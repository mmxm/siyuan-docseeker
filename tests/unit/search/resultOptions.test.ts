import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  DEFAULT_SORT,
  NO_FILTERS,
  applyFilters,
  countActiveFilters,
  isValidPageRange,
  normalizeSearchOptions,
  normalizedNeedle,
  sameOptions,
  type ResultFilters,
} from "../../../src/search/resultOptions";
import type { DocInfo } from "../../../src/search/searchStore";

function info(docId: string, path: string, over: Partial<DocInfo> = {}): DocInfo {
  const base = path.split("/").pop() ?? path;
  return { docId, path, title: base.replace(/\.pdf$/i, ""), pageCount: 10, pdfSize: 1, pdfModifiedMs: 1_000, ...over };
}

const NFC = "\u00e9"; // é précomposé
const NFD = "e\u0301"; // e + accent combinant

function run(docs: DocInfo[], filters: Partial<ResultFilters>) {
  const byId = new Map(docs.map((d) => [d.docId, d] as const));
  return applyFilters(
    docs.map((d) => ({ docId: d.docId })),
    { ...NO_FILTERS, ...filters },
    (id) => byId.get(id),
  );
}
const ids = (r: { kept: readonly { docId: string }[] }) => r.kept.map((d) => d.docId);

describe("constantes", () => {
  it("DEFAULT_SORT est la pertinence décroissante et NO_FILTERS n'active rien", () => {
    expect(DEFAULT_SORT).toEqual({ key: "relevance", direction: "desc" });
    expect(NO_FILTERS).toEqual({ includeSubfolders: true, nameContains: "" });
    expect(DEFAULT_OPTIONS).toEqual({ sort: DEFAULT_SORT, filters: NO_FILTERS });
    expect(countActiveFilters(NO_FILTERS)).toBe(0);
  });
});

describe("applyFilters : sans filtre actif", () => {
  const docs = [
    info("1", "assets/a/x.pdf"),
    info("2", "assets/ab/y.pdf"),
    info("3", "assets/a/sub/z.pdf"),
    info("4", "assets/root.pdf"),
  ];

  it("sans filtre, tout est gardé et rien n'est masqué", () => {
    const r = run(docs, {});
    expect(ids(r)).toEqual(["1", "2", "3", "4"]);
    expect(r.hidden).toBe(0);
  });

  it("includeSubfolders sans portée de documents ne filtre rien", () => {
    expect(ids(run(docs, { includeSubfolders: false }))).toEqual(["1", "2", "3", "4"]);
  });

  it("un ancien champ `folder` transmis par erreur n'a plus aucun effet", () => {
    const legacy = { ...NO_FILTERS, folder: "assets/a/" } as ResultFilters;
    const byId = new Map(docs.map((d) => [d.docId, d] as const));
    const r = applyFilters(docs.map((d) => ({ docId: d.docId })), legacy, (id) => byId.get(id));
    expect(ids(r)).toEqual(["1", "2", "3", "4"]);
  });

  it("conserve l'ordre d'entrée", () => {
    expect(ids(run([docs[2]!, docs[0]!], { nameContains: "z" }))).toEqual(["3"]);
    expect(ids(run([docs[2]!, docs[0]!], {}))).toEqual(["3", "1"]);
  });
});

