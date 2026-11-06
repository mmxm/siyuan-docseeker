/**
 * Parité avec le moteur Rust : rejoue tests/fixtures/docseeker-ranking.json (générée par
 * search_core::process_search_results) avec NOS fonctions de proximity.ts.
 *
 * Ce que la fixture et ce test font :
 *  - Fenêtre SQL émulée comme le générateur : score de base décroissant, titre croissant (binaire), doc_id,
 *    15 premiers ; au plus 5 pages par document (les 5 meilleurs bm25, `page_rank <= 5`).
 *  - Boîtes de la fixture en fractions de page, comme WordBox, avec la taille de page de chaque page (A4 par
 *    défaut) ; les mots sont appariés par un appariement EXPLICITE par scénario (voir MATCHING) puis
 *    groupOccurrences / pageStats / multiTermBonus / fontBonus / orderTopPages / rerankWindows : les MÊMES
 *    primitives que le ranker de production, rejouées par `analyse` / `replay` (sans l'orchestration du ranker :
 *    cache, fenêtres, concurrence, pages sans occurrence écartées de l'ordre).
 *  - Le bonus de police (max des occurrences du document, taille arrondie à 0,1) et le bonus multi-mots entrent
 *    ensemble dans `bonusByDoc`, comme dans proximityRanker.ts.
 *  - Le dernier bloc (« production ranker parity ») passe la fixture par `createProximityRanker` lui-même, avec un
 *    getPagesMatches simulé construit depuis les mots de la fixture, et le compare à `replay`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WordBox } from "../../../src/core/codec/format";
import { compareCodePoints } from "../../../src/core/bm25";
import { tokenize } from "../../../src/core/normalize";
import {
  fontBonus,
  groupOccurrences,
  multiTermBonus,
  orderTopPages,
  pageStats,
  rerankWindows,
  type Occurrence,
  type PageStats,
} from "../../../src/search/proximity";
import { createProximityRanker, type RankableDoc } from "../../../src/search/proximityRanker";
import { makeTermIndexer, makeTermMatcher } from "../../../src/search/queryMatch";
import type { PageMatch } from "../../../src/core/codec/decode";

interface FxWord { text: string; x: number; y: number; width: number; height: number; line: number }
interface FxPage { page: number; bm25: number; words: FxWord[]; size?: { widthPt: number; heightPt: number } }
interface FxDoc { docId: number; title: string; docRelevanceScore: number; pages: FxPage[] }
interface FxOcc { page: number; occId: number; distinctTerms: number; fontSize: number }
interface FxResult { id: number; title: string; relevanceScore: number; occurrences: FxOcc[] }
interface FxScenario {
  name: string;
  query: string;
  terms: string[];
  documents: FxDoc[];
  windowedOutDocIds: number[];
  expected: { results: FxResult[] };
}
interface Fixture { pageWidthPt: number; pageHeightPt: number; sqlWindow: number; scenarios: FxScenario[] }
/** `page_rank <= 5` dans la requête SQL du moteur. */
const SQL_PAGES_PER_DOC = 5;

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
  /** Mots distincts de la meilleure occurrence de chaque page. */
  distinctByPage: Map<number, number>;
  /** Occurrences de chaque page, dans l'ordre de lecture (comme `occId` du moteur). */
  occurrencesByPage: Map<number, readonly Occurrence[]>;
}

function sqlWindow(docs: readonly FxDoc[], size: number): FxDoc[] {
  return [...docs]
    .sort((a, b) => b.docRelevanceScore - a.docRelevanceScore || compareCodePoints(a.title, b.title) || a.docId - b.docId)
    .slice(0, size);
}

function analyse(doc: FxDoc, m: Matching): DocOutcome {
  const statsByPage = new Map<number, PageStats>();
  const occurrencesByPage = new Map<number, readonly Occurrence[]>();
  // Le moteur ne reçoit que les 5 meilleures pages (bm25 le plus négatif d'abord, puis numéro de page).
  const sent = [...doc.pages].sort((a, b) => a.bm25 - b.bm25 || a.page - b.page).slice(0, SQL_PAGES_PER_DOC);
  let bestFontPt = 0;
  let maxDistinct = 0;
  for (const p of sent) {
    const ordinals: number[] = [];
    const termIndexes: number[] = [];
    p.words.forEach((w, i) => {
      const token = tokenOf(w);
      if (!m.match(token)) return;
      ordinals.push(i);
      termIndexes.push(m.indexOf(token));
    });
    const size = p.size ?? { widthPt: fixture.pageWidthPt, heightPt: fixture.pageHeightPt };
    const occurrences = groupOccurrences(p.words.map(toBox), ordinals, termIndexes, size);
    occurrencesByPage.set(p.page, occurrences);
    const stats = pageStats(occurrences);
    if (stats.distinct > 0) statsByPage.set(p.page, stats);
    maxDistinct = Math.max(maxDistinct, stats.distinct);
    for (const o of occurrences) bestFontPt = Math.max(bestFontPt, o.fontSizePt);
  }
  const pages = sent.filter((p) => statsByPage.has(p.page)).map((p) => ({ page: p.page, score: -p.bm25 }));
  return {
    docId: String(doc.docId),
    title: doc.title,
    base: doc.docRelevanceScore,
    fontBonus: fontBonus(bestFontPt),
    multiBonus: multiTermBonus(maxDistinct, m.termCount),
    pagesOrder: orderTopPages(pages, statsByPage).map((p) => p.page),
    distinctByPage: new Map([...statsByPage].map(([page, st]) => [page, st.distinct])),
    occurrencesByPage,
  };
}

