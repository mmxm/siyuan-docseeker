import { describe, expect, it } from "vitest";
import { buildIndex, idf, indexOfSegments, makeSegment, searchPages, termScore, type DocumentSegment } from "../../src/core/bm25";
import { MATCH_WEIGHT, MatchClass } from "../../src/core/termMatch";
import { makeTermIndexer, makeTermMatcher } from "../../src/search/queryMatch";
import { tokenize } from "../../src/core/normalize";

const pagesOf = (hits: ReturnType<typeof searchPages>): string[] => hits.map((h) => `${h.docId}#${h.page}`);

const INDEX = buildIndex([
  { docId: "a", page: 1, text: "BPCO exacerbation sévère" },
  { docId: "a", page: 2, text: "pcr et pco" },
  { docId: "b", page: 1, text: "bronchite chronique" },
  { docId: "b", page: 2, text: "rien à voir" },
]);

describe("recherche par sous-chaîne", () => {
  it("« pco » trouve « bpco » (sous-chaîne) et « pco » (exact)", () => {
    expect(pagesOf(searchPages(INDEX, "pco")).sort()).toEqual(["a#1", "a#2"]);
  });

  it("insensible à la casse et aux accents", () => {
    expect(pagesOf(searchPages(INDEX, "PCÖ")).sort()).toEqual(["a#1", "a#2"]);
    expect(pagesOf(searchPages(INDEX, "sévè"))).toEqual(["a#1"]);
    expect(pagesOf(searchPages(INDEX, "SEVER"))).toEqual(["a#1"]);
  });

  it("multi-mots : sous-chaîne sur un mot non final", () => {
    expect(pagesOf(searchPages(INDEX, "pco exac"))).toEqual(["a#1"]);
    expect(pagesOf(searchPages(INDEX, "pco zzz"))).toEqual([]);
  });

  it("seuil : « pc » (2 car.) ne trouve pas « bpco » mais est préfixe de « pcr » en dernier mot", () => {
    expect(pagesOf(searchPages(INDEX, "pc"))).toEqual(["a#2"]);
    expect(pagesOf(searchPages(INDEX, "pc exacerbation"))).toEqual([]);
  });

  it("mot entier et préfixe inchangés", () => {
    expect(pagesOf(searchPages(INDEX, "bpco"))).toEqual(["a#1"]);
    expect(pagesOf(searchPages(INDEX, "bron"))).toEqual(["b#1"]);
  });

  it("requête sans correspondance : aucun résultat", () => {
    expect(searchPages(INDEX, "qqqq")).toEqual([]);
  });
});

describe("classement exact > préfixe > sous-chaîne", () => {
  it("un terme exact passe avant un préfixe, avant une sous-chaîne", () => {
    const idx = buildIndex([
      { docId: "sub", page: 1, text: "xx abcd yy" },
      { docId: "pre", page: 1, text: "xx bcda yy" },
      { docId: "exa", page: 1, text: "xx bcd yy" },
      { docId: "other", page: 1, text: "xx zz yy" },
    ]);
    expect(searchPages(idx, "bcd").map((h) => h.docId)).toEqual(["exa", "pre", "sub"]);
  });

  it("ordre aussi pour un mot non final (exact > sous-chaîne)", () => {
    const idx = buildIndex([
      { docId: "sub", page: 1, text: "abcd tail" },
      { docId: "exa", page: 1, text: "bcd tail" },
      { docId: "other", page: 1, text: "zz yy" },
    ]);
    expect(searchPages(idx, "bcd tail").map((h) => h.docId)).toEqual(["exa", "sub"]);
  });

  it("score = termScore avec tf pondéré par la classe", () => {
    const idx = buildIndex([
      { docId: "d", page: 1, text: "abcd" },
      { docId: "e", page: 1, text: "zz" },
    ]);
    const [hit] = searchPages(idx, "bcd");
    const expected = termScore({
      tf: MATCH_WEIGHT[MatchClass.Substring],
      pageLength: 1,
      avgPageLength: 1,
      idf: idf(2, 1),
    });
    expect(hit?.score).toBeCloseTo(expected, 12);
  });

  it("tf cumulé sur plusieurs termes de classes différentes dans une page", () => {
    const idx = buildIndex([
      { docId: "d", page: 1, text: "bcd bcda abcd" },
      { docId: "e", page: 1, text: "zz yy xx" },
    ]);
    const [hit] = searchPages(idx, "bcd");
    const tf = MATCH_WEIGHT[MatchClass.Exact] + MATCH_WEIGHT[MatchClass.Prefix] + MATCH_WEIGHT[MatchClass.Substring];
    expect(hit?.score).toBeCloseTo(termScore({ tf, pageLength: 3, avgPageLength: 3, idf: idf(2, 1) }), 12);
  });

  it("df = pages distinctes ayant au moins un terme apparié (idf cohérent)", () => {
    const idx = buildIndex([
      { docId: "d", page: 1, text: "bcd abcd" },
      { docId: "d", page: 2, text: "xbcd" },
      { docId: "d", page: 3, text: "zz" },
      { docId: "d", page: 4, text: "yy" },
    ]);
    const hit = searchPages(idx, "bcd").find((h) => h.page === 2);
    const tf = MATCH_WEIGHT[MatchClass.Substring];
    expect(hit?.score).toBeCloseTo(termScore({ tf, pageLength: 1, avgPageLength: 5 / 4, idf: idf(4, 2) }), 12);
  });
});

