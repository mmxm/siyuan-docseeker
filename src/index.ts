import { Plugin, Setting, confirm, openTab, showMessage } from "siyuan";
import { createKernelApi } from "./siyuan/kernelApi";
import { traceKeys } from "./diagnostic/traceKeys";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";
import { createAutoSync, type AutoSync, type AutoSyncConfig } from "./indexer/autoSync";
import { createIndexActivity, type IndexActivity } from "./indexer/indexActivity";
import { createIndexer, type Indexer } from "./indexer/indexer";
import { SETTINGS_FILE, createSettings, type DocSeekerSettings, type SettingsStore } from "./settings";
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
/** Le focus est redemandé peu après l'ouverture : l'onglet n'est pas toujours affiché quand `openTab` se résout. */
const FOCUS_RETRY_MS = 50;

/** Une saisie plus récente que cela retarde la synchronisation automatique (extraction dans le thread principal). */
const TYPING_QUIET_MS = 3000;
const USER_ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

type PanelPart = "autoIndex" | "autoIndexInterval" | "reindex" | "clearIndex" | "diagnostic" | "log";
/** Items du panneau, dans l'ordre : clé i18n du titre (`<clé>Desc` pour la description) et partie du panneau. */
const SETTING_ITEMS: readonly { key: string; part: PanelPart }[] = [
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
      init: (custom) => this.renderTab(custom.element),
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
      callback: () => this.openSearchTab(),
    });

    // Aucun raccourci par défaut (hotkey "") : l'utilisateur choisit le sien dans les réglages de SiYuan.
    this.addCommand({
      langKey: COMMAND_OPEN_KEY,
      langText: this.t("commandOpenSearch"),
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
  private panel: SettingsPanel | null = null;
  private autoSync: AutoSync | null = null;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private autoSyncCleanup: (() => void) | null = null;
  private activity: IndexActivity | null = null;
  private readonly settings: SettingsStore = createSettings({
    load: () => this.loadData(SETTINGS_FILE) as Promise<unknown>,
    save: (value) => this.saveData(SETTINGS_FILE, value) as Promise<unknown>,
    onWarn: (message, error) => this.warnLog.warn(message, error),
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
    for (const host of [...this.tabCleanups.keys()]) this.disposeTab(host);
    this.removeTopBar(TOP_BAR_ID);
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

  private openSearchTab(): void {
    openTab({
      app: this.app,
      custom: {
        id: `${this.name}${TAB_TYPE}`,
        icon: ICON_NAME,
        title: this.t("tabTitle"),
      },
      openNewTab: true, // sans cela SiYuan refocalise l'onglet de recherche déjà ouvert (id fixe)
    });
  }

  /**
   * Commande « Aller au champ de recherche PDF » : ramène devant le dernier onglet de recherche ouvert (SiYuan
   * refocalise l'onglet existant quand `openNewTab` est absent) ou en ouvre un, puis focalise son champ.
   */
  private focusSearch(): void {
    const hasTab = this.searchTabs.size > 0;
    const fail = (error: unknown): void => this.warnLog.warn("Accès au champ de recherche impossible", error);
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

  private renderTab(host: Element): void {
    if (this.unloaded) return; // plugin déchargé : ne recrée ni index ni onglet orphelins
    this.disposeTab(host);
    const cleanups: Array<() => void> = [];
    this.tabCleanups.set(host, cleanups);
    host.replaceChildren();
    ensureSearchStyle(document);
    const container = document.createElement("div");
    container.style.padding = "16px";
    host.append(container);

    const searchHost = document.createElement("div");
    container.append(searchHost);
    const kernel = createKernelApi();
    const getPdfjs = (): PdfjsLoader | undefined => window.pdfjsLib as PdfjsLoader | undefined;
    const loadPdf = createLoadPdf(getPdfjs);
    const sharedIndex = this.getSharedIndex();
    void sharedIndex.start(); // idempotent : filet si l'onglet est rendu avant onLayoutReady
    const searchTab = mountSearchTab(searchHost, {
      store: this.getPetalStore(kernel),
      sharedIndex,
      onOpenSettings: () => this.openSetting(),
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
    });
    this.searchTabs.set(host, searchTab);
    cleanups.push(() => searchTab.dispose());
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
