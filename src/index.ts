import { Plugin, openTab, showMessage } from "siyuan";
import { createKernelApi } from "./siyuan/kernelApi";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";
import { createIndexer, type Indexer, type IndexerEvent } from "./indexer/indexer";
import { createLoadPdf, type PdfjsLoader } from "./indexer/loadPdf";
import { discoverPdfs } from "./siyuan/discovery";
import { createPetalStore, type PetalStore } from "./siyuan/petalStore";
import { decodeIndexForSearch } from "./core/codec/decode";
import { createSharedIndex, type SharedIndex } from "./search/sharedIndex";
import { createWarnLog, mountSearchTab } from "./searchTab";
import { ensureSearchStyle } from "./ui/searchStyles";
import type { OpenTabFn } from "./siyuan/openPdf";
import type { RenderableDocument } from "./siyuan/pdfRenderer";

const TAB_TYPE = "docseeker";
const TOP_BAR_ID = "docseeker-top-bar";
const PETAL_ROOT = "/data/storage/petal";
const ICON_NAME = "iconSearch";
const COMMAND_OPEN_KEY = "openSearch";
const MESSAGE_TIMEOUT_MS = 6000;

declare global {
  interface Window {
    pdfjsLib?: unknown;
  }
}

function describeEvent(event: IndexerEvent): string {
  switch (event.type) {
    case "started":
      return "Indexation démarrée";
    case "progress":
      return `${event.path} : page ${event.page}/${event.total}`;
    case "indexed":
      return `Indexé : ${event.path} (${event.pages} pages)`;
    case "skipped-scanned":
      return `PDF sans texte ignoré : ${event.path}`;
    case "failed":
      return `Échec : ${event.path} — ${event.message}`;
    case "removed":
      return `Index supprimé : ${event.path}`;
    case "idle": {
      const s = event.summary;
      return `Terminé : ${s.indexed} indexé(s), ${s.skippedScanned} sans texte, ${s.failed} échec(s), ${s.removed} supprimé(s)${s.cancelled ? " (annulé)" : ""}`;
    }
  }
}

/** Point d'entrée du plugin. Onglet de recherche (mountSearchTab) + section repliable (Réindexer, Diagnostic M0). */
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

  override onunload(): void {
    this.unloaded = true;
    this.indexer?.cancel();
    this.sharedIndex?.dispose();
    this.sharedIndex = null;
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

  /** Lance l'indexation ; un échec est montré à l'utilisateur et journalisé. */
  private startIndexing(indexer: Indexer): Promise<void> {
    return indexer.start().then(
      () => undefined,
      (error: unknown) => {
        this.warnLog.warn("Indexation en échec", error);
        const message = error instanceof Error ? error.message : String(error);
        showMessage(`${this.t("indexFailed")} : ${message}`, MESSAGE_TIMEOUT_MS, "error");
      },
    );
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
    const indexer = this.getIndexer();
    const kernel = createKernelApi();
    const getPdfjs = (): PdfjsLoader | undefined => window.pdfjsLib as PdfjsLoader | undefined;
    const loadPdf = createLoadPdf(getPdfjs);
    const sharedIndex = this.getSharedIndex();
    void sharedIndex.start(); // idempotent : filet si l'onglet est rendu avant onLayoutReady
    const searchTab = mountSearchTab(searchHost, {
      store: this.getPetalStore(kernel),
      sharedIndex,
      indexer,
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

    const details = document.createElement("details");
    details.style.marginTop = "16px";
    const summary = document.createElement("summary");
    summary.className = "docseeker-summary";
    summary.textContent = this.t("advanced");
    details.append(summary);
    container.append(details);

    /** Bouton `aria-disabled` (reste focalisable) : le clic est ignoré tant que l'action tourne. */
    const guardedButton = (className: string, label: string, run: () => Promise<void>): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `b3-button b3-button--outline docseeker-action ${className}`;
      button.textContent = label;
      let busy = false;
      button.addEventListener("click", () => {
        if (busy) return;
        busy = true;
        button.setAttribute("aria-disabled", "true");
        void run().finally(() => {
          busy = false;
          button.removeAttribute("aria-disabled");
        });
      });
      return button;
    };
    const textBlock = (live: boolean): HTMLPreElement => {
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.style.userSelect = "text";
      if (live) {
        pre.setAttribute("role", "status");
        pre.setAttribute("aria-live", "polite");
      }
      return pre;
    };

    const output = textBlock(true);
    const diagnosticButton = guardedButton("docseeker-diagnostic", this.t("diagnostic"), async () => {
      output.textContent = "…";
      try {
        output.textContent = await this.runDiagnostic();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.textContent = message;
        showMessage(message, MESSAGE_TIMEOUT_MS, "error");
      }
    });

    const indexButton = guardedButton("docseeker-index", this.t("reindex"), () => this.startIndexing(indexer));
    // Les événements de progression (un par page) ne sont pas annoncés : seuls les changements d'état le sont.
    const indexStatus = textBlock(true);
    const indexProgress = textBlock(false);
    cleanups.push(
      indexer.onEvent((event) => {
        if (event.type === "progress") indexProgress.textContent = describeEvent(event);
        else {
          indexProgress.textContent = "";
          indexStatus.textContent = describeEvent(event);
        }
      }),
    );

    const logTitle = document.createElement("div");
    logTitle.textContent = this.t("warnLog");
    const log = textBlock(false);
    log.className = "docseeker-log";
    log.setAttribute("role", "log");
    const renderLog = (): void => {
      log.textContent = this.warnLog.entries().join("\n");
    };
    renderLog();
    cleanups.push(this.warnLog.subscribe(renderLog));

    details.append(indexButton, indexStatus, indexProgress, diagnosticButton, output, logTitle, log);
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