describe("applyFilters : nom", () => {
  const docs = [info("1", "assets/Anesthésie Réanimation-2020.pdf"), info("2", "assets/Cardio.pdf")];

  it("insensible à la casse et aux accents", () => {
    expect(ids(run(docs, { nameContains: "anesthesie" }))).toEqual(["1"]);
    expect(ids(run(docs, { nameContains: "RÉANIMATION" }))).toEqual(["1"]);
  });

  it("ignore les espaces autour de la saisie ; une saisie blanche ne filtre pas", () => {
    expect(ids(run(docs, { nameContains: "  cardio " }))).toEqual(["2"]);
    expect(ids(run(docs, { nameContains: "   " }))).toEqual(["1", "2"]);
  });

  it("compare NFD contre NFC dans les deux sens", () => {
    const nfdTitle = [info("1", "assets/x.pdf", { title: `Cardi${NFD}` })];
    expect(ids(run(nfdTitle, { nameContains: `cardi${NFC}` }))).toEqual(["1"]);
    const nfcTitle = [info("1", "assets/x.pdf", { title: `Cardi${NFC}` })];
    expect(ids(run(nfcTitle, { nameContains: `CARDI${NFD}` }))).toEqual(["1"]);
  });

  it("tolère « _ », « - » et les espaces : « mon fichier » trouve mon_fichier", () => {
    const d = [info("u", "assets/mon_fichier.pdf"), info("h", "assets/mon-fichier.pdf"), info("o", "assets/autre.pdf")];
    expect(ids(run(d, { nameContains: "mon fichier" }))).toEqual(["u", "h"]);
    expect(ids(run(d, { nameContains: "mon_fichier" }))).toEqual(["u", "h"]);
    expect(ids(run([info("s", "assets/mon fichier.pdf")], { nameContains: "mon-fichier" }))).toEqual(["s"]);
  });

  it("un besoin fait seulement de diacritiques ou d'espaces est inactif", () => {
    const r = run(docs, { nameContains: "\u0301" });
    expect(ids(r)).toEqual(["1", "2"]);
    expect(r.hidden).toBe(0);
    expect(ids(run(docs, { nameContains: "   " }))).toEqual(["1", "2"]);
  });

  it("compare sur le titre, pas sur le dossier", () => {
    expect(ids(run(docs, { nameContains: "assets" }))).toEqual([]);
  });

  it("aucun document ne correspond : tous masqués", () => {
    const r = run(docs, { nameContains: "zzz" });
    expect(r.kept).toEqual([]);
    expect(r.hidden).toBe(2);
  });
});

describe("applyFilters : pages et date", () => {
  const docs = [
    info("p5", "assets/a.pdf", { pageCount: 5 }),
    info("p10", "assets/b.pdf", { pageCount: 10 }),
    info("p20", "assets/c.pdf", { pageCount: 20 }),
  ];

  it("bornes de pages incluses", () => {
    expect(ids(run(docs, { minPages: 10 }))).toEqual(["p10", "p20"]);
    expect(ids(run(docs, { maxPages: 10 }))).toEqual(["p5", "p10"]);
    expect(ids(run(docs, { minPages: 10, maxPages: 10 }))).toEqual(["p10"]);
  });

  it("modifiedAfterMs : borne incluse", () => {
    const d = [
      info("old", "assets/a.pdf", { pdfModifiedMs: 999 }),
      info("on", "assets/b.pdf", { pdfModifiedMs: 1_000 }),
      info("new", "assets/c.pdf", { pdfModifiedMs: 1_001 }),
    ];
    expect(ids(run(d, { modifiedAfterMs: 1_000 }))).toEqual(["on", "new"]);
  });

  it("modifiedAfterMs à 0 (epoch) est un filtre actif valide", () => {
    const d = [info("a", "assets/a.pdf", { pdfModifiedMs: 5 })];
    expect(ids(run(d, { modifiedAfterMs: 6 }))).toEqual([]);
    expect(ids(run(d, { modifiedAfterMs: 0 }))).toEqual(["a"]);
  });
});

