import { describe, expect, it } from "vitest";
import { decodeIndex } from "../../../src/core/codec/decode";
import { fingerprint, type PdfEntry } from "../../../src/core/manifest";
import {
  EVENT_MESSAGE_MAX_LENGTH,
  MANIFEST_FILE_NAME,
  createIndexer,
  type IndexerDeps,
  type IndexerEvent,
  type PdfDocumentLike,
} from "../../../src/indexer/indexer";
import type { DiscoveryResult } from "../../../src/siyuan/discovery";

const enc = new TextEncoder();
const dec = new TextDecoder();

function entry(path: string, size = 100, modifiedAt = 1000): PdfEntry {
  return { path, size, modifiedAt };
}
const dsxName = (e: PdfEntry): string => `${fingerprint(e)}.dsx`;

function discovery(entries: PdfEntry[], complete = true): DiscoveryResult {
  return { manifest: entries, issues: [], complete, unsized: [] };
}

class FakeStore {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  removes: string[] = [];
  failWrite: ((name: string) => boolean) | undefined;
  failRead: Error | undefined;
  failRemove = false;
  async read(name: string): Promise<Uint8Array | null> {
    if (this.failRead) throw this.failRead;
    return this.files.get(name) ?? null;
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrite?.(name)) throw new Error(`write failed ${name}`);
    this.writes.push(name);
    this.files.set(name, bytes);
  }
  async remove(name: string): Promise<boolean> {
    if (this.failRemove) throw new Error("remove failed");
    this.removes.push(name);
    return this.files.delete(name);
  }
  manifestPaths(): string[] {
    const raw = this.files.get(MANIFEST_FILE_NAME);
    if (!raw) return [];
    return (JSON.parse(dec.decode(raw)) as { entries: PdfEntry[] }).entries.map((e) => e.path);
  }
}

const TEXT = "alpha beta gamma delta epsilon zeta eta theta";

interface FakePdfOptions {
  pages?: number;
  text?: string;
  failOnPage?: number;
  gate?: () => Promise<void>;
}

class FakePdf implements PdfDocumentLike {
  destroyed = 0;
  readonly numPages: number;
  constructor(private readonly opts: FakePdfOptions = {}) {
    this.numPages = opts.pages ?? 2;
  }
  async getPage(n: number) {
    await this.opts.gate?.();
    if (this.opts.failOnPage === n) throw new Error("boom page");
    return {
      getViewport: () => ({ transform: [1, 0, 0, -1, 0, 100], width: 100, height: 100 }),
      getTextContent: async () => ({
        items: [{ str: this.opts.text ?? TEXT, transform: [10, 0, 0, 10, 5, 50], width: 80, height: 10 }],
      }),
    };
  }
  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

function setup(entries: PdfEntry[], opts: { complete?: boolean; pdfs?: Record<string, FakePdf | Error>; store?: FakeStore } = {}) {
  const store = opts.store ?? new FakeStore();
  const events: IndexerEvent[] = [];
  const pdfs = opts.pdfs ?? {};
  const loaded: string[] = [];
  const deps: IndexerDeps = {
    discover: async () => discovery(entries, opts.complete ?? true),
    store,
    loadPdf: async (path) => {
      loaded.push(path);
      const p = pdfs[path] ?? new FakePdf();
      if (p instanceof Error) throw p;
      return p;
    },
    now: () => 1_700_000_000_000,
  };
  const indexer = createIndexer(deps);
  indexer.onEvent((e) => events.push(e));
  return { store, events, indexer, deps, loaded, pdfs };
}

const types = (events: IndexerEvent[]) => events.map((e) => e.type);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createIndexer - nominal", () => {
  it("indexes two PDFs, writes .dsx files and persists the manifest", async () => {
    const a = entry("assets/a.pdf", 100);
    const b = entry("assets/b.pdf", 200);
    const { store, events, indexer } = setup([a, b]);

    const summary = await indexer.start();

    expect(summary).toEqual({ indexed: 2, skippedScanned: 0, failed: 0, removed: 0, cancelled: false });
    expect([...store.files.keys()].sort()).toEqual([dsxName(a), dsxName(b), MANIFEST_FILE_NAME].sort());
    expect(store.manifestPaths().sort()).toEqual(["assets/a.pdf", "assets/b.pdf"]);
    const doc = await decodeIndex(store.files.get(dsxName(a))!);
    expect(doc.sourcePath).toBe("assets/a.pdf");
    expect(doc.pageTermCounts).toHaveLength(2);
    expect(doc.terms.length).toBeGreaterThan(0);
    expect(events[0]).toEqual({ type: "started" });
    expect(types(events).at(-1)).toBe("idle");
    expect(events.filter((e) => e.type === "indexed")).toEqual(
      expect.arrayContaining([
        { type: "indexed", path: "assets/a.pdf", pages: 2 },
        { type: "indexed", path: "assets/b.pdf", pages: 2 },
      ]),
    );
    expect(events.filter((e) => e.type === "progress" && e.path === "assets/a.pdf")).toEqual([
      { type: "progress", path: "assets/a.pdf", page: 1, total: 2 },
      { type: "progress", path: "assets/a.pdf", page: 2, total: 2 },
    ]);
    expect(indexer.getState().status).toBe("idle");
  });

