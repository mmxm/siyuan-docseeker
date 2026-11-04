import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  DuplicatePageError,
  groupByDocument,
  idf,
  searchPages,
  termScore,
  type PageHit,
  type PageInput,
} from "../../src/core/bm25";
import { tokenize } from "../../src/core/normalize";

const PERF_PAGES = 60_000; // 20 000 passait meme en O(df^2) (~0,5 s) ; 60 000 = 4,2 s mesurees avant correction
const PERF_BUDGET_MS = 2_500;
const FAST_CHECK_RUNS = 60;

describe("performance de buildIndex / groupByDocument", () => {
  it(`indexe ${PERF_PAGES} pages avec un terme omnipresent sous ${PERF_BUDGET_MS} ms`, () => {
    const pages: PageInput[] = Array.from({ length: PERF_PAGES }, (_, i) => ({
      docId: `d${i % 50}`,
      page: Math.floor(i / 50) + 1,
      text: `commun mot${i % 7}`,
    }));
    const start = performance.now();
    const index = buildIndex(pages);
    expect(index.postings.get("commun")).toHaveLength(PERF_PAGES);
    expect(performance.now() - start).toBeLessThan(PERF_BUDGET_MS);
  });

  it("groupByDocument regroupe 50 000 hits d'un meme document rapidement", () => {
    const hits: PageHit[] = Array.from({ length: 50_000 }, (_, i) => ({ docId: "D", page: i + 1, score: 1 + (i % 9) }));
    const start = performance.now();
    const [group] = groupByDocument(hits);
    expect(group?.matchingPages).toBe(50_000);
    expect(performance.now() - start).toBeLessThan(PERF_BUDGET_MS);
  });
});

/** Oracle naif : recalcule BM25 directement depuis les textes, sans index. */
function naiveSearch(pages: readonly PageInput[], query: string): readonly PageHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || pages.length === 0) return [];
  const tokenized = pages.map((p) => ({ p, tokens: tokenize(p.text) }));
  const avg = tokenized.reduce((s, t) => s + t.tokens.length, 0) / pages.length;
  const tfOf = (tokens: readonly string[], term: string, prefix: boolean): number =>
    tokens.filter((t) => (prefix ? t.startsWith(term) : t === term)).length;
  const dfs = terms.map((term, i) => tokenized.filter((t) => tfOf(t.tokens, term, i === terms.length - 1) > 0).length);
  const hits: PageHit[] = [];
  for (const { p, tokens } of tokenized) {
    const tfs = terms.map((term, i) => tfOf(tokens, term, i === terms.length - 1));
    if (tfs.some((tf) => tf === 0)) continue;
    const score = tfs.reduce(
      (sum, tf, i) =>
        sum + termScore({ tf, pageLength: tokens.length, avgPageLength: avg, idf: idf(pages.length, dfs[i] ?? 0) }),
      0,
    );
    hits.push({ docId: p.docId, page: p.page, score });
  }
  return hits;
}

const WORDS = ["chat", "chats", "chien", "cheval", "ch", "a", "ab", "abc", "été", "ete", "Œuf", "x1"];
const pagesArb = fc
  .uniqueArray(fc.tuple(fc.constantFrom("A", "B", "C", "d"), fc.integer({ min: 1, max: 40 })), {
    selector: ([d, p]) => `${d}/${p}`,
    maxLength: 60,
  })
  .chain((keys) =>
    fc
      .array(fc.array(fc.constantFrom(...WORDS), { maxLength: 8 }), { minLength: keys.length, maxLength: keys.length })
      .map((texts) => keys.map(([docId, page], i) => ({ docId, page, text: (texts[i] ?? []).join(" ") }))),
  );
