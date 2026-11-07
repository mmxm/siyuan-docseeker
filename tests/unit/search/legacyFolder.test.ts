// Compatibilité de lecture : l'ancien filtre par dossier d'assets (`folder`) n'existe plus. Un critère, une session ou des
// options qui le portent sont lus sans erreur, le champ est ignoré, et l'ignorance est tracée (jamais silencieuse).
import { describe, expect, it, vi } from "vitest";
import { buildIndex } from "../../../src/core/bm25";
import { NO_FILTERS, countActiveFilters, normalizeSearchOptions, sameOptions } from "../../../src/search/resultOptions";
import { normalizeCriteriaList, parseSavedCriteria } from "../../../src/search/savedCriteria";
import { createSearchController, type DocInfo, type SearchSource } from "../../../src/search/searchController";

const base = { name: "n", query: "q", sort: { key: "relevance", direction: "desc" }, groupByDocument: true };
const criterion = (filters: Record<string, unknown>, name = "n") => ({ ...base, name, filters });

describe("normalizeSearchOptions : ancien champ folder", () => {
  it("est ignoré sans erreur : la clé n'existe plus dans les filtres", () => {
    const o = normalizeSearchOptions({ filters: { folder: "assets/a/", nameContains: "x" } });
    expect(o.filters).not.toHaveProperty("folder");
    expect(o.filters.nameContains).toBe("x");
    expect(countActiveFilters(o.filters)).toBe(1); // le dossier ne compte plus comme filtre
  });

  it("NO_FILTERS ne porte plus de dossier", () => {
    expect(NO_FILTERS).toEqual({ includeSubfolders: true, nameContains: "" });
  });

  it("onLegacyFolder reçoit le dossier ignoré, une fois, seulement s'il n'était pas vide", () => {
    const seen = vi.fn();
    normalizeSearchOptions({ filters: { folder: " assets/a/ " } }, undefined, seen);
    expect(seen).toHaveBeenCalledExactlyOnceWith(" assets/a/ ");
    const none = vi.fn();
    for (const folder of ["", "   ", 3, null, undefined]) normalizeSearchOptions({ filters: { folder } }, undefined, none);
    normalizeSearchOptions({ filters: {} }, undefined, none);
    expect(none).not.toHaveBeenCalled();
  });

  it("un dossier n'influence plus la comparaison d'options", () => {
    const a = normalizeSearchOptions({ filters: { folder: "a/" } });
    const b = normalizeSearchOptions({ filters: {} });
    expect(sameOptions(a, b)).toBe(true);
  });
});

describe("critères enregistrés : ancien champ folder", () => {
  it("un critère avec dossier est lu (champ ignoré) et signale l'ignorance", () => {
    const parsed = parseSavedCriteria(criterion({ folder: "assets/a/", includeSubfolders: true, nameContains: "" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filters).not.toHaveProperty("folder");
    expect(parsed.ignoredFolder).toBe(true);
  });

  it("sans dossier (ou dossier vide) : aucune ignorance signalée", () => {
    for (const filters of [{ nameContains: "" }, { folder: "", nameContains: "" }]) {
      const parsed = parseSavedCriteria(criterion(filters));
      expect(parsed.ok && parsed.ignoredFolder).toBeFalsy();
    }
  });

  it("la liste garde les critères et ajoute UNE seule ligne d'avertissement, quel que soit leur nombre", () => {
    const { list, warnings, ignored } = normalizeCriteriaList([
      criterion({ folder: "a/" }, "un"),
      criterion({ folder: "b/" }, "deux"),
      criterion({}, "trois"),
    ]);
    expect(list.map((c) => c.name)).toEqual(["un", "deux", "trois"]);
    expect(ignored).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dossier/);
    expect(warnings[0]).toMatch(/2/);
  });

  it("aucun avertissement si aucun critère ne portait de dossier", () => {
    expect(normalizeCriteriaList([criterion({})]).warnings).toEqual([]);
  });
});

describe("contrôleur : options de session avec l'ancien champ folder", () => {
  const docs: DocInfo[] = [{ docId: "a", title: "a", path: "assets/a.pdf", pageCount: 1, pdfSize: 1, pdfModifiedMs: 1 }];
  const source: SearchSource = {
    getIndex: () => buildIndex([{ docId: "a", page: 1, text: "alpha" }]),
    getDoc: (id) => docs.find((d) => d.docId === id),
    listDocs: () => docs,
    getProgress: () => ({ loaded: 0, total: 0, failed: [] }),
    getPhase: () => "ready",
    getLastError: () => undefined,
    subscribe: () => () => undefined,
  };

  it("lues sans erreur, une seule trace, et aucun filtrage par dossier", () => {
    const onWarn = vi.fn();
    const controller = createSearchController({
      source,
      schedule: () => 0,
      clear: () => undefined,
      onChange: () => undefined,
      onWarn,
      initialOptions: { sort: { key: "relevance", direction: "desc" }, filters: { folder: "autre/", includeSubfolders: true, nameContains: "" } } as never,
    });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]![0])).toMatch(/folder|dossier/i);
    expect(controller.getOptions().filters).not.toHaveProperty("folder");
    controller.setOptions({ sort: { key: "name", direction: "asc" }, filters: controller.getOptions().filters });
    expect(onWarn).toHaveBeenCalledTimes(1); // plus de dossier : plus de trace
    let results = 0;
    const c2 = createSearchController({
      source,
      schedule: () => 0,
      clear: () => undefined,
      onChange: (vm) => {
        if (vm.kind === "results") results = vm.docs.length;
      },
      initialOptions: { sort: { key: "relevance", direction: "desc" }, filters: { folder: "autre/", includeSubfolders: true, nameContains: "" } } as never,
    });
    c2.submit("alpha");
    expect(results).toBe(1);
  });
});
