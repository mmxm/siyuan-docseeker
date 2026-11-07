import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  HISTORY_QUERY_MAX_LENGTH,
  addToHistory,
  clearHistory,
  normalizeHistory,
} from "../../../src/search/searchHistory";

describe("addToHistory", () => {
  it("met la requête la plus récente en tête", () => {
    expect(addToHistory(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });
  it("dédoublonne : une requête déjà présente remonte en tête", () => {
    expect(addToHistory(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
  it("trim avant d'ajouter et de comparer", () => {
    expect(addToHistory(["chat"], "  chat \n")).toEqual(["chat"]);
    expect(addToHistory([], "  chien ")).toEqual(["chien"]);
  });
  it("ignore le vide et les espaces seuls (liste inchangée, même contenu)", () => {
    expect(addToHistory(["a"], "")).toEqual(["a"]);
    expect(addToHistory(["a"], "   \t")).toEqual(["a"]);
  });
  it("plafonne à 20 en retirant la plus ancienne", () => {
    let list: readonly string[] = [];
    for (let i = 0; i < 25; i += 1) list = addToHistory(list, `q${i}`);
    expect(HISTORY_LIMIT).toBe(20);
    expect(list).toHaveLength(20);
    expect(list[0]).toBe("q24");
    expect(list[19]).toBe("q5");
  });
  it("sensible à la casse (la saisie de l'utilisateur est gardée telle quelle)", () => {
    expect(addToHistory(["chat"], "Chat")).toEqual(["Chat", "chat"]);
  });
  it("ne mémorise pas une requête trop longue", () => {
    const long = "x".repeat(HISTORY_QUERY_MAX_LENGTH + 1);
    expect(addToHistory(["a"], long)).toEqual(["a"]);
    const ok = "x".repeat(HISTORY_QUERY_MAX_LENGTH);
    expect(addToHistory([], ok)).toEqual([ok]);
  });
  it("une requête de 200 caractères avec espaces est gardée (la longueur se mesure après trim)", () => {
    const core = `a ${"b ".repeat(98)}cc`; // 200 caractères, espaces internes
    expect(core).toHaveLength(HISTORY_QUERY_MAX_LENGTH);
    expect(addToHistory([], `  ${core}  `)).toEqual([core]);
  });
  it("la limite compte des unités UTF-16 : 100 émojis (200 unités) passent, 101 non", () => {
    const hundred = "😀".repeat(100);
    expect(hundred.length).toBe(200);
    expect(addToHistory([], hundred)).toEqual([hundred]);
    expect(addToHistory(["a"], "😀".repeat(101))).toEqual(["a"]);
    // Un émoji à cheval sur la frontière : 199 lettres + 1 émoji = 201 unités, refusé.
    expect(addToHistory([], `${"x".repeat(199)}😀`)).toEqual([]);
  });
  it("garde les caractères spéciaux et l'Unicode", () => {
    expect(addToHistory([], "été 😀 <b>&\"'; DROP")).toEqual(["été 😀 <b>&\"'; DROP"]);
  });
  it("ne modifie pas la liste d'entrée", () => {
    const input = Object.freeze(["a", "b"]);
    expect(() => addToHistory(input, "c")).not.toThrow();
    expect(input).toEqual(["a", "b"]);
  });
});

describe("clearHistory", () => {
  it("renvoie une liste vide", () => {
    expect(clearHistory()).toEqual([]);
  });
  it("renvoie un tableau distinct à chaque appel (pas de partage d'état)", () => {
    const a = clearHistory();
    const b = clearHistory();
    expect(a).not.toBe(b);
    a.push("x");
    expect(clearHistory()).toEqual([]);
  });
});

describe("normalizeHistory", () => {
  it("accepte une liste propre telle quelle", () => {
    expect(normalizeHistory(["a", "b"])).toEqual({ history: ["a", "b"], valid: true });
  });
  it("absent (ancien fichier) : liste vide, valide", () => {
    expect(normalizeHistory(undefined)).toEqual({ history: [], valid: true });
  });
  it("pas un tableau : liste vide, invalide", () => {
    expect(normalizeHistory("chat")).toEqual({ history: [], valid: false });
    expect(normalizeHistory({ 0: "a" })).toEqual({ history: [], valid: false });
    expect(normalizeHistory(null)).toEqual({ history: [], valid: false });
  });
  it("retire les entrées non texte, vides ou en double, et signale", () => {
    expect(normalizeHistory(["a", 3, "", "  ", "a", " b ", null])).toEqual({ history: ["a", "b"], valid: false });
  });
  it("plafonne à 20 en gardant les plus récentes (en tête) et signale", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `q${i}`);
    const out = normalizeHistory(raw);
    expect(out.history).toEqual(raw.slice(0, 20));
    expect(out.valid).toBe(false);
  });
  it("exactement 20 valides : gardées, valide", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `q${i}`);
    expect(normalizeHistory(raw)).toEqual({ history: raw, valid: true });
  });
  it("21 valides : les 20 premières, invalide", () => {
    const raw = Array.from({ length: 21 }, (_, i) => `q${i}`);
    expect(normalizeHistory(raw)).toEqual({ history: raw.slice(0, 20), valid: false });
  });
  it("entrée de plus de 200 caractères : retirée, invalide", () => {
    const out = normalizeHistory(["a", "x".repeat(HISTORY_QUERY_MAX_LENGTH + 1), "b"]);
    expect(out).toEqual({ history: ["a", "b"], valid: false });
  });
  it("tableau creux : les trous sont ignorés, invalide", () => {
    const sparse = ["a", , "b"] as unknown[]; // eslint-disable-line no-sparse-arrays
    expect(normalizeHistory(sparse)).toEqual({ history: ["a", "b"], valid: false });
  });
  it("entrée avec espaces autour : corrigée (trim), invalide", () => {
    expect(normalizeHistory([" a "])).toEqual({ history: ["a"], valid: false });
  });
});
