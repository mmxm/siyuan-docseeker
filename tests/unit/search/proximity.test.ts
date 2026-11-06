import { describe, expect, it } from "vitest";
import {
  ASSUMED_PAGE_WIDTH_PT,
  MULTI_TERMS_ALL_MATCHED_BONUS,
  MULTI_TERMS_PARTIAL_MATCHED_BONUS,
  OCCURRENCE_MAX_GAP_PT,
  FONT_SIZE_BONUS_MAX,
  FONT_SIZE_BONUS_MULTIPLIER,
  FONT_SIZE_BONUS_THRESHOLD,
  PROXIMITY_PAGES,
  RERANK_WINDOW,
  SAME_LINE_OVERLAP,
} from "../../../src/core/constants";
import type { WordBox } from "../../../src/core/codec/format";
import {
  fontBonus,
  fontSizePt,
  groupOccurrences,
  multiTermBonus,
  orderTopPages,
  pageStats,
  rerankWindows,
} from "../../../src/search/proximity";

const PT = 1 / ASSUMED_PAGE_WIDTH_PT;
const box = (x: number, y = 0.1, width = 0.05, height = 0.02): WordBox => ({ x, y, width, height });
/** Boîte dont le bord gauche est à `gapPt` points du bord droit de `prev`. */
const after = (prev: WordBox, gapPt: number, y = prev.y, height = prev.height): WordBox =>
  box(prev.x + prev.width + gapPt * PT, y, 0.05, height);

describe("constants", () => {
  it("mirror search-core", () => {
    expect(MULTI_TERMS_ALL_MATCHED_BONUS).toBe(5000);
    expect(MULTI_TERMS_PARTIAL_MATCHED_BONUS).toBe(2000);
    expect(RERANK_WINDOW).toBe(15);
    expect(PROXIMITY_PAGES).toBe(5);
    expect(OCCURRENCE_MAX_GAP_PT).toBe(25);
    expect(SAME_LINE_OVERLAP).toBe(0.6);
    expect(ASSUMED_PAGE_WIDTH_PT).toBe(595);
  });
});

describe("groupOccurrences", () => {
  it("returns nothing without matches", () => {
    expect(groupOccurrences([box(0.1)], [], [])).toEqual([]);
    expect(groupOccurrences([], [], [])).toEqual([]);
  });

  it("groups words on one line separated by less than 25 pt", () => {
    const a = box(0.1);
    const b = after(a, 24);
    expect(groupOccurrences([a, b], [0, 1], [0, 1])).toEqual([{ distinct: 2, ordinals: [0, 1], fontSizePt: 16.8 }]);
  });

  it("splits words separated by 26 pt", () => {
    const a = box(0.1);
    const b = after(a, 26);
    expect(groupOccurrences([a, b], [0, 1], [0, 1])).toEqual([
      { distinct: 1, ordinals: [0], fontSizePt: 16.8 },
      { distinct: 1, ordinals: [1], fontSizePt: 16.8 },
    ]);
  });

  it("joins touching words (gap 0) and splits overlapping ones (negative gap)", () => {
    const a = box(0.1);
    expect(groupOccurrences([a, after(a, 0)], [0, 1], [0, 1])).toHaveLength(1);
    expect(groupOccurrences([a, after(a, -1)], [0, 1], [0, 1])).toHaveLength(2);
  });

  it("splits words on different lines even when close horizontally", () => {
    const a = box(0.1, 0.1);
    const b = after(a, 5, 0.2);
    expect(groupOccurrences([a, b], [0, 1], [0, 1])).toHaveLength(2);
  });

  it("accepts a vertical overlap of 0.7 of the smallest height and rejects 0.5", () => {
    const a = box(0.1, 0, 0.05, 1);
    expect(groupOccurrences([a, after(a, 5, 0.3, 1)], [0, 1], [0, 1])).toHaveLength(1); // 0.7
    expect(groupOccurrences([a, after(a, 5, 0.5, 1)], [0, 1], [0, 1])).toHaveLength(2); // 0.5
  });

  it("uses the smallest height as the overlap reference", () => {
    const tall = box(0.1, 0, 0.05, 1);
    const small = after(tall, 5, 0.4, 0.1); // entièrement contenu : 100 % de la petite hauteur
    expect(groupOccurrences([tall, small], [0, 1], [0, 1])).toHaveLength(1);
  });

  it("never joins words of zero height", () => {
    const a = box(0.1, 0.1, 0.05, 0);
    expect(groupOccurrences([a, after(a, 5)], [0, 1], [0, 1])).toHaveLength(2);
    const tall = box(0.1, 0.1, 0.05, 0.02);
    expect(groupOccurrences([tall, after(tall, 5, 0.1, 0)], [0, 1], [0, 1])).toHaveLength(2);
  });

  it("compares each word with the previous word of the group, not the first", () => {
    const a = box(0.1);
    const b = after(a, 20);
    const c = after(b, 20); // 40+ pt du premier mais 20 pt du précédent
    expect(groupOccurrences([a, b, c], [0, 1, 2], [0, 1, 0])).toEqual([{ distinct: 2, ordinals: [0, 1, 2], fontSizePt: 16.8 }]);
  });

  it("ignores unmatched words in between (non-consecutive ordinals) and uses reading order", () => {
    const a = box(0.1);
    const skipped = box(0.3);
    const b = after(a, 10);
    const boxes = [a, skipped, b];
    expect(groupOccurrences(boxes, [0, 2], [0, 1])).toEqual([{ distinct: 2, ordinals: [0, 2], fontSizePt: 16.8 }]);
  });

  it("counts distinct term indexes, not words", () => {
    const a = box(0.1);
    const b = after(a, 5);
    const c = after(b, 5);
    expect(groupOccurrences([a, b, c], [0, 1, 2], [1, 1, 1])).toEqual([{ distinct: 1, ordinals: [0, 1, 2], fontSizePt: 16.8 }]);
  });

  it("rejects misaligned ordinals and term indexes, and ordinals outside the boxes", () => {
    expect(() => groupOccurrences([box(0.1), box(0.3)], [0, 1], [0])).toThrow(RangeError);
    expect(() => groupOccurrences([box(0.1)], [0, 1], [0, 1])).toThrow(RangeError);
    expect(() => groupOccurrences([box(0.1)], [-1], [0])).toThrow(RangeError);
  });

  it("does not mutate its inputs", () => {
    const boxes = Object.freeze([box(0.1), box(0.2)]);
    const ordinals = Object.freeze([0, 1]);
    const terms = Object.freeze([0, 1]);
    expect(() => groupOccurrences(boxes, ordinals, terms)).not.toThrow();
  });
});

