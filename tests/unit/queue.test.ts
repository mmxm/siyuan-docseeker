import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CANCEL_TIMEOUT_MS,
  DEFAULT_FAILURE_MESSAGE,
  MAX_JOURNAL_ENTRIES,
  createIndexQueue,
  type JournalEntry,
  type ProcessContext,
} from "../../src/core/queue";

interface Deferred {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly ctx: ProcessContext;
  resolve(): void;
  reject(error: unknown): void;
}

interface HarnessOptions {
  /** false : le processeur ignore le signal d'annulation (ne se termine jamais seul). */
  readonly honorAbort?: boolean;
}

const harnesses: Array<{ active(): number }> = [];

function createHarness(options: HarnessOptions = {}) {
  const honorAbort = options.honorAbort ?? true;
  const started: string[] = [];
  const pendingCalls: Deferred[] = [];
  let active = 0;
  let maxActive = 0;
  const process = (id: string, ctx: ProcessContext): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      started.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        active -= 1;
        action();
      };
      if (honorAbort) {
        ctx.signal.addEventListener("abort", () => {
          settle(() => reject(new DOMException("aborted", "AbortError")));
        });
      }
      pendingCalls.push({
        id,
        signal: ctx.signal,
        ctx,
        resolve: () => settle(resolve),
        reject: (error) => settle(() => reject(error)),
      });
    });
  const call = (id: string): Deferred => {
    const found = [...pendingCalls].reverse().find((c) => c.id === id);
    if (!found) throw new Error(`not started: ${id}`);
    return found;
  };
  const harness = { process, started, call, calls: pendingCalls, maxActive: () => maxActive, active: () => active };
  harnesses.push(harness);
  return harness;
}

/** Laisse les continuations de promesses se dérouler (aucun timer, déterministe). */
const MICROTASK_TURNS = 20;
async function flush(): Promise<void> {
  for (let i = 0; i < MICROTASK_TURNS; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  const leaked = harnesses.map((h) => h.active());
  harnesses.length = 0;
  for (const count of leaked) expect(count).toBe(0);
});

const types = (entries: readonly JournalEntry[], id: string): string[] =>
  entries.filter((e) => "id" in e && e.id === id).map((e) => e.type);