  it("does nothing for unchanged PDFs on the second run", async () => {
    const a = entry("assets/a.pdf");
    const { store, indexer, loaded } = setup([a]);
    await indexer.start();
    loaded.length = 0;
    const summary = await indexer.start();
    expect(loaded).toEqual([]);
    expect(summary.indexed).toBe(0);
    expect(store.writes.filter((w) => w.endsWith(".dsx"))).toHaveLength(1);
  });

  it("returns the same promise when start is called while running", async () => {
    const { indexer } = setup([entry("assets/a.pdf")]);
    const p1 = indexer.start();
    const p2 = indexer.start();
    expect(p2).toBe(p1);
    await p1;
  });

  it("replaces the old .dsx when a modified PDF changes fingerprint", async () => {
    const old = entry("assets/a.pdf", 100, 1);
    const store = new FakeStore();
    const first = setup([old], { store });
    await first.indexer.start();
    const fresh = entry("assets/a.pdf", 150, 2);
    const second = setup([fresh], { store });
    await second.indexer.start();
    expect(store.files.has(dsxName(fresh))).toBe(true);
    expect(store.files.has(dsxName(old))).toBe(false);
  });

  it("tolerates a failing cleanup of the old .dsx", async () => {
    const old = entry("assets/a.pdf", 100, 1);
    const store = new FakeStore();
    await setup([old], { store }).indexer.start();
    store.failRemove = true;
    const second = setup([entry("assets/a.pdf", 150, 2)], { store });
    const summary = await second.indexer.start();
    expect(summary.indexed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("ignores non-text items (marked content) and the sync get of numPages 0", async () => {
    const empty = new FakePdf({ pages: 0 });
    const { indexer, events } = setup([entry("assets/a.pdf")], { pdfs: { "assets/a.pdf": empty } });
    await indexer.start();
    // zero pages => no text => treated as scanned
    expect(types(events)).toContain("skipped-scanned");
    expect(empty.destroyed).toBe(1);
  });
});

describe("createIndexer - scanned PDFs", () => {
  it("emits skipped-scanned, writes no index, and does not retry unchanged scanned PDFs", async () => {
    const a = entry("assets/scan.pdf");
    const pdf = new FakePdf({ text: "x" });
    const { store, events, indexer, loaded } = setup([a], { pdfs: { [a.path]: pdf } });

    const summary = await indexer.start();

    expect(events).toContainEqual({ type: "skipped-scanned", path: a.path });
    expect(types(events)).not.toContain("indexed");
    expect(store.files.has(dsxName(a))).toBe(false);
    expect(summary.skippedScanned).toBe(1);
    expect(pdf.destroyed).toBe(1);
    loaded.length = 0;
    await indexer.start();
    expect(loaded).toEqual([]);
  });

  it("removes a stale .dsx when a previously indexed PDF is now scanned", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await setup([a], { store }).indexer.start();
    expect(store.files.has(dsxName(a))).toBe(true);
    const second = setup([a], { store, pdfs: { [a.path]: new FakePdf({ text: "x" }) } });
    await second.indexer.reindex(a.path);
    expect(store.files.has(dsxName(a))).toBe(false);
  });
});

describe("createIndexer - failures", () => {
  it("isolates a failing PDF and still indexes the other, retrying the failed one next time", async () => {
    const bad = entry("assets/bad.pdf");
    const good = entry("assets/good.pdf", 300);
    const pdf = new FakePdf({ failOnPage: 2 });
    const { store, events, indexer, pdfs } = setup([bad, good], { pdfs: { [bad.path]: pdf } });

    const summary = await indexer.start();

    expect(summary).toMatchObject({ indexed: 1, failed: 1 });
    expect(events).toContainEqual({ type: "failed", path: bad.path, message: "boom page" });
    expect(store.files.has(dsxName(good))).toBe(true);
    expect(store.files.has(dsxName(bad))).toBe(false);
    expect(store.manifestPaths()).toEqual([good.path]);
    expect(pdf.destroyed).toBe(1);

    pdfs[bad.path] = new FakePdf();
    const retry = await indexer.start();
    expect(retry.indexed).toBe(1);
    expect(store.manifestPaths().sort()).toEqual([bad.path, good.path]);
  });

  it("handles loadPdf rejection (nothing to destroy) and truncates long messages", async () => {
    const a = entry("assets/a.pdf");
    const { events, indexer } = setup([a], { pdfs: { [a.path]: new Error("x".repeat(500)) } });
    await indexer.start();
    const failed = events.find((e) => e.type === "failed");
    expect(failed).toMatchObject({ type: "failed", path: a.path });
    expect((failed as { message: string }).message).toHaveLength(EVENT_MESSAGE_MAX_LENGTH);
  });

  it("formats non-Error rejections", async () => {
    const a = entry("assets/a.pdf");
    const { events, indexer, deps } = setup([a]);
    const loadPdf = deps.loadPdf;
    void loadPdf;
    const idx = createIndexer({ ...deps, loadPdf: () => Promise.reject("plain string") });
    idx.onEvent((e) => events.push(e));
    await idx.start();
    expect(events).toContainEqual({ type: "failed", path: a.path, message: "plain string" });
  });

  it("does not record the PDF when store.write fails, and destroys the document", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.failWrite = (n) => n.endsWith(".dsx");
    const pdf = new FakePdf();
    const { events, indexer } = setup([a], { store, pdfs: { [a.path]: pdf } });
    const summary = await indexer.start();
    expect(summary.failed).toBe(1);
    expect(types(events)).not.toContain("indexed");
    expect(store.manifestPaths()).toEqual([]);
    expect(pdf.destroyed).toBe(1);
  });

  it("fails the PDF (and keeps it out of the manifest) when the manifest write fails", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.failWrite = (n) => n === MANIFEST_FILE_NAME;
    const { events, indexer } = setup([a], { store });
    const summary = await indexer.start();
    expect(summary.failed).toBe(1);
    expect(events.find((e) => e.type === "failed")).toMatchObject({ path: a.path });
  });

