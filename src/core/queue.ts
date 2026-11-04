/** File d'indexation injectable : aucun timer global, traitement fourni par l'appelant. */

export const DEFAULT_CONCURRENCY = 2;

export interface ProgressInfo {
  readonly pagesDone: number;
  readonly pagesTotal?: number;
}

export interface ProcessContext {
  readonly signal: AbortSignal;
  reportProgress(pagesDone: number, pagesTotal?: number): void;
}

export type ProcessFn = (id: string, context: ProcessContext) => Promise<void>;

export interface FailedJob {
  readonly id: string;
  readonly message: string;
}

export type JournalEntry =
  | { readonly seq: number; readonly type: "started"; readonly id: string }
  | { readonly seq: number; readonly type: "completed"; readonly id: string }
  | { readonly seq: number; readonly type: "cancelled"; readonly id: string }
  | { readonly seq: number; readonly type: "failed"; readonly id: string; readonly message: string };

export interface QueueState {
  readonly pending: readonly string[];
  readonly running: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly FailedJob[];
  readonly progress: Readonly<Record<string, ProgressInfo>>;
  readonly paused: boolean;
}

/** État persistable (JSON) : les jobs en cours sont repris en tête de file. */
export interface QueueSnapshot {
  readonly pending: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly FailedJob[];
}

export interface IndexQueueOptions {
  readonly process: ProcessFn;
  readonly concurrency?: number;
  readonly initialState?: QueueSnapshot;
}

export interface IndexQueue {
  enqueue(id: string): boolean;
  pause(): void;
  resume(): void;
  cancel(id: string): boolean;
  state(): QueueState;
  snapshot(): QueueSnapshot;
  journal(): readonly JournalEntry[];
  subscribe(listener: () => void): () => void;
  /** Résout quand plus rien n'est en attente ni en cours (en pause : après reprise). */
  onIdle(): Promise<void>;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type JournalInput = DistributiveOmit<JournalEntry, "seq">;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class IndexQueueImpl implements IndexQueue {
  private pending: string[];
  private completed: string[];
  private failed: FailedJob[];
  private paused = false;
  private readonly running = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private readonly progress = new Map<string, ProgressInfo>();
  private readonly entries: JournalEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly processFn: ProcessFn,
    private readonly concurrency: number,
    initial: QueueSnapshot | undefined,
  ) {
    this.pending = [...(initial?.pending ?? [])];
    this.completed = [...(initial?.completed ?? [])];
    this.failed = [...(initial?.failed ?? [])];
    this.pump();
  }

  enqueue(id: string): boolean {
    if (this.pending.includes(id) || this.running.has(id)) return false;
    this.completed = this.completed.filter((done) => done !== id);
    this.failed = this.failed.filter((job) => job.id !== id);
    this.pending.push(id);
    this.pump();
    this.notify();
    return true;
  }

  pause(): void {
    this.paused = true;
    this.notify();
  }

  resume(): void {
    this.paused = false;
    this.pump();
    this.notify();
  }

  cancel(id: string): boolean {
    const controller = this.running.get(id);
    if (controller !== undefined) {
      this.cancelRequested.add(id);
      controller.abort();
      return true;
    }
    if (!this.pending.includes(id)) return false;
    this.pending = this.pending.filter((pendingId) => pendingId !== id);
    this.record({ type: "cancelled", id });
    this.settleIfIdle();
    this.notify();
    return true;
  }

  state(): QueueState {
    return {
      pending: [...this.pending],
      running: [...this.running.keys()],
      completed: [...this.completed],
      failed: [...this.failed],
      progress: Object.fromEntries(this.progress),
      paused: this.paused,
    };
  }

  snapshot(): QueueSnapshot {
    return {
      pending: [...this.running.keys(), ...this.pending],
      completed: [...this.completed],
      failed: [...this.failed],
    };
  }

  journal(): readonly JournalEntry[] {
    return [...this.entries];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.pending.length === 0 && this.running.size === 0;
  }

  private pump(): void {
    while (!this.paused && this.running.size < this.concurrency) {
      const next = this.pending.shift();
      if (next === undefined) break;
      void this.run(next);
    }
  }

  private async run(id: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(id, controller);
    this.record({ type: "started", id });
    this.notify();
    try {
      await this.processFn(id, this.createContext(id, controller.signal));
      this.finish(id, { type: "completed", id });
    } catch (error) {
      this.finish(id, { type: "failed", id, message: toMessage(error) });
    }
  }

  private createContext(id: string, signal: AbortSignal): ProcessContext {
    return {
      signal,
      reportProgress: (pagesDone, pagesTotal) => {
        const info: ProgressInfo = pagesTotal === undefined ? { pagesDone } : { pagesDone, pagesTotal };
        this.progress.set(id, info);
        this.notify();
      },
    };
  }

  private finish(id: string, outcome: JournalInput): void {
    this.running.delete(id);
    this.progress.delete(id);
    const wasCancelled = this.cancelRequested.delete(id);
    if (wasCancelled) this.record({ type: "cancelled", id });
    else this.applyOutcome(outcome);
    this.pump();
    this.settleIfIdle();
    this.notify();
  }

  private applyOutcome(outcome: JournalInput): void {
    this.record(outcome);
    if (outcome.type === "completed") this.completed.push(outcome.id);
    else if (outcome.type === "failed") this.failed.push({ id: outcome.id, message: outcome.message });
  }

  private record(entry: JournalInput): void {
    this.entries.push({ ...entry, seq: this.entries.length + 1 } as JournalEntry);
  }

  private settleIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export function createIndexQueue(options: IndexQueueOptions): IndexQueue {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  return new IndexQueueImpl(options.process, concurrency, options.initialState);
}
