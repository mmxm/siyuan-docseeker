// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  showMessage: vi.fn(),
  mount: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  unsubscribe: vi.fn(),
  listener: undefined as undefined | ((e: unknown) => void),
  sharedStart: vi.fn(),
  sharedDispose: vi.fn(),
  sharedCreated: 0,
  indexerDeps: undefined as { onDestroyError?: (e: unknown) => void; shouldYield?: () => boolean } | undefined,
  mounts: [] as {
    dispose: ReturnType<typeof vi.fn>;
    onWarn: (m: string, e?: unknown) => void;
    onOpenSettings?: (() => void) | undefined;
  }[],
  listeners: new Set<(e: unknown) => void>(),
  settings: [] as {
    options: { destroyCallback?: () => void };
    items: { title: string; description?: string; createActionElement?: () => HTMLElement; actionElement?: HTMLElement }[];
  }[],
  confirm: vi.fn(),
  openSetting: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
  getError: vi.fn(),
  isRunning: false,
  stale: vi.fn(),
  reset: vi.fn(),
  loadData: vi.fn(),
  saveData: vi.fn(),
  failCreate: false,
  queue: null as null | { pending: string[]; running: string[]; completed: string[]; failed: unknown[] },
  mountDeps: [] as { indexActivity?: { getSnapshot(): unknown; subscribe(l: () => void): () => void } }[],
}));

vi.mock("siyuan", () => ({
  Plugin: class {
    name = "docseeker";
    app = {};
    i18n: Record<string, string> = {
      reindex: "Réindexer",
      reindexDesc: "Desc réindexer",
      clearIndex: "Vider l'index",
      clearIndexDesc: "Desc vider",
      diagnostic: "Diagnostic technique",
      diagnosticDesc: "Desc diag",
      warnLog: "Journal",
      warnLogDesc: "Desc journal",
      indexFailed: "Indexation en échec",
      clearDoneRebuilding: "Index vidé. Reconstruction en cours…",
      autoIndex: "Indexation automatique",
      autoIndexDesc: "Desc auto",
      autoIndexInterval: "Fréquence de vérification",
      autoIndexIntervalDesc: "Desc freq",
    };
    setting: unknown;
    loadData = h.loadData;
    saveData = h.saveData;
    openSetting = h.openSetting;
    tab: { init: (this: unknown, c: unknown) => void; destroy: (this: unknown) => void } | undefined;
    addTab(o: NonNullable<typeof this.tab>) {
      this.tab = o;
    }
    topBar: { callback: () => void } | undefined;
    addTopBar(o: { callback: () => void }) {
      this.topBar = o;
    }
    addCommand() {}
    removeTopBar() {}
  },
  openTab: vi.fn(),
  showMessage: h.showMessage,
  confirm: h.confirm,
  Setting: class {
    items: (typeof h.settings)[number]["items"] = [];
    constructor(public options: { destroyCallback?: () => void }) {
      h.settings.push(this);
    }
    addItem(item: (typeof h.settings)[number]["items"][number]) {
      this.items.push(item);
    }
    open() {}
  },
}));
vi.mock("../../src/indexer/autoSync", async (orig) => {
  const actual = await orig<typeof import("../../src/indexer/autoSync")>();
  return {
    ...actual,
    createAutoSync: (deps: Parameters<typeof actual.createAutoSync>[0]) => {
      if (h.failCreate) throw new Error("création KO");
      return actual.createAutoSync(deps);
    },
  };
});
vi.mock("../../src/siyuan/kernelApi", () => ({ createKernelApi: () => ({}) }));
vi.mock("../../src/siyuan/petalStore", () => ({ createPetalStore: () => ({ clear: h.clear, removeStaleTmp: h.stale }) }));
vi.mock("../../src/siyuan/discovery", () => ({ discoverPdfs: vi.fn() }));
vi.mock("../../src/indexer/loadPdf", () => ({ createLoadPdf: () => vi.fn() }));
vi.mock("../../src/indexer/indexer", () => ({
  createIndexer: (deps: { onDestroyError?: (e: unknown) => void; shouldYield?: () => boolean }) => ({
    ...((h.indexerDeps = deps), {}),
    start: h.start,
    cancel: h.cancel,
    resetFailures: h.reset,
    getState: () => ({ status: h.isRunning ? "running" : "idle", queue: h.queue }),
    onEvent: (l: (e: unknown) => void) => {
      h.listener = l;
      h.listeners.add(l);
      return () => {
        h.listeners.delete(l);
        h.unsubscribe();
      };
    },
  }),
}));
vi.mock("../../src/search/sharedIndex", () => ({
  createSharedIndex: () => {
    h.sharedCreated++;
    return { start: h.sharedStart, dispose: h.sharedDispose, getError: h.getError, refreshNow: h.refresh };
  },
}));
vi.mock("../../src/searchTab", async (orig) => {
  const actual = await orig<typeof import("../../src/searchTab")>();
  return {
    ...actual,
    mountSearchTab: (
      _host: HTMLElement,
      deps: { onWarn: (m: string, e?: unknown) => void; onOpenSettings?: () => void; indexActivity?: never },
    ) => {
      h.mountDeps.push(deps);
      const m = { dispose: vi.fn(), onWarn: deps.onWarn, onOpenSettings: deps.onOpenSettings };
      h.mounts.push(m);
      return m;
    },
  };
});

