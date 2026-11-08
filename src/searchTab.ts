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
import { ScopeTooLargeError, createScopeResolver, normalizedScopes, scopeKey, type DocumentScope } from "./search/docScope";
import { DEFAULT_OPTIONS, isProposedSort, type SearchOptions } from "./search/resultOptions";
import { createSearchController } from "./search/searchController";
import { addToHistory, clearHistory } from "./search/searchHistory";
import type { SearchSessionState } from "./search/searchSession";
import { DSX_SUFFIX, type SharedIndex } from "./search/sharedIndex";
import { planFocusOrdinal } from "./search/thumbnailPlan";
import { IndexedDbThumbnailCache, type ThumbnailCache } from "./search/thumbnailCache";
import { IndexUnavailableError, NotFoundError, type KernelApi } from "./siyuan/kernelApi";
import { openPdfAtPage as realOpenPdfAtPage, openPdfInBrowser, type OpenPdfOptions } from "./siyuan/openPdf";
import { NativeModelNotOpenError, openNativeMobilePdf as realOpenNativeMobilePdf } from "./siyuan/nativeMobilePdf";
import { desktopProfile, type PlatformProfile } from "./platform/profile";
import type { PetalStore } from "./siyuan/petalStore";
import { createPdfRenderer, type RenderableDocument, type RenderCanvas } from "./siyuan/pdfRenderer";
import { createThumbnailLoader, type ThumbnailObserver } from "./ui/thumbnailLoader";
import type { SaveCriteriaResult, SavedCriteria } from "./search/savedCriteria";
import type { DocSeekerSettings } from "./settings";
import type { OpenConfirmDialog, OpenCustomDialog, OpenDialog, OpenFloatingDialog, OpenInputDialog, OpenMenu } from "./ui/nativeUiTypes";
import { openMobilePdfViewer } from "./ui/mobilePdfViewer";
import { DEFAULT_STRINGS, mountSearchView } from "./ui/searchView";

export { DSX_SUFFIX, REFRESH_DEBOUNCE_MS } from "./search/sharedIndex";
const THUMBNAIL_DOC_VERSION = 2; // 2 : cadrage par termes distincts (le recadrage mis en cache change)
const MESSAGE_CLASS = "docseeker-message";
const ERROR_CLASS = "docseeker-error";

