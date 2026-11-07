import { describe, expect, it } from "vitest";
import {
  MATCH_WEIGHT,
  MIN_SUBSTRING_LENGTH,
  MatchClass,
  classifyTerm,
  queryWordRules,
  type QueryWordRule,
} from "../../src/core/termMatch";

const rulesOf = (...words: string[]): [QueryWordRule, QueryWordRule] => {
  const [first, second] = queryWordRules(words);
  if (!first || !second) throw new Error("deux mots attendus");
  return [first, second];
};
const [early, last] = rulesOf("bpco", "pco");

describe("queryWordRules", () => {
  it("seul le dernier mot accepte le préfixe", () => {
    expect(early.allowPrefix).toBe(false);
    expect(last.allowPrefix).toBe(true);
  });

  it("la sous-chaîne exige MIN_SUBSTRING_LENGTH caractères (points de code)", () => {
    expect(MIN_SUBSTRING_LENGTH).toBe(3);
    const [two, three, astral] = queryWordRules(["pc", "pco", "😀😀"]);
    expect(two?.allowSubstring).toBe(false);
    expect(three?.allowSubstring).toBe(true);
    expect(astral?.allowSubstring).toBe(false);
  });

  it("liste vide : aucune règle", () => {
    expect(queryWordRules([])).toEqual([]);
  });
});

describe("classifyTerm", () => {
  it("exact > préfixe > sous-chaîne > aucun", () => {
    expect(classifyTerm("pco", last)).toBe(MatchClass.Exact);
    expect(classifyTerm("pcos", last)).toBe(MatchClass.Prefix);
    expect(classifyTerm("bpco", last)).toBe(MatchClass.Substring);
    expect(classifyTerm("xyz", last)).toBe(MatchClass.None);
  });

  it("un mot non final n'accepte pas le préfixe mais accepte la sous-chaîne", () => {
    expect(classifyTerm("bpco", early)).toBe(MatchClass.Exact);
    expect(classifyTerm("bpcos", early)).toBe(MatchClass.Substring);
    expect(classifyTerm("abpco", early)).toBe(MatchClass.Substring);
  });

  it("sous le seuil : exact, et préfixe seulement pour le dernier mot", () => {
    const [shortEarly, shortLast] = rulesOf("pc", "pc");
    expect(classifyTerm("pc", shortEarly)).toBe(MatchClass.Exact);
    expect(classifyTerm("pcr", shortEarly)).toBe(MatchClass.None);
    expect(classifyTerm("bpco", shortEarly)).toBe(MatchClass.None);
    expect(classifyTerm("pcr", shortLast)).toBe(MatchClass.Prefix);
    expect(classifyTerm("bpco", shortLast)).toBe(MatchClass.None);
  });

  it("les poids décroissent avec la classe et None vaut 0", () => {
    expect(MATCH_WEIGHT[MatchClass.None]).toBe(0);
    expect(MATCH_WEIGHT[MatchClass.Exact]).toBe(1);
    expect(MATCH_WEIGHT[MatchClass.Exact]).toBeGreaterThan(MATCH_WEIGHT[MatchClass.Prefix]);
    expect(MATCH_WEIGHT[MatchClass.Prefix]).toBeGreaterThan(MATCH_WEIGHT[MatchClass.Substring]);
    expect(MATCH_WEIGHT[MatchClass.Substring]).toBeGreaterThan(0);
  });
});