import DocSeekerPlugin from "../../src/index";

const plugins: { onunload(): void }[] = [];
afterEach(() => {
  // Les écouteurs de fenêtre d'un plugin non déchargé survivraient au test suivant (même window jsdom).
  for (const p of plugins.splice(0)) p.onunload();
});

type TabModel = { element: HTMLElement };
function setup() {
  const plugin = new (DocSeekerPlugin as unknown as new () => unknown)() as {
    onload(): void;
    onunload(): void;
    onLayoutReady(): void;
    tab: { init: (this: TabModel, c: TabModel) => void; destroy: (this: TabModel) => void };
    topBar: { callback: () => void };
  };
  plugin.onload();
  const render = (): TabModel => {
    const model = { element: document.createElement("div") };
    plugin.tab.init.call(model, model);
    return model;
  };
  plugins.push(plugin);
  return { plugin, render, destroy: (m: TabModel) => plugin.tab.destroy.call(m) };
}
/** Simule l'ouverture du panneau par SiYuan : appelle `createActionElement` de chaque élément, dans l'ordre. */
function openPanel() {
  const setting = h.settings[0]!;
  const els = setting.items.map((item) => item.createActionElement?.() ?? item.actionElement!);
  const [autoIndex, autoIndexInterval, reindex, clear, diagnostic, log] = els as HTMLElement[] as [
    HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement,
  ];
  return { setting, autoIndex, autoIndexInterval, reindex, clear, diagnostic, log, close: () => setting.options.destroyCallback?.() };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  h.mounts.length = 0;
  h.sharedStart.mockReset().mockResolvedValue(undefined);
  h.sharedDispose.mockClear();
  h.sharedCreated = 0;
  h.showMessage.mockClear();
  h.start.mockReset();
  h.cancel.mockClear();
  h.unsubscribe.mockClear();
  h.start.mockResolvedValue({});
  h.listeners.clear();
  h.settings.length = 0;
  h.confirm.mockReset();
  h.openSetting.mockReset();
  h.clear.mockReset().mockResolvedValue({ removed: ["a.dsx"], failed: [], manifestFailed: false });
  h.refresh.mockReset().mockResolvedValue(undefined);
  h.getError.mockReset().mockReturnValue(undefined);
  h.isRunning = false;
  h.queue = null;
  h.failCreate = false;
  h.mountDeps.length = 0;
  h.reset.mockReset();
  h.stale.mockReset().mockResolvedValue({ handled: [], failed: [] });
  h.loadData.mockReset().mockResolvedValue("");
  h.saveData.mockReset().mockResolvedValue(undefined);
});

