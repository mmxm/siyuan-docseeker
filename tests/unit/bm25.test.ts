import { describe, expect, it } from "vitest";
import {
  BM25_B,
  BM25_K1,
  buildIndex,
  postingsOf,
  groupByDocument,
  idf,
  MAX_EXPANDED_PAGES,
  searchPages,
  termScore,
  toFtsBm25,
  type PageInput,
} from "../../src/core/bm25";

// Parite DocSeeker (source de verite = SQLite FTS5 bm25(), pas de BM25 maison) :
// - backend-rust/crates/search-core/src/sql.rs:183 et :~250  `bm25(pages_fts) as page_bm25`
//   (table pages_fts, une ligne FTS5 = une page, colonne unique text_content, poids par defaut :
//    k1 = 1.2, b = 0.75 ; schema.rs:54-59 tokenize='unicode61 remove_diacritics 2').
// - sql.rs:213-218 : score document = titre(1500|500) + |min(page_bm25)|*100 + min(nbPages*5, 300).
// - sql.rs:230 / :245 : pages triees par page_bm25 ASC (valeurs negatives = meilleur en premier).
// - constants.rs:17-18 MAX_MATCHING_PAGES_PER_DOC = 5 ; constants.rs:21 TITLE_MATCH_BONUS = 1500.
// - matching.rs:91-124 : clause MATCH `mot*` (prefixe) joint par AND. DocSeeker met le prefixe sur
//   TOUS les mots ; ici, par decision produit, uniquement sur le DERNIER (ecart documente).
// Formule FTS5 : idf = ln((N-df+0.5)/(df+0.5)) plancher 1e-6 ; score = -idf*tf*(k1+1)/(tf+k1*(1-b+b*dl/avgdl)).
// Nos scores sont POSITIFS (plus grand = meilleur) ; toFtsBm25(s) = -s redonne la valeur FTS5.

// Mini-corpus : 3 documents, 6 pages, N = 6, total 18 tokens, avgdl = 3.
const CORPUS: readonly PageInput[] = [
  { docId: "A", page: 1, text: "Chat chat chien" }, // dl 3
  { docId: "A", page: 2, text: "oiseau poisson" }, // dl 2
  { docId: "B", page: 1, text: "chat souris" }, // dl 2
  { docId: "B", page: 2, text: "poisson poisson poisson rouge" }, // dl 4
  { docId: "C", page: 1, text: "chien oiseau poisson" }, // dl 3
  { docId: "C", page: 2, text: "cheval blanc vert gris" }, // dl 4
];

const IDF_DF2_OF_6 = Math.log(4.5 / 2.5); // ln 1.8
const K = BM25_K1;

describe("constantes", () => {
  it("utilise les valeurs par defaut de FTS5", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });
});

describe("idf", () => {
  it("calcule ln((N-df+0.5)/(df+0.5))", () => {
    expect(idf(6, 2)).toBeCloseTo(IDF_DF2_OF_6, 12);
  });

  it("applique le plancher 1e-6 quand l'idf est negatif (terme sur plus de la moitie des pages)", () => {
    expect(idf(6, 4)).toBe(1e-6);
  });
});

describe("termScore", () => {
  it("calcule idf*tf*(k1+1)/(tf+k1*(1-b+b*dl/avgdl)) a la main (tf=2, dl=avgdl)", () => {
    // K = 1.2 * (0.25 + 0.75) = 1.2 ; 2*2.2/(2+1.2) = 1.375
    expect(termScore({ tf: 2, pageLength: 3, avgPageLength: 3, idf: 1 })).toBeCloseTo(1.375, 12);
  });

  it("penalise les pages plus longues que la moyenne", () => {
    const shortPage = termScore({ tf: 1, pageLength: 2, avgPageLength: 3, idf: 1 });
    const longPage = termScore({ tf: 1, pageLength: 6, avgPageLength: 3, idf: 1 });
    expect(shortPage).toBeGreaterThan(longPage);
  });

  it("retourne 0 si avgPageLength vaut 0 (index vide)", () => {
    expect(termScore({ tf: 1, pageLength: 0, avgPageLength: 0, idf: 1 })).toBe(0);
  });
});

describe("buildIndex", () => {
  it("compte N, avgdl et les postings", () => {
    const index = buildIndex(CORPUS);
    expect(index.pageCount).toBe(6);
    expect(index.averagePageLength).toBe(3);
    expect(postingsOf(index, "chat")).toEqual([
      { docId: "A", page: 1, tf: 2 },
      { docId: "B", page: 1, tf: 1 },
    ]);
  });

  it("gere un corpus vide", () => {
    const index = buildIndex([]);
    expect(index.pageCount).toBe(0);
    expect(index.averagePageLength).toBe(0);
  });
});