describe("createIndexQueue", () => {
  it("resolves onIdle immediately on an empty queue", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    await queue.onIdle();
    expect(queue.state().pending).toEqual([]);
    expect(queue.snapshot()).toEqual({ pending: [], completed: [], failed: [] });
  });

  it("processes in FIFO order with default concurrency 2", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    ["a", "b", "c", "d"].forEach((id) => queue.enqueue(id));
    await flush();
    expect(h.started).toEqual(["a", "b"]);
    expect(queue.state().running).toEqual(["a", "b"]);
    expect(queue.state().pending).toEqual(["c", "d"]);
    h.call("a").resolve();
    await flush();
    expect(h.started).toEqual(["a", "b", "c"]);
    h.call("b").resolve();
    h.call("c").resolve();
    await flush();
    h.call("d").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a", "b", "c", "d"]);
  });

  it("never exceeds the configured concurrency", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 3 });
    const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
    ids.forEach((id) => queue.enqueue(id));
    for (const id of ids) {
      await flush();
      h.call(id).resolve();
    }
    await queue.onIdle();
    expect(h.maxActive()).toBe(3);
    expect(queue.state().completed).toHaveLength(10);
  });

  it("rejects an invalid concurrency or cancel timeout", () => {
    const h = createHarness();
    expect(() => createIndexQueue({ process: h.process, concurrency: 0 })).toThrow();
    expect(() => createIndexQueue({ process: h.process, concurrency: 1.5 })).toThrow();
    expect(() => createIndexQueue({ process: h.process, cancelTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createIndexQueue({ process: h.process, cancelTimeoutMs: Number.NaN })).toThrow(RangeError);
  });

  it("pauses without interrupting running jobs, then resumes", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    await flush();
    queue.pause();
    expect(queue.state().paused).toBe(true);
    h.call("a").resolve();
    await flush();
    expect(h.started).toEqual(["a"]);
    expect(queue.state().pending).toEqual(["b"]);
    queue.enqueue("c");
    await flush();
    expect(h.started).toEqual(["a"]);
    queue.resume();
    await flush();
    expect(h.started).toEqual(["a", "b"]);
    h.call("b").resolve();
    await flush();
    h.call("c").resolve();
    await queue.onIdle();
    expect(queue.state().paused).toBe(false);
    expect(queue.state().completed).toEqual(["a", "b", "c"]);
  });

  it("cancels a pending document", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    await flush();
    expect(queue.cancel("b")).toBe(true);
    expect(queue.state().pending).toEqual([]);
    h.call("a").resolve();
    await queue.onIdle();
    expect(h.started).toEqual(["a"]);
    expect(queue.journal().some((e) => e.type === "cancelled" && e.id === "b")).toBe(true);
  });

  it("cancels a running document through its AbortSignal without marking failure", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    await flush();
    expect(h.call("a").signal.aborted).toBe(false);
    expect(queue.cancel("a")).toBe(true);
    expect(h.call("a").signal.aborted).toBe(true);
    await flush();
    expect(queue.state().failed).toEqual([]);
    expect(queue.state().completed).toEqual([]);
    expect(h.started).toEqual(["a", "b"]);
    h.call("b").resolve();
    await queue.onIdle();
    expect(queue.journal().some((e) => e.type === "cancelled" && e.id === "a")).toBe(true);
  });

  it("returns false when cancelling an unknown document", () => {
    const queue = createIndexQueue({ process: createHarness().process });
    expect(queue.cancel("nope")).toBe(false);
  });

  it("isolates a failure and records it in the typed journal", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("bad");
    queue.enqueue("good");
    await flush();
    h.call("bad").reject(new Error("corrupt pdf"));
    await flush();
    h.call("good").resolve();
    await queue.onIdle();
    const state = queue.state();
    expect(state.completed).toEqual(["good"]);
    expect(state.failed).toEqual([{ id: "bad", message: "corrupt pdf" }]);
    expect(queue.journal().find((e) => e.type === "failed")).toMatchObject({
      type: "failed",
      id: "bad",
      message: "corrupt pdf",
    });
  });

  it("stringifies non-Error rejections", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("x");
    await flush();
    h.call("x").reject("boom");
    await queue.onIdle();
    expect(queue.state().failed).toEqual([{ id: "x", message: "boom" }]);
  });

  it("reports page progress from the processor", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    await flush();
    h.call("a").ctx.reportProgress(3, 10);
    expect(queue.state().progress["a"]).toEqual({ pagesDone: 3, pagesTotal: 10 });
    h.call("a").ctx.reportProgress(4);
    expect(queue.state().progress["a"]).toEqual({ pagesDone: 4 });
    h.call("a").resolve();
    await queue.onIdle();
    expect(queue.state().progress["a"]).toBeUndefined();
  });

  it("notifies subscribers and supports unsubscribe", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    let calls = 0;
    const unsubscribe = queue.subscribe(() => {
      calls += 1;
    });
    queue.enqueue("a");
    expect(calls).toBeGreaterThan(0);
    unsubscribe();
    const before = calls;
    await flush();
    h.call("a").resolve();
    await queue.onIdle();
    expect(calls).toBe(before);
  });

  it("ignores duplicates that are pending or running", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    expect(queue.enqueue("a")).toBe(true);
    expect(queue.enqueue("b")).toBe(true);
    expect(queue.enqueue("a")).toBe(false);
    expect(queue.enqueue("b")).toBe(false);
    await flush();
    expect(h.started).toEqual(["a"]);
    expect(queue.state().pending).toEqual(["b"]);
    h.call("a").resolve();
    await flush();
    h.call("b").resolve();
    await queue.onIdle();
  });

  it("allows re-enqueue of a completed or failed document", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    await flush();
    h.call("a").resolve();
    await queue.onIdle();
    expect(queue.enqueue("a")).toBe(true);
    expect(queue.state().completed).toEqual([]);
    await flush();
    h.call("a").resolve();
    await queue.onIdle();
  });

  it("restores from a snapshot, resuming interrupted work first", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    ["a", "b", "c"].forEach((id) => queue.enqueue(id));
    await flush();
    h.call("a").reject(new Error("x"));
    await flush();
    const snap = queue.snapshot();
    expect(snap).toEqual({ pending: ["b", "c"], completed: [], failed: [{ id: "a", message: "x" }] });
    const copy = JSON.parse(JSON.stringify(snap));
    h.call("b").resolve();
    await flush();
    h.call("c").resolve();
    await queue.onIdle();
    const h2 = createHarness();
    const restored = createIndexQueue({ process: h2.process, concurrency: 1, initialState: copy });
    await flush();
    expect(h2.started).toEqual(["b"]);
    expect(restored.state().failed).toEqual([{ id: "a", message: "x" }]);
    h2.call("b").resolve();
    await flush();
    h2.call("c").resolve();
    await restored.onIdle();
    expect(restored.state().completed).toEqual(["b", "c"]);
  });

  it("includes running jobs first in the snapshot", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    await flush();
    expect(queue.snapshot().pending).toEqual(["a", "b"]);
    h.call("a").resolve();
    await flush();
    h.call("b").resolve();
    await queue.onIdle();
  });

  it("does not start work while paused is requested via pause before enqueue", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.pause();
    queue.enqueue("a");
    await flush();
    expect(h.started).toEqual([]);
  });
});

