import { describe, expect, it } from "vitest";
import { buildIndex, searchPages } from "../../../src/core/bm25";
import { decodePageMatches } from "../../../src/core/codec/decode";
import { encodeIndex } from "../../../src/core/codec/encode";
import type { DocumentIndex } from "../../../src/core/codec/format";
import { tokenize } from "../../../src/core/normalize";
import { groupOccurrences, multiTermBonus } from "../../../src/search/proximity";
import { makeTermIndexer, makeTermIndexesOf, makeTermMatcher } from "../../../src/search/queryMatch";

/**
 * Mots de requête qui se recouvrent (« abc bcd » ne trouve que « abcd ») : un même terme satisfait plusieurs mots.
 * La recherche renvoie la page ; le surlignage et la proximité doivent le voir aussi (aucune dégradation à tort).
 */
const QUERY = "abc bcd";
const TEXT = "abcd";

function singleWordIndex(): DocumentIndex {
  return {
    normalizerVersion: 1,
    extractorVersion: "test",
    sourcePath: "a.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: [1],
    terms: [{ term: "abcd", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [0] }] }],
    pageBoxes: [[{ x: 0.1, y: 0.1, width: 0.05, height: 0.02 }]],
    pageSizes: [{ widthPt: 595, heightPt: 842 }],
  };
}

describe("termes qui satisfont plusieurs mots de la requête", () => {
  it("makeTermIndexesOf renvoie tous les mots distincts satisfaits, dans l'ordre", () => {
    const indexesOf = makeTermIndexesOf(QUERY);
    expect(indexesOf("abcd")).toEqual([0, 1]);
    expect(indexesOf("abc")).toEqual([0]);
    expect(indexesOf("zzz")).toEqual([]);
    expect(makeTermIndexesOf("")("abcd")).toEqual([]);
    expect(makeTermIndexesOf("abc abc")("abcd")).toEqual([0]);
  });

  it("makeTermIndexer reste le premier mot satisfait avec la classe la plus forte", () => {
    expect(makeTermIndexer(QUERY)("abcd")).toBe(0);
    expect(makeTermIndexer("bcd abcd")("abcd")).toBe(1); // exact pour le second mot
  });

  it("groupOccurrences : un ordinal répété pour deux mots compte deux mots distincts, une seule boîte", () => {
    const boxes = [{ x: 0.1, y: 0.1, width: 0.05, height: 0.02 }];
    const [occurrence, ...others] = groupOccurrences(boxes, [0, 0], [0, 1]);
    expect(others).toHaveLength(0);
    expect(occurrence?.distinct).toBe(2);
    expect(occurrence?.ordinals).toEqual([0]);
  });

  it("de bout en bout : la page est trouvée, surlignée et obtient le bonus de tous les mots", async () => {
    const hits = searchPages(buildIndex([{ docId: "d", page: 1, text: TEXT }]), QUERY);
    expect(hits.map((h) => h.page)).toEqual([1]);

    const bytes = await encodeIndex(singleWordIndex());
    const match = await decodePageMatches(bytes, 1, makeTermMatcher(QUERY), undefined, makeTermIndexesOf(QUERY));
    expect(match.ordinals).toEqual([0, 0]);
    expect(match.termIndexes).toEqual([0, 1]);

    const occurrences = groupOccurrences(match.boxes, match.ordinals, match.termIndexes ?? [], match.pageSize);
    const maxDistinct = Math.max(...occurrences.map((o) => o.distinct));
    const wordCount = new Set(tokenize(QUERY)).size;
    expect(maxDistinct).toBe(wordCount);
    expect(multiTermBonus(maxDistinct, wordCount)).toBe(multiTermBonus(2, 2));
    expect(multiTermBonus(2, 2)).toBeGreaterThan(multiTermBonus(1, 2));
  });
});
