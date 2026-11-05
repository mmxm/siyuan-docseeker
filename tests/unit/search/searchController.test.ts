import { describe, expect, it, vi } from "vitest";
import { buildIndex, MAX_EXPANDED_PAGES, type Bm25Index } from "../../../src/core/bm25";
import {
  RERANK_GRACE_MS,
  createSearchController,
  type RerankPort,
  type DocInfo,
  type LoadPhase,
  type LoadProgress,
  type SearchSource,
  type SearchViewModel,
} from "../../../src/search/searchController";

class FakeClock {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  schedule = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.tasks]) {
      if (t.at <= this.now) {
        this.tasks.delete(id);
        t.fn();
      }
    }
  }
  get pending(): number {
    return this.tasks.size;
  }
}

function doc(docId: string, title = docId): DocInfo {
  return { docId, path: `/data/${docId}.pdf`, title, pageCount: 3, pdfSize: 10, pdfModifiedMs: 1 };
}

class FakeSource implements SearchSource {
  index: Bm25Index;
  docs: DocInfo[];
  progress: LoadProgress = { loaded: 0, total: 0, failed: [] };
  phase: LoadPhase = "ready";
  lastError: string | undefined;
  private listeners = new Set<() => void>();
  constructor(pages: { docId: string; page: number; text: string }[], docs: DocInfo[]) {
    this.index = buildIndex(pages);
    this.docs = docs;
  }
  getIndex = () => this.index;
  getDoc = (id: string) => this.docs.find((d) => d.docId === id);
  listDocs = () => this.docs;
  getProgress = () => this.progress;
  getPhase = () => this.phase;
  getLastError = () => this.lastError;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  emit(): void {
    for (const l of [...this.listeners]) l();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

const PAGES = [
  { docId: "a", page: 1, text: "gradient descent method" },
  { docId: "a", page: 2, text: "gradient again" },
  { docId: "b", page: 1, text: "gradient boosting" },
];

function setup(source = new FakeSource(PAGES, [doc("a", "Alpha"), doc("b", "Beta")])) {
  const clock = new FakeClock();
  const seen: SearchViewModel[] = [];
  const onWarn = vi.fn();
  const controller = createSearchController({
    source,
    schedule: clock.schedule,
    clear: clock.clear,
    onChange: (vm) => seen.push(vm),
    onWarn,
  });
  return { source, clock, seen, controller, onWarn };
}

describe("createSearchController", () => {
  it("starts with an empty-query view model", () => {
    const { controller } = setup();
    expect(controller.getViewModel()).toEqual({ kind: "empty-query" });
  });

  it("debounces: nothing runs before 200 ms, one search after", () => {
    const { controller, clock, seen } = setup();
    controller.setQuery("grad");
    clock.advance(199);
    expect(seen).toHaveLength(0);
    clock.advance(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("results");
  });

  it("keeps only the latest query when typing fast", () => {
    const { controller, clock, seen } = setup();
    controller.setQuery("boost");
    clock.advance(100);
    controller.setQuery("descent");
    clock.advance(199);
    expect(seen).toHaveLength(0);
    clock.advance(1);
    expect(seen).toHaveLength(1);
    const vm = seen[0];
    expect(vm?.kind === "results" && vm.query).toBe("descent");
    expect(vm?.kind === "results" && vm.docs.map((d) => d.docId)).toEqual(["a"]);
  });

  it("joins DocInfo and returns ranked pages", () => {
    const { controller, clock } = setup();
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    if (vm.kind !== "results") throw new Error("expected results");
    expect(vm.total).toBe(2);
    const a = vm.docs.find((d) => d.docId === "a");
    expect(a).toMatchObject({ title: "Alpha", path: "/data/a.pdf", matchingPages: 2 });
    expect(a?.pages.map((p) => p.page).sort()).toEqual([1, 2]);
    expect(a?.relevance).toBeGreaterThan(0);
    expect(vm.partial).toBe(false);
  });

  it("transmits the full page list (capped) so the view can expand it", () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ docId: "a", page: i + 1, text: "gradient" }));
    const { controller, clock } = setup(new FakeSource(pages, [doc("a", "Alpha")]));
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    if (vm.kind !== "results") throw new Error("expected results");
    expect(vm.docs[0]?.matchingPages).toBe(12);
    expect(vm.docs[0]?.pages).toHaveLength(12);
  });

