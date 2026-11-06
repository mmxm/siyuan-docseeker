/**
 * Contenu du panneau de paramètres du plugin (Réindexer, Vider l'index, Diagnostic M0, journal).
 * Module DOM sans accès à SiYuan : tout (indexeur, magasin, `showMessage`, `confirm`…) est injecté.
 * Aucun `innerHTML` : les textes (dont ceux des événements de l'indexeur) passent par `textContent`.
 *
 * `createSettingsPanel` abonne des écouteurs (indexeur, journal) ; `dispose()` les libère (idempotent).
 */
import type { IndexerEvent } from "../indexer/indexer";
import { FREQUENCY_MINUTES, type DocSeekerSettings } from "../settings";
import { ensureSearchStyle } from "./searchStyles";

export const MESSAGE_TIMEOUT_MS = 6000;
let panelSeq = 0;

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
  /** Réglages persistés (indexation automatique). */
  readonly settings: {
    get(): DocSeekerSettings;
    update(patch: Partial<DocSeekerSettings>): Promise<void>;
    subscribe(listener: () => void): () => void;
  };
  /** Déclenche une synchronisation automatique (après un vidage, drapeau déjà libéré) ; vrai si elle va avoir lieu. */
  readonly startAutoSync: () => boolean;
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
  readonly autoIndex: HTMLElement;
  readonly autoIndexInterval: HTMLElement;
  readonly reindex: HTMLElement;
  readonly clearIndex: HTMLElement;
  readonly diagnostic: HTMLElement;
  readonly log: HTMLElement;
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isQuiet = (s: { indexed: number; skippedScanned: number; failed: number; removed: number; cancelled: boolean }): boolean =>
  s.indexed + s.skippedScanned + s.failed + s.removed === 0 && !s.cancelled;
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
  // Les passes automatiques sont silencieuses ici : « démarrée » et un bilan à zéro ne s'affichent que
  // pour une passe demandée par le bouton.
  let manualRun = false;
  const indexButton = guardedButton("docseeker-index", t("reindex"), indexStatus, async () => {
    if (clearing.active()) {
      indexStatus.textContent = t("reindexBlockedByClear");
      return;
    }
    manualRun = true;
    try {
      await deps.startIndexing();
      manualRun = false;
    } catch (error) {
      manualRun = false;
      warnLog.warn("Indexation en échec", error);
      const text = `${t("indexFailed")} : ${messageOf(error)}`;
      indexStatus.textContent = text;
      deps.showMessage(text, MESSAGE_TIMEOUT_MS, "error");
    }
  });
  const unsubscribeIndexer = deps.indexer.onEvent((event) => {
    if (event.type === "progress") indexProgress.textContent = describeEvent(event);
    else if (!manualRun && event.type === "started") return;
    else if (!manualRun && event.type === "idle" && isQuiet(event.summary)) {
      indexProgress.textContent = "";
      if (indexStatus.textContent === t("indexRunning")) indexStatus.textContent = ""; // panneau ouvert en pleine passe
    }
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
  /**
   * "ok" : vidé sans réserve (le message final est donné par l'appelant, après le lancement de la
   * reconstruction) ; "partial" : vidé en partie (message d'erreur déjà donné, reconstruction utile) ; "failed".
   */
  const doClear = async (): Promise<"ok" | "partial" | "failed"> => {
    let result: ClearOutcome;
    try {
      result = await deps.clearIndex();
    } catch (error) {
      warnLog.warn("Vidage de l'index en échec", error);
      report(`${t("clearFailed")} : ${messageOf(error)}`, "error");
      return "failed";
    }
    for (const failure of result.failed) warnLog.warn(`Suppression de ${failure.name} en échec`, failure.error);
    if (result.manifestFailed) {
      report(t("clearManifestFailed"), "error"); // rien n'a été supprimé d'autre : pas de rafraîchissement utile
      return "failed";
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
    if (partial === undefined && refresh === undefined) return "ok";
    report([partial, refresh].filter((x) => x !== undefined).join(" "), "error");
    return "partial";
  };

  /** Message final d'un vidage réussi : ne promet « en cours » que si la reconstruction a vraiment démarré. */
  const reportCleared = (rebuilding: boolean | undefined): void => {
    if (rebuilding === undefined) report(t("clearDone"), "info");
    else report(t(rebuilding ? "clearDoneRebuilding" : "clearDoneWillRebuild"), "info");
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
        void doClear()
          .catch((error: unknown) => {
            warnLog.warn("Vidage de l'index en échec", error);
            report(`${t("clearFailed")} : ${messageOf(error)}`, "error");
            return "failed" as const;
          })
          .then((outcome) => {
            clearing.set(false); // libéré AVANT la reconstruction, que le drapeau bloquerait sinon
            let rebuilding: boolean | undefined;
            if (outcome !== "failed" && deps.settings.get().autoIndex) {
              try {
                rebuilding = deps.startAutoSync();
              } catch (error) {
                warnLog.warn("Reconstruction automatique après vidage en échec", error);
                rebuilding = false;
              }
            }
            if (outcome === "ok") reportCleared(rebuilding);
          })
          .catch((error: unknown) => warnLog.warn("Fin du vidage de l'index en échec", error));
      },
      () => undefined,
    );
  });

  // --- Diagnostic : état court annoncé, rapport complet dans un bloc non annoncé.
  const diagnosticStatus = textBlock({ live: true, label: t("indexStatusLabel") });
  const diagnosticReport = textBlock({ live: false, label: t("diagnosticOutputLabel") });
  diagnosticReport.className = "docseeker-diagnostic-report";
  const diagnosticButton = guardedButton("docseeker-diagnostic", t("diagnosticRun"), diagnosticStatus, async () => {
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

  // --- Réglages d'indexation automatique : appliqués au changement, sans bouton Enregistrer.
  const uid = `docseeker-${++panelSeq}`;
  const describedNode = (id: string): HTMLElement => {
    const node = doc.createElement("span");
    node.id = id;
    node.hidden = true; // référencé par aria-describedby, jamais affiché
    return node;
  };
  const switchInput = doc.createElement("input");
  switchInput.type = "checkbox";
  switchInput.className = "b3-switch fn__flex-center";
  switchInput.setAttribute("role", "switch");
  switchInput.setAttribute("aria-label", t("autoIndex"));
  const switchDesc = describedNode(`${uid}-auto-desc`);
  switchDesc.textContent = t("autoIndexDesc");
  switchInput.setAttribute("aria-describedby", switchDesc.id);
  const intervalSelect = doc.createElement("select");
  intervalSelect.className = "b3-select fn__flex-center";
  intervalSelect.setAttribute("aria-label", t("autoIndexInterval"));
  const intervalDesc = describedNode(`${uid}-interval-desc`);
  intervalSelect.setAttribute("aria-describedby", intervalDesc.id);
  for (const minutes of FREQUENCY_MINUTES) {
    const option = doc.createElement("option");
    option.value = String(minutes);
    option.textContent = t(`freq${minutes}`);
    intervalSelect.append(option);
  }
  // Erreur d'enregistrement : région locale annoncée (le toast de SiYuan ne l'est pas de façon fiable).
  const settingsStatus = textBlock({ live: true, label: t("indexStatusLabel") });
  const syncSettings = (): void => {
    const current = deps.settings.get();
    switchInput.checked = current.autoIndex;
    intervalSelect.value = String(current.intervalMinutes);
    intervalSelect.disabled = !current.autoIndex;
    const base = t("autoIndexIntervalDesc");
    intervalDesc.textContent = current.autoIndex ? base : `${base} ${t("autoIndexIntervalDisabledHint")}`;
  };
  syncSettings();
  const unsubscribeSettings = deps.settings.subscribe(syncSettings);
  const applySetting = (patch: Partial<DocSeekerSettings>): void => {
    deps.settings.update(patch).then(
      () => {
        settingsStatus.textContent = "";
      },
      (error: unknown) => {
        warnLog.warn("Enregistrement des réglages en échec", error);
        settingsStatus.textContent = t("settingsSaveFailed");
        deps.showMessage(t("settingsSaveFailed"), MESSAGE_TIMEOUT_MS, "error");
      },
    );
  };
  switchInput.addEventListener("change", () => applySetting({ autoIndex: switchInput.checked }));
  intervalSelect.addEventListener("change", () => applySetting({ intervalMinutes: Number(intervalSelect.value) }));

  let disposed = false;
  return {
    autoIndex: container(switchInput, switchDesc, settingsStatus),
    autoIndexInterval: container(intervalSelect, intervalDesc),
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
      unsubscribeSettings();
    },
  };
}
