// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createClearingFlag,
  createSettingsPanel,
  describeEvent,
  type SettingsPanelDeps,
} from "../../../src/ui/settingsPanel";
import { SEARCH_STYLE_ID } from "../../../src/ui/searchStyles";
import type { IndexerEvent } from "../../../src/indexer/indexer";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const STRINGS: Record<string, string> = {
  reindex: "Réindexer",
  diagnostic: "Diagnostic technique",
  clearIndex: "Vider l'index",
  indexStatusLabel: "État",
  indexProgressLabel: "Progression de l'indexation",
  diagnosticOutputLabel: "Rapport du diagnostic",
  warnLog: "Journal des avertissements",
  warnLogEmpty: "Aucun avertissement.",
  indexFailed: "Indexation en échec",
  indexRunning: "Indexation en cours",
  alreadyRunning: "Déjà en cours…",
  reindexBlockedByClear: "Vidage de l'index en cours : attendez sa fin.",
  clearConfirmTitle: "Vider l'index ?",
  clearConfirmText: "Tous les fichiers d'index seront supprimés. Il faudra réindexer vos PDF.",
  clearBusy: "Indexation en cours : attendez la fin avant de vider l'index.",
  clearRunning: "Vidage en cours…",
  clearDone: "Index vidé. Lancez Réindexer pour le reconstruire.",
  clearPartialOne: "Index vidé en partie : {n} fichier n'a pas pu être supprimé.",
  clearPartialMany: "Index vidé en partie : {n} fichiers n'ont pas pu être supprimés.",
  clearManifestFailed: "Le manifeste n'a pas pu être supprimé : rien n'a été vidé. Réessayez le vidage.",
  clearFailed: "Impossible de vider l'index",
  clearRefreshFailed: "La recherche n'a pas pu être mise à jour",
  diagnosticRunning: "Diagnostic en cours…",
  diagnosticDone: "Diagnostic terminé",
  diagnosticFailed: "Diagnostic en échec",
};

interface Harness {
  deps: SettingsPanelDeps;
  listeners: Set<(e: IndexerEvent) => void>;
  warnListeners: Set<() => void>;
  lines: string[];
  startIndexing: ReturnType<typeof vi.fn>;
  clearIndex: ReturnType<typeof vi.fn>;
  refreshIndex: ReturnType<typeof vi.fn>;
  runDiagnostic: ReturnType<typeof vi.fn>;
  showMessage: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  warn: Mock<(message: string, error?: unknown) => void>;
  isIndexing: ReturnType<typeof vi.fn>;
  clearing: ReturnType<typeof createClearingFlag>;
  /** Appelle le callback de confirmation / d'annulation de la dernière boîte. */
  accept(): void;
  cancel(): void;
}