  it("swallows a destroy() failure", async () => {
    const a = entry("assets/a.pdf");
    const pdf = new FakePdf();
    pdf.destroy = async () => {
      throw new Error("destroy boom");
    };
    const { indexer } = setup([a], { pdfs: { [a.path]: pdf } });
    expect((await indexer.start()).indexed).toBe(1);
  });

  it("reports a discovery failure as a failed event then idle", async () => {
    const store = new FakeStore();
    const indexer = createIndexer({
      discover: async () => {
        throw new Error("root unreadable");
      },
      store,
      loadPdf: async () => new FakePdf(),
      now: () => 0,
    });
    const events: IndexerEvent[] = [];
    indexer.onEvent((e) => events.push(e));
    const summary = await indexer.start();
    expect(summary.failed).toBe(1);
    expect(events.find((e) => e.type === "failed")).toMatchObject({ message: "root unreadable" });
    expect(types(events).at(-1)).toBe("idle");
    expect(store.writes).toEqual([]);
  });

  it("aborts the run (no removal, no write) when the manifest cannot be read", async () => {
    const store = new FakeStore();
    store.failRead = new Error("io");
    const { events, indexer } = setup([entry("assets/a.pdf")], { store });
    const summary = await indexer.start();
    expect(summary.failed).toBe(1);
    expect(store.writes).toEqual([]);
    expect(store.removes).toEqual([]);
    expect(events.find((e) => e.type === "failed")).toMatchObject({ path: MANIFEST_FILE_NAME });
  });
});

