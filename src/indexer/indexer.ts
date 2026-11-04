/**
 * Orchestrateur d'indexation : synchronise les `.dsx` avec les PDF découverts.
 *
 * Entièrement injectable (aucun window/document/Worker). Choix documentés :
 * - Manifeste précédent : `manifest.json` dans le store ({version, entries}), validé à la lecture.
 *   Illisible/corrompu => on repart de zéro (tout est réindexé) SANS jamais supprimer d'index.
 *   Erreur d'E/S à la lecture => la synchronisation est abandonnée (on ne sait pas ce qui existe).
 * - Un PDF n'entre dans le manifeste qu'après écriture réussie de son `.dsx` (un échec sera retenté).
 *   Exception : un PDF scanné n'a pas de `.dsx` mais est enregistré, pour ne pas être réextrait à chaque passe.
 * - RISQUE 4 : le signal est vérifié juste avant `store.write` / `store.remove` et avant chaque écriture du
 *   manifeste ; un traitement abandonné ne publie donc rien.
 * - Nom du fichier : `<empreinte>.dsx` (empreinte = chemin + taille). Si la taille change, l'ancien fichier
 *   est supprimé après la mise à jour du manifeste (échec de ce nettoyage ignoré : fichier orphelin inoffensif).
 */
import { encodeIndex } from "../core/codec/encode";
import {
  buildDocumentIndex,
  isLikelyScanned,
  type ExtractedPage,
  type TextItemLike,
} from "../core/extract";
import { fingerprint, type Manifest, type PdfEntry } from "../core/manifest";
import { createIndexQueue, type IndexQueue, type QueueState } from "../core/queue";
import { planIndexUpdate, type DiscoveryResult } from "../siyuan/discovery";
import type { PetalStore } from "../siyuan/petalStore";

export const MANIFEST_FILE_NAME = "manifest.json";
export const MANIFEST_VERSION = 1;
export const EVENT_MESSAGE_MAX_LENGTH = 200;
export const NORMALIZER_VERSION = 1;
export const EXTRACTOR_VERSION = "docseeker-extract-1";
const EMPTY_SUMMARY: IndexSummary = { indexed: 0, skippedScanned: 0, failed: 0, removed: 0, cancelled: false };
const DISCOVERY_FAILURE_PATH = "(discovery)";

export interface PdfViewportLike {
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
}

export interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void> | void;
}

export interface IndexerDeps {
  readonly discover: () => Promise<DiscoveryResult>;
  readonly store: Pick<PetalStore, "read" | "write" | "remove">;
  readonly loadPdf: (path: string, signal: AbortSignal) => Promise<PdfDocumentLike>;
  readonly now: () => number;
  readonly concurrency?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface IndexSummary {
  readonly indexed: number;
  readonly skippedScanned: number;
  readonly failed: number;
  readonly removed: number;
  readonly cancelled: boolean;
}

export type IndexerEvent =
  | { readonly type: "started" }
  | { readonly type: "progress"; readonly path: string; readonly page: number; readonly total: number }
  | { readonly type: "indexed"; readonly path: string; readonly pages: number }
  | { readonly type: "skipped-scanned"; readonly path: string }
  | { readonly type: "failed"; readonly path: string; readonly message: string }
  | { readonly type: "removed"; readonly path: string }
  | { readonly type: "idle"; readonly summary: IndexSummary };

export interface IndexerState {
  readonly status: "idle" | "running" | "paused";
  readonly paused: boolean;
  readonly queue: QueueState | null;
  readonly lastSummary: IndexSummary | null;
}

export interface Indexer {
  /** Lance une synchronisation ; si une est en cours, renvoie la même promesse. Ne rejette jamais. */
  start(): Promise<IndexSummary>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Force la réindexation d'un PDF (ou de tous), après la synchronisation en cours le cas échéant. */
  reindex(path?: string): Promise<IndexSummary>;
  getState(): IndexerState;
  onEvent(listener: (event: IndexerEvent) => void): () => void;
}

interface Run {
  readonly abort: AbortController;
  promise: Promise<IndexSummary>;
  queue: IndexQueue | null;
}

interface Counters {
  indexed: number;
  skippedScanned: number;
  failed: number;
  removed: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const truncate = (message: string): string => message.slice(0, EVENT_MESSAGE_MAX_LENGTH);

function abortError(): Error {
  const error = new Error("Indexing aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

const dsxName = (entry: PdfEntry): string => `${fingerprint(entry)}.dsx`;

function isValidEntry(value: unknown): value is PdfEntry {
  if (typeof value !== "object" || value === null) return false;
  const { path, size, modifiedAt } = value as Record<string, unknown>;
  return (
    typeof path === "string" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof modifiedAt === "number" &&
    Number.isFinite(modifiedAt)
  );
}

/** Manifeste validé, ou null si le contenu est corrompu. */
function parseManifest(bytes: Uint8Array): PdfEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version, entries } = parsed as Record<string, unknown>;
    if (version !== MANIFEST_VERSION || !Array.isArray(entries) || !entries.every(isValidEntry)) return null;
    const paths = new Set(entries.map((e: PdfEntry) => e.path));
    if (paths.size !== entries.length) return null;
    return entries.map((e: PdfEntry) => ({ path: e.path, size: e.size, modifiedAt: e.modifiedAt }));
  } catch {
    return null;
  }
}

const serializeManifest = (entries: ReadonlyMap<string, PdfEntry>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version: MANIFEST_VERSION, entries: [...entries.values()] }));