  it("caps the transmitted page list at MAX_EXPANDED_PAGES while keeping the real matchingPages", () => {
    const pages = Array.from({ length: MAX_EXPANDED_PAGES + 30 }, (_, i) => ({ docId: "a", page: i + 1, text: "gradient" }));
    const { controller, clock } = setup(new FakeSource(pages, [doc("a", "Alpha")]));
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    if (vm.kind !== "results") throw new Error("expected results");
    expect(vm.docs[0]?.matchingPages).toBe(MAX_EXPANDED_PAGES + 30);
    expect(vm.docs[0]?.pages).toHaveLength(MAX_EXPANDED_PAGES);
  });

  it("applies title bonuses", () => {
    const source = new FakeSource(
      [
        { docId: "a", page: 1, text: "gradient gradient gradient" },
        { docId: "b", page: 1, text: "gradient" },
      ],
      [doc("a", "Other"), doc("b", "Gradient")],
    );
    const { controller, clock } = setup(source);
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    expect(vm.kind === "results" && vm.docs[0]?.docId).toBe("b");
  });

  it("returns no-result with the query", () => {
    const { controller, clock } = setup();
    controller.setQuery("zzzz");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "no-result", query: "zzzz", partial: false, failedCount: 0 });
  });

  it("returns empty-query for blank or non-searchable input, immediately and cancelling pending work", () => {
    const { controller, clock, seen } = setup();
    controller.setQuery("grad");
    controller.setQuery("   ");
    expect(controller.getViewModel()).toEqual({ kind: "empty-query" });
    expect(clock.pending).toBe(0);
    clock.advance(1000);
    expect(seen.at(-1)).toEqual({ kind: "empty-query" });
    expect(seen.every((vm) => vm.kind === "empty-query")).toBe(true);
  });

  it("returns no-index (not indexing) when the index is empty and idle", () => {
    const source = new FakeSource([], []);
    source.phase = "idle";
    const { controller, clock } = setup(source);
    controller.setQuery("abc");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "no-index", indexing: false });
  });

  it("returns no-index with indexing=true when loading with nothing to load yet", () => {
    const source = new FakeSource([], []);
    source.phase = "loading";
    const { controller, clock } = setup(source);
    controller.setQuery("abc");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "no-index", indexing: true });
  });

  it("returns loading with progress when the index is empty while loading", () => {
    const source = new FakeSource([], []);
    source.phase = "loading";
    source.progress = { loaded: 1, total: 4, failed: [] };
    const { controller, clock } = setup(source);
    controller.setQuery("abc");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "loading", progress: source.progress });
  });

  it("marks results partial while loading", () => {
    const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
    source.phase = "loading";
    source.progress = { loaded: 1, total: 3, failed: [] };
    const { controller, clock } = setup(source);
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    expect(vm.kind === "results" && vm.partial).toBe(true);
    controller.setQuery("zzz");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "no-result", query: "zzz", partial: true, failedCount: 0 });
  });

  it("re-runs the current query when the source notifies", () => {
    const { controller, clock, source, seen } = setup();
    controller.setQuery("gradient");
    clock.advance(200);
    const before = seen.length;
    source.index = buildIndex([...PAGES, { docId: "c", page: 1, text: "gradient new" }]);
    source.docs = [...source.docs, doc("c", "Gamma")];
    source.emit();
    const vm = controller.getViewModel();
    expect(seen.length).toBeGreaterThan(before);
    expect(vm.kind === "results" && vm.total).toBe(3);
  });

  it("does not emit on source notification when no query is set", () => {
    const { source, seen } = setup();
    source.emit();
    expect(seen).toHaveLength(0);
  });

  it("ignores hits whose docId is missing from the catalog", () => {
    const source = new FakeSource(PAGES, [doc("a", "Alpha")]);
    const { controller, clock } = setup(source);
    controller.setQuery("gradient");
    clock.advance(200);
    const vm = controller.getViewModel();
    expect(vm.kind === "results" && vm.docs.map((d) => d.docId)).toEqual(["a"]);
  });

  it("gives no-result when every hit is outside the catalog", () => {
    const source = new FakeSource(PAGES, [doc("zzz")]);
    const { controller, clock } = setup(source);
    controller.setQuery("gradient");
    clock.advance(200);
    expect(controller.getViewModel().kind).toBe("no-result");
  });

  it("turns an exception into an error view model", () => {
    const { controller, clock, source } = setup();
    source.getIndex = () => {
      throw new Error("boom");
    };
    controller.setQuery("gradient");
    expect(() => clock.advance(200)).not.toThrow();
    expect(controller.getViewModel()).toEqual({ kind: "error", message: "boom" });
  });

  it("stringifies non-Error exceptions", () => {
    const { controller, clock, source } = setup();
    source.getIndex = () => {
      throw "plain";
    };
    controller.setQuery("gradient");
    clock.advance(200);
    expect(controller.getViewModel()).toEqual({ kind: "error", message: "plain" });
  });

  it("recovers from an error on the next query", () => {
    const { controller, clock, source } = setup();
    const good = source.getIndex;
    source.getIndex = () => {
      throw new Error("boom");
    };
    controller.setQuery("gradient");
    clock.advance(200);
    source.getIndex = good;
    controller.setQuery("boost");
    clock.advance(200);
    expect(controller.getViewModel().kind).toBe("results");
  });

  it("honours a custom debounce", () => {
    const clock = new FakeClock();
    const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
    const onChange = vi.fn();
    const c = createSearchController({ source, schedule: clock.schedule, clear: clock.clear, debounceMs: 50, onChange });
    c.setQuery("gradient");
    clock.advance(50);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels pending work, unsubscribes and silences later calls", () => {
    const { controller, clock, source, seen } = setup();
    controller.setQuery("gradient");
    controller.dispose();
    expect(clock.pending).toBe(0);
    expect(source.listenerCount).toBe(0);
    clock.advance(1000);
    controller.setQuery("boost");
    clock.advance(1000);
    source.emit();
    expect(seen).toHaveLength(0);
    expect(() => controller.dispose()).not.toThrow();
  });

  describe("phase error, failedCount, coalescing, onWarn", () => {
    it("produces an error view when the source phase is error, with the last known cause", () => {
      const source = new FakeSource([], []);
      source.phase = "error";
      source.lastError = "list failed";
      const { controller, clock } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      expect(controller.getViewModel()).toEqual({ kind: "error", message: "list failed" });
    });

    it("uses a generic message when the error cause is unknown", () => {
      const source = new FakeSource([], []);
      source.phase = "error";
      const { controller, clock } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      const vm = controller.getViewModel();
      expect(vm.kind === "error" && vm.message.length > 0).toBe(true);
    });

    it("exposes failedCount in results and no-result", () => {
      const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
      source.progress = { loaded: 2, total: 4, failed: [{ name: "x.dsx", message: "m" }, { name: "y.dsx", message: "m" }] };
      const { controller, clock } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      const vm = controller.getViewModel();
      expect(vm.kind === "results" && vm.failedCount).toBe(2);
      controller.setQuery("zzz");
      clock.advance(200);
      const none = controller.getViewModel();
      expect(none.kind === "no-result" && none.failedCount).toBe(2);
    });

    it("coalesces store notifications during loading into one search per window", () => {
      const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
      const { controller, clock, seen } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      source.phase = "loading";
      source.progress = { loaded: 1, total: 50, failed: [] };
      const before = seen.length;
      const spy = vi.spyOn(source, "getIndex");
      for (let i = 0; i < 40; i++) source.emit();
      expect(seen.length).toBe(before);
      expect(spy).not.toHaveBeenCalled();
      clock.advance(149);
      expect(seen.length).toBe(before);
      clock.advance(1);
      expect(seen.length).toBe(before + 1);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("runs immediately when the store leaves loading, cancelling the coalescing timer", () => {
      const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
      const { controller, clock, seen } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      source.phase = "loading";
      source.emit();
      const before = seen.length;
      source.phase = "ready";
      source.emit();
      expect(seen.length).toBe(before + 1);
      expect(clock.pending).toBe(0);
      const vm = controller.getViewModel();
      expect(vm.kind === "results" && vm.partial).toBe(false);
    });

    it("does not search on a notification while the debounce of a new query is pending", () => {
      const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
      const { controller, clock, seen } = setup(source);
      controller.setQuery("gradient");
      const spy = vi.spyOn(source, "getIndex");
      source.emit();
      expect(spy).not.toHaveBeenCalled();
      clock.advance(200);
      expect(seen).toHaveLength(1);
    });

    it("calls onWarn with the full error when run() fails", () => {
      const { controller, clock, source, onWarn } = setup();
      const boom = new Error("boom");
      source.getIndex = () => {
        throw boom;
      };
      controller.setQuery("gradient");
      clock.advance(200);
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("search"), boom);
    });

    it("dispose cancels the coalescing timer", () => {
      const source = new FakeSource(PAGES, [doc("a"), doc("b")]);
      const { controller, clock, seen } = setup(source);
      controller.setQuery("gradient");
      clock.advance(200);
      source.phase = "loading";
      source.emit();
      controller.dispose();
      expect(clock.pending).toBe(0);
      clock.advance(1000);
      expect(seen).toHaveLength(1);
    });
  });
});

