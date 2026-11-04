import { describe, expect, it, vi } from "vitest";
import { buildIndex, type Bm25Index } from "../../../src/core/bm25";
import {
  createSearchController,
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
  const controller = createSearchController({
    source,
    schedule: clock.schedule,
    clear: clock.clear,
    onChange: (vm) => seen.push(vm),
  });
  return { source, clock, seen, controller };
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
    expect(controller.getViewModel()).toEqual({ kind: "no-result", query: "zzzz", partial: false });
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
    expect(controller.getViewModel()).toEqual({ kind: "no-result", query: "zzz", partial: true });
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
});
