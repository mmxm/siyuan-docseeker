import { describe, expect, it } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import { NO_FILTERS } from "../../../src/search/resultOptions";
import { createSearchSessionStore } from "../../../src/search/searchSession";

describe("searchSession : portée", () => {
  it("copie la portée en profondeur à l'écriture et à la lecture", () => {
    const scope: DocumentScope = { kind: "notebook", box: "20210808180117-6v0mkxr", label: "Cahier" };
    const store = createSearchSessionStore();
    store.set({ query: "q", options: { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS, scopes: [scope] } } });
    const first = store.get();
    expect(first?.options.filters.scopes).toEqual([scope]);
    expect(first?.options.filters.scopes?.[0]).not.toBe(scope);
    expect(store.get()?.options.filters.scopes?.[0]).not.toBe(first?.options.filters.scopes?.[0]);
    (first?.options.filters.scopes?.[0] as { label: string }).label = "mutée";
    expect(store.get()?.options.filters.scopes?.[0]?.label).toBe("Cahier");
  });

  it("copie en profondeur une liste de deux portées (liste et éléments)", () => {
    const a: DocumentScope = { kind: "notebook", box: "20210808180117-6v0mkxr", label: "A" };
    const b: DocumentScope = { kind: "document", box: "20210808180117-6v0mkxr", docPath: "/20210808180117-czj9bvb.sy", label: "B" };
    const list = [a, b];
    const store = createSearchSessionStore();
    store.set({ query: "q", options: { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS, scopes: list } } });
    list.pop();
    const got = store.get()?.options.filters.scopes;
    expect(got).toEqual([a, b]);
    expect(got).not.toBe(list);
    expect(got?.[1]).not.toBe(b);
    (got as DocumentScope[]).length = 0;
    expect(store.get()?.options.filters.scopes).toHaveLength(2);
  });

  it("sans portée, la clé scope reste absente", () => {
    const store = createSearchSessionStore();
    store.set({ query: "", options: { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS } });
    expect(store.get()?.options.filters).not.toHaveProperty("scopes");
  });
});
