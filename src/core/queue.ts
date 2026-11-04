/** File d'indexation injectable : traitement fourni par l'appelant, seul timer : l'échéance d'annulation. */

export const DEFAULT_CONCURRENCY = 2;
/** Délai après lequel un job annulé qui ignore le signal est abandonné et son slot libéré. */
export const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;
/** Taille maximale du journal : les entrées les plus anciennes sont écartées (seq reste croissant). */
export const MAX_JOURNAL_ENTRIES = 1000;
/** Message utilisé quand une erreur n'en fournit aucun. */
export const DEFAULT_FAILURE_MESSAGE = "Unknown error";

export interface ProgressInfo {
  readonly pagesDone: number;
  readonly pagesTotal?: number;
}

export interface ProcessContext {
  readonly signal: AbortSignal;
  /**
   * Signale l'avancement. Appel ignoré si le job n'est plus en cours (terminé, annulé, abandonné).
   * Lève une RangeError si les valeurs ne sont pas finies, négatives, ou si pagesDone > pagesTotal.
   */
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
  | {
      readonly seq: number;
      readonly type: "failed";
      readonly id: string;
      readonly message: string;
      readonly name?: string;
      readonly stack?: string;
    }
  | { readonly seq: number; readonly type: "cancel-timeout"; readonly id: string }
  | { readonly seq: number; readonly type: "listener-error"; readonly message: string };

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
  /** Réconcilié à la construction : doublons retirés, pending > failed > completed. */
  readonly initialState?: QueueSnapshot;
  /** Délai (ms, > 0) avant d'abandonner un job annulé qui ignore le signal. */
  readonly cancelTimeoutMs?: number;
}

