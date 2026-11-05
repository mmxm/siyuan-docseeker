/**
 * Parité avec le moteur Rust : rejoue tests/fixtures/docseeker-ranking.json (générée par
 * search_core::process_search_results) avec NOS fonctions de proximity.ts.
 *
 * Ce que la fixture et ce test font :
 *  - Fenêtre SQL émulée comme le générateur : score de base décroissant, titre croissant (binaire), doc_id,
 *    15 premiers ; au plus 5 pages par document.
 *  - Boîtes de la fixture en fractions de page, comme WordBox ; les mots sont appariés par un appariement
 *    EXPLICITE par scénario (voir MATCHING) puis groupOccurrences / multiTermBonus / orderTopPages / rerankWindows.
 *  - Bonus de police : il n'existe pas encore chez nous (phase 2, AVANCEMENT item 6). Le test le CALCULE donc
 *    depuis la fixture, avec la formule du moteur vérifiée sur ses résultats : clamp((h - 10) * 25, 0, 400),
 *    h = plus grande hauteur de ligne (en points, page de 842 pt) parmi les mots appariés de TOUTES les pages
 *    du document. Ce bonus de substitution est ajouté à `relevance` avant rerankWindows, de sorte que les scores
 *    finaux et l'ordre sont comparables au Rust. Le bonus multi-mots est lui comparé séparément :
 *    relevanceScore attendu - score SQL de base - bonus de police.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WordBox } from "../../../src/core/codec/format";
import { compareCodePoints } from "../../../src/core/bm25";
import { tokenize } from "../../../src/core/normalize";
import { groupOccurrences, multiTermBonus, orderTopPages, rerankWindows } from "../../../src/search/proximity";
import { makeTermIndexer, makeTermMatcher } from "../../../src/search/queryMatch";

interface FxWord { text: string; x: number; y: number; width: number; height: number; line: number }
interface FxPage { page: number; bm25: number; words: FxWord[] }
interface FxDoc { docId: number; title: string; docRelevanceScore: number; pages: FxPage[] }
interface FxOcc { page: number; distinctTerms: number }
interface FxResult { id: number; title: string; relevanceScore: number; occurrences: FxOcc[] }
interface FxScenario {
  name: string;
  query: string;
  terms: string[];
  documents: FxDoc[];
  windowedOutDocIds: number[];
  expected: { results: FxResult[] };
}
interface Fixture { pageHeightPt: number; sqlWindow: number; scenarios: FxScenario[] }

const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/docseeker-ranking.json", import.meta.url), "utf8"),
) as Fixture;

type Matching = { match: (token: string) => boolean; indexOf: (token: string) => number; termCount: number };

/** Notre appariement : égalité, préfixe pour le dernier mot (queryMatch.ts) ; termes = mots distincts. */
function ourMatching(query: string): Matching {
  return {
    match: makeTermMatcher(query),
    indexOf: makeTermIndexer(query),
    termCount: new Set(tokenize(query)).size,
  };
}

/**
 * Appariement du Rust (matching.rs), réimplémenté dans le test : un mot correspond à un terme s'il est égal,
 * commence par lui, ou (terme >= 4 caractères) le contient ; les termes d'un caractère sont ignorés pour
 * l'appariement mais comptent dans terms.len(). Les phrases (termes à plusieurs mots) ne sont pas gérées.
 */
function rustMatching(terms: readonly string[]): Matching {
  const norm = terms.map((t) => tokenize(t).join(" "));
  const indexOf = (token: string): number =>
    norm.findIndex(
      (t) => [...t].length >= 2 && (token === t || token.startsWith(t) || ([...t].length >= 4 && token.includes(t))),
    );
  return { match: (token) => indexOf(token) >= 0, indexOf, termCount: terms.length };
}

/**
 * Appariement utilisé par scénario. Par défaut le nôtre. Les scénarios dont le Rust diverge de notre appariement
 * rejouent le pipeline avec l'appariement Rust (pour valider quand même groupOccurrences & co.), et la divergence
 * d'appariement elle-même est caractérisée plus bas (KNOWN_GAPS).
 */
