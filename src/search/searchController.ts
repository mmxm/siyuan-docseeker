/**
 * Contrôleur de recherche : logique pure (sans DOM). Débounce la saisie,
 * exécute la requête sur l'index de la source et produit un view-model.
 */
import { groupByDocument, searchPages, type Bm25Index } from "../core/bm25";
import { isSearchable, titleBonuses } from "./queryMatch";

export interface DocInfo {
  readonly docId: string;
  readonly path: string;
  readonly title: string;
  readonly pageCount: number;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
}

export interface LoadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly failed: readonly { readonly name: string; readonly message: string }[];
}

export type LoadPhase = "idle" | "loading" | "ready" | "error";

export interface SearchSource {
  getIndex(): Bm25Index;
  getDoc(docId: string): DocInfo | undefined;
  listDocs(): readonly DocInfo[];
  getProgress(): LoadProgress;
  getPhase(): LoadPhase;
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
  | { readonly kind: "no-result"; readonly query: string; readonly partial: boolean }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "results";
      readonly query: string;
      readonly docs: readonly ResultDoc[];
      readonly partial: boolean;
      readonly total: number;
    };

export interface SearchControllerOptions {
  readonly source: SearchSource;
  readonly schedule: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
  readonly debounceMs?: number;
  readonly onChange: (viewModel: SearchViewModel) => void;
}

export interface SearchController {
  setQuery(query: string): void;
  getViewModel(): SearchViewModel;
  dispose(): void;
}

export const DEFAULT_DEBOUNCE_MS = 200;

const EMPTY: SearchViewModel = { kind: "empty-query" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compute(source: SearchSource, query: string): SearchViewModel {
  if (!isSearchable(query)) return EMPTY;
  const phase = source.getPhase();
  const partial = phase === "loading";
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
  if (docs.length === 0) return { kind: "no-result", query, partial };
  return { kind: "results", query, docs, partial, total: docs.length };
}

export function createSearchController(options: SearchControllerOptions): SearchController {
  const { source, schedule, clear, onChange, debounceMs = DEFAULT_DEBOUNCE_MS } = options;
  let query = "";
  let current: SearchViewModel = EMPTY;
  let pending: { handle: unknown } | undefined;
  let requestNumber = 0;
  let disposed = false;

  const cancel = (): void => {
    if (pending) clear(pending.handle);
    pending = undefined;
  };

  const run = (): void => {
    const mine = ++requestNumber;
    let vm: SearchViewModel;
    try {
      vm = compute(source, query);
    } catch (error) {
      vm = { kind: "error", message: describeError(error) };
    }
    if (disposed || mine !== requestNumber) return;
    current = vm;
    onChange(vm);
  };

  const unsubscribe = source.subscribe(() => {
    if (disposed || !isSearchable(query)) return;
    cancel();
    run();
  });

  return {
    setQuery(next) {
      if (disposed) return;
      query = next;
      cancel();
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
      requestNumber++;
      unsubscribe();
    },
  };
}
