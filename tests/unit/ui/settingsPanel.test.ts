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
import { createSettings, DEFAULT_SETTINGS, type DocSeekerSettings } from "../../../src/settings";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const STRINGS: Record<string, string> = {
  reindex: "Réindexer",
  diagnostic: "Diagnostic technique",
  diagnosticRun: "Lancer le diagnostic",
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
  clearDoneRebuilding: "Index vidé. Reconstruction en cours…",
  autoIndex: "Indexation automatique",
  autoIndexInterval: "Fréquence de vérification",
  freq5: "Toutes les 5 minutes",
  freq15: "Toutes les 15 minutes",
  freq60: "Toutes les heures",
  settingsSaveFailed: "Réglage appliqué mais non enregistré : il sera perdu au redémarrage.",
  clearDoneWillRebuild: "Index vidé. Il sera reconstruit automatiquement.",
  autoIndexDesc: "Indexe les PDF nouveaux ou modifiés.",
  autoIndexIntervalDesc: "Délai entre deux vérifications.",
  autoIndexIntervalDisabledHint: "Disponible quand l'indexation automatique est activée.",
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
  settings: ReturnType<typeof createSettings>;
  save: ReturnType<typeof vi.fn>;
  startAutoSync: Mock<() => boolean>;
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
  const save = vi.fn(async (_v: DocSeekerSettings) => undefined);
  const settings = createSettings({ load: async () => undefined, save, onWarn: warn });
  const startAutoSync = vi.fn((): boolean => true);
  const deps: SettingsPanelDeps = {
    settings,
    startAutoSync,
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
    clearing, confirm, warn, isIndexing, settings, save, startAutoSync, accept: () => onConfirm(), cancel: () => onCancel?.(),
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

describe("settingsPanel : libellé du bouton de diagnostic", () => {
  it("le bouton ne répète pas le titre de l'item : « Lancer le diagnostic »", () => {
    const panel = createSettingsPanel(h.deps);
    expect(btn(panel.diagnostic).textContent).toBe("Lancer le diagnostic");
    expect(btn(panel.diagnostic).textContent).not.toBe(STRINGS.diagnostic);
    panel.dispose();
  });

  it("Réindexer et Vider l'index gardent leur libellé", () => {
    const panel = createSettingsPanel(h.deps);
    expect(btn(panel.reindex).textContent).toBe("Réindexer");
    expect(btn(panel.clearIndex).textContent).toBe("Vider l'index");
    panel.dispose();
  });
});

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
    expect(status.textContent).toBe(""); // passe automatique : silencieuse tant qu'il n'y a rien à dire
    emit(h, { type: "progress", path: "assets/a.pdf", page: 2, total: 9 });
    expect(progress.textContent).toBe("assets/a.pdf : page 2/9");
    expect(status.textContent).toBe("");
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

describe("settingsPanel : passes automatiques silencieuses", () => {
  const zero = { indexed: 0, skippedScanned: 0, failed: 0, removed: 0, migrated: 0, cancelled: false, incomplete: 0 };

  it("started puis idle à zéro, hors clic sur Réindexer : aucun message d'état", () => {
    const panel = createSettingsPanel(h.deps);
    emit(h, { type: "started" });
    emit(h, { type: "idle", summary: zero });
    expect(statusOf(panel.reindex).textContent).toBe("");
    panel.dispose();
  });

  it("une passe automatique qui a travaillé affiche son bilan", () => {
    const panel = createSettingsPanel(h.deps);
    emit(h, { type: "started" });
    emit(h, { type: "idle", summary: { ...zero, indexed: 1 } });
    expect(statusOf(panel.reindex).textContent).toBe("Terminé : 1 indexé, 0 sans texte, 0 échecs, 0 supprimés");
    panel.dispose();
  });

  it("le bouton Réindexer affiche « démarrée » puis le bilan, même à zéro", async () => {
    let finish: () => void = () => undefined;
    h.startIndexing.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const panel = createSettingsPanel(h.deps);
    btn(panel.reindex).click();
    emit(h, { type: "started" });
    expect(statusOf(panel.reindex).textContent).toBe("Indexation démarrée");
    emit(h, { type: "idle", summary: zero });
    expect(statusOf(panel.reindex).textContent).toBe("Terminé : 0 indexés, 0 sans texte, 0 échecs, 0 supprimés");
    finish();
    await flush();
    // passe suivante automatique : retour au silence
    statusOf(panel.reindex).textContent = "";
    emit(h, { type: "started" });
    emit(h, { type: "idle", summary: zero });
    expect(statusOf(panel.reindex).textContent).toBe("");
    panel.dispose();
  });

  it("un échec d'une passe automatique reste visible (événement failed)", () => {
    const panel = createSettingsPanel(h.deps);
    emit(h, { type: "failed", path: "a.pdf", message: "vide" });
    expect(statusOf(panel.reindex).textContent).toContain("a.pdf");
    panel.dispose();
  });
});

describe("settingsPanel : réglages d'indexation automatique", () => {
  const switchOf = (panel: ReturnType<typeof createSettingsPanel>): HTMLInputElement =>
    panel.autoIndex.querySelector<HTMLInputElement>("input.b3-switch")!;
  const selectOf = (panel: ReturnType<typeof createSettingsPanel>): HTMLSelectElement =>
    panel.autoIndexInterval.querySelector<HTMLSelectElement>("select.b3-select")!;

  it("interrupteur b3-switch nommé, coché par défaut", () => {
    const panel = createSettingsPanel(h.deps);
    const sw = switchOf(panel);
    expect(sw.type).toBe("checkbox");
    expect(sw.checked).toBe(true);
    expect(sw.getAttribute("aria-label")).toBe("Indexation automatique");
    panel.dispose();
  });

  it("liste de fréquences 5, 15, 60 min, 5 sélectionnée, libellés i18n et nom accessible", () => {
    const panel = createSettingsPanel(h.deps);
    const select = selectOf(panel);
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["5", "Toutes les 5 minutes"],
      ["15", "Toutes les 15 minutes"],
      ["60", "Toutes les heures"],
    ]);
    expect(select.value).toBe("5");
    expect(select.getAttribute("aria-label")).toBe("Fréquence de vérification");
    expect(select.disabled).toBe(false);
    panel.dispose();
  });

  it("basculer l'interrupteur met à jour les réglages, enregistre et désactive la liste", async () => {
    const panel = createSettingsPanel(h.deps);
    const sw = switchOf(panel);
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await flush();
    expect(h.settings.get().autoIndex).toBe(false);
    expect(h.save).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, autoIndex: false });
    expect(selectOf(panel).disabled).toBe(true);
    panel.dispose();
  });

  it("changer la fréquence met à jour les réglages", async () => {
    const panel = createSettingsPanel(h.deps);
    const select = selectOf(panel);
    select.value = "15";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(h.settings.get().intervalMinutes).toBe(15);
    panel.dispose();
  });

  it("reflète les réglages chargés après coup (abonnement) et se désabonne au dispose", async () => {
    const panel = createSettingsPanel(h.deps);
    await h.settings.update({ autoIndex: false, intervalMinutes: 60 });
    expect(switchOf(panel).checked).toBe(false);
    expect(selectOf(panel).value).toBe("60");
    expect(selectOf(panel).disabled).toBe(true);
    panel.dispose();
    await h.settings.update({ autoIndex: true });
    expect(switchOf(panel).checked).toBe(false);
  });

  it("un enregistrement qui échoue est journalisé et signalé, le réglage reste appliqué", async () => {
    h.save.mockRejectedValueOnce(new Error("disque plein"));
    const panel = createSettingsPanel(h.deps);
    const sw = switchOf(panel);
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await flush();
    expect(h.warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(h.showMessage).toHaveBeenCalledWith(expect.stringContaining("non enregistré"), expect.any(Number), "error");
    expect(h.settings.get().autoIndex).toBe(false);
    const zone = panel.autoIndex.querySelector('[role="status"]')!;
    expect(zone.textContent).toBe(STRINGS.settingsSaveFailed);
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await flush();
    expect(zone.textContent).toBe(""); // enregistré cette fois : le message disparaît
    panel.dispose();
  });
});