const RUST_MATCHING_SCENARIOS = new Set(["mot-un-caractere", "prefixe-accents-sous-chaine"]);
/** Scénarios non rejouables : phrases entre guillemets, non gérées par notre appariement. */
const SKIPPED_SCENARIOS = new Set(["phrase-et-mot"]);
/**
 * Écart connu d'ordre de pages : le Rust départage aussi par taille de police (distinct, police, bm25, page) ;
 * sans bonus/tri de police (phase 2) nous obtenons l'ordre ci-dessous.
 */
const KNOWN_PAGE_ORDER_GAPS = new Map<string, number[]>([["tri-des-occurrences", [2, 4, 3, 5, 1]]]);

const toBox = (w: FxWord): WordBox => ({ x: w.x, y: w.y, width: w.width, height: w.height });
const tokenOf = (w: FxWord): string => tokenize(w.text).join("");
const round2 = (v: number): number => Math.round(v * 100) / 100;

interface DocOutcome {
  docId: string;
  title: string;
  base: number;
  fontBonus: number;
  multiBonus: number;
  /** Pages avec au moins un mot trouvé, ordonnées par orderTopPages. */
  pagesOrder: number[];
  /** Mots distincts maximum par page. */
  distinctByPage: Map<number, number>;
}

function sqlWindow(docs: readonly FxDoc[], size: number): FxDoc[] {
  return [...docs]
    .sort((a, b) => b.docRelevanceScore - a.docRelevanceScore || compareCodePoints(a.title, b.title) || a.docId - b.docId)
    .slice(0, size);
}

function analyse(doc: FxDoc, m: Matching, pageHeightPt: number): DocOutcome {
  const distinctByPage = new Map<number, number>();
  let maxHeightPt = 0;
  for (const p of doc.pages) {
    const ordinals: number[] = [];
    const termIndexes: number[] = [];
    p.words.forEach((w, i) => {
      const token = tokenOf(w);
      if (!m.match(token)) return;
      ordinals.push(i);
      termIndexes.push(m.indexOf(token));
      maxHeightPt = Math.max(maxHeightPt, round2(w.height * pageHeightPt));
    });
    const occurrences = groupOccurrences(p.words.map(toBox), ordinals, termIndexes);
    const distinct = Math.max(0, ...occurrences.map((o) => o.distinct));
    if (distinct > 0) distinctByPage.set(p.page, distinct);
  }
  const maxDistinct = Math.max(0, ...distinctByPage.values());
  const pages = doc.pages.filter((p) => distinctByPage.has(p.page)).map((p) => ({ page: p.page, score: -p.bm25 }));
  return {
    docId: String(doc.docId),
    title: doc.title,
    base: doc.docRelevanceScore,
    fontBonus: Math.min(Math.max((maxHeightPt - 10) * 25, 0), 400),
    multiBonus: multiTermBonus(maxDistinct, m.termCount),
    pagesOrder: orderTopPages(pages, distinctByPage).map((p) => p.page),
    distinctByPage,
  };
}

function replay(sc: FxScenario, m: Matching): { outcomes: Map<string, DocOutcome>; order: readonly { docId: string; title: string; relevance: number }[]; finalScore: Map<string, number> } {
  const outcomes = new Map<string, DocOutcome>();
  for (const d of sqlWindow(sc.documents, fixture.sqlWindow)) {
    outcomes.set(String(d.docId), analyse(d, m, fixture.pageHeightPt));
  }
  const docs = [...outcomes.values()].map((o) => ({ docId: o.docId, title: o.title, relevance: o.base + o.fontBonus }));
  const bonusByDoc = new Map([...outcomes.values()].map((o) => [o.docId, o.multiBonus]));
  const order = rerankWindows(docs, bonusByDoc, fixture.sqlWindow);
  const finalScore = new Map(order.map((d) => [d.docId, round2(d.relevance + (bonusByDoc.get(d.docId) ?? 0))]));
  return { outcomes, order, finalScore };
}

/** Pages de l'attendu Rust dans l'ordre de première apparition parmi ses occurrences triées. */
const rustPageOrder = (r: FxResult): number[] => [...new Set(r.occurrences.map((o) => o.page))];

const replayable = fixture.scenarios.filter((s) => !SKIPPED_SCENARIOS.has(s.name));

describe("fixture", () => {
  it("contains the 17 reference scenarios", () => {
    expect(fixture.scenarios).toHaveLength(17);
    expect(fixture.sqlWindow).toBe(15);
  });
});

