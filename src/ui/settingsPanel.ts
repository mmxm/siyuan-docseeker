/**
 * Contenu du panneau de paramètres du plugin (Réindexer, Vider l'index, Diagnostic M0, journal).
 * Module DOM sans accès à SiYuan : tout (indexeur, magasin, `showMessage`, `confirm`…) est injecté.
 * Aucun `innerHTML` : les textes (dont ceux des événements de l'indexeur) passent par `textContent`.
 *
 * `createSettingsPanel` abonne des écouteurs (indexeur, journal) ; `dispose()` les libère (idempotent).
 */
import type { IndexerEvent } from "../indexer/indexer";
import { ensureSearchStyle } from "./searchStyles";

export const MESSAGE_TIMEOUT_MS = 6000;

type MessageType = "info" | "error";

/** Drapeau « vidage en cours » porté par le plugin : il survit à la fermeture et à la réouverture du panneau. */
export interface ClearingFlag {
  active(): boolean;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
  listenerCount(): number;
}

export function createClearingFlag(): ClearingFlag {
  let value = false;
  const listeners = new Set<() => void>();
  return {
    active: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
  };
}

export interface ClearOutcome {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly name: string; readonly error: unknown }[];
  readonly manifestFailed: boolean;
}

export interface SettingsPanelDeps {
  readonly t: (key: string) => string;
  readonly indexer: { onEvent(listener: (event: IndexerEvent) => void): () => void };
  /** Lance l'indexation ; peut rejeter (l'échec est journalisé et affiché ici). */
  readonly startIndexing: () => Promise<unknown>;
  /** Vrai tant que l'indexeur n'est pas au repos (lue aussi à l'ouverture pour initialiser l'état). */
  readonly isIndexing: () => boolean;
  /** Exclusion mutuelle vidage / réindexation, partagée entre les ouvertures du panneau. */
  readonly clearing: ClearingFlag;
  readonly clearIndex: () => Promise<ClearOutcome>;
  /** Rafraîchit l'index de recherche partagé après un vidage. */
  readonly refreshIndex: () => Promise<void>;
  readonly runDiagnostic: () => Promise<string>;
  readonly warnLog: {
    warn(message: string, error?: unknown): void;
    entries(): readonly string[];
    subscribe(listener: () => void): () => void;
  };
  readonly showMessage: (message: string, timeoutMs: number, type: MessageType) => void;
  readonly confirm: (title: string, text: string, onConfirm: () => void, onCancel?: () => void) => void;
  readonly doc?: Document;
}

export interface SettingsPanel {
  readonly reindex: HTMLElement;
  readonly clearIndex: HTMLElement;
  readonly diagnostic: HTMLElement;
  readonly log: HTMLElement;
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function describeEvent(event: IndexerEvent): string {
  switch (event.type) {
    case "started":
      return "Indexation démarrée";
    case "progress":
      return `${event.path} : page ${event.page}/${event.total}`;
    case "indexed":
      return `Indexé : ${event.path} (${plural(event.pages, "page", "pages")})`;
    case "skipped-scanned":
      return `PDF sans texte ignoré : ${event.path}`;
    case "failed":
      return `Échec : ${event.path} : ${event.message}`;
    case "removed":
      return `Index supprimé : ${event.path}`;
    case "idle": {
      const s = event.summary;
      const parts = [
        plural(s.indexed, "indexé", "indexés"),
        `${s.skippedScanned} sans texte`,
        plural(s.failed, "échec", "échecs"),
        plural(s.removed, "supprimé", "supprimés"),
      ];
      return `Terminé : ${parts.join(", ")}${s.cancelled ? " (annulé)" : ""}`;
    }
  }
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const doc = deps.doc ?? document;
  const { t, warnLog, clearing } = deps;
  ensureSearchStyle(doc); // le panneau vit hors de l'onglet, qui injecte normalement la feuille de style

  /** Bloc de texte ; `live` en fait une région d'état annoncée poliment, `label` lui donne un nom. */
  const textBlock = (options: { live: boolean; label?: string; role?: "alert" }): HTMLPreElement => {
    const pre = doc.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.userSelect = "text";
    if (options.label) pre.setAttribute("aria-label", options.label);
    if (options.live) {
      pre.setAttribute("role", "status");
      pre.setAttribute("aria-live", "polite");
    }
    if (options.role) pre.setAttribute("role", options.role);
    return pre;
  };

  /** Bouton `aria-disabled` (reste focalisable) : un clic ignoré l'explique dans la région d'état. */
  const guardedButton = (
    className: string,
    label: string,
    status: HTMLElement,
    run: () => Promise<void>,
  ): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `b3-button b3-button--outline docseeker-action ${className}`;
    button.textContent = label;
    let busy = false;
    button.addEventListener("click", () => {
      if (busy) {
        status.textContent = t("alreadyRunning");
        return;
      }
      busy = true;
      button.setAttribute("aria-disabled", "true");
      void run().finally(() => {
        busy = false;
        button.removeAttribute("aria-disabled");
      });
    });
    return button;
  };

  const container = (...children: Node[]): HTMLElement => {
    const div = doc.createElement("div");
    div.className = "docseeker-setting-action";
    div.append(...children);
    return div;
  };

