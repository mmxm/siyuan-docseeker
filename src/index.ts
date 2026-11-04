import { Plugin, openTab, showMessage } from "siyuan";
import { createKernelApi } from "./siyuan/kernelApi";
import { formatReport, runM0Diagnostic, type PdfjsLike } from "./diagnostic/m0";

const TAB_TYPE = "docseeker";
const TOP_BAR_ID = "docseeker-top-bar";
const PETAL_ROOT = "/data/storage/petal";
const ICON_NAME = "iconSearch";
const COMMAND_OPEN_KEY = "openSearch";
const MESSAGE_TIMEOUT_MS = 6000;

declare global {
  interface Window {
    pdfjsLib?: PdfjsLike;
  }
}

/** Point d'entrée du plugin. La recherche arrive aux étapes suivantes; pour l'instant: onglet + diagnostic M0. */
export default class DocSeekerPlugin extends Plugin {
  override onload(): void {
    this.addTab({
      type: TAB_TYPE,
      init: (custom) => this.renderTab(custom.element),
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

  override onunload(): void {
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

    container.append(button, output);
  }

  private async runDiagnostic(): Promise<string> {
    const report = await runM0Diagnostic({
      kernel: createKernelApi(),
      fetch: (input, init) => fetch(input, init),
      pdfjs: window.pdfjsLib,
      createWorker: (url) => new Worker(url, { type: "module" }),
      now: () => performance.now(),
      petalDir: `${PETAL_ROOT}/${this.name}`,
    });
    return formatReport(report);
  }
}
