import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexData } from "../../../src/core/codec/format";
import type { IndexerEvent } from "../../../src/indexer/indexer";
import { createDsxStore, createSharedIndex, REFRESH_DEBOUNCE_MS } from "../../../src/search/sharedIndex";

const PDF_A = "assets/Alpha-20240101120000-abc1234.pdf";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function data(sourcePath: string): SearchIndexData {
  return {
    normalizerVersion: 1,
    extractorVersion: "t",
    sourcePath,
    pdfSize: 1,
    pdfModifiedMs: 2,
    pageTermCounts: new Uint32Array([1, 2]),
    postings: {
      terms: ["chat"],
      offsets: new Uint32Array([0, 1]),
      pages: new Uint32Array([2]),
      termFrequencies: new Uint32Array([1]),
    },
  };
}

function setup(ids: string[] = ["a"]) {
  const files = new Map<string, Uint8Array>([["manifest.json", bytes("{}")]]);
  for (const id of ids) files.set(`${id}.dsx`, bytes(id));
  const list = vi.fn(async () => [...files.keys()]);
  const read = vi.fn(async (name: string) => files.get(name) ?? null);
  const listeners = new Set<(e: IndexerEvent) => void>();
  const onWarn = vi.fn();
  const shared = createSharedIndex({
    store: { list, read },
    decode: async () => data(PDF_A),
    indexer: {
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    onWarn,
  });
  const emit = (e: IndexerEvent): void => {
    for (const l of [...listeners]) l(e);
  };
  return { shared, list, read, listeners, onWarn, emit, files };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDsxStore", () => {
  it("ne liste que les .dsx et délègue la lecture", async () => {
    const read = vi.fn(async () => bytes("x"));
    const store = createDsxStore({ list: async () => ["a.dsx", "manifest.json", "b.dsx.tmp"], read });
    expect(await store.list()).toEqual(["a.dsx"]);
    await store.read("a.dsx");
    expect(read).toHaveBeenCalledWith("a.dsx");
  });
});