describe("multiTermBonus", () => {
  it("gives no bonus for a one-word query", () => {
    expect(multiTermBonus(1, 1)).toBe(0);
    expect(multiTermBonus(0, 0)).toBe(0);
  });
  it("gives 5000 when every term is found in one occurrence", () => {
    expect(multiTermBonus(2, 2)).toBe(5000);
    expect(multiTermBonus(3, 3)).toBe(5000);
    expect(multiTermBonus(4, 3)).toBe(5000);
  });
  it("gives a proportional partial bonus from two distinct terms", () => {
    expect(multiTermBonus(2, 3)).toBeCloseTo((2 / 3) * 2000);
    expect(multiTermBonus(3, 4)).toBe(1500);
  });
  it("gives nothing below two distinct terms", () => {
    expect(multiTermBonus(1, 3)).toBe(0);
    expect(multiTermBonus(0, 3)).toBe(0);
  });
});

describe("fontSizePt", () => {
  const h = (heightPt: number, pageHeightPt = 842): WordBox => box(0.1, 0.1, 0.05, heightPt / pageHeightPt);
  it("is the box height in points (fraction x page height), rounded to 0.1", () => {
    expect(fontSizePt([h(12.04)], [0], 842)).toBe(12);
    expect(fontSizePt([h(12.06)], [0], 842)).toBe(12.1);
  });
  it("takes the maximum over the words of the occurrence", () => {
    expect(fontSizePt([h(9), h(20), h(14)], [0, 1, 2], 842)).toBe(20);
  });
  it("only looks at the matched ordinals", () => {
    expect(fontSizePt([h(9), h(40), h(14)], [0, 2], 842)).toBe(14);
  });
  it("scales with the page height", () => {
    expect(fontSizePt([box(0.1, 0.1, 0.05, 0.02)], [0], 792)).toBe(15.8);
  });
  it("rejects an ordinal outside the boxes, like groupOccurrences", () => {
    expect(() => fontSizePt([h(12)], [1], 842)).toThrow(RangeError);
    expect(() => fontSizePt([h(12)], [-1], 842)).toThrow(RangeError);
    expect(() => fontSizePt([], [0], 842)).toThrow(RangeError);
  });
  it.each([0, -842, Number.NaN, Number.POSITIVE_INFINITY])("is 0, never NaN or infinite, for an aberrant page height (%s)", (pageHeightPt) => {
    expect(fontSizePt([h(12)], [0], pageHeightPt)).toBe(0);
  });
  it("is 0 without ordinals and never negative", () => {
    expect(fontSizePt([h(12)], [], 842)).toBe(0);
    expect(fontSizePt([box(0.1, 0.1, 0.05, -0.5)], [0], 842)).toBe(0);
  });
});