describe("applyFilters : combinaison et documents inconnus", () => {
  it("combine les critères en ET", () => {
    const docs = [
      info("1", "assets/a/chat.pdf", { pageCount: 10, pdfModifiedMs: 2_000 }),
      info("2", "assets/a/chien.pdf", { pageCount: 10, pdfModifiedMs: 2_000 }),
      info("3", "assets/b/chat.pdf", { pageCount: 10, pdfModifiedMs: 2_000 }),
      info("4", "assets/a/chat2.pdf", { pageCount: 3, pdfModifiedMs: 2_000 }),
      info("5", "assets/a/chat3.pdf", { pageCount: 10, pdfModifiedMs: 100 }),
    ];
    const byId = new Map(docs.map((d) => [d.docId, d] as const));
    const scope = { kind: "notebook", box: "20240101000000-aaaaaaa", label: "A" } as const;
    // Portée = les PDF de assets/a/ (déjà résolue) : ET avec le nom, les pages et la date.
    const cited = new Set(docs.filter((d) => d.path.startsWith("assets/a/")).map((d) => d.path));
    const r = applyFilters(
      docs.map((d) => ({ docId: d.docId })),
      { ...NO_FILTERS, scopes: [scope], nameContains: "chat", minPages: 5, modifiedAfterMs: 1_000 },
      (id) => byId.get(id),
      cited,
    );
    expect(ids(r)).toEqual(["1"]);
    expect(r.hidden).toBe(4);
  });

  it("document absent de getInfo : conservé, compté comme non filtrable, sans exception", () => {
    const known = info("k", "assets/a/k.pdf");
    const r = applyFilters(
      [{ docId: "k" }, { docId: "ghost" }],
      { ...NO_FILTERS, nameContains: "zzz" },
      (id) => (id === "k" ? known : undefined),
    );
    expect(r).toEqual({ kept: [{ docId: "ghost" }], hidden: 1 });
  });

  it("sans filtre actif, un document inconnu est conservé", () => {
    expect(applyFilters([{ docId: "ghost" }], NO_FILTERS, () => undefined)).toEqual({ kept: [{ docId: "ghost" }], hidden: 0 });
  });

  it("document fantôme avec filtre sur le nom : conservé sans exception", () => {
    const r = applyFilters([{ docId: "ghost" }], { ...NO_FILTERS, nameContains: "x" }, () => undefined);
    expect(r).toEqual({ kept: [{ docId: "ghost" }], hidden: 0 });
  });

  it("`kept` est une nouvelle liste, même sans filtre actif", () => {
    const input = [{ docId: "a" }];
    expect(applyFilters(input, NO_FILTERS, () => undefined).kept).not.toBe(input);
    const withFilter = applyFilters(input, { ...NO_FILTERS, minPages: 1 }, () => info("a", "a.pdf"));
    expect(withFilter.kept).not.toBe(input);
    expect(withFilter).toEqual({ kept: [{ docId: "a" }], hidden: 0 });
  });

  it("liste vide : aucun résultat, aucune exception", () => {
    expect(applyFilters([], { ...NO_FILTERS, minPages: 1 }, () => undefined)).toEqual({ kept: [], hidden: 0 });
  });

  it("bornes de pages contradictoires (min > max) : ignorées", () => {
    const docs = [info("1", "assets/a.pdf", { pageCount: 5 })];
    expect(ids(run(docs, { minPages: 9, maxPages: 2 }))).toEqual(["1"]);
  });
});

describe("countActiveFilters", () => {
  it("compte un par critère actif ; sous-dossiers seul ne compte pas", () => {
    expect(countActiveFilters({ ...NO_FILTERS, includeSubfolders: false })).toBe(0);
    expect(countActiveFilters({ ...NO_FILTERS, nameContains: "assets" })).toBe(1);
    expect(countActiveFilters({ ...NO_FILTERS, nameContains: "  " })).toBe(0);
    expect(countActiveFilters({ ...NO_FILTERS, nameContains: "\u0301" })).toBe(0);
    expect(
      countActiveFilters({ includeSubfolders: true, nameContains: "x", minPages: 2, maxPages: 9, modifiedAfterMs: 0, scopes: [{ kind: "notebook", box: "b", label: "L" }] }),
    ).toBe(5);
  });

  it("des bornes contradictoires ne comptent pas", () => {
    expect(countActiveFilters({ ...NO_FILTERS, minPages: 9, maxPages: 2 })).toBe(0);
  });
});