export interface IndexQueue {
  /** false si l'id est déjà en attente ou en cours (sauf annulation en cours : réindexation mémorisée, true). */
  enqueue(id: string): boolean;
  pause(): void;
  resume(): void;
  cancel(id: string): boolean;
  state(): QueueState;
  snapshot(): QueueSnapshot;
  journal(): readonly JournalEntry[];
  subscribe(listener: () => void): () => void;
  /**
   * Résout quand plus rien n'est en attente ni en cours. En pause avec du travail en attente,
   * la promesse reste pendante jusqu'à la reprise et la fin du travail.
   */
  onIdle(): Promise<void>;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type JournalInput = DistributiveOmit<JournalEntry, "seq">;

interface Failure {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

type Outcome =
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly failure: Failure };

function toFailure(error: unknown): Failure {
  if (error instanceof Error) {
    return {
      message: error.message === "" ? DEFAULT_FAILURE_MESSAGE : error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  const message = String(error);
  return { message: message === "" ? DEFAULT_FAILURE_MESSAGE : message };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateProgress(pagesDone: number, pagesTotal: number | undefined): void {
  const totalValid = pagesTotal === undefined || isNonNegativeFinite(pagesTotal);
  if (!isNonNegativeFinite(pagesDone) || !totalValid) {
    throw new RangeError("progress values must be finite and >= 0");
  }
  if (pagesTotal !== undefined && pagesDone > pagesTotal) {
    throw new RangeError("pagesDone must not exceed pagesTotal");
  }
}

class IndexQueueImpl implements IndexQueue {
  private readonly pending = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly failed = new Map<string, FailedJob>();
  private paused = false;
  private readonly running = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly requeue = new Set<string>();
  private readonly progress = new Map<string, ProgressInfo>();
  private readonly entries: JournalEntry[] = [];
  private lastSeq = 0;
  private readonly listeners = new Set<() => void>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly processFn: ProcessFn,
    private readonly concurrency: number,
    private readonly cancelTimeoutMs: number,
    initial: QueueSnapshot | undefined,
  ) {
    this.restore(initial);
    this.pump();
  }

  private restore(initial: QueueSnapshot | undefined): void {
    for (const id of initial?.pending ?? []) this.pending.add(id);
    for (const job of initial?.failed ?? []) {
      if (!this.pending.has(job.id)) this.failed.set(job.id, { id: job.id, message: job.message });
    }
    for (const id of initial?.completed ?? []) {
      if (!this.pending.has(id) && !this.failed.has(id)) this.completed.add(id);
    }
    for (const job of this.failed.values()) {
      this.record({ type: "failed", id: job.id, message: job.message });
    }
  }

  enqueue(id: string): boolean {
    if (this.running.has(id)) return this.requestRequeue(id);
    if (this.pending.has(id)) return false;
    this.addPending(id);
    this.pump();
    this.notify();
    return true;
  }

  private requestRequeue(id: string): boolean {
    if (!this.cancelRequested.has(id) || this.requeue.has(id)) return false;
    this.requeue.add(id);
    this.notify();
    return true;
  }

  private addPending(id: string): void {
    this.completed.delete(id);
    this.failed.delete(id);
    this.pending.add(id);
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
    if (controller !== undefined) return this.cancelRunning(id, controller);
    if (!this.pending.delete(id)) return false;
    this.record({ type: "cancelled", id });
    this.settleIfIdle();
    this.notify();
    return true;
  }

  private cancelRunning(id: string, controller: AbortController): boolean {
    if (this.cancelRequested.has(id)) return this.requeue.delete(id);
    this.cancelRequested.add(id);
    this.cancelTimers.set(
      id,
      setTimeout(() => this.onCancelTimeout(id, controller), this.cancelTimeoutMs),
    );
    controller.abort();
    return true;
  }

  state(): QueueState {
    return {
      pending: [...this.pending],
      running: [...this.running.keys()],
      completed: [...this.completed],
      failed: [...this.failed.values()].map((job) => ({ ...job })),
      progress: Object.fromEntries(this.progress),
      paused: this.paused,
    };
  }

  snapshot(): QueueSnapshot {
    return {
      pending: [...this.running.keys(), ...this.pending],
      completed: [...this.completed],
      failed: [...this.failed.values()].map((job) => ({ ...job })),
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
    return this.pending.size === 0 && this.running.size === 0;
  }

  private pump(): void {
    while (!this.paused && this.running.size < this.concurrency) {
      const next = this.pending.values().next();
      if (next.done === true) break;
      this.pending.delete(next.value);
      this.start(next.value);
    }
  }

  private start(id: string): void {
    const controller = new AbortController();
    this.running.set(id, controller);
    this.run(id, controller).catch((error: unknown) => {
      this.settle(id, controller, { kind: "failed", failure: toFailure(error) });
    });
  }

  private async run(id: string, controller: AbortController): Promise<void> {
    this.record({ type: "started", id });
    this.notify();
    const outcome = await this.execute(id, controller);
    this.settle(id, controller, outcome);
  }

  /** Une annulation n'est retenue que si le signal est avorté ET l'erreur est une AbortError. */
  private async execute(id: string, controller: AbortController): Promise<Outcome> {
    try {
      await this.processFn(id, this.createContext(id, controller));
      return { kind: "completed" };
    } catch (error) {
      if (controller.signal.aborted && isAbortError(error)) return { kind: "cancelled" };
      return { kind: "failed", failure: toFailure(error) };
    }
  }

  private createContext(id: string, controller: AbortController): ProcessContext {
    return {
      signal: controller.signal,
      reportProgress: (pagesDone, pagesTotal) => {
        if (this.running.get(id) !== controller) return;
        validateProgress(pagesDone, pagesTotal);
        this.progress.set(id, pagesTotal === undefined ? { pagesDone } : { pagesDone, pagesTotal });
        this.notify();
      },
    };
  }

  /** Termine un job ; sans effet si le job a déjà été libéré (timeout d'annulation) : une seule issue. */
  private settle(id: string, controller: AbortController, outcome: Outcome): void {
    if (this.running.get(id) !== controller) return;
    this.release(id);
    this.applyOutcome(id, outcome);
    this.afterRelease(id);
  }

  private onCancelTimeout(id: string, controller: AbortController): void {
    if (this.running.get(id) !== controller) return;
    this.release(id);
    this.record({ type: "cancel-timeout", id });
    this.afterRelease(id);
  }

  private release(id: string): void {
    this.running.delete(id);
    this.progress.delete(id);
    this.cancelRequested.delete(id);
    const timer = this.cancelTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.cancelTimers.delete(id);
  }

  private afterRelease(id: string): void {
    if (this.requeue.delete(id)) this.addPending(id);
    this.pump();
    this.settleIfIdle();
    this.notify();
  }

  private applyOutcome(id: string, outcome: Outcome): void {
    if (outcome.kind === "cancelled") {
      this.record({ type: "cancelled", id });
    } else if (outcome.kind === "completed") {
      this.record({ type: "completed", id });
      this.failed.delete(id);
      this.completed.add(id);
    } else {
      const { message, name, stack } = outcome.failure;
      this.record({
        type: "failed",
        id,
        message,
        ...(name === undefined ? {} : { name }),
        ...(stack === undefined ? {} : { stack }),
      });
      this.completed.delete(id);
      this.failed.set(id, { id, message });
    }
  }

  private record(entry: JournalInput): void {
    this.lastSeq += 1;
    this.entries.push({ ...entry, seq: this.lastSeq } as JournalEntry);
    if (this.entries.length > MAX_JOURNAL_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_JOURNAL_ENTRIES);
    }
  }

  private settleIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** L'erreur d'un listener est journalisée et n'interrompt ni les autres listeners ni la file. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.record({ type: "listener-error", message: toFailure(error).message });
      }
    }
  }
}

export function createIndexQueue(options: IndexQueueOptions): IndexQueue {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  if (!Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs <= 0) {
    throw new RangeError("cancelTimeoutMs must be a positive finite number");
  }
  return new IndexQueueImpl(options.process, concurrency, cancelTimeoutMs, options.initialState);
}
