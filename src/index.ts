import { Plugin, Setting, confirm, openTab, showMessage } from "siyuan";
import { createKernelApi } from "./siyuan/kernelApi";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";
import { createIndexer, type Indexer } from "./indexer/indexer";
import { createLoadPdf, type PdfjsLoader } from "./indexer/loadPdf";
import { discoverPdfs } from "./siyuan/discovery";
import { createPetalStore, type PetalStore } from "./siyuan/petalStore";
import { decodeIndexForSearch } from "./core/codec/decode";
import { createSharedIndex, type SharedIndex } from "./search/sharedIndex";
import { createWarnLog, mountSearchTab } from "./searchTab";
import { ensureSearchStyle } from "./ui/searchStyles";
import { createClearingFlag, createSettingsPanel, type SettingsPanel } from "./ui/settingsPanel";
import type { OpenTabFn } from "./siyuan/openPdf";
import type { RenderableDocument } from "./siyuan/pdfRenderer";

const TAB_TYPE = "docseeker";
const TOP_BAR_ID = "docseeker-top-bar";
const PETAL_ROOT = "/data/storage/petal";
const ICON_NAME = "iconSearch";
const COMMAND_OPEN_KEY = "openSearch";

type PanelPart = "reindex" | "clearIndex" | "diagnostic" | "log";
/** Items du panneau, dans l'ordre : clé i18n du titre (`<clé>Desc` pour la description) et partie du panneau. */
const SETTING_ITEMS: readonly { key: string; part: PanelPart }[] = [
  { key: "reindex", part: "reindex" },
  { key: "clearIndex", part: "clearIndex" },
  { key: "diagnostic", part: "diagnostic" },
  { key: "warnLog", part: "log" },
];

declare global {
  interface Window {
    pdfjsLib?: unknown;
  }
}

/** Point d'entrée du plugin. Onglet de recherche (mountSearchTab) + panneau de paramètres (Réindexer, Vider l'index, Diagnostic M0, journal). */
export default class DocSeekerPlugin extends Plugin {
  override onload(): void {
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
        direction: "column",
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

    this.addCommand({
      langKey: COMMAND_OPEN_KEY,
      hotkey: "",
      callback: () => this.openSearchTab(),
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
  }

  private unloaded = false;
  private indexer: Indexer | null = null;
  private sharedIndex: SharedIndex | null = null;
  private petalStore: PetalStore | null = null;
  private readonly tabCleanups = new Map<Element, Array<() => void>>();
  private readonly warnLog = createWarnLog();
  private panel: SettingsPanel | null = null;
  /** Vidage de l'index en cours : porté ici pour survivre à la fermeture/réouverture du panneau. */
  private readonly clearing = createClearingFlag();

  override onunload(): void {
    this.unloaded = true;
    this.indexer?.cancel();
    this.sharedIndex?.dispose();
    this.sharedIndex = null;
    this.disposePanel();
    for (const host of [...this.tabCleanups.keys()]) this.disposeTab(host);
    this.removeTopBar(TOP_BAR_ID);
  }

  private disposeTab(host: Element): void {
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
      refreshIndex: () => sharedIndex.refreshNow(),
      runDiagnostic: () => this.runDiagnostic(),
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