function replay(sc: FxScenario, m: Matching): { outcomes: Map<string, DocOutcome>; order: readonly { docId: string; title: string; relevance: number }[]; finalScore: Map<string, number> } {
  const outcomes = new Map<string, DocOutcome>();
  for (const d of sqlWindow(sc.documents, fixture.sqlWindow)) {
    outcomes.set(String(d.docId), analyse(d, m));
  }
  const docs = [...outcomes.values()].map((o) => ({ docId: o.docId, title: o.title, relevance: o.base }));
  const bonusByDoc = new Map([...outcomes.values()].map((o) => [o.docId, o.multiBonus + o.fontBonus]));
  const order = rerankWindows(docs, bonusByDoc, fixture.sqlWindow);
  const finalScore = new Map(order.map((d) => [d.docId, round2(d.relevance + (bonusByDoc.get(d.docId) ?? 0))]));
  return { outcomes, order, finalScore };
}

/** Pages de l'attendu Rust dans l'ordre de première apparition parmi ses occurrences triées. */
const rustPageOrder = (r: FxResult): number[] => [...new Set(r.occurrences.map((o) => o.page))];

const replayable = fixture.scenarios.filter((s) => !SKIPPED_SCENARIOS.has(s.name));

describe("fixture", () => {
  it("contains the 29 reference scenarios, phase 2 included", () => {
    expect(fixture.scenarios).toHaveLength(29);
    const names = new Set(fixture.scenarios.map((s) => s.name));
    for (const name of [
      "police-seuil-arrondi", "police-plafond", "police-sur-requete-un-mot", "police-mot-isole-deux-termes",
      "police-max-du-groupe", "police-egalite-arrondie", "tri-distinct-avant-police", "tri-police-avant-bm25",
      "tri-meilleure-occurrence-par-page", "police-hors-5-pages", "page-letter", "page-paysage",
    ]) expect(names.has(name), name).toBe(true);
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

  it("gives the same final score (base + font bonus + multi-term bonus)", () => {
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

  it("orders the pages like the engine", () => {
    for (const r of sc.expected.results) {
      const o = run.outcomes.get(String(r.id)) as DocOutcome;
      const exposed = rustPageOrder(r);
      expect(o.pagesOrder.slice(0, exposed.length)).toEqual(exposed);
    }
  });

  it("measures the same font size (pt, rounded to 0.1) for each occurrence", () => {
    for (const r of sc.expected.results) {
      const o = run.outcomes.get(String(r.id)) as DocOutcome;
      for (const occ of r.occurrences) {
        expect(o.occurrencesByPage.get(occ.page)?.[occ.occId]?.fontSizePt, `${r.title} p.${occ.page} occ ${occ.occId}`).toBe(occ.fontSize);
      }
    }
  });
});

describe("page-paysage (842 x 595 pt)", () => {
  const sc = fixture.scenarios.find((s) => s.name === "page-paysage") as FxScenario;
  it("uses the real width for the 25 pt threshold: 24 pt joins, 26 pt splits (as the Rust engine does)", () => {
    const run = replay(sc, ourMatching(sc.query));
    const joined = run.outcomes.get(String(sc.documents[0]?.docId)) as DocOutcome;
    const split = run.outcomes.get(String(sc.documents[1]?.docId)) as DocOutcome;
    expect(joined.multiBonus).toBe(5000);
    expect(split.multiBonus).toBe(0);
    expect(joined.occurrencesByPage.get(1)).toHaveLength(1);
    expect(split.occurrencesByPage.get(1)).toHaveLength(2);
    expect(sc.expected.results.map((r) => [r.title, r.relevanceScore])).toEqual([
      ["Paysage joints", 5555],
      ["Paysage separes", 555],
    ]);
  });
  it("uses the real height for the font size: 12 pt on 595 pt (not 17 pt as on A4)", () => {
    const run = replay(sc, ourMatching(sc.query));
    for (const d of sc.documents) {
      const o = run.outcomes.get(String(d.docId)) as DocOutcome;
      for (const occ of o.occurrencesByPage.get(1) ?? []) expect(occ.fontSizePt).toBe(12);
    }
  });
});

describe("production ranker parity (createProximityRanker on the fixture)", () => {
  const ours = replayable.filter((s) => !RUST_MATCHING_SCENARIOS.has(s.name));

  /** getPagesMatches simulé : mêmes mots, mêmes boîtes et mêmes tailles de page que `analyse`. */
  function simulatedMatches(doc: FxDoc, m: Matching) {
    return async (_docId: string, pages: readonly number[]): Promise<ReadonlyMap<number, PageMatch>> => {
      const out = new Map<number, PageMatch>();
      for (const page of pages) {
        const p = doc.pages.find((x) => x.page === page) as FxPage;
        const ordinals: number[] = [];
        const termIndexes: number[] = [];
        p.words.forEach((w, i) => {
          const token = tokenOf(w);
          if (!m.match(token)) return;
          ordinals.push(i);
          termIndexes.push(m.indexOf(token));
        });
        out.set(page, {
          boxes: p.words.map(toBox),
          ordinals,
          termIndexes,
          pageSize: p.size ?? { widthPt: fixture.pageWidthPt, heightPt: fixture.pageHeightPt },
        });
      }
      return out;
    };
  }

  it.each(ours.map((s) => [s.name, s] as const))("%s: same bonuses, page orders and document order as the replay", async (_name, sc) => {
    const m = ourMatching(sc.query);
    const window = sqlWindow(sc.documents, fixture.sqlWindow);
    const byId = new Map(window.map((d) => [String(d.docId), d] as const));
    const ranker = createProximityRanker({
      getPagesMatches: (docId, pages) => simulatedMatches(byId.get(docId) as FxDoc, m)(docId, pages),
      yieldToMain: async () => undefined,
    });
    const docs: RankableDoc[] = window.map((d) => ({
      docId: String(d.docId),
      title: d.title,
      relevance: d.docRelevanceScore,
      // Les pages arrivent au ranker triées par pertinence BM25 (score = -bm25 décroissant, puis page).
      pages: [...d.pages].sort((a, b) => a.bm25 - b.bm25 || a.page - b.page).map((p) => ({ page: p.page, score: -p.bm25 })),
    }));
    const out = await ranker.rank(sc.query, docs, {});
    await out.done;
    const run = replay(sc, m);
    expect(out.failedDocIds.size).toBe(0);
    expect(out.docs.map((d) => d.docId)).toEqual(run.order.map((d) => d.docId));
    for (const [docId, o] of run.outcomes) {
      expect(out.bonusByDoc.get(docId), `${o.title} bonus`).toBe(o.multiBonus + o.fontBonus);
      // Le ranker garde aussi les pages mesurées sans occurrence, en queue ; le replay ne garde que celles avec.
      const order = out.pagesOrderByDoc.get(docId) as readonly number[];
      expect(order.slice(0, o.pagesOrder.length), `${o.title} pages`).toEqual(o.pagesOrder);
      expect(order.slice(o.pagesOrder.length).every((page) => !o.pagesOrder.includes(page))).toBe(true);
    }
  });
});

describe("known gaps with the Rust engine", () => {
  const byName = (name: string): FxScenario => fixture.scenarios.find((s) => s.name === name) as FxScenario;

  it("mot-un-caractere: we match the 1-character word 'a' and count 2 distinct words (Rust ignores it)", () => {
    const sc = byName("mot-un-caractere");
    const o = analyse(sc.documents[0] as FxDoc, ourMatching(sc.query));
    expect(o.multiBonus).toBe(5000);
    expect(sc.expected.results[0]?.relevanceScore).toBe(455);
  });

  it("prefixe-accents-sous-chaine: we require equality for non-last words, so 'eleves' does not match 'eleve'", () => {
    const sc = byName("prefixe-accents-sous-chaine");
    const accents = analyse(sc.documents[0] as FxDoc, ourMatching(sc.query));
    expect(accents.multiBonus).toBe(0);
    const substring = analyse(sc.documents[1] as FxDoc, ourMatching(sc.query));
    expect(substring.multiBonus).toBe(0); // 'souscontrat' (sous-chaîne) non apparié ; Rust : +5000
  });

  it("phrase-et-mot: quoted phrases are plain words for us, so the disordered doc B wrongly gets the bonus", () => {
    const sc = byName("phrase-et-mot");
    const m = ourMatching(sc.query);
    const b = analyse(sc.documents[1] as FxDoc, m);
    expect(m.termCount).toBe(4);
    expect(b.multiBonus).toBe(5000); // Rust : 0 (phrase non satisfaite, doc B à 555)
    expect(sc.expected.results.find((r) => r.title === "B desordre")?.relevanceScore).toBe(555);
  });
});
