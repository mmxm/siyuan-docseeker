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
import { ScopeTooLargeError, createScopeResolver, normalizedScope, scopeKey } from "./search/docScope";
import { DEFAULT_OPTIONS, isProposedSort, listFolders, type SearchOptions } from "./search/resultOptions";
import { createSearchController } from "./search/searchController";
import { addToHistory, clearHistory } from "./search/searchHistory";
import type { SearchSessionState } from "./search/searchSession";
import { DSX_SUFFIX, type SharedIndex } from "./search/sharedIndex";
import { planFocusOrdinal } from "./search/thumbnailPlan";
import { IndexedDbThumbnailCache, type ThumbnailCache } from "./search/thumbnailCache";
import { listDocTree } from "./siyuan/docQueries";
import { IndexUnavailableError, type KernelApi } from "./siyuan/kernelApi";
import { openPdfAtPage as realOpenPdfAtPage, type OpenPdfOptions } from "./siyuan/openPdf";
import type { PetalStore } from "./siyuan/petalStore";
import { createPdfRenderer, type RenderableDocument, type RenderCanvas } from "./siyuan/pdfRenderer";
import { createThumbnailLoader, type ThumbnailObserver } from "./ui/thumbnailLoader";
import type { SaveCriteriaResult, SavedCriteria } from "./search/savedCriteria";
import type { DocSeekerSettings } from "./settings";
import type { OpenDialog, OpenMenu } from "./ui/nativeUiTypes";
import { DEFAULT_STRINGS, mountSearchView } from "./ui/searchView";

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
  /**
   * Noyau SiYuan (SQL et liste des cahiers) pour le filtre « portée de documents ». Absent : le menu du chemin ne propose que les
   * dossiers de fichiers, et une portée restaurée d'une session est retirée avec un message.
   */
  readonly kernel?: Pick<KernelApi, "sql" | "lsNotebooks">;
  /** Horloge du cache des portées (30 s) ; `Date.now` par défaut. */
  readonly now?: () => number;
  /**
   * Message d'erreur VISIBLE (toast) pour un incident survenu quand la fenêtre flottante n'est plus là pour l'afficher (surlignage
   * raté après l'ouverture du PDF). Texte brut, sans `<`, `>` ni `&` (SiYuan l'insère comme HTML). Le journal reçoit toujours l'incident.
   */
  readonly notify?: (message: string) => void;
  /** Activité d'indexation pour l'indicateur discret (fournie par le plugin ; l'onglet ne voit pas l'indexeur). */
  readonly indexActivity?: {
    getSnapshot(): IndexActivitySnapshot;
    subscribe(listener: () => void): () => void;
  };
  readonly decodePageMatches?: typeof realDecodePageMatches;
  /** Décodeur multi-pages du re-classement ; absent avec un `decodePageMatches` injecté : repli page par page. */
  readonly decodePagesMatches?: typeof realDecodePagesMatches;
  readonly openPdfAtPage?: typeof realOpenPdfAtPage;
  /**
   * Session de recherche (fenêtre flottante, ou onglet ouvert par « Ouvrir dans un nouvel onglet ») : `initial` est restaurée au
   * montage (options appliquées ; requête, si elle existe, RELANCÉE sans toucher à l'historique ; le tri de la session l'emporte
   * sur celui des réglages), `save` est appelée à chaque soumission et à chaque changement d'options. Rien n'est persisté.
   */
  readonly session?: {
    readonly initial: SearchSessionState | undefined;
    save(state: SearchSessionState): void;
  };
  /**
   * Mode fenêtre flottante. `onPdfOpened` : le PDF est ouvert (openPdfAtPage terminé) ; le plugin ferme alors la fenêtre, et le
   * calque de surlignage, désormais propre au visualiseur, n'est plus libéré par la vue (sinon la fermeture l'avorterait).
   * Jamais appelé si l'ouverture échoue (la fenêtre reste ouverte, l'erreur est affichée et tracée).
   * `onOpenInTab` : bouton « Ouvrir dans un nouvel onglet ». `onCloseRequest` : Échap sur un champ vide.
   */
  readonly floating?: {
    /** `overlay` : le calque de surlignage, désormais propre au visualiseur ; le plugin le garde pour le libérer au déchargement. */
    onPdfOpened(overlay: { dispose(): void }): void;
    onOpenInTab(): void;
    onCloseRequest(): void;
  };
  readonly observerFactory?: (
    cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) => ThumbnailObserver;
  /** Cache de vignettes ; par défaut IndexedDB. */
  readonly cache?: ThumbnailCache;
  readonly indexedDB?: IDBFactory;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly clear?: (handle: unknown) => void;
  readonly t?: (key: string) => string;
  /** Menus et dialogues natifs de SiYuan (voir `src/siyuan/nativeUi.ts`), injectés par le plugin. */
  readonly openMenu: OpenMenu;
  readonly openDialog: OpenDialog;
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
    /** Critères enregistrés (relecture et fusion à l'écriture). Absents : pas de bouton « Critères enregistrés ». */
    saveCriteria?(criteria: SavedCriteria): Promise<SaveCriteriaResult>;
    deleteCriteria?(name: string): Promise<boolean>;
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
/** Durée de validité d'une portée résolue (le contenu des documents change au fil de l'édition). */
const SCOPE_TTL_MS = 30_000;
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