export interface SearchTabDeps {
  /**
   * Profil de plateforme (plafonds de rendu, de cache, de correspondances et échelle des vignettes). Absent : profil bureau,
   * dont les valeurs sont les constantes historiques. Un `cache` injecté reste prioritaire sur les plafonds du profil.
   */
  readonly profile?: PlatformProfile;
  /** Lecture des `.dsx` pour les correspondances par page (le chargement de l'index n'est pas ici). */
  readonly store: Pick<PetalStore, "read">;
  /** Index partagé entre onglets, créé et chargé par le plugin : l'onglet ne le charge ni ne le libère. */
  readonly sharedIndex: SharedIndex;
  /** Ouvre le panneau de paramètres du plugin (indexation, index, diagnostic). */
  readonly onOpenSettings?: () => void;
  /**
   * `openTab` de SiYuan et `app` du plugin, passés tels quels à `openPdfAtPage`. Absent (mobile, où `openTab` est un stub qui ne fait
   * rien) ou profil sans `canOpenTab` : le PDF s'ouvre par `openPdfFallback`, jamais par `openTab`.
   */
  readonly openTab?: OpenPdfOptions["openTab"] | undefined;
  /**
   * Repli sans onglet (mobile) : ouvre le PDF `assets/x.pdf` à la page (1-based) et renvoie faux si le navigateur bloque la fenêtre.
   * Défaut : `openPdfInBrowser` (seul adaptateur de `window.open`). Peut lever : l'erreur est tracée et un message est affiché.
   */
  readonly openPdfFallback?: (path: string, page: number) => boolean;
  /**
   * Dialogue plein écran natif (`openFloatingDialog`) sur lequel le visionneur de page s'empile (mobile, `canOpenTab` faux). Absent :
   * pas de visionneur, le PDF s'ouvre par `openPdfFallback`. Le bureau ne s'en sert jamais.
   */
  readonly openFloatingDialog?: OpenFloatingDialog;
  /**
   * Mobile (`canOpenTab` faux) : ouvre le PDF dans le visionneur natif de SiYuan (défaut : `openNativeMobilePdf`), tenté avant le
   * visionneur de page maison. Il lève si l'éditeur mobile est absent ou si le visionneur ne s'ouvre pas : repli sur le visionneur
   * maison puis sur `openPdfFallback`. Le bureau ne s'en sert jamais.
   */
  readonly openNativePdf?: OpenPdfOptions["openTab"];
  /** Visionneur de page (défaut : `openMobilePdfViewer`) ; injectable pour les tests. */
  readonly openPdfViewer?: typeof openMobilePdfViewer;
  readonly app: unknown;
  /** Charge un PDF pour le rendu des vignettes (PDF.js de SiYuan). */
  readonly loadDocument: (path: string, signal?: AbortSignal) => Promise<RenderableDocument>;
  readonly createCanvas: (width: number, height: number) => RenderCanvas;
  readonly onWarn: (message: string, error?: unknown) => void;
  /**
   * Noyau SiYuan (SQL des PDF cités, cahiers, documents, recherche et chemins lisibles) pour le filtre « portée de documents ».
   * Absent : pas de bouton « Spécifier le chemin », et une portée restaurée d'une session est retirée avec un message.
   */
  readonly kernel?: Pick<KernelApi, "sql" | "lsNotebooks" | "listDocsByPath" | "searchDocs" | "getHPathsByPaths">;
  /** Horloge du cache des portées (30 s) ; `Date.now` par défaut. */
  readonly now?: () => number;
  /**
   * Message d'erreur VISIBLE (toast) pour un incident survenu quand la fenêtre flottante n'est plus là pour l'afficher (surlignage
   * raté après l'ouverture du PDF). Texte brut, sans `<`, `>` ni `&` (SiYuan l'insère comme HTML). Le journal reçoit toujours l'incident.
   */
  readonly notify?: (message: string) => void;
  /**
   * Notification globale de SiYuan (toast), qui survit à l'onglet : échec d'écriture d'un critère terminé après sa fermeture.
   * Texte brut, sans `<`, `>` ni `&`. Absent : l'échec reste tracé mais pas montré.
   */
  readonly toast?: (message: string) => void;
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
    /** Absent (mobile) : le bouton « Ouvrir dans un nouvel onglet » n'est pas affiché. */
    onOpenInTab?(): void;
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
  /** Dialogue à contenu libre (« Spécifier le chemin ») ; absent : pas de bouton de chemin. */
  readonly openCustomDialog?: OpenCustomDialog;
  /** Dialogues d'entrée et de confirmation natifs (ligne des critères enregistrés) ; absents : pas de ligne de critères. */
  readonly openInputDialog?: OpenInputDialog;
  readonly openConfirmDialog?: OpenConfirmDialog;
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
    /** Critères enregistrés (relecture et fusion à l'écriture). Absents : pas de ligne de critères. */
    saveCriteria?(criteria: SavedCriteria, removeNames?: readonly string[]): Promise<SaveCriteriaResult>;
    deleteCriteria?(name: string): Promise<boolean>;
  };
}

