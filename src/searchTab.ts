/**
 * Assemblage de l'onglet de recherche : câble les briques (index, contrôleur, correspondances par page,
 * rendu des vignettes, vue) et le clic vers l'ouverture du PDF surlignée. Tout est injecté : aucun accès
 * direct à `window`, au noyau ou à SiYuan (voir `index.ts` pour le câblage réel).
 */
import { decodeIndexForSearch, decodePageMatches as realDecodePageMatches } from "./core/codec/decode";
import { rectToPercentStyle, wordBoxesToPageRects, type PercentStyle } from "./core/crop";
import type { IndexerEvent } from "./indexer/indexer";
import { createPageMatchService } from "./search/pageMatches";
import { createSearchController } from "./search/searchController";
import { createSearchStore, type SearchStoreDeps } from "./search/searchStore";
import { IndexedDbThumbnailCache, type ThumbnailCache } from "./search/thumbnailCache";
import { openPdfAtPage as realOpenPdfAtPage, type OpenPdfOptions } from "./siyuan/openPdf";
import type { PetalStore } from "./siyuan/petalStore";
import { createPdfRenderer, type RenderableDocument, type RenderCanvas } from "./siyuan/pdfRenderer";
import { createThumbnailLoader, type ThumbnailObserver } from "./ui/thumbnailLoader";
import { mountSearchView } from "./ui/searchView";

export const DSX_SUFFIX = ".dsx";
export const REFRESH_DEBOUNCE_MS = 1000;
const THUMBNAIL_DOC_VERSION = 1;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MESSAGE_CLASS = "docseeker-message";

export interface SearchTabDeps {
  readonly store: Pick<PetalStore, "list" | "read">;
  readonly indexer: {
    onEvent(listener: (event: IndexerEvent) => void): () => void;
    start(): Promise<unknown>;
  };
  /** `openTab` de SiYuan et `app` du plugin, passés tels quels à `openPdfAtPage`. */
  readonly openTab: OpenPdfOptions["openTab"];
  readonly app: unknown;
  /** Charge un PDF pour le rendu des vignettes (PDF.js de SiYuan). */
  readonly loadDocument: (path: string, signal?: AbortSignal) => Promise<RenderableDocument>;
  readonly createCanvas: (width: number, height: number) => RenderCanvas;
  readonly onWarn: (message: string, error?: unknown) => void;
  readonly decode?: SearchStoreDeps["decode"];
  readonly decodePageMatches?: typeof realDecodePageMatches;
  readonly openPdfAtPage?: typeof realOpenPdfAtPage;
  readonly observerFactory?: (
    cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) => ThumbnailObserver;
  /** Cache de vignettes ; par défaut IndexedDB. */
  readonly cache?: ThumbnailCache;
  readonly indexedDB?: IDBFactory;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly clear?: (handle: unknown) => void;
  readonly refreshDebounceMs?: number;
  readonly t?: (key: string) => string;
}

