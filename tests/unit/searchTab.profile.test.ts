// @vitest-environment jsdom
// E3 : le profil de plateforme est transmis de bout en bout par l'assemblage (rendu, cache, correspondances, vignettes).
// Sans profil, ou avec le profil bureau, les valeurs sont EXACTEMENT les constantes historiques.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({
  renderer: [] as unknown[],
  cache: [] as unknown[],
  pageMatches: [] as unknown[],
  loader: [] as unknown[],
}));

vi.mock("../../src/siyuan/pdfRenderer", async (orig) => {
  const actual = await orig<typeof import("../../src/siyuan/pdfRenderer")>();
  return { ...actual, createPdfRenderer: (o: Parameters<typeof actual.createPdfRenderer>[0]) => (spy.renderer.push(o), actual.createPdfRenderer(o)) };
});
vi.mock("../../src/search/thumbnailCache", async (orig) => {
  const actual = await orig<typeof import("../../src/search/thumbnailCache")>();
  class Spied extends actual.IndexedDbThumbnailCache {
    constructor(o: ConstructorParameters<typeof actual.IndexedDbThumbnailCache>[0]) {
      super(o);
      spy.cache.push(o);
    }
  }
  return { ...actual, IndexedDbThumbnailCache: Spied };
});
vi.mock("../../src/search/pageMatches", async (orig) => {
  const actual = await orig<typeof import("../../src/search/pageMatches")>();
  return { ...actual, createPageMatchService: (o: Parameters<typeof actual.createPageMatchService>[0]) => (spy.pageMatches.push(o), actual.createPageMatchService(o)) };
});
vi.mock("../../src/ui/thumbnailLoader", async (orig) => {
  const actual = await orig<typeof import("../../src/ui/thumbnailLoader")>();
  return { ...actual, createThumbnailLoader: (o: Parameters<typeof actual.createThumbnailLoader>[0]) => (spy.loader.push(o), actual.createThumbnailLoader(o)) };
});

import {
  CROP_RENDER_SCALE,
  DEFAULT_MAX_OPEN_DOCUMENTS,
  DEFAULT_RENDER_CONCURRENCY,
  PAGE_MATCHES_MAX_BYTES,
  THUMBNAIL_CACHE_MAX_BYTES,
  THUMBNAIL_CACHE_MAX_ENTRIES,
} from "../../src/core/constants";
import { desktopProfile, mobileProfile } from "../../src/platform/profile";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { createNativeFakes } from "./ui/nativeFakes";
import { harness as baseHarness, sharedInstances } from "./helpers/searchTabHarness";

const fakes = createNativeFakes();
/** Sans `cache` injecté : l'assemblage crée lui-même le cache IndexedDB (observé par l'espion). */
function mount(over: Partial<SearchTabDeps> = {}) {
  const h = baseHarness(over, fakes);
  const deps: { -readonly [K in keyof SearchTabDeps]?: SearchTabDeps[K] } = { ...h.deps };
  delete deps.cache;
  const tab = mountSearchTab(h.host, { ...deps, indexedDB: {} as IDBFactory, ...over } as SearchTabDeps);
  return { h, tab };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const list of Object.values(spy)) list.length = 0;
});
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("assemblage : bureau inchangé (aucun profil, ou profil bureau)", () => {
  for (const [label, over] of [
    ["sans profil", {}],
    ["profil bureau explicite", { profile: desktopProfile() }],
  ] as const) {
    it(`${label} : constantes historiques partout`, () => {
      const { tab } = mount(over);
      expect(spy.renderer[0]).toMatchObject({ concurrency: DEFAULT_RENDER_CONCURRENCY, maxOpenDocuments: DEFAULT_MAX_OPEN_DOCUMENTS });
      expect(spy.cache[0]).toMatchObject({ maxEntries: THUMBNAIL_CACHE_MAX_ENTRIES, maxBytes: THUMBNAIL_CACHE_MAX_BYTES });
      expect(spy.pageMatches[0]).toMatchObject({ maxBytesFiles: PAGE_MATCHES_MAX_BYTES });
      expect((spy.loader[0] as { cropScale?: number }).cropScale).toBe(CROP_RENDER_SCALE);
      tab.dispose();
    });
  }
});

describe("assemblage : profil mobile", () => {
  it("transmet concurrence, documents ouverts, cache, correspondances et échelle", () => {
    const profile = mobileProfile();
    const { tab } = mount({ profile });
    expect(spy.renderer[0]).toMatchObject({ concurrency: 1, maxOpenDocuments: 1 });
    expect(spy.cache[0]).toMatchObject({ maxEntries: 500, maxBytes: 16 * 1024 * 1024 });
    expect(spy.pageMatches[0]).toMatchObject({ maxBytesFiles: 16 * 1024 * 1024 });
    expect((spy.loader[0] as { cropScale?: number }).cropScale).toBe(1.0);
    tab.dispose();
  });

  it("un cache injecté reste prioritaire sur les plafonds du profil", () => {
    const injected = { get: async () => undefined, put: async () => undefined, clear: async () => undefined };
    const { tab } = mount({ profile: mobileProfile(), cache: injected });
    expect(spy.cache).toHaveLength(0);
    expect((spy.loader[0] as { cache: unknown }).cache).toBe(injected);
    tab.dispose();
  });
});
