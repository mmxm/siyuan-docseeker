import { describe, expect, it } from "vitest";
import { buildIndex, searchPages } from "../../../src/core/bm25";
import { isSearchable, makeTermIndexer, makeTermIndexesOf, makeTermMatcher, titleBonuses } from "../../../src/search/queryMatch";

describe("makeTermIndexer", () => {
  it("renvoie l'index du mot de la requete (mots distincts, ordre d'apparition), -1 sinon", () => {
    const indexOf = makeTermIndexer("Classification BPCO");
    expect(indexOf("classification")).toBe(0);
    expect(indexOf("bpco")).toBe(1);
    expect(indexOf("classifications")).toBe(0); // contient « classification »
    expect(indexOf("autre")).toBe(-1);
  });

  it("le dernier mot est un prefixe, les autres des mots entiers ou des sous-chaines (3 car. minimum)", () => {
    const indexOf = makeTermIndexer("plan rech");
    expect(indexOf("planete")).toBe(0); // contient « plan » (sous-chaine)
    expect(indexOf("recherche")).toBe(1);
    expect(indexOf("replan")).toBe(0);
    expect(makeTermIndexer("pl rech")("replan")).toBe(-1); // « pl » : sous le seuil, mot entier exigé
    expect(makeTermIndexer("pl rech")("planete")).toBe(-1); // et pas de prefixe hors dernier mot
  });

  it("deduplique les mots repetes et reste coherent avec makeTermMatcher", () => {
    const indexOf = makeTermIndexer("plan plan rech");
    const match = makeTermMatcher("plan plan rech");
    expect(indexOf("plan")).toBe(0);
    expect(indexOf("recherche")).toBe(1);
    for (const t of ["plan", "planete", "rech", "recherche", "x"]) expect(indexOf(t) >= 0).toBe(match(t));
  });

  it("un terme qui satisfait deux mots de la requete : le meilleur mot, et la liste complete ailleurs", () => {
    expect(makeTermIndexer("abc bcd")("abcd")).toBe(0);
    expect(makeTermIndexesOf("abc bcd")("abcd")).toEqual([0, 1]);
    expect(makeTermMatcher("abc bcd")("abcd")).toBe(true);
  });

  it("requete sans jeton : -1", () => {
    expect(makeTermIndexer("")("a")).toBe(-1);
  });
});

describe("makeTermMatcher", () => {
  it("egalite pour un mot unique en tant que dernier mot : prefixe", () => {
    const match = makeTermMatcher("rech");
    expect(match("recherche")).toBe(true);
    expect(match("rech")).toBe(true);
    expect(match("cherche")).toBe(false);
  });

  it("mot entier ou sous-chaine pour les mots non finaux, prefixe ou sous-chaine pour le dernier", () => {
    const match = makeTermMatcher("plan rech");
    expect(match("plan")).toBe(true);
    expect(match("planete")).toBe(true); // contient « plan »
    expect(match("pl")).toBe(false);
    expect(makeTermMatcher("pl rech")("planete")).toBe(false); // sous le seuil : mot entier exigé
    expect(match("replan")).toBe(true);
    expect(match("recherche")).toBe(true);
    expect(match("prerecherche")).toBe(true);
  });

  it("sous-chaine : « pco » retient « bpco » ; sous le seuil, « pc » ne retient pas « bpco »", () => {
    expect(makeTermMatcher("pco")("bpco")).toBe(true);
    expect(makeTermMatcher("pc")("bpco")).toBe(false);
    expect(makeTermMatcher("pc")("pcr")).toBe(true);
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

  it("est coherent avec searchPages (index reel) : mot unique", () => {
    const words = ["plan", "planete", "planning", "recherche", "rechercher", "ete", "etendu", "complete", "pl", "te"];
    for (const query of ["plan", "pl", "ete", "te", "zzz", "planete", "cher"]) {
      const match = makeTermMatcher(query);
      for (const term of words) {
        const found = searchPages(buildIndex([{ docId: "x", page: 1, text: term }]), query).length > 0;
        expect(match(term), `${query} / ${term}`).toBe(found);
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