describe("settingsPanel : accessibilité des réglages", () => {
  it("l'interrupteur a role=switch et une description reliée par aria-describedby", () => {
    const panel = createSettingsPanel(h.deps);
    const sw = panel.autoIndex.querySelector<HTMLInputElement>("input.b3-switch")!;
    expect(sw.getAttribute("role")).toBe("switch");
    const desc = panel.autoIndex.querySelector(`#${sw.getAttribute("aria-describedby")}`);
    expect(desc?.textContent).toBe(STRINGS.autoIndexDesc);
    panel.dispose();
  });

  it("la liste désactivée l'explique dans sa description, et la retire une fois activée", async () => {
    const panel = createSettingsPanel(h.deps);
    const select = panel.autoIndexInterval.querySelector<HTMLSelectElement>("select")!;
    const desc = (): string => panel.autoIndexInterval.querySelector(`#${select.getAttribute("aria-describedby")}`)!.textContent!;
    expect(desc()).toBe(STRINGS.autoIndexIntervalDesc);
    await h.settings.update({ autoIndex: false });
    expect(desc()).toBe(`${STRINGS.autoIndexIntervalDesc} ${STRINGS.autoIndexIntervalDisabledHint}`);
    await h.settings.update({ autoIndex: true });
    expect(desc()).toBe(STRINGS.autoIndexIntervalDesc);
    panel.dispose();
  });

  it("deux panneaux n'utilisent pas les mêmes identifiants", () => {
    const a = createSettingsPanel(h.deps);
    const b = createSettingsPanel(h.deps);
    const idOf = (p: typeof a) => p.autoIndex.querySelector("input")!.getAttribute("aria-describedby");
    expect(idOf(a)).not.toBe(idOf(b));
    a.dispose();
    b.dispose();
  });
});