describe("createIndexer - removals", () => {
  async function seeded(): Promise<{ store: FakeStore; a: PdfEntry; b: PdfEntry }> {
    const a = entry("assets/a.pdf", 100);
    const b = entry("assets/b.pdf", 200);
    const store = new FakeStore();
    await setup([a, b], { store }).indexer.start();
    return { store, a, b };
  }

  it("removes the .dsx of a PDF that disappeared when removals are allowed", async () => {
    const { store, a, b } = await seeded();
    const { events, indexer } = setup([a], { store });
    const summary = await indexer.start();
    expect(summary.removed).toBe(1);
    expect(events).toContainEqual({ type: "removed", path: b.path });
    expect(store.files.has(dsxName(b))).toBe(false);
    expect(store.files.has(dsxName(a))).toBe(true);
    expect(store.manifestPaths()).toEqual([a.path]);
  });

  it("never removes anything when the discovery is incomplete", async () => {
    const { store, a, b } = await seeded();
    const { events, indexer } = setup([a], { store, complete: false });
    const summary = await indexer.start();
    expect(summary.removed).toBe(0);
    expect(types(events)).not.toContain("removed");
    expect(store.files.has(dsxName(b))).toBe(true);
    expect(store.manifestPaths().sort()).toEqual([a.path, b.path]);
  });

  it("keeps the manifest entry and reports failure when removal fails", async () => {
    const { store, a, b } = await seeded();
    store.failRemove = true;
    const { events, indexer } = setup([a], { store });
    const summary = await indexer.start();
    expect(summary).toMatchObject({ removed: 0, failed: 1 });
    expect(events.find((e) => e.type === "failed")).toMatchObject({ path: b.path });
    expect(store.manifestPaths().sort()).toEqual([a.path, b.path]);
  });
});

describe("createIndexer - corrupt manifest", () => {
  it.each([
    ["not json", "{{{"],
    ["wrong shape", JSON.stringify({ version: 1, entries: "nope" })],
    ["wrong version", JSON.stringify({ version: 99, entries: [] })],
    ["bad entry", JSON.stringify({ version: 1, entries: [{ path: "a.pdf", size: -1, modifiedAt: 1 }] })],
    ["duplicate paths", JSON.stringify({ version: 1, entries: [entry("a.pdf"), entry("a.pdf")] })],
    ["null", "null"],
    ["entry not an object", JSON.stringify({ version: 1, entries: [null] })],
  ])("starts from scratch without deleting any index (%s)", async (_label, content) => {
    const orphan = entry("assets/orphan.pdf");
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.files.set(dsxName(orphan), new Uint8Array([1]));
    store.files.set(MANIFEST_FILE_NAME, enc.encode(content));
    const { indexer } = setup([a], { store });
    const summary = await indexer.start();
    expect(summary.indexed).toBe(1);
    expect(store.removes).toEqual([]);
    expect(store.files.has(dsxName(orphan))).toBe(true);
    expect(store.manifestPaths()).toEqual([a.path]);
  });

  it("starts from scratch on invalid UTF-8 bytes", async () => {
    const store = new FakeStore();
    store.files.set(MANIFEST_FILE_NAME, new Uint8Array([0xff, 0xfe, 0xfd]));
    const { indexer } = setup([entry("assets/a.pdf")], { store });
    expect((await indexer.start()).indexed).toBe(1);
  });
});