describe("fontBonus", () => {
  it("mirrors the engine constants", () => {
    expect(FONT_SIZE_BONUS_THRESHOLD).toBe(10);
    expect(FONT_SIZE_BONUS_MULTIPLIER).toBe(25);
    expect(FONT_SIZE_BONUS_MAX).toBe(400);
  });
  it("is zero at 10 pt or below, strictly", () => {
    expect(fontBonus(0)).toBe(0);
    expect(fontBonus(9.9)).toBe(0);
    expect(fontBonus(10)).toBe(0);
  });
  it("grows by 25 per point above 10 pt", () => {
    expect(fontBonus(10.1)).toBeCloseTo(2.5, 9);
    expect(fontBonus(12)).toBe(50);
    expect(fontBonus(14)).toBe(100);
  });
  it("is capped at 400 from 26 pt", () => {
    expect(fontBonus(25.9)).toBeCloseTo(397.5, 9);
    expect(fontBonus(26)).toBe(400);
    expect(fontBonus(40)).toBe(400);
    expect(fontBonus(1e9)).toBe(400);
  });
  it("rejects non-finite sizes as zero rather than propagating NaN", () => {
    expect(fontBonus(Number.NaN)).toBe(0);
  });
});

describe("groupOccurrences font size", () => {
  it("reports the maximum font size of each group in points, using the page height", () => {
    const a = box(0.1, 0.1, 0.05, 12 / 842);
    const b = { ...after(a, 5), height: 20 / 842 };
    const far = { ...box(0.8, 0.1, 0.05, 15 / 842) };
    const occ = groupOccurrences([a, b, far], [0, 1, 2], [0, 1, 0], { widthPt: 595, heightPt: 842 });
    expect(occ.map((o) => o.fontSizePt)).toEqual([20, 15]);
  });
  it("uses the real page width for the 25 pt gap (Letter 612 pt)", () => {
    const a = box(0.1, 0.1, 0.05, 0.015);
    // 0.04 de page : 24,5 pt sur une page de 612 pt (joint), 23,8 pt sur 595 pt.
    const b = box(a.x + a.width + 0.04, 0.1, 0.05, 0.015);
    expect(groupOccurrences([a, b], [0, 1], [0, 1], { widthPt: 612, heightPt: 792 })).toHaveLength(1);
    const c = box(a.x + a.width + 0.0415, 0.1, 0.05, 0.015); // 25,4 pt sur 612, 24,7 pt sur 595
    expect(groupOccurrences([a, c], [0, 1], [0, 1], { widthPt: 612, heightPt: 792 })).toHaveLength(2);
    expect(groupOccurrences([a, c], [0, 1], [0, 1])).toHaveLength(1); // repli A4 : 24,7 pt
  });
});

describe("pageStats", () => {
  const occ = (distinct: number, fontSizePt: number) => ({ distinct, fontSizePt, ordinals: [0] });
  it("is empty for a page without occurrence", () => {
    expect(pageStats([])).toEqual({ distinct: 0, fontSizePt: 0 });
  });
  it("keeps the best occurrence by (distinct, font) lexicographically, not the maximum of each", () => {
    expect(pageStats([occ(2, 10), occ(1, 30)])).toEqual({ distinct: 2, fontSizePt: 10 });
    expect(pageStats([occ(2, 10), occ(2, 14), occ(1, 30)])).toEqual({ distinct: 2, fontSizePt: 14 });
  });
});

