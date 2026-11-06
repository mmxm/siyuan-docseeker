// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexData } from "../../src/core/codec/format";
import type { IndexerEvent } from "../../src/indexer/indexer";
import { InvalidPdfPathError } from "../../src/siyuan/openPdf";
import { createWarnLog, mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { createSharedIndex, type SharedIndex } from "../../src/search/sharedIndex";

const PDF_A = "assets/Alpha-20240101120000-abc1234.pdf";
const PDF_B = "assets/Beta-20240101120000-def5678.pdf";

function data(sourcePath: string, over: Partial<SearchIndexData> = {}): SearchIndexData {
  return {
    normalizerVersion: 1,
    extractorVersion: "t",
    sourcePath,
    pdfSize: 123,
    pdfModifiedMs: 456,
    pageTermCounts: new Uint32Array([1, 2, 3]),
    postings: {
      terms: ["chat", "chien"],
      offsets: new Uint32Array([0, 2, 4]),
      pages: new Uint32Array([2, 3, 2, 3]),
      termFrequencies: new Uint32Array([1, 1, 1, 1]),
    },
    ...over,
  };
}

const ATTACHED = { status: "attached", pageNumber: 2, keptRects: 1, droppedRects: 0 };
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

interface Harness {
  host: HTMLElement;
  deps: SearchTabDeps;
  files: Map<string, Uint8Array>;
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  emit: (event: IndexerEvent) => void;
  shared: SharedIndex;
  listeners: Set<(event: IndexerEvent) => void>;
  openSettings: ReturnType<typeof vi.fn>;
  openPdfAtPage: ReturnType<typeof vi.fn>;
  decodePageMatches: ReturnType<typeof vi.fn>;
  onWarn: ReturnType<typeof vi.fn>;
  observerDisconnect: ReturnType<typeof vi.fn>;
}

const sharedInstances: SharedIndex[] = [];

function harness(over: { ids?: string[]; autoStart?: boolean } = {}): Harness {
  const ids = over.ids ?? ["a"];
  const files = new Map<string, Uint8Array>();
  for (const id of ids) files.set(`${id}.dsx`, bytes(id));
  files.set("manifest.json", bytes("{}"));
  const list = vi.fn(async () => [...files.keys()]);
  const read = vi.fn(async (name: string) => files.get(name) ?? null);
  const listeners = new Set<(event: IndexerEvent) => void>();
  const openSettings = vi.fn();
  const openPdfAtPage = vi.fn(async () => ({ dispose: vi.fn(), ready: Promise.resolve(ATTACHED) }));
  const decodePageMatches = vi.fn(async () => ({
    boxes: [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      { x: 0.5, y: 0.6, width: 0.2, height: 0.05 },
    ],
    ordinals: [1],
  }));
  const onWarn = vi.fn();
  const observerDisconnect = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const indexerEvents = {
    onEvent: (l: (event: IndexerEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  // Index partagé : créé (et chargé) une fois par le plugin, jamais par l'onglet.
  const shared = createSharedIndex({
    store: { list, read } as unknown as SearchTabDeps["store"] & { list: () => Promise<string[]> },
    decode: async (b) => data(new TextDecoder().decode(b) === "b" ? PDF_B : PDF_A),
    indexer: indexerEvents,
    onWarn,
  });
  sharedInstances.push(shared);
  if (over.autoStart !== false) void shared.start();
  const deps: SearchTabDeps = {
    store: { read } as unknown as SearchTabDeps["store"],
    sharedIndex: shared,
    decodePageMatches: decodePageMatches as unknown as NonNullable<SearchTabDeps["decodePageMatches"]>,
    onOpenSettings: openSettings,
    openTab: vi.fn(),
    app: { id: "app" },
    openPdfAtPage: openPdfAtPage as unknown as NonNullable<SearchTabDeps["openPdfAtPage"]>,
    loadDocument: async () => {
      throw new Error("pas de rendu dans ce test");
    },
    createCanvas: () => {
      throw new Error("pas de canvas dans ce test");
    },
    observerFactory: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: observerDisconnect }),
    cache: { get: async () => undefined, put: async () => undefined, clear: async () => undefined },
    onWarn,
  };
  return {
    host, deps, shared, files, list, read, listeners, openSettings, openPdfAtPage, decodePageMatches, onWarn, observerDisconnect,
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
  };
}

async function type(host: HTMLElement, text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(500);
  await flush();
}

/** Frappe sans Entrée : ne doit rien lancer. */
async function typeOnly(host: HTMLElement, text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
}

const cards = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>("button.docseeker-card")];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mountSearchTab", () => {
  describe("re-classement par proximité", () => {
    const TWO_TERMS = {
      boxes: [
        { x: 0.1, y: 0.2, width: 0.05, height: 0.02 },
        { x: 0.16, y: 0.2, width: 0.05, height: 0.02 },
      ],
      ordinals: [0, 1],
      termIndexes: [0, 1],
    };

    const FAR_TERMS = {
      ...TWO_TERMS,
      boxes: [
        { x: 0.1, y: 0.2, width: 0.05, height: 0.02 },
        { x: 0.7, y: 0.2, width: 0.05, height: 0.02 },
      ],
    };

    it("branche le ranker sur le service de correspondances et annonce le classement affiné", async () => {
      const h = harness();
      // Page 3 : mots côte à côte ; page 2 : mots éloignés => l'ordre des pages change (3 avant 2).
      h.decodePageMatches.mockImplementation(async (_b: Uint8Array, page: number) => (page === 3 ? TWO_TERMS : FAR_TERMS));
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat chien");
      expect(h.decodePageMatches).toHaveBeenCalled();
      expect(h.host.querySelector(".docseeker-status")!.textContent).toContain("Classement affiné par proximité des mots");
      expect(cards(h.host).map((c) => c.dataset["page"])).toEqual(["3", "2"]);
      tab.dispose();
    });

    it("décode chaque document en une seule passe quand un décodeur multi-pages est fourni", async () => {
      const h = harness();
      const decodePages = vi.fn(async (_b: Uint8Array, pages: readonly number[]) => new Map(pages.map((p) => [p, TWO_TERMS])));
      h.deps = { ...h.deps, decodePagesMatches: decodePages as never };
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat chien");
      expect(decodePages).toHaveBeenCalledTimes(1);
      expect(decodePages.mock.calls[0]?.[1]).toEqual([2, 3]);
      tab.dispose();
    });

    it("journalise l'échec de mesure via onWarn et garde l'ordre BM25", async () => {
      const h = harness(); // le décodeur par défaut ne fournit pas termIndexes
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat chien");
      expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Proximity measure failed"), expect.anything());
      expect(cards(h.host).map((c) => c.dataset["page"])).toEqual(["2", "3"]);
      tab.dispose();
    });

    it("un document réindexé est mesuré de nouveau (cache du ranker invalidé, re-classement relancé)", async () => {
      const h = harness();
      h.decodePageMatches.mockImplementation(async () => TWO_TERMS);
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat chien");
      const before = h.decodePageMatches.mock.calls.length;
      h.emit({ type: "indexed", path: PDF_A, pages: 3 });
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
      expect(h.decodePageMatches.mock.calls.length).toBeGreaterThan(before);
      tab.dispose();
    });
  });

  it("affiche les résultats de l'index partagé sans le charger lui-même (manifest.json ignoré)", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(h.list).toHaveBeenCalledTimes(1); // le chargement vient du partagé, pas de l'onglet
    expect(h.read).toHaveBeenCalledWith("a.dsx");
    expect(h.read).not.toHaveBeenCalledWith("manifest.json");
    await type(h.host, "chat");
    expect(cards(h.host).map((c) => c.dataset["page"])).toEqual(["2", "3"]);
    tab.dispose();
  });

  it("taper sans Entrée ne lance pas de recherche ; Entrée la lance", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await typeOnly(h.host, "chat");
    expect(cards(h.host)).toHaveLength(0);
    expect(h.host.textContent).toContain("appuyez sur Entrée");
    await type(h.host, "chat");
    expect(cards(h.host).map((c) => c.dataset["page"])).toEqual(["2", "3"]);
    tab.dispose();
  });

  it("affiche des résultats partiels pendant le chargement", async () => {
    const h = harness({ ids: ["a", "b"] });
    let release: (v: Uint8Array) => void = () => undefined;
    h.read.mockImplementation((name: string) =>
      name === "b.dsx" ? new Promise<Uint8Array>((r) => (release = r)) : Promise.resolve(bytes("a")),
    );
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    expect(h.host.textContent).toContain("partiels");
    release(bytes("b"));
    await flush();
    tab.dispose();
  });

  it("rafraîchit (débouncé) sur indexed/removed et invalide les correspondances du document", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.read.mock.calls.filter(([n]) => n === "a.dsx")).toHaveLength(2); // index + page
    const before = h.list.mock.calls.length;

    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    h.emit({ type: "removed", path: "assets/autre.pdf" });
    h.emit({ type: "progress", path: PDF_A, page: 1, total: 3 });
    expect(h.list.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(h.list.mock.calls.length).toBe(before + 1);

    h.read.mockClear();
    cards(h.host)[0]!.click();
    await flush();
    expect(h.read.mock.calls.filter(([n]) => n === "a.dsx").length).toBeGreaterThanOrEqual(1);
    tab.dispose();
  });

  it("au clic, ouvre le PDF à la bonne page avec des rectangles en pourcentage", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[1]!.click();
    await flush();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    const arg = h.openPdfAtPage.mock.calls[0]![0] as {
      path: string; page: number; app: unknown; openTab: unknown; rects: { left: number; top: number; width: number; height: number }[];
    };
    expect(arg.path).toBe(PDF_A);
    expect(arg.page).toBe(3);
    expect(arg.app).toBe(h.deps.app);
    expect(arg.openTab).toBe(h.deps.openTab);
    expect(arg.rects).toHaveLength(1);
    expect(arg.rects[0]!.left).toBeCloseTo(50);
    expect(arg.rects[0]!.top).toBeCloseTo(60);
    expect(arg.rects[0]!.width).toBeCloseTo(20);
    expect(arg.rects[0]!.height).toBeCloseTo(5);
    expect(h.decodePageMatches).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("transmet l'indice du rectangle de la zone choisie par la vignette (groupe dense, pas le premier mot)", async () => {
    const h = harness();
    h.decodePageMatches.mockResolvedValue({
      boxes: [
        { x: 0.1, y: 0.05, width: 0.1, height: 0.02 },
        { x: 0.4, y: 0.7, width: 0.1, height: 0.02 },
        { x: 0.5, y: 0.7, width: 0.1, height: 0.02 },
      ],
      ordinals: [0, 1, 2],
      termIndexes: [0, 0, 1],
    });
    const doc = {
      numPages: 10,
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve() }) }),
      destroy: () => undefined,
    };
    h.deps = { ...h.deps, loadDocument: async () => doc as never };
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[1]!.click();
    await flush();
    const arg = h.openPdfAtPage.mock.calls[0]![0] as { rects: unknown[]; focusIndex?: number };
    expect(arg.rects).toHaveLength(3);
    expect(arg.focusIndex).toBe(1);
    tab.dispose();
  });

  it("garde l'indice 0 et avertit si la taille de page est indisponible (repli sans erreur)", async () => {
    const h = harness();
    const loadDocument = vi.fn(async () => {
      throw new Error("pas de PDF");
    });
    h.deps = { ...h.deps, loadDocument };
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[1]!.click();
    await flush();
    const arg = h.openPdfAtPage.mock.calls[0]![0] as { rects: unknown[]; focusIndex?: number };
    expect(loadDocument).toHaveBeenCalled();
    expect(arg.rects).toHaveLength(1);
    expect(arg.focusIndex).toBe(0);
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Zone du surlignage non déterminée"), expect.anything());
    tab.dispose();
  });

  describe("page size wait is bounded", () => {
    const neverDoc = { numPages: 10, getPage: () => new Promise(() => undefined), destroy: () => undefined };
    const setupSlow = () => {
      const h = harness();
      const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
      h.deps = {
        ...h.deps,
        loadDocument: async () => neverDoc as never,
        schedule: (fn, ms) => {
          if (ms !== 400) return setTimeout(fn, ms);
          const t = { fn, ms, cleared: false };
          timers.push(t);
          return t;
        },
        clear: (t) => {
          if (t && typeof t === "object" && "cleared" in t) (t as { cleared: boolean }).cleared = true;
          else clearTimeout(t as ReturnType<typeof setTimeout>);
        },
      };
      return { h, timers };
    };
    const fireOpenTimer = (timers: { fn: () => void; ms: number; cleared: boolean }[]) =>
      timers.filter((t) => !t.cleared).forEach((t) => t.fn());

    it("opens with focusIndex 0 after the delay when getPageSize never resolves", async () => {
      const { h, timers } = setupSlow();
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat");
      cards(h.host)[1]!.click();
      await flush();
      expect(h.openPdfAtPage).not.toHaveBeenCalled();
      fireOpenTimer(timers);
      await flush();
      expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
      expect(h.openPdfAtPage.mock.calls[0]![0]).toMatchObject({ focusIndex: 0 });
      tab.dispose();
    });

    it("a second open during the wait means no openPdf for the first", async () => {
      const { h, timers } = setupSlow();
      const tab = mountSearchTab(h.host, h.deps);
      await flush();
      await type(h.host, "chat");
      cards(h.host)[1]!.click();
      await flush();
      cards(h.host)[0]!.click();
      await flush();
      fireOpenTimer(timers);
      await flush();
      expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
      expect(h.openPdfAtPage.mock.calls[0]![0]).toMatchObject({ page: 2 });
      tab.dispose();
    });
  });

  it("si le calque échoue, ouvre quand même la page sans rectangles et avertit", async () => {
    const h = harness();
    h.decodePageMatches.mockRejectedValue(new Error("dsx corrompu"));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    expect(h.openPdfAtPage.mock.calls[0]![0]).toMatchObject({ path: PDF_A, page: 2, rects: [] });
    expect(h.onWarn).toHaveBeenCalled();
    tab.dispose();
  });

  it("si l'ouverture échoue, affiche un message discret dans l'UI sans alert", async () => {
    const h = harness();
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    h.openPdfAtPage.mockRejectedValueOnce(new InvalidPdfPathError("../x.pdf"));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    const msg = h.host.querySelector<HTMLElement>(".docseeker-message")!;
    expect(msg.textContent).toMatch(/ouvrir/i);
    expect(msg.getAttribute("role")).toBe("status");
    expect(alert).not.toHaveBeenCalled();

    h.openPdfAtPage.mockRejectedValueOnce(new Error("introuvable"));
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toMatch(/ouvrir/i);

    h.openPdfAtPage.mockResolvedValueOnce({ dispose: vi.fn(), ready: Promise.resolve(ATTACHED) });
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toBe("");
    vi.unstubAllGlobals();
    tab.dispose();
  });

  it("branche le bouton Ouvrir les paramètres sur onOpenSettings", async () => {
    const h = harness({ ids: [] });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    const button = h.host.querySelector<HTMLButtonElement>("button.docseeker-open-settings")!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.host.querySelector("button.docseeker-reindex")).toBeNull();
    tab.dispose();
  });

  it("dispose est idempotent, libère observateur et DOM, et laisse l'index partagé intact", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    const subscribersBefore = h.listeners.size;
    expect(subscribersBefore).toBe(1); // l'abonnement à l'indexeur est celui du partagé

    tab.dispose();
    expect(() => tab.dispose()).not.toThrow();
    expect(h.observerDisconnect).toHaveBeenCalled();
    expect(h.host.childElementCount).toBe(0);
    expect(h.listeners.size).toBe(subscribersBefore);
    expect(h.shared.store.getPhase()).toBe("ready");
    expect(h.shared.store.listDocs()).toHaveLength(1);

    // Le partagé continue de se rafraîchir, sans plantage ni notification vers l'onglet disposé.
    const before = h.list.mock.calls.length;
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(h.list.mock.calls.length).toBe(before + 1);
    expect(h.host.childElementCount).toBe(0);
  });

  it("deux onglets partagent un seul chargement et un seul rafraîchissement", async () => {
    const h = harness();
    const host2 = document.createElement("div");
    document.body.append(host2);
    const tab1 = mountSearchTab(h.host, h.deps);
    const tab2 = mountSearchTab(host2, h.deps);
    await flush();
    expect(h.list).toHaveBeenCalledTimes(1);
    await type(h.host, "chat");
    await type(host2, "chat");
    expect(cards(h.host)).toHaveLength(2);
    expect(cards(host2)).toHaveLength(2);
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(h.list).toHaveBeenCalledTimes(2);
    tab1.dispose();
    tab2.dispose();
  });

  it("un onglet ouvert après le chargement voit directement les documents", async () => {
    const h = harness();
    await h.shared.start();
    const tab = mountSearchTab(h.host, h.deps);
    await type(h.host, "chat");
    expect(cards(h.host)).toHaveLength(2);
    expect(h.list).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("invalide les correspondances de page de l'onglet quand le partagé signale un document périmé", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    h.read.mockClear();
    cards(h.host)[0]!.click();
    await flush();
    expect(h.read).not.toHaveBeenCalledWith("a.dsx"); // en cache
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await flush();
    cards(h.host)[0]!.click();
    await flush();
    expect(h.read).toHaveBeenCalledWith("a.dsx"); // relu après invalidation
    tab.dispose();
  });

  it("affiche l'échec de chargement du partagé, même pour un onglet ouvert après coup", async () => {
    const h = harness({ ids: [], autoStart: false });
    h.list.mockRejectedValue(new Error("liste KO"));
    await h.shared.start();
    const late = mountSearchTab(h.host, h.deps);
    expect(errMsg(h.host)).toMatch(/liste KO/);
    late.dispose();
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringMatching(/Chargement/), expect.any(Error));
  });

  it("affiche l'échec de chargement survenu pendant que l'onglet est ouvert", async () => {
    const h = harness({ ids: [], autoStart: false });
    h.list.mockRejectedValue(new Error("liste KO"));
    const tab = mountSearchTab(h.host, h.deps);
    expect(errMsg(h.host)).toBe("");
    await h.shared.start();
    expect(errMsg(h.host)).toMatch(/liste KO/);
    tab.dispose();
  });
  it("ne rouvre rien après dispose pendant la récupération des correspondances", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    h.decodePageMatches.mockImplementation(
      () => new Promise((r) => (release = () => r({ boxes: [], ordinals: [] }))),
    );
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    release();
    await flush();
    expect(h.openPdfAtPage).not.toHaveBeenCalled();
  });
});