describe("DocSeekerPlugin", () => {
  it("détruire un onglet ne libère pas les autres", () => {
    const s = setup();
    const a = s.render();
    s.render();
    s.destroy(a);
    expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.mounts[1]!.dispose).not.toHaveBeenCalled();
    expect(h.unsubscribe).not.toHaveBeenCalled(); // l'onglet n'a plus d'écouteur d'indexeur : seul le panneau en a
    s.destroy(a);
    expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("journalise un échec de libération de PDF via le journal d'avertissements", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.indexerDeps = undefined;
    const s = setup();
    s.render();
    s.plugin.onLayoutReady();
    const error = new Error("destroy KO");
    const deps = h.indexerDeps as { onDestroyError?: (e: unknown) => void } | undefined;
    expect(deps?.onDestroyError).toBeTypeOf("function");
    deps?.onDestroyError?.(error);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Libération du PDF en échec"), error);
    warn.mockRestore();
  });

  it("onunload libère les onglets restants", () => {
    const s = setup();
    s.render();
    s.render();
    s.plugin.onunload();
    expect(h.mounts.every((m) => m.dispose.mock.calls.length === 1)).toBe(true);
    expect(h.cancel).toHaveBeenCalled();
  });

  it("onLayoutReady démarre le chargement de l'index partagé, créé une seule fois pour tous les onglets", () => {
    const s = setup();
    s.plugin.onLayoutReady();
    expect(h.sharedStart).toHaveBeenCalledTimes(1);
    s.render();
    s.render();
    expect(h.sharedCreated).toBe(1);
  });

  it("onunload libère l'index partagé", () => {
    const s = setup();
    s.plugin.onLayoutReady();
    s.plugin.onunload();
    expect(h.sharedDispose).toHaveBeenCalledTimes(1);
  });

  it("onLayoutReady ne lève pas si start() lève de façon synchrone, et journalise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.sharedStart.mockImplementation(() => {
      throw new Error("start KO");
    });
    const s = setup();
    expect(() => s.plugin.onLayoutReady()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("docseeker"), expect.any(Error));
    warn.mockRestore();
  });

  it("renderTab après onunload ne recrée pas d'index partagé orphelin", () => {
    const s = setup();
    s.render();
    s.plugin.onunload();
    expect(h.sharedCreated).toBe(1);
    const mounts = h.mounts.length;
    s.render();
    expect(h.sharedCreated).toBe(1);
    expect(h.mounts.length).toBe(mounts);
  });

  it("l'onglet ne contient plus la section Avancé : seulement la recherche", () => {
    const s = setup();
    const tab = s.render();
    expect(tab.element.querySelector("details, summary")).toBeNull();
    expect(tab.element.querySelector("button")).toBeNull();
  });

  it("le bouton « Ouvrir les paramètres » de l'onglet appelle openSetting()", () => {
    const s = setup();
    s.render();
    h.mounts[0]!.onOpenSettings!();
    expect(h.openSetting).toHaveBeenCalledTimes(1);
  });
});

