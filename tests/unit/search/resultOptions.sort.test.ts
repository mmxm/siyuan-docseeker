import { describe, expect, it, vi } from "vitest";
import {
  SORT_CHOICES,
  normalizeSearchOptions,
  sortDocs,
  sortFromValue,
  sortToValue,
  type SortDirection,
  type SortKey,
} from "../../../src/search/resultOptions";
import type { DocInfo } from "../../../src/search/searchStore";

interface D {
  readonly docId: string;
  readonly matchingPages: number;
}
const d = (docId: string, matchingPages = 1): D => ({ docId, matchingPages });
const info = (docId: string, over: Partial<DocInfo> = {}): DocInfo => ({
  docId,
  path: `assets/${docId}.pdf`,
  title: docId,
  pageCount: 10,
  pdfSize: 1,
  pdfModifiedMs: 0,
  ...over,
});
const lookup = (infos: DocInfo[]) => {
  const byId = new Map(infos.map((i) => [i.docId, i] as const));
  return (id: string) => byId.get(id);
};
const sort = (docs: D[], key: SortKey, direction: SortDirection, infos: DocInfo[], collator?: Intl.Collator) =>
  sortDocs(docs, { key, direction }, lookup(infos), collator).map((x) => x.docId);

describe("SORT_CHOICES, sortToValue, sortFromValue", () => {
  it("expose exactement huit choix, dans l'ordre d'affichage, avec valeur et clé de libellé", () => {
    expect(SORT_CHOICES.map((c) => [sortToValue(c.spec), c.labelKey])).toEqual([
      ["relevance:desc", "sortRelevanceDesc"],
      ["relevance:asc", "sortRelevanceAsc"],
      ["modified:asc", "sortModifiedAsc"],
      ["modified:desc", "sortModifiedDesc"],
      ["name:asc", "sortNameAsc"],
      ["name:desc", "sortNameDesc"],
      ["path:asc", "sortPathAsc"],
      ["matches:desc", "sortMatchesDesc"],
    ]);
  });

  it("sortToValue / sortFromValue sont inverses pour chaque choix", () => {
    for (const c of SORT_CHOICES) expect(sortFromValue(sortToValue(c.spec))).toEqual(c.spec);
    expect(sortToValue({ key: "name", direction: "asc" })).toBe("name:asc");
  });

  it.each(["foo:asc", "name", "name:up", "", "name:asc:x", "path:desc", "pages:desc", ":asc", "NAME:asc"])(
    "sortFromValue(%j) refuse une valeur non proposée",
    (value) => {
      expect(sortFromValue(value)).toBeUndefined();
    },
  );

  it("normalizeSearchOptions accepte matches et path, et refuse l'ancienne clé « pages »", () => {
    expect(normalizeSearchOptions({ sort: { key: "matches", direction: "desc" } }).sort).toEqual({ key: "matches", direction: "desc" });
    expect(normalizeSearchOptions({ sort: { key: "path", direction: "asc" } }).sort).toEqual({ key: "path", direction: "asc" });
    expect(normalizeSearchOptions({ sort: { key: "pages", direction: "asc" } }).sort).toEqual({ key: "relevance", direction: "desc" });
  });
});