describe("plusieurs segments", () => {
  it("la sous-chaîne s'applique dans chaque segment, df global", () => {
    const seg = (docId: string, terms: string[]) =>
      makeSegment(docId, new Uint32Array([1]), {
        terms,
        offsets: Uint32Array.from([0, ...terms.map((_, i) => i + 1)]),
        pages: new Uint32Array(terms.map(() => 1)),
        termFrequencies: new Uint32Array(terms.map(() => 1)),
      });
    const idx = indexOfSegments([seg("s1", ["abcd"]), seg("s2", ["bcd"]), seg("s3", ["zzz"])]);
    expect(searchPages(idx, "bcd").map((h) => h.docId)).toEqual(["s2", "s1"]);
  });
});

describe("surlignage = recherche", () => {
  const terms = ["bpco", "pco", "pcos", "pc", "pcr", "exacerbation", "xyz", "co"];

  it("makeTermMatcher à un mot retient exactement les termes que searchPages apparie", () => {
    for (const query of ["pco", "pc", "co", "exac", "pcos"]) {
      const matcher = makeTermMatcher(query);
      for (const term of terms) {
        const found = searchPages(buildIndex([{ docId: "x", page: 1, text: term }]), query).length > 0;
        expect(matcher(term), `${query} / ${term}`).toBe(found);
      }
    }
  });

  it("pages trouvées => au moins un terme retenu (surlignage non vide)", () => {
    const pages = [
      { docId: "a", page: 1, text: "BPCO exacerbation" },
      { docId: "a", page: 2, text: "pcr" },
    ];
    const idx = buildIndex(pages);
    for (const query of ["pco", "pco exac", "pc", "exacerb pco"]) {
      const matcher = makeTermMatcher(query);
      for (const hit of searchPages(idx, query)) {
        const text = pages.find((p) => p.page === hit.page)?.text ?? "";
        expect(tokenize(text).some(matcher), `${query} p${hit.page}`).toBe(true);
      }
    }
  });

  it("makeTermIndexer : sous-chaîne sur un mot non final, meilleur mot gagne", () => {
    const indexOf = makeTermIndexer("pco exac");
    expect(indexOf("bpco")).toBe(0);
    expect(indexOf("exacerbation")).toBe(1);
    expect(indexOf("xyz")).toBe(-1);
    expect(makeTermMatcher("pco exac")("bpco")).toBe(true);
  });

  it("makeTermIndexer : la classe la plus forte l'emporte entre deux mots", () => {
    const indexOf = makeTermIndexer("bpco pco");
    expect(indexOf("bpco")).toBe(0); // exact pour le mot 0, sous-chaîne pour le mot 1
    expect(indexOf("pco")).toBe(1);
  });

  it("makeTermIndexer sous le seuil : inchangé", () => {
    const indexOf = makeTermIndexer("pc");
    expect(indexOf("pcr")).toBe(0);
    expect(indexOf("bpco")).toBe(-1);
  });
});