// ---- Re-classement par proximité (jalon 6, phase 1) ----

const RR_PAGES = [
  { docId: "a", page: 1, text: "alpha beta gamma" },
  { docId: "a", page: 2, text: "alpha beta" },
  { docId: "a", page: 3, text: "alpha" },
  { docId: "b", page: 1, text: "alpha beta" },
  { docId: "c", page: 1, text: "alpha beta" },
];
const RR_DOCS = [doc("a", "Alpha"), doc("b", "Beta"), doc("c", "Gamma")];
const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type RankResult = Awaited<ReturnType<RerankPort["rank"]>>;
interface Call {
  query: string;
  docs: readonly { docId: string }[];
  signal: AbortSignal | undefined;
  onWindow: ((r: unknown) => void) | undefined;
  resolve: (r: RankResult) => void;
  reject: (e: unknown) => void;
}

function rerankSetup(opts: { phase?: LoadPhase } = {}) {
  const source = new FakeSource(RR_PAGES, RR_DOCS);
  if (opts.phase) source.phase = opts.phase;
  const calls: Call[] = [];
  const rerank: RerankPort = {
    rank: ((query: string, docs: readonly { docId: string }[], o: { signal?: AbortSignal; onWindow?: (r: unknown) => void }) =>
      new Promise((resolve, reject) => {
        calls.push({ query, docs, signal: o.signal, onWindow: o.onWindow, resolve: resolve as Call["resolve"], reject });
      })) as unknown as RerankPort["rank"],
  };
  const clock = new FakeClock();
  const seen: SearchViewModel[] = [];
  const onWarn = vi.fn();
  const controller = createSearchController({
    source, schedule: clock.schedule, clear: clock.clear, onChange: (vm) => seen.push(vm), onWarn, rerank,
  });
  return { source, clock, seen, controller, onWarn, calls };
}