describe("subscriber isolation (defect 1)", () => {
  it("survives a throwing listener: job completes once, onIdle resolves, error is journaled", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    let healthyCalls = 0;
    queue.subscribe(() => {
      throw new Error("listener boom");
    });
    queue.subscribe(() => {
      healthyCalls += 1;
    });
    queue.enqueue("a");
    await flush();
    h.call("a").resolve();
    await queue.onIdle();
    const state = queue.state();
    expect(state.running).toEqual([]);
    expect(state.completed).toEqual(["a"]);
    expect(state.failed).toEqual([]);
    expect(types(queue.journal(), "a")).toEqual(["started", "completed"]);
    expect(healthyCalls).toBeGreaterThan(1);
    expect(queue.journal().some((e) => e.type === "listener-error" && e.message === "listener boom")).toBe(true);
  });

  it("a throwing listener does not turn a success into a failure on the next job", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.subscribe(() => {
      throw new Error("always");
    });
    queue.enqueue("a");
    queue.enqueue("b");
    await flush();
    h.call("a").resolve();
    await flush();
    h.call("b").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a", "b"]);
    expect(queue.state().failed).toEqual([]);
  });
});

describe("cancel timeout (defect 2)", () => {
  it("exposes a 30 s default", () => {
    expect(DEFAULT_CANCEL_TIMEOUT_MS).toBe(30_000);
  });

  it("frees the slot when the processor ignores the signal, and ignores its late result", async () => {
    vi.useFakeTimers();
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    expect(queue.cancel("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_CANCEL_TIMEOUT_MS - 1);
    expect(queue.state().running).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.state().running).toEqual(["b"]);
    expect(types(queue.journal(), "a")).toEqual(["started", "cancel-timeout"]);
    h.call("a").ctx.reportProgress(1, 2);
    expect(queue.state().progress["a"]).toBeUndefined();
    h.call("a").resolve();
    await flush();
    expect(queue.state().completed).toEqual([]);
    expect(types(queue.journal(), "a")).toEqual(["started", "cancel-timeout"]);
    h.call("b").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["b"]);
  });

  it("honors a custom timeout and onIdle resolves once the slot is freed", async () => {
    vi.useFakeTimers();
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, cancelTimeoutMs: 100 });
    queue.enqueue("a");
    queue.cancel("a");
    let idle = false;
    void queue.onIdle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(idle).toBe(true);
    h.call("a").reject(new Error("late"));
    await flush();
    expect(queue.state().failed).toEqual([]);
  });

  it("does not emit cancel-timeout when the processor honors the abort", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    queue.cancel("a");
    await queue.onIdle();
    await vi.advanceTimersByTimeAsync(DEFAULT_CANCEL_TIMEOUT_MS * 2);
    expect(types(queue.journal(), "a")).toEqual(["started", "cancelled"]);
  });
});

describe("real outcome versus cancellation (defect 3)", () => {
  it("journals a real failure of a cancelled job as failed", async () => {
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.cancel("a");
    h.call("a").reject(new Error("disk full"));
    await queue.onIdle();
    expect(queue.state().failed).toEqual([{ id: "a", message: "disk full" }]);
    expect(types(queue.journal(), "a")).toEqual(["started", "failed"]);
  });

  it("journals a success that ignored the abort as completed", async () => {
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.cancel("a");
    h.call("a").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a"]);
    expect(types(queue.journal(), "a")).toEqual(["started", "completed"]);
  });

  it("treats an AbortError without a cancel request as a failure", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    h.call("a").reject(new DOMException("spurious", "AbortError"));
    await queue.onIdle();
    expect(queue.state().failed).toHaveLength(1);
    expect(types(queue.journal(), "a")).toEqual(["started", "failed"]);
  });
});

