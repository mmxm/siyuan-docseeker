import { describe, expect, it } from "vitest";
import { createIndexQueue, type ProcessContext } from "../../src/core/queue";

interface Deferred {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly ctx: ProcessContext;
  resolve(): void;
  reject(error: unknown): void;
}

function createHarness() {
  const started: string[] = [];
  const pendingCalls: Deferred[] = [];
  let active = 0;
  let maxActive = 0;
  const process = (id: string, ctx: ProcessContext): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      started.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const finish = () => {
        active -= 1;
      };
      ctx.signal.addEventListener("abort", () => {
        finish();
        reject(new DOMException("aborted", "AbortError"));
      });
      pendingCalls.push({
        id,
        signal: ctx.signal,
        ctx,
        resolve: () => {
          finish();
          resolve();
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
    });
  const call = (id: string): Deferred => {
    const found = pendingCalls.find((c) => c.id === id);
    if (!found) throw new Error(`not started: ${id}`);
    return found;
  };
  return { process, started, call, maxActive: () => maxActive };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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

  it("rejects an invalid concurrency", () => {
    const h = createHarness();
    expect(() => createIndexQueue({ process: h.process, concurrency: 0 })).toThrow();
    expect(() => createIndexQueue({ process: h.process, concurrency: 1.5 })).toThrow();
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
  });

  it("does not start restored work while paused is requested via pause before enqueue", async () => {
    const h = createHarness();
    const queue = createIndexQueue({ process: h.process });
    queue.pause();
    queue.enqueue("a");
    await flush();
    expect(h.started).toEqual([]);
  });
});
