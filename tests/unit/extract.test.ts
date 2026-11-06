import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ExtractionInputError,
  SCANNED_MAX_TOKENS_PER_PAGE,
  buildDocumentIndex,
  isLikelyScanned,
  itemToViewRect,
  type DocumentMeta,
  type ExtractedPage,
  type TextItemLike,
} from "../../src/core/extract";
import { decodeIndex, decodePageBoxes } from "../../src/core/codec/decode";
import { encodeIndex } from "../../src/core/codec/encode";
import { tokenize } from "../../src/core/normalize";

const W = 612;
const H = 792;
const QUANTUM = 1 / 65535;
const VP_0 = [1, 0, 0, -1, 0, H] as const;
const VP_90 = [0, 1, 1, 0, 0, 0] as const;
const VP_180 = [-1, 0, 0, 1, W, 0] as const;
const VP_270 = [0, -1, -1, 0, H, W] as const;

const META: DocumentMeta = {
  normalizerVersion: 1,
  extractorVersion: "test",
  pdfSize: 10,
  pdfModifiedMs: 20,
  sourcePath: "a.pdf",
  pageCount: 1,
};

function item(str: string, over: Partial<TextItemLike> = {}): TextItemLike {
  return { str, transform: [10, 0, 0, 10, 100, 700], width: str.length * 5, height: 10, ...over };
}

function page(items: TextItemLike[], pageNumber = 1): ExtractedPage {
  return { pageNumber, viewportTransform: VP_0, viewWidth: W, viewHeight: H, items };
}

describe("itemToViewRect", () => {
  const it0 = { str: "x", transform: [10, 0, 0, 10, 100, 700], width: 50, height: 10 };
  it("rotation 0", () => {
    const r = itemToViewRect(it0, VP_0);
    expect(r).toEqual({ x: 100, y: 82, width: 50, height: 10 });
  });
  it("rotation 90", () => {
    const r = itemToViewRect(it0, VP_90);
    expect(r).toEqual({ x: 700, y: 100, width: 10, height: 50 });
  });
  it("rotation 180", () => {
    const r = itemToViewRect(it0, VP_180);
    expect(r).toEqual({ x: 462, y: 700, width: 50, height: 10 });
  });
  it("rotation 270", () => {
    const r = itemToViewRect(it0, VP_270);
    expect(r).toEqual({ x: 82, y: 462, width: 10, height: 50 });
  });
  it("scale 2", () => {
    const r = itemToViewRect(it0, [2, 0, 0, -2, 0, 2 * H]);
    expect(r).toEqual({ x: 200, y: 164, width: 100, height: 20 });
  });
  it("slanted text 45 degrees", () => {
    const s = (10 * Math.SQRT2) / 2;
    const r = itemToViewRect({ ...it0, transform: [s, s, -s, s, 100, 700] }, VP_0);
    const expected = (50 + 10) * (Math.SQRT2 / 2);
    expect(r.width).toBeCloseTo(expected, 6);
    expect(r.height).toBeCloseTo(expected, 6);
  });
  it("rejects bad matrices", () => {
    expect(() => itemToViewRect(it0, [1, 0, 0, 1, 0])).toThrow(ExtractionInputError);
    expect(() => itemToViewRect({ ...it0, transform: [1, 2, 3] }, VP_0)).toThrow(ExtractionInputError);
    expect(() => itemToViewRect({ ...it0, transform: [1, 0, 0, NaN, 0, 0] }, VP_0)).toThrow(
      ExtractionInputError,
    );
  });
  it("degenerate horizontal vector falls back to the x axis", () => {
    const r = itemToViewRect({ ...it0, transform: [0, 0, 0, 10, 100, 700] }, VP_0);
    expect(r.width).toBe(50);
  });
});