/**
 * Poids écrits en dur (1, 0.6, 0.3) : changer MATCH_WEIGHT doit faire échouer ces tests.
 * Index de 3 pages d'un seul terme : N = 3, df = 1 pour le terme cherché, longueur de page 1, longueur moyenne 1.
 */
const HARD_IDF = Math.log((3 - 1 + 0.5) / (1 + 0.5));
const hardScore = (tf: number): number => termScore({ tf, pageLength: 1, avgPageLength: 1, idf: HARD_IDF });
const singleTermIndex = (term: string) =>
  buildIndex([
    { docId: "t", page: 1, text: term },
    { docId: "f1", page: 1, text: "zz" },
    { docId: "f2", page: 1, text: "yy" },
  ]);
const scoreOf = (term: string, query: string): number | undefined => searchPages(singleTermIndex(term), query)[0]?.score;

describe("poids de classe en dur", () => {
  it("exact 1, préfixe 0.6, sous-chaîne 0.3", () => {
    expect(scoreOf("bcd", "bcd")).toBeCloseTo(hardScore(1), 12);
    expect(scoreOf("bcda", "bcd")).toBeCloseTo(hardScore(0.6), 12);
    expect(scoreOf("abcd", "bcd")).toBeCloseTo(hardScore(0.3), 12);
  });
});

describe("mots de requête qui se recouvrent", () => {
  // Choix : chaque mot de la requête compte son propre tf (comme BM25 pour un mot répété), même si un seul terme de
  // la page les satisfait tous. La page reste trouvée (ET satisfait) et son score est la somme des mots.
  it("« pco bpco » sur « bpco » : sous-chaîne (0.3) + exact (1)", () => {
    expect(scoreOf("bpco", "pco bpco")).toBeCloseTo(hardScore(0.3) + hardScore(1), 12);
  });

  it("« bpco pco » sur « bpco » : exact (1) + sous-chaîne (0.3), même score", () => {
    expect(scoreOf("bpco", "bpco pco")).toBeCloseTo(hardScore(1) + hardScore(0.3), 12);
  });

  it("« pco pco pco » sur « pco » : trois fois le mot exact", () => {
    expect(scoreOf("pco", "pco pco pco")).toBeCloseTo(3 * hardScore(1), 12);
  });

  it("« patient patients » sur « patients » : sous-chaîne (0.3) + exact (1)", () => {
    expect(scoreOf("patients", "patient patients")).toBeCloseTo(hardScore(0.3) + hardScore(1), 12);
  });

  it("« patient patient » sur « patients » : sous-chaîne (0.3) + préfixe du dernier mot (0.6)", () => {
    expect(scoreOf("patients", "patient patient")).toBeCloseTo(hardScore(0.3) + hardScore(0.6), 12);
  });

  it("« abc bcd » sur « abcd » seul : page trouvée", () => {
    expect(searchPages(singleTermIndex("abcd"), "abc bcd").map((h) => h.docId)).toEqual(["t"]);
  });
});

describe("seuil et mots courts mélangés", () => {
  const index = buildIndex([
    { docId: "p1", page: 1, text: "pc bpco" },
    { docId: "p2", page: 1, text: "pcr bpco" },
    { docId: "p3", page: 1, text: "bpco pcr" },
    { docId: "p4", page: 1, text: "bpco bpc" },
    { docId: "p5", page: 1, text: "co exacerbation" },
    { docId: "p6", page: 1, text: "bpco exacerbation" },
  ]);
  const docs = (query: string): string[] => searchPages(index, query).map((h) => h.docId).sort();

  it("« pc pco » : « pc » non final exige le mot entier", () => {
    expect(docs("pc pco")).toEqual(["p1"]);
  });

  it("« pco pc » : « pc » final accepte le préfixe mais pas la sous-chaîne (p4 : « bpc » refusé)", () => {
    expect(docs("pco pc")).toEqual(["p1", "p2", "p3"]);
  });

  it("« co exacerb » : « co » (2 caractères) non final exige le mot entier", () => {
    expect(docs("co exacerb")).toEqual(["p5"]);
  });
});