describe("panneau de paramètres", () => {
  it("onload assigne this.setting avec six éléments (titre + description + action), sans réglage mort", () => {
    const s = setup();
    expect(h.settings).toHaveLength(1);
    expect((s.plugin as unknown as { setting: unknown }).setting).toBe(h.settings[0]);
    expect(h.settings[0]!.items.map((i) => [i.title, i.description])).toEqual([
      ["Indexation automatique", "Desc auto"],
      ["Fréquence de vérification", "Desc freq"],
      ["Réindexer", "Desc réindexer"],
      ["Vider l'index", "Desc vider"],
      ["Diagnostic technique", "Desc diag"],
      ["Journal", "Desc journal"],
    ]);
    expect(h.settings[0]!.items.every((i) => typeof i.createActionElement === "function")).toBe(true);
  });

  it("chaque item utilise direction « row » : SiYuan place alors l'action sous le titre, en pleine largeur (fn__block)", () => {
    setup();
    const items = h.settings[0]!.items as { direction?: string }[];
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.direction)).toEqual(["row", "row", "row", "row", "row", "row"]);
  });

  it("n'abonne rien avant l'ouverture du panneau", () => {
    setup();
    expect(h.listeners.size).toBe(0);
  });

  it("Réindexer lance l'indexeur, avec aria-disabled et signalement visible d'un échec", async () => {
    h.start.mockRejectedValue(new Error("noyau KO"));
    const s = setup();
    s.render();
    const panel = openPanel();
    const button = panel.reindex.querySelector<HTMLButtonElement>("button.docseeker-index")!;
    button.click();
    await flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.showMessage).toHaveBeenCalledWith(expect.stringContaining("noyau KO"), expect.any(Number), "error");
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    panel.close();
  });

  it("Réindexer relance le chargement de l'index partagé s'il avait échoué", async () => {
    h.getError.mockReturnValue("Chargement des index en échec");
    const s = setup();
    openPanel().reindex.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(h.sharedStart).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("Réindexer ne relance pas le chargement quand l'index va bien", async () => {
    setup();
    openPanel().reindex.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(h.sharedStart).not.toHaveBeenCalled();
  });

  it("affiche statut et progression de l'indexeur", () => {
    setup();
    const panel = openPanel();
    h.listener!({ type: "started" });
    h.listener!({ type: "progress", path: "a.pdf", page: 1, total: 3 });
    expect(panel.reindex.querySelector('[role="status"]')!.textContent).toBe("");
    expect(panel.reindex.textContent).toContain("a.pdf : page 1/3");
    panel.close();
  });

  it("Vider l'index : confirmation SiYuan, puis suppression du petal et rafraîchissement de l'index partagé (refreshNow)", async () => {
    setup();
    const panel = openPanel();
    panel.clear.querySelector<HTMLButtonElement>("button")!.click();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.clear).not.toHaveBeenCalled();
    h.confirm.mock.calls[0]![2]();
    await flush();
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    panel.close();
  });

  it("l'état « vidage en cours » est porté par le plugin : rouvrir le panneau pendant le vidage refuse Réindexer", async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.clear.mockImplementation(() => new Promise((r) => (finish = r)));
    setup();
    const first = openPanel();
    first.clear.querySelector<HTMLButtonElement>("button")!.click();
    h.confirm.mock.calls[0]![2]();
    first.close(); // fermeture pendant le vidage
    const second = openPanel();
    expect(second.clear.querySelector<HTMLButtonElement>("button")!.getAttribute("aria-disabled")).toBe("true");
    second.reindex.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(h.start).not.toHaveBeenCalled();
    finish({ removed: [], failed: [], manifestFailed: false });
    await flush();
    expect(second.clear.querySelector<HTMLButtonElement>("button")!.hasAttribute("aria-disabled")).toBe(false);
    second.reindex.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(h.start).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("rouvrir le panneau pendant une indexation initialise le statut depuis l'indexeur", () => {
    setup();
    h.isRunning = true;
    const panel = openPanel();
    expect(panel.reindex.querySelector('[role="status"]')!.textContent).not.toBe("");
    panel.close();
  });

  it("injecte la feuille de style à l'ouverture du panneau, sans onglet", () => {
    document.getElementById("docseeker-search-style")?.remove();
    setup();
    openPanel().close();
    expect(document.getElementById("docseeker-search-style")).not.toBeNull();
  });

  it("Vider l'index annulé : rien n'est supprimé", async () => {
    setup();
    const panel = openPanel();
    panel.clear.querySelector<HTMLButtonElement>("button")!.click();
    h.confirm.mock.calls[0]![3]();
    await flush();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("Vider l'index est refusé pendant une indexation (état de l'indexeur)", async () => {
    setup();
    h.isRunning = true;
    const panel = openPanel();
    panel.clear.querySelector<HTMLButtonElement>("button")!.click();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("Diagnostic : un échec est montré dans la sortie", async () => {
    setup();
    const panel = openPanel();
    panel.diagnostic.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(panel.diagnostic.querySelector('[role="status"]')!.textContent).not.toBe("");
    panel.close();
  });

  it("affiche un journal borné des avertissements (groupe défilable)", () => {
    const s = setup();
    s.render();
    const panel = openPanel();
    for (let i = 0; i < 60; i++) h.mounts[0]!.onWarn(`avert ${i}`);
    const log = panel.log.querySelector<HTMLElement>(".docseeker-log")!;
    expect(log.textContent).toContain("avert 59");
    expect(log.textContent).not.toContain("avert 5\n");
    expect(log.textContent!.trim().split("\n")).toHaveLength(50);
    panel.close();
  });

  it("destroyCallback libère les écouteurs (indexeur et journal)", () => {
    const s = setup();
    s.render();
    const base = h.listeners.size; // le suivi d'activité partagé de l'indicateur
    const panel = openPanel();
    expect(h.listeners.size).toBe(base + 1);
    panel.close();
    expect(h.listeners.size).toBe(base);
    h.mounts[0]!.onWarn("après fermeture");
    expect(panel.log.textContent).not.toContain("après fermeture");
  });

  it("rouvrir plusieurs fois ne cumule aucun écouteur", () => {
    const s = setup();
    s.render();
    const base = h.listeners.size;
    for (let i = 0; i < 4; i++) {
      const panel = openPanel();
      expect(h.listeners.size).toBe(base + 1);
      panel.close();
      expect(h.listeners.size).toBe(base);
    }
    openPanel();
    expect(h.listeners.size).toBe(base + 1);
  });

  it("fermer deux fois est sans effet", () => {
    setup();
    const panel = openPanel();
    panel.close();
    expect(() => panel.close()).not.toThrow();
    expect(h.listeners.size).toBe(0);
  });

  it("une rouverture sans fermeture préalable réutilise le panneau (pas d'écouteur en double)", () => {
    setup();
    openPanel();
    openPanel();
    expect(h.listeners.size).toBe(1);
  });

  it("onunload libère un panneau resté ouvert", () => {
    const s = setup();
    openPanel();
    expect(h.listeners.size).toBe(1);
    s.plugin.onunload();
    expect(h.listeners.size).toBe(0);
  });

  it("après onunload, rouvrir le panneau n'abonne plus rien", () => {
    const s = setup();
    s.plugin.onunload();
    openPanel();
    expect(h.listeners.size).toBe(0);
  });
});

describe("ouverture de plusieurs onglets de recherche", () => {
  it("demande un nouvel onglet à chaque clic sur le bouton de la barre du haut", async () => {
    const { openTab } = await import("siyuan");
    const mocked = vi.mocked(openTab);
    mocked.mockClear();
    const plugin = new (DocSeekerPlugin as unknown as new () => {
      onload(): void;
      topBar: { callback: () => void };
    })();
    plugin.onload();
    plugin.topBar.callback();
    plugin.topBar.callback();
    expect(mocked).toHaveBeenCalledTimes(2);
    for (const [options] of mocked.mock.calls) expect(options.openNewTab).toBe(true);
  });
});

describe("indexation automatique", () => {
  const MIN = 60_000;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const settle = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const startPlugin = async (stored: unknown = "") => {
    h.loadData.mockResolvedValue(stored);
    const s = setup();
    s.plugin.onLayoutReady();
    await settle(0);
    return s;
  };

  it("charge les réglages depuis settings.json, puis synchronise ~3 s après onLayoutReady, après removeStaleTmp", async () => {
    const order: string[] = [];
    h.stale.mockImplementation(async () => (order.push("stale"), { handled: [], failed: [] }));
    h.start.mockImplementation(async () => (order.push("start"), { failed: 0 }));
    await startPlugin();
    expect(h.loadData).toHaveBeenCalledWith("settings.json");
    await settle(2900);
    expect(h.start).not.toHaveBeenCalled();
    await settle(200);
    expect(order).toEqual(["stale", "start"]);
    expect(h.start).toHaveBeenCalledWith({ automatic: true }); // passe automatique : retrait progressif et pause activés
  });

  it("réglage désactivé au stockage : removeStaleTmp est appelé, aucune synchronisation", async () => {
    await startPlugin({ autoIndex: false, intervalMinutes: 5 });
    await settle(10 * MIN);
    expect(h.stale).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("réglages corrompus : défauts (activé, 5 min) et avertissement dans le journal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startPlugin({ autoIndex: "oui", intervalMinutes: 7 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalide"), undefined);
    await settle(3100);
    expect(h.start).toHaveBeenCalledTimes(1);
    await settle(5 * MIN);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("loadData qui rejette : défauts et avertissement, le plugin démarre quand même", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.loadData.mockRejectedValue(new Error("E/S"));
    const s = setup();
    s.plugin.onLayoutReady();
    await settle(3100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("réglages"), expect.any(Error));
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("removeStaleTmp : le rapport (.bak orphelin restauré, échecs) est journalisé et ne bloque pas le démarrage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.stale.mockResolvedValue({
      handled: ["abc.dsx.bak"],
      failed: [{ name: "def.dsx.tmp", error: new Error("verrou") }],
    });
    await startPlugin();
    await settle(3100);
    const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("abc.dsx.bak");
    expect(lines).toContain("def.dsx.tmp");
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("removeStaleTmp qui rejette : journalisé, la synchronisation a lieu", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.stale.mockRejectedValue(new Error("dossier illisible"));
    await startPlugin();
    await settle(3100);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("removeStaleTmp n'est appelé qu'une fois", async () => {
    await startPlugin();
    await settle(30 * MIN);
    expect(h.stale).toHaveBeenCalledTimes(1);
  });

  it("synchronise périodiquement (5 min par défaut)", async () => {
    await startPlugin();
    await settle(3100);
    await settle(5 * MIN);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("retour du focus de la fenêtre : synchronise après l'intervalle minimal de 30 s", async () => {
    await startPlugin();
    await settle(3100);
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(1);
    await settle(31_000);
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("onglet redevenu visible : traité comme un retour du focus", async () => {
    await startPlugin();
    await settle(3100 + 31_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("une saisie récente au clavier retarde la synchronisation (réessai après 10 s)", async () => {
    await startPlugin();
    await settle(2500);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await settle(1000); // 3,5 s : premier tour, saisie datant de 1 s
    expect(h.start).not.toHaveBeenCalled();
    await settle(10_000);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it.each([["keydown"], ["pointerdown"], ["wheel"]])(
    "une activité de l'utilisateur (%s) met l'indexeur en pause pendant 3 s (shouldYield) et retarde la passe",
    async (type) => {
      const s = await startPlugin();
      void s;
      expect(h.indexerDeps?.shouldYield?.()).toBe(false);
      document.dispatchEvent(new Event(type));
      expect(h.indexerDeps?.shouldYield?.()).toBe(true);
      await settle(3001);
      expect(h.indexerDeps?.shouldYield?.()).toBe(false);
    },
  );

  it("si createAutoSync lève : journalisé, aucun écouteur de saisie laissé sur le document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const add = vi.spyOn(document, "addEventListener");
    h.failCreate = true;
    const s = setup();
    expect(() => s.plugin.onLayoutReady()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("indexation automatique"), expect.any(Error));
    expect(add.mock.calls.filter((c) => ["keydown", "pointerdown", "wheel"].includes(String(c[0])))).toHaveLength(0);
    add.mockRestore();
  });

  it("un échec d'indexation est journalisé avec ses détails (bilan de l'indexeur), sans toast, et la boucle continue", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.start.mockResolvedValue({ failed: 1, failures: ["assets/vide.pdf : 0 octet"], incomplete: 0 });
    await startPlugin();
    await settle(3100);
    const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("1 PDF en échec");
    expect(lines).toContain("assets/vide.pdf");
    expect(h.showMessage).not.toHaveBeenCalled();
    await settle(5 * MIN);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("1 PDF en échec"))).toHaveLength(1);
    expect(h.listeners.size).toBeLessThanOrEqual(1); // seul le suivi d'activité écoute l'indexeur
  });

  it("une exception de start() est journalisée, sans toast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.start.mockRejectedValue(new Error("noyau KO"));
    await startPlugin();
    await settle(3100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Indexation automatique"), expect.any(Error));
    expect(h.showMessage).not.toHaveBeenCalled();
  });

  it("couper l'interrupteur dans le panneau s'applique tout de suite et est enregistré", async () => {
    const s = await startPlugin();
    await settle(3100);
    const panel = openPanel();
    const sw = panel.autoIndex.querySelector<HTMLInputElement>("input.b3-switch")!;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await settle(0);
    expect(h.saveData).toHaveBeenCalledWith("settings.json", { autoIndex: false, intervalMinutes: 5 });
    await settle(30 * MIN);
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(1);
    panel.close();
    s.plugin.onunload();
  });

  it("rallumer l'interrupteur relance une synchronisation tout de suite", async () => {
    await startPlugin({ autoIndex: false, intervalMinutes: 5 });
    await settle(3100);
    const panel = openPanel();
    const sw = panel.autoIndex.querySelector<HTMLInputElement>("input.b3-switch")!;
    expect((panel.autoIndexInterval.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    sw.checked = true;
    sw.dispatchEvent(new Event("change"));
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(1);
    panel.close();
  });

  it("changer la fréquence reprogramme sans recharger", async () => {
    await startPlugin();
    await settle(3100);
    const panel = openPanel();
    const select = panel.autoIndexInterval.querySelector<HTMLSelectElement>("select")!;
    select.value = "15";
    select.dispatchEvent(new Event("change"));
    await settle(0);
    expect(h.saveData).toHaveBeenCalledWith("settings.json", { autoIndex: true, intervalMinutes: 15 });
    await settle(15 * MIN);
    expect(h.start).toHaveBeenCalledTimes(2);
    panel.close();
  });

  it("pas de synchronisation pendant un vidage ; reconstruction automatique juste après", async () => {
    await startPlugin();
    await settle(3100);
    h.start.mockClear();
    let finish: (v: unknown) => void = () => undefined;
    h.clear.mockImplementation(() => new Promise((r) => (finish = r)));
    const panel = openPanel();
    panel.clear.querySelector<HTMLButtonElement>("button")!.click();
    h.confirm.mock.calls[0]![2]();
    await settle(0);
    await settle(10 * MIN);
    expect(h.start).not.toHaveBeenCalled();
    finish({ removed: ["a.dsx"], failed: [], manifestFailed: false });
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(panel.clear.textContent).toContain("Reconstruction en cours");
    expect(h.reset).toHaveBeenCalledTimes(1); // la table de retrait progressif est vidée avant la reconstruction
    panel.close();
  });

  it("onunload : plus aucun minuteur ni écouteur de fenêtre", async () => {
    const s = await startPlugin();
    await settle(3100);
    s.plugin.onunload();
    h.start.mockClear();
    await settle(60 * MIN);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(0);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("onunload avant la fin du délai initial : ni removeStaleTmp ni synchronisation", async () => {
    const s = await startPlugin();
    s.plugin.onunload();
    await settle(MIN);
    expect(h.stale).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("l'onglet reçoit la source d'activité d'indexation (progression N/M issue de la file)", async () => {
    const s = await startPlugin();
    s.render();
    const activity = h.mountDeps[0]!.indexActivity!;
    expect(activity.getSnapshot()).toMatchObject({ phase: "idle" });
    h.queue = { pending: ["b"], running: ["c"], completed: ["a"], failed: [] };
    for (const l of [...h.listeners]) l({ type: "progress", path: "c", page: 1, total: 2 });
    expect(activity.getSnapshot()).toEqual({ phase: "running", done: 1, total: 3, failed: 0, incomplete: 0, discovery: false });
  });

  it("un seul suivi d'activité partagé entre onglets, libéré à onunload", async () => {
    const s = await startPlugin();
    s.render();
    s.render();
    expect(h.mountDeps[0]!.indexActivity).toBe(h.mountDeps[1]!.indexActivity);
    s.plugin.onunload();
    expect(h.listeners.size).toBe(0);
  });
});