describe("orderTopPages", () => {
  const p = (page: number, score: number) => ({ page, score });
  const stats = (entries: [number, number, number][]) =>
    new Map(entries.map(([page, distinct, fontSizePt]) => [page, { distinct, fontSizePt }] as const));
  it("sorts by distinct terms desc, then score desc (better first), then page asc", () => {
    const pages = [p(1, 5), p(2, 9), p(3, 9), p(4, 1)];
    expect(orderTopPages(pages, stats([[4, 3, 0], [1, 2, 0]])).map((x) => x.page)).toEqual([4, 1, 2, 3]);
  });
  it("sorts by font size after distinct terms and before score", () => {
    const pages = [p(1, 9), p(2, 1), p(3, 5)];
    expect(orderTopPages(pages, stats([[1, 1, 12], [2, 1, 20], [3, 1, 12]])).map((x) => x.page)).toEqual([2, 1, 3]);
  });
  it("lets distinct terms win over font size", () => {
    const pages = [p(1, 1), p(2, 1)];
    expect(orderTopPages(pages, stats([[1, 2, 10], [2, 1, 40]])).map((x) => x.page)).toEqual([1, 2]);
  });
  it("compares font sizes rounded to 0.1 (10.04 ties with 10.0, 10.06 does not)", () => {
    const pages = [p(1, 1), p(2, 9)];
    expect(orderTopPages(pages, stats([[1, 1, 10.04], [2, 1, 10]])).map((x) => x.page)).toEqual([2, 1]);
    expect(orderTopPages(pages, stats([[1, 1, 10.06], [2, 1, 10]])).map((x) => x.page)).toEqual([1, 2]);
  });
  it("treats missing pages as 0 distinct terms and 0 pt and keeps the input untouched", () => {
    const pages = Object.freeze([p(2, 1), p(1, 1)]);
    expect(orderTopPages(pages, new Map()).map((x) => x.page)).toEqual([1, 2]);
    expect(pages.map((x) => x.page)).toEqual([2, 1]);
  });
  it("handles an empty list", () => {
    expect(orderTopPages([], new Map())).toEqual([]);
  });
});

describe("rerankWindows", () => {
  const doc = (docId: string, relevance: number, title = docId) => ({ docId, title, relevance });

  it("re-sorts by base relevance + bonus, descending", () => {
    const docs = [doc("a", 100), doc("b", 90)];
    expect(rerankWindows(docs, new Map([["b", 50]]), 15).map((d) => d.docId)).toEqual(["b", "a"]);
  });
  it("breaks ties (rounded to 2 decimals) by title ascending", () => {
    const docs = [doc("1", 10.001, "Zeta"), doc("2", 10.004, "Alpha"), doc("3", 10.0, "Mid")];
    expect(rerankWindows(docs, new Map(), 15).map((d) => d.title)).toEqual(["Alpha", "Mid", "Zeta"]);
  });
  it("orders titles by code point, like SQLite BINARY", () => {
    const docs = [doc("1", 1, "b"), doc("2", 1, "B")];
    expect(rerankWindows(docs, new Map(), 15).map((d) => d.title)).toEqual(["B", "b"]);
  });
  it("keeps the incoming order when relevance and title are equal (stable)", () => {
    const docs = [doc("z", 1, "T"), doc("a", 1, "T"), doc("m", 1, "T")];
    expect(rerankWindows(docs, new Map(), 15).map((d) => d.docId)).toEqual(["z", "a", "m"]);
  });
  it("only reorders inside each window of windowSize consecutive documents", () => {
    const docs = Array.from({ length: 17 }, (_, i) => doc(`d${i}`, 100 - i));
    const bonus = new Map([["d16", 10000], ["d14", 10000], ["d15", 5000]]);
    const ids = rerankWindows(docs, bonus, 15).map((d) => d.docId);
    expect(ids.slice(0, 15)).toEqual(["d14", ...Array.from({ length: 14 }, (_, i) => `d${i}`)]);
    expect(ids.slice(15)).toEqual(["d16", "d15"]);
  });
  it("leaves a document beyond the first window in place even with a huge bonus", () => {
    const docs = Array.from({ length: 16 }, (_, i) => doc(`d${i}`, 100 - i));
    const ids = rerankWindows(docs, new Map([["d15", 1e6]]), RERANK_WINDOW).map((d) => d.docId);
    expect(ids[15]).toBe("d15");
    expect(ids.slice(0, 15)).toEqual(docs.slice(0, 15).map((d) => d.docId));
  });
  it("handles empty input, small input and windowSize 1", () => {
    expect(rerankWindows([], new Map(), 15)).toEqual([]);
    const docs = [doc("a", 1), doc("b", 2)];
    expect(rerankWindows(docs, new Map(), 1).map((d) => d.docId)).toEqual(["a", "b"]);
  });
  it("does not mutate the input", () => {
    const docs = Object.freeze([doc("a", 1), doc("b", 2)]);
    rerankWindows(docs, new Map(), 15);
    expect(docs.map((d) => d.docId)).toEqual(["a", "b"]);
  });
  it.each([0, -1, 1.5, Number.NaN])("rejects windowSize %s", (size) => {
    expect(() => rerankWindows([doc("a", 1)], new Map(), size)).toThrow(RangeError);
  });
});
