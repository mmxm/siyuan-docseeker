import { describe, expect, it } from "vitest";
import rawFixture from "../fixtures/fts5-parity.json";
import { buildIndex, searchPages, toFtsBm25, type PageInput } from "../../src/core/bm25";

// Parite avec le VRAI SQLite FTS5 : valeurs produites par scripts/gen-fts5-fixture.mjs (binaire sqlite3).
interface FixtureResult {
  readonly docId: string;
  readonly page: number;
  readonly bm25: number;
}
interface FixtureQuery {
  readonly label: string;
  readonly query: string;
  readonly match: string;
  readonly results: readonly FixtureResult[];
}
interface Fixture {
  readonly pages: readonly PageInput[];
  readonly queries: readonly FixtureQuery[];
}

const fixture: Fixture = rawFixture;
const SCORE_TOLERANCE = 1e-9;
const index = buildIndex(fixture.pages);

describe("parite bm25() de SQLite FTS5", () => {
  it("la fixture couvre au moins 15 pages et des requetes variees", () => {
    expect(fixture.pages.length).toBeGreaterThanOrEqual(15);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(10);
    expect(fixture.queries.some((q) => q.results.length === 0)).toBe(true);
    expect(fixture.queries.some((q) => q.results.some((r) => Math.abs(r.bm25) < 1e-5))).toBe(true);
  });

  for (const q of fixture.queries) {
    it(`${q.label} : "${q.query}" -> ${q.match}`, () => {
      const hits = searchPages(index, q.query);
      expect(hits.map((h) => [h.docId, h.page])).toEqual(q.results.map((r) => [r.docId, r.page]));
      hits.forEach((hit, i) => {
        expect(Math.abs(toFtsBm25(hit.score) - (q.results[i]?.bm25 ?? NaN))).toBeLessThan(SCORE_TOLERANCE);
      });
    });
  }
});
