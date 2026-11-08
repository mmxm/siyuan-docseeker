import { describe, expect, it, vi } from "vitest";
import type { SearchIndexData } from "../../../src/core/codec/format";
import { createSearchStore, type SearchStoreDeps } from "../../../src/search/searchStore";

function data(over: Partial<SearchIndexData> = {}): SearchIndexData {
  return {
    normalizerVersion: 1,
    extractorVersion: "t",
    sourcePath: "assets/Mon rapport-20240101120000-abc1234.pdf",
    pdfSize: 123,
    pdfModifiedMs: 456,
    pageTermCounts: new Uint32Array([1, 2, 3]),
    postings: {
      terms: ["chat"],
      offsets: new Uint32Array([0, 1]),
      pages: new Uint32Array([1]),
      termFrequencies: new Uint32Array([1]),
    },
    ...over,
  };
}

/** Octets factices : le premier octet identifie le document pour le décodeur factice. */
const bytesOf = (id: string): Uint8Array => new TextEncoder().encode(id);

interface Harness {
  deps: SearchStoreDeps;
  files: Map<string, Uint8Array | null>;
  names: { value: string[] };
  warn: ReturnType<typeof vi.fn>;
  decoded: string[];
  sources: Map<string, Partial<SearchIndexData>>;
}

function harness(ids: string[] = []): Harness {
  const files = new Map<string, Uint8Array | null>();
  const names = { value: [] as string[] };
  const sources = new Map<string, Partial<SearchIndexData>>();
  for (const id of ids) {
    files.set(`${id}.dsx`, bytesOf(id));
    names.value.push(`${id}.dsx`);
  }
  const decoded: string[] = [];
  const warn = vi.fn();
  const deps: SearchStoreDeps = {
    store: {
      list: async () => [...names.value],
      read: async (n) => files.get(n) ?? null,
    },
    decode: async (b) => {
      const id = new TextDecoder().decode(b);
      if (id.startsWith("bad")) throw new Error(`corrupt ${id}`);
      decoded.push(id);
      return data(sources.get(id) ?? {});
    },
    onWarn: warn,
  };
  return { deps, files, names, warn, decoded, sources };
}