describe("normalizeSearchOptions", () => {
  it("valeurs par défaut pour une entrée absente ou invalide", () => {
    expect(normalizeSearchOptions(undefined)).toEqual(DEFAULT_OPTIONS);
    expect(normalizeSearchOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(normalizeSearchOptions("x")).toEqual(DEFAULT_OPTIONS);
    expect(normalizeSearchOptions({ sort: 3, filters: "no" })).toEqual(DEFAULT_OPTIONS);
  });

  it("rejette les nombres non entiers, nuls, négatifs ou non finis", () => {
    const o = normalizeSearchOptions({
      filters: { minPages: 0, maxPages: 2.5, modifiedAfterMs: Number.NaN },
    });
    expect(o.filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { minPages: -3 } }).filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { minPages: Infinity } }).filters).toEqual(NO_FILTERS);
  });

  it("conserve les valeurs valides, y compris une date à 0", () => {
    const o = normalizeSearchOptions({
      filters: { includeSubfolders: false, nameContains: "x", minPages: 2, maxPages: 9, modifiedAfterMs: 0 },
    });
    expect(o.filters).toEqual({
      includeSubfolders: false,
      nameContains: "x",
      minPages: 2,
      maxPages: 9,
      modifiedAfterMs: 0,
    });
  });

  it("abandonne les deux bornes si min > max", () => {
    const o = normalizeSearchOptions({ filters: { minPages: 9, maxPages: 2 } });
    expect(o.filters).toEqual(NO_FILTERS);
  });

  it("tri : valeurs inconnues ramenées au défaut, valeurs valides conservées", () => {
    expect(normalizeSearchOptions({ sort: { key: "nope", direction: "up" } }).sort).toEqual(DEFAULT_SORT);
    expect(normalizeSearchOptions({ sort: { key: "name", direction: "asc" } }).sort).toEqual({ key: "name", direction: "asc" });
  });

  it("ne partage pas d'état avec l'entrée (copie)", () => {
    const input = { filters: { nameContains: "a" } };
    const o = normalizeSearchOptions(input);
    expect(o.filters).not.toBe(input.filters);
  });
});

describe("normalizeSearchOptions : champs normalisés", () => {
  it("nameContains est rogné", () => {
    expect(normalizeSearchOptions({ filters: { nameContains: "  abc " } }).filters.nameContains).toBe("abc");
  });

  it("minPages: 0, maxPages: 0 et minPages seul invalide : ignorés ou conservés selon la validité", () => {
    expect(normalizeSearchOptions({ filters: { maxPages: 0 } }).filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { minPages: 0 } }).filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { minPages: 3 } }).filters).toEqual({ ...NO_FILTERS, minPages: 3 });
  });

  it("entier non sûr (2^53) refusé comme borne de pages", () => {
    expect(normalizeSearchOptions({ filters: { minPages: 9007199254740992 } }).filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { minPages: 9007199254740991 } }).filters.minPages).toBe(9007199254740991);
  });

  it("modifiedAfterMs NaN ou infini : ignoré (aucun filtre de date)", () => {
    expect(normalizeSearchOptions({ filters: { modifiedAfterMs: Number.NaN } }).filters).toEqual(NO_FILTERS);
    expect(normalizeSearchOptions({ filters: { modifiedAfterMs: Number.POSITIVE_INFINITY } }).filters).toEqual(NO_FILTERS);
  });
});

describe("helpers partagés", () => {
  it("normalizedNeedle", () => {
    expect(normalizedNeedle("  Mon_Fichier ")).toBe("mon fichier");
    expect(normalizedNeedle("\u0301")).toBe("");
    expect(normalizedNeedle("   ")).toBe("");
  });

  it("isValidPageRange", () => {
    expect(isValidPageRange(undefined, undefined)).toBe(true);
    expect(isValidPageRange(3, undefined)).toBe(true);
    expect(isValidPageRange(undefined, 3)).toBe(true);
    expect(isValidPageRange(3, 3)).toBe(true);
    expect(isValidPageRange(4, 3)).toBe(false);
  });

  it("sameOptions compare champ par champ, sans dépendre de l'ordre des clés", () => {
    const a = normalizeSearchOptions({ filters: { nameContains: "x", minPages: 2 }, sort: { key: "name", direction: "asc" } });
    const b = normalizeSearchOptions({ sort: { direction: "asc", key: "name" }, filters: { minPages: 2, nameContains: "x" } });
    expect(sameOptions(a, b)).toBe(true);
    expect(sameOptions(a, { ...b, filters: { ...b.filters, minPages: 3 } })).toBe(false);
    expect(sameOptions(a, { ...b, filters: { ...b.filters, maxPages: 9 } })).toBe(false);
    expect(sameOptions(a, { ...b, sort: { key: "name", direction: "desc" } })).toBe(false);
    expect(sameOptions(a, { ...b, filters: { ...b.filters, includeSubfolders: false } })).toBe(false);
    expect(sameOptions(a, { ...b, filters: { ...b.filters, modifiedAfterMs: 0 } })).toBe(false);
  });
});