describe("buildDocumentIndex", () => {
  it("indexes accented French text with shared normalized terms", () => {
    const idx = buildDocumentIndex(META, [page([item("Éléphant à l'école")])]);
    expect(idx.terms.map((t) => t.term)).toEqual(["a", "ecole", "elephant", "l"]);
    expect(idx.pageTermCounts).toEqual([4]);
    expect(idx.pageBoxes[0]).toHaveLength(4);
  });

  it("splits item width proportionally to character positions", () => {
    const idx = buildDocumentIndex(META, [page([item("ab cd", { width: 50 })])]);
    const [b0, b1] = idx.pageBoxes[0] ?? [];
    expect(b0?.x).toBeCloseTo(100 / W, 9);
    expect(b0?.width).toBeCloseTo(20 / W, 9);
    expect(b1?.x).toBeCloseTo(130 / W, 9);
    expect(b1?.width).toBeCloseTo(20 / W, 9);
    expect(b0?.y).toBeCloseTo(82 / H, 9);
    expect(b0?.height).toBeCloseTo(10 / H, 9);
  });

  it("gives all tokens of one word the same box (NFKD expansion)", () => {
    const idx = buildDocumentIndex(META, [page([item("½ ok")])]);
    expect(tokenize("½")).toEqual(["1", "2"]);
    const boxes = idx.pageBoxes[0] ?? [];
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toEqual(boxes[1]);
    expect(boxes[2]).not.toEqual(boxes[0]);
    expect(idx.pageTermCounts).toEqual([3]);
  });

  it("does not join hyphenated words across lines (v1 choice)", () => {
    const idx = buildDocumentIndex(META, [
      page([item("informa-", { hasEOL: true }), item("tion")]),
    ]);
    expect(idx.terms.map((t) => t.term)).toEqual(["informa", "tion"]);
  });

  it("ignores empty and whitespace-only items", () => {
    const idx = buildDocumentIndex(META, [page([item(""), item("   "), item("a")])]);
    expect(idx.pageTermCounts).toEqual([1]);
  });

  it("handles multi-line items and keeps item order", () => {
    const idx = buildDocumentIndex(META, [page([item("zeta\nalpha"), item("beta", { transform: [10, 0, 0, 10, 0, 100] })])]);
    const t = (name: string) => idx.terms.find((e) => e.term === name)?.postings[0]?.wordOrdinals;
    expect(t("zeta")).toEqual([0]);
    expect(t("alpha")).toEqual([1]);
    expect(t("beta")).toEqual([2]);
  });

  it("keeps empty and missing pages, in a 1-based posting scheme", () => {
    const meta = { ...META, pageCount: 4 };
    const idx = buildDocumentIndex(meta, [page([item("mot")], 3), page([], 1)]);
    expect(idx.pageTermCounts).toEqual([0, 0, 1, 0]);
    expect(idx.pageBoxes.map((b) => b.length)).toEqual([0, 0, 1, 0]);
    expect(idx.terms[0]?.postings[0]?.page).toBe(3);
  });

  it("reports one page size per page, in points, rounded to 0.1", () => {
    const meta = { ...META, pageCount: 2 };
    const idx = buildDocumentIndex(meta, [
      { ...page([item("a")], 2), viewWidth: 841.89, viewHeight: 595.276 },
      { ...page([item("b")], 1), viewWidth: 612, viewHeight: 792 },
    ]);
    expect(idx.pageSizes).toEqual([
      { widthPt: 612, heightPt: 792 },
      { widthPt: 841.9, heightPt: 595.3 },
    ]);
  });

  it("uses the A4 fallback for pages absent from the extraction", () => {
    const meta = { ...META, pageCount: 3 };
    const idx = buildDocumentIndex(meta, [page([item("mot")], 2)]);
    expect(idx.pageSizes).toEqual([
      { widthPt: 595, heightPt: 842 },
      { widthPt: W, heightPt: H },
      { widthPt: 595, heightPt: 842 },
    ]);
  });

  it("round-trips page sizes through the v2 codec", async () => {
    const idx = buildDocumentIndex(META, [{ ...page([item("a")]), viewWidth: 595.3, viewHeight: 841.9 }]);
    const back = await decodeIndex(await encodeIndex(idx));
    expect(back.pageSizes).toEqual([{ widthPt: 595.3, heightPt: 841.9 }]);
  });

  it("rejects non-positive or non-finite page sizes (boxes cannot be computed)", () => {
    expect(() => buildDocumentIndex(META, [{ ...page([]), viewWidth: 0 }])).toThrow(ExtractionInputError);
    expect(() => buildDocumentIndex(META, [{ ...page([]), viewHeight: -1 }])).toThrow(ExtractionInputError);
    expect(() => buildDocumentIndex(META, [{ ...page([]), viewHeight: Infinity }])).toThrow(ExtractionInputError);
    expect(() => buildDocumentIndex(META, [{ ...page([]), viewWidth: Number.NaN }])).toThrow(ExtractionInputError);
  });

  describe("pages aberrantes (taille hors 0.1..20000 pt) : repli A4 et avertissement", () => {
    const aberrant: readonly [string, Partial<ExtractedPage>][] = [
      ["largeur 0.01", { viewWidth: 0.01 }],
      ["hauteur 20001", { viewHeight: 20001 }],
      ["largeur 100000", { viewWidth: 100000 }],
    ];

    it.each(aberrant)("%s : la page prend le repli A4, l'avertissement nomme la page, le PDF est indexé", (_n, over) => {
      const warnings: string[] = [];
      const meta = { ...META, pageCount: 2 };
      const idx = buildDocumentIndex(
        meta,
        [{ ...page([item("mot")], 2), ...over }, page([item("ok")], 1)],
        { onWarn: (message) => warnings.push(message) },
      );
      expect(idx.pageSizes).toEqual([
        { widthPt: W, heightPt: H },
        { widthPt: 595, heightPt: 842 },
      ]);
      expect(idx.terms.map((t) => t.term)).toEqual(["mot", "ok"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/page 2/);
      expect(warnings[0]).toMatch(/A4|595/);
    });

    it("les boîtes restent des fractions valides de la vraie vue, et l'index s'encode", async () => {
      const idx = buildDocumentIndex(META, [{ ...page([item("mot")]), viewWidth: 30000 }], { onWarn: () => undefined });
      for (const b of idx.pageBoxes[0] ?? []) {
        expect(b.x + b.width).toBeLessThanOrEqual(1);
      }
      const back = await decodeIndex(await encodeIndex(idx));
      expect(back.pageSizes).toEqual([{ widthPt: 595, heightPt: 842 }]);
    });

    it("sans onWarn : pas d'exception, repli quand même", () => {
      const idx = buildDocumentIndex(META, [{ ...page([item("mot")]), viewWidth: 30000 }]);
      expect(idx.pageSizes).toEqual([{ widthPt: 595, heightPt: 842 }]);
    });

    it("les bornes exactes (0.1 et 20000) ne sont pas aberrantes", () => {
      const warnings: string[] = [];
      const idx = buildDocumentIndex(META, [{ ...page([]), viewWidth: 20000, viewHeight: 0.1 }], {
        onWarn: (m) => warnings.push(m),
      });
      expect(idx.pageSizes).toEqual([{ widthPt: 20000, heightPt: 0.1 }]);
      expect(warnings).toEqual([]);
    });

    it("un onWarn qui lève n'est pas avalé : l'exception remonte à l'appelant (l'indexeur la protège)", () => {
      expect(() =>
        buildDocumentIndex(META, [{ ...page([item("mot")]), viewWidth: 30000 }], {
          onWarn: () => {
            throw new Error("boom");
          },
        }),
      ).toThrow("boom");
    });
  });

  it("orders terms by UTF-8 bytes and postings by page then ordinal", () => {
    const meta = { ...META, pageCount: 2 };
    const idx = buildDocumentIndex(meta, [
      page([item("b a b")], 2),
      page([item("b zz 9 b")], 1),
    ]);
    expect(idx.terms.map((t) => t.term)).toEqual(["9", "a", "b", "zz"]);
    const b = idx.terms.find((t) => t.term === "b");
    expect(b?.postings).toEqual([
      { page: 1, termFrequency: 2, wordOrdinals: [0, 3] },
      { page: 2, termFrequency: 2, wordOrdinals: [0, 2] },
    ]);
  });

  it("clamps boxes into [0,1]", () => {
    const idx = buildDocumentIndex(META, [
      page([item("hors", { transform: [10, 0, 0, 10, 600, 790], width: 500 }), item("neg", { transform: [10, 0, 0, 10, -50, -50] })]),
    ]);
    for (const b of idx.pageBoxes[0] ?? []) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1);
      expect(b.y + b.height).toBeLessThanOrEqual(1);
    }
  });

  it("handles a very long item", () => {
    const str = Array.from({ length: 20000 }, (_, i) => `w${i}`).join(" ");
    const idx = buildDocumentIndex(META, [page([item(str, { width: 100000 })])]);
    expect(idx.pageTermCounts).toEqual([20000]);
  });

  it("indexes symbols that only become alphanumeric after NFKD, like the query tokenizer does", () => {
    // Avant : « ⓐ », « ㎏ », « ℀ » donnaient 0 jeton dans le document mais des jetons dans la requete.
    const terms = (str: string): string[] => buildDocumentIndex(META, [page([item(str)])]).terms.map((t) => t.term);
    expect(terms("\u24d0")).toEqual(["a"]);
    expect(terms("\u338f")).toEqual(["kg"]);
    expect(terms("\u2100")).toEqual(["a", "c"]);
    // Dans un mot, le symbole fait partie du mot (comme `tokenize` sur la meme chaine).
    expect(terms("a\u24d0b")).toEqual(["aab"]);
    expect(terms("a \u338f b")).toEqual(["a", "b", "kg"]);
  });

  it("keeps one box per token for NFKD-expanded symbols", () => {
    const idx = buildDocumentIndex(META, [page([item("x \u2100 y")])]);
    expect(idx.pageTermCounts[0]).toBe(4);
    expect(idx.pageBoxes[0]).toHaveLength(4);
    const ordinals = idx.terms.flatMap((t) => t.postings.flatMap((p) => p.wordOrdinals));
    expect([...ordinals].sort()).toEqual([0, 1, 2, 3]);
  });

  it("property: every query token of a word is found in a document containing that word", () => {
    const alphabet = fc.constantFrom("a", "b", "k", "g", "\u24d0", "\u338f", "\u2100", "\u00bd", "\ufb01", "\u00e9", "1", "-", " ", "+", "\u0301");
    const wordArb = fc.array(alphabet, { minLength: 1, maxLength: 6 }).map((cs) => cs.join(""));
    fc.assert(
      fc.property(wordArb, fc.array(wordArb, { maxLength: 3 }), (word, others) => {
        const doc = buildDocumentIndex(META, [page([item([...others, word].join(" "))])]);
        const docTerms = new Set(doc.terms.map((t) => t.term));
        for (const token of tokenize(word)) expect(docTerms.has(token)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("validates inputs", () => {
    const bad = (p: ExtractedPage, m: DocumentMeta = META) => () => buildDocumentIndex(m, [p]);
    expect(bad({ ...page([]), viewportTransform: [1, 0, 0, 1] })).toThrow(ExtractionInputError);
    expect(bad(page([item("a", { transform: [1, 0, 0, 1, 0] })]))).toThrow(ExtractionInputError);
    expect(bad(page([item("a", { width: NaN })]))).toThrow(ExtractionInputError);
    expect(bad(page([item("a", { transform: [1, 0, 0, 1, 0, Infinity] })]))).toThrow(ExtractionInputError);
    expect(bad({ ...page([]), viewWidth: 0 })).toThrow(ExtractionInputError);
    expect(bad({ ...page([]), viewHeight: NaN })).toThrow(ExtractionInputError);
    expect(bad(page([], 2))).toThrow(ExtractionInputError);
    expect(bad(page([], 0))).toThrow(ExtractionInputError);
    expect(bad(page([]), { ...META, pageCount: -1 })).toThrow(ExtractionInputError);
    expect(() => buildDocumentIndex(META, [page([]), page([])])).toThrow(ExtractionInputError);
  });

  it("round-trips through encodeIndex/decodeIndex", async () => {
    const meta = { ...META, pageCount: 3 };
    const idx = buildDocumentIndex(meta, [
      page([item("Le café ½ est à côté")], 1),
      page([item("côté café", { transform: [10, 0, 0, 10, 300, 300] })], 3),
    ]);
    const bytes = await encodeIndex(idx);
    const back = await decodeIndex(bytes);
    expect({ ...back, pageBoxes: [] }).toEqual({ ...idx, pageBoxes: [] });
    back.pageBoxes.forEach((boxes, p) => {
      expect(boxes).toHaveLength(idx.pageBoxes[p]?.length ?? -1);
      boxes.forEach((b, i) => {
        const o = idx.pageBoxes[p]?.[i];
        expect(Math.abs(b.x - (o?.x ?? 9))).toBeLessThanOrEqual(QUANTUM);
        expect(Math.abs(b.width - (o?.width ?? 9))).toBeLessThanOrEqual(QUANTUM);
      });
    });
    const p1 = await decodePageBoxes(bytes, 1);
    expect(p1).toHaveLength(idx.pageBoxes[0]?.length ?? -1);
  });

  it("property: boxes = sum of tf = pageTermCounts", () => {
    const itemArb = fc.string({ unit: "grapheme", maxLength: 30 }).map((s) => item(s, { width: s.length * 4 }));
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 8 }), (items) => {
        const idx = buildDocumentIndex(META, [page(items)]);
        const tf = idx.terms.reduce(
          (sum, t) => sum + t.postings.reduce((s, p) => s + (p.page === 1 ? p.termFrequency : 0), 0),
          0,
        );
        // Parité document/requête : le document contient exactement les jetons que `tokenize` tire de chaque
        // item (l'ancien calcul par mots de la chaîne ORIGINALE encodait le défaut « ⓐ = séparateur »).
        const expected = items.reduce((s, i) => s + tokenize(i.str).length, 0);
        expect(idx.pageBoxes[0]).toHaveLength(tf);
        expect(idx.pageTermCounts[0]).toBe(tf);
        expect(tf).toBe(expected);
        for (const b of idx.pageBoxes[0] ?? []) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(1 + 1e-9);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("builds 2000 pages x 500 words in a reasonable time", () => {
    const words = Array.from({ length: 500 }, (_, i) => `mot${i % 97}`).join(" ");
    const pages = Array.from({ length: 2000 }, (_, i) => page([item(words, { width: 5000 })], i + 1));
    const start = performance.now();
    const idx = buildDocumentIndex({ ...META, pageCount: 2000 }, pages);
    expect(performance.now() - start).toBeLessThan(20000);
    expect(idx.pageTermCounts[1999]).toBe(500);
  });
});

describe("isLikelyScanned", () => {
  it("is true for no text, empty or near-empty pages", () => {
    expect(isLikelyScanned([])).toBe(true);
    expect(isLikelyScanned([page([]), page([item("  ")], 2)])).toBe(true);
    const few = Array.from({ length: SCANNED_MAX_TOKENS_PER_PAGE }, () => "a").join(" ");
    expect(isLikelyScanned([page([item(few)])])).toBe(true);
  });
  it("is false once a page has more than the threshold", () => {
    const many = Array.from({ length: SCANNED_MAX_TOKENS_PER_PAGE + 1 }, () => "a").join(" ");
    expect(isLikelyScanned([page([]), page([item(many)], 2)])).toBe(false);
  });
});
