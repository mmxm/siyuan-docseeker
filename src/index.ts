import { Plugin, Setting, confirm, openTab, showMessage } from "siyuan";
import { openDialog, openFloatingDialog, openMenu } from "./siyuan/nativeUi";
import { createFloatingSearch, type FloatingMountOptions, type FloatingSearch } from "./siyuan/floatingSearch";
import { createSearchSessionStore, type SearchSessionState } from "./search/searchSession";
import { createKernelApi } from "./siyuan/kernelApi";
import { traceKeys } from "./diagnostic/traceKeys";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";
import { createAutoSync, type AutoSync, type AutoSyncConfig } from "./indexer/autoSync";
import { createIndexActivity, type IndexActivity } from "./indexer/indexActivity";
import { createIndexer, type Indexer } from "./indexer/indexer";
import { SETTINGS_FILE, createSettings, type DocSeekerSettings, type OpenMode, type SettingsStore } from "./settings";
import { createLoadPdf, type PdfjsLoader } from "./indexer/loadPdf";
import { discoverPdfs } from "./siyuan/discovery";
import { createPetalStore, type PetalStore } from "./siyuan/petalStore";
import { decodeIndexForSearch } from "./core/codec/decode";
import { createSharedIndex, type SharedIndex } from "./search/sharedIndex";
import { createWarnLog, mountSearchTab, type SearchTab } from "./searchTab";
import { ensureSearchStyle } from "./ui/searchStyles";
import { isShown } from "./ui/visibility";
import { createClearingFlag, createSettingsPanel, type SettingsPanel } from "./ui/settingsPanel";
import type { OpenTabFn } from "./siyuan/openPdf";
import type { RenderableDocument } from "./siyuan/pdfRenderer";

const TAB_TYPE = "docseeker";
const TOP_BAR_ID = "docseeker-top-bar";
const PETAL_ROOT = "/data/storage/petal";
const ICON_NAME = "iconSearch";
const COMMAND_OPEN_KEY = "openSearch";
const COMMAND_FOCUS_KEY = "focusSearch";
const COMMAND_OPEN_FLOATING_KEY = "openSearchFloating";
const COMMAND_OPEN_TAB_KEY = "openSearchTab";
/** Le focus est redemandé peu après l'ouverture : l'onglet n'est pas toujours affiché quand `openTab` se résout. */
const FOCUS_RETRY_MS = 50;
/** Durée d'affichage d'un message d'erreur (toast) : le temps de le lire. */
const ERROR_TOAST_MS = 8000;
/**
 * Clé de `custom.data` portant le jeton d'un transfert vers un onglet. SiYuan 3.8.9 transmet `custom.data` à `init` (`this.data` de
 * l'onglet) et l'enregistre dans la mise en page (`Object.assign({}, model.data)`) : c'est donc un objet simple, sérialisable.
 */
const TRANSFER_KEY = "docseekerTransfer";
/** Délai au-delà duquel un transfert non repris par un onglet est abandonné (jeton nettoyé, verrou levé, incident tracé). */
const TRANSFER_TTL_MS = 30_000;

/** Session en attente d'un onglet ouvert par « Ouvrir dans un nouvel onglet », retrouvée par son jeton. */
interface Transfer {
  readonly state: SearchSessionState;
  timer: ReturnType<typeof setTimeout>;
  /** `openTab` a répondu (résolu ou rejeté) : seule la reprise par `init` reste attendue. */
  settled: boolean;
}

/** Une saisie plus récente que cela retarde la synchronisation automatique (extraction dans le thread principal). */
const TYPING_QUIET_MS = 3000;
const USER_ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