export interface SearchTab {
  dispose(): void;
  /** Met le focus sur le champ de recherche (commande « Aller au champ de recherche PDF »). `false` : onglet fermé ou focus refusé. */
  focusInput(): boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const PDF_BROWSER_OPEN_ERROR = "Impossible d'ouvrir ce PDF sur cet appareil.";
const PDF_BROWSER_OPEN_FAILED = "Impossible d'ouvrir ce PDF sur cet appareil : le navigateur a bloqué la fenêtre.";
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
/** Résultat d'une ouverture par onglet : faite (ou échec déjà signalé) ; natif indisponible (rien cliqué) ; natif cliqué sans confirmation. */
type OpenOutcome = "done" | "unavailable" | "clicked";

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
  const profile = deps.profile ?? desktopProfile();
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
    maxBytesFiles: profile.pageMatchesLimit,
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
    scopePaths: (scopes, includeChildren) => {
      const fresh = resolver.peek(scopes, includeChildren);
      if (fresh) return fresh;
      return lastResolved?.key === scopeKey(scopes, includeChildren) ? lastResolved.paths : undefined;
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
    concurrency: profile.renderConcurrency,
    maxOpenDocuments: profile.maxOpenDocuments,
    onWarn,
  });
  cleanups.push(() => renderer.dispose());
  const cache: ThumbnailCache =
    deps.cache ??
    new IndexedDbThumbnailCache({
      maxEntries: profile.thumbnailCache.maxEntries,
      maxBytes: profile.thumbnailCache.maxBytes,
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
    cropScale: profile.cropScale,
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

  // Mobile : `openTab` est un stub, il n'est donc jamais utilisé même s'il est injecté.
  const openTabFn = profile.canOpenTab ? deps.openTab : undefined;
  // --- Visionneur de page (mobile) : la recherche, dessous, est inerte pour le focus tant qu'il est ouvert.
  const openViewerFn = deps.openPdfViewer ?? openMobilePdfViewer;
  interface ViewerSession {
    handle?: { dispose(): void };
    released: boolean;
    /** Cible rendue inerte à l'ouverture : c'est CETTE cible que l'on libère, même si l'hôte a changé de dialogue entre-temps. */
    inertTarget?: Element | undefined;
  }
  let viewerSession: ViewerSession | undefined;
  /** Premier dialogue (ou à défaut l'hôte) à rendre inerte pendant le visionneur. */
  const inertTargetNow = (): Element => host.closest(".b3-dialog") ?? host;
  /** Lève l'inert posé par cette session (idempotent) ; sans effet sur l'inert d'une autre session. */
  const releaseInert = (session: ViewerSession): void => {
    const target = session.inertTarget;
    session.inertTarget = undefined;
    target?.removeAttribute("inert");
  };
  const endViewer = (session: ViewerSession, restore?: { opener: OpenerRef; focus: boolean }): void => {
    releaseInert(session);
    if (session.released) return;
    session.released = true;
    if (viewerSession === session) viewerSession = undefined;
    if (restore?.focus && !disposed) restoreFocus(restore.opener);
  };
  /** Libère le visionneur courant ; un `dispose()` qui lève est tracé et ne doit jamais interrompre l'appelant. */
  const disposeHandle = (session: ViewerSession): void => {
    try {
      session.handle?.dispose();
    } catch (error) {
      onWarn("Fermeture du visionneur de page impossible", error);
    }
  };
  const disposeViewer = (): void => {
    const session = viewerSession;
    if (!session) return;
    endViewer(session);
    disposeHandle(session);
  };
  cleanups.push(disposeViewer);
  interface OpenerRef {
    readonly element: HTMLElement | undefined;
    readonly docId: string;
    readonly page: number;
  }
  const findCard = (docId: string, page: number): HTMLElement | undefined =>
    Array.from(host.querySelectorAll<HTMLElement>("button.docseeker-card")).find(
      (card) => card.dataset["docId"] === docId && card.dataset["page"] === String(page),
    );
  /** Carte à qui rendre le focus : l'élément actif s'il est dans la vue, sinon la carte du résultat (un toucher iOS ne focalise pas). */
  const findOpener = (docId: string, page: number): OpenerRef => {
    const active = host.ownerDocument.activeElement;
    const element =
      active instanceof HTMLElement && active !== host.ownerDocument.body && host.contains(active) ? active : findCard(docId, page);
    return { element, docId, page };
  };
  /** Rend le focus : carte d'origine (ou son équivalent re-rendu), sinon champ de recherche, sinon hôte. Jamais par-dessus un focus posé ailleurs. */
  const restoreFocus = (opener: OpenerRef): void => {
    const ownerDoc = host.ownerDocument;
    const active = ownerDoc.activeElement;
    if (active !== null && active !== ownerDoc.body && active !== ownerDoc.documentElement) return;
    const card = opener.element?.isConnected === true ? opener.element : findCard(opener.docId, opener.page);
    if (card) {
      card.focus({ preventScroll: true });
      if (ownerDoc.activeElement === card) return;
    }
    if (view.focusInput()) return;
    if (!host.hasAttribute("tabindex")) host.setAttribute("tabindex", "-1");
    host.focus({ preventScroll: true });
  };
  const highlightsFor = async (docId: string, page: number, query: string, signal: AbortSignal): Promise<PercentStyle[]> => {
    const match = await pageMatches.getPageMatches(docId, page, query, signal);
    const kept = [...new Set(match.ordinals)];
    const boxes = kept.flatMap((ordinal) => {
      const box = match.boxes[ordinal];
      return box === undefined ? [] : [box];
    });
    return wordBoxesToPageRects(boxes, 1, 1).map((rect) => rectToPercentStyle(rect, 1, 1));
  };
  const KNOWN_VIEWER_STATUSES = new Set(["attached", "empty", "disposed", "superseded", "timeout"]);
  /** Vrai si le visionneur est ouvert (ou remplacé / fermé avec l'onglet) ; faux s'il n'a pas pu s'ouvrir (l'appelant se replie). */
  const openViewer = async (
    openDialog: OpenFloatingDialog,
    docId: string,
    path: string,
    page: number,
    query: string,
    mine: AbortController,
  ): Promise<boolean> => {
    const previous = viewerSession;
    if (previous) {
      endViewer(previous);
      disposeHandle(previous);
    }
    const opener = findOpener(docId, page);
    const inertTarget = inertTargetNow();
    const session: ViewerSession = { released: false, inertTarget };
    viewerSession = session;
    inertTarget.setAttribute("inert", "");
    let handle: Awaited<ReturnType<typeof openViewerFn>>;
    try {
      handle = await openViewerFn({
        openDialog,
        renderer,
        path,
        page,
        getHighlights: (target, signal) => highlightsFor(docId, target, query, signal),
        ...(deps.t ? { t: deps.t } : {}),
        onWarn,
        onClosing: () => releaseInert(session),
        onClosed: (info) => endViewer(session, { opener, focus: info.focus }),
      });
    } catch (error) {
      endViewer(session);
      onWarn("Ouverture du visionneur de page impossible : repli sur le navigateur", error);
      return false;
    }
    session.handle = handle;
    if (disposed || openController !== mine || session.released) {
      endViewer(session);
      disposeHandle(session);
      return true;
    }
    handle.ready.then(
      (report) => {
        if (!KNOWN_VIEWER_STATUSES.has(report.status)) onWarn(describeHighlightProblem(report) ?? `${HIGHLIGHT_UNAVAILABLE} : état inconnu.`);
      },
      (error: unknown) => onWarn("État du visionneur de page inconnu", error),
    );
    return true;
  };
  const openNativePdf = deps.openNativePdf ?? realOpenNativeMobilePdf;
  const openBrowserPdf = deps.openPdfFallback ?? ((path: string, page: number) => openPdfInBrowser({ path, page, onWarn }));
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
    /**
     * Ouvre le PDF par `openPdfAtPage` avec les surlignages calculés (bureau : `openTab` de SiYuan ; mobile : visionneur natif).
     * Renvoie faux seulement si la tentative `native` a échoué (l'appelant se replie) ; vrai sinon, y compris pour un échec déjà signalé.
     * Une tentative native laisse la recherche ouverte dessous : la fenêtre flottante n'est pas fermée.
     */
    const openWithTab = async (tabFn: NonNullable<OpenPdfOptions["openTab"]>, native: boolean): Promise<OpenOutcome> => {
      let rects: PercentStyle[] = [];
      let focusIndex = 0;
      let issue: string | undefined;
      try {
        const match = await pageMatches.getPageMatches(docId, page, query, mine.signal);
        // Un ordinal peut figurer plusieurs fois (un mot de page satisfaisant plusieurs mots de la requête) : un seul rectangle.
        const kept = [...new Set(match.ordinals)].filter((ordinal) => match.boxes[ordinal] !== undefined);
        const boxes = kept.map((ordinal) => match.boxes[ordinal] as FractionBox);
        focusIndex = await findFocusIndex(doc.path, page, match, kept, mine.signal);
        // Les boîtes sont déjà des fractions de page : une page de 1 x 1 donne directement des pourcentages.
        rects = wordBoxesToPageRects(boxes, 1, 1).map((rect) => rectToPercentStyle(rect, 1, 1));
      } catch (error) {
        if (stale()) {
          if (closedWindow()) onWarn("Ouverture du PDF abandonnée : la fenêtre de recherche a été fermée");
          return "done";
        }
        onWarn("Surlignage indisponible : la page s'ouvre sans calque", error);
        issue = `${HIGHLIGHT_UNAVAILABLE} : ${messageOf(error)}.`;
      }
      if (stale()) {
        if (closedWindow()) onWarn("Ouverture du PDF abandonnée : la fenêtre de recherche a été fermée"); // rien ne s'est ouvert
        return "done";
      }
      let handle: Awaited<ReturnType<typeof openPdf>>;
      try {
        handle = await openPdf({
          openTab: tabFn,
          app: deps.app,
          path: doc.path,
          page,
          rects,
          focusIndex,
          ...(alternate && !native ? { position: "right" as const } : {}), // Alt+clic / Ctrl+Entrée : à droite
          // Natif : annulable, et la page n'est cherchée que dans le visionneur natif (jamais dans un autre PDF ouvert).
          ...(native ? { signal: mine.signal, resolvePageRoot: () => document.getElementById("modelMain") } : {}),
          onWarn: (message) => onWarn(message),
        });
      } catch (error) {
        if (stale() && !closedWindow()) {
          onWarn("Ouverture du PDF périmée (remplacée par une ouverture plus récente ou recherche fermée) : échec ignoré", error);
          return "done";
        }
        if (native) {
          // Le visionneur natif est une tentative : la cause est tracée et l'appelant se replie, sans message d'échec.
          // Lien déjà cliqué mais visionneur absent : il peut encore apparaître, donc pas de navigateur (seulement le visionneur maison).
          onWarn("Visionneur PDF natif de SiYuan indisponible : repli sur le visionneur de page", error);
          return error instanceof NativeModelNotOpenError ? "clicked" : "unavailable";
        }
        onWarn("Ouverture du PDF impossible", error);
        showMessage(`Impossible d'ouvrir ce PDF (${messageOf(error)}).`);
        return "done";
      }
      // Remplacée par une ouverture plus récente, ou onglet fermé : le calque est libéré. Une FENÊTRE flottante fermée pendant l'ouverture
      // (Échap) ne l'abandonne pas : le PDF s'est ouvert, son calque va au plugin et un échec de surlignage est signalé.
      if (openController !== mine || (disposed && !deps.floating)) {
        handle.dispose();
        return "done";
      }
      // Faux tant que la fenêtre flottante est encore là pour afficher un message (onPdfOpened a échoué : elle reste ouverte).
      let windowGone = false;
      if (deps.floating && !native) {
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
        return "done";
      }
      if (stale() || !report) return "done";
      if (problem) showMessage(issue ?? problem);
      return "done";
    };
    // Sans onglet (mobile) : visionneur de page dans un second dialogue ; s'il ne s'ouvre pas, repli par le navigateur, sans surlignage.
    // La recherche reste ouverte et `openTab` n'est jamais appelé.
    if (openTabFn === undefined) {
      const openDialog = deps.openFloatingDialog;
      // `openTab` absent : mobile (profil sans onglet), ou bureau sans `openTab` injecté, qui ne tente ni le natif ni le visionneur maison.
      const mobileWithoutTab = !profile.canOpenTab;
      // Visionneur natif de SiYuan (PDF.js complet) d'abord ; s'il échoue, visionneur maison puis navigateur.
      const nativeOutcome: OpenOutcome = mobileWithoutTab ? await openWithTab(openNativePdf, true) : "unavailable";
      if (nativeOutcome === "done") return;
      if (stale()) return;
      if (mobileWithoutTab && openDialog !== undefined && (await openViewer(openDialog, docId, doc.path, page, query, mine))) return;
      if (stale()) return;
      if (nativeOutcome === "clicked") {
        // Le lien natif a été cliqué : le visionneur peut encore apparaître, ouvrir aussi le navigateur ferait un doublon.
        onWarn("Visionneur natif cliqué mais non confirmé, visionneur de page indisponible : pas de repli sur le navigateur");
        showMessage(deps.t?.("pdfBrowserOpenError") ?? PDF_BROWSER_OPEN_ERROR);
        return;
      }
      try {
        if (openBrowserPdf(doc.path, page)) return;
        onWarn("Ouverture du PDF dans le navigateur refusée : fenêtre bloquée");
        showMessage(deps.t?.("pdfBrowserOpenFailed") ?? PDF_BROWSER_OPEN_FAILED);
      } catch (error) {
        // Chemin invalide, `window.open` qui lève… : message distinct de « bloquée », détail technique seulement dans le journal.
        onWarn("Ouverture du PDF dans le navigateur impossible", error);
        showMessage(deps.t?.("pdfBrowserOpenError") ?? PDF_BROWSER_OPEN_ERROR);
      }
      return;
    }
    await openWithTab(openTabFn, false);
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
    const { scopes: _scopes, ...filters } = o.filters;
    return { sort: o.sort, filters };
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
  ): void => {
    // Restauration de session : appliquée telle quelle, sans mémoriser le tri dans les réglages ni réécrire la session.
    const commit = restoring ? (o: SearchOptions): void => controller.setOptions(o) : commitOptions;
    // Ordre : on annule d'abord la résolution en cours, PUIS on incrémente la génération. `scopeAbort` est partagé avec `refreshScope`
    // (qui l'adopte s'il existe) : l'annulation coupe donc aussi un rafraîchissement en vol, et la génération (capturée par chaque
    // demande avant son attente) fait ignorer tout résultat tardif d'une demande dépassée, même si son signal n'a pas pu l'arrêter.
    scopeAbort?.abort();
    scopeAbort = undefined;
    const generation = ++scopeGeneration;
    const rawScope = next.filters.scopes;
    if (rawScope !== undefined && normalizedScopes(rawScope) === undefined) {
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
    const { scopes, includeSubfolders } = next.filters;
    const cached = scopes ? resolver.peek(scopes, includeSubfolders) : undefined;
    if (scopes === undefined || cached) {
      pendingOptions = undefined;
      if (scopes && cached) lastResolved = { key: scopeKey(scopes, includeSubfolders), paths: cached };
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
      .resolve(scopes, includeSubfolders, mine.signal)
      .then(
        (paths) =>
          finish(() => {
            lastResolved = { key: scopeKey(scopes, includeSubfolders), paths };
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
    const { scopes, includeSubfolders } = controller.getOptions().filters;
    // Une portée est en résolution : les options du contrôleur sont périmées et le message « Chargement » ne doit pas être écrasé.
    if (disposed || pendingOptions !== undefined || scopes === undefined || resolver.peek(scopes, includeSubfolders)) return;
    const generation = scopeGeneration;
    const mine = (scopeAbort ??= new AbortController());
    resolver
      .resolve(scopes, includeSubfolders, mine.signal)
      .then(
        (paths) => {
          if (generation !== scopeGeneration || disposed) return;
          lastResolved = { key: scopeKey(scopes, includeSubfolders), paths };
          if (scopeMessage === tr("scopeRefreshFailed")) clearScopeMessage();
          controller.invalidate();
        },
        (error: unknown) => {
          if (generation !== scopeGeneration || disposed) return;
          onWarn("Documents du filtre non relus : l'ensemble précédent est conservé", error);
          // « Liste précédente conservée » n'est vrai que si elle correspond à cette portée ; sinon on décrit l'erreur.
          const keptPrevious = lastResolved?.key === scopeKey(scopes, includeSubfolders);
          setScopeMessage(keptPrevious ? tr("scopeRefreshFailed") : describeScopeError(error));
        },
      )
      .catch((error: unknown) => onWarn("Rafraîchissement du filtre par document en échec", error));
  };

  // --- Critères enregistrés : rappel (options, regroupement, puis requête) et branchement sur les réglages.
  /** Le document existe-t-il ? « Introuvable » du noyau ou aucun chemin lisible : non ; toute autre erreur est relancée (vérification en échec). */
  const documentExists = async (kernel: NonNullable<SearchTabDeps["kernel"]>, docPath: string, signal: AbortSignal): Promise<boolean> => {
    try {
      const answer = await kernel.getHPathsByPaths([docPath], signal);
      return answer.length === 1 && answer[0] !== "";
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  };
  /** Portées dont le cahier ou le document n'existe plus (un document sans PDF existe : il n'est PAS ici). Rejette si le noyau échoue. */
  const missingScopes = async (scopes: readonly DocumentScope[], signal: AbortSignal): Promise<readonly DocumentScope[]> => {
    const kernel = deps.kernel;
    if (!kernel) return []; // pas de noyau : la résolution de la portée échouera avec son propre message
    const boxes = new Set((await kernel.lsNotebooks(signal)).map((n) => n.id));
    const exists = await Promise.all(
      scopes.map(async (scope) => boxes.has(scope.box) && (scope.kind === "notebook" || (await documentExists(kernel, scope.docPath, signal)))),
    );
    return scopes.filter((_scope, i) => !exists[i]);
  };
  let recallAbort: AbortController | undefined;
  cleanups.push(() => recallAbort?.abort());
  const recallCriteria = (criteria: SavedCriteria): void => {
    if (disposed) return;
    recallAbort?.abort();
    recallAbort = undefined;
    // Comme un choix manuel : la portée de documents repasse par la résolution asynchrone. Si elle échoue, rien n'est appliqué (le
    // message de portée est affiché) : la recherche ne se relance pas sans un filtre que le critère demandait.
    const apply = (filters: SearchOptions["filters"], missing: readonly DocumentScope[]): void => {
      requestOptions(
        { sort: criteria.sort, filters },
        () => controller.getOptions(),
        (applied) => {
          if (!applied || disposed) return;
          // Seules les portées INEXISTANTES sont retirées, et nommées : une portée qui existe sans PDF reste appliquée.
          if (missing.length > 0) setScopeMessage(tr("criteriaMissingPath").replace("{x}", () => missing.map((m) => m.label).join(", ")));
          groupTouched = true;
          persist("regrouper par document", { groupByDocument: criteria.groupByDocument });
          view.setGroupByDocument(criteria.groupByDocument);
          view.restoreQuery(criteria.query); // champ rempli et recherche relancée, hors historique (la requête est déjà enregistrée)
        },
      );
    };
    const scopes = criteria.filters.scopes;
    if (scopes === undefined || normalizedScopes(scopes) === undefined) {
      apply(criteria.filters, []); // pas de portée (ou illisible : requestOptions la signale)
      return;
    }
    // Vérification d'existence AVANT la résolution : zéro PDF ne veut pas dire « inexistant ».
    scopeAbort?.abort();
    scopeAbort = undefined;
    const generation = ++scopeGeneration;
    const mine = new AbortController();
    recallAbort = mine;
    pendingOptions = { sort: criteria.sort, filters: criteria.filters }; // la barre l'affiche déjà ; une requête soumise attend
    setScopeMessage(tr("scopeLoading"));
    const superseded = (): boolean => disposed || mine.signal.aborted || generation !== scopeGeneration;
    missingScopes(scopes, mine.signal).then(
      (missing) => {
        if (superseded()) return;
        pendingOptions = undefined;
        const kept = scopes.filter((s) => !missing.includes(s));
        const { scopes: _scopes, ...rest } = criteria.filters;
        apply(kept.length > 0 ? { ...rest, scopes: kept } : rest, missing);
      },
      (error: unknown) => {
        if (superseded()) return;
        pendingOptions = undefined;
        onWarn("Existence des chemins du critère non vérifiée : critère non appliqué", error);
        setScopeMessage(describeScopeError(error));
        view.refreshOptions();
        flushDeferred();
      },
    ).catch((error: unknown) => onWarn("Rappel du critère en échec", error));
  };
  const criteriaStore = deps.settings;
  const saveCriteriaFn = criteriaStore?.saveCriteria?.bind(criteriaStore);
  const deleteCriteriaFn = criteriaStore?.deleteCriteria?.bind(criteriaStore);

  const view = mountSearchView(host, {
    ...(profile.readOnly ? { readOnly: true } : {}),
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
      open(docId, page, query, opts?.alternate === true).catch((error: unknown) => onWarn("Ouverture du résultat en échec", error));
    },
    history: {
      get: currentHistory,
      add: (query) => editHistory((history) => addToHistory(history, query)),
      clear: () => editHistory(() => clearHistory()),
    },
    openMenu: deps.openMenu,
    openDialog: deps.openDialog,
    ...(deps.openCustomDialog ? { openCustomDialog: deps.openCustomDialog } : {}),
    notify: flashMessage,
    onWarn,
    ...(deps.onOpenSettings ? { onOpenSettings: deps.onOpenSettings } : {}),
    getDocMeta: (docId) => {
      const info = searchStore.getDoc(docId);
      return info ? { pdfSize: info.pdfSize, pdfModifiedMs: info.pdfModifiedMs } : undefined;
    },
    // Filtres de la session : mémoire du contrôleur seulement. Seul le TRI est mémorisé dans les réglages.
    options: {
      getOptions: () => pendingOptions ?? controller.getOptions(),
      setOptions: (next) => requestOptions(next, () => withoutScopeOptions(next)),
      ...(deps.kernel ? { pathKernel: deps.kernel } : {}),
    },
    ...(criteriaStore && saveCriteriaFn && deleteCriteriaFn && deps.openInputDialog && deps.openConfirmDialog
      ? {
          openInputDialog: deps.openInputDialog,
          openConfirmDialog: deps.openConfirmDialog,
          criteria: {
            list: () => criteriaStore.get().savedCriteria ?? [],
            save: saveCriteriaFn,
            remove: deleteCriteriaFn,
            recall: recallCriteria,
            notify: flashMessage,
            ...(deps.toast ? { toast: deps.toast } : {}),
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
            ...(deps.floating.onOpenInTab
              ? { openInTab: () => callFloating("Ouverture dans un nouvel onglet", () => deps.floating?.onOpenInTab?.()) }
              : {}),
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
      disposeViewer();
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
