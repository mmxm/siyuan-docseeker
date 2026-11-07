import { describe, expect, it, vi } from "vitest";
import { buildIndex } from "../../../src/core/bm25";
import type { DocumentScope } from "../../../src/search/docScope";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { createSearchController, type DocInfo, type SearchSource, type SearchViewModel } from "../../../src/search/searchController";

const BOX = "20210808180117-6v0mkxr";
const ID1 = "20210808180117-czj9bvb";
const scope: DocumentScope = { kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "Doc" };

const doc = (docId: string, path: string): DocInfo => ({ docId, title: docId, path, pageCount: 3, pdfSize: 1, pdfModifiedMs: 1 });
const DOCS = [doc("a", "assets/a.pdf"), doc("b", "assets/b.pdf"), doc("c", "assets/c.pdf")];

const source: SearchSource = {
  getIndex: () => buildIndex(DOCS.map((d) => ({ docId: d.docId, page: 1, text: "alpha beta" }))),
  getDoc: (id) => DOCS.find((d) => d.docId === id),
  listDocs: () => DOCS,
  getProgress: () => ({ loaded: 0, total: 0, failed: [] }),
  getPhase: () => "ready",
  getLastError: () => undefined,
  subscribe: () => () => undefined,
};

const withScope = (over: Partial<SearchOptions["filters"]> = {}): SearchOptions => ({
  sort: { key: "relevance", direction: "desc" },
  filters: { ...NO_FILTERS, scope, ...over },
});

function setup(initialOptions: SearchOptions, scopePaths?: (s: DocumentScope, include: boolean) => ReadonlySet<string> | undefined) {
  const views: SearchViewModel[] = [];
  const onWarn = vi.fn();
  const controller = createSearchController({
    source,
    schedule: () => 0,
    clear: () => undefined,
    onChange: (vm) => views.push(vm),
    onWarn,
    initialOptions,
    ...(scopePaths ? { scopePaths } : {}),
  });
  return { controller, views, onWarn };
}

describe("contrôleur : portée de documents", () => {
  it("ne garde que les PDF cités et compte les autres comme masqués", () => {
    const scopePaths = vi.fn(() => new Set(["assets/b.pdf"]));
    const { controller, views } = setup(withScope(), scopePaths);
    controller.submit("alpha");
    const vm = views.at(-1);
    expect(vm?.kind).toBe("results");
    if (vm?.kind !== "results") return;
    expect(vm.docs.map((d) => d.docId)).toEqual(["b"]);
    expect(vm.hiddenByFilters).toBe(2);
    expect(scopePaths).toHaveBeenCalledWith(scope, true);
  });

  it("transmet l'inclusion des enfants (includeSubfolders)", () => {
    const scopePaths = vi.fn(() => new Set(["assets/a.pdf"]));
    const { controller } = setup(withScope({ includeSubfolders: false }), scopePaths);
    controller.submit("alpha");
    expect(scopePaths).toHaveBeenCalledWith(scope, false);
  });

  it("portée citant aucun PDF indexé : no-result avec hiddenByFilters, sans avertissement", () => {
    const { controller, views, onWarn } = setup(withScope(), () => new Set());
    controller.submit("alpha");
    expect(views.at(-1)).toMatchObject({ kind: "no-result", hiddenByFilters: 3 });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("portée non résolue (scopePaths renvoie undefined) : liste vide ET avertissement", () => {
    const { controller, views, onWarn } = setup(withScope(), () => undefined);
    controller.submit("alpha");
    expect(views.at(-1)).toMatchObject({ kind: "no-result", hiddenByFilters: 3 });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain("scope");
  });

  it("portée non résolue : le view-model porte scopeUnresolved (distinct d'un vrai « aucun résultat »)", () => {
    const unresolved = setup(withScope(), () => undefined);
    unresolved.controller.submit("alpha");
    expect(unresolved.views.at(-1)).toMatchObject({ kind: "no-result", scopeUnresolved: true });
    const empty = setup(withScope(), () => new Set());
    empty.controller.submit("alpha");
    expect(empty.views.at(-1)?.kind).toBe("no-result");
    expect(empty.views.at(-1)).not.toHaveProperty("scopeUnresolved");
  });

  it("un seul avertissement par clé de portée tant qu'elle reste non résolue", () => {
    let resolved: ReadonlySet<string> | undefined;
    const { controller, onWarn } = setup(withScope(), () => resolved);
    controller.submit("alpha");
    controller.submit("alpha");
    controller.submit("alpha beta");
    expect(onWarn).toHaveBeenCalledTimes(1);
    resolved = new Set(["assets/a.pdf"]);
    controller.submit("alpha");
    resolved = undefined;
    controller.submit("alpha"); // de nouveau non résolue : un nouvel avertissement
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it("un autre jeu de paramètres (enfants exclus) non résolu est signalé à son tour", () => {
    const { controller, onWarn } = setup(withScope(), () => undefined);
    controller.submit("alpha");
    controller.setOptions(withScope({ includeSubfolders: false }));
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it("portée active sans scopePaths injecté : même comportement sûr", () => {
    const { controller, views, onWarn } = setup(withScope());
    controller.submit("alpha");
    expect(views.at(-1)?.kind).toBe("no-result");
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("sans portée, scopePaths n'est jamais appelé", () => {
    const scopePaths = vi.fn(() => undefined);
    const { controller, views, onWarn } = setup({ sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS }, scopePaths);
    controller.submit("alpha");
    expect(views.at(-1)?.kind).toBe("results");
    expect(scopePaths).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("setOptions avec une nouvelle portée relance la requête", () => {
    const { controller, views } = setup(
      { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS },
      () => new Set(["assets/c.pdf"]),
    );
    controller.submit("alpha");
    controller.setOptions(withScope());
    const vm = views.at(-1);
    expect(vm?.kind === "results" && vm.docs.map((d) => d.docId)).toEqual(["c"]);
    expect(controller.getOptions().filters.scope).toEqual(scope);
  });
});

describe("contrôleur : portée invalide", () => {
  it("setOptions avec une portée forgée la retire ET le journal le sait", () => {
    const { controller, onWarn } = setup({ sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS });
    controller.setOptions({ sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS, scope: { kind: "x", box: BOX, label: "L" } as never } });
    expect(controller.getOptions().filters.scope).toBeUndefined();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("scope"), expect.anything());
  });
});

describe("contrôleur : immuabilité de la portée", () => {
  it("getOptions renvoie une portée gelée et indépendante de l'entrée", () => {
    const input = withScope();
    const { controller } = setup(input, () => new Set());
    const got = controller.getOptions().filters.scope;
    expect(Object.isFrozen(got)).toBe(true);
    expect(got).not.toBe(scope);
  });
});
