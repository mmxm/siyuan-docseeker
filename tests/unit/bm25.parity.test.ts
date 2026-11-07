import { describe, expect, it } from "vitest";
import rawFixture from "../fixtures/fts5-parity.json";
import { buildIndex, searchPages, toFtsBm25, type PageHit, type PageInput } from "../../src/core/bm25";
import { tokenize } from "../../src/core/normalize";
import { MATCH_WEIGHT, MatchClass } from "../../src/core/termMatch";

// Parite avec le VRAI SQLite FTS5 : valeurs produites par scripts/gen-fts5-fixture.mjs (binaire sqlite3).
// Deux regimes :
//  - requetes dont chaque terme apparie par FTS5 est EXACT (aucun prefixe ni sous-chaine possible) : egalite stricte
//    (meme liste ordonnee, memes scores) ;
//  - les autres : FTS5 ignore les sous-chaines et traite un prefixe a poids 1, alors que nous ponderons le tf par
//    classe (termMatch.ts). On exige alors toutes les pages FTS5, un score entre MATCH_WEIGHT.Substring x FTS5 et
//    FTS5, et les pages en plus ne doivent etre atteintes que par sous-chaine.
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
const pageKey = (docId: string, page: number): string => `${docId}#${page}`;
const tokensOfPages = fixture.pages.map((p) => ({ key: pageKey(p.docId, p.page), tokens: tokenize(p.text) }));
const vocabulary = new Set(tokensOfPages.flatMap((p) => p.tokens));

/** Regle FTS5 de la fixture, ecrite ici independamment du code de production : egalite, prefixe pour le dernier mot. */
const ftsAccepts = (token: string, word: string, isLast: boolean): boolean =>
  token === word || (isLast && token.startsWith(word));

/** Vrai si, pour chaque mot, tout terme du vocabulaire que FTS5 apparie est egal au mot et qu'aucune sous-chaine n'existe. */
function onlyExactTerms(query: string): boolean {
  const words = tokenize(query);
  return words.every((word, i) =>
    [...vocabulary].every((term) => {
      const matchedByFts = ftsAccepts(term, word, i === words.length - 1);
      const matchedAtAll = matchedByFts || ([...word].length >= 3 && term.includes(word));
      return !matchedAtAll || term === word;
    }),
  );
}

/** Une page en plus de FTS5 n'est atteinte que par sous-chaine : un mot sans terme FTS5, tous les mots contenus. */
function reachedOnlyBySubstring(key: string, query: string): boolean {
  const words = tokenize(query);
  const tokens = tokensOfPages.find((p) => p.key === key)?.tokens ?? [];
  const missedByFts = words.some((word, i) => !tokens.some((t) => ftsAccepts(t, word, i === words.length - 1)));
  const containedEverywhere = words.every((word) => tokens.some((t) => t.includes(word)));
  return missedByFts && containedEverywhere;
}

function expectStrictParity(hits: readonly PageHit[], q: FixtureQuery): void {
  expect(hits.map((h) => [h.docId, h.page])).toEqual(q.results.map((r) => [r.docId, r.page]));
  hits.forEach((hit, i) => {
    expect(Math.abs(toFtsBm25(hit.score) - (q.results[i]?.bm25 ?? NaN))).toBeLessThan(SCORE_TOLERANCE);
  });
}

function expectBoundedParity(hits: readonly PageHit[], q: FixtureQuery): void {
  const found = new Map(hits.map((h) => [pageKey(h.docId, h.page), h.score]));
  const fts = new Map(q.results.map((r) => [pageKey(r.docId, r.page), -r.bm25]));
  const hasExtraPages = [...found.keys()].some((key) => !fts.has(key));
  for (const [key, ftsScore] of fts) {
    expect(found.has(key), key).toBe(true);
    const ours = found.get(key) as number;
    expect(ours).toBeLessThanOrEqual(ftsScore + SCORE_TOLERANCE);
    // La borne basse suppose le meme df : des pages en plus abaissent l'idf (et donc le score) hors de cette borne.
    if (!hasExtraPages) expect(ours).toBeGreaterThanOrEqual(MATCH_WEIGHT[MatchClass.Substring] * ftsScore - SCORE_TOLERANCE);
  }
  for (const key of found.keys()) {
    if (!fts.has(key)) expect(reachedOnlyBySubstring(key, q.query), `${key} en plus`).toBe(true);
  }
}

describe("parite bm25() de SQLite FTS5", () => {
  it("la fixture couvre au moins 15 pages et des requetes variees", () => {
    expect(fixture.pages.length).toBeGreaterThanOrEqual(15);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(10);
    expect(fixture.queries.some((q) => q.results.length === 0)).toBe(true);
    expect(fixture.queries.some((q) => q.results.some((r) => Math.abs(r.bm25) < 1e-5))).toBe(true);
    expect(fixture.queries.some((q) => onlyExactTerms(q.query))).toBe(true);
  });

  for (const q of fixture.queries) {
    it(`${q.label} : "${q.query}" -> ${q.match}`, () => {
      const hits = searchPages(index, q.query);
      if (onlyExactTerms(q.query)) expectStrictParity(hits, q);
      else expectBoundedParity(hits, q);
    });
  }

  it("« zebre » ne trouve rien, comme FTS5", () => {
    expect(searchPages(index, "zebre")).toEqual([]);
    expect(fixture.queries.find((q) => q.query === "zebre")?.results).toEqual([]);
  });
});