describe("buildIndex : numeros de page", () => {
  it.each([0, -1, 1.5, Number.NaN, 10_000_001])("rejette la page %s", (page) => {
    expect(() => buildIndex([{ docId: "A", page, text: "chat" }])).toThrow(RangeError);
  });

  it("accepte des numeros de page creux (longueur 0 pour les pages absentes, N compte les pages indexees)", () => {
    const index = buildIndex([
      { docId: "A", page: 1, text: "chat" },
      { docId: "A", page: 5, text: "chat chien" },
    ]);
    expect(index.pageCount).toBe(2);
    expect(index.averagePageLength).toBe(1.5);
    expect(searchPages(index, "chien").map((h) => h.page)).toEqual([5]);
  });
});

describe("searchPages", () => {
  const index = buildIndex(CORPUS);

  it("score un terme unique comme FTS5 (valeurs calculees a la main)", () => {
    // chat : df=2, idf=ln1.8.
    // A1 : tf=2, dl=3 -> 2*2.2/(2+1.2)=1.375 ; B1 : tf=1, dl=2 -> K'=1.2*(0.25+0.75*2/3)=0.9 ; 2.2/1.9
    const hits = searchPages(index, "chat");
    expect(hits.map((h) => [h.docId, h.page])).toEqual([["A", 1], ["B", 1]]);
    expect(hits[0]?.score).toBeCloseTo(IDF_DF2_OF_6 * 1.375, 10);
    expect(hits[1]?.score).toBeCloseTo((IDF_DF2_OF_6 * 2.2) / 1.9, 10);
  });

  it("expose la valeur FTS5 negative via toFtsBm25", () => {
    const hit = searchPages(index, "chat")[0];
    expect(toFtsBm25(hit?.score ?? 0)).toBeCloseTo(-IDF_DF2_OF_6 * 1.375, 10);
  });

  it("somme les termes en ET et exclut les pages incompletes", () => {
    // chat+chien : seule A1 contient les deux. chien : df=2 (A1,C1), tf=1, dl=3 -> 2.2/(1+1.2)=1.
    const hits = searchPages(index, "chat chien");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.docId).toBe("A");
    expect(hits[0]?.score).toBeCloseTo(IDF_DF2_OF_6 * (1.375 + 1), 10);
  });

  it("l'ET s'evalue au niveau page, pas au niveau document", () => {
    // oiseau (A2, C1) et souris (B1) : aucune page commune
    expect(searchPages(index, "oiseau souris")).toEqual([]);
    // chien (A1) et oiseau (A2) : meme document, pages differentes
    expect(searchPages(index, "chien poisson rouge")).toEqual([]);
  });

  it("applique le prefixe au dernier mot seulement", () => {
    // 'chi' est prefixe du dernier mot -> chien ; A1 contient chat et chien.
    expect(searchPages(index, "chat chi").map((h) => h.docId)).toEqual(["A"]);
    // 'ch' n'est PAS le dernier mot -> exact, aucun token 'ch'
    expect(searchPages(index, "ch chien")).toEqual([]);
  });

  it("fusionne tf et df des tokens couverts par le prefixe (plancher idf)", () => {
    // 'ch*' : chat(A1:2,B1:1) chien(A1:1,C1:1) cheval(C2:1) -> A1 tf=3 ; df=4 pages -> idf=1e-6
    const hit = searchPages(index, "ch").find((h) => h.docId === "A");
    expect(hit?.score).toBeCloseTo((1e-6 * 3 * 2.2) / (3 + K), 12);
  });

  it("n'applique pas le prefixe aux mots non finaux en mode exact", () => {
    expect(searchPages(index, "cha chien")).toEqual([]);
  });

  it("ignore accents et casse dans la requete", () => {
    const withAccents = buildIndex([
      { docId: "X", page: 1, text: "L'Été Œuvre" },
      { docId: "X", page: 2, text: "autre chose" },
      { docId: "Y", page: 1, text: "rien ici" },
      { docId: "Y", page: 2, text: "vide total" },
    ]);
    expect(searchPages(withAccents, "ETE")).toHaveLength(1);
    expect(searchPages(withAccents, "oeuvre")).toHaveLength(1);
    expect(searchPages(withAccents, "éTé œUVRE")).toHaveLength(1);
  });

  it("retourne [] pour une requete vide ou de separateurs", () => {
    expect(searchPages(index, "")).toEqual([]);
    expect(searchPages(index, "  - ' ")).toEqual([]);
  });

  it("retourne [] pour un terme absent", () => {
    expect(searchPages(index, "zebre")).toEqual([]);
  });

  it("retourne [] si un terme parmi plusieurs est absent", () => {
    expect(searchPages(index, "chat zebre")).toEqual([]);
  });

  it("classe par score decroissant puis docId/page croissants en cas d'egalite", () => {
    const hits = searchPages(index, "poisson");
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(hits[0]).toMatchObject({ docId: "B", page: 2 }); // tf=3
  });

  it("retourne [] sur un index vide", () => {
    expect(searchPages(buildIndex([]), "chat")).toEqual([]);
  });
});

