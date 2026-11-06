// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  indexerDeps: undefined as { onDestroyError?: (e: unknown) => void } | undefined,
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
    };
    setting: unknown;
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
vi.mock("../../src/siyuan/kernelApi", () => ({ createKernelApi: () => ({}) }));
vi.mock("../../src/siyuan/petalStore", () => ({ createPetalStore: () => ({ clear: h.clear }) }));
vi.mock("../../src/siyuan/discovery", () => ({ discoverPdfs: vi.fn() }));
vi.mock("../../src/indexer/loadPdf", () => ({ createLoadPdf: () => vi.fn() }));
vi.mock("../../src/indexer/indexer", () => ({
  createIndexer: (deps: { onDestroyError?: (e: unknown) => void }) => ({
    ...((h.indexerDeps = deps), {}),
    start: h.start,
    cancel: h.cancel,
    getState: () => ({ status: h.isRunning ? "running" : "idle" }),
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
      deps: { onWarn: (m: string, e?: unknown) => void; onOpenSettings?: () => void },
    ) => {
      const m = { dispose: vi.fn(), onWarn: deps.onWarn, onOpenSettings: deps.onOpenSettings };
      h.mounts.push(m);
      return m;
    },
  };
});

import DocSeekerPlugin from "../../src/index";

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
  return { plugin, render, destroy: (m: TabModel) => plugin.tab.destroy.call(m) };
}
/** Simule l'ouverture du panneau par SiYuan : appelle `createActionElement` de chaque élément, dans l'ordre. */
function openPanel() {
  const setting = h.settings[0]!;
  const els = setting.items.map((item) => item.createActionElement?.() ?? item.actionElement!);
  const [reindex, clear, diagnostic, log] = els as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
  return { setting, reindex, clear, diagnostic, log, close: () => setting.options.destroyCallback?.() };
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
    expect(h.listeners.size).toBe(0);
  });

  it("le bouton « Ouvrir les paramètres » de l'onglet appelle openSetting()", () => {
    const s = setup();
    s.render();
    h.mounts[0]!.onOpenSettings!();
    expect(h.openSetting).toHaveBeenCalledTimes(1);
  });
});

describe("panneau de paramètres", () => {
  it("onload assigne this.setting avec quatre éléments (titre + description + action), sans réglage mort", () => {
    const s = setup();
    expect(h.settings).toHaveLength(1);
    expect((s.plugin as unknown as { setting: unknown }).setting).toBe(h.settings[0]);
    expect(h.settings[0]!.items.map((i) => [i.title, i.description])).toEqual([
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
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.direction)).toEqual(["row", "row", "row", "row"]);
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
    expect(panel.reindex.querySelector('[role="status"]')!.textContent).toBe("Indexation démarrée");
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
    const panel = openPanel();
    expect(h.listeners.size).toBe(1);
    panel.close();
    expect(h.listeners.size).toBe(0);
    h.mounts[0]!.onWarn("après fermeture");
    expect(panel.log.textContent).not.toContain("après fermeture");
  });

  it("rouvrir plusieurs fois ne cumule aucun écouteur", () => {
    const s = setup();
    s.render();
    for (let i = 0; i < 4; i++) {
      const panel = openPanel();
      expect(h.listeners.size).toBe(1);
      panel.close();
      expect(h.listeners.size).toBe(0);
    }
    openPanel();
    expect(h.listeners.size).toBe(1);
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