function harness(): Harness {
  const listeners = new Set<(e: IndexerEvent) => void>();
  const warnListeners = new Set<() => void>();
  const lines: string[] = [];
  let onConfirm: () => void = () => undefined;
  let onCancel: (() => void) | undefined;
  const startIndexing = vi.fn(async () => undefined);
  const clearIndex = vi.fn(async () => ({
    removed: ["a.dsx", "manifest.json"],
    failed: [] as { name: string; error: unknown }[],
    manifestFailed: false,
  }));
  const clearing = createClearingFlag();
  const refreshIndex = vi.fn(async () => undefined);
  const runDiagnostic = vi.fn(async () => "rapport M0");
  const showMessage = vi.fn();
  const warn = vi.fn((message: string, error?: unknown) => {
    lines.push(error === undefined ? message : `${message} — ${String(error)}`);
    for (const l of [...warnListeners]) l();
  });
  const isIndexing = vi.fn(() => false);
  const confirm = vi.fn((_title: string, _text: string, yes: () => void, no?: () => void) => {
    onConfirm = yes;
    onCancel = no;
  });
  const deps: SettingsPanelDeps = {
    t: (key) => STRINGS[key] ?? key,
    indexer: {
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    startIndexing,
    isIndexing,
    clearing,
    clearIndex,
    refreshIndex,
    runDiagnostic,
    warnLog: {
      warn,
      entries: () => [...lines],
      subscribe: (l) => {
        warnListeners.add(l);
        return () => warnListeners.delete(l);
      },
    },
    showMessage,
    confirm,
  };
  return {
    deps, listeners, warnListeners, lines, startIndexing, clearIndex, refreshIndex, runDiagnostic, showMessage,
    clearing, confirm, warn, isIndexing, accept: () => onConfirm(), cancel: () => onCancel?.(),
  };
}

const btn = (el: HTMLElement): HTMLButtonElement => el.querySelector("button")!;
const emit = (h: Harness, e: IndexerEvent): void => {
  for (const l of [...h.listeners]) l(e);
};

let h: Harness;
beforeEach(() => {
  h = harness();
});

const statusOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('[role="status"]')!;
const alertOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('[role="alert"]')!;

describe("settingsPanel : style", () => {
  it("injecte la feuille de style (le panneau n'a pas l'onglet pour le faire)", () => {
    document.getElementById(SEARCH_STYLE_ID)?.remove();
    const panel = createSettingsPanel(h.deps);
    expect(document.getElementById(SEARCH_STYLE_ID)).not.toBeNull();
    panel.dispose();
  });
});

describe("settingsPanel : Réindexer", () => {
  it("rend un bouton nommé et une seule zone annoncée (l'état), nommée « État »", () => {
    const panel = createSettingsPanel(h.deps);
    const button = btn(panel.reindex);
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Réindexer");
    expect(statusOf(panel.reindex).getAttribute("aria-live")).toBe("polite");
    expect(statusOf(panel.reindex).getAttribute("aria-label")).toBe("État");
    expect(panel.reindex.querySelectorAll("[aria-live]")).toHaveLength(1);
    panel.dispose();
  });

  it("lance startIndexing au clic, avec aria-disabled (et non disabled) tant que ça tourne", async () => {
    let finish: () => void = () => undefined;
    h.startIndexing.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const panel = createSettingsPanel(h.deps);
    const button = btn(panel.reindex);
    button.click();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    button.click();
    expect(h.startIndexing).toHaveBeenCalledTimes(1);
    expect(statusOf(panel.reindex).textContent).toBe("Déjà en cours…");
    finish();
    await flush();
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    panel.dispose();
  });

  it("signale un échec : journal, message ET texte dans la région d'état", async () => {
    h.startIndexing.mockRejectedValue(new Error("noyau KO"));
    const panel = createSettingsPanel(h.deps);
    btn(panel.reindex).click();
    await flush();
    expect(h.warn).toHaveBeenCalledWith("Indexation en échec", expect.any(Error));
    expect(h.showMessage).toHaveBeenCalledWith("Indexation en échec : noyau KO", expect.any(Number), "error");
    expect(statusOf(panel.reindex).textContent).toBe("Indexation en échec : noyau KO");
    expect(btn(panel.reindex).hasAttribute("aria-disabled")).toBe(false);
    panel.dispose();
  });

  it("est refusé pendant un vidage de l'index (message dans la région d'état)", () => {
    h.clearing.set(true);
    const panel = createSettingsPanel(h.deps);
    btn(panel.reindex).click();
    expect(h.startIndexing).not.toHaveBeenCalled();
    expect(statusOf(panel.reindex).textContent).toBe("Vidage de l'index en cours : attendez sa fin.");
    panel.dispose();
  });

  it("à la réouverture pendant une indexation, initialise l'état depuis l'indexeur", () => {
    h.isIndexing.mockReturnValue(true);
    const panel = createSettingsPanel(h.deps);
    expect(statusOf(panel.reindex).textContent).toBe("Indexation en cours");
    panel.dispose();
  });

  it("sans indexation en cours, l'état initial est vide", () => {
    const panel = createSettingsPanel(h.deps);
    expect(statusOf(panel.reindex).textContent).toBe("");
    panel.dispose();
  });

  it("affiche l'état annoncé et la progression non annoncée", () => {
    const panel = createSettingsPanel(h.deps);
    const status = statusOf(panel.reindex);
    const progress = [...panel.reindex.querySelectorAll("pre")].find((p) => p !== status)!;
    emit(h, { type: "started" });
    expect(status.textContent).toBe("Indexation démarrée");
    emit(h, { type: "progress", path: "assets/a.pdf", page: 2, total: 9 });
    expect(progress.textContent).toBe("assets/a.pdf : page 2/9");
    expect(status.textContent).toBe("Indexation démarrée");
    expect(progress.hasAttribute("aria-live")).toBe(false);
    expect(progress.getAttribute("role")).toBeNull();
    emit(h, { type: "indexed", path: "assets/a.pdf", pages: 9 });
    expect(progress.textContent).toBe("");
    expect(status.textContent).toBe("Indexé : assets/a.pdf (9 pages)");
    panel.dispose();
  });

  it("n'injecte jamais de HTML : le texte vient d'événements non fiables", () => {
    const panel = createSettingsPanel(h.deps);
    emit(h, { type: "failed", path: "<img src=x onerror=alert(1)>.pdf", message: "<b>x</b>" });
    expect(panel.reindex.querySelector("img, b")).toBeNull();
    expect(panel.reindex.textContent).toContain("<b>x</b>");
    panel.dispose();
  });
});

describe("describeEvent", () => {
  it("décrit chaque type d'événement, avec les accords au singulier", () => {
    const many = { indexed: 2, skippedScanned: 2, failed: 3, removed: 4, cancelled: true };
    expect(describeEvent({ type: "idle", summary: many })).toBe(
      "Terminé : 2 indexés, 2 sans texte, 3 échecs, 4 supprimés (annulé)",
    );
    const one = { indexed: 1, skippedScanned: 0, failed: 1, removed: 1, cancelled: false };
    expect(describeEvent({ type: "idle", summary: one })).toBe("Terminé : 1 indexé, 0 sans texte, 1 échec, 1 supprimé");
    expect(describeEvent({ type: "indexed", path: "p", pages: 1 })).toBe("Indexé : p (1 page)");
    expect(describeEvent({ type: "failed", path: "p", message: "m" })).toBe("Échec : p : m");
    expect(describeEvent({ type: "skipped-scanned", path: "p" })).toBe("PDF sans texte ignoré : p");
    expect(describeEvent({ type: "removed", path: "p" })).toBe("Index supprimé : p");
  });
});

describe("createClearingFlag", () => {
  it("notifie les abonnés aux seuls changements et se désabonne", () => {
    const flag = createClearingFlag();
    const seen: boolean[] = [];
    const off = flag.subscribe(() => seen.push(flag.active()));
    flag.set(true);
    flag.set(true);
    flag.set(false);
    off();
    flag.set(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("settingsPanel : Vider l'index", () => {
  const click = (panel: ReturnType<typeof createSettingsPanel>): void => btn(panel.clearIndex).click();
  const clearAndConfirm = async (panel: ReturnType<typeof createSettingsPanel>): Promise<void> => {
    click(panel);
    h.accept();
    await flush();
  };
  const text = (panel: ReturnType<typeof createSettingsPanel>): string =>
    statusOf(panel.clearIndex).textContent! + alertOf(panel.clearIndex).textContent!;

  it("demande confirmation avant d'agir et n'agit pas avant", () => {
    const panel = createSettingsPanel(h.deps);
    click(panel);
    expect(h.confirm).toHaveBeenCalledWith("Vider l'index ?", STRINGS.clearConfirmText, expect.any(Function), expect.any(Function));
    expect(h.clearIndex).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("annuler la confirmation ne supprime rien", async () => {
    const panel = createSettingsPanel(h.deps);
    click(panel);
    h.cancel();
    await flush();
    expect(h.clearIndex).not.toHaveBeenCalled();
    expect(h.refreshIndex).not.toHaveBeenCalled();
    expect(h.showMessage).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("confirmer supprime puis rafraîchit, et annonce « Index vidé. Lancez Réindexer… » dans la région d'état", async () => {
    const calls: string[] = [];
    h.clearIndex.mockImplementation(async () => {
      calls.push("clear");
      return { removed: ["a.dsx", "manifest.json"], failed: [], manifestFailed: false };
    });
    h.refreshIndex.mockImplementation(async () => void calls.push("refresh"));
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(calls).toEqual(["clear", "refresh"]);
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDone);
    expect(alertOf(panel.clearIndex).textContent).toBe("");
    expect(h.showMessage).toHaveBeenCalledWith(STRINGS.clearDone, expect.any(Number), "info");
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.clearing.active()).toBe(false);
    panel.dispose();
  });

  it("refuse d'agir pendant une indexation, sans confirmation, dans une région role=alert", () => {
    h.isIndexing.mockReturnValue(true);
    const panel = createSettingsPanel(h.deps);
    click(panel);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.clearIndex).not.toHaveBeenCalled();
    expect(h.showMessage).toHaveBeenCalledWith(STRINGS.clearBusy, expect.any(Number), "error");
    expect(alertOf(panel.clearIndex).textContent).toBe(STRINGS.clearBusy);
    expect(statusOf(panel.clearIndex).textContent).toBe("");
    panel.dispose();
  });

  it("revérifie l'indexation après la confirmation", async () => {
    const panel = createSettingsPanel(h.deps);
    click(panel);
    h.isIndexing.mockReturnValue(true);
    h.accept();
    await flush();
    expect(h.clearIndex).not.toHaveBeenCalled();
    expect(alertOf(panel.clearIndex).textContent).toBe(STRINGS.clearBusy);
    panel.dispose();
  });

  it("échec partiel : jamais « Index vidé. » ; pluriel One/Many ; journal par fichier ; rafraîchit quand même", async () => {
    h.clearIndex.mockResolvedValue({
      removed: ["a.dsx"],
      failed: [
        { name: "b.dsx", error: new Error("disque plein") },
        { name: "c.dsx", error: new Error("verrou") },
      ],
      manifestFailed: false,
    });
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(h.warn).toHaveBeenCalledWith("Suppression de b.dsx en échec", expect.any(Error));
    expect(h.warn).toHaveBeenCalledWith("Suppression de c.dsx en échec", expect.any(Error));
    expect(h.refreshIndex).toHaveBeenCalledTimes(1);
    const expected = "Index vidé en partie : 2 fichiers n'ont pas pu être supprimés.";
    expect(h.showMessage).toHaveBeenCalledWith(expected, expect.any(Number), "error");
    expect(alertOf(panel.clearIndex).textContent).toBe(expected);
    expect(text(panel)).not.toContain(STRINGS.clearDone);
    panel.dispose();
  });

  it("échec partiel au singulier", async () => {
    h.clearIndex.mockResolvedValue({ removed: [], failed: [{ name: "b.dsx", error: new Error("x") }], manifestFailed: false });
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(alertOf(panel.clearIndex).textContent).toBe("Index vidé en partie : 1 fichier n'a pas pu être supprimé.");
    panel.dispose();
  });

  it("échec du manifeste : message dédié, pas de rafraîchissement, pas de « Index vidé »", async () => {
    h.clearIndex.mockResolvedValue({
      removed: [],
      failed: [{ name: "manifest.json", error: new Error("verrou") }],
      manifestFailed: true,
    });
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(h.warn).toHaveBeenCalledWith("Suppression de manifest.json en échec", expect.any(Error));
    expect(h.refreshIndex).not.toHaveBeenCalled();
    expect(alertOf(panel.clearIndex).textContent).toBe(STRINGS.clearManifestFailed);
    panel.dispose();
  });

  it("échec partiel ET échec du rafraîchissement : message combiné", async () => {
    h.clearIndex.mockResolvedValue({ removed: [], failed: [{ name: "b.dsx", error: new Error("x") }], manifestFailed: false });
    h.refreshIndex.mockRejectedValue(new Error("liste KO"));
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(alertOf(panel.clearIndex).textContent).toBe(
      "Index vidé en partie : 1 fichier n'a pas pu être supprimé. La recherche n'a pas pu être mise à jour : liste KO",
    );
    expect(h.warn).toHaveBeenCalledWith("Rafraîchissement après vidage en échec", expect.any(Error));
    panel.dispose();
  });

  it("signale l'échec complet de clearIndex (rejet) sans rafraîchir", async () => {
    h.clearIndex.mockRejectedValue(new Error("readDir KO"));
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(h.warn).toHaveBeenCalledWith("Vidage de l'index en échec", expect.any(Error));
    expect(h.showMessage).toHaveBeenCalledWith("Impossible de vider l'index : readDir KO", expect.any(Number), "error");
    expect(alertOf(panel.clearIndex).textContent).toBe("Impossible de vider l'index : readDir KO");
    expect(h.refreshIndex).not.toHaveBeenCalled();
    expect(btn(panel.clearIndex).hasAttribute("aria-disabled")).toBe(false);
    expect(h.clearing.active()).toBe(false);
    panel.dispose();
  });

  it("échec seul du rafraîchissement de l'index partagé", async () => {
    h.refreshIndex.mockRejectedValue(new Error("liste KO"));
    const panel = createSettingsPanel(h.deps);
    await clearAndConfirm(panel);
    expect(alertOf(panel.clearIndex).textContent).toBe("La recherche n'a pas pu être mise à jour : liste KO");
    panel.dispose();
  });

  it("pendant le vidage : drapeau partagé levé, état « Vidage en cours… », second clic refusé avec « Déjà en cours… »", async () => {
    let finish: (v: { removed: string[]; failed: never[]; manifestFailed: false }) => void = () => undefined;
    h.clearIndex.mockImplementation(() => new Promise((r) => (finish = r)));
    const panel = createSettingsPanel(h.deps);
    const button = btn(panel.clearIndex);
    click(panel);
    h.accept();
    expect(h.clearing.active()).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(statusOf(panel.clearIndex).textContent).toBe("Vidage en cours…");
    button.click();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(statusOf(panel.clearIndex).textContent).toBe("Déjà en cours…");
    finish({ removed: [], failed: [], manifestFailed: false });
    await flush();
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(h.clearing.active()).toBe(false);
    panel.dispose();
  });

  it("l'état « vidage en cours » survit à la réouverture : le nouveau panneau le montre, refuse, puis se met à jour", async () => {
    let finish: (v: { removed: string[]; failed: never[]; manifestFailed: false }) => void = () => undefined;
    h.clearIndex.mockImplementation(() => new Promise((r) => (finish = r)));
    const first = createSettingsPanel(h.deps);
    click(first);
    h.accept();
    first.dispose(); // fermeture du panneau pendant le vidage
    const second = createSettingsPanel(h.deps);
    expect(statusOf(second.clearIndex).textContent).toBe("Vidage en cours…");
    expect(btn(second.clearIndex).getAttribute("aria-disabled")).toBe("true");
    btn(second.clearIndex).click();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    finish({ removed: [], failed: [], manifestFailed: false });
    await flush();
    expect(h.clearing.active()).toBe(false);
    expect(btn(second.clearIndex).hasAttribute("aria-disabled")).toBe(false);
    expect(statusOf(second.clearIndex).textContent).toBe("");
    second.dispose();
  });

  it("a un nom accessible, et des régions status/alert nommées « État »", () => {
    const panel = createSettingsPanel(h.deps);
    expect(btn(panel.clearIndex).textContent).toBe("Vider l'index");
    expect(statusOf(panel.clearIndex).getAttribute("aria-label")).toBe("État");
    expect(alertOf(panel.clearIndex).getAttribute("aria-label")).toBe("État");
    panel.dispose();
  });
});

describe("settingsPanel : Diagnostic technique", () => {
  const report = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>("pre.docseeker-diagnostic-report")!;

  it("région d'état courte annoncée, rapport complet dans un bloc non annoncé", async () => {
    let finish: (s: string) => void = () => undefined;
    h.runDiagnostic.mockImplementation(() => new Promise<string>((r) => (finish = r)));
    const panel = createSettingsPanel(h.deps);
    btn(panel.diagnostic).click();
    expect(statusOf(panel.diagnostic).textContent).toBe("Diagnostic en cours…");
    finish("ligne 1\nligne 2");
    await flush();
    expect(statusOf(panel.diagnostic).textContent).toBe("Diagnostic terminé");
    expect(report(panel.diagnostic).textContent).toBe("ligne 1\nligne 2");
    expect(report(panel.diagnostic).hasAttribute("aria-live")).toBe(false);
    expect(report(panel.diagnostic).getAttribute("role")).toBeNull();
    expect(report(panel.diagnostic).getAttribute("aria-label")).toBe("Rapport du diagnostic");
    panel.dispose();
  });

  it("échec : « Diagnostic en échec » + erreur dans le bloc, sans toast en double", async () => {
    h.runDiagnostic.mockRejectedValue(new Error("pdfjs absent"));
    const panel = createSettingsPanel(h.deps);
    btn(panel.diagnostic).click();
    await flush();
    expect(statusOf(panel.diagnostic).textContent).toBe("Diagnostic en échec");
    expect(report(panel.diagnostic).textContent).toBe("pdfjs absent");
    expect(h.showMessage).not.toHaveBeenCalled();
    expect(btn(panel.diagnostic).hasAttribute("aria-disabled")).toBe(false);
    panel.dispose();
  });

  it("ignore les clics pendant l'exécution avec « Déjà en cours… »", () => {
    h.runDiagnostic.mockImplementation(() => new Promise<string>(() => undefined));
    const panel = createSettingsPanel(h.deps);
    btn(panel.diagnostic).click();
    btn(panel.diagnostic).click();
    expect(h.runDiagnostic).toHaveBeenCalledTimes(1);
    expect(statusOf(panel.diagnostic).textContent).toBe("Déjà en cours…");
    panel.dispose();
  });
});

describe("settingsPanel : journal des avertissements", () => {
  const logOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(".docseeker-log")!;

  it("est un groupe nommé, focusable, non live, mis à jour en direct", () => {
    h.lines.push("12:00:00 déjà là");
    const panel = createSettingsPanel(h.deps);
    const log = logOf(panel.log);
    expect(log.getAttribute("role")).toBe("group");
    expect(log.getAttribute("aria-label")).toBe("Journal des avertissements");
    expect(log.getAttribute("tabindex")).toBe("0");
    expect(log.hasAttribute("aria-live")).toBe(false);
    expect(log.textContent).toBe("12:00:00 déjà là");
    h.warn("nouveau");
    expect(log.textContent).toBe("12:00:00 déjà là\nnouveau");
    panel.dispose();
  });

  it("affiche « Aucun avertissement. » quand le journal est vide", () => {
    const panel = createSettingsPanel(h.deps);
    expect(logOf(panel.log).textContent).toBe("Aucun avertissement.");
    h.warn("x");
    expect(logOf(panel.log).textContent).toBe("x");
    panel.dispose();
  });
});

describe("settingsPanel : cycle de vie", () => {
  it("dispose libère les écouteurs (indexeur, journal, drapeau de vidage), idempotent", () => {
    const panel = createSettingsPanel(h.deps);
    expect(h.listeners.size).toBe(1);
    expect(h.warnListeners.size).toBe(1);
    panel.dispose();
    panel.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.warnListeners.size).toBe(0);
    expect(h.clearing.listenerCount()).toBe(0);
  });

  it("des panneaux successifs ne cumulent pas d'écouteurs", () => {
    for (let i = 0; i < 5; i++) createSettingsPanel(h.deps).dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.warnListeners.size).toBe(0);
    expect(h.clearing.listenerCount()).toBe(0);
  });
});
