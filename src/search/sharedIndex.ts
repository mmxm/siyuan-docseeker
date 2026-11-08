/**
 * Index de recherche partagé par tous les onglets : un seul `SearchStore`, chargé une fois (en arrière-plan,
 * dès le démarrage du plugin) et rafraîchi une seule fois (débouncé) sur les événements de l'indexeur.
 *
 * - `start()` est idempotent : le chargement n'a lieu qu'une fois, quel que soit le nombre d'appels/onglets.
 * - Un échec de chargement ou de rafraîchissement est journalisé (`onWarn`) et exposé via `getError()` /
 *   `onStatus()` pour que les onglets l'affichent. Une annulation (`dispose`) n'est pas une erreur.
 * - `onInvalidate` signale aux onglets les `docId` dont les correspondances par page sont périmées
 *   (immédiatement à l'événement, puis une seconde fois à la fin du rafraîchissement).
 * - `dispose()` annule le chargement/rafraîchissement, la minuterie et l'abonnement à l'indexeur.
 */
import type { SearchIndexData } from "../core/codec/format";
import type { IndexerEvent } from "../indexer/indexer";
import type { PetalStore } from "../siyuan/petalStore";
import { createSearchStore, type SearchStore } from "./searchStore";

export const DSX_SUFFIX = ".dsx";
export const REFRESH_DEBOUNCE_MS = 1000;

type ReadableStore = Pick<PetalStore, "list" | "read">;

/** Vue du dossier d'index qui ne montre que les `.dsx` (ignore manifest.json, .tmp, .bak...). */
export function createDsxStore(store: ReadableStore): ReadableStore {
  return {
    list: async () => (await store.list()).filter((name) => name.endsWith(DSX_SUFFIX)),
    read: (name) => store.read(name),
  };
}

export interface SharedIndexDeps {
  readonly store: ReadableStore;
  readonly decode: (bytes: Uint8Array) => Promise<SearchIndexData>;
  readonly indexer: { onEvent(listener: (event: IndexerEvent) => void): () => void };
  readonly onWarn: (message: string, error?: unknown) => void;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly clear?: (handle: unknown) => void;
  readonly refreshDebounceMs?: number;
  /** Décodages d'index en parallèle (profil de plateforme) ; défaut : celui du magasin. */
  readonly decodeConcurrency?: number;
}

export interface SharedIndex {
  readonly store: SearchStore;
  /** Lance le chargement (une seule fois). La promesse ne rejette jamais : l'échec passe par `getError()`. */
  start(): Promise<void>;
  /** Dernier échec de chargement/rafraîchissement (message affichable), effacé au succès suivant. */
  getError(): string | undefined;
  /**
   * Relit la liste des `.dsx` tout de suite (après un vidage de l'index) : invalide les correspondances par
   * page de tous les documents connus, efface ou expose l'erreur. Rejette si le rafraîchissement échoue
   * (déjà journalisé et exposé via `getError()`). Sans effet après `dispose()`.
   */
  refreshNow(): Promise<void>;
  onStatus(listener: () => void): () => void;
  onInvalidate(listener: (docIds: readonly string[]) => void): () => void;
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createSharedIndex(deps: SharedIndexDeps): SharedIndex {
  const { onWarn } = deps;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clear = deps.clear ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const debounceMs = deps.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS;
  const lifetime = new AbortController();
  const store = createSearchStore({
    store: createDsxStore(deps.store),
    decode: deps.decode,
    onWarn,
    ...(deps.decodeConcurrency === undefined ? {} : { decodeConcurrency: deps.decodeConcurrency }),
  });
  const statusListeners = new Set<() => void>();
  const invalidateListeners = new Set<(docIds: readonly string[]) => void>();
  let disposed = false;
  let started: Promise<void> | undefined;
  let unsubscribeIndexer: (() => void) | undefined;
  let error: string | undefined;
  let refreshHandle: unknown;
  let refreshTimerSet = false;
  const reloadPaths = new Set<string>();

  const emit = <A extends unknown[]>(listeners: ReadonlySet<(...args: A) => void>, ...args: A): void => {
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch (cause) {
        warn("Écouteur de l'index partagé en échec", cause);
      }
    }
  };
  const stateError = (): string | undefined => {
    if (error !== undefined) return error;
    if (store.getPhase() !== "error") return undefined;
    const cause = store.getLastError();
    return `Chargement des index en échec : ${cause ?? "aucun index lisible"}.`;
  };
  let shown: string | undefined;
  /** Notifie si l'erreur visible (propre ou dérivée du store) a changé depuis la dernière notification. */
  const syncStatus = (): void => {
    const now = stateError();
    if (now === shown) return;
    shown = now;
    emit(statusListeners);
  };
  const setError = (next: string | undefined): void => {
    error = next;
    syncStatus();
  };
  const warn = (message: string, cause?: unknown): void => {
    try {
      onWarn(message, cause);
    } catch {
      // un journal défaillant ne doit rien casser
    }
  };
  /** Version de péremption par docId : un événement survenu pendant un refresh garde le docId périmé. */
  const staleVersions = new Map<string, number>();
  let staleCounter = 0;
  const markStale = (docId: string): void => {
    staleVersions.set(docId, ++staleCounter);
  };

