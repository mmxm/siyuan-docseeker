/**
 * Contrôleur de recherche : logique pure (sans DOM). La recherche part à la
 * soumission explicite (`submit`), jamais à la frappe ; exécute la requête sur l'index de la source et produit un view-model.
 */
import { groupByDocument, searchPages, type Bm25Index } from "../core/bm25";
import type { ProximityResult } from "./proximityRanker";
import { isSearchable, titleBonuses } from "./queryMatch";
import { applyFilters, DEFAULT_OPTIONS, normalizeSearchOptions, sameOptions, type SearchOptions } from "./resultOptions";

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
      /** Documents trouvés mais masqués par les filtres (0 sans filtre). */
      readonly hiddenByFilters: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "results";
      readonly query: string;
      readonly docs: readonly ResultDoc[];
      readonly partial: boolean;
      readonly total: number;
      readonly failedCount: number;
      /** "proximity" dès qu'au moins une fenêtre du re-classement par proximité est appliquée. */
      readonly ranking: "bm25" | "proximity";
      /** Documents trouvés mais masqués par les filtres (0 sans filtre). */
      readonly hiddenByFilters: number;
    };

/** Re-classement par proximité (le `ProximityRanker`), injecté : le contrôleur ne connaît que ce port. */
export interface RerankPort {
  rank(
    query: string,
    docs: readonly ResultDoc[],
    options: { readonly signal?: AbortSignal; readonly onWindow?: (result: ProximityResult<ResultDoc>) => void },
  ): Promise<ProximityResult<ResultDoc>>;
}

export interface SearchControllerOptions {
  readonly source: SearchSource;
  readonly schedule: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
  readonly onChange: (viewModel: SearchViewModel) => void;
  /** Appelé avec l'erreur complète quand le calcul d'une requête échoue. */
  readonly onWarn?: (message: string, error?: unknown) => void;
  /** Fenêtre de coalescence des notifications du store pendant le chargement (défaut 150 ms). */
  readonly loadingRefreshMs?: number;
  /** Re-classement (proximité et police) de toute requête ; absent : ordre BM25 seul. */
  readonly rerank?: RerankPort;
  /** Options de départ (filtres, tri) ; en session seulement, jamais persistées. */
  readonly initialOptions?: SearchOptions;
}

export interface SearchController {
  /** Soumet la requête (touche Entrée) : lance la recherche tout de suite, même si c'est la même requête. */
  submit(query: string): void;
  /** Un document a été réindexé : relance proprement le re-classement de la requête courante (s'il y en a un). */
  invalidate(): void;
  /**
   * Change les filtres/le tri (action explicite). Relance la requête déjà soumise ; sans requête soumise,
   * l'option est seulement mémorisée.
   */
  setOptions(next: SearchOptions): void;
  /** Options courantes : objet gelé, à ne pas muter. */
  getOptions(): SearchOptions;
  getViewModel(): SearchViewModel;
  dispose(): void;
}

export const DEFAULT_LOADING_REFRESH_MS = 150;
/** Attente maximale de la fenêtre 1 du re-classement avant de publier l'ordre BM25. */
export const RERANK_GRACE_MS = 300;
const DEFAULT_ERROR_MESSAGE = "Impossible de charger l'index de recherche.";