describe("settingsPanel : état « en cours » et passe silencieuse", () => {
  it("panneau ouvert pendant une passe automatique puis idle à zéro : « Indexation en cours » disparaît", () => {
    h.isIndexing.mockReturnValue(true);
    const panel = createSettingsPanel(h.deps);
    expect(statusOf(panel.reindex).textContent).toBe(STRINGS.indexRunning);
    emit(h, { type: "idle", summary: { indexed: 0, skippedScanned: 0, failed: 0, removed: 0, migrated: 0, cancelled: false, incomplete: 0 } });
    expect(statusOf(panel.reindex).textContent).toBe("");
    panel.dispose();
  });
});

describe("settingsPanel : reconstruction après vidage", () => {
  const run = async (panel: ReturnType<typeof createSettingsPanel>): Promise<void> => {
    btn(panel.clearIndex).click();
    h.accept();
    await flush();
  };

  it("indexation automatique activée : message « Reconstruction en cours… » et synchronisation déclenchée après libération du drapeau", async () => {
    const seen: boolean[] = [];
    h.startAutoSync.mockImplementation(() => (seen.push(h.clearing.active()), true));
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDoneRebuilding);
    expect(h.showMessage).toHaveBeenCalledWith(STRINGS.clearDoneRebuilding, expect.any(Number), "info");
    expect(h.startAutoSync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([false]);
    panel.dispose();
  });

  it("synchronisation non lancée (false) : pas de promesse d'immédiateté", async () => {
    h.startAutoSync.mockReturnValue(false);
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDoneWillRebuild);
    expect(h.showMessage).toHaveBeenCalledWith(STRINGS.clearDoneWillRebuild, expect.any(Number), "info");
    panel.dispose();
  });

  it("startAutoSync qui lève : journalisé, drapeau libéré, la chaîne ne rejette pas", async () => {
    h.startAutoSync.mockImplementation(() => { throw new Error("planificateur KO"); });
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(h.warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(h.clearing.active()).toBe(false);
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDoneWillRebuild);
    panel.dispose();
  });

  it("indexation automatique coupée : ancien message, aucune synchronisation", async () => {
    await h.settings.update({ autoIndex: false });
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDone);
    expect(h.startAutoSync).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("échec du manifeste ou du vidage : pas de reconstruction", async () => {
    h.clearIndex.mockResolvedValueOnce({ removed: [], failed: [], manifestFailed: true });
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(h.startAutoSync).not.toHaveBeenCalled();
    h.clearIndex.mockRejectedValueOnce(new Error("KO"));
    await run(panel);
    expect(h.startAutoSync).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("vidage partiel : message d'erreur partiel, mais la reconstruction est lancée", async () => {
    h.clearIndex.mockResolvedValueOnce({ removed: [], failed: [{ name: "a.dsx", error: new Error("x") }], manifestFailed: false });
    const panel = createSettingsPanel(h.deps);
    await run(panel);
    expect(h.startAutoSync).toHaveBeenCalledTimes(1);
    expect(alertOf(panel.clearIndex).textContent).toContain("Index vidé en partie");
    panel.dispose();
  });
});

describe("describeEvent", () => {
  it("décrit chaque type d'événement, avec les accords au singulier", () => {
    const many = { indexed: 2, skippedScanned: 2, failed: 3, removed: 4, migrated: 0, cancelled: true, incomplete: 0 };
    expect(describeEvent({ type: "idle", summary: many })).toBe(
      "Terminé : 2 indexés, 2 sans texte, 3 échecs, 4 supprimés (annulé)",
    );
    const one = { indexed: 1, skippedScanned: 0, failed: 1, removed: 1, migrated: 0, cancelled: false, incomplete: 0 };
    expect(describeEvent({ type: "idle", summary: one })).toBe("Terminé : 1 indexé, 0 sans texte, 1 échec, 1 supprimé");
    expect(describeEvent({ type: "indexed", path: "p", pages: 1 })).toBe("Indexé : p (1 page)");
    expect(describeEvent({ type: "failed", path: "p", message: "m" })).toBe("Échec : p : m");
    expect(describeEvent({ type: "skipped-scanned", path: "p" })).toBe("PDF sans texte ignoré : p");
    expect(describeEvent({ type: "plan", toIndex: 3, migrating: 2, complete: true })).toBe("Mise à jour de l'index : 2 PDF à migrer");
    expect(describeEvent({ type: "removed", path: "p" })).toBe("Index supprimé : p");
  });

  it("le bilan de fin de passe montre les PDF migrés, et seulement s'il y en a", () => {
    const base = { indexed: 3, skippedScanned: 0, failed: 0, removed: 0, cancelled: false, incomplete: 0 };
    expect(describeEvent({ type: "idle", summary: { ...base, migrated: 2 } })).toBe(
      "Terminé : 3 indexés, 0 sans texte, 0 échecs, 0 supprimés, dont 2 migrés (ancien index mis à jour)",
    );
    expect(describeEvent({ type: "idle", summary: { ...base, migrated: 1 } })).toContain("dont 1 migré (");
    expect(describeEvent({ type: "idle", summary: { ...base, migrated: 0 } })).not.toContain("migré");
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
    expect(statusOf(panel.clearIndex).textContent).toBe(STRINGS.clearDoneRebuilding);
    expect(alertOf(panel.clearIndex).textContent).toBe("");
    expect(h.showMessage).toHaveBeenCalledWith(STRINGS.clearDoneRebuilding, expect.any(Number), "info");
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