/** Ordre BM25 de référence (sans re-classement). */
function bm25Order(query: string): string[] {
  const { controller, clock } = setup(new FakeSource(RR_PAGES, RR_DOCS));
  controller.setQuery(query);
  clock.advance(200);
  const vm = controller.getViewModel();
  if (vm.kind !== "results") throw new Error("expected results");
  return vm.docs.map((d) => d.docId);
}

const resultOf = (vm: SearchViewModel) => {
  if (vm.kind !== "results") throw new Error(`expected results, got ${vm.kind}`);
  return vm;
};

/** Résultat de ranker factice : documents inversés ; pages du premier document inversées. */
function reversed(docs: readonly { docId: string; pages: readonly { page: number }[] }[]): RankResult {
  const out = [...docs].reverse();
  const first = docs[0]!;
  return {
    docs: out,
    pagesOrderByDoc: new Map([[first.docId, first.pages.map((p) => p.page).slice(0, 5).reverse()]]),
    bonusByDoc: new Map(docs.map((d) => [d.docId, 0])),
    failedDocIds: new Set<string>(),
    done: Promise.resolve(),
  } as unknown as RankResult;
}

describe("searchController : re-classement par proximité", () => {
  it("expose la constante de grâce nommée (300 ms)", () => {
    expect(RERANK_GRACE_MS).toBe(300);
  });

  it("requête à un mot : chemin inchangé, aucun appel, ranking bm25 publié tout de suite", () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha");
    clock.advance(200);
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(resultOf(seen[0]!).ranking).toBe("bm25");
  });

  it("requête à deux mots : un appel avec signal et onWindow, rien publié avant la fenêtre 1 ou la grâce", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    await flushMicro();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe("alpha beta");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(typeof calls[0]!.onWindow).toBe("function");
    expect(seen).toHaveLength(0);
  });

  it("fenêtre 1 prête dans le délai de grâce : publie directement l'ordre re-classé (docs et 5 premières pages)", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    const base = bm25Order("alpha beta");
    controller.setQuery("alpha beta");
    clock.advance(200);
    clock.advance(RERANK_GRACE_MS - 1);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    calls[0]!.resolve(reversed(docs));
    await flushMicro();
    expect(seen).toHaveLength(1);
    const vm = resultOf(seen[0]!);
    expect(vm.ranking).toBe("proximity");
    expect(vm.docs.map((d) => d.docId)).toEqual([...base].reverse());
    const first = vm.docs.find((d) => d.docId === docs[0]!.docId)!;
    expect(first.pages.map((p) => p.page)).toEqual(docs[0]!.pages.map((p) => p.page).reverse());
    // La minuterie de grâce a été annulée : rien d'autre ne sera publié.
    clock.advance(1000);
    expect(seen).toHaveLength(1);
  });

  it("grâce dépassée : publie BM25 puis applique l'ordre de la fenêtre 1 une seule fois", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    const base = bm25Order("alpha beta");
    controller.setQuery("alpha beta");
    clock.advance(200);
    clock.advance(RERANK_GRACE_MS);
    expect(seen).toHaveLength(1);
    expect(resultOf(seen[0]!).ranking).toBe("bm25");
    expect(resultOf(seen[0]!).docs.map((d) => d.docId)).toEqual(base);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    expect(seen).toHaveLength(2);
    expect(resultOf(seen[1]!).ranking).toBe("proximity");
    expect(resultOf(seen[1]!).docs.map((d) => d.docId)).toEqual([...base].reverse());
    clock.advance(5000);
    await flushMicro();
    expect(seen).toHaveLength(2);
  });

  it("fenêtres suivantes (onWindow) appliquées au fur et à mesure, après la fenêtre 1", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    calls[0]!.resolve(reversed(docs));
    await flushMicro();
    expect(seen).toHaveLength(1);
    const next = { ...reversed(docs), docs: [...docs].reverse() };
    calls[0]!.onWindow!(next as never);
    expect(seen).toHaveLength(2);
    expect(resultOf(seen[1]!).docs.map((d) => d.docId)).toEqual([...docs].reverse().map((d) => d.docId));
    expect(resultOf(seen[1]!).ranking).toBe("proximity");
  });

  it("onWindow arrivé avant la prise en compte de la fenêtre 1 : le plus récent l'emporte, sans double publication", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    const later = reversed(docs);
    calls[0]!.onWindow!(later as never);
    expect(seen).toHaveLength(0);
    calls[0]!.resolve({ ...later, docs: [...docs], pagesOrderByDoc: new Map() } as unknown as RankResult); // fenêtre 1 plus ancienne
    await flushMicro();
    expect(seen).toHaveLength(1);
    expect(resultOf(seen[0]!).docs.map((d) => d.docId)).toEqual([...docs].reverse().map((d) => d.docId));
  });

  it("les pages au-delà de l'ordre fourni restent en ordre BM25", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    const a = docs.find((d) => d.docId === "a")!;
    const original = a.pages.map((p) => p.page);
    calls[0]!.resolve({
      docs, pagesOrderByDoc: new Map([["a", [original[1]!]]]), bonusByDoc: new Map([["a", 0]]),
      failedDocIds: new Set<string>(), done: Promise.resolve(),
    } as unknown as RankResult);
    await flushMicro();
    const got = resultOf(seen[0]!).docs.find((d) => d.docId === "a")!.pages.map((p) => p.page);
    expect(got).toEqual([original[1], ...original.filter((p) => p !== original[1])]);
  });

  it("nouvelle requête : l'exécution précédente est annulée et sa résolution tardive ignorée", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const first = calls[0]!;
    controller.setQuery("alpha");
    expect(first.signal!.aborted).toBe(true);
    clock.advance(200); // requête à un mot : publiée tout de suite
    const published = seen.length;
    first.resolve(reversed(first.docs as Parameters<typeof reversed>[0]));
    first.onWindow?.({ docs: [], pagesOrderByDoc: new Map(), bonusByDoc: new Map(), failedDocIds: new Set() });
    clock.advance(RERANK_GRACE_MS * 3);
    await flushMicro();
    expect(seen).toHaveLength(published);
    expect(resultOf(controller.getViewModel()).ranking).toBe("bm25");
  });

  it("une nouvelle exécution (même requête) annule la précédente", async () => {
    const { controller, clock, calls, source } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    source.emit();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(calls[1]!.signal!.aborted).toBe(false);
  });

  it("dispose annule le re-classement et rien n'est publié ensuite", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    controller.dispose();
    expect(calls[0]!.signal!.aborted).toBe(true);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    clock.advance(RERANK_GRACE_MS * 2);
    await flushMicro();
    expect(seen).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it("échec du ranker avant la grâce : ordre BM25 publié aussitôt, avertissement journalisé", async () => {
    const { controller, clock, calls, seen, onWarn } = rerankSetup();
    const base = bm25Order("alpha beta");
    controller.setQuery("alpha beta");
    clock.advance(200);
    const boom = new Error("boom");
    calls[0]!.reject(boom);
    await flushMicro();
    expect(seen).toHaveLength(1);
    expect(resultOf(seen[0]!).ranking).toBe("bm25");
    expect(resultOf(seen[0]!).docs.map((d) => d.docId)).toEqual(base);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("proximity"), boom);
    clock.advance(1000);
    expect(seen).toHaveLength(1);
  });

  it("échec du ranker après la grâce : BM25 conservé, avertissement, pas de seconde publication", async () => {
    const { controller, clock, calls, seen, onWarn } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    clock.advance(RERANK_GRACE_MS);
    calls[0]!.reject(new Error("late boom"));
    await flushMicro();
    expect(seen).toHaveLength(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("un rejet d'annulation (signal annulé) n'est pas journalisé", async () => {
    const { controller, clock, calls, onWarn } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    controller.setQuery("");
    calls[0]!.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    await flushMicro();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("sans option rerank, deux mots : publié tout de suite avec ranking bm25", () => {
    const { controller, clock, seen } = setup(new FakeSource(RR_PAGES, RR_DOCS));
    controller.setQuery("alpha beta");
    clock.advance(200);
    expect(seen).toHaveLength(1);
    expect(resultOf(seen[0]!).ranking).toBe("bm25");
  });

  it("pendant le chargement partiel : pas de re-classement avant la fenêtre de regroupement", async () => {
    const { controller, clock, calls, source } = rerankSetup({ phase: "ready" });
    controller.setQuery("alpha beta");
    clock.advance(200);
    expect(calls).toHaveLength(1);
    source.phase = "loading";
    source.progress = { loaded: 1, total: 3, failed: [] };
    source.emit();
    source.emit();
    source.emit();
    expect(calls).toHaveLength(1); // coalescé : pas de nouveau run immédiat
    clock.advance(150);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  it("invalidate() relance proprement le re-classement de la requête courante", async () => {
    const { controller, clock, calls } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    controller.invalidate();
    expect(calls[0]!.signal!.aborted).toBe(true); // le snapshot périmé ne sera jamais publié
    expect(calls).toHaveLength(1); // relance coalescée
    clock.advance(150);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signal!.aborted).toBe(false);
  });

  it("invalidate() sans requête active ou après dispose : sans effet", () => {
    const { controller, calls } = rerankSetup();
    controller.invalidate();
    controller.dispose();
    controller.invalidate();
    expect(calls).toHaveLength(0);
  });

  it("M1 : runs rapprochés (150 ms) avec un ranker lent : l'ordre BM25 finit par être publié", async () => {
    const { controller, clock, calls, seen, source } = rerankSetup({ phase: "loading" });
    source.progress = { loaded: 1, total: 3, failed: [] };
    controller.setQuery("alpha beta");
    clock.advance(200);
    for (let i = 0; i < 6; i++) {
      source.emit();
      clock.advance(150);
    }
    expect(calls.length).toBeGreaterThan(2); // le ranker a bien été relancé à chaque fenêtre
    expect(seen.length).toBeGreaterThan(0);
    expect(resultOf(seen[0]!).ranking).toBe("bm25");
  });

  it("grâce mesurée depuis la première demande, publiée avec le BM25 du dernier run", () => {
    const { controller, clock, calls, seen, source } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    clock.advance(200);
    source.emit(); // run 2 à t = 400 : la grâce de t = 200 court toujours
    expect(seen).toHaveLength(0);
    clock.advance(100); // t = 500 = 200 + 300
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("une liste déjà affichée pour la même requête n'est pas remplacée par du BM25 pendant une relance lente", async () => {
    const { controller, clock, calls, seen, source } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    expect(seen).toHaveLength(1);
    source.emit();
    clock.advance(RERANK_GRACE_MS * 2);
    expect(seen).toHaveLength(1); // pas de retour à BM25 (scintillement)
    calls[1]!.resolve(reversed(calls[1]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    expect(seen).toHaveLength(2);
    expect(resultOf(seen[1]!).ranking).toBe("proximity");
  });

  it("M2 : un onChange qui lève à la publication du re-classement est journalisé, pas perdu", async () => {
    const source = new FakeSource(RR_PAGES, RR_DOCS);
    const calls: Call[] = [];
    const rerank = {
      rank: (q: string, docs: readonly { docId: string }[]) =>
        new Promise((resolve, reject) => calls.push({ query: q, docs, signal: undefined, onWindow: undefined, resolve: resolve as Call["resolve"], reject })),
    } as unknown as RerankPort;
    const clock = new FakeClock();
    const onWarn = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const controller = createSearchController({
      source, schedule: clock.schedule, clear: clock.clear, rerank, onWarn,
      onChange: () => {
        throw new Error("render exploded");
      },
    });
    controller.setQuery("alpha beta");
    clock.advance(200);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("publication"), expect.objectContaining({ message: "render exploded" }));
    // minuteur de grâce : onChange qui lève
    controller.setQuery("alpha beta ");
    clock.advance(200);
    clock.advance(RERANK_GRACE_MS);
    expect(onWarn).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("F1 : toutes les mesures en échec : ranking reste bm25 ; une seule mesure réussie suffit pour proximity", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    const allFailed = { ...reversed(docs), failedDocIds: new Set(docs.map((d) => d.docId)) };
    calls[0]!.resolve(allFailed as RankResult);
    await flushMicro();
    expect(resultOf(seen.at(-1)!).ranking).toBe("bm25");
    calls[0]!.onWindow!({ ...reversed(docs), failedDocIds: new Set([docs[0]!.docId]) } as never);
    expect(resultOf(seen.at(-1)!).ranking).toBe("proximity");
  });

  it("5 : pas de ranking proximity si l'ordre n'a pas changé ; oui si seules les 5 premières pages changent", async () => {
    const { controller, clock, calls, seen } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    const docs = calls[0]!.docs as Parameters<typeof reversed>[0];
    const same = { docs, pagesOrderByDoc: new Map(), bonusByDoc: new Map(docs.map((d) => [d.docId, 0])), failedDocIds: new Set<string>(), done: Promise.resolve() };
    calls[0]!.resolve(same as unknown as RankResult);
    await flushMicro();
    expect(resultOf(seen.at(-1)!).ranking).toBe("bm25");
    const a = docs.find((d) => d.docId === "a")!;
    const pagesOnly = { ...same, pagesOrderByDoc: new Map([["a", a.pages.map((p) => p.page).reverse()]]) };
    calls[0]!.onWindow!(pagesOnly as never);
    expect(resultOf(seen.at(-1)!).ranking).toBe("proximity");
  });

  it("5 : après une relance identique, le view-model proximity republié garde le même contenu (statut inchangé)", async () => {
    const { controller, clock, calls, seen, source } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    source.emit();
    calls[1]!.resolve(reversed(calls[1]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    const [x, y] = [resultOf(seen[0]!), resultOf(seen[1]!)];
    expect(y.ranking).toBe(x.ranking);
    expect(y.docs.map((d) => d.docId)).toEqual(x.docs.map((d) => d.docId));
  });

  it("6 : invalidate pendant la coalescence du chargement annule le re-classement en vol", async () => {
    const { controller, clock, calls, seen, source } = rerankSetup({ phase: "loading" });
    source.progress = { loaded: 1, total: 3, failed: [] };
    controller.setQuery("alpha beta");
    clock.advance(200);
    source.emit(); // coalescence armée
    controller.invalidate();
    expect(calls[0]!.signal!.aborted).toBe(true);
    calls[0]!.resolve(reversed(calls[0]!.docs as Parameters<typeof reversed>[0]));
    await flushMicro();
    expect(seen.filter((v) => v.kind === "results" && v.ranking === "proximity")).toHaveLength(0);
  });

  it("6 : invalidate suivi d'une notification du store ne donne qu'un seul run", () => {
    const { controller, clock, calls, source } = rerankSetup();
    controller.setQuery("alpha beta");
    clock.advance(200);
    controller.invalidate();
    source.emit(); // run immédiat : annule la relance coalescée devenue inutile
    expect(calls).toHaveLength(2);
    clock.advance(1000);
    expect(calls).toHaveLength(2);
  });
});
