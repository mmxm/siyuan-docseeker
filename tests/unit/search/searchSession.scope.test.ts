import { describe, expect, it } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import { NO_FILTERS } from "../../../src/search/resultOptions";
import { createSearchSessionStore } from "../../../src/search/searchSession";

describe("searchSession : portée", () => {
  it("copie la portée en profondeur à l'écriture et à la lecture", () => {
    const scope: DocumentScope = { kind: "notebook", box: "20210808180117-6v0mkxr", label: "Cahier" };
    const store = createSearchSessionStore();
    store.set({ query: "q", options: { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS, scope } } });
    const first = store.get();
    expect(first?.options.filters.scope).toEqual(scope);
    expect(first?.options.filters.scope).not.toBe(scope);
    expect(store.get()?.options.filters.scope).not.toBe(first?.options.filters.scope);
    (first?.options.filters.scope as { label: string }).label = "mutée";
    expect(store.get()?.options.filters.scope?.label).toBe("Cahier");
  });

  it("sans portée, la clé scope reste absente", () => {
    const store = createSearchSessionStore();
    store.set({ query: "", options: { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS } });
    expect(store.get()?.options.filters).not.toHaveProperty("scope");
  });
});
