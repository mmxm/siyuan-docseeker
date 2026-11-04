/**
 * Contrôleur de recherche : logique pure (sans DOM). Débounce la saisie,
 * exécute la requête sur l'index de la source et produit un view-model.
 */
import { groupByDocument, searchPages, type Bm25Index } from "../core/bm25";
import { isSearchable, titleBonuses } from "./queryMatch";

import type { DocInfo, LoadPhase, LoadProgress } from "./searchStore";

// Une seule définition (celle du store), ré-exportée pour les consommateurs du contrôleur.
export type { DocInfo, LoadPhase, LoadProgress };

export interface SearchSource {
  getIndex(): Bm25Index;
  getDoc(docId: string): DocInfo | undefined;
  listDocs(): readonly DocInfo[];
  getProgress(): LoadProgress;
  getPhase(): LoadPhase;
  /** Dernière cause d'erreur connue (phase "error"). */
  getLastError(): string | undefined;
  subscribe(listener: () => void): () => void;
}

export interface ResultDoc {
  readonly docId: string;
  readonly title: string;
  readonly path: string;
  readonly matchingPages: number;
  readonly relevance: number;
  readonly pages: readonly { readonly page: number; readonly score: number }[];
}

export type SearchViewModel =
  | { readonly kind: "empty-query" }
  | { readonly kind: "no-index"; readonly indexing: boolean }
  | { readonly kind: "loading"; readonly progress: LoadProgress }
  | {
      readonly kind: "no-result";
      readonly query: string;
      readonly partial: boolean;
      /** Nombre de .dsx illisibles (résultats potentiellement incomplets). */
      readonly failedCount: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "results";
      readonly query: string;
      readonly docs: readonly ResultDoc[];
      readonly partial: boolean;
      readonly total: number;
      readonly failedCount: number;
    };

export interface SearchControllerOptions {
  readonly source: SearchSource;
  readonly schedule: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
  readonly debounceMs?: number;
  readonly onChange: (viewModel: SearchViewModel) => void;
  /** Appelé avec l'erreur complète quand le calcul d'une requête échoue. */
  readonly onWarn?: (message: string, error?: unknown) => void;
  /** Fenêtre de coalescence des notifications du store pendant le chargement (défaut 150 ms). */
  readonly loadingRefreshMs?: number;
}

export interface SearchController {
  setQuery(query: string): void;
  getViewModel(): SearchViewModel;
  dispose(): void;
}

export const DEFAULT_DEBOUNCE_MS = 200;
export const DEFAULT_LOADING_REFRESH_MS = 150;
const DEFAULT_ERROR_MESSAGE = "Impossible de charger l'index de recherche.";

const EMPTY: SearchViewModel = { kind: "empty-query" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compute(source: SearchSource, query: string): SearchViewModel {
  if (!isSearchable(query)) return EMPTY;
  const phase = source.getPhase();
  if (phase === "error") return { kind: "error", message: source.getLastError() ?? DEFAULT_ERROR_MESSAGE };
  const partial = phase === "loading";
  const failedCount = source.getProgress().failed.length;
  const index = source.getIndex();
  if (index.pageCount === 0) {
    if (partial) {
      const progress = source.getProgress();
      if (progress.total > 0) return { kind: "loading", progress };
    }
    return { kind: "no-index", indexing: partial };
  }
  const hits = searchPages(index, query);
  const grouped = groupByDocument(hits, { titleBonuses: titleBonuses(source.listDocs(), query) });
  const docs: ResultDoc[] = [];
  for (const hit of grouped) {
    const info = source.getDoc(hit.docId);
    if (!info) continue;
    docs.push({
      docId: hit.docId,
      title: info.title,
      path: info.path,
      matchingPages: hit.matchingPages,
      relevance: hit.relevance,
      pages: hit.pages.map(({ page, score }) => ({ page, score })),
    });
  }
  if (docs.length === 0) return { kind: "no-result", query, partial, failedCount };
  return { kind: "results", query, docs, partial, total: docs.length, failedCount };
}

export function createSearchController(options: SearchControllerOptions): SearchController {
  const {
    source,
    schedule,
    clear,
    onChange,
    onWarn,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    loadingRefreshMs = DEFAULT_LOADING_REFRESH_MS,
  } = options;
  let query = "";
  let current: SearchViewModel = EMPTY;
  let pending: { handle: unknown } | undefined;
  let coalescing: { handle: unknown } | undefined;
  let requestNumber = 0;
  let disposed = false;

  const cancel = (): void => {
    if (pending) clear(pending.handle);
    pending = undefined;
  };

  const cancelCoalescing = (): void => {
    if (coalescing) clear(coalescing.handle);
    coalescing = undefined;
  };

  const run = (): void => {
    const mine = ++requestNumber;
    let vm: SearchViewModel;
    try {
      vm = compute(source, query);
    } catch (error) {
      vm = { kind: "error", message: describeError(error) };
      onWarn?.("search failed", error);
    }
    if (disposed || mine !== requestNumber) return;
    current = vm;
    onChange(vm);
  };

  const unsubscribe = source.subscribe(() => {
    // Pas de requête active, ou saisie en cours (le débounce lancera la recherche) : rien à recalculer.
    if (disposed || !isSearchable(query) || pending) return;
    if (source.getPhase() === "loading") {
      // Un document de plus toutes les quelques ms : une seule recherche par fenêtre.
      if (coalescing) return;
      const slot: { handle: unknown } = { handle: undefined };
      slot.handle = schedule(() => {
        if (coalescing === slot) coalescing = undefined;
        if (!disposed && isSearchable(query)) run();
      }, loadingRefreshMs);
      coalescing = slot;
      return;
    }
    cancelCoalescing();
    run();
  });

  return {
    setQuery(next) {
      if (disposed) return;
      query = next;
      cancel();
      cancelCoalescing();
      if (!isSearchable(next)) {
        requestNumber++;
        current = EMPTY;
        onChange(EMPTY);
        return;
      }
      const slot: { handle: unknown } = { handle: undefined };
      slot.handle = schedule(() => {
        if (pending === slot) pending = undefined;
        run();
      }, debounceMs);
      pending = slot;
    },
    getViewModel: () => current,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      cancelCoalescing();
      requestNumber++;
      unsubscribe();
    },
  };
}