export interface SearchTab {
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const HIGHLIGHT_UNAVAILABLE = "Surlignage indisponible";
const OBSERVER_ROOT_MARGIN = "200px 0px";
export const WARN_LOG_MAX = 50;

/** Message discret expliquant l'absence de surlignage, ou undefined (succès, ou ouverture remplacée). */
function describeHighlightProblem(report: { status?: string; keptRects?: number }): string | undefined {
  switch (report.status) {
    case "attached":
      return report.keptRects === 0 ? `${HIGHLIGHT_UNAVAILABLE} : aucun rectangle exploitable sur cette page.` : undefined;
    case "timeout":
      return `${HIGHLIGHT_UNAVAILABLE} : la page n'a pas été trouvée dans le visualiseur (délai dépassé).`;
    case "empty":
      return `${HIGHLIGHT_UNAVAILABLE} : aucun mot localisé sur cette page.`;
    case "disposed":
    case "superseded":
      return undefined;
    default:
      return `${HIGHLIGHT_UNAVAILABLE} : état inconnu.`;
  }
}

export interface WarnLog {
  /** Journalise (borné) puis relaie au `sink` (console par défaut). Ne lève jamais. */
  warn(message: string, error?: unknown): void;
  entries(): readonly string[];
  subscribe(listener: () => void): () => void;
}

/** Petit journal circulaire des avertissements, affiché dans la section « Avancé ». */
export function createWarnLog(
  options: { max?: number; sink?: (message: string, error?: unknown) => void } = {},
): WarnLog {
  const max = Math.max(1, options.max ?? WARN_LOG_MAX);
  const sink = options.sink ?? ((message, error) => console.warn(`[docseeker] ${message}`, error));
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  return {
    warn(message, error) {
      const stamp = new Date().toISOString().slice(11, 19);
      lines.push(`${stamp} ${message}${error === undefined ? "" : ` — ${messageOf(error)}`}`);
      if (lines.length > max) lines.splice(0, lines.length - max);
      try {
        sink(message, error);
      } catch {
        // un sink défaillant ne doit rien casser
      }
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // idem
        }
      }
    },
    entries: () => [...lines],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function mountSearchTab(host: HTMLElement, deps: SearchTabDeps): SearchTab {
  const { onWarn } = deps;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clear = deps.clear ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const openPdf = deps.openPdfAtPage ?? realOpenPdfAtPage;
  const lifetime = new AbortController();
  let disposed = false;

  const dsxStore: Pick<PetalStore, "list" | "read"> = {
    list: async () => (await deps.store.list()).filter((name) => name.endsWith(DSX_SUFFIX)),
    read: (name) => deps.store.read(name),
  };
  const searchStore = createSearchStore({
    store: dsxStore,
    decode: deps.decode ?? decodeIndexForSearch,
    onWarn,
  });
  const controllerListeners = new Set<() => void>();
  const controller = createSearchController({
    source: searchStore,
    schedule,
    clear,
    onChange: () => {
      for (const listener of [...controllerListeners]) listener();
    },
  });
  const pageMatches = createPageMatchService({
    readDsx: async (docId) => {
      const bytes = await deps.store.read(`${docId}${DSX_SUFFIX}`);
      if (!bytes) throw new Error(`Index introuvable pour ${docId}`);
      return bytes;
    },
    decode: deps.decodePageMatches ?? realDecodePageMatches,
  });
  const renderer = createPdfRenderer({
    loadDocument: deps.loadDocument,
    createCanvas: deps.createCanvas,
    onWarn,
  });
  const cache: ThumbnailCache =
    deps.cache ??
    new IndexedDbThumbnailCache({
      maxEntries: CACHE_MAX_ENTRIES,
      maxBytes: CACHE_MAX_BYTES,
      factory: deps.indexedDB,
      onWarn,
    });
  const loader = createThumbnailLoader({
    observerFactory:
      deps.observerFactory ??
      ((cb) => new IntersectionObserver((entries) => cb(entries), { rootMargin: OBSERVER_ROOT_MARGIN })),
    getPageMatches: (docId, page, query, signal) => pageMatches.getPageMatches(docId, page, query, signal),
    renderer,
    cache,
    docVersion: THUMBNAIL_DOC_VERSION,
    onWarn,
  });

  const messageEl = host.ownerDocument.createElement("div");
  messageEl.className = MESSAGE_CLASS;
  messageEl.setAttribute("role", "status");
  messageEl.setAttribute("aria-live", "polite");
  const showMessage = (text: string): void => {
    if (!disposed) messageEl.textContent = text;
  };

  let openController: AbortController | null = null;
  let lastOpened: { dispose(): void } | null = null;

  const open = async (docId: string, page: number, query: string): Promise<void> => {
    openController?.abort();
    const mine = new AbortController();
    openController = mine;
    const stale = (): boolean => disposed || mine.signal.aborted;
    showMessage("");
    const doc = searchStore.getDoc(docId);
    if (!doc) {
      showMessage("Document introuvable dans l'index : lancez une réindexation.");
      return;
    }
    let rects: PercentStyle[] = [];
    let issue: string | undefined;
    try {
      const match = await pageMatches.getPageMatches(docId, page, query, mine.signal);
      const boxes = match.ordinals.flatMap((ordinal) => {
        const box = match.boxes[ordinal];
        return box ? [box] : [];
      });
      // Les boîtes sont déjà des fractions de page : une page de 1 x 1 donne directement des pourcentages.
      rects = wordBoxesToPageRects(boxes, 1, 1).map((rect) => rectToPercentStyle(rect, 1, 1));
    } catch (error) {
      if (stale()) return;
      onWarn("Surlignage indisponible : la page s'ouvre sans calque", error);
      issue = `${HIGHLIGHT_UNAVAILABLE} : ${messageOf(error)}.`;
    }
    if (stale()) return;
    let handle: Awaited<ReturnType<typeof openPdf>>;
    try {
      handle = await openPdf({
        openTab: deps.openTab,
        app: deps.app,
        path: doc.path,
        page,
        rects,
        onWarn: (message) => onWarn(message),
      });
    } catch (error) {
      if (stale()) return;
      onWarn("Ouverture du PDF impossible", error);
      showMessage(`Impossible d'ouvrir ce PDF (${messageOf(error)}).`);
      return;
    }
    if (stale()) {
      handle.dispose();
      return;
    }
    lastOpened?.dispose();
    lastOpened = handle;
    if (issue) showMessage(issue);
    let report: Awaited<typeof handle.ready> | undefined;
    try {
      report = await handle.ready;
    } catch (error) {
      onWarn("État du surlignage inconnu", error);
    }
    if (stale() || !report) return;
    const problem = describeHighlightProblem(report);
    if (problem) showMessage(issue ?? problem);
  };

  const view = mountSearchView(host, {
    controller,
    subscribe: (listener) => {
      controllerListeners.add(listener);
      return () => controllerListeners.delete(listener);
    },
    thumbnails: loader,
    onOpen: (docId, page, query) => {
      void open(docId, page, query);
    },
    onReindex: () => {
      void deps.indexer.start().catch((error: unknown) => {
        onWarn("Réindexation en échec", error);
        showMessage(`Réindexation en échec : ${messageOf(error)}.`);
      });
    },
    getDocMeta: (docId) => {
      const info = searchStore.getDoc(docId);
      return info ? { pdfSize: info.pdfSize, pdfModifiedMs: info.pdfModifiedMs } : undefined;
    },
    ...(deps.t ? { t: deps.t } : {}),
  });
  host.append(messageEl);

  // Rafraîchissement de l'index sur événements de l'indexeur (débouncé).
  const debounceMs = deps.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS;
  let refreshHandle: unknown;
  let refreshTimerSet = false;
  const staleDocIds = new Set<string>();
  const invalidatePending = (): void => {
    for (const docId of staleDocIds) pageMatches.invalidate(docId);
  };
  const reloadPaths = new Set<string>();
  const runRefresh = (): void => {
    refreshTimerSet = false;
    if (disposed) return;
    const paths = [...reloadPaths];
    reloadPaths.clear();
    searchStore
      .refresh({ reloadPaths: paths, signal: lifetime.signal })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        onWarn("Rafraîchissement de l'index en échec", error);
        showMessage(`Rafraîchissement de l'index en échec : ${messageOf(error)}.`);
      })
      .finally(() => {
        invalidatePending();
        staleDocIds.clear();
      });
  };
  const unsubscribeIndexer = deps.indexer.onEvent((event) => {
    if (disposed || (event.type !== "indexed" && event.type !== "removed")) return;
    for (const info of searchStore.listDocs()) {
      if (info.path === event.path) staleDocIds.add(info.docId);
    }
    invalidatePending();
    if (event.type === "indexed") reloadPaths.add(event.path);
    if (refreshTimerSet) clear(refreshHandle);
    refreshTimerSet = true;
    refreshHandle = schedule(runRefresh, debounceMs);
  });

  void searchStore
    .load(lifetime.signal)
    .catch((error: unknown) => {
      if (lifetime.signal.aborted) return;
      onWarn("Chargement des index en échec", error);
      showMessage(`Chargement des index en échec : ${messageOf(error)}.`);
    });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      openController?.abort();
      if (refreshTimerSet) clear(refreshHandle);
      refreshTimerSet = false;
      unsubscribeIndexer();
      view.dispose();
      controller.dispose();
      loader.dispose();
      renderer.dispose();
      lastOpened?.dispose();
      lastOpened = null;
      controllerListeners.clear();
      messageEl.remove();
    },
  };
}