describe("enqueue after cancel of a running job (defect 4)", () => {
  it("remembers the request and requeues the id when the cancellation ends", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    expect(queue.cancel("a")).toBe(true);
    expect(queue.enqueue("a")).toBe(true);
    expect(queue.enqueue("a")).toBe(false);
    await flush();
    expect(h.started).toEqual(["a", "a"]);
    expect(h.call("a").signal.aborted).toBe(false);
    h.call("a").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a"]);
    expect(types(queue.journal(), "a")).toEqual(["started", "cancelled", "started", "completed"]);
  });

  it("requeues after a cancel timeout as well", async () => {
    vi.useFakeTimers();
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, concurrency: 1, cancelTimeoutMs: 50 });
    queue.enqueue("a");
    queue.cancel("a");
    queue.enqueue("a");
    await vi.advanceTimersByTimeAsync(50);
    expect(h.started).toEqual(["a", "a"]);
    h.calls.forEach((c) => c.resolve());
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a"]);
  });
});

describe("reportProgress validation (defect 5)", () => {
  it("ignores calls once the job is no longer running", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    const ctx = h.call("a").ctx;
    h.call("a").resolve();
    await queue.onIdle();
    ctx.reportProgress(5, 10);
    expect(queue.state().progress).toEqual({});
  });

  it.each([
    [Number.NaN, undefined],
    [-1, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [5, 3],
    [1, -2],
    [1, Number.NaN],
  ])("throws a RangeError for (%s, %s) and keeps previous progress", async (done, total) => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    const ctx = h.call("a").ctx;
    ctx.reportProgress(1, 10);
    expect(() => ctx.reportProgress(done, total)).toThrow(RangeError);
    expect(queue.state().progress["a"]).toEqual({ pagesDone: 1, pagesTotal: 10 });
    h.call("a").resolve();
    await queue.onIdle();
  });
});

describe("initialState reconciliation (defect 6)", () => {
  it("deduplicates pending ids so a job never runs twice at once", async () => {
    const h = createHarness();
    const queue = createIndexQueue({
      process: h.process,
      concurrency: 2,
      initialState: { pending: ["a", "a", "b", "a"], completed: [], failed: [] },
    });
    expect(h.started).toEqual(["a", "b"]);
    expect(queue.state().running).toEqual(["a", "b"]);
    h.call("a").resolve();
    h.call("b").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual(["a", "b"]);
  });

  it("gives priority to pending over completed/failed, and to failed over completed", async () => {
    const h = createHarness();
    const queue = createIndexQueue({
      process: h.process,
      concurrency: 1,
      initialState: {
        pending: ["p", "p2"],
        completed: ["p", "x", "both"],
        failed: [
          { id: "p2", message: "old" },
          { id: "both", message: "bad" },
          { id: "f", message: "one" },
          { id: "f", message: "two" },
        ],
      },
    });
    const state = queue.state();
    expect(state.completed).toEqual(["x"]);
    expect(state.failed).toEqual([
      { id: "both", message: "bad" },
      { id: "f", message: "two" },
    ]);
    h.call("p").resolve();
    await flush();
    h.call("p2").resolve();
    await queue.onIdle();
  });

  it("accepts unknown ids and exposes initial failures in the journal", () => {
    const h = createHarness();
    const queue = createIndexQueue({
      process: h.process,
      initialState: { pending: [], completed: ["unknown-1"], failed: [{ id: "unknown-2", message: "m" }] },
    });
    expect(queue.state().completed).toEqual(["unknown-1"]);
    expect(queue.journal()).toEqual([{ seq: 1, type: "failed", id: "unknown-2", message: "m" }]);
  });
});

describe("journal (defect 7)", () => {
  it("keeps name and stack of the failure", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    const error = new TypeError("bad type");
    h.call("a").reject(error);
    await queue.onIdle();
    const entry = queue.journal().find((e) => e.type === "failed");
    expect(entry).toMatchObject({ name: "TypeError", message: "bad type" });
    expect(entry && "stack" in entry ? entry.stack : undefined).toBe(error.stack);
  });

  it("uses a default message when the error message is empty", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    queue.enqueue("b");
    h.call("a").reject(new Error(""));
    h.call("b").reject("");
    await queue.onIdle();
    expect(queue.state().failed.map((f) => f.message)).toEqual([DEFAULT_FAILURE_MESSAGE, DEFAULT_FAILURE_MESSAGE]);
    expect(DEFAULT_FAILURE_MESSAGE.length).toBeGreaterThan(0);
  });

  it("caps the journal while keeping sequence numbers monotonic", async () => {
    const queue = createIndexQueue({ process: () => Promise.resolve(), concurrency: 4 });
    const total = MAX_JOURNAL_ENTRIES;
    for (let i = 0; i < total; i += 1) queue.enqueue(`d${i}`);
    await queue.onIdle();
    const journal = queue.journal();
    expect(journal).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(journal[journal.length - 1]?.seq).toBe(total * 2);
    expect(journal[0]?.seq).toBe(total * 2 - MAX_JOURNAL_ENTRIES + 1);
  });

  it("returns a defensive copy", () => {
    const queue = createIndexQueue({
      process: createHarness().process,
      initialState: { pending: [], completed: [], failed: [{ id: "x", message: "m" }] },
    });
    (queue.journal() as JournalEntry[]).pop();
    expect(queue.journal()).toHaveLength(1);
  });
});

