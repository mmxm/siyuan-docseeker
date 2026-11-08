/**
 * Magasin de recherche : charge les `.dsx` du dossier `idx/` et tient à jour l'index BM25 global.
 *
 * - Seuls les noms finissant par `.dsx` sont pris en compte (manifest.json, .tmp, .bak sont ignorés).
 * - Décodage avec une concurrence de 2 par défaut (`decodeConcurrency`) ; chaque document est ajouté à l'index dès qu'il est décodé
 *   (résultats partiels) et les abonnés sont notifiés à chaque ajout. Les octets ne sont conservés
 *   que le temps du décodage.
 * - Un fichier illisible ou corrompu n'arrête pas le chargement : il est compté dans `failed`.
 * - `list()` ne renvoie que des noms (ni taille ni date) : `refresh()` n'invalide donc que par nom ;
 *   `refresh({ reloadPaths })` force en plus la relecture des documents dont `DocInfo.path` en fait partie
 *   (PDF réindexé sur place : même nom de .dsx). `load()` relit tout.
 * - `load()` et `refresh()` sont sérialisés. L'annulation (AbortSignal) interrompt sans publier.
 * - `load()` passe la phase à "loading" (résultats partiels visibles). `refresh()` garde "ready" quand
 *   l'index est déjà chargé : il met l'index à jour sans état de chargement visible.
 * - Une erreur de `list()` met la phase à "error" et rejette la promesse (pour un refresh d'un index déjà
 *   "ready", la phase reste "ready" : l'index chargé reste utilisable). `getLastError()` garde la dernière cause.
 * - Les tableaux typés renvoyés par `decode` sont cédés à l'index sans copie : `decode` doit renvoyer des
 *   tampons neufs à chaque appel.
 */
import { DEFAULT_DECODE_CONCURRENCY } from "../core/constants";
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
  /** Doit renvoyer des tableaux neufs : l'index les conserve sans copie. */
  readonly decode: (bytes: Uint8Array) => Promise<SearchIndexData>;
  readonly onWarn: (message: string, error?: unknown) => void;
  /** Décodages en parallèle (au moins 1) ; défaut : 2, la valeur historique du bureau. */
  readonly decodeConcurrency?: number;
}

export interface RefreshOptions {
  /** Documents (DocInfo.path) à relire même si leur nom de .dsx est déjà connu. */
  readonly reloadPaths?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SearchStore {
  load(signal?: AbortSignal): Promise<void>;
  refresh(options?: RefreshOptions): Promise<void>;
  getIndex(): Bm25Index;
  getDoc(docId: string): DocInfo | undefined;
  listDocs(): readonly DocInfo[];
  getProgress(): LoadProgress;
  getPhase(): LoadPhase;
  /** Dernière cause d'erreur connue (list() en échec, ou dernier .dsx illisible quand tout échoue) ; effacée au succès. */
  getLastError(): string | undefined;
  subscribe(listener: () => void): () => void;
}

const DSX_SUFFIX = ".dsx";
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
  const requested = deps.decodeConcurrency;
  // Valeur absente : défaut sans bruit ; valeur invalide (NaN, infinie, < 1) : repli signalé, jamais silencieux.
  if (requested !== undefined && !(Number.isFinite(requested) && requested >= 1)) {
    onWarn(`decodeConcurrency invalide (${String(requested)}) : ${Number.isFinite(requested) ? "ramenée à 1" : `défaut ${DEFAULT_DECODE_CONCURRENCY} utilisé`}`);
  }
  const decodeConcurrency = requested === undefined || !Number.isFinite(requested) ? DEFAULT_DECODE_CONCURRENCY : Math.max(1, Math.floor(requested));
  let index: Bm25Index = toBm25Index([]);
  const docs = new Map<string, DocInfo>();
  let phase: LoadPhase = "idle";
  let progress: LoadProgress = { loaded: 0, total: 0, failed: [] };
  let lastError: string | undefined;
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

  async function sync(
    full: boolean,
    signal: AbortSignal | undefined,
    reloadPaths: ReadonlySet<string>,
  ): Promise<void> {
    if (signal?.aborted) return;
    const previousPhase = phase;
    // Un refresh d'un index déjà chargé ne montre pas d'état "loading" : les résultats restent affichés.
    const quiet = !full && previousPhase === "ready";
    if (!quiet) {
      phase = "loading";
      notify();
    }
    let names: readonly string[];
    try {
      names = (await store.list()).filter((n) => n.endsWith(DSX_SUFFIX) && n.length > DSX_SUFFIX.length);
    } catch (error) {
      lastError = messageOf(error);
      phase = quiet ? previousPhase : "error";
      notify();
      throw error;
    }
    if (signal?.aborted) {
      phase = previousPhase;
      if (!quiet) notify();
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

    const todo = names.filter((n) => {
      const known = docs.get(n.slice(0, -DSX_SUFFIX.length));
      return full || known === undefined || reloadPaths.has(known.path);
    });
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
          index = withDocument(index, docId, data, { owned: true });
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
    await Promise.all(Array.from({ length: Math.min(decodeConcurrency, todo.length) }, worker));

    if (aborted || signal?.aborted) {
      phase = previousPhase === "loading" ? "idle" : previousPhase;
    } else {
      progress = { loaded: docs.size, total: names.length, failed: [...failed] };
      const allFailed = names.length > 0 && docs.size === 0 && failed.length > 0;
      phase = allFailed ? "error" : "ready";
      lastError = allFailed ? failed[failed.length - 1]?.message : undefined;
    }
    notify();
  }

  const enqueue = (full: boolean, signal?: AbortSignal, reloadPaths: readonly string[] = []): Promise<void> => {
    const run = queue.then(() => sync(full, signal, new Set(reloadPaths)));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    load: (signal) => enqueue(true, signal),
    refresh: (options) => enqueue(false, options?.signal, options?.reloadPaths),
    getIndex: () => index,
    getDoc: (docId) => docs.get(docId),
    listDocs: () => [...docs.values()],
    getProgress: () => progress,
    getPhase: () => phase,
    getLastError: () => lastError,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