const queryArb = fc.array(fc.constantFrom(...WORDS, "zz"), { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
const sortKey = (h: PageHit): string => `${h.docId}/${h.page}`;

describe("collectPostings optimise : resultat identique a un calcul naif", () => {
  it("memes pages, memes scores", () => {
    fc.assert(
      fc.property(pagesArb, queryArb, (pages, query) => {
        const actual = [...searchPages(buildIndex(pages), query)].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        const expected = [...naiveSearch(pages, query)].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        expect(actual.map(sortKey)).toEqual(expected.map(sortKey));
        actual.forEach((h, i) => expect(h.score).toBeCloseTo(expected[i]?.score ?? NaN, 10));
      }),
      { numRuns: FAST_CHECK_RUNS },
    );
  });

  it("gros index aleatoire (5 000 pages) : prefixe et exact", () => {
    const vocab = Array.from({ length: 300 }, (_, i) => `t${i.toString(36)}`);
    const pages: PageInput[] = Array.from({ length: 5_000 }, (_, i) => ({
      docId: `d${i % 40}`,
      page: Math.floor(i / 40) + 1,
      text: Array.from({ length: 6 }, (_, j) => vocab[(i * 31 + j * 17 + (i % 5) * j) % vocab.length]).join(" "),
    }));
    const index = buildIndex(pages);
    for (const query of ["t1", "t1 t2a", "t", "t1a t"]) {
      const actual = searchPages(index, query);
      const expected = naiveSearch(pages, query);
      expect(actual).toHaveLength(expected.length);
      const byKey = new Map(expected.map((h) => [sortKey(h), h.score]));
      for (const h of actual) expect(h.score).toBeCloseTo(byKey.get(sortKey(h)) ?? NaN, 10);
    }
  });
});

describe("ordre deterministe (points de code, independant de la locale)", () => {
  it("departage les egalites de score par docId en ordre de points de code", () => {
    const pages: PageInput[] = ["b", "A", "é", "a", "Z", "B"].map((docId) => ({ docId, page: 1, text: "mot" }));
    const ids = searchPages(buildIndex(pages), "mot").map((h) => h.docId);
    expect(ids).toEqual(["A", "B", "Z", "a", "b", "é"]);
  });

  it("groupByDocument departage aussi par points de code", () => {
    const hits: PageHit[] = ["b", "A", "a", "B"].map((docId) => ({ docId, page: 1, score: 1 }));
    expect(groupByDocument(hits).map((g) => g.docId)).toEqual(["A", "B", "a", "b"]);
  });

  it("n'appelle pas localeCompare", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare interdit");
    };
    try {
      const pages: PageInput[] = ["x", "y", "z"].map((docId) => ({ docId, page: 1, text: "mot" }));
      expect(() => groupByDocument(searchPages(buildIndex(pages), "mot"))).not.toThrow();
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

describe("pages en double et pages vides", () => {
  it("leve DuplicatePageError pour un meme (docId, page) insere deux fois", () => {
    const pages: PageInput[] = [
      { docId: "A", page: 1, text: "chat" },
      { docId: "A", page: 1, text: "chat" },
    ];
    expect(() => buildIndex(pages)).toThrow(DuplicatePageError);
    try {
      buildIndex(pages);
    } catch (error) {
      expect(error).toMatchObject({ docId: "A", page: 1, name: "DuplicatePageError" });
    }
  });

  it("accepte la meme page dans deux documents differents", () => {
    expect(buildIndex([
      { docId: "A", page: 1, text: "chat" },
      { docId: "B", page: 1, text: "chat" },
    ]).pageCount).toBe(2);
  });

  it("les pages vides comptent dans N et avgdl mais jamais dans les resultats", () => {
    const index = buildIndex([
      { docId: "A", page: 1, text: "chat chien" },
      { docId: "A", page: 2, text: "" },
      { docId: "A", page: 3, text: " - ' " },
      { docId: "A", page: 4, text: "oiseau" },
    ]);
    expect(index.pageCount).toBe(4);
    expect(index.averagePageLength).toBe(0.75);
    expect(searchPages(index, "chat").map((h) => h.page)).toEqual([1]);
    expect(searchPages(index, "")).toEqual([]);
  });

  it("corpus entierement vide : avgdl 0, pas de NaN, aucun resultat", () => {
    const index = buildIndex([{ docId: "A", page: 1, text: "" }, { docId: "A", page: 2, text: "" }]);
    expect(index.pageCount).toBe(2);
    expect(index.averagePageLength).toBe(0);
    expect(Number.isNaN(index.averagePageLength)).toBe(false);
    expect(searchPages(index, "chat")).toEqual([]);
  });
});

describe("proprietes du classement", () => {
  const shuffled = pagesArb.chain((pages) => fc.tuple(fc.constant(pages), fc.shuffledSubarray(pages, { minLength: pages.length })));

  it("classement invariant a l'ordre d'insertion des pages", () => {
    fc.assert(
      fc.property(shuffled, queryArb, ([pages, permuted], query) => {
        const a = searchPages(buildIndex(pages), query);
        const b = searchPages(buildIndex(permuted), query);
        expect(b.map(sortKey)).toEqual(a.map(sortKey));
        b.forEach((h, i) => expect(h.score).toBeCloseTo(a[i]?.score ?? NaN, 10));
      }),
      { numRuns: FAST_CHECK_RUNS },
    );
  });

  it("scores finis, strictement positifs, tries par ordre decroissant", () => {
    fc.assert(
      fc.property(pagesArb, queryArb, (pages, query) => {
        const hits = searchPages(buildIndex(pages), query);
        hits.forEach((h) => {
          expect(Number.isFinite(h.score)).toBe(true);
          expect(h.score).toBeGreaterThan(0);
        });
        hits.slice(1).forEach((h, i) => expect(h.score).toBeLessThanOrEqual(hits[i]?.score ?? Infinity));
      }),
      { numRuns: FAST_CHECK_RUNS },
    );
  });

  it("ET : les resultats sont inclus dans ceux de chaque terme (exact) seul", () => {
    fc.assert(
      fc.property(pagesArb, fc.constantFrom(...WORDS), fc.constantFrom(...WORDS), (pages, w1, w2) => {
        const index = buildIndex(pages);
        const both = new Set(searchPages(index, `${w1} ${w2}`).map(sortKey));
        const solo2 = new Set(searchPages(index, w2).map(sortKey));
        const exact1 = new Set(pages.filter((p) => tokenize(p.text).includes(tokenize(w1)[0] ?? "")).map((p) => `${p.docId}/${p.page}`));
        for (const key of both) {
          expect(solo2.has(key)).toBe(true);
          expect(exact1.has(key)).toBe(true);
        }
      }),
      { numRuns: FAST_CHECK_RUNS },
    );
  });

  it("requete insensible a la casse et aux accents", () => {
    fc.assert(
      fc.property(pagesArb, queryArb, (pages, query) => {
        const index = buildIndex(pages);
        const variant = query.toUpperCase().replace(/e/gi, "é").replace(/ete/gi, "ÉTÉ");
        const base = searchPages(index, query).map(sortKey);
        // 'é' vs 'e' : meme token normalise ; on compare avec la requete normalisee de la meme facon.
        expect(searchPages(index, query.toUpperCase()).map(sortKey)).toEqual(base);
        expect(searchPages(index, variant).map(sortKey)).toEqual(searchPages(index, tokenize(variant).join(" ")).map(sortKey));
        expect(searchPages(index, query.normalize("NFD")).map(sortKey)).toEqual(base);
      }),
      { numRuns: FAST_CHECK_RUNS },
    );
  });
});

describe("groupByDocument : bonus de titre et departage", () => {
  const hits: PageHit[] = [
    { docId: "strong", page: 1, score: 2 },
    { docId: "weak", page: 1, score: 0.5 },
    { docId: "partial", page: 1, score: 1 },
  ];

  it("un titre complet (1500) l'emporte sur un meilleur score ; titre partiel (500) classe entre les deux", () => {
    const groups = groupByDocument(hits, { titleBonuses: new Map([["weak", 1500], ["partial", 500]]) });
    expect(groups.map((g) => g.docId)).toEqual(["weak", "partial", "strong"]);
  });

  it("titre partiel (500) contre meilleur score sans titre : 500 + 100 > 2*100", () => {
    const groups = groupByDocument(hits, { titleBonuses: new Map([["weak", 500]]) });
    expect(groups[0]?.docId).toBe("weak");
  });

  it("egalite de pertinence departagee par docId (DocSeeker departage par titre : ecart documente)", () => {
    const tie: PageHit[] = ["z", "m", "a"].map((docId) => ({ docId, page: 1, score: 1 }));
    expect(groupByDocument(tie).map((g) => g.docId)).toEqual(["a", "m", "z"]);
  });
});
