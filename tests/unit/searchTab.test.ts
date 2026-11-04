// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexData } from "../../src/core/codec/format";
import type { IndexerEvent } from "../../src/indexer/indexer";
import { InvalidPdfPathError } from "../../src/siyuan/openPdf";
import { createWarnLog, mountSearchTab, type SearchTabDeps } from "../../src/searchTab";

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
      terms: ["chat"],
      offsets: new Uint32Array([0, 2]),
      pages: new Uint32Array([2, 3]),
      termFrequencies: new Uint32Array([1, 1]),
    },
    ...over,
  };
}

const ATTACHED = { status: "attached", pageNumber: 2, keptRects: 1, droppedRects: 0 };
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Harness {
  host: HTMLElement;
  deps: SearchTabDeps;
  files: Map<string, Uint8Array>;
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  emit: (event: IndexerEvent) => void;
  listeners: Set<(event: IndexerEvent) => void>;
  start: ReturnType<typeof vi.fn>;
  openPdfAtPage: ReturnType<typeof vi.fn>;
  decodePageMatches: ReturnType<typeof vi.fn>;
  onWarn: ReturnType<typeof vi.fn>;
  observerDisconnect: ReturnType<typeof vi.fn>;
}

function harness(over: { ids?: string[] } = {}): Harness {
  const ids = over.ids ?? ["a"];
  const files = new Map<string, Uint8Array>();
  for (const id of ids) files.set(`${id}.dsx`, bytes(id));
  files.set("manifest.json", bytes("{}"));
  const list = vi.fn(async () => [...files.keys()]);
  const read = vi.fn(async (name: string) => files.get(name) ?? null);
  const listeners = new Set<(event: IndexerEvent) => void>();
  const start = vi.fn(async () => ({ indexed: 0, skippedScanned: 0, failed: 0, removed: 0, cancelled: false }));
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
  const deps: SearchTabDeps = {
    store: { list, read } as unknown as SearchTabDeps["store"],
    decode: async (b) => data(new TextDecoder().decode(b) === "b" ? PDF_B : PDF_A),
    decodePageMatches: decodePageMatches as unknown as NonNullable<SearchTabDeps["decodePageMatches"]>,
    indexer: {
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      start,
    },
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
    host, deps, files, list, read, listeners, start, openPdfAtPage, decodePageMatches, onWarn, observerDisconnect,
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
  };
}

async function type(host: HTMLElement, text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(500);
  await flush();
}

const cards = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>("button.docseeker-card")];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mountSearchTab", () => {
  it("charge les index au montage, en ignorant manifest.json, et affiche les résultats", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith("a.dsx");
    expect(h.read).not.toHaveBeenCalledWith("manifest.json");
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

  it("branche le bouton Réindexer sur l'indexeur", async () => {
    const h = harness({ ids: [] });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    const button = h.host.querySelector<HTMLButtonElement>("button.docseeker-reindex")!;
    button.click();
    expect(h.start).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("dispose est idempotent et libère observateur, abonnements, minuteries et DOM", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await type(h.host, "chat");
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const before = h.list.mock.calls.length;

    tab.dispose();
    expect(() => tab.dispose()).not.toThrow();
    expect(h.observerDisconnect).toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.host.childElementCount).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.list.mock.calls.length).toBe(before);
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

  it("montre l'échec du rafraîchissement, du chargement et de la réindexation", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    h.list.mockRejectedValue(new Error("noyau muet"));
    h.emit({ type: "indexed", path: PDF_A, pages: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(msg(h.host)).toMatch(/noyau muet/);
    tab.dispose();

    const h2 = harness({ ids: [] });
    h2.list.mockRejectedValue(new Error("liste KO"));
    const tab2 = mountSearchTab(h2.host, h2.deps);
    await flush();
    expect(msg(h2.host)).toMatch(/liste KO/);
    tab2.dispose();

    const h3 = harness({ ids: [] });
    h3.start.mockRejectedValue(new Error("indexeur KO"));
    const tab3 = mountSearchTab(h3.host, h3.deps);
    await flush();
    await type(h3.host, "chat");
    h3.host.querySelector<HTMLButtonElement>("button.docseeker-reindex")!.click();
    await flush();
    expect(msg(h3.host)).toMatch(/indexeur KO/);
    tab3.dispose();
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