describe("createIndexer - cancellation (risk 4)", () => {
  it("never writes to the store once cancelled, even if the abandoned job completes", async () => {
    const a = entry("assets/a.pdf");
    const gate = deferred();
    const pdf = new FakePdf({ gate: () => gate.promise });
    const { store, events, indexer } = setup([a], { pdfs: { [a.path]: pdf } });

    const run = indexer.start();
    await new Promise((r) => setTimeout(r, 0));
    indexer.cancel();
    const writesAtCancel = store.writes.length;
    gate.resolve();
    const summary = await run;

    expect(summary.cancelled).toBe(true);
    expect(store.writes.length).toBe(writesAtCancel);
    expect(store.files.has(dsxName(a))).toBe(false);
    expect(store.files.has(MANIFEST_FILE_NAME)).toBe(false);
    expect(types(events)).not.toContain("indexed");
    expect(types(events)).not.toContain("failed");
    expect(pdf.destroyed).toBe(1);
    expect(types(events).at(-1)).toBe("idle");
  });

  it("does not write when cancelled right after the last page was extracted", async () => {
    const a = entry("assets/a.pdf");
    const { store, indexer } = setup([a]);
    indexer.onEvent((e) => {
      if (e.type === "progress" && e.page === e.total) indexer.cancel();
    });
    const summary = await indexer.start();
    expect(summary.cancelled).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it("does not update the manifest if cancelled between the .dsx write and the manifest write", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const realWrite = store.write.bind(store);
    let cancelHook = (): void => undefined;
    store.write = async (name, bytes) => {
      await realWrite(name, bytes);
      if (name.endsWith(".dsx")) cancelHook();
    };
    const { indexer } = setup([a], { store });
    cancelHook = () => indexer.cancel();
    const summary = await indexer.start();
    expect(summary.cancelled).toBe(true);
    expect(store.writes).toEqual([dsxName(a)]);
    expect(store.files.has(MANIFEST_FILE_NAME)).toBe(false);
  });

  it("cancel after pause drops pending jobs and finishes", async () => {
    const entries = [entry("assets/a.pdf", 1), entry("assets/b.pdf", 2), entry("assets/c.pdf", 3), entry("assets/d.pdf", 4)];
    const gate = deferred();
    const pdfs: Record<string, FakePdf> = {};
    for (const e of entries) pdfs[e.path] = new FakePdf({ gate: () => gate.promise });
    const { store, indexer, loaded } = setup(entries, { pdfs });

    const run = indexer.start();
    await new Promise((r) => setTimeout(r, 0));
    indexer.pause();
    expect(indexer.getState().status).toBe("paused");
    indexer.cancel();
    gate.resolve();
    const summary = await run;

    expect(summary.cancelled).toBe(true);
    expect(loaded.length).toBeLessThanOrEqual(2);
    expect(store.writes).toEqual([]);
  });

  it("cancel during discovery stops before any work", async () => {
    const gate = deferred();
    const store = new FakeStore();
    const indexer = createIndexer({
      discover: async () => {
        await gate.promise;
        return discovery([entry("assets/a.pdf")]);
      },
      store,
      loadPdf: async () => new FakePdf(),
      now: () => 0,
    });
    const run = indexer.start();
    await new Promise((r) => setTimeout(r, 0));
    indexer.cancel();
    gate.resolve();
    const summary = await run;
    expect(summary).toMatchObject({ cancelled: true, indexed: 0 });
    expect(store.writes).toEqual([]);
  });

  it("cancel without a run is a no-op", () => {
    const { indexer } = setup([]);
    expect(() => indexer.cancel()).not.toThrow();
  });

  it("does not remove files when cancelled before the removal phase", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf", 2);
    const store = new FakeStore();
    await setup([a, b], { store }).indexer.start();
    store.removes.length = 0;
    const gate = deferred();
    const indexer = createIndexer({
      discover: async () => {
        await gate.promise;
        return discovery([a]);
      },
      store,
      loadPdf: async () => new FakePdf(),
      now: () => 0,
    });
    const run = indexer.start();
    await new Promise((r) => setTimeout(r, 0));
    indexer.cancel();
    gate.resolve();
    await run;
    expect(store.removes).toEqual([]);
  });
});

