/**
 * Assemblage de l'onglet de recherche : câble les briques (index, contrôleur, correspondances par page,
 * rendu des vignettes, vue) et le clic vers l'ouverture du PDF surlignée. Tout est injecté : aucun accès
 * direct à `window`, au noyau ou à SiYuan (voir `index.ts` pour le câblage réel).
 */
import type { IndexActivitySnapshot } from "./indexer/indexActivity";
import { decodePageMatches as realDecodePageMatches, decodePagesMatches as realDecodePagesMatches } from "./core/codec/decode";
import { rectToPercentStyle, wordBoxesToPageRects, type FractionBox, type PercentStyle } from "./core/crop";
import { createPageMatchService } from "./search/pageMatches";
import { createProximityRanker } from "./search/proximityRanker";
import { DEFAULT_OPTIONS, isProposedSort, listFolders } from "./search/resultOptions";
import { createSearchController } from "./search/searchController";
import { addToHistory, clearHistory, removeFromHistory } from "./search/searchHistory";
import { DSX_SUFFIX, type SharedIndex } from "./search/sharedIndex";
import { planFocusOrdinal } from "./search/thumbnailPlan";
import { IndexedDbThumbnailCache, type ThumbnailCache } from "./search/thumbnailCache";
import { openPdfAtPage as realOpenPdfAtPage, type OpenPdfOptions } from "./siyuan/openPdf";
import type { PetalStore } from "./siyuan/petalStore";
import { createPdfRenderer, type RenderableDocument, type RenderCanvas } from "./siyuan/pdfRenderer";
import { createThumbnailLoader, type ThumbnailObserver } from "./ui/thumbnailLoader";
import type { DocSeekerSettings } from "./settings";
import { mountSearchView } from "./ui/searchView";

export { DSX_SUFFIX, REFRESH_DEBOUNCE_MS } from "./search/sharedIndex";
const THUMBNAIL_DOC_VERSION = 2; // 2 : cadrage par termes distincts (le recadrage mis en cache change)
const CACHE_MAX_ENTRIES = 2000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MESSAGE_CLASS = "docseeker-message";
const ERROR_CLASS = "docseeker-error";

export interface SearchTabDeps {
  /** Lecture des `.dsx` pour les correspondances par page (le chargement de l'index n'est pas ici). */
  readonly store: Pick<PetalStore, "read">;
  /** Index partagé entre onglets, créé et chargé par le plugin : l'onglet ne le charge ni ne le libère. */
  readonly sharedIndex: SharedIndex;
  /** Ouvre le panneau de paramètres du plugin (indexation, index, diagnostic). */
  readonly onOpenSettings?: () => void;
  /** `openTab` de SiYuan et `app` du plugin, passés tels quels à `openPdfAtPage`. */
  readonly openTab: OpenPdfOptions["openTab"];
  readonly app: unknown;
  /** Charge un PDF pour le rendu des vignettes (PDF.js de SiYuan). */
  readonly loadDocument: (path: string, signal?: AbortSignal) => Promise<RenderableDocument>;
  readonly createCanvas: (width: number, height: number) => RenderCanvas;
  readonly onWarn: (message: string, error?: unknown) => void;
  /** Activité d'indexation pour l'indicateur discret (fournie par le plugin ; l'onglet ne voit pas l'indexeur). */
  readonly indexActivity?: {
    getSnapshot(): IndexActivitySnapshot;
    subscribe(listener: () => void): () => void;
  };
  readonly decodePageMatches?: typeof realDecodePageMatches;
  /** Décodeur multi-pages du re-classement ; absent avec un `decodePageMatches` injecté : repli page par page. */
  readonly decodePagesMatches?: typeof realDecodePagesMatches;
  readonly openPdfAtPage?: typeof realOpenPdfAtPage;
  readonly observerFactory?: (
    cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) => ThumbnailObserver;
  /** Cache de vignettes ; par défaut IndexedDB. */
  readonly cache?: ThumbnailCache;
  readonly indexedDB?: IDBFactory;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly clear?: (handle: unknown) => void;
  readonly t?: (key: string) => string;
  /**
   * Réglages persistés : le tri et le regroupement y sont lus au montage et réécrits à chaque changement.
   * Si le fichier n'est pas encore lu au montage (`ready` en attente), l'onglet démarre avec les défauts puis applique
   * UNE fois les valeurs lues, sauf pour un réglage que l'utilisateur a déjà changé entre-temps.
   * L'historique des requêtes suit la même discipline (une requête soumise avant la fin de la lecture est fusionnée
   * avec l'historique lu, jamais écrite par-dessus) mais se lit toujours dans `get()` une fois le fichier lu.
   * Les filtres n'y vont jamais ; l'onglet ne s'abonne pas aux changements externes.
   */
  readonly settings?: {
    get(): DocSeekerSettings;
    update(patch: Partial<DocSeekerSettings>): Promise<void>;
    readonly ready?: Promise<void>;
  };
}