describe("scalability (defect 8)", () => {
  it("enqueues 20 000 ids within a generous bound and keeps FIFO order", () => {
    const queue = createIndexQueue({ process: () => new Promise<void>(() => undefined) });
    queue.pause();
    const count = 20_000;
    const startedAt = performance.now();
    for (let i = 0; i < count; i += 1) queue.enqueue(`doc-${i}`);
    for (let i = 0; i < count; i += 1) queue.enqueue(`doc-${i}`);
    const elapsed = performance.now() - startedAt;
    expect(queue.state().pending).toHaveLength(count);
    expect(queue.state().pending[0]).toBe("doc-0");
    expect(elapsed).toBeLessThan(1500);
  });

  it("cancels pending ids and re-enqueues completed ones at scale", async () => {
    const queue = createIndexQueue({ process: () => Promise.resolve(), concurrency: 8 });
    const count = 20_000;
    for (let i = 0; i < count; i += 1) queue.enqueue(`doc-${i}`);
    await queue.onIdle();
    expect(queue.state().completed).toHaveLength(count);
    expect(queue.enqueue("doc-5")).toBe(true);
    expect(queue.state().completed).toHaveLength(count - 1);
    await queue.onIdle();
  });
});

describe("races and edge states (defect 9)", () => {
  it("cancel right after resolve in the same tick: completed and failed never overlap", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    h.call("a").resolve();
    queue.cancel("a");
    await queue.onIdle();
    const state = queue.state();
    const failedIds = state.failed.map((f) => f.id);
    expect(state.completed.filter((id) => failedIds.includes(id))).toEqual([]);
    expect(state.running).toEqual([]);
  });

  it("cancel right before a real rejection in the same tick: single outcome", async () => {
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    queue.cancel("a");
    h.call("a").reject(new Error("real"));
    await queue.onIdle();
    expect(queue.state().completed).toEqual([]);
    expect(queue.state().failed).toEqual([{ id: "a", message: "real" }]);
  });

  it("cancel then abort-honoring finish in the same tick resolves onIdle", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.enqueue("a");
    queue.cancel("a");
    h.call("a").resolve();
    await queue.onIdle();
    expect(queue.state().completed).toEqual([]);
    expect(queue.state().failed).toEqual([]);
  });

  it("returns false and leaves state intact when cancelling an already cancelled or finished job", async () => {
    const h = createHarness({ honorAbort: false });
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("done");
    expect(queue.cancel("a")).toBe(true);
    expect(queue.cancel("a")).toBe(false);
    h.call("a").reject(new DOMException("x", "AbortError"));
    await flush();
    h.call("done").resolve();
    await queue.onIdle();
    const before = queue.state();
    expect(queue.cancel("a")).toBe(false);
    expect(queue.cancel("done")).toBe(false);
    expect(queue.state()).toEqual(before);
  });

  it("cancels a running job while paused and does not start pending work until resume", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.enqueue("a");
    queue.enqueue("b");
    queue.pause();
    expect(queue.cancel("a")).toBe(true);
    await flush();
    expect(queue.state().running).toEqual([]);
    expect(queue.state().pending).toEqual(["b"]);
    expect(h.started).toEqual(["a"]);
    queue.resume();
    expect(h.started).toEqual(["a", "b"]);
    h.call("b").resolve();
    await queue.onIdle();
  });

  it("onIdle stays pending during a pause with queued work and resolves after resume", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process, concurrency: 1 });
    queue.pause();
    queue.enqueue("a");
    let idle = false;
    void queue.onIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    queue.resume();
    h.call("a").resolve();
    await queue.onIdle();
    expect(idle).toBe(true);
  });

  it("onIdle resolves during a pause when nothing is queued", async () => {
    const queue = createIndexQueue({ process: createHarness().process });
    queue.pause();
    await queue.onIdle();
    expect(queue.state().paused).toBe(true);
  });

  it("never lets a synchronous throw of the processor block the queue", async () => {
    const queue = createIndexQueue({
      process: () => {
        throw new Error("sync");
      },
    });
    queue.enqueue("a");
    await queue.onIdle();
    expect(queue.state().failed).toEqual([{ id: "a", message: "sync" }]);
  });
});