describe("createIndexer - pause / resume", () => {
  it("does not start jobs while paused and resumes them", async () => {
    const a = entry("assets/a.pdf");
    const { store, indexer, loaded } = setup([a]);
    indexer.pause();
    const run = indexer.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(loaded).toEqual([]);
    expect(indexer.getState().status).toBe("paused");
    indexer.resume();
    const summary = await run;
    expect(summary.indexed).toBe(1);
    expect(store.files.has(dsxName(a))).toBe(true);
    expect(indexer.getState().paused).toBe(false);
  });
});

describe("createIndexer - reindex", () => {
  it("reindex(path) reprocesses only that PDF even if unchanged", async () => {
    const a = entry("assets/a.pdf", 1);
    const b = entry("assets/b.pdf", 2);
    const { indexer, loaded } = setup([a, b]);
    await indexer.start();
    loaded.length = 0;
    const summary = await indexer.reindex(b.path);
    expect(loaded).toEqual([b.path]);
    expect(summary.indexed).toBe(1);
  });

  it("reindex() reprocesses everything", async () => {
    const a = entry("assets/a.pdf", 1);
    const b = entry("assets/b.pdf", 2);
    const { indexer, loaded } = setup([a, b]);
    await indexer.start();
    loaded.length = 0;
    const summary = await indexer.reindex();
    expect(loaded.sort()).toEqual([a.path, b.path]);
    expect(summary.indexed).toBe(2);
  });

  it("reindex while running waits for the current run then runs", async () => {
    const a = entry("assets/a.pdf");
    const { indexer, loaded } = setup([a]);
    const first = indexer.start();
    const second = indexer.reindex(a.path);
    await first;
    const summary = await second;
    expect(loaded).toEqual([a.path, a.path]);
    expect(summary.indexed).toBe(1);
  });
});

describe("createIndexer - listeners", () => {
  it("isolates a throwing listener and keeps notifying the others", async () => {
    const errors: unknown[] = [];
    const store = new FakeStore();
    const indexer = createIndexer({
      discover: async () => discovery([entry("assets/a.pdf")]),
      store,
      loadPdf: async () => new FakePdf(),
      now: () => 0,
      onListenerError: (e) => errors.push(e),
    });
    const received: IndexerEvent[] = [];
    indexer.onEvent(() => {
      throw new Error("listener boom");
    });
    indexer.onEvent((e) => received.push(e));
    const summary = await indexer.start();
    expect(summary.indexed).toBe(1);
    expect(types(received).at(-1)).toBe("idle");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("swallows listener errors silently without onListenerError and supports unsubscribe", async () => {
    const { indexer } = setup([entry("assets/a.pdf")]);
    indexer.onEvent(() => {
      throw new Error("x");
    });
    const seen: IndexerEvent[] = [];
    const off = indexer.onEvent((e) => seen.push(e));
    off();
    await indexer.start();
    expect(seen).toEqual([]);
  });
});