export interface SearchTab {
  dispose(): void;
  /** Met le focus sur le champ de recherche (commande « Aller au champ de recherche PDF »). `false` : onglet fermé ou focus refusé. */
  focusInput(): boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const DOC_NOT_FOUND = "Document introuvable dans l'index : voir les paramètres du plugin.";
const HIGHLIGHT_UNAVAILABLE = "Surlignage indisponible";
const SETTING_NOT_SAVED = "Réglage non enregistré";
/** Durée d'affichage du message « Réglage non enregistré ». */
const FLASH_MESSAGE_MS = 5000;
const OBSERVER_ROOT_MARGIN = "200px 0px";
const PAGE_SIZE_WAIT_MS = 400;

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
  options: { max?: number; sink?: (message: string, error?: unknown) => void; now?: () => Date } = {},
): WarnLog {
  const max = Math.max(1, options.max ?? WARN_LOG_MAX);
  const sink = options.sink ?? ((message, error) => console.warn(`[docseeker] ${message}`, error));
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  return {
    warn(message, error) {
      const d = (options.now ?? (() => new Date()))();
      const two = (n: number): string => String(n).padStart(2, "0");
      const stamp = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; // heure locale
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
  let disposed = false;

  const searchStore = deps.sharedIndex.store;
  const saved = deps.settings?.get();
  /** Mémorise un réglage ; un échec (synchrone ou non) est journalisé, jamais avalé. */
  const persist = (what: string, patch: Partial<DocSeekerSettings>): void => {
    const settings = deps.settings;
    if (!settings) return;
    const fail = (error: unknown): void => {
      onWarn(`Réglage « ${what} » non enregistré`, error);
      flashMessage(deps.t?.("settingNotSaved") ?? SETTING_NOT_SAVED); // retour visible et bref, en plus du journal
    };
    try {
      settings.update(patch).catch(fail);
    } catch (error) {
      fail(error);
    }
  };
  /**
   * Écriture de l'historique, à chaque soumission : un échec persistant (disque plein) n'est journalisé qu'une fois
   * tant qu'il dure, et ne fait pas clignoter la zone de messages (l'historique n'est pas un réglage visible).
   */
  let historyWriteFailing = false;
  const persistHistory = (history: string[]): void => {
    const settings = deps.settings;
    if (!settings) return;
    const fail = (error: unknown): void => {
      if (historyWriteFailing) return;
      historyWriteFailing = true;
      onWarn("Historique des requêtes non enregistré", error);
    };
    try {
      settings.update({ history }).then(() => {
        historyWriteFailing = false;
      }, fail);
    } catch (error) {
      fail(error);
    }
  };
  /** Réglages que l'utilisateur a changés lui-même : la lecture tardive du fichier ne les écrase pas. */
  let sortTouched = false;
  let groupTouched = false;
  // Historique des requêtes : avant la fin de la lecture du fichier, copie locale + opérations rejouées sur l'historique lu.
  type HistoryOp = (history: readonly string[]) => string[];
  let historyLoaded = deps.settings?.ready === undefined;
  /** Lecture des réglages en échec : l'historique reste en mémoire pour la session, jamais écrit (le fichier est illisible). */
  let historyReadFailed = false;
  let localHistory: readonly string[] = [...(saved?.history ?? [])];
  const pendingHistoryOps: HistoryOp[] = [];
  const currentHistory = (): readonly string[] =>
    historyLoaded && deps.settings ? (deps.settings.get().history ?? []) : localHistory;
  const editHistory = (op: HistoryOp): void => {
    if (disposed) return;
    const next = op(currentHistory());
    if (!historyLoaded) {
      if (!historyReadFailed) pendingHistoryOps.push(op);
      localHistory = next;
      return;
    }
    if (!deps.settings) localHistory = next; // sans réglages, la copie locale est la seule source
    persistHistory(next);
  };
  const controllerListeners = new Set<() => void>();
  const pageMatches = createPageMatchService({
    readDsx: async (docId) => {
      const bytes = await deps.store.read(`${docId}${DSX_SUFFIX}`);
      if (!bytes) throw new Error(`Index introuvable pour ${docId}`);
      return bytes;
    },
    decode: deps.decodePageMatches ?? realDecodePageMatches,
    ...((deps.decodePagesMatches ?? (deps.decodePageMatches ? undefined : realDecodePagesMatches))
      ? { decodePages: (deps.decodePagesMatches ?? realDecodePagesMatches) }
      : {}),
  });
  const ranker = createProximityRanker({
    getPagesMatches: (docId, pages, query, signal) => pageMatches.getPagesMatches(docId, pages, query, signal),
    onWarn,
  });
  const controller = createSearchController({
    source: searchStore,
    schedule,
    clear,
    onChange: () => {
      for (const listener of [...controllerListeners]) listener();
    },
    onWarn,
    rerank: ranker,
    ...(saved ? { initialOptions: { ...DEFAULT_OPTIONS, sort: saved.sort } } : {}),
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

  const statusRegion = (className: string): HTMLElement => {
    const el = host.ownerDocument.createElement("div");
    el.className = className;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    return el;
  };
  // Deux régions distinctes : l'erreur d'index partagée (dérivée de l'état courant) et les messages d'action.
  const errorEl = statusRegion(ERROR_CLASS);
  const messageEl = statusRegion(MESSAGE_CLASS);
  const showMessage = (text: string): void => {
    if (!disposed) messageEl.textContent = text;
  };

  let flashHandle: unknown;
  let hasFlash = false;
  /** Message bref dans la zone de messages existante ; il s'éteint seul, sans effacer un message plus récent. */
  function flashMessage(text: string): void {
    if (disposed) return;
    showMessage(text);
    if (hasFlash) clear(flashHandle);
    hasFlash = true;
    flashHandle = schedule(() => {
      hasFlash = false;
      if (!disposed && messageEl.textContent === text) messageEl.textContent = "";
    }, FLASH_MESSAGE_MS);
  }

  let openController: AbortController | null = null;
  let lastOpened: { dispose(): void } | null = null;

  // Attente bornée : getPageSize passe par la file partagée du renderer (peut charger tout le PDF).
  const boundedPageSize = (path: string, page: number, signal: AbortSignal): Promise<{ width: number; height: number }> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`taille de page non reçue en ${PAGE_SIZE_WAIT_MS} ms`));
      }, PAGE_SIZE_WAIT_MS);
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clear(timer);
        fn();
      };
      signal.addEventListener("abort", () => finish(() => reject(new Error("annulé"))), { once: true });
      // La promesse perdante est toujours consommée : jamais de rejet non géré.
      renderer.getPageSize(path, page, signal).then(
        (size) => finish(() => resolve(size)),
        (error: unknown) => finish(() => reject(error)),
      );
    });

  // Même zone que la vignette (planThumbnail, même taille de page) ; repli sur le premier rectangle.
  const findFocusIndex = async (
    path: string,
    page: number,
    match: { boxes: readonly FractionBox[]; ordinals: readonly number[]; termIndexes?: readonly number[] },
    kept: readonly number[],
    signal: AbortSignal,
  ): Promise<number> => {
    try {
      const size = await boundedPageSize(path, page, signal);
      const ordinal = planFocusOrdinal(
        match.boxes,
        match.ordinals,
        size,
        match.termIndexes ? { termIndexes: match.termIndexes } : {},
      );
      return Math.max(0, ordinal === undefined ? 0 : kept.indexOf(ordinal));
    } catch (error) {
      if (!signal.aborted) onWarn("Zone du surlignage non déterminée : défilement sur le premier mot", error);
      return 0;
    }
  };

  const open = async (docId: string, page: number, query: string, alternate: boolean): Promise<void> => {
    openController?.abort();
    const mine = new AbortController();
    openController = mine;
    const stale = (): boolean => disposed || mine.signal.aborted;
    showMessage("");
    const doc = searchStore.getDoc(docId);
    if (!doc) {
      showMessage(deps.t?.("docNotFound") ?? DOC_NOT_FOUND);
      return;
    }
    let rects: PercentStyle[] = [];
    let focusIndex = 0;
    let issue: string | undefined;
    try {
      const match = await pageMatches.getPageMatches(docId, page, query, mine.signal);
      const kept = match.ordinals.filter((ordinal) => match.boxes[ordinal] !== undefined);
      const boxes = kept.map((ordinal) => match.boxes[ordinal] as FractionBox);
      focusIndex = await findFocusIndex(doc.path, page, match, kept, mine.signal);
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
        focusIndex,
        ...(alternate ? { position: "right" as const } : {}), // Alt+clic / Ctrl+Entrée : à droite
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
    onOpen: (docId, page, query, opts) => {
      void open(docId, page, query, opts?.alternate === true);
    },
    history: {
      get: currentHistory,
      add: (query) => editHistory((history) => addToHistory(history, query)),
      remove: (query) => editHistory((history) => removeFromHistory(history, query)),
      clear: () => editHistory(() => clearHistory()),
    },
    ...(deps.onOpenSettings ? { onOpenSettings: deps.onOpenSettings } : {}),
    getDocMeta: (docId) => {
      const info = searchStore.getDoc(docId);
      return info ? { pdfSize: info.pdfSize, pdfModifiedMs: info.pdfModifiedMs } : undefined;
    },
    // Filtres de la session : mémoire du contrôleur seulement. Seul le TRI est mémorisé dans les réglages.
    options: {
      getOptions: () => controller.getOptions(),
      setOptions: (next) => {
        const before = controller.getOptions().sort;
        try {
          controller.setOptions(next);
        } finally {
          // Même si le rendu lève dans setOptions, le tri déjà appliqué par le contrôleur est mémorisé.
          const after = controller.getOptions().sort; // normalisé par le contrôleur
          if (after.key !== before.key || after.direction !== before.direction) {
            sortTouched = true;
            if (isProposedSort(after)) persist("tri des résultats", { sort: after }); // hors choix du sélecteur : session seulement
          }
        }
      },
      getFolders: () => listFolders(searchStore.listDocs()),
    },
    ...(saved ? { initialGroupByDocument: saved.groupByDocument } : {}),
    onGroupByDocumentChange: (groupByDocument) => {
      groupTouched = true;
      persist("regrouper par document", { groupByDocument });
    },
    ...(deps.indexActivity ? { indexActivity: deps.indexActivity, schedule, clear } : {}),
    ...(deps.t ? { t: deps.t } : {}),
  });
  host.append(errorEl, messageEl);

  // Réglages lus après le montage : on applique le tri et le regroupement mémorisés, sauf ceux que l'utilisateur a changés.
  const pendingSettings = deps.settings;
  if (pendingSettings?.ready) {
    const applyLoaded = (): void => {
      const loaded = pendingSettings.get();
      try {
        // L'historique lu devient la référence ; ce que l'utilisateur a soumis entre-temps est rejoué dessus,
        // même si l'onglet a été fermé entre-temps (l'écriture compte, la présentation non).
        historyLoaded = true;
        if (pendingHistoryOps.length > 0) {
          const merged = pendingHistoryOps.splice(0).reduce<string[]>((list, op) => op(list), [...(loaded.history ?? [])]);
          persistHistory(merged);
        }
      } finally {
        if (!disposed) applyPresentation(loaded);
      }
    };
    const applyPresentation = (loaded: DocSeekerSettings): void => {
      try {
        if (!sortTouched) {
          const current = controller.getOptions();
          controller.setOptions({ ...current, sort: loaded.sort }); // pas de persist : on applique ce qui est déjà enregistré
        }
      } finally {
        // Le regroupement et la barre d'outils sont traités même si le rendu du tri a levé.
        try {
          if (!groupTouched) view.setGroupByDocument(loaded.groupByDocument);
        } finally {
          view.refreshOptions();
        }
      }
    };
    pendingSettings.ready.then(applyLoaded, (error: unknown) => {
      // Fichier illisible : on n'écrit rien par-dessus (les opérations en attente écraseraient peut-être l'historique réel).
      // L'historique de la session reste utilisable en mémoire.
      historyReadFailed = true;
      pendingHistoryOps.length = 0;
      onWarn("Lecture des réglages impossible : l'historique de cette session n'est pas enregistré", error);
    }).catch((error: unknown) => onWarn("Application des réglages mémorisés en échec", error));
  }


  // Le rafraîchissement et le chargement sont faits par l'index partagé ; l'onglet n'en garde que
  // l'invalidation de ses propres correspondances par page et l'affichage de l'erreur éventuelle.
  const syncSharedError = (): void => {
    if (!disposed) errorEl.textContent = deps.sharedIndex.getError() ?? "";
  };
  const unsubscribeInvalidate = deps.sharedIndex.onInvalidate((docIds) => {
    if (disposed) return;
    for (const docId of docIds) {
      pageMatches.invalidate(docId);
      ranker.invalidate(docId);
    }
    controller.invalidate(); // relance le re-classement avec des mesures fraîches
  });
  const unsubscribeStatus = deps.sharedIndex.onStatus(syncSharedError);
  syncSharedError();

  return {
    focusInput: () => !disposed && view.focusInput(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (hasFlash) clear(flashHandle);
      hasFlash = false;
      openController?.abort();
      unsubscribeInvalidate();
      unsubscribeStatus();
      view.dispose();
      controller.dispose();
      loader.dispose();
      renderer.dispose();
      lastOpened?.dispose();
      lastOpened = null;
      controllerListeners.clear();
      errorEl.remove();
      messageEl.remove();
    },
  };
}