type PanelPart = "openMode" | "autoIndex" | "autoIndexInterval" | "reindex" | "clearIndex" | "diagnostic" | "log";
/** Items du panneau, dans l'ordre : clé i18n du titre (`<clé>Desc` pour la description) et partie du panneau. */
const SETTING_ITEMS: readonly { key: string; part: PanelPart }[] = [
  { key: "openMode", part: "openMode" },
  { key: "autoIndex", part: "autoIndex" },
  { key: "autoIndexInterval", part: "autoIndexInterval" },
  { key: "reindex", part: "reindex" },
  { key: "clearIndex", part: "clearIndex" },
  { key: "diagnostic", part: "diagnostic" },
  { key: "warnLog", part: "log" },
];

const toConfig = (settings: DocSeekerSettings): AutoSyncConfig => ({
  enabled: settings.autoIndex,
  intervalMinutes: settings.intervalMinutes,
});

declare global {
  interface Window {
    pdfjsLib?: unknown;
  }
}

/** Point d'entrée du plugin. Onglet de recherche (mountSearchTab) + panneau de paramètres (Réindexer, Vider l'index, Diagnostic M0, journal). */
export default class DocSeekerPlugin extends Plugin {
  override onload(): void {
    // Réglages lus tout de suite (idempotent, ne rejette jamais) : un onglet restauré ou un update() n'attend pas onLayoutReady.
    void this.settings.load();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- `destroy` reçoit l'onglet comme `this`
    const plugin = this;
    this.addTab({
      type: TAB_TYPE,
      init: (custom) => this.renderTab(custom.element, custom),
      // Chaque onglet libère ses propres ressources : en détruire un ne touche pas les autres.
      destroy() {
        plugin.disposeTab(this.element);
      },
    });

    this.setting = new Setting({ destroyCallback: () => this.disposePanel() });
    for (const part of SETTING_ITEMS) {
      this.setting.addItem({
        title: this.t(part.key),
        description: this.t(`${part.key}Desc`),
        direction: "row", // "column" met l'action à droite sur 200 px (fn__size200) ; "row" la met sous le titre, en pleine largeur
        // Appelé par SiYuan à chaque ouverture du panneau ; `destroyCallback` à sa fermeture.
        createActionElement: () => this.panelPart(part.part),
      });
    }

    this.addTopBar({
      id: TOP_BAR_ID,
      icon: ICON_NAME,
      title: this.t("openSearch"),
      position: "right",
      callback: () => this.openSearch(),
    });

    // Aucun raccourci par défaut (hotkey "") : l'utilisateur choisit le sien dans les réglages de SiYuan.
    this.addCommand({
      langKey: COMMAND_OPEN_KEY,
      langText: this.t("commandOpenSearch"),
      hotkey: "",
      callback: () => this.openSearch(),
    });
    this.addCommand({
      langKey: COMMAND_OPEN_FLOATING_KEY,
      langText: this.t("commandOpenSearchFloating"),
      hotkey: "",
      callback: () => this.openFloatingSearch(),
    });
    this.addCommand({
      langKey: COMMAND_OPEN_TAB_KEY,
      langText: this.t("commandOpenSearchTab"),
      hotkey: "",
      callback: () => this.openSearchTab(),
    });
    this.addCommand({
      langKey: COMMAND_FOCUS_KEY,
      langText: this.t("commandFocusSearch"),
      hotkey: "",
      callback: () => this.focusSearch(),
    });
  }

  /** Charge les index en arrière-plan dès que l'interface est prête, sans attendre l'ouverture d'un onglet. */
  override onLayoutReady(): void {
    if (this.unloaded) return;
    try {
      void this.getSharedIndex().start();
    } catch (error) {
      this.warnLog.warn("Démarrage de l'index partagé en échec", error);
    }
    try {
      this.getActivity();
      this.startAutoIndex();
    } catch (error) {
      this.warnLog.warn("Démarrage de l'indexation automatique en échec", error);
    }
  }