describe.each(replayable.map((s) => [s.name, s] as const))("parity: %s", (_name, sc) => {
  const matching = RUST_MATCHING_SCENARIOS.has(sc.name) ? rustMatching(sc.terms) : ourMatching(sc.query);
  const run = replay(sc, matching);

  it("keeps the same documents in the same order", () => {
    expect(run.order.map((d) => d.title)).toEqual(sc.expected.results.map((r) => r.title));
    for (const out of sc.windowedOutDocIds) expect(run.outcomes.has(String(out))).toBe(false);
  });

  it("gives the same final score (base + font stand-in + multi-term bonus)", () => {
    for (const r of sc.expected.results) expect(run.finalScore.get(String(r.id))).toBe(r.relevanceScore);
  });

  it("computes the multi-term bonus = expected - base - font", () => {
    for (const r of sc.expected.results) {
      const o = run.outcomes.get(String(r.id)) as DocOutcome;
      expect(round2(r.relevanceScore - o.base - o.fontBonus)).toBe(round2(o.multiBonus));
    }
  });

  it("finds the same distinct words per occurrence page", () => {
    for (const r of sc.expected.results) {
      const o = run.outcomes.get(String(r.id)) as DocOutcome;
      const expected = new Map<number, number>();
      for (const occ of r.occurrences) expected.set(occ.page, Math.max(expected.get(occ.page) ?? 0, occ.distinctTerms));
      // total_occurrences est tronqué à 25 : seules les pages exposées sont comparées.
      for (const [page, distinct] of expected) expect(o.distinctByPage.get(page)).toBe(distinct);
    }
  });

  it("orders the pages like the engine (or as documented)", () => {
    const gap = KNOWN_PAGE_ORDER_GAPS.get(sc.name);
    for (const r of sc.expected.results) {
      const o = run.outcomes.get(String(r.id)) as DocOutcome;
      const exposed = rustPageOrder(r);
      expect(o.pagesOrder.slice(0, exposed.length)).toEqual(gap ?? exposed);
    }
  });
});

describe("known gaps with the Rust engine", () => {
  const byName = (name: string): FxScenario => fixture.scenarios.find((s) => s.name === name) as FxScenario;

  it("tri-des-occurrences: Rust breaks ties by font size, we do not yet (phase 2)", () => {
    const sc = byName("tri-des-occurrences");
    expect(rustPageOrder(sc.expected.results[0] as FxResult).slice(0, 2)).toEqual([4, 2]);
    expect(KNOWN_PAGE_ORDER_GAPS.get(sc.name)?.slice(0, 2)).toEqual([2, 4]);
  });

  it("mot-un-caractere: we match the 1-character word 'a' and count 2 distinct words (Rust ignores it)", () => {
    const sc = byName("mot-un-caractere");
    const o = analyse(sc.documents[0] as FxDoc, ourMatching(sc.query), fixture.pageHeightPt);
    expect(o.multiBonus).toBe(5000);
    expect(sc.expected.results[0]?.relevanceScore).toBe(455);
  });

  it("prefixe-accents-sous-chaine: we require equality for non-last words, so 'eleves' does not match 'eleve'", () => {
    const sc = byName("prefixe-accents-sous-chaine");
    const accents = analyse(sc.documents[0] as FxDoc, ourMatching(sc.query), fixture.pageHeightPt);
    expect(accents.multiBonus).toBe(0);
    const substring = analyse(sc.documents[1] as FxDoc, ourMatching(sc.query), fixture.pageHeightPt);
    expect(substring.multiBonus).toBe(0); // 'souscontrat' (sous-chaîne) non apparié ; Rust : +5000
  });

  it("phrase-et-mot: quoted phrases are plain words for us, so the disordered doc B wrongly gets the bonus", () => {
    const sc = byName("phrase-et-mot");
    const m = ourMatching(sc.query);
    const b = analyse(sc.documents[1] as FxDoc, m, fixture.pageHeightPt);
    expect(m.termCount).toBe(4);
    expect(b.multiBonus).toBe(5000); // Rust : 0 (phrase non satisfaite, doc B à 555)
    expect(sc.expected.results.find((r) => r.title === "B desordre")?.relevanceScore).toBe(555);
  });
});
