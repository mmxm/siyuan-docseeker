import { describe, expect, it } from "vitest";
import { sectionLocation } from "./helpers/dsxLayout";
import { encodeIndex } from "../../src/core/codec/encode";
import { decodeIndex, decodePageMatches } from "../../src/core/codec/decode";
import {
  BudgetExceededError,
  CorruptDataError,
  DsxFormatError,
  TruncatedFileError,
  type DocumentIndex,
  type WordBox,
} from "../../src/core/codec/format";

const box = (i: number): WordBox => ({ x: (i % 50) / 100, y: (i % 30) / 100, width: 0.05, height: 0.02 });
const boxesFor = (count: number, salt: number): WordBox[] => Array.from({ length: count }, (_, i) => box(i + salt));

/** Trois pages ; une boîte par jeton ; « alpha » aux pages 1 et 3, « beta » aux pages 1 et 2. */
function makeIndex(): DocumentIndex {
  return {
    normalizerVersion: 1,
    extractorVersion: "test",
    sourcePath: "a.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: [6, 4, 1],
    terms: [
      { term: "alpha", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [0, 4] }, { page: 3, termFrequency: 1, wordOrdinals: [0] }] },
      { term: "beta", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [4, 5] }, { page: 2, termFrequency: 1, wordOrdinals: [3] }] },
      { term: "gamma", postings: [{ page: 2, termFrequency: 1, wordOrdinals: [1] }] },
    ],
    pageBoxes: [boxesFor(6, 0), boxesFor(4, 100), boxesFor(1, 200)],
    pageSizes: [{ widthPt: 612, heightPt: 792 }, { widthPt: 595.3, heightPt: 841.9 }, { widthPt: 842, heightPt: 595 }],
  };
}

const QUANTUM = 1 / 65535;