  /**
   * Indexation automatique : lit les réglages, puis le planificateur lance une première synchronisation peu
   * après (précédée du nettoyage des .tmp/.bak abandonnés), au retour du focus et périodiquement.
   */
  private startAutoIndex(): void {
    if (this.autoSync) return;
    const indexer = this.getIndexer();
    const store = this.getPetalStore(createKernelApi());
    const onVisible = (listener: () => void) => (): void => {
      if (document.visibilityState === "visible") listener();
    };
    const autoSync = createAutoSync({
      sync: async () => {
        const summary = await indexer.start({ automatic: true });
        return {
          failed: summary.failed,
          cancelled: summary.cancelled,
          incomplete: summary.incomplete,
          ...(summary.failures ? { failures: summary.failures } : {}),
          ...(summary.incompleteDetails ? { incompleteDetails: summary.incompleteDetails } : {}),
        };
      },
      prepare: async () => {
        const report = await store.removeStaleTmp();
        if (report.handled.length > 0) {
          this.warnLog.warn(`Fichiers temporaires restaurés ou supprimés au démarrage : ${report.handled.join(", ")}`);
        }
        for (const failure of report.failed) this.warnLog.warn(`Nettoyage de ${failure.name} en échec`, failure.error);
      },
      isBusy: () => this.clearing.active() || this.userIsActive(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onFocus: (listener) => {
        const visible = onVisible(listener);
        window.addEventListener("focus", listener);
        document.addEventListener("visibilitychange", visible);
        return () => {
          window.removeEventListener("focus", listener);
          document.removeEventListener("visibilitychange", visible);
        };
      },
      now: () => Date.now(),
      onWarn: (message, error) => this.warnLog.warn(message, error),
    });
    this.autoSync = autoSync;
    // Détecteur d'activité (saisie, clic, molette) : partagé par le planificateur (isBusy) et l'indexeur (shouldYield).
    // Enregistré après la création du planificateur : s'il lève, aucun écouteur ne reste sur le document.
    const onInput = (): void => {
      this.lastInputAt = Date.now();
    };
    for (const type of USER_ACTIVITY_EVENTS) document.addEventListener(type, onInput, { capture: true, passive: true });
    const unsubscribeSettings = this.settings.subscribe(() => autoSync.configure(toConfig(this.settings.get())));
    this.autoSyncCleanup = () => {
      unsubscribeSettings();
      for (const type of USER_ACTIVITY_EVENTS) document.removeEventListener(type, onInput, { capture: true });
      autoSync.dispose();
    };
    this.settings
      .load()
      .then((loaded) => {
        if (!this.unloaded) autoSync.start(toConfig(loaded));
      })
      .catch((error: unknown) => this.warnLog.warn("Démarrage de l'indexation automatique en échec", error));
  }

  private unloaded = false;
  private indexer: Indexer | null = null;
  private sharedIndex: SharedIndex | null = null;
  private petalStore: PetalStore | null = null;
  private readonly tabCleanups = new Map<Element, Array<() => void>>();
  /** Onglets de recherche ouverts, dans l'ordre d'ouverture (le dernier est la cible de « Aller au champ de recherche »). */
  private readonly searchTabs = new Map<Element, SearchTab>();
  private readonly warnLog = createWarnLog();
  /** Session de la recherche (requête soumise + options), partagée entre la fenêtre flottante et le transfert vers un onglet. */
  private readonly session = createSearchSessionStore();
  /** Fenêtre flottante, créée à la première ouverture. */
  private floating: FloatingSearch | null = null;
  /** Sessions à restituer aux onglets ouverts par « Ouvrir dans un nouvel onglet », par jeton (relu dans `custom.data` par `init`) ; chacune est reprise une seule fois. */
  private readonly transfers = new Map<string, Transfer>();
  private transferSeq = 0;
  /** Vrai tant qu'un transfert attend la réponse d'`openTab` : un double clic n'ouvre pas un second onglet. */
  private transferring = false;
  /** Calque de surlignage remis au visualiseur par la fenêtre flottante : libéré au prochain calque et au déchargement. */
  private lastFloatingOverlay: { dispose(): void } | undefined;
  private panel: SettingsPanel | null = null;
  private autoSync: AutoSync | null = null;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private autoSyncCleanup: (() => void) | null = null;
  private activity: IndexActivity | null = null;
  private readonly settings: SettingsStore = createSettings({
    load: () => this.loadData(SETTINGS_FILE) as Promise<unknown>,
    save: (value) => this.saveData(SETTINGS_FILE, value) as Promise<unknown>,
    onWarn: (message, error) => this.warnLog.warn(message, error),
    // Une seule lecture par session : un seul message, la trace (un critère par ligne) est déjà dans le journal.
    onCriteriaIgnored: () => this.toast(this.t("criteriaLoadFailed")),
  });
  /** Vidage de l'index en cours : porté ici pour survivre à la fermeture/réouverture du panneau. */
  private readonly clearing = createClearingFlag();

  override onunload(): void {
    this.unloaded = true;
    this.autoSyncCleanup?.();
    this.autoSyncCleanup = null;
    this.activity?.dispose();
    this.activity = null;
    this.indexer?.cancel();
    this.sharedIndex?.dispose();
    this.sharedIndex = null;
    this.disposePanel();
    try {
      this.floating?.dispose();
    } catch (error) {
      this.warnLog.warn("Libération de la fenêtre flottante en échec", error);
    }
    this.floating = null;
    for (const transfer of this.transfers.values()) clearTimeout(transfer.timer);
    this.transfers.clear();
    this.transferring = false;
    this.releaseFloatingOverlay();
    this.session.clear();
    for (const host of [...this.tabCleanups.keys()]) this.disposeTab(host);
    this.removeTopBar(TOP_BAR_ID);
  }

  /** Libère le dernier calque de surlignage remis au visualiseur par la fenêtre flottante ; un échec est tracé. */
  private releaseFloatingOverlay(): void {
    const overlay = this.lastFloatingOverlay;
    this.lastFloatingOverlay = undefined;
    try {
      overlay?.dispose();
    } catch (error) {
      this.warnLog.warn("Libération du calque de surlignage en échec", error);
    }
  }

  /** Le PDF est ouvert depuis la fenêtre : son calque appartient au visualiseur, le plugin le garde pour le libérer (nouveau calque, déchargement). */
  private keepFloatingOverlay(overlay: { dispose(): void }): void {
    if (this.unloaded) {
      try {
        overlay.dispose();
      } catch (error) {
        this.warnLog.warn("Libération du calque de surlignage en échec", error);
      }
      return;
    }
    if (this.lastFloatingOverlay === overlay) return;
    this.releaseFloatingOverlay();
    this.lastFloatingOverlay = overlay;
  }

  /** Message d'erreur visible (toast) : texte i18n fixe, sans `<`, `>` ni `&` (SiYuan l'insère comme HTML) ; le détail va au journal. */
  private toast(message: string): void {
    try {
      showMessage(message, ERROR_TOAST_MS, "error");
    } catch (error) {
      this.warnLog.warn("Notification d'erreur impossible", error);
    }
  }

  private disposeTab(host: Element): void {
    this.searchTabs.delete(host);
    const cleanups = this.tabCleanups.get(host);
    this.tabCleanups.delete(host);
    for (const cleanup of cleanups ?? []) {
      try {
        cleanup();
      } catch (error) {
        this.warnLog.warn("Libération de l'onglet en échec", error);
      }
    }
  }

  /** Libère les écouteurs du panneau de paramètres (fermeture du panneau ou déchargement du plugin). */
  private disposePanel(): void {
    const panel = this.panel;
    this.panel = null;
    panel?.dispose();
  }

  /**
   * Élément d'action d'un item du panneau. Le panneau est construit à la première demande après une
   * fermeture ; plusieurs items d'une même ouverture partagent donc les mêmes écouteurs.
   */
  private panelPart(part: PanelPart): HTMLElement {
    if (this.unloaded) return document.createElement("div"); // plugin déchargé : aucun abonnement orphelin
    this.panel ??= this.createPanel();
    return this.panel[part];
  }

  private createPanel(): SettingsPanel {
    const indexer = this.getIndexer();
    const sharedIndex = this.getSharedIndex();
    const store = this.getPetalStore(createKernelApi());
    return createSettingsPanel({
      t: (key) => this.t(key),
      indexer,
      startIndexing: () => {
        if (sharedIndex.getError() !== undefined) void sharedIndex.start(); // retente un chargement échoué (ne rejette jamais)
        return indexer.start();
      },
      isIndexing: () => indexer.getState().status !== "idle",
      clearing: this.clearing,
      clearIndex: () => store.clear(),
      settings: this.settings,
      startAutoSync: () => {
        indexer.resetFailures(); // index vidé : les PDF en échec doivent être retentés sans attendre leur délai
        return this.autoSync?.triggerNow() ?? false;
      },
      refreshIndex: () => sharedIndex.refreshNow(),
      runDiagnostic: () => this.runDiagnostic(),
      // Diagnostic clavier : trace les touches de l'onglet de recherche VISIBLE (le dernier, comme focusSearch).
      startKeyTrace: (log) => {
        const roots = [...document.querySelectorAll<HTMLElement>(".docseeker-search")].filter(isShown);
        const root = roots.at(-1);
        return root ? traceKeys(root, log) : undefined;
      },
      warnLog: this.warnLog,
      showMessage: (message, timeoutMs, type) => showMessage(message, timeoutMs, type),
      confirm: (title, text, onConfirm, onCancel) =>
        confirm(title, text, () => onConfirm(), () => onCancel?.()),
    });
  }

  private t(key: string): string {
    const value = this.i18n[key];
    return typeof value === "string" ? value : key;
  }

  /** Icône de la barre et commande « Rechercher dans les PDF » : fenêtre flottante ou onglet, selon le réglage `openMode`. */
  private openSearch(): void {
    // Le réglage est lu AVANT de choisir : un clic juste après le démarrage ne doit pas ignorer « Fenêtre flottante ».
    const open = (mode: OpenMode): void => {
      if (this.unloaded) return;
      if (mode === "dialog") this.openFloatingSearch();
      else this.openSearchTab();
    };
    this.settings.ready
      .then(
        () => open(this.settings.get().openMode),
        (error: unknown) => {
          this.warnLog.warn("Lecture des réglages impossible : la recherche s'ouvre dans un onglet", error);
          open("tab");
        },
      )
      .catch((error: unknown) => this.warnLog.warn("Ouverture de la recherche en échec", error));
  }

  /** Ouvre (ou refocalise) la fenêtre flottante, quel que soit le réglage. */
  private openFloatingSearch(): void {
    if (this.unloaded) return;
    this.floating ??= createFloatingSearch({
      openDialog: openFloatingDialog,
      title: this.t("floatingTitle"),
      session: this.session,
      mount: (host, options) => this.mountSearchInto(host, { floating: options }),
      onWarn: (message, error) => this.warnLog.warn(message, error),
      notify: (message) => this.toast(message),
      openFailedText: this.t("floatingOpenFailed"),
    });
    this.floating.open();
  }

  /** Ouvre toujours un NOUVEL onglet de recherche ; un échec est tracé et affiché (jamais une promesse rejetée non gérée). */
  private openSearchTab(): void {
    if (this.unloaded) return;
    this.requestSearchTab().catch((error: unknown) => {
      this.warnLog.warn("Ouverture de l'onglet de recherche impossible", error);
      if (!this.unloaded) this.toast(this.t("openTabFailed"));
    });
  }

  /**
   * Demande un nouvel onglet à SiYuan ; résolue quand `openTab` l'est, rejetée si `openTab` échoue (même de façon synchrone).
   * `data` : transmis tel quel à `init` de l'onglet (`custom.data`).
   */
  private requestSearchTab(data?: Record<string, string>): Promise<void> {
    return new Promise<unknown>((resolve) =>
      resolve(
        openTab({
          app: this.app,
          custom: {
            id: `${this.name}${TAB_TYPE}`,
            icon: ICON_NAME,
            title: this.t("tabTitle"),
            ...(data ? { data } : {}),
          },
          openNewTab: true, // sans cela SiYuan refocalise l'onglet de recherche déjà ouvert (id fixe)
        }),
      ),
    ).then(() => undefined);
  }

  /**
   * « Ouvrir dans un nouvel onglet » : la session est rangée sous un JETON unique, placé dans `custom.data` de l'onglet ; `init`
   * (appelé par SiYuan pendant `openTab` si l'onglet est créé tout de suite, ou plus tard) la reprend par ce jeton : l'ordre
   * `init` / résolution d'`openTab` n'a pas d'importance et aucun autre onglet ne peut la voler. La fenêtre se ferme APRÈS
   * l'ouverture, sans rendre le focus. Si l'onglet ne s'ouvre pas, la fenêtre reste ouverte et l'erreur est affichée et tracée ;
   * un jeton jamais repris est nettoyé au bout de `TRANSFER_TTL_MS`.
   */
  private transferToTab(close: FloatingMountOptions["close"]): void {
    // Un transfert en cours, ou une fenêtre déjà en fermeture (double clic) : un seul onglet, une seule fermeture.
    if (this.unloaded || this.transferring || this.floating?.isOpen() !== true) return;
    const seq = ++this.transferSeq;
    const state = this.session.get();
    const token = state ? `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 10)}` : undefined;
    this.transferring = true;
    const release = (): void => {
      if (this.transferSeq === seq) this.transferring = false;
    };
    const timer = setTimeout(() => {
      release(); // openTab n'a jamais répondu : on peut réessayer
      if (token && this.transfers.delete(token)) {
        this.warnLog.warn("Transfert vers un onglet : la session n'a jamais été reprise par un onglet, elle est abandonnée");
      }
    }, TRANSFER_TTL_MS);
    const transfer: Transfer | undefined = token && state ? { state, timer, settled: false } : undefined;
    if (token && transfer) this.transfers.set(token, transfer);
    /** `openTab` a répondu : si rien n'attend plus de reprise par `init`, la minuterie n'a plus d'objet. */
    const settle = (): void => {
      release();
      if (transfer) transfer.settled = true;
      if (!transfer || !token || !this.transfers.has(token)) clearTimeout(timer);
    };
    this.requestSearchTab(token ? { [TRANSFER_KEY]: token } : undefined).then(
      () => {
        settle();
        if (!this.unloaded) close({ restoreFocus: false });
      },
      (error: unknown) => {
        settle();
        if (token) {
          this.transfers.delete(token);
          clearTimeout(timer);
        }
        this.warnLog.warn("Ouverture dans un nouvel onglet impossible", error);
        if (!this.unloaded) this.toast(this.t("transferTabFailed"));
      },
    );
  }

  /**
   * Commande « Aller au champ de recherche PDF » : ramène devant le dernier onglet de recherche ouvert (SiYuan
   * refocalise l'onglet existant quand `openNewTab` est absent) ou en ouvre un, puis focalise son champ.
   */
  private focusSearch(): void {
    const fail = (error: unknown): void => this.warnLog.warn("Accès au champ de recherche impossible", error);
    if (this.floating?.isOpen() === true) {
      // La fenêtre flottante est ouverte : c'est elle qu'on veut (elle est devant tout le reste).
      try {
        if (!this.floating.focusInput()) this.warnLog.warn("Champ de recherche non focalisé");
      } catch (error) {
        fail(error);
      }
      return;
    }
    const hasTab = this.searchTabs.size > 0;
    /** Focalise le champ du dernier onglet VISIBLE ; faux si aucun onglet n'est affiché ou si le focus est refusé. */
    const focus = (): boolean => {
      const visible = [...this.searchTabs].filter(([host]) => isShown(host));
      const target = visible.at(-1)?.[1];
      return target !== undefined && target.focusInput();
    };
    const attempt = (final: boolean): void => {
      try {
        if (!focus() && final) this.warnLog.warn("Champ de recherche non focalisé");
      } catch (error) {
        fail(error);
      }
    };
    try {
      void Promise.resolve(
        openTab({
          app: this.app,
          custom: { id: `${this.name}${TAB_TYPE}`, icon: ICON_NAME, title: this.t("tabTitle") },
          ...(hasTab ? {} : { openNewTab: true }),
        }),
      )
        .then(() => {
          if (this.unloaded) return;
          attempt(false); // l'onglet n'est parfois affiché qu'ensuite : l'échec n'est signalé qu'au rattrapage
          setTimeout(() => {
            if (!this.unloaded) attempt(true);
          }, FOCUS_RETRY_MS);
        })
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Reprend la session d'un transfert d'après le jeton de `custom.data`, une seule fois. Toute donnée à nous est retirée de l'onglet :
   * SiYuan enregistre `custom.data` dans la mise en page, un jeton périmé n'a pas à être restauré au prochain démarrage.
   */
  private takeTransfer(custom: { data?: unknown }): SearchSessionState | undefined {
    const data: unknown = custom.data;
    if (typeof data !== "object" || data === null || !(TRANSFER_KEY in data)) return undefined;
    const token = (data as Record<string, unknown>)[TRANSFER_KEY];
    custom.data = undefined;
    const transfer = typeof token === "string" ? this.transfers.get(token) : undefined;
    if (!transfer || typeof token !== "string") return undefined;
    this.transfers.delete(token);
    if (transfer.settled) clearTimeout(transfer.timer);
    return transfer.state;
  }

  private renderTab(host: Element, custom: { data?: unknown } = {}): void {
    if (this.unloaded) return; // plugin déchargé : ne recrée ni index ni onglet orphelins
    this.disposeTab(host);
    const cleanups: Array<() => void> = [];
    this.tabCleanups.set(host, cleanups);
    host.replaceChildren();
    const container = document.createElement("div");
    container.style.padding = "16px";
    host.append(container);

    const searchHost = document.createElement("div");
    container.append(searchHost);
    // Onglet ouvert par « Ouvrir dans un nouvel onglet » : il reçoit la session une seule fois, d'après son jeton.
    const initial = this.takeTransfer(custom);
    const searchTab = this.mountSearchInto(searchHost, initial ? { initial } : {});
    this.searchTabs.set(host, searchTab);
    cleanups.push(() => searchTab.dispose());
  }

  /**
   * Monte la vue de recherche dans `host` : même assemblage pour un onglet et pour la fenêtre flottante.
   * `floating` : mode fenêtre flottante (session restituée et mémorisée, fermeture après l'ouverture d'un PDF, bouton « nouvel onglet »,
   * Échap sur un champ vide) ; `initial` : session à restituer dans un onglet (transfert), sans rien mémoriser.
   */
  private mountSearchInto(
    host: HTMLElement,
    mode: { floating?: FloatingMountOptions; initial?: SearchSessionState },
  ): SearchTab {
    ensureSearchStyle(document);
    const { floating } = mode;
    const kernel = createKernelApi();
    const getPdfjs = (): PdfjsLoader | undefined => window.pdfjsLib as PdfjsLoader | undefined;
    const loadPdf = createLoadPdf(getPdfjs);
    const sharedIndex = this.getSharedIndex();
    void sharedIndex.start(); // idempotent : filet si l'onglet est rendu avant onLayoutReady
    return mountSearchTab(host, {
      store: this.getPetalStore(kernel),
      kernel, // filtre « portée de documents » (arbre et PDF cités, SQL du noyau)
      sharedIndex,
      onOpenSettings: () => this.openSetting(),
      openMenu,
      openDialog,
      settings: this.settings, // tri et regroupement mémorisés
      indexActivity: this.getActivity(),
      openTab: openTab as unknown as OpenTabFn,
      app: this.app,
      // Les pages du PDF.js de SiYuan exposent `render` : le type d'indexation n'en décrit qu'une partie.
      loadDocument: (path, signal) =>
        loadPdf(path, signal ?? new AbortController().signal) as unknown as Promise<RenderableDocument>,
      createCanvas: (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      onWarn: (message, error) => this.warnLog.warn(message, error),
      t: (key) => this.t(key),
      ...(floating
        ? {
            notify: (message: string) => this.toast(message),
            session: { initial: floating.initial, save: floating.save },
            floating: {
              // Le PDF est ouvert : la fenêtre se ferme sans rendre le focus (il va au visualiseur) ; le calque reste au plugin.
              onPdfOpened: (overlay: { dispose(): void }) => {
                this.keepFloatingOverlay(overlay);
                floating.close({ restoreFocus: false });
              },
              onOpenInTab: () => this.transferToTab(floating.close),
              onCloseRequest: () => floating.close(),
            },
          }
        : mode.initial
          ? { session: { initial: mode.initial, save: () => undefined } }
          : {}),
    });
  }

  private getPetalStore(kernel: ReturnType<typeof createKernelApi>): PetalStore {
    this.petalStore ??= createPetalStore({ api: kernel, pluginName: this.name });
    return this.petalStore;
  }

  /** Index de recherche unique, créé paresseusement ; `start()` y est idempotent (onLayoutReady ou 1er onglet). */
  private getSharedIndex(): SharedIndex {
    if (this.sharedIndex) return this.sharedIndex;
    const shared = createSharedIndex({
      store: this.getPetalStore(createKernelApi()),
      decode: decodeIndexForSearch,
      indexer: this.getIndexer(),
      onWarn: (message, error) => this.warnLog.warn(message, error),
    });
    this.sharedIndex = shared;
    return shared;
  }

  /** Vrai si l'utilisateur a saisi, cliqué ou fait défiler depuis moins de TYPING_QUIET_MS. */
  private userIsActive(): boolean {
    return Date.now() - this.lastInputAt < TYPING_QUIET_MS;
  }

  /** Suivi d'activité unique partagé par les onglets (indicateur discret) ; créé paresseusement. */
  private getActivity(): IndexActivity {
    if (this.activity) return this.activity;
    const indexer = this.getIndexer();
    this.activity = createIndexActivity({
      indexer,
      getProgress: () => {
        const queue = indexer.getState().queue;
        if (queue === null) return null;
        const done = queue.completed.length + queue.failed.length;
        return { done, total: done + queue.pending.length + queue.running.length };
      },
      onWarn: (message, error) => this.warnLog.warn(message, error),
    });
    return this.activity;
  }

  private getIndexer(): Indexer {
    if (this.indexer) return this.indexer;
    const kernel = createKernelApi();
    this.indexer = createIndexer({
      discover: () => discoverPdfs({ api: kernel }),
      store: this.getPetalStore(kernel),
      loadPdf: createLoadPdf(() => window.pdfjsLib as PdfjsLoader | undefined),
      now: () => Date.now(),
      onListenerError: (error) => this.warnLog.warn("Écouteur d'indexation en échec", error),
      onDestroyError: (error) => this.warnLog.warn("Libération du PDF en échec", error),
      onWarn: (message) => this.warnLog.warn(message),
      shouldYield: () => this.userIsActive(), // les passes automatiques cèdent la place à l'utilisateur
    });
    return this.indexer;
  }

  private async runDiagnostic(): Promise<string> {
    const report = await runM0Diagnostic({
      kernel: createKernelApi(),
      fetch: (input, init) => fetch(input, init),
      pdfjs: window.pdfjsLib as PdfjsLike | undefined,
      createWorker: (url) => new Worker(url, { type: "module" }),
      now: () => performance.now(),
      petalDir: `${PETAL_ROOT}/${this.name}`,
    });
    return formatReport(report);
  }
}