describe("groupByDocument", () => {
  const index = buildIndex(CORPUS);

  it("regroupe par document avec meilleure page, nb de pages et pertinence", () => {
    // chat : A1 (1.375*idf) puis B1
    const groups = groupByDocument(searchPages(index, "chat"));
    expect(groups.map((g) => g.docId)).toEqual(["A", "B"]);
    const first = groups[0];
    expect(first?.matchingPages).toBe(1);
    expect(first?.bestScore).toBeCloseTo(IDF_DF2_OF_6 * 1.375, 10);
    // relevance = |best|*100 + min(1*5, 300)
    expect(first?.relevance).toBeCloseTo(IDF_DF2_OF_6 * 1.375 * 100 + 5, 8);
    expect(first?.pages.map((p) => p.page)).toEqual([1]);
  });

  it("ajoute le bonus de titre fourni et reordonne", () => {
    const hits = searchPages(index, "chat");
    const groups = groupByDocument(hits, { titleBonuses: new Map([["B", 1500]]) });
    expect(groups.map((g) => g.docId)).toEqual(["B", "A"]);
    expect(groups[0]?.relevance).toBeCloseTo((IDF_DF2_OF_6 * 2.2) / 1.9 * 100 + 5 + 1500, 8);
  });

  it("conserve toutes les pages correspondantes (jusqu'au plafond), triees par score decroissant, et plafonne le bonus de pages", () => {
    const many: PageInput[] = Array.from({ length: 80 }, (_, i) => ({
      docId: "D",
      page: i + 1,
      text: i < 10 ? "alpha" : `autre${i}`,
    }));
    const groups = groupByDocument(searchPages(buildIndex(many), "alpha"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.matchingPages).toBe(10);
    expect(groups[0]?.pages).toHaveLength(10);
    const bonus = (groups[0]?.relevance ?? 0) - (groups[0]?.bestScore ?? 0) * 100;
    expect(bonus).toBeCloseTo(50, 8); // 10 pages * 5
  });

  it("plafonne la liste de pages a MAX_EXPANDED_PAGES sans changer l'ordre ni matchingPages", () => {
    const total = MAX_EXPANDED_PAGES + 50;
    const many: PageInput[] = Array.from({ length: total }, (_, i) => ({
      docId: "D",
      page: i + 1,
      text: `alpha ${"mot ".repeat(i % 7)}`,
    }));
    const hits = searchPages(buildIndex(many), "alpha");
    const groups = groupByDocument(hits);
    expect(groups[0]?.matchingPages).toBe(total);
    expect(groups[0]?.pages).toHaveLength(MAX_EXPANDED_PAGES);
    expect(groups[0]?.pages.map((p) => p.page)).toEqual(hits.slice(0, MAX_EXPANDED_PAGES).map((h) => h.page));
  });

  it("frontiere du plafond : 200 pages gardees telles quelles, 201 tronquees a 200", () => {
    for (const [n, kept] of [[MAX_EXPANDED_PAGES, MAX_EXPANDED_PAGES], [MAX_EXPANDED_PAGES + 1, MAX_EXPANDED_PAGES]] as const) {
      const many: PageInput[] = Array.from({ length: n }, (_, i) => ({ docId: "D", page: i + 1, text: "alpha" }));
      const g = groupByDocument(searchPages(buildIndex(many), "alpha"));
      expect(g[0]?.matchingPages).toBe(n);
      expect(g[0]?.pages).toHaveLength(kept);
    }
  });

  it("plafonne le bonus de nombre de pages a 300", () => {
    const many: PageInput[] = Array.from({ length: 200 }, (_, i) => ({
      docId: "D",
      page: i + 1,
      text: i < 100 ? "alpha" : `autre${i}`,
    }));
    const [group] = groupByDocument(searchPages(buildIndex(many), "alpha"));
    expect((group?.relevance ?? 0) - (group?.bestScore ?? 0) * 100).toBeCloseTo(300, 8);
  });

  it("retourne [] sans resultat", () => {
    expect(groupByDocument([])).toEqual([]);
  });

  it("ne modifie pas ses entrees", () => {
    const hits = Object.freeze(searchPages(index, "chat"));
    expect(() => groupByDocument(hits)).not.toThrow();
  });
});
