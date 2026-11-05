import { describe, expect, it } from "vitest";
import {
  isExcludedName,
  median,
  parseBudgetMinutes,
  pendingEntries,
  percentile,
  selectCorpusNames,
  summarizeTimings,
} from "../../perf/corpusTools";

describe("isExcludedName", () => {
  it.each(["OffNoteA_1.pdf", "x RaceNote.pdf", "RT_crlf.pdf", "ZipExportNote 1.pdf"])("exclut %s", (name) => {
    expect(isExcludedName(name)).toBe(true);
  });
  it("garde un PDF normal", () => {
    expect(isExcludedName("023 - Grossesse normale.pdf")).toBe(false);
  });
});

describe("selectCorpusNames", () => {
  const names = ["b.pdf", "a.PDF", "c.md", "RT_x.pdf", "ItemBpco.pdf", "d.pdf"];
  it("ne garde que les PDF non exclus, triés (ordre des points de code)", () => {
    expect(selectCorpusNames(names, {})).toEqual(["ItemBpco.pdf", "a.PDF", "b.pdf", "d.pdf"]);
  });
  it("applique le filtre (insensible à la casse) puis la limite", () => {
    expect(selectCorpusNames(names, { filter: "bpco" })).toEqual(["ItemBpco.pdf"]);
    expect(selectCorpusNames(names, { limit: 2 })).toEqual(["ItemBpco.pdf", "a.PDF"]);
  });
  it("limite 0 ou invalide : pas de limite", () => {
    expect(selectCorpusNames(names, { limit: 0 })).toHaveLength(4);
    expect(selectCorpusNames(names, { limit: Number.NaN })).toHaveLength(4);
  });
});

describe("median / percentile", () => {
  it("mediane impaire et paire", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("p95 au rang le plus proche, sans muter l'entrée", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    const copy = [...values];
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 100)).toBe(20);
    expect(percentile(values, 0)).toBe(1);
    expect(values).toEqual(copy);
  });
  it("une valeur unique", () => {
    expect(percentile([7], 95)).toBe(7);
  });
  it("entrée vide : erreur", () => {
    expect(() => median([])).toThrow();
    expect(() => percentile([], 95)).toThrow();
  });
  it("summarizeTimings", () => {
    expect(summarizeTimings([5, 1, 3])).toEqual({ min: 1, median: 3, p95: 5, max: 5, runs: 3 });
  });
});

describe("pendingEntries (reprise)", () => {
  const entries = [
    { path: "a.pdf", size: 1, modifiedAt: 0 },
    { path: "b.pdf", size: 2, modifiedAt: 0 },
  ];
  it("écarte ceux dont le .dsx ou le marqueur existe déjà", () => {
    const done = new Set(["a.pdf"]);
    expect(pendingEntries(entries, (e) => done.has(e.path))).toEqual([entries[1]]);
  });
  it("tout est à faire si rien n'existe", () => {
    expect(pendingEntries(entries, () => false)).toEqual(entries);
  });
});

describe("parseBudgetMinutes", () => {
  it("défaut 25", () => expect(parseBudgetMinutes(undefined)).toBe(25));
  it("valeur valide", () => expect(parseBudgetMinutes("0.5")).toBe(0.5));
  it("invalide ou négatif : défaut", () => {
    expect(parseBudgetMinutes("abc")).toBe(25);
    expect(parseBudgetMinutes("-3")).toBe(25);
    expect(parseBudgetMinutes("0")).toBe(25);
  });
});
