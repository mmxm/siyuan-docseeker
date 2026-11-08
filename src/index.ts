import { Plugin, Setting, confirm, getFrontend, openTab, showMessage } from "siyuan";
import { readFrontend } from "./platform/frontend";
import { applySettingsOverride, profileFor, type PlatformProfile } from "./platform/profile";
import { openConfirmDialog, openCustomDialog, openDialog, openFloatingDialog, openInputDialog, openMenu } from "./siyuan/nativeUi";
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
import { createLazyPdfjs } from "./siyuan/pdfjsLoader";
import { discoverPdfs } from "./siyuan/discovery";
import { createPetalStore, type PetalStore } from "./siyuan/petalStore";
import { decodeIndexForSearch } from "./core/codec/decode";
import { createSharedIndex, type SharedIndex } from "./search/sharedIndex";
import { createWarnLog, mountSearchTab, type SearchTab } from "./searchTab";
import { ensureSearchStyle } from "./ui/searchStyles";
import { isShown } from "./ui/visibility";
import { createClearingFlag, createSettingsPanel, type SettingsPanel } from "./ui/settingsPanel";
import type { OpenTabFn } from "./siyuan/openPdf";
import type { CustomDialogHandle } from "./ui/nativeUiTypes";
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

/** Motif d'un refus d'indexer ou de vider l'index en lecture seule (mobile) ; tracé et affiché par le panneau. */
const READ_ONLY_MESSAGE = "Mode lecture seule : l'index se construit sur ordinateur";

/** Une saisie plus récente que cela retarde la synchronisation automatique (extraction dans le thread principal). */
const TYPING_QUIET_MS = 3000;
const USER_ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

type PanelPart = "openMode" | "autoIndex" | "autoIndexInterval" | "reindex" | "clearIndex" | "diagnostic" | "log";
/**
 * Items du panneau, dans l'ordre : clé i18n du titre (`<clé>Desc` pour la description) et partie du panneau. `writes` : la partie
 * indexe, vide l'index ou règle l'ouverture/l'indexation ; inopérante (et dangereuse) en lecture seule, elle n'est alors pas affichée.
 */