/**
 * Si l'assemblage échoue en cours de route (montage de la vue, abonnements), tout ce qui a déjà été créé est libéré dans l'ordre
 * inverse : ni abonnement, ni minuterie, ni élément orphelin (la fenêtre flottante n'a alors aucune vue à libérer).
 */
export function mountSearchTab(host: HTMLElement, deps: SearchTabDeps): SearchTab {
  const cleanups: Array<() => void> = [];
  try {
    return assembleSearchTab(host, deps, cleanups);
  } catch (error) {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (cleanupError) {
        deps.onWarn("Libération partielle de l'onglet de recherche en échec", cleanupError);
      }
    }
    throw error;
  }
}

function assembleSearchTab(host: HTMLElement, deps: SearchTabDeps, cleanups: Array<() => void>): SearchTab {
  const { onWarn } = deps;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clear = deps.clear ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const openPdf = deps.openPdfAtPage ?? realOpenPdfAtPage;
  let disposed = false;
  let openController: AbortController | null = null;
  cleanups.push(() => {
    disposed = true;
    openController?.abort();
  });

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
  // Portée de documents : le résolveur interroge le noyau (cache 30 s) ; `lastResolved` garde le dernier ensemble connu pour que
  // l'expiration du cache ne vide pas les résultats entre deux rafraîchissements (voir `refreshScope`).
  const resolver = createScopeResolver({
    query: (sql, signal) => (deps.kernel ? deps.kernel.sql(sql, signal) : Promise.reject(new Error(tr("kernelUnavailable")))),
    now: () => (deps.now ?? Date.now)(),
    ttlMs: SCOPE_TTL_MS,
  });
  let lastResolved: { readonly key: string; readonly paths: ReadonlySet<string> } | undefined;
  const controller = createSearchController({
    source: searchStore,
    scopePaths: (scope, includeChildren) => {
      const fresh = resolver.peek(scope, includeChildren);
      if (fresh) return fresh;
      return lastResolved?.key === scopeKey(scope, includeChildren) ? lastResolved.paths : undefined;
    },
    schedule,
    clear,
    onChange: () => {
      for (const listener of [...controllerListeners]) listener();
    },
    onWarn,
    rerank: ranker,
    ...(saved ? { initialOptions: { ...DEFAULT_OPTIONS, sort: saved.sort } } : {}),
  });
  cleanups.push(() => controller.dispose());
  // Session : dernière requête soumise (jamais ce qui est seulement tapé) ; les options sont relues dans le contrôleur.
  let lastQuery = deps.session?.initial?.query ?? "";
  const saveSession = (): void => {
    const session = deps.session;
    if (!session || disposed) return;
    try {
      session.save({ query: lastQuery, options: controller.getOptions() });
    } catch (error) {
      onWarn("Session de recherche non mémorisée", error);
    }
  };
  /** Rappel du plugin déclenché par un geste de l'utilisateur : un échec est tracé, jamais propagé au DOM. */
  const callFloating = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      onWarn(`${what} en échec`, error);
    }
  };
  const renderer = createPdfRenderer({
    loadDocument: deps.loadDocument,
    createCanvas: deps.createCanvas,
    onWarn,
  });
  cleanups.push(() => renderer.dispose());
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
  cleanups.push(() => loader.dispose());

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
  cleanups.push(() => {
    errorEl.remove();
    messageEl.remove();
  });
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
    /** Fenêtre flottante fermée (et non remplacée par une ouverture plus récente) : l'interruption est tracée, jamais silencieuse. */
    const closedWindow = (): boolean => deps.floating !== undefined && disposed && openController === mine;
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
      if (stale()) {
        if (closedWindow()) onWarn("Ouverture du PDF abandonnée : la fenêtre de recherche a été fermée");
        return;
      }
      onWarn("Surlignage indisponible : la page s'ouvre sans calque", error);
      issue = `${HIGHLIGHT_UNAVAILABLE} : ${messageOf(error)}.`;
    }
    if (stale()) {
      if (closedWindow()) onWarn("Ouverture du PDF abandonnée : la fenêtre de recherche a été fermée"); // rien ne s'est ouvert
      return;
    }
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
      if (stale() && !closedWindow()) return;
      onWarn("Ouverture du PDF impossible", error);
      showMessage(`Impossible d'ouvrir ce PDF (${messageOf(error)}).`);
      return;
    }
    // Remplacée par une ouverture plus récente, ou onglet fermé : le calque est libéré. Une FENÊTRE flottante fermée pendant l'ouverture
    // (Échap) ne l'abandonne pas : le PDF s'est ouvert, son calque va au plugin et un échec de surlignage est signalé.
    if (openController !== mine || (disposed && !deps.floating)) {
      handle.dispose();
      return;
    }
    // Faux tant que la fenêtre flottante est encore là pour afficher un message (onPdfOpened a échoué : elle reste ouverte).
    let windowGone = false;
    if (deps.floating) {
      // Le calque passe au visualiseur (il se libère seul quand la page disparaît, ou quand une ouverture plus récente le remplace) :
      // le garder ici le ferait avorter par le `dispose()` de la vue, que la fermeture de la fenêtre va déclencher. Le plugin le garde.
      callFloating("Fermeture de la recherche flottante", () => {
        deps.floating?.onPdfOpened(handle);
        windowGone = true;
      });
    } else {
      lastOpened?.dispose();
      lastOpened = handle;
    }
    const gone = (): boolean => windowGone || (deps.floating !== undefined && disposed);
    let notified = false;
    /** La fenêtre n'est plus là : un toast (texte i18n fixe) en plus du journal. */
    const notifyLost = (): void => {
      if (notified || !deps.notify) return;
      notified = true;
      try {
        deps.notify(deps.t?.("highlightUnavailable") ?? HIGHLIGHT_UNAVAILABLE);
      } catch (error) {
        onWarn("Notification d'erreur impossible", error);
      }
    };
    if (issue) {
      if (gone()) notifyLost(); // déjà tracé plus haut (onWarn)
      else showMessage(issue);
    }
    let report: Awaited<typeof handle.ready> | undefined;
    try {
      report = await handle.ready;
    } catch (error) {
      onWarn("État du surlignage inconnu", error);
      if (gone()) notifyLost();
    }
    const problem = report ? describeHighlightProblem(report) : undefined;
    if (gone()) {
      // La fenêtre est fermée ou se ferme : plus d'endroit où afficher le message, donc le journal et un toast (sauf si l'incident a déjà été tracé).
      if (problem) {
        if (issue === undefined) onWarn(problem);
        notifyLost();
      }
      return;
    }
    if (stale() || !report) return;
    if (problem) showMessage(issue ?? problem);
  };

  // --- Portée de documents : résolution asynchrone des PDF cités avant d'appliquer le filtre au contrôleur.
  const tr = (key: string): string => {
    const custom = deps.t?.(key);
    return custom && custom !== key ? custom : (DEFAULT_STRINGS[key] ?? key);
  };
  const describeScopeError = (error: unknown): string => {
    if (error instanceof IndexUnavailableError) return tr("scopeNotReady");
    if (error instanceof ScopeTooLargeError) return tr("scopeTooLarge");
    return `${tr("scopeFailed")} (${messageOf(error)})`;
  };
  /** Dernier message lié à la portée (affiché dans la zone de messages) : n'efface que lui, jamais le message d'une autre action. */
  let scopeMessage: string | undefined;
  const setScopeMessage = (text: string): void => {
    scopeMessage = text;
    showMessage(text);
  };
  const clearScopeMessage = (): void => {
    if (scopeMessage !== undefined && messageEl.textContent === scopeMessage) showMessage("");
    scopeMessage = undefined;
  };
  let scopeGeneration = 0;
  let scopeAbort: AbortController | undefined;
  cleanups.push(() => scopeAbort?.abort());
  /** Options demandées par l'utilisateur, en attente de la résolution de leur portée : la barre les affiche déjà. */
  let pendingOptions: SearchOptions | undefined;
  /** Requête soumise pendant la résolution d'une portée : jouée, avec les options appliquées, dès que la résolution est finie. */
  let deferredQuery: string | undefined;
  const flushDeferred = (): void => {
    if (deferredQuery === undefined || disposed || pendingOptions !== undefined) return;
    const query = deferredQuery;
    deferredQuery = undefined;
    controller.submit(query);
  };
  const withoutScopeOptions = (o: SearchOptions): SearchOptions => {
    const { scope: _scope, ...filters } = o.filters;
    return { sort: o.sort, filters };
  };
  /**
   * Échec de résolution : tout ce qui était demandé (tri, autres filtres) est appliqué sauf la portée. Le choix d'une portée vide
   * le dossier de la demande ; le dossier déjà actif est alors rétabli (il n'a pas été remplacé).
   */
  const withoutScopeKeepingFolder = (next: SearchOptions): SearchOptions => {
    const rest = withoutScopeOptions(next);
    if (rest.filters.folder !== "") return rest;
    return { sort: rest.sort, filters: { ...rest.filters, folder: controller.getOptions().filters.folder } };
  };
  /** Applique au contrôleur ; mémorise le tri changé et la session (même si le rendu lève). */
  const commitOptions = (next: SearchOptions): void => {
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
      saveSession();
    }
  };
  /**
   * Demande de nouvelles options. Sans portée (ou portée en cache) : appliquées tout de suite. Sinon la portée est résolue
   * d'abord ; une demande plus récente, ou la fermeture, annule la résolution (jeton de génération). Un échec ne laisse JAMAIS un
   * filtre ignoré : `onFailure` donne les options à appliquer à la place, et message et trace sont affichés.
   */
  const requestOptions = (
    next: SearchOptions,
    onFailure: () => SearchOptions,
    after?: (applied: boolean) => void,
    restoring = false,
    /** Critère rappelé : une portée qui ne cite plus aucun PDF (document ou cahier disparu) est retirée, avec un message. */
    recalled = false,
  ): void => {
    // Restauration de session : appliquée telle quelle, sans mémoriser le tri dans les réglages ni réécrire la session.
    const commit = restoring ? (o: SearchOptions): void => controller.setOptions(o) : commitOptions;
    // Ordre : on annule d'abord la résolution en cours, PUIS on incrémente la génération. `scopeAbort` est partagé avec `refreshScope`
    // (qui l'adopte s'il existe) : l'annulation coupe donc aussi un rafraîchissement en vol, et la génération (capturée par chaque
    // demande avant son attente) fait ignorer tout résultat tardif d'une demande dépassée, même si son signal n'a pas pu l'arrêter.
    scopeAbort?.abort();
    scopeAbort = undefined;
    const generation = ++scopeGeneration;
    const rawScope = next.filters.scope;
    if (rawScope !== undefined && normalizedScope(rawScope) === undefined) {
      // Portée illisible (session ou entrée altérée) : jamais retirée en silence, ni appliquée.
      onWarn("Portée de documents invalide retirée des options", rawScope);
      pendingOptions = undefined;
      clearScopeMessage();
      commit(withoutScopeOptions(next));
      setScopeMessage(tr("scopeInvalid"));
      after?.(true);
      flushDeferred();
      return;
    }
    const { scope, includeSubfolders } = next.filters;
    const cached = scope ? resolver.peek(scope, includeSubfolders) : undefined;
    /** Rappel d'un critère dont le chemin n'existe plus : tout est appliqué sauf la portée, et l'utilisateur en est averti. */
    const applyWithoutMissingPath = (): void => {
      clearScopeMessage();
      commit(withoutScopeOptions(next));
      setScopeMessage(tr("criteriaMissingPath"));
    };
    if (scope === undefined || cached) {
      pendingOptions = undefined;
      if (recalled && cached?.size === 0) {
        applyWithoutMissingPath();
        after?.(true);
        flushDeferred();
        return;
      }
      if (scope && cached) lastResolved = { key: scopeKey(scope, includeSubfolders), paths: cached };
      clearScopeMessage();
      commit(next);
      after?.(true);
      flushDeferred();
      return;
    }
    pendingOptions = next;
    setScopeMessage(tr("scopeLoading"));
    const mine = new AbortController();
    scopeAbort = mine;
    const finish = (apply: () => void, applied = true): void => {
      if (disposed) return;
      if (generation !== scopeGeneration) {
        // Demande dépassée par une plus récente : rien n'est appliqué, mais le suivi (ex. requête de la session à relancer) est dû.
        after?.(false);
        return;
      }
      pendingOptions = undefined;
      apply();
      view.refreshOptions();
      after?.(applied);
      flushDeferred();
    };
    resolver
      .resolve(scope, includeSubfolders, mine.signal)
      .then(
        (paths) =>
          finish(() => {
            if (recalled && paths.size === 0) {
              applyWithoutMissingPath();
              return;
            }
            lastResolved = { key: scopeKey(scope, includeSubfolders), paths };
            clearScopeMessage();
            commit(next);
          }),
        (error: unknown) =>
          finish(() => {
            onWarn("Filtre par document non appliqué", error);
            setScopeMessage(describeScopeError(error));
            commit(onFailure());
          }, false),
      )
      .catch((error: unknown) => onWarn("Application du filtre par document en échec", error));
  };
  /**
   * À chaque soumission : si les documents cités ne sont plus en cache (30 s), ils sont relus sans retarder la recherche, qui
   * utilise l'ensemble précédent puis est relancée. Un échec garde l'ensemble précédent, avec un message et une trace.
   */
  const refreshScope = (): void => {
    const { scope, includeSubfolders } = controller.getOptions().filters;
    // Une portée est en résolution : les options du contrôleur sont périmées et le message « Chargement » ne doit pas être écrasé.
    if (disposed || pendingOptions !== undefined || scope === undefined || resolver.peek(scope, includeSubfolders)) return;
    const generation = scopeGeneration;
    const mine = (scopeAbort ??= new AbortController());
    resolver
      .resolve(scope, includeSubfolders, mine.signal)
      .then(
        (paths) => {
          if (generation !== scopeGeneration || disposed) return;
          lastResolved = { key: scopeKey(scope, includeSubfolders), paths };
          if (scopeMessage === tr("scopeRefreshFailed")) clearScopeMessage();
          controller.invalidate();
        },
        (error: unknown) => {
          if (generation !== scopeGeneration || disposed) return;
          onWarn("Documents du filtre non relus : l'ensemble précédent est conservé", error);
          // « Liste précédente conservée » n'est vrai que si elle correspond à cette portée ; sinon on décrit l'erreur.
          const keptPrevious = lastResolved?.key === scopeKey(scope, includeSubfolders);
          setScopeMessage(keptPrevious ? tr("scopeRefreshFailed") : describeScopeError(error));
        },
      )
      .catch((error: unknown) => onWarn("Rafraîchissement du filtre par document en échec", error));
  };

  // --- Critères enregistrés : rappel (options, regroupement, puis requête) et branchement sur les réglages.
  const recallCriteria = (criteria: SavedCriteria): void => {
    if (disposed) return;
    // Comme un choix manuel : la portée de documents repasse par la résolution asynchrone. Si elle échoue, rien n'est appliqué (le
    // message de portée est affiché) : la recherche ne se relance pas sans un filtre que le critère demandait.
    requestOptions(
      { sort: criteria.sort, filters: criteria.filters },
      () => controller.getOptions(),
      (applied) => {
        if (!applied || disposed) return;
        groupTouched = true;
        persist("regrouper par document", { groupByDocument: criteria.groupByDocument });
        view.setGroupByDocument(criteria.groupByDocument);
        view.restoreQuery(criteria.query); // champ rempli et recherche relancée, hors historique (la requête est déjà enregistrée)
      },
      false,
      true,
    );
  };
  const criteriaStore = deps.settings;
  const saveCriteriaFn = criteriaStore?.saveCriteria?.bind(criteriaStore);
  const deleteCriteriaFn = criteriaStore?.deleteCriteria?.bind(criteriaStore);

  const view = mountSearchView(host, {
    controller: {
      submit: (query) => {
        if (pendingOptions !== undefined) {
          // Portée en résolution : calculer maintenant donnerait des résultats hors portée. La requête est jouée à la fin.
          deferredQuery = query;
          lastQuery = query;
          saveSession();
          return;
        }
        refreshScope();
        controller.submit(query);
        lastQuery = query;
        saveSession();
      },
      getViewModel: () => controller.getViewModel(),
    },
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
      clear: () => editHistory(() => clearHistory()),
    },
    openMenu: deps.openMenu,
    openDialog: deps.openDialog,
    onWarn,
    ...(deps.onOpenSettings ? { onOpenSettings: deps.onOpenSettings } : {}),
    getDocMeta: (docId) => {
      const info = searchStore.getDoc(docId);
      return info ? { pdfSize: info.pdfSize, pdfModifiedMs: info.pdfModifiedMs } : undefined;
    },
    // Filtres de la session : mémoire du contrôleur seulement. Seul le TRI est mémorisé dans les réglages.
    options: {
      getOptions: () => pendingOptions ?? controller.getOptions(),
      setOptions: (next) => requestOptions(next, () => withoutScopeKeepingFolder(next)),
      getFolders: () => listFolders(searchStore.listDocs()),
      ...(deps.kernel ? { getDocTree: (signal?: AbortSignal) => listDocTree(deps.kernel as Pick<KernelApi, "sql" | "lsNotebooks">, signal) } : {}),
    },
    ...(criteriaStore && saveCriteriaFn && deleteCriteriaFn
      ? {
          criteria: {
            list: () => criteriaStore.get().savedCriteria ?? [],
            save: saveCriteriaFn,
            remove: deleteCriteriaFn,
            recall: recallCriteria,
            notify: flashMessage,
          },
        }
      : {}),
    ...(saved ? { initialGroupByDocument: saved.groupByDocument } : {}),
    onGroupByDocumentChange: (groupByDocument) => {
      groupTouched = true;
      persist("regrouper par document", { groupByDocument });
    },
    ...(deps.indexActivity ? { indexActivity: deps.indexActivity, schedule, clear } : {}),
    ...(deps.t ? { t: deps.t } : {}),
    ...(deps.floating
      ? {
          floating: {
            requestClose: () => callFloating("Fermeture de la recherche flottante", () => deps.floating?.onCloseRequest()),
            openInTab: () => callFloating("Ouverture dans un nouvel onglet", () => deps.floating?.onOpenInTab()),
          },
        }
      : {}),
  });
  cleanups.push(() => view.dispose());
  host.append(errorEl, messageEl);

  // Session à restaurer : options d'abord, puis la requête soumise (relancée, hors historique).
  const initialSession = deps.session?.initial;
  if (initialSession) {
    try {
      // Une portée de documents repasse par la résolution (jamais de résultats non filtrés entre-temps : la requête n'est relancée
      // qu'une fois les options appliquées) ; en cas d'échec, la portée est retirée avec un message et une trace.
      requestOptions(initialSession.options, () => withoutScopeOptions(initialSession.options), () => {
        view.refreshOptions();
        if (initialSession.query !== "") view.restoreQuery(initialSession.query);
      }, true);
      // Posé une fois la demande acceptée : le tri de la session l'emporte alors sur celui des réglages, même lus plus tard ; si la
      // restauration échoue, rien n'a été appliqué et le tri des réglages reste celui qui s'applique.
      sortTouched = true;
    } catch (error) {
      onWarn("Restauration de la session de recherche en échec", error);
    }
  }

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
  cleanups.push(unsubscribeInvalidate);
  const unsubscribeStatus = deps.sharedIndex.onStatus(syncSharedError);
  cleanups.push(unsubscribeStatus);
  syncSharedError();

  return {
    focusInput: () => !disposed && view.focusInput(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (hasFlash) clear(flashHandle);
      hasFlash = false;
      openController?.abort();
      scopeAbort?.abort();
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