describe("createSearchStore", () => {
  it("starts idle with an empty index", () => {
    const s = createSearchStore(harness().deps);
    expect(s.getPhase()).toBe("idle");
    expect(s.getIndex().segments).toHaveLength(0);
    expect(s.listDocs()).toEqual([]);
    expect(s.getProgress()).toEqual({ loaded: 0, total: 0, failed: [] });
  });

  it("loads only .dsx files and derives DocInfo", async () => {
    const h = harness(["a"]);
    h.names.value.push("manifest.json", "a.dsx.tmp", "a.dsx.bak", "x.abc.tmp");
    const s = createSearchStore(h.deps);
    await s.load();
    expect(s.getPhase()).toBe("ready");
    expect(s.getProgress()).toEqual({ loaded: 1, total: 1, failed: [] });
    expect(s.getDoc("a")).toEqual({
      docId: "a",
      path: "assets/Mon rapport-20240101120000-abc1234.pdf",
      title: "Mon rapport",
      pageCount: 3,
      pdfSize: 123,
      pdfModifiedMs: 456,
    });
    expect(s.getIndex().segments.map((x) => x.docId)).toEqual(["a"]);
    expect(s.getDoc("zzz")).toBeUndefined();
  });

  it("derives titles from varied paths", async () => {
    const h = harness(["a", "b", "c"]);
    h.sources.set("a", { sourcePath: "C:\\docs\\Plain.PDF" });
    h.sources.set("b", { sourcePath: "x/y/no-ext" });
    h.sources.set("c", { sourcePath: "" });
    const s = createSearchStore(h.deps);
    await s.load();
    expect(s.getDoc("a")?.title).toBe("Plain");
    expect(s.getDoc("b")?.title).toBe("no-ext");
    expect(s.getDoc("c")?.title).toBe("c");
  });

  it("decodes with a concurrency of 2 and releases bytes between documents", async () => {
    const h = harness(["a", "b", "c", "d", "e"]);
    let running = 0;
    let max = 0;
    const base = h.deps.decode;
    const deps: SearchStoreDeps = {
      ...h.deps,
      decode: async (b) => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return base(b);
      },
    };
    const s = createSearchStore(deps);
    await s.load();
    expect(max).toBe(2);
    expect(s.listDocs()).toHaveLength(5);
  });

  it("publishes partial results and notifies at each addition", async () => {
    const h = harness(["a", "b", "c"]);
    const s = createSearchStore(h.deps);
    const seen: number[] = [];
    s.subscribe(() => seen.push(s.getIndex().segments.length));
    await s.load();
    expect(seen.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(seen.find((n) => n > 0)).toBe(1);
    expect(seen[seen.length - 1]).toBe(3);
  });

  it("survives corrupt, unreadable and failing files", async () => {
    const h = harness(["a", "bad1"]);
    h.names.value.push("missing.dsx");
    const s = createSearchStore(h.deps);
    await s.load();
    expect(s.getPhase()).toBe("ready");
    expect(s.listDocs().map((d) => d.docId)).toEqual(["a"]);
    const p = s.getProgress();
    expect(p.total).toBe(3);
    expect(p.loaded).toBe(1);
    expect(p.failed.map((f) => f.name).sort()).toEqual(["bad1.dsx", "missing.dsx"]);
    expect(p.failed.find((f) => f.name === "bad1.dsx")?.message).toContain("corrupt");
    expect(h.warn).toHaveBeenCalledTimes(2);
  });

  it("ends in error only when everything fails", async () => {
    const h = harness(["bad1", "bad2"]);
    const s = createSearchStore(h.deps);
    await s.load();
    expect(s.getPhase()).toBe("error");
    const empty = createSearchStore(harness().deps);
    await empty.load();
    expect(empty.getPhase()).toBe("ready");
  });

  it("goes to error and rejects when list() fails", async () => {
    const h = harness();
    const deps = { ...h.deps, store: { ...h.deps.store, list: async () => { throw new Error("boom"); } } };
    const s = createSearchStore(deps);
    await expect(s.load()).rejects.toThrow("boom");
    expect(s.getPhase()).toBe("error");
  });

  it("isolates throwing listeners and supports unsubscribe", async () => {
    const h = harness(["a"]);
    const s = createSearchStore(h.deps);
    const good = vi.fn();
    s.subscribe(() => { throw new Error("listener"); });
    const off = s.subscribe(good);
    await s.load();
    expect(good).toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalled();
    const n = good.mock.calls.length;
    off();
    h.names.value.push("b.dsx");
    h.files.set("b.dsx", bytesOf("b"));
    await s.refresh();
    expect(good.mock.calls.length).toBe(n);
  });

  it("refresh decodes only new files and drops vanished ones", async () => {
    const h = harness(["a", "b"]);
    const s = createSearchStore(h.deps);
    await s.load();
    h.decoded.length = 0;
    h.names.value = ["b.dsx", "c.dsx"];
    h.files.set("c.dsx", bytesOf("c"));
    await s.refresh();
    expect(h.decoded).toEqual(["c"]);
    expect(s.listDocs().map((d) => d.docId).sort()).toEqual(["b", "c"]);
    expect(s.getDoc("a")).toBeUndefined();
    expect(s.getIndex().segments.map((x) => x.docId).sort()).toEqual(["b", "c"]);
    expect(s.getProgress().total).toBe(2);
  });

  it("refresh retries previously failed files", async () => {
    const h = harness(["a", "bad1"]);
    const s = createSearchStore(h.deps);
    await s.load();
    await s.refresh();
    expect(s.getDoc("bad1")).toBeUndefined();
    expect(s.getProgress().failed).toHaveLength(1);
    h.names.value = ["a.dsx", "bad1.dsx"];
    h.files.set("bad1.dsx", bytesOf("ok"));
    await s.refresh();
    expect(s.getDoc("bad1")).toBeDefined();
    expect(s.getProgress().failed).toEqual([]);
  });

  it("load() again reloads everything", async () => {
    const h = harness(["a"]);
    const s = createSearchStore(h.deps);
    await s.load();
    h.sources.set("a", { pdfSize: 999 });
    await s.load();
    expect(s.getDoc("a")?.pdfSize).toBe(999);
    expect(s.getIndex().segments).toHaveLength(1);
  });

  it("does not publish after abort", async () => {
    const h = harness(["a", "b", "c"]);
    const ctl = new AbortController();
    const base = h.deps.decode;
    const deps: SearchStoreDeps = {
      ...h.deps,
      decode: async (b) => {
        ctl.abort();
        return base(b);
      },
    };
    const s = createSearchStore(deps);
    const listener = vi.fn();
    s.subscribe(listener);
    await s.load(ctl.signal);
    expect(s.listDocs()).toHaveLength(0);
    expect(s.getIndex().segments).toHaveLength(0);
    expect(s.getPhase()).toBe("idle");
  });

  it("returns immediately when already aborted", async () => {
    const h = harness(["a"]);
    const ctl = new AbortController();
    ctl.abort();
    const s = createSearchStore(h.deps);
    await s.load(ctl.signal);
    expect(s.listDocs()).toEqual([]);
  });

  it("serializes concurrent load and refresh", async () => {
    const h = harness(["a", "b"]);
    let running = 0;
    let overlap = false;
    const base = h.deps.decode;
    const deps: SearchStoreDeps = {
      ...h.deps,
      decode: async (b) => {
        running++;
        await new Promise((r) => setTimeout(r, 3));
        running--;
        return base(b);
      },
    };
    const s = createSearchStore(deps);
    const listing = deps.store.list;
    deps.store.list = async () => {
      if (running > 0) overlap = true;
      return listing();
    };
    await Promise.all([s.load(), s.refresh(), s.refresh()]);
    expect(overlap).toBe(false);
    expect(s.listDocs()).toHaveLength(2);
    expect(s.getIndex().segments).toHaveLength(2);
  });

  it("reports phase loading during load", async () => {
    const h = harness(["a"]);
    const s = createSearchStore(h.deps);
    const phases: string[] = [];
    s.subscribe(() => phases.push(s.getPhase()));
    await s.load();
    expect(phases[0]).toBe("loading");
    expect(s.getPhase()).toBe("ready");
  });

  it("la fin du chargement émet une dernière notification en phase ready (c'est elle qui relance le contrôleur)", async () => {
    const h = harness(["a", "b"]);
    const s = createSearchStore(h.deps);
    const phases: string[] = [];
    s.subscribe(() => phases.push(s.getPhase()));
    await s.load();
    expect(phases.at(-1)).toBe("ready");
    expect(phases.filter((p) => p === "ready")).toHaveLength(1); // une seule : un seul re-classement côté contrôleur
    expect(phases.slice(0, -1).every((p) => p === "loading")).toBe(true);
  });

  describe("refresh(options)", () => {
    it("keeps the phase ready (no visible loading) during a refresh of a loaded store", async () => {
      const h = harness(["a"]);
      const s = createSearchStore(h.deps);
      await s.load();
      const phases: string[] = [];
      s.subscribe(() => phases.push(s.getPhase()));
      h.names.value.push("b.dsx");
      h.files.set("b.dsx", bytesOf("b"));
      await s.refresh();
      expect(phases.length).toBeGreaterThan(0);
      expect(new Set(phases)).toEqual(new Set(["ready"]));
      expect(s.getDoc("b")).toBeDefined();
    });

    it("still reports loading when refreshing a store that never finished loading", async () => {
      const h = harness(["a"]);
      const s = createSearchStore(h.deps);
      const phases: string[] = [];
      s.subscribe(() => phases.push(s.getPhase()));
      await s.refresh();
      expect(phases[0]).toBe("loading");
      expect(s.getPhase()).toBe("ready");
    });

    it("reloadPaths forces the reload of the documents whose path matches, even with the same name", async () => {
      const h = harness(["a", "b"]);
      h.sources.set("a", { sourcePath: "assets/a.pdf", pdfSize: 1 });
      h.sources.set("b", { sourcePath: "assets/b.pdf", pdfSize: 1 });
      const s = createSearchStore(h.deps);
      await s.load();
      h.decoded.length = 0;
      h.sources.set("a", { sourcePath: "assets/a.pdf", pdfSize: 2 });
      await s.refresh({ reloadPaths: ["assets/a.pdf"] });
      expect(h.decoded).toEqual(["a"]);
      expect(s.getDoc("a")?.pdfSize).toBe(2);
      expect(s.getDoc("b")?.pdfSize).toBe(1);
      expect(s.getIndex().segments.map((x) => x.docId).sort()).toEqual(["a", "b"]);
    });

    it("without reloadPaths nothing is reloaded", async () => {
      const h = harness(["a"]);
      const s = createSearchStore(h.deps);
      await s.load();
      h.decoded.length = 0;
      await s.refresh({ reloadPaths: [] });
      expect(h.decoded).toEqual([]);
    });

    it("a failed reload keeps the previous version of the document and records the failure", async () => {
      const h = harness(["a"]);
      const s = createSearchStore(h.deps);
      await s.load();
      const path = s.getDoc("a")?.path as string;
      h.files.set("a.dsx", bytesOf("bad-a"));
      await s.refresh({ reloadPaths: [path] });
      expect(s.getDoc("a")).toBeDefined();
      expect(s.getProgress().failed.map((f) => f.name)).toEqual(["a.dsx"]);
      expect(s.getPhase()).toBe("ready");
    });

    it("an aborted refresh publishes nothing and keeps the phase", async () => {
      const h = harness(["a"]);
      const s = createSearchStore(h.deps);
      await s.load();
      h.names.value.push("b.dsx");
      h.files.set("b.dsx", bytesOf("b"));
      const ctl = new AbortController();
      ctl.abort();
      await s.refresh({ signal: ctl.signal });
      expect(s.getDoc("b")).toBeUndefined();
      expect(s.getPhase()).toBe("ready");
    });

    it("a refresh whose list() fails rejects but keeps the loaded index usable (phase ready)", async () => {
      const h = harness(["a"]);
      let fail = false;
      const deps = { ...h.deps, store: { ...h.deps.store, list: async () => { if (fail) throw new Error("boom"); return [...h.names.value]; } } };
      const s = createSearchStore(deps);
      await s.load();
      fail = true;
      await expect(s.refresh()).rejects.toThrow("boom");
      expect(s.getPhase()).toBe("ready");
      expect(s.getLastError()).toBe("boom");
      expect(s.getDoc("a")).toBeDefined();
    });
  });

  describe("getLastError", () => {
    it("is undefined at first and after a successful load", async () => {
      const s = createSearchStore(harness(["a"]).deps);
      expect(s.getLastError()).toBeUndefined();
      await s.load();
      expect(s.getLastError()).toBeUndefined();
    });

    it("keeps the list() error message", async () => {
      const h = harness();
      const s = createSearchStore({ ...h.deps, store: { ...h.deps.store, list: async () => { throw new Error("boom"); } } });
      await expect(s.load()).rejects.toThrow("boom");
      expect(s.getLastError()).toBe("boom");
    });

    it("keeps the last failure message when every file fails, and clears it on recovery", async () => {
      const h = harness(["bad1", "bad2"]);
      const s = createSearchStore(h.deps);
      await s.load();
      expect(s.getPhase()).toBe("error");
      expect(s.getLastError()).toContain("corrupt bad");
      h.files.set("bad1.dsx", bytesOf("ok"));
      await s.load();
      expect(s.getPhase()).toBe("ready");
      expect(s.getLastError()).toBeUndefined();
    });
  });

  it("hands the decoded typed arrays to the index without copying them", async () => {
    const h = harness(["a"]);
    const decoded = data();
    const s = createSearchStore({ ...h.deps, decode: async () => decoded });
    await s.load();
    expect(s.getIndex().segments[0]?.pages).toBe(decoded.postings.pages);
  });
});