describe("sortDocs", () => {
  const docs = [d("a", 3), d("b", 1), d("c", 2)];

  it("relevance desc : ordre d'entrée, nouvelle liste", () => {
    const out = sortDocs(docs, { key: "relevance", direction: "desc" }, () => undefined);
    expect(out.map((x) => x.docId)).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(docs);
    expect(docs.map((x) => x.docId)).toEqual(["a", "b", "c"]); // entrée intacte
  });

  it("relevance asc : inverse de l'ordre d'entrée", () => {
    expect(sort(docs, "relevance", "asc", [])).toEqual(["c", "b", "a"]);
  });

  it("name asc / desc : par titre, numérique et sans accent ni casse (collator fr)", () => {
    const infos = [info("a", { title: "doc 10" }), info("b", { title: "Doc 2" }), info("c", { title: "école" }), info("e", { title: "Zèbre" })];
    const input = [d("e"), d("a"), d("c"), d("b")];
    expect(sort(input, "name", "asc", infos)).toEqual(["b", "a", "c", "e"]);
    expect(sort(input, "name", "desc", infos)).toEqual(["e", "c", "a", "b"]);
  });

  it("name : collator injecté utilisé (et lui seul)", () => {
    const compare = vi.fn((x: string, y: string) => y.localeCompare(x)); // inversé
    const collator = { compare } as unknown as Intl.Collator;
    const infos = [info("a", { title: "A" }), info("b", { title: "B" })];
    expect(sort([d("a"), d("b")], "name", "asc", infos, collator)).toEqual(["b", "a"]);
    expect(compare).toHaveBeenCalled();
  });

  it("modified asc / desc : par pdfModifiedMs", () => {
    const infos = [info("a", { pdfModifiedMs: 300 }), info("b", { pdfModifiedMs: 100 }), info("c", { pdfModifiedMs: 200 })];
    expect(sort(docs, "modified", "asc", infos)).toEqual(["b", "c", "a"]);
    expect(sort(docs, "modified", "desc", infos)).toEqual(["a", "c", "b"]);
  });

  it("path asc / desc : par chemin (collator)", () => {
    const infos = [info("a", { path: "assets/z/a.pdf" }), info("b", { path: "assets/a/b.pdf" }), info("c", { path: "assets/m/c.pdf" })];
    expect(sort(docs, "path", "asc", infos)).toEqual(["b", "c", "a"]);
    expect(sort(docs, "path", "desc", infos)).toEqual(["a", "c", "b"]);
  });

  it("matches asc / desc : par nombre de pages correspondantes du résultat, sans info nécessaire", () => {
    expect(sort(docs, "matches", "desc", [])).toEqual(["a", "c", "b"]);
    expect(sort(docs, "matches", "asc", [])).toEqual(["b", "c", "a"]);
  });

  it("égalités : ordre d'entrée conservé quel que soit le sens (pas d'inversion), puis docId", () => {
    const infos = [info("a", { pdfModifiedMs: 5 }), info("b", { pdfModifiedMs: 5 }), info("c", { pdfModifiedMs: 5 })];
    const input = [d("c"), d("a"), d("b")];
    expect(sort(input, "modified", "asc", infos)).toEqual(["c", "a", "b"]);
    expect(sort(input, "modified", "desc", infos)).toEqual(["c", "a", "b"]);
    // même docId deux fois : stable, sans exception
    expect(sort([d("a", 1), d("a", 1)], "matches", "desc", [])).toEqual(["a", "a"]);
  });

  it("égalité de nom insensible à la casse : ordre d'entrée", () => {
    const infos = [info("a", { title: "Rapport" }), info("b", { title: "rapport" })];
    expect(sort([d("b"), d("a")], "name", "asc", infos)).toEqual(["b", "a"]);
  });

  it.each<[SortKey, SortDirection]>([
    ["name", "asc"], ["name", "desc"], ["modified", "asc"], ["modified", "desc"], ["path", "asc"], ["path", "desc"],
  ])("document sans info (%s %s) : en fin de liste, sans exception, ordre d'entrée entre eux", (key, direction) => {
    const infos = [info("a", { title: "B", path: "p/b", pdfModifiedMs: 2 }), info("c", { title: "A", path: "p/a", pdfModifiedMs: 1 })];
    const out = sort([d("x"), d("a"), d("y"), d("c")], key, direction, infos);
    expect(out.slice(2)).toEqual(["x", "y"]);
    expect(out.slice(0, 2).sort()).toEqual(["a", "c"]);
  });

  it("liste vide et élément unique", () => {
    expect(sort([], "name", "asc", [])).toEqual([]);
    expect(sort([d("a")], "modified", "desc", [])).toEqual(["a"]);
  });

  it("grande liste : tri correct et rapide (10 000 documents)", () => {
    const n = 10_000;
    const infos = Array.from({ length: n }, (_, i) => info(`d${i}`, { pdfModifiedMs: (i * 7919) % n }));
    const input = infos.map((i) => d(i.docId));
    const out = sortDocs(input, { key: "modified", direction: "asc" }, lookup(infos));
    const byId = lookup(infos);
    for (let i = 1; i < out.length; i++) {
      expect(byId(out[i - 1]!.docId)!.pdfModifiedMs).toBeLessThanOrEqual(byId(out[i]!.docId)!.pdfModifiedMs);
    }
  });
});

describe("tri : dates non finies et garde-fous (J10 10c)", () => {
  const withMs = (id: string, ms: number): DocInfo => info(id, { pdfModifiedMs: ms });
  const docs = ["a", "b", "c", "d"].map((id) => d(id));

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "pdfModifiedMs = %s : traité comme « sans info », en fin dans les DEUX sens, ordre d'entrée conservé",
    (bad) => {
      const infos = [withMs("a", 30), withMs("b", bad), withMs("c", 10), withMs("d", 20)];
      expect(sort(docs, "modified", "asc", infos)).toEqual(["c", "d", "a", "b"]);
      expect(sort(docs, "modified", "desc", infos)).toEqual(["a", "d", "c", "b"]);
    },
  );

  it("plusieurs dates non finies : comparateur transitif (mêmes résultats quel que soit l'ordre d'entrée des valides)", () => {
    const infos = [withMs("a", Number.NaN), withMs("b", Number.POSITIVE_INFINITY), withMs("c", 5), withMs("d", 1)];
    expect(sort(docs, "modified", "asc", infos)).toEqual(["d", "c", "a", "b"]);
    expect(sort([...docs].reverse(), "modified", "asc", infos)).toEqual(["d", "c", "b", "a"]);
    expect(sort(docs, "modified", "desc", infos)).toEqual(["c", "d", "a", "b"]);
  });

  it("isRecord est partagé (exporté) : objets vrai, null et scalaires faux", async () => {
    const mod = await import("../../../src/search/resultOptions");
    expect(mod.isRecord({})).toBe(true);
    expect(mod.isRecord(null)).toBe(false);
    expect(mod.isRecord("x")).toBe(false);
    expect(mod.isRecord(undefined)).toBe(false);
  });

  it("isProposedSort : vrai pour les tris du sélecteur, faux pour un tri valide mais non proposé", async () => {
    const mod = await import("../../../src/search/resultOptions");
    expect(mod.isProposedSort({ key: "name", direction: "asc" })).toBe(true);
    expect(mod.isProposedSort({ key: "path", direction: "desc" })).toBe(false);
    expect(mod.isProposedSort({ key: "matches", direction: "asc" })).toBe(false);
  });
});