const SETTING_ITEMS: readonly { key: string; part: PanelPart; writes: boolean }[] = [
  { key: "openMode", part: "openMode", writes: true },
  { key: "autoIndex", part: "autoIndex", writes: true },
  { key: "autoIndexInterval", part: "autoIndexInterval", writes: true },
  { key: "reindex", part: "reindex", writes: true },
  { key: "clearIndex", part: "clearIndex", writes: true },
  { key: "diagnostic", part: "diagnostic", writes: false },
  { key: "warnLog", part: "log", writes: false },
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
    const profile = this.getProfile();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- `destroy` reçoit l'onglet comme `this`
    const plugin = this;
    // Mobile : `addTab` ne renvoie rien et `openTab` est un stub, un onglet n'y serait jamais affiché.
    if (profile.canOpenTab) {
      this.addTab({
        type: TAB_TYPE,
        init: (custom) => this.renderTab(custom.element, custom),
        // Chaque onglet libère ses propres ressources : en détruire un ne touche pas les autres.
        destroy() {
          plugin.disposeTab(this.element);
        },
      });
    }

    this.setting = new Setting({ destroyCallback: () => this.disposePanel() });
    for (const part of this.visibleSettingItems()) {
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
    if (profile.canOpenTab) {
      this.addCommand({
        langKey: COMMAND_OPEN_TAB_KEY,
        langText: this.t("commandOpenSearchTab"),
        hotkey: "",
        callback: () => this.openSearchTab(),
      });
    }
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
      // Mobile : l'index est chargé à la première ouverture de la recherche (le montage d'un onglet appelle `start()`).
      if (!this.getProfile().lazyIndexLoad) void this.getSharedIndex().start();
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
    // Lecture seule (mobile) : ni indexation, ni nettoyage des .tmp (qui écrit dans le dossier d'index partagé).
    if (this.getProfile().readOnly) return;
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
    const unsubscribeSettings = this.settings.subscribe(() => autoSync.configure(toConfig(this.effectiveSettings())));
    this.autoSyncCleanup = () => {
      unsubscribeSettings();
      for (const type of USER_ACTIVITY_EVENTS) document.removeEventListener(type, onInput, { capture: true });
      autoSync.dispose();
    };
    this.settings
      .load()
      .then((loaded) => {
        if (!this.unloaded) autoSync.start(toConfig(applySettingsOverride(loaded, this.getProfile())));
      })
      .catch((error: unknown) => this.warnLog.warn("Démarrage de l'indexation automatique en échec", error));
  }

  private unloaded = false;
  private indexer: Indexer | null = null;
  private lazyPdfjs: (() => Promise<PdfjsLoader>) | undefined;
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
  /** Dialogue des réglages (mobile), ouvert au plus une fois. */
  private settingsDialog: CustomDialogHandle | null = null;
  private autoSync: AutoSync | null = null;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private autoSyncCleanup: (() => void) | null = null;
  private activity: IndexActivity | null = null;
  private profile: PlatformProfile | undefined;
  private readonly settings: SettingsStore = createSettings({
    load: () => this.loadData(SETTINGS_FILE) as Promise<unknown>,
    save: (value) => this.saveData(SETTINGS_FILE, value) as Promise<unknown>,
    onWarn: (message, error) => this.warnLog.warn(message, error),
    // Mobile : le dossier du plugin est synchronisé, les réglages ne vivent qu'en mémoire (jamais de saveData).
    readOnly: () => this.getProfile().readOnly,
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
    try {
      this.settingsDialog?.close();
    } catch (error) {
      this.warnLog.warn("Fermeture des réglages en échec", error);
    }
    this.settingsDialog = null;
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

  /** Items du panneau à afficher : en lecture seule (mobile), les parties qui indexent, vident l'index ou règlent l'ouverture sont retirées. */
  private visibleSettingItems(): readonly (typeof SETTING_ITEMS)[number][] {
    const readOnly = this.getProfile().readOnly;
    return SETTING_ITEMS.filter((item) => !(readOnly && item.writes));
  }

  /** Ouvre les réglages : panneau natif sur bureau ; sur mobile, dialogue du plugin (le chemin `openSetting` n'y est pas garanti). */
  private openSettings(): void {
    if (this.unloaded) return;
    if (!this.getProfile().settingsInDialog) {
      this.openSetting();
      return;
    }
    if (this.settingsDialog?.isOpen()) return;
    try {
      ensureSearchStyle(document); // les classes des sections viennent de la feuille du plugin
      const content = document.createElement("div");
      for (const item of this.visibleSettingItems()) {
        const section = document.createElement("div");
        section.className = "docseeker-settings-section";
        const title = document.createElement("div");
        title.className = "b3-label__text docseeker-settings-title";
        title.textContent = this.t(item.key);
        const description = document.createElement("div");
        description.className = "b3-label__text";
        description.textContent = this.t(`${item.key}Desc`);
        section.append(title, description, this.panelPart(item.part));
        content.append(section);
      }
      this.settingsDialog = openCustomDialog({
        title: this.t("settingsDialogTitle"),
        width: "94vw",
        height: "90vh",
        dataKey: "docseeker-settings",
        content,
        onDestroyed: () => {
          this.settingsDialog = null;
          this.disposePanel();
        },
      });
    } catch (error) {
      this.disposePanel();
      this.warnLog.warn("Ouverture des réglages impossible", error);
      this.toast(this.t("settingsOpenFailed"));
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
    const readOnly = this.getProfile().readOnly;
    return createSettingsPanel({
      t: (key) => this.t(key),
      indexer,
      startIndexing: () => {
        if (readOnly) return Promise.reject(new Error(READ_ONLY_MESSAGE));
        if (sharedIndex.getError() !== undefined) void sharedIndex.start(); // retente un chargement échoué (ne rejette jamais)
        return indexer.start();
      },
      isIndexing: () => indexer.getState().status !== "idle",
      clearing: this.clearing,
      clearIndex: () => (readOnly ? Promise.reject(new Error(READ_ONLY_MESSAGE)) : store.clear()),
      // Le panneau montre les valeurs EFFECTIVES (surcharges du profil comprises), pas les valeurs brutes du fichier.
      settings: {
        get: () => this.effectiveSettings(),
        update: (patch) => this.settings.update(patch),
        subscribe: (listener) => this.settings.subscribe(listener),
      },
      readOnly,
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

  /**
   * Profil de plateforme, lu une seule fois : `getFrontend()` de l'API SiYuan (jamais le user-agent). Valeur inconnue ou erreur :
   * profil bureau, avec un avertissement dans le journal.
   */
  private getProfile(): PlatformProfile {
    return (this.profile ??= profileFor(readFrontend(() => getFrontend(), (message, error) => this.warnLog.warn(message, error))));
  }

  /** Réglages effectifs : ceux du fichier avec les surcharges du profil, appliquées à la lecture. En lecture seule (mobile), `settings.json` n'est jamais écrit non plus : les changements restent en mémoire pour la session. */
  private effectiveSettings(): DocSeekerSettings {
    return applySettingsOverride(this.settings.get(), this.getProfile());
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
      // Sans onglet possible (mobile), la recherche s'ouvre toujours en dialogue, quel que soit le réglage.
      if (mode === "dialog" || !this.getProfile().canOpenTab) this.openFloatingSearch();
      else this.openSearchTab();
    };
    this.settings.ready
      .then(
        () => open(this.effectiveSettings().openMode),
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
      // Bureau : fenêtre flottante ; mobile : plein écran (le profil décide).
      openDialog: (options) => openFloatingDialog({ ...options, layout: this.getProfile().floatingLayout }),
      title: this.t("floatingTitle"),
      closeLabel: this.t("floatingClose"),
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
    if (!this.getProfile().canOpenTab) return this.openFloatingSearch(); // filet : `openTab` est un stub sur mobile
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
    if (!this.getProfile().canOpenTab) return Promise.reject(new Error("Onglets indisponibles sur mobile (openTab est un stub)"));
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
    if (this.unloaded || this.transferring || this.floating?.isOpen() !== true || !this.getProfile().canOpenTab) return;
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
    if (!this.getProfile().canOpenTab) {
      // Mobile : pas d'onglet à ramener, la fenêtre de recherche (rouverte si besoin) est le seul endroit.
      this.openFloatingSearch();
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
    const profile = this.getProfile();
    const loadPdf = createLoadPdf(this.getPdfjs(), undefined, { disableAutoFetch: profile.disableAutoFetch });
    const sharedIndex = this.getSharedIndex();
    void sharedIndex.start(); // idempotent : filet si l'onglet est rendu avant onLayoutReady
    return mountSearchTab(host, {
      store: this.getPetalStore(kernel),
      kernel, // filtre « portée de documents » (PDF cités par SQL, arbre des cahiers et documents)
      sharedIndex,
      profile,
      onOpenSettings: () => this.openSettings(),
      openMenu,
      openDialog,
      openCustomDialog,
      openInputDialog,
      openConfirmDialog,
      toast: (message) => this.toast(message), // échec d'écriture d'un critère après la fermeture de l'onglet
      settings: this.settings, // tri et regroupement mémorisés
      indexActivity: this.getActivity(),
      // Mobile : `openTab` est un stub qui ne fait rien : il n'est pas injecté.
      ...(profile.canOpenTab ? { openTab: openTab as unknown as OpenTabFn } : {}),
      // Mobile : le PDF s'ouvre dans le visionneur de page, un second dialogue plein écran empilé sur la recherche.
      ...(profile.canOpenTab ? {} : { openFloatingDialog }),
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
                // Mobile : la recherche reste ouverte sous le PDF (on y revient sans la relancer).
                if (profile.canOpenTab) floating.close({ restoreFocus: false });
              },
              ...(profile.canOpenTab ? { onOpenInTab: () => this.transferToTab(floating.close) } : {}),
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
      decodeConcurrency: this.getProfile().decodeConcurrency,
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

  /**
   * Chargeur PDF.js paresseux, partagé par l'onglet, l'indexeur et le diagnostic. Sur bureau, `window.pdfjsLib`
   * est normalement déjà posé par les gabarits de SiYuan : il est alors renvoyé tel quel, sans rien injecter.
   * Sinon (mobile), l'injection du module PDF.js de SiYuan comble le manque.
   */
  private getPdfjs(): () => Promise<PdfjsLoader> {
    return (this.lazyPdfjs ??= createLazyPdfjs({ window, document }));
  }

  private getIndexer(): Indexer {
    if (this.indexer) return this.indexer;
    const kernel = createKernelApi();
    this.indexer = createIndexer({
      discover: () => discoverPdfs({ api: kernel }),
      store: this.getPetalStore(kernel),
      loadPdf: createLoadPdf(this.getPdfjs(), undefined, { disableAutoFetch: this.getProfile().disableAutoFetch }),
      now: () => Date.now(),
      onListenerError: (error) => this.warnLog.warn("Écouteur d'indexation en échec", error),
      onDestroyError: (error) => this.warnLog.warn("Libération du PDF en échec", error),
      onWarn: (message) => this.warnLog.warn(message),
      shouldYield: () => this.userIsActive(), // les passes automatiques cèdent la place à l'utilisateur
    });
    return this.indexer;
  }

  private async runDiagnostic(): Promise<string> {
    // PDF.js : celui de SiYuan s'il existe (bureau), sinon chargé paresseusement ; un échec est tracé
    // et son message est transmis au rapport (« pdfjs indisponible : <cause> »).
    let pdfjs: PdfjsLike | undefined;
    let pdfjsError: string | undefined;
    try {
      pdfjs = (await this.getPdfjs()()) as PdfjsLike;
    } catch (error) {
      this.warnLog.warn("Chargement de PDF.js en échec (diagnostic)", error);
      pdfjsError = error instanceof Error ? error.message : String(error);
    }
    const report = await runM0Diagnostic({
      kernel: createKernelApi(),
      fetch: (input, init) => fetch(input, init),
      pdfjs,
      ...(pdfjsError === undefined ? {} : { pdfjsError }),
      createWorker: (url) => new Worker(url, { type: "module" }),
      now: () => performance.now(),
      petalDir: `${PETAL_ROOT}/${this.name}`,
      readOnly: this.getProfile().readOnly,
    });
    return formatReport(report);
  }
}