describe("concurrence de décodage (E3)", () => {
  async function maxParallel(concurrency: number | undefined): Promise<number> {
    const h = harness(["a", "b", "c", "d", "e"]);
    let running = 0;
    let peak = 0;
    const inner = h.deps.decode;
    const store = createSearchStore({
      ...h.deps,
      ...(concurrency === undefined ? {} : { decodeConcurrency: concurrency }),
      decode: async (b) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        const out = await inner(b);
        running--;
        return out;
      },
    });
    await store.load();
    return peak;
  }

  it("défaut : 2 décodages en parallèle (bureau inchangé)", async () => {
    expect(await maxParallel(undefined)).toBe(2);
  });

  it("1 : décodage séquentiel", async () => {
    expect(await maxParallel(1)).toBe(1);
  });

  it("valeur invalide (0, NaN, négative) : au moins 1, jamais zéro travailleur", async () => {
    for (const bad of [0, Number.NaN, -3]) expect(await maxParallel(bad)).toBeGreaterThanOrEqual(1);
  });

  it("valeur invalide : avertissement via onWarn (pas de repli silencieux), valeur valide ou absente : aucun", async () => {
    for (const bad of [0, Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const h = harness(["a"]);
      const onWarn = vi.fn();
      createSearchStore({ ...h.deps, onWarn, decodeConcurrency: bad });
      expect(onWarn, String(bad)).toHaveBeenCalledTimes(1);
      expect(String(onWarn.mock.calls[0]?.[0])).toContain("decodeConcurrency");
    }
    for (const good of [undefined, 1, 2, 4]) {
      const h = harness(["a"]);
      const onWarn = vi.fn();
      createSearchStore({ ...h.deps, onWarn, ...(good === undefined ? {} : { decodeConcurrency: good }) });
      expect(onWarn, String(good)).not.toHaveBeenCalled();
    }
  });
});
