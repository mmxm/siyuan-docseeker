import { describe, expect, it } from "vitest";
import { buildIndex, searchPages } from "../../../src/core/bm25";
import { tokenize } from "../../../src/core/normalize";
import { makeTermMatcher } from "../../../src/search/queryMatch";

const PAGES = [
  { docId: "d1", page: 1, text: "Le patient a une bronchopneumopathie obstructive" },
  { docId: "d1", page: 2, text: "patients obstruction a b c 7 œuvre ÉTÉ" },
  { docId: "d2", page: 1, text: "a a a patient obstr" },
  { docId: "d2", page: 2, text: "bronchopneumopathie seule, sans patient" },
  { docId: "d2", page: 3, text: "ete oeuvre 7" },
];
const QUERIES = [
  "a", "a a", "patient patient", "patient pat", "pat patient", "pat obstr", "patient obstr", "bronchopneumopathie obstr",
  "b c", "c b", "7", "7 a", "œuvre ete", "OEUVRE ÉTÉ", "  patient,, --  obstr!! ", "x", "", " -- ", "le a une", "obstr obstr obstr",
];

/** Règle écrite indépendamment de termMatch.ts : égalité, préfixe (dernier mot), sous-chaîne (3 car. minimum). */
const acceptsTerm = (word: string, isLast: boolean, term: string): boolean =>
  term === word || (isLast && term.startsWith(word)) || ([...word].length >= 3 && term.includes(word));

describe("cohérence searchPages / makeTermMatcher", () => {
  const index = buildIndex(PAGES);
  const termsByPage = new Map<string, Set<string>>(PAGES.map((p) => [`${p.docId}#${p.page}`, new Set(tokenize(p.text))]));

  for (const query of QUERIES) {
    it(`pages trouvées = pages où chaque mot requis est retenu par le matcher : ${JSON.stringify(query)}`, () => {
      const words = tokenize(query);
      const matcher = makeTermMatcher(query);
      const found = new Set(searchPages(index, query).map((h) => `${h.docId}#${h.page}`));
      const expected = new Set<string>();
      if (words.length > 0) {
        for (const [key, terms] of termsByPage) {
          const ok = words.every((w, i) => [...terms].some((t) => acceptsTerm(w, i === words.length - 1, t)));
          if (ok) expected.add(key);
        }
      }
      expect(found).toEqual(expected);
      // Toute page trouvée a au moins un terme retenu par le matcher (il y aura donc des boîtes à surligner).
      for (const key of found) expect([...(termsByPage.get(key) ?? [])].some(matcher), key).toBe(true);
      // Chaque mot requis est retenu par le matcher sur au moins un terme de la page.
      for (const key of found) {
        for (const w of words) {
          expect([...(termsByPage.get(key) ?? [])].some((t) => t.includes(w) && matcher(t)), `${key} ${w}`).toBe(true);
        }
      }
    });
  }

  it("un mot précoce n'est pas un préfixe mais accepte la sous-chaîne, dans la recherche comme dans le matcher", () => {
    // 'pat' (3 car.) est une sous-chaîne de 'patient' : trouvé ; sous le seuil il faudrait le mot entier.
    expect(searchPages(index, "pat obstr").length).toBeGreaterThan(0);
    expect(searchPages(index, "pa obstr")).toHaveLength(0);
    expect(makeTermMatcher("pat obstr")("patient")).toBe(true);
    expect(makeTermMatcher("pa obstr")("patient")).toBe(false);
    expect(makeTermMatcher("pa obstr")("obstructive")).toBe(true);
  });

  it("requête dupliquée : le mot final accepte le préfixe, le matcher est aligné", () => {
    const keys = searchPages(index, "patient patient").map((h) => `${h.docId}#${h.page}`).sort();
    // d1#2 ne contient que « patients » : trouvé par sous-chaîne (premier mot) ET par préfixe (dernier mot).
    expect(keys).toEqual(["d1#1", "d1#2", "d2#1", "d2#2"]);
    expect(makeTermMatcher("patient patient")("patients")).toBe(true);
  });

  it("mots d'une lettre et chiffres : pas de liste d'arrêt, le préfixe d'une lettre s'applique", () => {
    expect(searchPages(index, "7").map((h) => h.page).sort()).toEqual([2, 3]);
    expect(makeTermMatcher("a")("patient")).toBe(false);
    expect(makeTermMatcher("a")("a")).toBe(true);
    expect(makeTermMatcher("le a une")("le")).toBe(true);
  });
});
