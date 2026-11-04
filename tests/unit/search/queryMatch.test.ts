import { describe, expect, it } from "vitest";
import { buildIndex, postingsOf, vocabulary } from "../../../src/core/bm25";
import { isSearchable, makeTermMatcher, titleBonuses } from "../../../src/search/queryMatch";

describe("makeTermMatcher", () => {
  it("egalite pour un mot unique en tant que dernier mot : prefixe", () => {
    const match = makeTermMatcher("rech");
    expect(match("recherche")).toBe(true);
    expect(match("rech")).toBe(true);
    expect(match("cherche")).toBe(false);
  });

  it("egalite pour les mots entiers, prefixe pour le dernier seulement", () => {
    const match = makeTermMatcher("plan rech");
    expect(match("plan")).toBe(true);
    expect(match("planete")).toBe(false);
    expect(match("recherche")).toBe(true);
  });

  it("normalise casse et accents", () => {
    const match = makeTermMatcher("ÉTÉ");
    expect(match("ete")).toBe(true);
    expect(match("etendu")).toBe(true);
  });

  it("requete vide ou sans jeton : rien ne correspond", () => {
    expect(makeTermMatcher("")("a")).toBe(false);
    expect(makeTermMatcher(" -- ")("a")).toBe(false);
  });

  it("est coherent avec collectPostings (via searchPages sur un index reel)", () => {
    const index = buildIndex([
      { docId: "a", page: 1, text: "plan planete planning recherche rechercher" },
      { docId: "b", page: 1, text: "Été etendu ete plan" },
    ]);
    for (const query of ["plan", "plan rech", "ete", "zzz", "rechercher plan", "planete"]) {
      const match = makeTermMatcher(query);
      const tokens = query.toLowerCase().split(" ");
      const last = tokens[tokens.length - 1] as string;
      for (const term of vocabulary(index)) {
        const isLast = term.startsWith(last);
        const isWhole = tokens.slice(0, -1).includes(term);
        const hasPostings = postingsOf(index, term).length > 0;
        expect(hasPostings).toBe(true);
        expect(match(term), `${query} / ${term}`).toBe(isLast || isWhole);
      }
    }
  });
});

describe("isSearchable", () => {
  it("vrai s'il y a au moins un jeton", () => {
    expect(isSearchable("a")).toBe(true);
    expect(isSearchable("  Été! ")).toBe(true);
    expect(isSearchable("42")).toBe(true);
  });
  it("faux sans jeton", () => {
    expect(isSearchable("")).toBe(false);
    expect(isSearchable("   ")).toBe(false);
    expect(isSearchable("-- ?!")).toBe(false);
  });
});

describe("titleBonuses", () => {
  const docs = [
    { docId: "1", title: "Rapport annuel 2024.pdf" },
    { docId: "2", title: "Rapport financier.PDF" },
    { docId: "3", title: "Autre chose-20260901094913-e8yelo4.pdf" },
    { docId: "4", title: "Résumé-20260901094913-e8yelo4" },
  ];

  it("1500 si tous les jetons figurent dans le titre", () => {
    expect(titleBonuses(docs, "rapport annuel").get("1")).toBe(1500);
    expect(titleBonuses(docs, "RAPPORT").get("1")).toBe(1500);
  });

  it("500 si au moins un jeton figure", () => {
    const map = titleBonuses(docs, "rapport annuel");
    expect(map.get("2")).toBe(500);
  });

  it("absent sinon", () => {
    expect(titleBonuses(docs, "zebre").size).toBe(0);
  });

  it("ignore l'extension .pdf et le suffixe d'identifiant SiYuan", () => {
    expect(titleBonuses(docs, "chose").get("3")).toBe(1500);
    expect(titleBonuses(docs, "e8yelo4").has("3")).toBe(false);
    expect(titleBonuses(docs, "20260901094913").has("3")).toBe(false);
    expect(titleBonuses(docs, "pdf").has("1")).toBe(false);
    expect(titleBonuses(docs, "resume").get("4")).toBe(1500);
  });

  it("insensible aux accents", () => {
    expect(titleBonuses(docs, "RESUME").get("4")).toBe(1500);
  });

  it("requete non cherchable ou liste vide : Map vide", () => {
    expect(titleBonuses(docs, "").size).toBe(0);
    expect(titleBonuses(docs, "?!").size).toBe(0);
    expect(titleBonuses([], "rapport").size).toBe(0);
  });
});
