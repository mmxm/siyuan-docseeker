/**
 * Magasin de recherche : charge les `.dsx` du dossier `idx/` et tient à jour l'index BM25 global.
 *
 * - Seuls les noms finissant par `.dsx` sont pris en compte (manifest.json, .tmp, .bak sont ignorés).
 * - Décodage avec une concurrence de 2 ; chaque document est ajouté à l'index dès qu'il est décodé
 *   (résultats partiels) et les abonnés sont notifiés à chaque ajout. Les octets ne sont conservés
 *   que le temps du décodage.
 * - Un fichier illisible ou corrompu n'arrête pas le chargement : il est compté dans `failed`.
 * - `list()` ne renvoie que des noms (ni taille ni date) : `refresh()` n'invalide donc que par nom ;
 *   pour forcer la relecture d'un document modifié sur place, appeler `load()`.
 * - `load()` et `refresh()` sont sérialisés. L'annulation (AbortSignal) interrompt sans publier.
 * - Une erreur de `list()` met la phase à "error" et rejette la promesse.
 */
import type { Bm25Index } from "../core/bm25";
import type { SearchIndexData } from "../core/codec/format";
import { toBm25Index, withDocument, withoutDocument } from "../core/indexMerge";
import type { PetalStore } from "../siyuan/petalStore";

export type LoadPhase = "idle" | "loading" | "ready" | "error";

export interface LoadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly failed: readonly { name: string; message: string }[];
}

export interface DocInfo {
  readonly docId: string;
  readonly path: string;
  readonly title: string;
  readonly pageCount: number;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
}

export interface SearchStoreDeps {
  readonly store: Pick<PetalStore, "list" | "read">;
  readonly decode: (bytes: Uint8Array) => Promise<SearchIndexData>;
  readonly onWarn: (message: string, error?: unknown) => void;
}

export interface SearchStore {
  load(signal?: AbortSignal): Promise<void>;
  refresh(): Promise<void>;
  getIndex(): Bm25Index;
  getDoc(docId: string): DocInfo | undefined;
  listDocs(): readonly DocInfo[];
  getProgress(): LoadProgress;
  getPhase(): LoadPhase;
  subscribe(listener: () => void): () => void;
}

const DSX_SUFFIX = ".dsx";
const DECODE_CONCURRENCY = 2;
const SIYUAN_ID_SUFFIX = /-\d{14}-[a-z0-9]{7}$/i;
const PDF_EXTENSION = /\.pdf$/i;

export function titleOf(sourcePath: string, fallback: string): string {
  const base = sourcePath.split(/[\\/]/).pop() ?? "";
  const title = base.replace(PDF_EXTENSION, "").replace(SIYUAN_ID_SUFFIX, "");
  return title.length > 0 ? title : fallback;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createSearchStore(deps: SearchStoreDeps): SearchStore {
  const { store, decode, onWarn } = deps;
  let index: Bm25Index = toBm25Index([]);
  const docs = new Map<string, DocInfo>();
  let phase: LoadPhase = "idle";
  let progress: LoadProgress = { loaded: 0, total: 0, failed: [] };
  const listeners = new Set<() => void>();
  let queue: Promise<void> = Promise.resolve();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        onWarn("search store listener failed", error);
      }
    }
  };

  const infoOf = (docId: string, data: SearchIndexData): DocInfo => ({
    docId,
    path: data.sourcePath,
    title: titleOf(data.sourcePath, docId),
    pageCount: data.pageTermCounts.length,
    pdfSize: data.pdfSize,
    pdfModifiedMs: data.pdfModifiedMs,
  });

  async function loadOne(name: string, signal: AbortSignal | undefined): Promise<SearchIndexData | null> {
    const bytes = await store.read(name);
    if (bytes === null) throw new Error(`file not found: ${name}`);
    if (signal?.aborted) return null;
    return decode(bytes); // `bytes` n'est plus référencé dès le retour : libérable.
  }

  async function sync(full: boolean, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return;
    const previousPhase = phase;
    phase = "loading";
    notify();
    let names: readonly string[];
    try {
      names = (await store.list()).filter((n) => n.endsWith(DSX_SUFFIX) && n.length > DSX_SUFFIX.length);
    } catch (error) {
      phase = "error";
      notify();
      throw error;
    }
    if (signal?.aborted) {
      phase = previousPhase;
      notify();
      return;
    }
    const wanted = new Set(names.map((n) => n.slice(0, -DSX_SUFFIX.length)));
    let removed = false;
    for (const docId of [...docs.keys()]) {
      if (!wanted.has(docId)) {
        docs.delete(docId);
        index = withoutDocument(index, docId);
        removed = true;
      }
    }
    const failed: { name: string; message: string }[] = [];
    progress = { loaded: docs.size, total: names.length, failed };
    if (removed) notify();

    const todo = names.filter((n) => full || !docs.has(n.slice(0, -DSX_SUFFIX.length)));
    let cursor = 0;
    let aborted = false;
    const worker = async (): Promise<void> => {
      while (!aborted && cursor < todo.length) {
        const name = todo[cursor++] as string;
        const docId = name.slice(0, -DSX_SUFFIX.length);
        try {
          const data = await loadOne(name, signal);
          if (data === null || signal?.aborted) {
            aborted = true;
            return;
          }
          index = withDocument(index, docId, data);
          docs.set(docId, infoOf(docId, data));
        } catch (error) {
          if (signal?.aborted) {
            aborted = true;
            return;
          }
          failed.push({ name, message: messageOf(error) });
          onWarn(`could not load ${name}`, error);
        }
        progress = { loaded: docs.size, total: names.length, failed: [...failed] };
        notify();
      }
    };
    await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, todo.length) }, worker));

    if (aborted || signal?.aborted) {
      phase = previousPhase === "loading" ? "idle" : previousPhase;
    } else {
      progress = { loaded: docs.size, total: names.length, failed: [...failed] };
      phase = names.length > 0 && docs.size === 0 && failed.length > 0 ? "error" : "ready";
    }
    notify();
  }

  const enqueue = (full: boolean, signal?: AbortSignal): Promise<void> => {
    const run = queue.then(() => sync(full, signal));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    load: (signal) => enqueue(true, signal),
    refresh: () => enqueue(false),
    getIndex: () => index,
    getDoc: (docId) => docs.get(docId),
    listDocs: () => [...docs.values()],
    getProgress: () => progress,
    getPhase: () => phase,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