describe("createSharedIndex", () => {
  it("ne charge qu'une fois, même si start est appelé plusieurs fois", async () => {
    const s = setup();
    const p1 = s.shared.start();
    const p2 = s.shared.start();
    await Promise.all([p1, p2]);
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.shared.store.getPhase()).toBe("ready");
    expect(s.shared.store.listDocs()).toHaveLength(1);
  });

  it("ne charge rien avant start", async () => {
    const s = setup();
    await flush();
    expect(s.list).not.toHaveBeenCalled();
    expect(s.listeners.size).toBe(0);
  });

  it("un abonné tardif voit directement les documents chargés", async () => {
    const s = setup();
    await s.shared.start();
    expect(s.shared.store.getDoc("a")?.path).toBe(PDF_A);
    expect(s.shared.getError()).toBeUndefined();
  });

  it("un seul refresh débouncé quel que soit le nombre d'abonnés, avec reloadPaths", async () => {
    const s = setup(["a"]);
    await s.shared.start();
    const t1 = vi.fn();
    const t2 = vi.fn();
    s.shared.onInvalidate(t1);
    s.shared.onInvalidate(t2);
    s.list.mockClear();
    s.read.mockClear();

    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    s.emit({ type: "removed", path: "assets/autre.pdf" });
    s.emit({ type: "progress", path: PDF_A, page: 1, total: 2 });
    expect(s.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.read).toHaveBeenCalledWith("a.dsx");
    // Les deux abonnés sont notifiés des documents périmés (immédiatement, puis après le refresh).
    expect(t1).toHaveBeenCalledWith(["a"]);
    expect(t2).toHaveBeenCalledWith(["a"]);
    expect(t1.mock.calls).toEqual([[["a"]], [["a"]]]);
  });

  it("se désabonner d'onInvalidate arrête les notifications", async () => {
    const s = setup();
    await s.shared.start();
    const t = vi.fn();
    s.shared.onInvalidate(t)();
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    expect(t).not.toHaveBeenCalled();
  });

  it("un échec de chargement est journalisé et exposé aux abonnés", async () => {
    const s = setup();
    s.list.mockRejectedValue(new Error("noyau muet"));
    const status = vi.fn();
    s.shared.onStatus(status);
    await s.shared.start();
    expect(s.onWarn).toHaveBeenCalledWith(expect.stringMatching(/Chargement/), expect.any(Error));
    expect(s.shared.getError()).toMatch(/Chargement des index en échec.*noyau muet/);
    expect(status).toHaveBeenCalled();
    expect(s.shared.store.getPhase()).toBe("error");
  });

  it("un échec de rafraîchissement est signalé puis effacé au succès suivant", async () => {
    const s = setup();
    await s.shared.start();
    const status = vi.fn();
    s.shared.onStatus(status);
    s.list.mockRejectedValueOnce(new Error("KO"));
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(s.shared.getError()).toMatch(/Rafraîchissement.*KO/);
    expect(s.onWarn).toHaveBeenCalled();
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(s.shared.getError()).toBeUndefined();
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("dispose annule le chargement en cours sans le signaler comme une erreur", async () => {
    const s = setup(["a", "b"]);
    const releases: Array<(v: Uint8Array) => void> = [];
    s.read.mockImplementation(() => new Promise<Uint8Array>((r) => releases.push(r)));
    const p = s.shared.start();
    await flush();
    s.shared.dispose();
    for (const release of releases) release(bytes("a"));
    await p;
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(s.shared.getError()).toBeUndefined();
    expect(s.listeners.size).toBe(0);
  });

  it("dispose annule la minuterie de rafraîchissement et se désabonne de l'indexeur", async () => {
    const s = setup();
    await s.shared.start();
    s.list.mockClear();
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    expect(vi.getTimerCount()).toBe(1);
    s.shared.dispose();
    s.shared.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.list).not.toHaveBeenCalled();
  });

  it("start après dispose ne charge rien", async () => {
    const s = setup();
    s.shared.dispose();
    await s.shared.start();
    expect(s.list).not.toHaveBeenCalled();
  });

  it("un chargement échoué est retenté par start(), sans double abonnement à l'indexeur", async () => {
    const s = setup();
    s.list.mockRejectedValueOnce(new Error("noyau muet"));
    await s.shared.start();
    expect(s.shared.getError()).toMatch(/noyau muet/);
    expect(s.listeners.size).toBe(1);
    await s.shared.start();
    expect(s.list).toHaveBeenCalledTimes(2);
    expect(s.listeners.size).toBe(1);
    expect(s.shared.getError()).toBeUndefined();
    expect(s.shared.store.getPhase()).toBe("ready");
    await s.shared.start();
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it("getError reflète la phase d'erreur du store quand tous les .dsx sont illisibles", async () => {
    const files = new Map<string, Uint8Array>([["a.dsx", bytes("a")], ["b.dsx", bytes("b")]]);
    const onWarn = vi.fn();
    const shared = createSharedIndex({
      store: { list: async () => [...files.keys()], read: async (n) => files.get(n) ?? null },
      decode: async () => {
        throw new Error("dsx corrompu");
      },
      indexer: { onEvent: () => () => undefined },
      onWarn,
    });
    const status = vi.fn();
    shared.onStatus(status);
    await shared.start();
    expect(shared.store.getPhase()).toBe("error");
    expect(shared.getError()).toMatch(/dsx corrompu/);
    expect(status).toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalled(); // échecs partiels journalisés
  });

  it("un événement arrivé pendant un refresh en vol est notifié après le refresh suivant", async () => {
    const s = setup();
    await s.shared.start();
    const t = vi.fn();
    s.shared.onInvalidate(t);
    let release: (names: string[]) => void = () => undefined;
    s.list.mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)));
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10); // refresh 1 en vol
    s.emit({ type: "indexed", path: PDF_A, pages: 2 }); // pendant le vol
    t.mockClear();
    release(["a.dsx"]);
    await flush();
    expect(t).toHaveBeenCalledTimes(1); // fin du refresh 1
    t.mockClear();
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(t).toHaveBeenCalledTimes(1); // 'a' était resté périmé : fin du refresh 2
    expect(t).toHaveBeenCalledWith(["a"]);
  });

  it("remet les chemins à recharger si le refresh rejette", async () => {
    const s = setup(["a"]);
    await s.shared.start();
    s.list.mockRejectedValueOnce(new Error("KO"));
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(s.shared.getError()).toMatch(/KO/);
    s.read.mockClear();
    s.emit({ type: "removed", path: "assets/autre.pdf" }); // déclenche un refresh sans nouveau chemin
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    expect(s.read.mock.calls.map(([n]) => n)).toEqual(["a.dsx"]);
  });

  it("un écouteur qui lève est journalisé et n'empêche pas les autres", async () => {
    const s = setup();
    await s.shared.start();
    const good = vi.fn();
    s.shared.onInvalidate(() => {
      throw new Error("écouteur KO");
    });
    s.shared.onInvalidate(good);
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    expect(good).toHaveBeenCalledWith(["a"]);
    expect(s.onWarn).toHaveBeenCalledWith(expect.stringMatching(/Écouteur/), expect.any(Error));
  });

  it("dispose pendant un refresh en vol : pas d'erreur, pas de notification", async () => {
    const s = setup();
    await s.shared.start();
    const t = vi.fn();
    s.shared.onInvalidate(t);
    let release: (names: string[]) => void = () => undefined;
    s.list.mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)));
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    s.shared.dispose();
    t.mockClear();
    s.onWarn.mockClear();
    release(["a.dsx"]);
    await flush();
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(s.shared.getError()).toBeUndefined();
    expect(t).not.toHaveBeenCalled();
  });

  it("un événement pendant le chargement initial est pris en compte par un refresh après le chargement", async () => {
    const s = setup();
    let release: (names: string[]) => void = () => undefined;
    s.list.mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)));
    const p = s.shared.start();
    await flush();
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    expect(s.list).toHaveBeenCalledTimes(1); // le refresh attend la fin du chargement
    release(["a.dsx"]);
    await p;
    await flush();
    expect(s.list).toHaveBeenCalledTimes(2);
    expect(s.shared.store.getPhase()).toBe("ready");
    expect(s.shared.getError()).toBeUndefined();
  });

  it("start ne lève jamais de façon synchrone si l'abonnement à l'indexeur échoue", async () => {
    const onWarn = vi.fn();
    const shared = createSharedIndex({
      store: { list: async () => [], read: async () => null },
      decode: async () => data(PDF_A),
      indexer: {
        onEvent: () => {
          throw new Error("abonnement KO");
        },
      },
      onWarn,
    });
    let p: Promise<void> | undefined;
    expect(() => {
      p = shared.start();
    }).not.toThrow();
    await p;
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(shared.getError()).toMatch(/abonnement KO/);
  });

  it("un onWarn qui lève pendant un refresh en échec ne produit pas de rejet non géré", async () => {
    const s = setup();
    await s.shared.start();
    s.onWarn.mockImplementation(() => {
      throw new Error("onWarn KO");
    });
    s.list.mockRejectedValueOnce(new Error("KO"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    s.emit({ type: "indexed", path: PDF_A, pages: 2 });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    await flush();
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