function toPage(pageNumber: number, viewport: PdfViewportLike, content: { items: readonly unknown[] }): ExtractedPage {
  const items = content.items.filter(
    (item): item is TextItemLike => typeof (item as { str?: unknown } | null)?.str === "string",
  );
  return {
    pageNumber,
    viewportTransform: viewport.transform,
    viewWidth: viewport.width,
    viewHeight: viewport.height,
    items,
  };
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const listeners = new Set<(event: IndexerEvent) => void>();
  let run: Run | null = null;
  let paused = false;
  let lastSummary: IndexSummary | null = null;

  const emit = (event: IndexerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          deps.onListenerError?.(error);
        } catch {
          // un gestionnaire d'erreurs défaillant ne doit rien casser
        }
      }
    }
  };

  async function loadPrevious(): Promise<PdfEntry[]> {
    const bytes = await deps.store.read(MANIFEST_FILE_NAME);
    if (bytes === null) return [];
    return parseManifest(bytes) ?? [];
  }

  async function execute(runCtx: Run, force: ReadonlySet<string> | "all" | null): Promise<IndexSummary> {
    const counters: Counters = { indexed: 0, skippedScanned: 0, failed: 0, removed: 0 };
    const signal = runCtx.abort.signal;
    const summary = (): IndexSummary => ({ ...counters, cancelled: signal.aborted });
    emit({ type: "started" });
    try {
      await synchronize(runCtx, counters, force);
    } catch (error) {
      if (!signal.aborted) {
        counters.failed += 1;
        const path = error instanceof ManifestReadError ? MANIFEST_FILE_NAME : DISCOVERY_FAILURE_PATH;
        emit({ type: "failed", path, message: truncate(messageOf(error)) });
      }
    }
    const result = summary();
    lastSummary = result;
    run = null;
    emit({ type: "idle", summary: result });
    return result;
  }

  async function synchronize(runCtx: Run, counters: Counters, force: ReadonlySet<string> | "all" | null): Promise<void> {
    const signal = runCtx.abort.signal;
    const previous = await loadPrevious().catch((error: unknown) => {
      throw new ManifestReadError(messageOf(error));
    });
    throwIfAborted(signal);
    const discovered = await deps.discover();
    throwIfAborted(signal);

    let current = new Map<string, PdfEntry>(previous.map((e) => [e.path, e]));
    // Écritures du manifeste sérialisées ; le signal est revérifié juste avant chaque écriture.
    let chain: Promise<void> = Promise.resolve();
    const persist = (mutate: (next: Map<string, PdfEntry>) => void, jobSignal: AbortSignal): Promise<void> => {
      const task = chain.then(async () => {
        throwIfAborted(jobSignal);
        throwIfAborted(signal);
        const next = new Map(current);
        mutate(next);
        await deps.store.write(MANIFEST_FILE_NAME, serializeManifest(next));
        current = next;
      });
      chain = task.catch(() => undefined);
      return task;
    };

    const plan = planIndexUpdate(previous as Manifest, discovered);
    const forced = forcedEntries(discovered.manifest, force);
    const toIndex = [...plan.toIndex];
    for (const entry of forced) if (!toIndex.some((e) => e.path === entry.path)) toIndex.push(entry);

    if (plan.removalsAllowed) {
      for (const entry of plan.toRemove) {
        throwIfAborted(signal);
        await removeEntry(entry, signal, counters, persist);
      }
    }
    throwIfAborted(signal);
    await indexAll(runCtx, toIndex, counters, () => current, persist);
  }

  async function removeEntry(
    entry: PdfEntry,
    signal: AbortSignal,
    counters: Counters,
    persist: (m: (n: Map<string, PdfEntry>) => void, s: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      throwIfAborted(signal);
      await deps.store.remove(dsxName(entry));
      await persist((n) => n.delete(entry.path), signal);
      counters.removed += 1;
      emit({ type: "removed", path: entry.path });
    } catch (error) {
      if (signal.aborted) return;
      counters.failed += 1;
      emit({ type: "failed", path: entry.path, message: truncate(messageOf(error)) });
    }
  }

  async function indexAll(
    runCtx: Run,
    toIndex: readonly PdfEntry[],
    counters: Counters,
    currentEntries: () => ReadonlyMap<string, PdfEntry>,
    persist: (m: (n: Map<string, PdfEntry>) => void, s: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (toIndex.length === 0) return;
    const byPath = new Map(toIndex.map((e) => [e.path, e]));
    const runSignal = runCtx.abort.signal;

    const processOne = async (path: string, ctx: { signal: AbortSignal; reportProgress(d: number, t?: number): void }): Promise<void> => {
      const entry = byPath.get(path) as PdfEntry;
      const jobSignal = ctx.signal;
      const aborted = (): boolean => jobSignal.aborted || runSignal.aborted;
      const guard = (): void => {
        if (aborted()) throw abortError();
      };
      let doc: PdfDocumentLike | undefined;
      try {
        doc = await deps.loadPdf(path, jobSignal);
        guard();
        const total = doc.numPages;
        const pages: ExtractedPage[] = [];
        for (let n = 1; n <= total; n += 1) {
          const page = await doc.getPage(n);
          guard();
          const content = await page.getTextContent();
          guard();
          pages.push(toPage(n, page.getViewport({ scale: 1 }), content));
          ctx.reportProgress(n, total);
          emit({ type: "progress", path, page: n, total });
        }
        guard();
        const previousEntry = currentEntries().get(path);
        if (isLikelyScanned(pages)) {
          await persist((m) => m.set(path, entry), jobSignal);
          if (previousEntry !== undefined) await tryRemove(dsxName(previousEntry));
          counters.skippedScanned += 1;
          emit({ type: "skipped-scanned", path });
          return;
        }
        const index = buildDocumentIndex(
          {
            normalizerVersion: NORMALIZER_VERSION,
            extractorVersion: EXTRACTOR_VERSION,
            pdfSize: entry.size,
            pdfModifiedMs: entry.modifiedAt,
            sourcePath: path,
            pageCount: total,
          },
          pages,
        );
        const bytes = await encodeIndex(index);
        guard(); // dernier contrôle avant publication (RISQUE 4)
        await deps.store.write(dsxName(entry), bytes);
        await persist((m) => m.set(path, entry), jobSignal);
        if (previousEntry !== undefined && dsxName(previousEntry) !== dsxName(entry)) {
          await tryRemove(dsxName(previousEntry));
        }
        counters.indexed += 1;
        emit({ type: "indexed", path, pages: total });
      } catch (error) {
        if (!aborted()) {
          counters.failed += 1;
          emit({ type: "failed", path, message: truncate(messageOf(error)) });
        }
        throw error;
      } finally {
        if (doc !== undefined) {
          try {
            await doc.destroy();
          } catch {
            // la libération est au mieux ; elle ne doit pas masquer le résultat du traitement
          }
        }
      }
    };

    const queue = createIndexQueue({
      process: processOne,
      ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    });
    runCtx.queue = queue;
    if (paused) queue.pause();
    if (runSignal.aborted) return;
    for (const path of byPath.keys()) queue.enqueue(path);
    await queue.onIdle();
  }

  async function tryRemove(name: string): Promise<void> {
    try {
      await deps.store.remove(name);
    } catch {
      // fichier orphelin inoffensif : il ne doit pas faire échouer l'indexation réussie
    }
  }

  function begin(force: ReadonlySet<string> | "all" | null): Run {
    const abort = new AbortController();
    const runCtx: Run = { abort, queue: null, promise: Promise.resolve(EMPTY_SUMMARY) };
    run = runCtx; // publié avant `execute` : un listener de « started » voit déjà la synchronisation en cours
    runCtx.promise = execute(runCtx, force);
    return runCtx;
  }

  function startRun(force: ReadonlySet<string> | "all" | null): Promise<IndexSummary> {
    if (run !== null) return run.promise;
    return begin(force).promise;
  }

  return {
    start: () => (run !== null ? run.promise : startRun(null)),
    pause() {
      paused = true;
      run?.queue?.pause();
    },
    resume() {
      paused = false;
      run?.queue?.resume();
    },
    cancel() {
      if (run === null) return;
      run.abort.abort();
      const queue = run.queue;
      if (queue === null) return;
      const state = queue.state();
      for (const id of [...state.pending, ...state.running]) queue.cancel(id);
    },
    reindex(path) {
      const force: ReadonlySet<string> | "all" = path === undefined ? "all" : new Set([path]);
      if (run === null) return startRun(force);
      return run.promise.then(() => startRun(force));
    },
    getState() {
      const status = run === null ? "idle" : paused ? "paused" : "running";
      return { status, paused, queue: run?.queue?.state() ?? null, lastSummary };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

class ManifestReadError extends Error {
  constructor(message: string) {
    super(`Cannot read ${MANIFEST_FILE_NAME}: ${message}`);
    this.name = "ManifestReadError";
  }
}

function forcedEntries(manifest: Manifest, force: ReadonlySet<string> | "all" | null): readonly PdfEntry[] {
  if (force === null) return [];
  return force === "all" ? manifest : manifest.filter((e) => force.has(e.path));
}