describe("lettres hors BMP", () => {
  const index = buildIndex([
    { docId: "cjk", page: 1, text: "a𠀀𠀁𠀂b" },
    { docId: "other", page: 1, text: "zz" },
  ]);

  it("l'index garde le mot hors BMP comme un seul terme", () => {
    expect(tokenize("a𠀀𠀁𠀂b")).toHaveLength(1);
  });

  it("3 points de code acceptent la sous-chaîne", () => {
    expect(searchPages(index, "𠀀𠀁𠀂").map((h) => h.docId)).toEqual(["cjk"]);
    expect(makeTermMatcher("𠀀𠀁𠀂")("a𠀀𠀁𠀂b")).toBe(true);
  });

  it("2 points de code (4 unités UTF-16) la refusent", () => {
    expect(searchPages(index, "𠀀𠀁")).toEqual([]);
    expect(makeTermMatcher("𠀀𠀁")("a𠀀𠀁𠀂b")).toBe(false);
  });
});

describe("plusieurs segments", () => {
  const pageIn = (docId: string, text: string) => ({ docId, page: 1, text });

  it("ET dont chaque mot est dans un segment différent : aucun résultat", () => {
    const index = buildIndex([pageIn("a", "abcd"), pageIn("b", "wxyz")]);
    expect(searchPages(index, "abc wxy")).toEqual([]);
  });

  it("le df global change l'idf : score vérifié avec df = 2 sur 5 pages", () => {
    const index = buildIndex([
      pageIn("a", "abcd"),
      pageIn("b", "abcd"),
      pageIn("c", "zz"),
      pageIn("d", "yy"),
      pageIn("e", "xx"),
    ]);
    const hits = searchPages(index, "bcd");
    expect(hits.map((h) => h.docId)).toEqual(["a", "b"]);
    const hardIdf = Math.log((5 - 2 + 0.5) / (2 + 0.5));
    for (const hit of hits) {
      expect(hit.score).toBeCloseTo(termScore({ tf: 0.3, pageLength: 1, avgPageLength: 1, idf: hardIdf }), 12);
    }
  });

  it("un segment vide ou sans correspondance ne perturbe ni le résultat ni N", () => {
    const empty: DocumentSegment = makeSegment(
      "empty",
      new Uint32Array(0),
      { terms: [], offsets: new Uint32Array(1), pages: new Uint32Array(0), termFrequencies: new Uint32Array(0) },
      0,
    );
    const base = buildIndex([pageIn("a", "abcd"), pageIn("b", "zz"), pageIn("c", "yy")]);
    const withEmpty = indexOfSegments([...base.segments, empty]);
    expect(searchPages(withEmpty, "bcd")).toEqual(searchPages(base, "bcd"));
    expect(withEmpty.pageCount).toBe(base.pageCount);
    expect(searchPages(withEmpty, "qqq")).toEqual([]);
  });
});

describe("performance (non fragile)", () => {
  const SEGMENT_COUNT = 300;
  const TERMS_PER_SEGMENT = 2_000;
  const MIN_WORD_LENGTH = 3;
  const MAX_WORD_LENGTH = 14;
  const PERF_BUDGET_MS = 1_000;
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

  /** Générateur congruentiel déterministe : mêmes mots à chaque exécution. */
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function realisticSegment(docId: string, random: () => number): DocumentSegment {
    const words = new Set<string>();
    while (words.size < TERMS_PER_SEGMENT) {
      const length = MIN_WORD_LENGTH + Math.floor(random() * (MAX_WORD_LENGTH - MIN_WORD_LENGTH + 1));
      let word = "";
      for (let i = 0; i < length; i++) word += ALPHABET[Math.floor(random() * ALPHABET.length)];
      words.add(word);
    }
    const terms = [...words].sort();
    return makeSegment(docId, new Uint32Array([terms.length]), {
      terms,
      offsets: Uint32Array.from({ length: terms.length + 1 }, (_, i) => i),
      pages: new Uint32Array(terms.length).fill(1),
      termFrequencies: new Uint32Array(terms.length).fill(1),
    });
  }

  it("300 segments x 2 000 termes, requête de 3 mots : sous 1 s", () => {
    const random = makeRandom(42);
    const index = indexOfSegments(Array.from({ length: SEGMENT_COUNT }, (_, i) => realisticSegment(`d${i}`, random)));
    const start = performance.now();
    const hits = searchPages(index, "ab er ion");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });
});