  // --- Réindexer : l'état est annoncé, la progression (un événement par page) ne l'est pas.
  const indexStatus = textBlock({ live: true, label: t("indexStatusLabel") });
  const indexProgress = textBlock({ live: false, label: t("indexProgressLabel") });
  if (deps.isIndexing()) indexStatus.textContent = t("indexRunning"); // panneau rouvert pendant une indexation
  const indexButton = guardedButton("docseeker-index", t("reindex"), indexStatus, async () => {
    if (clearing.active()) {
      indexStatus.textContent = t("reindexBlockedByClear");
      return;
    }
    try {
      await deps.startIndexing();
    } catch (error) {
      warnLog.warn("Indexation en échec", error);
      const text = `${t("indexFailed")} : ${messageOf(error)}`;
      indexStatus.textContent = text;
      deps.showMessage(text, MESSAGE_TIMEOUT_MS, "error");
    }
  });
  const unsubscribeIndexer = deps.indexer.onEvent((event) => {
    if (event.type === "progress") indexProgress.textContent = describeEvent(event);
    else {
      indexProgress.textContent = "";
      indexStatus.textContent = describeEvent(event);
    }
  });

  // --- Vider l'index : confirmation, suppression, rafraîchissement ; tout échec est signalé.
  // Deux régions : l'état (poli) et l'alerte (erreurs), comme la vue de recherche.
  const clearStatus = textBlock({ live: true, label: t("indexStatusLabel") });
  const clearAlert = textBlock({ live: false, label: t("indexStatusLabel"), role: "alert" });
  const report = (text: string, type: MessageType): void => {
    clearStatus.textContent = type === "info" ? text : "";
    clearAlert.textContent = type === "error" ? text : "";
    deps.showMessage(text, MESSAGE_TIMEOUT_MS, type);
  };
  const clearButton = doc.createElement("button");
  clearButton.type = "button";
  clearButton.className = "b3-button b3-button--outline docseeker-action docseeker-clear-index";
  clearButton.textContent = t("clearIndex");

  const partialText = (n: number): string => t(n === 1 ? "clearPartialOne" : "clearPartialMany").replace("{n}", String(n));
  const doClear = async (): Promise<void> => {
    let result: ClearOutcome;
    try {
      result = await deps.clearIndex();
    } catch (error) {
      warnLog.warn("Vidage de l'index en échec", error);
      report(`${t("clearFailed")} : ${messageOf(error)}`, "error");
      return;
    }
    for (const failure of result.failed) warnLog.warn(`Suppression de ${failure.name} en échec`, failure.error);
    if (result.manifestFailed) {
      report(t("clearManifestFailed"), "error"); // rien n'a été supprimé d'autre : pas de rafraîchissement utile
      return;
    }
    let refreshError: unknown;
    try {
      await deps.refreshIndex();
    } catch (error) {
      warnLog.warn("Rafraîchissement après vidage en échec", error);
      refreshError = error;
    }
    const partial = result.failed.length > 0 ? partialText(result.failed.length) : undefined;
    const refresh = refreshError === undefined ? undefined : `${t("clearRefreshFailed")} : ${messageOf(refreshError)}`;
    if (partial === undefined && refresh === undefined) report(t("clearDone"), "info");
    else report([partial, refresh].filter((x) => x !== undefined).join(" "), "error");
  };

  const syncClearing = (): void => {
    if (clearing.active()) {
      clearButton.setAttribute("aria-disabled", "true");
      clearAlert.textContent = "";
      clearStatus.textContent = t("clearRunning");
    } else {
      clearButton.removeAttribute("aria-disabled");
      // Vidage terminé ailleurs (panneau précédent) : ne laisse pas un « en cours » périmé.
      if ([t("clearRunning"), t("alreadyRunning")].includes(clearStatus.textContent ?? "")) clearStatus.textContent = "";
    }
  };
  if (clearing.active()) syncClearing();
  const unsubscribeClearing = clearing.subscribe(syncClearing);

  clearButton.addEventListener("click", () => {
    if (clearing.active()) {
      clearStatus.textContent = t("alreadyRunning");
      return;
    }
    if (deps.isIndexing()) {
      report(t("clearBusy"), "error");
      return;
    }
    deps.confirm(
      t("clearConfirmTitle"),
      t("clearConfirmText"),
      () => {
        if (clearing.active()) return;
        if (deps.isIndexing()) {
          report(t("clearBusy"), "error");
          return;
        }
        clearing.set(true);
        void doClear().finally(() => clearing.set(false));
      },
      () => undefined,
    );
  });

  // --- Diagnostic : état court annoncé, rapport complet dans un bloc non annoncé.
  const diagnosticStatus = textBlock({ live: true, label: t("indexStatusLabel") });
  const diagnosticReport = textBlock({ live: false, label: t("diagnosticOutputLabel") });
  diagnosticReport.className = "docseeker-diagnostic-report";
  const diagnosticButton = guardedButton("docseeker-diagnostic", t("diagnostic"), diagnosticStatus, async () => {
    diagnosticStatus.textContent = t("diagnosticRunning");
    diagnosticReport.textContent = "";
    try {
      diagnosticReport.textContent = await deps.runDiagnostic();
      diagnosticStatus.textContent = t("diagnosticDone");
    } catch (error) {
      diagnosticReport.textContent = messageOf(error); // affiché ici : pas de second message
      diagnosticStatus.textContent = t("diagnosticFailed");
    }
  });

  // --- Journal des avertissements : groupe nommé, focusable (défilement au clavier), non annoncé.
  const log = textBlock({ live: false, label: t("warnLog") });
  log.className = "docseeker-log";
  log.setAttribute("role", "group");
  log.tabIndex = 0;
  const renderLog = (): void => {
    const entries = warnLog.entries();
    log.textContent = entries.length > 0 ? entries.join("\n") : t("warnLogEmpty");
  };
  renderLog();
  const unsubscribeLog = warnLog.subscribe(renderLog);

  let disposed = false;
  return {
    reindex: container(indexButton, indexStatus, indexProgress),
    clearIndex: container(clearButton, clearStatus, clearAlert),
    diagnostic: container(diagnosticButton, diagnosticStatus, diagnosticReport),
    log: container(log),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeIndexer();
      unsubscribeLog();
      unsubscribeClearing();
    },
  };
}