const EMPTY: SearchViewModel = { kind: "empty-query" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalise puis gèle (sort et filters compris) : `getOptions` peut renvoyer l'état sans copie ni risque de mutation. */
function frozenOptions(input: unknown): SearchOptions {
  const o = normalizeSearchOptions(input);
  return Object.freeze({ sort: Object.freeze(o.sort), filters: Object.freeze(o.filters) });
}

function compute(source: SearchSource, query: string, options: SearchOptions): SearchViewModel {
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
  // Filtres après BM25 et AVANT le re-classement : sa fenêtre de documents ne contient aucun document exclu.
  const { kept, hidden } = applyFilters(docs, options.filters, (id) => source.getDoc(id));
  if (kept.length === 0) return { kind: "no-result", query, partial, failedCount, hiddenByFilters: hidden };
  return { kind: "results", query, docs: kept, partial, total: kept.length, failedCount, ranking: "bm25", hiddenByFilters: hidden };
}

/** Applique un résultat de re-classement à l'ordre BM25 : documents réordonnés, 5 premières pages réordonnées. */
function applyRanking(base: Extract<SearchViewModel, { kind: "results" }>, ranked: ProximityResult<ResultDoc>): SearchViewModel {
  const byId = new Map(base.docs.map((d) => [d.docId, d] as const));
  const seen = new Set<string>();
  const docs: ResultDoc[] = [];
  const push = (docId: string): void => {
    const original = byId.get(docId);
    if (!original || seen.has(docId)) return;
    seen.add(docId);
    const order = ranked.pagesOrderByDoc.get(docId);
    if (!order) {
      docs.push(original);
      return;
    }
    const byPage = new Map(original.pages.map((p) => [p.page, p] as const));
    const head = [...new Set(order)].flatMap((page) => byPage.get(page) ?? []);
    const placed = new Set(head.map((p) => p.page));
    docs.push({ ...original, pages: [...head, ...original.pages.filter((p) => !placed.has(p.page))] });
  };
  for (const d of ranked.docs) push(d.docId);
  for (const d of base.docs) push(d.docId); // filet : jamais de document perdu
  // « Affiné » seulement si une mesure a réussi ET que l'ordre (documents ou 5 premières pages) a vraiment changé.
  const measured = [...ranked.bonusByDoc.keys()].some((id) => !ranked.failedDocIds.has(id));
  const samePages = (a: ResultDoc, b: ResultDoc): boolean => a.pages.every((p, i) => p.page === b.pages[i]?.page);
  const changed = docs.some((d, i) => {
    const original = base.docs[i];
    return !original || d.docId !== original.docId || !samePages(d, original);
  });
  if (!measured || !changed) return base;
  return { ...base, docs, ranking: "proximity" };
}

export function createSearchController(options: SearchControllerOptions): SearchController {
  const {
    source,
    schedule,
    clear,
    onChange,
    onWarn,
    loadingRefreshMs = DEFAULT_LOADING_REFRESH_MS,
    rerank,
  } = options;
  let searchOptions: SearchOptions = frozenOptions(options.initialOptions ?? DEFAULT_OPTIONS);
  /** Dernière requête soumise (pas le texte en cours de frappe). */
  let query = "";
  let current: SearchViewModel = EMPTY;
  let coalescing: { handle: unknown } | undefined;
  let requestNumber = 0;
  let disposed = false;

  const cancelCoalescing = (): void => {
    if (coalescing) clear(coalescing.handle);
    coalescing = undefined;
  };

  type ResultsVm = Extract<SearchViewModel, { kind: "results" }>;
  let rerankAbort: AbortController | undefined;
  let rerankGrace: { handle: unknown } | undefined;
  /** BM25 du dernier run de re-classement pas encore publié : ce que la grâce publiera si la fenêtre 1 tarde. */
  let unpublished: ResultsVm | undefined;

  const abortInFlight = (): void => {
    rerankAbort?.abort();
    rerankAbort = undefined;
  };

  const clearGrace = (): void => {
    if (rerankGrace) clear(rerankGrace.handle);
    rerankGrace = undefined;
    unpublished = undefined;
  };

  const abortRerank = (): void => {
    abortInFlight();
    clearGrace();
  };

  const publish = (vm: SearchViewModel): void => {
    clearGrace(); // avant onChange : l'état reste cohérent même si le consommateur lève
    current = vm;
    onChange(vm);
  };

  /** Publication issue d'un callback asynchrone du re-classement : une exception est journalisée, jamais perdue. */
  const publishGuarded = (build: () => SearchViewModel): void => {
    try {
      publish(build());
    } catch (error) {
      onWarn?.("proximity reranking publication failed", error);
    }
  };

  const sameDocSet = (a: ResultsVm, b: SearchViewModel): boolean =>
    b.kind === "results" &&
    b.query === a.query &&
    b.docs.length === a.docs.length &&
    b.docs.every((d) => a.docs.some((x) => x.docId === d.docId));

  const startRerank = (base: ResultsVm, mine: number, port: RerankPort): void => {
    const controller = new AbortController();
    rerankAbort = controller;
    const isCurrent = (): boolean => !disposed && mine === requestNumber && !controller.signal.aborted;
    unpublished = base;
    if (!rerankGrace) {
      // La grâce court depuis la première demande restée sans publication : des runs rapprochés
      // (chargement, rafale d'invalidations) ne la repoussent pas.
      const slot: { handle: unknown } = { handle: undefined };
      slot.handle = schedule(() => {
        if (rerankGrace === slot) rerankGrace = undefined;
        const pendingBase = unpublished;
        unpublished = undefined;
        if (disposed || !pendingBase) return;
        // Une liste déjà affichée pour cette requête et ces documents n'est pas remplacée (pas de scintillement).
        if (sameDocSet(pendingBase, current)) return;
        publishGuarded(() => pendingBase);
      }, RERANK_GRACE_MS);
      rerankGrace = slot;
    }
    let firstSeen = false;
    let latest: ProximityResult<ResultDoc> | undefined;
    const apply = (ranked: ProximityResult<ResultDoc>): void => publishGuarded(() => applyRanking(base, ranked));
    const onWindow = (ranked: ProximityResult<ResultDoc>): void => {
      if (!isCurrent()) return;
      latest = ranked; // cumulatif : le plus récent contient tout
      if (firstSeen) apply(ranked);
    };
    let ranking: Promise<ProximityResult<ResultDoc>>;
    try {
      ranking = port.rank(base.query, base.docs, { signal: controller.signal, onWindow });
    } catch (error) {
      ranking = Promise.reject(error);
    }
    void ranking.then(
      (first) => {
        if (!isCurrent()) return;
        firstSeen = true;
        apply(latest ?? first);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        onWarn?.("proximity reranking failed; BM25 order kept", error);
        if (unpublished === base) publishGuarded(() => base);
      },
    );
  };

  const run = (): void => {
    const mine = ++requestNumber;
    abortInFlight();
    cancelCoalescing(); // ce run recalcule déjà tout : une relance coalescée en attente devient inutile
    let vm: SearchViewModel;
    try {
      vm = compute(source, query, searchOptions);
    } catch (error) {
      vm = { kind: "error", message: describeError(error) };
      onWarn?.("search failed", error);
    }
    if (disposed || mine !== requestNumber) return;
    // Pendant le chargement l'index change toutes les ~150 ms : un re-classement serait relancé (et son décodage
    // refait) à chaque fenêtre. On publie le BM25 partiel ; la fin du chargement relance le re-classement une fois.
    if (rerank && vm.kind === "results" && !vm.partial) {
      startRerank(vm, mine, rerank);
      return;
    }
    publish(vm);
  };

  const armCoalescing = (): void => {
    if (coalescing) return;
    const slot: { handle: unknown } = { handle: undefined };
    slot.handle = schedule(() => {
      if (coalescing === slot) coalescing = undefined;
      if (!disposed && isSearchable(query)) run();
    }, loadingRefreshMs);
    coalescing = slot;
  };

  const onSourceChange = (): void => {
    // Pas de requête soumise : rien à recalculer.
    if (disposed || !isSearchable(query)) return;
    if (source.getPhase() === "loading") {
      // Un document de plus toutes les quelques ms : une seule recherche par fenêtre.
      armCoalescing();
      return;
    }
    cancelCoalescing();
    run();
  };
  const unsubscribe = source.subscribe(onSourceChange);

  return {
    submit(next) {
      if (disposed) return;
      query = next;
      cancelCoalescing();
      abortRerank();
      if (!isSearchable(next)) {
        requestNumber++;
        current = EMPTY;
        onChange(EMPTY);
        return;
      }
      run();
    },
    invalidate() {
      if (disposed || !rerank || !isSearchable(query)) return;
      // Les mesures en vol portent sur l'ancien contenu : jamais de snapshot périmé publié.
      abortInFlight();
      unpublished = undefined;
      armCoalescing(); // une seule relance, même avec la notification du store qui suit
    },
    setOptions(next) {
      if (disposed) return;
      const normalized = frozenOptions(next);
      if (sameOptions(normalized, searchOptions)) return;
      searchOptions = normalized;
      if (!isSearchable(query)) return; // rien de soumis : l'option est seulement mémorisée
      cancelCoalescing();
      abortRerank();
      run();
    },
    getOptions: () => searchOptions,
    getViewModel: () => current,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelCoalescing();
      abortRerank();
      requestNumber++;
      unsubscribe();
    },
  };
}
