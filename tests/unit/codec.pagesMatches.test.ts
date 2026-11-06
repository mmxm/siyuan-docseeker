import { describe, expect, it } from "vitest";
import { encodeIndex } from "../../src/core/codec/encode";
import { decodePageMatches, decodePagesMatches } from "../../src/core/codec/decode";
import { BudgetExceededError, DsxFormatError, type DocumentIndex, type WordBox } from "../../src/core/codec/format";

const box = (i: number): WordBox => ({ x: (i % 50) / 100, y: (i % 30) / 100, width: 0.05, height: 0.02 });

/** Index pseudo-aléatoire déterministe : 12 pages, 6 termes, ordinaux partagés entre termes. */
function makeIndex(): DocumentIndex {
  const pageLengths = Array.from({ length: 12 }, (_, p) => (p === 5 ? 0 : 8 + p));
  const termNames = ["alpha", "beta", "gamma", "delta", "eps", "zeta"];
  const terms = termNames.map((term, t) => ({
    term,
    postings: pageLengths.flatMap((len, p) => {
      if (len === 0 || (p + t) % 3 === 0) return [];
      const ordinals = [...new Set([(p * 7 + t * 3) % len, (p + t * 5 + 1) % len, (t * 2) % len])].sort((a, b) => a - b);
      return [{ page: p + 1, termFrequency: ordinals.length, wordOrdinals: ordinals }];
    }),
  }));
  return {
    normalizerVersion: 1,
    extractorVersion: "test",
    sourcePath: "a.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: pageLengths,
    terms,
    pageBoxes: pageLengths.map((len, p) => Array.from({ length: len }, (_, i) => box(i + p * 13))),
    pageSizes: pageLengths.map(() => ({ widthPt: 595, heightPt: 842 })),
  };
}

const indexOf = (t: string): number => ["alpha", "beta", "gamma", "delta"].indexOf(t);
const wanted = (t: string): boolean => indexOf(t) >= 0;

describe("decodePagesMatches", () => {
  it("equals one decodePageMatches call per page, with and without term indexer", async () => {
    const bytes = await encodeIndex(makeIndex());
    const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const termIndexOf of [undefined, indexOf]) {
      const many = await decodePagesMatches(bytes, pages, wanted, undefined, termIndexOf);
      expect([...many.keys()].sort((a, b) => a - b)).toEqual(pages);
      for (const page of pages) {
        expect(many.get(page)).toEqual(await decodePageMatches(bytes, page, wanted, undefined, termIndexOf));
      }
    }
  });

  it("returns only the requested pages, in any order, deduplicating repeated pages", async () => {
    const bytes = await encodeIndex(makeIndex());
    const many = await decodePagesMatches(bytes, [9, 2, 9, 2, 5], wanted, undefined, indexOf);
    expect([...many.keys()].sort((a, b) => a - b)).toEqual([2, 5, 9]);
    for (const page of [2, 5, 9]) {
      expect(many.get(page)).toEqual(await decodePageMatches(bytes, page, wanted, undefined, indexOf));
    }
  });

  it("handles a page without text and a filter that retains nothing", async () => {
    const bytes = await encodeIndex(makeIndex());
    const many = await decodePagesMatches(bytes, [6, 1], () => false, undefined, indexOf);
    expect(many.get(6)).toEqual({
      boxes: [],
      ordinals: [],
      termIndexes: [],
      pageSize: { widthPt: 595, heightPt: 842 },
    });
    expect(many.get(1)).toEqual(await decodePageMatches(bytes, 1, () => false, undefined, indexOf));
  });

  it("returns an empty map for an empty list without failing", async () => {
    const bytes = await encodeIndex(makeIndex());
    expect((await decodePagesMatches(bytes, [], wanted)).size).toBe(0);
  });

  it.each([[[0]], [[13]], [[1, 13]], [[-1]], [[1.5]], [[Number.NaN]]])("rejects pages %j with the same RangeError", async (pages) => {
    const bytes = await encodeIndex(makeIndex());
    const single = await decodePageMatches(bytes, pages[pages.length - 1] as number, wanted).catch((e: unknown) => e);
    const multi = await decodePagesMatches(bytes, pages, wanted).catch((e: unknown) => e);
    expect(multi).toBeInstanceOf(RangeError);
    expect((multi as Error).message).toBe((single as Error).message);
  });

  it("applies the same security budgets", async () => {
    const bytes = await encodeIndex(makeIndex());
    const limits = { maxInflatedBytes: 1e9, maxBoxes: 3, maxPostingItems: 1e9 };
    await expect(decodePageMatches(bytes, 1, wanted, limits)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(decodePagesMatches(bytes, [1, 2], wanted, limits)).rejects.toBeInstanceOf(BudgetExceededError);
    const postings = { maxInflatedBytes: 1e9, maxBoxes: 1e9, maxPostingItems: 1 };
    await expect(decodePagesMatches(bytes, [1], wanted, postings)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects a truncated file with a typed error", async () => {
    const bytes = await encodeIndex(makeIndex());
    await expect(decodePagesMatches(bytes.subarray(0, bytes.length - 3), [1, 2], wanted)).rejects.toBeInstanceOf(DsxFormatError);
  });
});