const msg = (host: HTMLElement): string => host.querySelector(".docseeker-message")!.textContent ?? "";
const errMsg = (host: HTMLElement): string => host.querySelector(".docseeker-error")!.textContent ?? "";

describe("mountSearchTab (review fixes)", () => {
  it("ignore une ouverture périmée : handle jeté, pas de message, lastOpened intact", async () => {
    const h = harness();
    const first: { dispose: ReturnType<typeof vi.fn>; ready: Promise<unknown> } = {
      dispose: vi.fn(),
      ready: Promise.resolve(ATTACHED),
    };
    const second = { dispose: vi.fn(), ready: Promise.resolve(ATTACHED) };
    let resolveFirst: (v: typeof first) => void = () => undefined;
    h.openPdfAtPage
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(second);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    cards(h.host)[1]!.click();
    await flush();
    resolveFirst(first);
    await flush();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    tab.dispose();
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it("n'affiche pas l'erreur d'une ouverture périmée", async () => {
    const h = harness();
    let rejectFirst: (e: unknown) => void = () => undefined;
    h.openPdfAtPage
      .mockImplementationOnce(() => new Promise((_, rej) => (rejectFirst = rej)))
      .mockResolvedValueOnce({ dispose: vi.fn(), ready: Promise.resolve(ATTACHED) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    cards(h.host)[1]!.click();
    await flush();
    rejectFirst(new Error("vieux"));
    await flush();
    expect(msg(h.host)).toBe("");
    tab.dispose();
  });

  it.each([
    ["timeout", /Surlignage indisponible.*visualiseur/],
    ["empty", /Surlignage indisponible/],
  ])("dit pourquoi le surlignage manque (statut %s)", async (status, re) => {
    const h = harness();
    h.openPdfAtPage.mockResolvedValue({
      dispose: vi.fn(),
      ready: Promise.resolve({ ...ATTACHED, status, keptRects: 0 }),
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(msg(h.host)).toMatch(re);
    tab.dispose();
  });

  it("ne dit rien quand l'ouverture est remplacée (superseded)", async () => {
    const h = harness();
    h.openPdfAtPage.mockResolvedValue({
      dispose: vi.fn(),
      ready: Promise.resolve({ ...ATTACHED, status: "superseded", keptRects: 0 }),
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(msg(h.host)).toBe("");
    tab.dispose();
  });

  it("annonce un surlignage indisponible quand getPageMatches échoue", async () => {
    const h = harness();
    h.decodePageMatches.mockRejectedValue(new Error("dsx corrompu"));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(msg(h.host)).toMatch(/Surlignage indisponible.*dsx corrompu/);
    tab.dispose();
  });

  it("recharge le document réindexé (reloadPaths) même si son nom de fichier est inchangé", async () => {
    const h = harness({ ids: ["a", "b"] });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    h.read.mockClear();
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const reads = h.read.mock.calls.map(([n]) => n);
    expect(reads).toContain("a.dsx");
    expect(reads).not.toContain("b.dsx");
    tab.dispose();
  });

  it("montre l'échec du rafraîchissement, puis l'efface", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    h.list.mockRejectedValueOnce(new Error("noyau muet"));
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(errMsg(h.host)).toMatch(/noyau muet/);
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(errMsg(h.host)).toBe("");
    tab.dispose();
  });

  it("crée l'observateur avec rootMargin 200px 0px par défaut", async () => {
    const h = harness();
    const ctor = vi.fn(function (this: unknown) {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal("IntersectionObserver", ctor);
    delete (h.deps as { observerFactory?: unknown }).observerFactory;
    const tab = mountSearchTab(h.host, h.deps);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect((ctor.mock.calls[0] as unknown[])[1]).toMatchObject({ rootMargin: "200px 0px" });
    tab.dispose();
    vi.unstubAllGlobals();
  });
});

describe("mountSearchTab (messages distincts)", () => {
  const failRefresh = async (h: Harness): Promise<void> => {
    h.list.mockRejectedValueOnce(new Error("noyau muet"));
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
  };

  it("utilise deux régions status/polite distinctes", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    const err = h.host.querySelector(".docseeker-error")!;
    const action = h.host.querySelector(".docseeker-message")!;
    expect(err).not.toBe(action);
    for (const el of [err, action]) {
      expect(el.getAttribute("role")).toBe("status");
      expect(el.getAttribute("aria-live")).toBe("polite");
    }
    tab.dispose();
  });

  it("un clic sur un résultat n'efface pas l'erreur d'index partagée", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    await failRefresh(h);
    expect(errMsg(h.host)).toMatch(/noyau muet/);
    cards(h.host)[0]!.click();
    await flush();
    expect(errMsg(h.host)).toMatch(/noyau muet/);
    tab.dispose();
  });

  it("la fin de l'erreur partagée n'efface pas « Impossible d'ouvrir ce PDF »", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    await failRefresh(h);
    h.openPdfAtPage.mockRejectedValueOnce(new Error("introuvable"));
    cards(h.host)[0]!.click();
    await flush();
    expect(msg(h.host)).toMatch(/Impossible d'ouvrir/);
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(errMsg(h.host)).toBe("");
    expect(msg(h.host)).toMatch(/Impossible d'ouvrir/);
    tab.dispose();
  });

  it("l'apparition d'une erreur partagée n'écrase pas un message d'action", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    h.openPdfAtPage.mockRejectedValueOnce(new Error("introuvable"));
    cards(h.host)[0]!.click();
    await flush();
    await failRefresh(h);
    expect(msg(h.host)).toMatch(/Impossible d'ouvrir/);
    expect(errMsg(h.host)).toMatch(/noyau muet/);
    tab.dispose();
  });

  it("document disparu de l'index : le message renvoie aux paramètres (clé i18n), sans parler de réindexation en ligne", async () => {
    const h = harness();
    h.deps = { ...h.deps, t: (key) => (key === "docNotFound" ? "Introuvable : voir les paramètres" : key) };
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    const card = cards(h.host)[0]!;
    vi.spyOn(h.shared.store, "getDoc").mockReturnValue(undefined); // le document a disparu entre l'affichage et le clic
    card.click();
    await flush();
    expect(msg(h.host)).toBe("Introuvable : voir les paramètres");
    tab.dispose();
  });

  it("en cas d'erreur de chargement, propose les paramètres sans relancer le chargement", async () => {
    const h = harness({ ids: ["a"], autoStart: false });
    h.list.mockRejectedValueOnce(new Error("liste KO"));
    await h.shared.start();
    const tab = mountSearchTab(h.host, h.deps);
    expect(errMsg(h.host)).toMatch(/liste KO/);
    h.host.querySelector<HTMLButtonElement>("button.docseeker-open-settings")!.click();
    await flush();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledTimes(1);
    tab.dispose();
  });
});

describe("createWarnLog : heure locale", () => {
  it("horodate en heure locale HH:MM:SS (pas en UTC), avec une horloge injectée", () => {
    const local = new Date(2026, 10, 6, 13, 36, 5); // construite en heure locale, quel que soit le fuseau
    const log = createWarnLog({ sink: () => undefined, now: () => local });
    log.warn("test");
    expect(log.entries()).toEqual(["13:36:05 test"]);
  });

  it("complète les unités à deux chiffres", () => {
    const log = createWarnLog({ sink: () => undefined, now: () => new Date(2026, 0, 2, 3, 4, 5) });
    log.warn("x", new Error("e"));
    expect(log.entries()[0]).toBe("03:04:05 x — e");
  });
});

describe("createWarnLog", () => {
  it("garde au plus 50 entrées récentes, notifie et relaie à la console", () => {
    const sink = vi.fn();
    const log = createWarnLog({ max: 50, sink });
    const seen = vi.fn();
    const off = log.subscribe(seen);
    for (let i = 0; i < 60; i++) log.warn(`m${i}`, i === 59 ? new Error("x") : undefined);
    expect(log.entries()).toHaveLength(50);
    expect(log.entries()[0]).toContain("m10");
    expect(log.entries()[49]).toContain("m59");
    expect(log.entries()[49]).toContain("x");
    expect(seen).toHaveBeenCalledTimes(60);
    expect(sink).toHaveBeenCalledTimes(60);
    off();
    log.warn("z");
    expect(seen).toHaveBeenCalledTimes(60);
  });
});

describe("mountSearchTab : indicateur d'indexation automatique", () => {
  type Snapshot = {
    phase: "idle" | "running" | "done" | "partial" | "failed";
    done: number;
    total: number;
    failed: number;
    incomplete: number;
    discovery: boolean;
  };
  const IDLE: Snapshot = { phase: "idle", done: 0, total: 0, failed: 0, incomplete: 0, discovery: false };
  const snap = (over: Partial<Snapshot>): Snapshot => ({ ...IDLE, ...over });
  function activity(initial: Snapshot = IDLE) {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
      source: {
        getSnapshot: () => snapshot,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      set: (next: Snapshot) => {
        snapshot = next;
        for (const l of [...listeners]) l();
      },
      listeners,
    };
  }
  const T: Record<string, string> = {
    autoIndexRunning: "Indexation en cours",
    autoIndexCount: "{done}/{total} PDF",
    autoIndexUpToDate: "Index à jour",
    autoIndexFailed: "{n} PDF en échec : voir le journal dans les paramètres",
    autoIndexDiscoveryFailed: "La découverte des PDF a échoué : voir le journal dans les paramètres",
    autoIndexPartialOne: "Index à jour, mais {n} élément n'a pas pu être lu : voir le journal des paramètres",
    autoIndexPartialMany: "Index à jour, mais {n} éléments n'ont pas pu être lus : voir le journal des paramètres",
    indexingMayMiss: "Indexation en cours : des résultats peuvent manquer",
    openSettings: "Ouvrir les paramètres",
  };
  const mount = (a: ReturnType<typeof activity>) => {
    const h = harness();
    h.deps = { ...h.deps, indexActivity: a.source, t: (key: string) => T[key] ?? key };
    const tab = mountSearchTab(h.host, h.deps);
    const region = h.host.querySelector<HTMLElement>(".docseeker-index-activity")!;
    const count = h.host.querySelector<HTMLElement>(".docseeker-index-count")!;
    const button = (): HTMLButtonElement | null => h.host.querySelector(".docseeker-index-settings");
    return { h, tab, region, count, button };
  };

  it("région polie stable : role=status, aria-live, aria-atomic, jamais `hidden`, vide au repos", () => {
    const { region } = mount(activity());
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.hasAttribute("hidden")).toBe(false);
    expect(region.textContent).toBe("");
  });

  it("l'indicateur est placé juste après le champ de recherche, avant la liste", () => {
    const { h } = mount(activity());
    const root = h.host.querySelector(".docseeker-search")!;
    const kids = [...root.children];
    const input = kids.findIndex((k) => k.tagName === "INPUT");
    const row = kids.findIndex((k) => k.querySelector(".docseeker-index-activity") !== null);
    const list = kids.findIndex((k) => k.tagName === "UL");
    expect(input).toBeLessThan(row);
    expect(row).toBeLessThan(list);
    expect(row).toBe(input + 1);
  });

  it("sans dépendance indexActivity, aucune région n'est ajoutée", () => {
    const h = harness();
    mountSearchTab(h.host, h.deps);
    expect(h.host.querySelector(".docseeker-index-activity")).toBeNull();
  });

  it("en cours : texte live FIXE ; la fraction N/M est dans un nœud aria-hidden qui ne réécrit pas la région live", () => {
    const a = activity();
    const { region, count } = mount(a);
    a.set(snap({ phase: "running", done: 1, total: 3 }));
    expect(region.textContent).toBe("Indexation en cours");
    expect(region.contains(count)).toBe(false);
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(count.textContent).toBe("1/3 PDF");
    const node = region.firstChild;
    a.set(snap({ phase: "running", done: 2, total: 3 }));
    expect(region.firstChild).toBe(node);
    expect(count.textContent).toBe("2/3 PDF");
  });

  it("total inconnu : pas de fraction", () => {
    const a = activity();
    const { region, count } = mount(a);
    a.set(snap({ phase: "running", done: 0, total: 0 }));
    expect(region.textContent).toBe("Indexation en cours");
    expect(count.textContent).toBe("");
  });

  it("terminé : « Index à jour » 8 s puis la région est vidée (mais reste dans l'arbre)", () => {
    const a = activity();
    const { region, h } = mount(a);
    a.set(snap({ phase: "running", done: 0, total: 1 }));
    a.set(snap({ phase: "done" }));
    expect(region.textContent).toBe("Index à jour");
    vi.advanceTimersByTime(7999);
    expect(region.textContent).toBe("Index à jour");
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe("");
    expect(h.host.contains(region)).toBe(true);
  });

  it("une nouvelle passe annule le masquage différé", () => {
    const a = activity();
    const { region } = mount(a);
    a.set(snap({ phase: "done" }));
    vi.advanceTimersByTime(2000);
    a.set(snap({ phase: "running", done: 0, total: 2 }));
    vi.advanceTimersByTime(20_000);
    expect(region.textContent).toBe("Indexation en cours");
  });

  it("échecs : message persistant, bouton « Ouvrir les paramètres » à côté ; au repos il disparaît", () => {
    const a = activity();
    const { region, button, h } = mount(a);
    expect(button()?.hidden).toBe(true);
    a.set(snap({ phase: "failed", failed: 2 }));
    expect(region.textContent).toBe("2 PDF en échec : voir le journal dans les paramètres");
    vi.advanceTimersByTime(60_000);
    expect(region.textContent).not.toBe("");
    expect(button()!.hidden).toBe(false);
    expect(button()!.textContent).toBe("Ouvrir les paramètres");
    expect(region.contains(button())).toBe(false); // hors de la région live
    button()!.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    a.set(snap({ phase: "idle" }));
    expect(region.textContent).toBe("");
    expect(button()!.hidden).toBe(true);
  });

  it("échec de découverte : texte distinct", () => {
    const a = activity();
    const { region } = mount(a);
    a.set(snap({ phase: "failed", failed: 1, discovery: true }));
    expect(region.textContent).toBe("La découverte des PDF a échoué : voir le journal dans les paramètres");
  });

  it("parcours incomplet : « Index à jour, mais N éléments… » persistant, pluriel et bouton", () => {
    const a = activity();
    const { region, button } = mount(a);
    a.set(snap({ phase: "partial", incomplete: 1 }));
    expect(region.textContent).toBe("Index à jour, mais 1 élément n'a pas pu être lu : voir le journal des paramètres");
    a.set(snap({ phase: "partial", incomplete: 3 }));
    expect(region.textContent).toBe("Index à jour, mais 3 éléments n'ont pas pu être lus : voir le journal des paramètres");
    vi.advanceTimersByTime(60_000);
    expect(region.textContent).not.toBe("");
    expect(button()!.hidden).toBe(false);
  });

  it("sans onOpenSettings, pas de bouton", () => {
    const h = harness();
    const a = activity();
    h.deps = { ...h.deps, indexActivity: a.source };
    delete (h.deps as { onOpenSettings?: unknown }).onOpenSettings;
    mountSearchTab(h.host, h.deps);
    expect(h.host.querySelector(".docseeker-index-settings")).toBeNull();
  });

  it("état initial non nul (onglet ouvert pendant une indexation) : affiché au montage", () => {
    const { region, count } = mount(activity(snap({ phase: "running", done: 1, total: 4 })));
    expect(region.textContent).toBe("Indexation en cours");
    expect(count.textContent).toBe("1/4 PDF");
  });

  it("dispose se désabonne, annule le minuteur et retire l'indicateur", () => {
    const a = activity();
    const { tab, region, h } = mount(a);
    a.set(snap({ phase: "done" }));
    tab.dispose();
    expect(a.listeners.size).toBe(0);
    expect(h.host.querySelector(".docseeker-index-activity")).toBeNull();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(region.isConnected).toBe(false);
  });
});

describe("mountSearchTab : résultats partiels pendant l'indexation", () => {
  const T: Record<string, string> = { indexingMayMiss: "Indexation en cours : des résultats peuvent manquer" };
  const IDLE = { phase: "idle", done: 0, total: 0, failed: 0, incomplete: 0, discovery: false } as const;
  function setup() {
    const h = harness();
    let snapshot: { phase: "idle" | "running" | "done" | "partial" | "failed"; done: number; total: number; failed: number; incomplete: number; discovery: boolean } = IDLE;
    const listeners = new Set<() => void>();
    h.deps = {
      ...h.deps,
      t: (key: string) => T[key] ?? key,
      indexActivity: {
        getSnapshot: () => snapshot,
        subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
      },
    };
    const set = (phase: typeof snapshot.phase, done = 0): void => {
      snapshot = { ...IDLE, phase, done, total: 3 };
      for (const l of [...listeners]) l();
    };
    const status = (): string => h.host.querySelector(".docseeker-status")!.textContent!;
    return { h, set, status };
  }

  it("sur « aucun résultat » : le suffixe apparaît pendant l'indexation et disparaît ensuite, sans relancer la requête", async () => {
    const { h, set, status } = setup();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "zzzinconnu");
    expect(status()).toBe("Aucun résultat");
    const reads = h.read.mock.calls.length;
    set("running");
    expect(status()).toBe("Aucun résultat. Indexation en cours : des résultats peuvent manquer");
    set("running", 1); // le N/M ne re-rend pas le texte
    expect(status()).toBe("Aucun résultat. Indexation en cours : des résultats peuvent manquer");
    set("done");
    expect(status()).toBe("Aucun résultat");
    expect(h.read.mock.calls.length).toBe(reads);
    tab.dispose();
  });

  it("sur des résultats : le suffixe est aussi ajouté", async () => {
    const { h, set, status } = setup();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    set("running");
    expect(status()).toContain("des résultats peuvent manquer");
    expect(cards(h.host).length).toBeGreaterThan(0);
    set("idle");
    expect(status()).not.toContain("peuvent manquer");
    tab.dispose();
  });

  it("une indexation terminée (indexed) met à jour les résultats de la requête courante sans nouvelle saisie", async () => {
    const h = harness({ ids: ["a"] });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    const before = h.host.querySelectorAll("li.docseeker-doc, ul.docseeker-list > li").length;
    h.files.set("b.dsx", bytes("b"));
    h.emit({ type: "indexed", path: PDF_B, pages: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    const after = h.host.querySelectorAll("li.docseeker-doc, ul.docseeker-list > li").length;
    expect(after).toBe(before + 1);
    tab.dispose();
  });
});