  const runRefresh = (): void => {
    refreshTimerSet = false;
    if (disposed) return;
    const paths = [...reloadPaths];
    reloadPaths.clear();
    const mine = new Map(staleVersions);
    store
      .refresh({ reloadPaths: paths, signal: lifetime.signal })
      .then(
        () => {
          if (!lifetime.signal.aborted) setError(undefined);
        },
        (cause: unknown) => {
          if (lifetime.signal.aborted) return;
          for (const path of paths) reloadPaths.add(path);
          warn("Rafraîchissement de l'index en échec", cause);
          setError(`Rafraîchissement de l'index en échec : ${messageOf(cause)}.`);
        },
      )
      .finally(() => {
        if (mine.size > 0) emit(invalidateListeners, [...mine.keys()]);
        for (const [docId, version] of mine) {
          if (staleVersions.get(docId) === version) staleVersions.delete(docId);
        }
      })
      .catch((cause: unknown) => warn("Rafraîchissement de l'index : erreur inattendue", cause));
  };

  const onIndexerEvent = (event: IndexerEvent): void => {
    if (disposed || (event.type !== "indexed" && event.type !== "removed")) return;
    const fresh: string[] = [];
    for (const info of store.listDocs()) {
      if (info.path === event.path) {
        markStale(info.docId);
        fresh.push(info.docId);
      }
    }
    if (fresh.length > 0) emit(invalidateListeners, fresh);
    if (event.type === "indexed") reloadPaths.add(event.path);
    if (refreshTimerSet) clear(refreshHandle);
    refreshTimerSet = true;
    refreshHandle = schedule(runRefresh, debounceMs);
  };

  return {
    store,
    start() {
      if (disposed) return Promise.resolve();
      if (started) return started;
      if (!unsubscribeIndexer) {
        try {
          unsubscribeIndexer = deps.indexer.onEvent(onIndexerEvent);
        } catch (cause) {
          warn("Abonnement à l'indexeur en échec", cause);
          setError(`Abonnement à l'indexeur en échec : ${messageOf(cause)}.`);
          return Promise.resolve(); // retenté au prochain start()
        }
      }
      const run: Promise<void> = store.load(lifetime.signal).then(
        () => {
          if (!lifetime.signal.aborted) setError(undefined);
        },
        (cause: unknown) => {
          if (lifetime.signal.aborted) return;
          if (started === run) started = undefined; // permet de retenter
          warn("Chargement des index en échec", cause);
          setError(`Chargement des index en échec : ${messageOf(cause)}.`);
        },
      );
      started = run;
      return run;
    },
    getError: stateError,
    async refreshNow() {
      if (disposed) return;
      const ids = store.listDocs().map((info) => info.docId);
      if (ids.length > 0) emit(invalidateListeners, ids);
      try {
        await store.refresh({ reloadPaths: [], signal: lifetime.signal });
        if (!lifetime.signal.aborted) setError(undefined);
      } catch (cause) {
        if (lifetime.signal.aborted) return;
        warn("Rafraîchissement de l'index en échec", cause);
        setError(`Rafraîchissement de l'index en échec : ${messageOf(cause)}.`);
        throw cause;
      } finally {
        if (!lifetime.signal.aborted && ids.length > 0) emit(invalidateListeners, ids);
      }
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onInvalidate(listener) {
      invalidateListeners.add(listener);
      return () => invalidateListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      if (refreshTimerSet) clear(refreshHandle);
      refreshTimerSet = false;
      unsubscribeIndexer?.();
      unsubscribeIndexer = undefined;
      statusListeners.clear();
      invalidateListeners.clear();
    },
  };
}
