import { Plugin, openTab, showMessage } from "siyuan";
import { createKernelApi } from "./siyuan/kernelApi";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";
import { createIndexer, type Indexer, type IndexerEvent } from "./indexer/indexer";
import { createLoadPdf, type PdfjsLoader } from "./indexer/loadPdf";
import { discoverPdfs } from "./siyuan/discovery";
import { createPetalStore } from "./siyuan/petalStore";

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

/** Point d'entrée du plugin. La recherche arrive aux étapes suivantes; pour l'instant: onglet + diagnostic M0. */
export default class DocSeekerPlugin extends Plugin {
  override onload(): void {
    this.addTab({
      type: TAB_TYPE,
      init: (custom) => this.renderTab(custom.element),
      destroy: () => {
        for (const cleanup of this.tabCleanups.splice(0)) cleanup();
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

  private indexer: Indexer | null = null;
  private readonly tabCleanups: Array<() => void> = [];

  override onunload(): void {
    this.indexer?.cancel();
    for (const cleanup of this.tabCleanups.splice(0)) cleanup();
    this.removeTopBar(TOP_BAR_ID);
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
    host.replaceChildren();
    const container = document.createElement("div");
    container.style.padding = "16px";
    host.append(container);

    const button = document.createElement("button");
    button.className = "b3-button b3-button--outline";
    button.textContent = this.t("diagnostic");

    const output = document.createElement("pre");
    output.style.whiteSpace = "pre-wrap";
    output.style.userSelect = "text";

    button.addEventListener("click", () => {
      button.disabled = true;
      output.textContent = "…";
      this.runDiagnostic()
        .then((text) => {
          output.textContent = text;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          output.textContent = message;
          showMessage(message, MESSAGE_TIMEOUT_MS, "error");
        })
        .finally(() => {
          button.disabled = false;
        });
    });

    const indexButton = document.createElement("button");
    indexButton.className = "b3-button b3-button--outline";
    indexButton.textContent = this.t("reindex");
    const indexStatus = document.createElement("pre");
    indexStatus.style.whiteSpace = "pre-wrap";
    indexStatus.style.userSelect = "text";

    const indexer = this.getIndexer();
    const unsubscribe = indexer.onEvent((event) => {
      indexStatus.textContent = describeEvent(event);
    });
    this.tabCleanups.push(unsubscribe);
    indexButton.addEventListener("click", () => {
      indexButton.disabled = true;
      void indexer.start().finally(() => {
        indexButton.disabled = false;
      });
    });

    container.append(indexButton, indexStatus, button, output);
  }

  private getIndexer(): Indexer {
    if (this.indexer) return this.indexer;
    const kernel = createKernelApi();
    this.indexer = createIndexer({
      discover: () => discoverPdfs({ api: kernel }),
      store: createPetalStore({ api: kernel, pluginName: this.name }),
      loadPdf: createLoadPdf(() => window.pdfjsLib as PdfjsLoader | undefined),
      now: () => Date.now(),
      onListenerError: (error) => console.error("[docseeker] listener", error),
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
