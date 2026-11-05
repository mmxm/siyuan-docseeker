import { describe, expect, it } from "vitest";
import {
  ASSUMED_PAGE_WIDTH_PT,
  MULTI_TERMS_ALL_MATCHED_BONUS,
  MULTI_TERMS_PARTIAL_MATCHED_BONUS,
  OCCURRENCE_MAX_GAP_PT,
  PROXIMITY_PAGES,
  RERANK_WINDOW,
  SAME_LINE_OVERLAP,
} from "../../../src/core/constants";
import type { WordBox } from "../../../src/core/codec/format";
import { groupOccurrences, multiTermBonus, orderTopPages, rerankWindows } from "../../../src/search/proximity";

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
    expect(groupOccurrences([a, b], [0, 1], [0, 1])).toEqual([{ distinct: 2, ordinals: [0, 1] }]);
  });

  it("splits words separated by 26 pt", () => {
    const a = box(0.1);
    const b = after(a, 26);
    expect(groupOccurrences([a, b], [0, 1], [0, 1])).toEqual([
      { distinct: 1, ordinals: [0] },
      { distinct: 1, ordinals: [1] },
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
    expect(groupOccurrences([a, b, c], [0, 1, 2], [0, 1, 0])).toEqual([{ distinct: 2, ordinals: [0, 1, 2] }]);
  });

  it("ignores unmatched words in between (non-consecutive ordinals) and uses reading order", () => {
    const a = box(0.1);
    const skipped = box(0.3);
    const b = after(a, 10);
    const boxes = [a, skipped, b];
    expect(groupOccurrences(boxes, [0, 2], [0, 1])).toEqual([{ distinct: 2, ordinals: [0, 2] }]);
  });

  it("counts distinct term indexes, not words", () => {
    const a = box(0.1);
    const b = after(a, 5);
    const c = after(b, 5);
    expect(groupOccurrences([a, b, c], [0, 1, 2], [1, 1, 1])).toEqual([{ distinct: 1, ordinals: [0, 1, 2] }]);
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

describe("orderTopPages", () => {
  const p = (page: number, score: number) => ({ page, score });
  it("sorts by distinct terms desc, then score desc (better first), then page asc", () => {
    const pages = [p(1, 5), p(2, 9), p(3, 9), p(4, 1)];
    const distinct = new Map([[4, 3], [1, 2]]);
    expect(orderTopPages(pages, distinct).map((x) => x.page)).toEqual([4, 1, 2, 3]);
  });
  it("treats missing pages as 0 distinct terms and keeps the input untouched", () => {
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
