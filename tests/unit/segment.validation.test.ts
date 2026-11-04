import { describe, expect, it } from "vitest";
import {
  DuplicateDocumentError,
  buildIndex,
  indexOfSegments,
  makeSegment,
  postingsOf,
  type SegmentPostings,
} from "../../src/core/bm25";
import { MAX_PAGES } from "../../src/core/codec/format";
import { toBm25Index } from "../../src/core/indexMerge";

const u32 = (...values: number[]): Uint32Array => Uint32Array.from(values);

/** Deux termes ("a" : pages 1 et 2, "b" : page 2) sur un document de 2 pages. */
const validPostings = (): SegmentPostings => ({
  terms: ["a", "b"],
  offsets: u32(0, 2, 3),
  pages: u32(1, 2, 2),
  termFrequencies: u32(1, 1, 4),
});
const LENGTHS = (): Uint32Array => u32(3, 5);

describe("makeSegment : validation", () => {
  it("accepte une entree coherente", () => {
    const segment = makeSegment("d", LENGTHS(), validPostings());
    expect(segment.pageCount).toBe(2);
    expect(segment.totalTokens).toBe(8);
  });

  const broken: [string, (p: SegmentPostings) => SegmentPostings][] = [
    ["offsets trop courts", (p) => ({ ...p, offsets: u32(0, 3) })],
    ["offsets trop longs", (p) => ({ ...p, offsets: u32(0, 2, 3, 3) })],
    ["offsets decroissants", (p) => ({ ...p, offsets: u32(0, 3, 2) })],
    ["offsets[0] non nul", (p) => ({ ...p, offsets: u32(1, 2, 3) })],
    ["dernier offset != pages.length", (p) => ({ ...p, offsets: u32(0, 2, 2) })],
    ["termFrequencies de longueur differente", (p) => ({ ...p, termFrequencies: u32(1, 1) })],
    ["page 0", (p) => ({ ...p, pages: u32(0, 2, 2) })],
    ["page au dela de pageLengths", (p) => ({ ...p, pages: u32(1, 2, 3) })],
  ];
  for (const [name, mutate] of broken) {
    it(`refuse : ${name}`, () => {
      expect(() => makeSegment("doc-x", LENGTHS(), mutate(validPostings()))).toThrow(RangeError);
      expect(() => makeSegment("doc-x", LENGTHS(), mutate(validPostings()))).toThrow(/doc-x/);
    });
  }

  it("refuse pageCount > pageLengths.length, negatif ou non entier", () => {
    for (const bad of [3, -1, 1.5, Number.NaN]) {
      expect(() => makeSegment("doc-x", LENGTHS(), validPostings(), bad)).toThrow(RangeError);
    }
  });

  it("copie defensivement les tableaux fournis", () => {
    const lengths = LENGTHS();
    const postings = validPostings();
    const segment = makeSegment("d", lengths, postings);
    lengths.fill(0);
    postings.offsets.fill(0);
    postings.pages.fill(0);
    postings.termFrequencies.fill(0);
    expect(segment.totalTokens).toBe(8);
    expect(segment.pageLengths[1]).toBe(5);
    expect(postingsOf(indexOfSegments([segment]), "b")).toEqual([{ docId: "d", page: 2, tf: 4 }]);
  });
});

describe("entree objet : valeurs non representables en u32", () => {
  const doc = (page: number, termFrequency: number, count: number) => ({
    docId: "doc-y",
    index: { terms: [{ term: "a", postings: [{ page, termFrequency, wordOrdinals: [] }] }], pageTermCounts: [count] },
  });

  it("refuse NaN, negatif, non entier et > UINT32_MAX", () => {
    for (const bad of [Number.NaN, -1, 1.5, 2 ** 32]) {
      expect(() => toBm25Index([doc(bad, 1, 1)])).toThrow(RangeError);
      expect(() => toBm25Index([doc(1, bad, 1)])).toThrow(RangeError);
      expect(() => toBm25Index([doc(1, 1, bad)])).toThrow(RangeError);
    }
    expect(() => toBm25Index([doc(1, 2 ** 32, 1)])).toThrow(/doc-y/);
  });

  it("accepte UINT32_MAX comme tf", () => {
    expect(() => toBm25Index([doc(1, 2 ** 32 - 1, 1)])).not.toThrow();
  });
});

describe("indexOfSegments", () => {
  it("leve DuplicateDocumentError sur docId en double", () => {
    const segment = makeSegment("d", LENGTHS(), validPostings());
    expect(() => indexOfSegments([segment, segment])).toThrow(DuplicateDocumentError);
    expect(() => indexOfSegments([segment, segment])).toThrow(/d/);
  });
});

describe("borne de page de buildIndex", () => {
  it("aligne sur MAX_PAGES", () => {
    expect(() => buildIndex([{ docId: "d", page: MAX_PAGES, text: "chat" }])).not.toThrow();
    expect(() => buildIndex([{ docId: "d", page: MAX_PAGES + 1, text: "chat" }])).toThrow(RangeError);
  });
});
