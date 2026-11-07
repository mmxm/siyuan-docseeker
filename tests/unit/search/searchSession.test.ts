import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { createSearchSessionStore } from "../../../src/search/searchSession";

const options = (over: Partial<SearchOptions["filters"]> = {}): SearchOptions => ({
  sort: { key: "name", direction: "asc" },
  filters: { ...NO_FILTERS, ...over },
});

describe("createSearchSessionStore", () => {
  it("est vide au départ", () => {
    expect(createSearchSessionStore().get()).toBeUndefined();
  });

  it("set puis get renvoie la requête et les options (tri et filtres compris)", () => {
    const store = createSearchSessionStore();
    const full = options({ includeSubfolders: false, nameContains: "rapport", minPages: 2, maxPages: 9, modifiedAfterMs: 1_700_000_000_000 });
    store.set({ query: "chat noir", options: full });
    expect(store.get()).toEqual({ query: "chat noir", options: full });
  });

  it("conserve une requête vide avec les options (restauration des options seules)", () => {
    const store = createSearchSessionStore();
    store.set({ query: "", options: options({ nameContains: "x" }) });
    expect(store.get()).toEqual({ query: "", options: options({ nameContains: "x" }) });
  });

  it("copie à l'écriture : modifier l'objet passé à set ensuite ne change pas l'état mémorisé", () => {
    const store = createSearchSessionStore();
    const mutable = { query: "a", options: { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, nameContains: "assets" } } } as unknown as {
      query: string;
      options: { sort: { key: string; direction: string }; filters: { nameContains: string } };
    };
    store.set(mutable as unknown as Parameters<typeof store.set>[0]);
    mutable.query = "autre";
    mutable.options.filters.nameContains = "autre";
    mutable.options.sort.key = "path";
    expect(store.get()).toEqual({ query: "a", options: { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, nameContains: "assets" } } });
  });

  it("copie à la lecture : modifier le résultat de get ne change pas le suivant", () => {
    const store = createSearchSessionStore();
    store.set({ query: "a", options: options({ nameContains: "assets" }) });
    const first = store.get() as unknown as { query: string; options: { filters: { nameContains: string }; sort: { key: string } } };
    first.query = "pirate";
    first.options.filters.nameContains = "";
    first.options.sort.key = "path";
    expect(store.get()).toEqual({ query: "a", options: options({ nameContains: "assets" }) });
  });

  it("set remplace entièrement l'état précédent (aucun champ de filtre ne survit)", () => {
    const store = createSearchSessionStore();
    store.set({ query: "a", options: options({ minPages: 3 }) });
    store.set({ query: "b", options: DEFAULT_OPTIONS });
    const got = store.get()!;
    expect(got.query).toBe("b");
    expect(got.options.filters).toEqual(NO_FILTERS);
    expect("minPages" in got.options.filters).toBe(false);
  });

  it("clear efface l'état ; clear sans état ne lève pas", () => {
    const store = createSearchSessionStore();
    expect(() => store.clear()).not.toThrow();
    store.set({ query: "a", options: DEFAULT_OPTIONS });
    store.clear();
    expect(store.get()).toBeUndefined();
  });

  it("deux magasins sont indépendants", () => {
    const a = createSearchSessionStore();
    const b = createSearchSessionStore();
    a.set({ query: "a", options: DEFAULT_OPTIONS });
    expect(b.get()).toBeUndefined();
  });
});