describe("decodePageMatches", () => {
  it("matches decodeIndex on ordinals (sorted, deduplicated) and boxes of the page", async () => {
    const bytes = await encodeIndex(makeIndex());
    const full = await decodeIndex(bytes);
    const result = await decodePageMatches(bytes, 1, (t) => t === "alpha" || t === "beta");
    expect(result.ordinals).toEqual([0, 4, 5]); // 4 partagé entre alpha et beta
    expect(result.boxes).toEqual(full.pageBoxes[0]);
    expect(result.boxes).toHaveLength(6);
    result.boxes.forEach((b, i) => expect(Math.abs(b.x - box(i).x)).toBeLessThanOrEqual(QUANTUM));
  });

  it("keeps only the requested page and the wanted terms", async () => {
    const bytes = await encodeIndex(makeIndex());
    const full = await decodeIndex(bytes);
    const result = await decodePageMatches(bytes, 2, (t) => t === "beta");
    expect(result.ordinals).toEqual([3]);
    expect(result.boxes).toEqual(full.pageBoxes[1]);
  });

  it("uses each ordinal as an index into the boxes of its page (one box per token)", async () => {
    const bytes = await encodeIndex(makeIndex());
    const full = await decodeIndex(bytes);
    for (let page = 1; page <= 3; page++) {
      const result = await decodePageMatches(bytes, page, () => true);
      const expected = new Set<number>();
      for (const entry of full.terms) for (const p of entry.postings) if (p.page === page) p.wordOrdinals.forEach((o) => expected.add(o));
      expect(result.ordinals).toEqual([...expected].sort((a, b) => a - b));
      for (const o of result.ordinals) expect(result.boxes[o]).toBeDefined();
    }
  });

  it("returns no ordinals but still the boxes when the filter retains nothing", async () => {
    const bytes = await encodeIndex(makeIndex());
    const result = await decodePageMatches(bytes, 1, () => false);
    expect(result.ordinals).toEqual([]);
    expect(result.boxes).toHaveLength(6);
  });

  it("reports the query-term index of each ordinal, parallel to ordinals, when a term indexer is given", async () => {
    const bytes = await encodeIndex(makeIndex());
    const indexOf = (t: string): number => (t === "alpha" ? 0 : t === "beta" ? 1 : -1);
    const result = await decodePageMatches(bytes, 1, (t) => indexOf(t) >= 0, undefined, indexOf);
    expect(result.ordinals).toEqual([0, 4, 5]);
    expect(result.termIndexes).toHaveLength(3);
    expect(result.termIndexes?.[0]).toBe(0); // ordinal 0 : alpha
    expect(result.termIndexes?.[2]).toBe(1); // ordinal 5 : beta
    expect([0, 1]).toContain(result.termIndexes?.[1]); // ordinal 4 partage entre alpha et beta
  });

  it("omits termIndexes without a term indexer", async () => {
    const result = await decodePageMatches(await encodeIndex(makeIndex()), 1, () => true);
    expect(result.termIndexes).toBeUndefined();
  });

  it("returns the ordinals of the last page", async () => {
    const result = await decodePageMatches(await encodeIndex(makeIndex()), 3, (t) => t === "alpha");
    expect(result.ordinals).toEqual([0]);
    expect(result.boxes).toHaveLength(1);
  });

  it("handles a document without terms or pages content", async () => {
    const empty: DocumentIndex = { ...makeIndex(), pageTermCounts: [0], terms: [], pageBoxes: [[]], pageSizes: [{ widthPt: 595, heightPt: 842 }] };
    expect(await decodePageMatches(await encodeIndex(empty), 1, () => true)).toEqual({
      boxes: [],
      ordinals: [],
      pageSize: { widthPt: 595, heightPt: 842 },
    });
  });

  it.each([0, 4, -1, 1.5, Number.NaN])("rejects page %s out of [1, 3]", async (page) => {
    const bytes = await encodeIndex(makeIndex());
    await expect(decodePageMatches(bytes, page, () => true)).rejects.toThrow(RangeError);
  });

  it("rejects a corrupted or truncated file with a typed error", async () => {
    const bytes = await encodeIndex(makeIndex());
    await expect(decodePageMatches(bytes.subarray(0, bytes.length - 3), 1, () => true)).rejects.toBeInstanceOf(DsxFormatError);
    await expect(decodePageMatches(bytes.subarray(0, 5), 1, () => true)).rejects.toBeInstanceOf(TruncatedFileError);
    const bad = bytes.slice();
    bad[0] = (bad[0] ?? 0) ^ 0xff;
    await expect(decodePageMatches(bad, 1, () => true)).rejects.toBeInstanceOf(DsxFormatError);
  });

  it("rejects a flipped byte in the compressed sections", async () => {
    const bytes = await encodeIndex(makeIndex());
    let failures = 0;
    // Toute la section des boîtes (dérivée de la table de l'en-tête) : table des longueurs et blobs de chaque page.
    const boxes = sectionLocation(bytes, 3);
    expect(boxes.offset + boxes.length).toBe(bytes.length);
    for (let i = boxes.offset; i < bytes.length; i++) {
      const bad = bytes.slice();
      bad[i] = (bad[i] ?? 0) ^ 0xff;
      try {
        await decodePageMatches(bad, 1, () => true);
      } catch (error) {
        expect(error).toBeInstanceOf(DsxFormatError);
        failures++;
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it("rejects an ordinal beyond the boxes of its page as corrupt data", async () => {
    const index = { ...makeIndex(), pageBoxes: [boxesFor(2, 0), boxesFor(4, 100), boxesFor(1, 200)] };
    await expect(decodePageMatches(await encodeIndex(index), 1, () => true)).rejects.toBeInstanceOf(CorruptDataError);
  });

  it("applies the anti-bomb budgets", async () => {
    const bytes = await encodeIndex(makeIndex());
    const limits = { maxInflatedBytes: 1 << 20, maxBoxes: 1 << 20, maxPostingItems: 3 };
    await expect(decodePageMatches(bytes, 1, () => false, limits)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(decodePageMatches(bytes, 1, () => true, { ...limits, maxPostingItems: 1000, maxBoxes: 2 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    await expect(decodePageMatches(bytes, 1, () => true, { ...limits, maxInflatedBytes: 10 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });
});
