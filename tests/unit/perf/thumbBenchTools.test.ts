import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENARIOS,
  expandScenario,
  matchCorpusName,
  summarizeReady,
} from "../../perf/thumbs/benchTools";
import { parseRangeHeader, resolveInside } from "../../perf/thumbs/serverTools";

describe("resolveInside", () => {
  it("résout un fichier sous la racine", () => {
    expect(resolveInside("/root/dir", "a b.pdf")).toBe("/root/dir/a b.pdf");
    expect(resolveInside("/root/dir", "sub/x.js")).toBe("/root/dir/sub/x.js");
  });
  it.each(["../secret", "a/../../secret", "/etc/passwd", "..", "a\0b", ""])("refuse %j", (rel) => {
    expect(resolveInside("/root/dir", rel)).toBeNull();
  });
  it("refuse un dossier voisin de même préfixe", () => {
    expect(resolveInside("/root/dir", "../dir2/x")).toBeNull();
  });
});

describe("parseRangeHeader", () => {
  it("sans en-tête : fichier entier", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "full" });
  });
  it("plage fermée, bornée à la taille", () => {
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ kind: "range", start: 10, end: 19 });
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 99 });
  });
  it("plage ouverte et suffixe", () => {
    expect(parseRangeHeader("bytes=10-", 100)).toEqual({ kind: "range", start: 10, end: 99 });
    expect(parseRangeHeader("bytes=-20", 100)).toEqual({ kind: "range", start: 80, end: 99 });
  });
  it.each(["bytes=100-", "bytes=5-2", "bytes=a-b", "items=0-1", "bytes=0-1,3-4", "bytes=-0"])("invalide : %s", (h) => {
    expect(parseRangeHeader(h, 100)).toEqual({ kind: "unsatisfiable" });
  });
  it("fichier vide : toute plage est insatisfaisable", () => {
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("summarizeReady", () => {
  it("first / median / last et erreurs (temps négatifs)", () => {
    expect(summarizeReady([300, -100, 200, 400])).toEqual({ first: 100, median: 250, last: 400, errors: 1 });
  });
  it("une seule valeur", () => {
    expect(summarizeReady([42])).toEqual({ first: 42, median: 42, last: 42, errors: 0 });
  });
  it("liste vide : refuse", () => {
    expect(() => summarizeReady([])).toThrow(RangeError);
  });
});

describe("matchCorpusName", () => {
  it("ignore la forme Unicode (NFC/NFD)", () => {
    const nfd = "Néphrologie - 11E 2024.pdf".normalize("NFD");
    expect(matchCorpusName([nfd, "x.pdf"], "Néphrologie - 11E 2024.pdf".normalize("NFC"))).toBe(nfd);
  });
  it("introuvable : undefined", () => {
    expect(matchCorpusName(["a.pdf"], "b.pdf")).toBeUndefined();
  });
});

describe("expandScenario / DEFAULT_SCENARIOS", () => {
  it("développe fichiers x pages dans l'ordre", () => {
    expect(expandScenario([{ file: "a.pdf", pages: [1, 2] }, { file: "b.pdf", pages: [7] }])).toEqual([
      { file: "a.pdf", page: 1 },
      { file: "a.pdf", page: 2 },
      { file: "b.pdf", page: 7 },
    ]);
  });
  it("scénarios par défaut : Pilly 12 pages, texte 10 pages, mélange de 5 PDF", () => {
    expect(expandScenario(DEFAULT_SCENARIOS.pilly)).toHaveLength(12);
    expect(expandScenario(DEFAULT_SCENARIOS.text).map((i) => i.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(DEFAULT_SCENARIOS.mix.map((s) => s.file)).size).toBe(5);
  });
});
