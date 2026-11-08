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
  pdfjsGetters: [] as Array<() => unknown>,
  lazyCreated: 0,
  lazyOverride: undefined as undefined | (() => Promise<unknown>),
  m0Deps: undefined as undefined | { pdfjs?: unknown; pdfjsError?: string },
  indexerDeps: undefined as { onDestroyError?: (e: unknown) => void; shouldYield?: () => boolean } | undefined,
  commands: [] as { langKey: string; langText?: string; hotkey?: string; callback?: () => void }[],
  mounts: [] as {
    dispose: ReturnType<typeof vi.fn>;
    focusInput: ReturnType<typeof vi.fn>;
    onWarn: (m: string, e?: unknown) => void;
    onOpenSettings?: (() => void) | undefined;
    host: HTMLElement;
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
  mountError: undefined as Error | undefined,
  floatingDisposeError: undefined as Error | undefined,
  openFloating: vi.fn(),
  floatingDialogs: [] as {
    options: { title: string; build(c: HTMLElement): void; onDestroyed?(info: { focus: boolean }): void; onClosing?(info: { focus: boolean }): void };
    container: HTMLElement;
    closeCalls: ({ focus?: boolean } | undefined)[];
    destroyed: boolean;
    vanished: boolean;
    /** SiYuan lance la destruction (Échap global, voile, croix) : `onClosing` tout de suite ; destruction réelle ensuite (immédiate sauf `floatingDeferred`). */
    beginDestroy(info?: { focus: boolean }): void;
    destroy(info?: { focus: boolean }): void;
    /** SiYuan retire l'élément sans jamais appeler `destroyCallback`. */
    vanish(): void;
  }[],
  floatingDeferred: false,
  queue: null as null | { pending: string[]; running: string[]; completed: string[]; failed: unknown[] },
  mountDeps: [] as {
    indexActivity?: { getSnapshot(): unknown; subscribe(l: () => void): () => void };
    settings?: { get(): { sort: unknown; groupByDocument: boolean }; update(patch: Record<string, unknown>): Promise<void> };
  }[],
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
      commandOpenSearch: "Rechercher dans les PDF",
      commandFocusSearch: "Aller au champ de recherche PDF",
      commandOpenSearchFloating: "Rechercher dans les PDF (fenêtre flottante)",
      commandOpenSearchTab: "Rechercher dans les PDF (onglet)",
      openMode: "Ouverture de la recherche",
      openModeDesc: "Desc ouverture",
      floatingTitle: "Recherche dans les PDF",
      floatingOpenFailed: "Impossible d'ouvrir la fenêtre de recherche",
      openTabFailed: "Impossible d'ouvrir l'onglet de recherche",
      transferTabFailed: "Impossible d'ouvrir la recherche dans un onglet : la fenêtre reste ouverte",
      highlightUnavailable: "Surlignage indisponible",
      criteriaLoadFailed: "Critères illisibles : ils sont ignorés",
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
    addCommand(command: (typeof h.commands)[number]) {
      h.commands.push(command);
    }
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
vi.mock("../../src/siyuan/pdfjsLoader", async (orig) => {
  const actual = await orig<typeof import("../../src/siyuan/pdfjsLoader")>();
  return {
    ...actual,
    createLazyPdfjs: (deps: Parameters<typeof actual.createLazyPdfjs>[0]) => {
      h.lazyCreated += 1;
      return h.lazyOverride ?? actual.createLazyPdfjs(deps);
    },
  };
});
vi.mock("../../src/diagnostic/m0", async (orig) => {
  const actual = await orig<typeof import("../../src/diagnostic/m0")>();
  return {
    ...actual,
    runM0Diagnostic: (deps: Parameters<typeof actual.runM0Diagnostic>[0]) => {
      h.m0Deps = deps;
      return actual.runM0Diagnostic(deps);
    },
  };
});
vi.mock("../../src/siyuan/kernelApi", () => ({ createKernelApi: () => ({}) }));
vi.mock("../../src/siyuan/nativeUi", () => ({ openMenu: vi.fn(), openDialog: vi.fn(), openCustomDialog: vi.fn(), openInputDialog: vi.fn(), openConfirmDialog: vi.fn(), openFloatingDialog: (o: unknown) => h.openFloating(o) }));
vi.mock("../../src/siyuan/petalStore", () => ({ createPetalStore: () => ({ clear: h.clear, removeStaleTmp: h.stale }) }));
vi.mock("../../src/siyuan/discovery", () => ({ discoverPdfs: vi.fn() }));
vi.mock("../../src/indexer/loadPdf", () => ({
  createLoadPdf: (getter: () => unknown) => (h.pdfjsGetters.push(getter), vi.fn()),
}));
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
vi.mock("../../src/siyuan/floatingSearch", async (orig) => {
  const actual = await orig<typeof import("../../src/siyuan/floatingSearch")>();
  return {
    ...actual,
    createFloatingSearch: (deps: Parameters<typeof actual.createFloatingSearch>[0]) => {
      const real = actual.createFloatingSearch(deps);
      return {
        ...real,
        dispose() {
          if (h.floatingDisposeError) {
            real.dispose();
            throw h.floatingDisposeError;
          }
          real.dispose();
        },
      };
    },
  };
});
vi.mock("../../src/searchTab", async (orig) => {
  const actual = await orig<typeof import("../../src/searchTab")>();
  return {
    ...actual,
    mountSearchTab: (
      host: HTMLElement,
      deps: { onWarn: (m: string, e?: unknown) => void; onOpenSettings?: () => void; indexActivity?: never },
    ) => {
      if (h.mountError) throw h.mountError;
      h.mountDeps.push(deps);
      const m = { dispose: vi.fn(), focusInput: vi.fn(() => true), onWarn: deps.onWarn, onOpenSettings: deps.onOpenSettings, host };
      h.mounts.push(m);
      return m;
    },
  };
});

import DocSeekerPlugin from "../../src/index";

const plugins: { onunload(): void }[] = [];
afterEach(() => {
  document.body.replaceChildren();
  // Les écouteurs de fenêtre d'un plugin non déchargé survivraient au test suivant (même window jsdom).
  for (const p of plugins.splice(0)) p.onunload();
});

type TabModel = { element: HTMLElement; data?: unknown };
function setup() {
  const plugin = new (DocSeekerPlugin as unknown as new () => unknown)() as {
    onload(): void;
    onunload(): void;
    onLayoutReady(): void;
    tab: { init: (this: TabModel, c: TabModel) => void; destroy: (this: TabModel) => void };
    topBar: { callback: () => void };
  };
  plugin.onload();
  /**
   * Rend un onglet dans `element` (nouveau par défaut), attaché au document comme un vrai onglet SiYuan. `data` : le `custom.data` que
   * SiYuan transmet à `init` (`this.data` de Custom, lu dans le bundle 3.8.9 : celui passé à `openTab({ custom: { data } })`).
   */
  const render = (element: HTMLElement = document.createElement("div"), data?: unknown): TabModel => {
    const model: TabModel = { element, data };
    if (!element.isConnected) document.body.append(element);
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
  const [openMode, autoIndex, autoIndexInterval, reindex, clear, diagnostic, log] = els as HTMLElement[] as [
    HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement,
  ];
  return { setting, openMode, autoIndex, autoIndexInterval, reindex, clear, diagnostic, log, close: () => setting.options.destroyCallback?.() };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  h.mounts.length = 0;
  h.commands.length = 0;
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
  h.mountError = undefined;
  h.floatingDisposeError = undefined;
  h.mountDeps.length = 0;
  h.floatingDialogs.length = 0;
  h.floatingDeferred = false;
  h.openFloating.mockReset().mockImplementation((options: (typeof h.floatingDialogs)[number]["options"]) => {
    const container = document.createElement("div");
    document.body.append(container);
    let pendingFocus = true;
    let begun = false;
    const dialog: (typeof h.floatingDialogs)[number] = {
      options,
      container,
      closeCalls: [],
      destroyed: false,
      vanished: false,
      beginDestroy(info) {
        if (begun) return;
        begun = true;
        options.onClosing?.(info ?? { focus: pendingFocus });
        if (!h.floatingDeferred) dialog.destroy(info);
      },
      destroy(info) {
        if (dialog.destroyed) return;
        dialog.destroyed = true;
        container.remove();
        options.onDestroyed?.(info ?? { focus: pendingFocus });
      },
      vanish() {
        dialog.vanished = true;
        container.remove();
      },
    };
    h.floatingDialogs.push(dialog);
    options.build(container);
    return {
      close: (o?: { focus?: boolean }) => {
        dialog.closeCalls.push(o);
        if (dialog.closeCalls.length === 1) pendingFocus = o?.focus !== false;
        dialog.beginDestroy();
      },
      isOpen: () => !dialog.destroyed && !dialog.vanished,
    };
  });
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

  it("bureau : les points d'appel obtiennent window.pdfjsLib tel quel, sans injecter de script", async () => {
    const lib = { getDocument: vi.fn() };
    (window as { pdfjsLib?: unknown }).pdfjsLib = lib;
    const scriptsBefore = document.querySelectorAll("script").length;
    h.pdfjsGetters.length = 0;
    try {
      const s = setup();
      s.render(); // point d'appel de l'onglet
      s.plugin.onLayoutReady(); // point d'appel de l'indexeur
      expect(h.pdfjsGetters.length).toBeGreaterThanOrEqual(2);
      for (const getter of h.pdfjsGetters) await expect(getter()).resolves.toBe(lib);
      expect(document.querySelectorAll("script")).toHaveLength(scriptsBefore);
    } finally {
      delete (window as { pdfjsLib?: unknown }).pdfjsLib;
    }
  });

  it("les deux points d'appel partagent le même chargeur paresseux (une seule création)", () => {
    h.lazyCreated = 0;
    h.pdfjsGetters.length = 0;
    const s = setup();
    s.render();
    s.plugin.onLayoutReady();
    expect(h.pdfjsGetters.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.pdfjsGetters).size).toBe(1);
    expect(h.lazyCreated).toBe(1);
  });

  it("Diagnostic : transmet le PDF.js obtenu du chargeur paresseux", async () => {
    const lib = { getDocument: vi.fn() };
    h.lazyOverride = async () => lib;
    h.m0Deps = undefined;
    const captured = (): { pdfjs?: unknown; pdfjsError?: string } | undefined => h.m0Deps;
    try {
      setup();
      const panel = openPanel();
      panel.diagnostic.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
      expect(captured()?.pdfjs).toBe(lib);
      expect(captured()?.pdfjsError).toBeUndefined();
      panel.close();
    } finally {
      h.lazyOverride = undefined;
    }
  });

  it("Diagnostic : l'échec de chargement de PDF.js est tracé et son message transmis au rapport", async () => {
    h.lazyOverride = async () => {
      throw new Error("PDF.js n'est pas apparu après 10000 ms");
    };
    h.m0Deps = undefined;
    const captured = (): { pdfjs?: unknown; pdfjsError?: string } | undefined => h.m0Deps;
    try {
      setup();
      const panel = openPanel();
      panel.diagnostic.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
      expect(captured()?.pdfjs).toBeUndefined();
      expect(captured()?.pdfjsError).toContain("PDF.js n'est pas apparu après 10000 ms");
      panel.close();
    } finally {
      h.lazyOverride = undefined;
    }
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
  it("onload assigne this.setting avec sept éléments (titre + description + action), sans réglage mort", () => {
    const s = setup();
    expect(h.settings).toHaveLength(1);
    expect((s.plugin as unknown as { setting: unknown }).setting).toBe(h.settings[0]);
    expect(h.settings[0]!.items.map((i) => [i.title, i.description])).toEqual([
      ["Ouverture de la recherche", "Desc ouverture"],
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
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.direction)).toEqual(["row", "row", "row", "row", "row", "row", "row"]);
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
    await flush(); // le réglage d'ouverture est lu avant de choisir (settings.ready)
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
  const PRESENTATION = { sort: { key: "relevance", direction: "desc" }, groupByDocument: true, history: [], openMode: "tab", savedCriteria: [] } as const;
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

  describe("critères enregistrés illisibles", () => {
    const GOOD = { name: "ok", query: "chat", filters: { folder: "", includeSubfolders: true, nameContains: "" }, sort: { key: "relevance", direction: "desc" }, groupByDocument: true };

    it("message visible UNE seule fois par session (même après plusieurs lectures), une trace par critère ignoré", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await startPlugin({ savedCriteria: [GOOD, { name: 1 }, "x"] });
      await settle(100);
      expect(h.showMessage).toHaveBeenCalledTimes(1);
      expect(h.showMessage).toHaveBeenCalledWith("Critères illisibles : ils sont ignorés", expect.any(Number), "error");
      expect(warn.mock.calls.filter(([m]) => String(m).includes("Critère n°"))).toHaveLength(2);
    });

    it("critères valides ou absents : aucun message", async () => {
      await startPlugin({ savedCriteria: [GOOD] });
      await startPlugin({ autoIndex: true });
      await settle(100);
      expect(h.showMessage).not.toHaveBeenCalled();
    });
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
      await startPlugin();
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
    expect(h.saveData).toHaveBeenCalledWith("settings.json", { autoIndex: false, intervalMinutes: 5, ...PRESENTATION });
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
    expect(h.saveData).toHaveBeenCalledWith("settings.json", { autoIndex: true, intervalMinutes: 15, ...PRESENTATION });
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

  it("l'onglet reçoit les réglages : tri et regroupement chargés depuis settings.json, réécrits à chaque changement", async () => {
    const s = await startPlugin({ autoIndex: true, intervalMinutes: 5, sort: { key: "name", direction: "asc" }, groupByDocument: false });
    s.render();
    const tabSettings = h.mountDeps[0]!.settings!;
    expect(tabSettings.get().sort).toEqual({ key: "name", direction: "asc" });
    expect(tabSettings.get().groupByDocument).toBe(false);
    await tabSettings.update({ sort: { key: "modified", direction: "desc" } });
    expect(h.saveData).toHaveBeenLastCalledWith("settings.json", {
      autoIndex: true, intervalMinutes: 5, sort: { key: "modified", direction: "desc" }, groupByDocument: false, history: [], openMode: "tab", savedCriteria: [],
    });
  });

  it("les réglages sont lus dès onload (avant onLayoutReady) et une seule fois", async () => {
    h.loadData.mockResolvedValue({ autoIndex: false, intervalMinutes: 60 });
    const s = setup();
    expect(h.loadData).toHaveBeenCalledWith("settings.json");
    s.plugin.onLayoutReady();
    await settle(0);
    expect(h.loadData).toHaveBeenCalledTimes(1);
  });

  it("un onglet monté et modifié AVANT onLayoutReady n'écrase pas settings.json existant", async () => {
    h.loadData.mockResolvedValue({ autoIndex: false, intervalMinutes: 60, sort: { key: "name", direction: "asc" }, groupByDocument: true });
    const s = setup();
    s.render();
    const pending = h.mountDeps[0]!.settings!.update({ groupByDocument: false });
    await pending;
    expect(h.saveData).toHaveBeenLastCalledWith("settings.json", {
      autoIndex: false, intervalMinutes: 60, sort: { key: "name", direction: "asc" }, groupByDocument: false, history: [], openMode: "tab", savedCriteria: [],
    });
  });

  it("l'onglet reçoit une promesse ready (réglages chargés) pour appliquer le tri mémorisé", async () => {
    h.loadData.mockResolvedValue({ sort: { key: "name", direction: "asc" } });
    const s = setup();
    s.render();
    const tabSettings = h.mountDeps[0]!.settings as unknown as { ready: Promise<void>; get(): { sort: unknown } };
    expect(tabSettings.ready).toBeInstanceOf(Promise);
    await tabSettings.ready;
    expect(tabSettings.get().sort).toEqual({ key: "name", direction: "asc" });
  });

  it("un ancien settings.json (deux champs) se charge sans avertissement ni réécriture", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startPlugin({ autoIndex: true, intervalMinutes: 15 });
    expect(h.saveData).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("changer le tri ne perturbe pas l'indexation automatique (aucune synchronisation de plus, minuterie intacte)", async () => {
    const s = await startPlugin();
    await settle(3100);
    s.render();
    expect(h.start).toHaveBeenCalledTimes(1);
    await h.mountDeps[0]!.settings!.update({ sort: { key: "name", direction: "desc" } });
    await h.mountDeps[0]!.settings!.update({ groupByDocument: false });
    await settle(0);
    expect(h.start).toHaveBeenCalledTimes(1);
    await settle(5 * MIN);
    expect(h.start).toHaveBeenCalledTimes(2); // la période de 5 minutes n'a pas été repoussée ni doublée
  });
});

describe("commandes (J10 10e)", () => {
  const command = (key: string) => h.commands.find((c) => c.langKey === key);
  /** Laisse s'écouler toute la chaîne de promesses en attente (un tour de boucle d'événements complet). */
  const settle = async (): Promise<void> => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const hide = (el: HTMLElement): void => {
    el.style.display = "none";
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("enregistre openSearch, openSearchFloating, openSearchTab et focusSearch, sans raccourci par défaut, avec leurs libellés", () => {
    setup();
    expect(h.commands.map((c) => c.langKey).sort()).toEqual(["focusSearch", "openSearch", "openSearchFloating", "openSearchTab"]);
    for (const c of h.commands) expect(c.hotkey).toBe("");
    expect(command("openSearch")!.langText).toBe("Rechercher dans les PDF");
    expect(command("focusSearch")!.langText).toBe("Aller au champ de recherche PDF");
    expect(command("openSearchFloating")!.langText).toBe("Rechercher dans les PDF (fenêtre flottante)");
    expect(command("openSearchTab")!.langText).toBe("Rechercher dans les PDF (onglet)");
  });

  it("openSearch ouvre toujours un nouvel onglet", async () => {
    const { openTab } = await import("siyuan");
    const mocked = vi.mocked(openTab);
    mocked.mockReset();
    setup();
    command("openSearch")!.callback!();
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]![0]).toMatchObject({ openNewTab: true, custom: { id: "docseekerdocseeker" } });
  });

  it("focusSearch sans onglet : ouvre l'onglet puis met le focus sur son champ", async () => {
    const { openTab } = await import("siyuan");
    const mocked = vi.mocked(openTab);
    mocked.mockReset();
    const { render } = setup();
    mocked.mockImplementation((async () => {
      render();
    }) as never);
    command("focusSearch")!.callback!();
    await settle();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]![0]).toMatchObject({ openNewTab: true });
    expect(h.mounts).toHaveLength(1);
    expect(h.mounts[0]!.focusInput).toHaveBeenCalled();
  });

  it("focusSearch avec un onglet ouvert : le ramène devant (sans en créer un autre) et focalise son champ", async () => {
    const { openTab } = await import("siyuan");
    const mocked = vi.mocked(openTab);
    mocked.mockReset().mockResolvedValue(undefined as never);
    const { render } = setup();
    render();
    command("focusSearch")!.callback!();
    await settle();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]![0]).not.toHaveProperty("openNewTab");
    expect(mocked.mock.calls[0]![0]).toMatchObject({ custom: { id: "docseekerdocseeker" } });
    expect(h.mounts[0]!.focusInput).toHaveBeenCalled();
  });

  it("focusSearch avec plusieurs onglets : le dernier ouvert", async () => {
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const { render } = setup();
    render();
    render();
    command("focusSearch")!.callback!();
    await settle();
    expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
    expect(h.mounts[1]!.focusInput).toHaveBeenCalled();
  });

  it("un onglet fermé n'est plus ciblé : focusSearch en rouvre un", async () => {
    const { openTab } = await import("siyuan");
    const mocked = vi.mocked(openTab);
    mocked.mockReset().mockResolvedValue(undefined as never);
    const { render, destroy } = setup();
    const model = render();
    destroy(model);
    command("focusSearch")!.callback!();
    await settle();
    expect(mocked.mock.calls[0]![0]).toMatchObject({ openNewTab: true });
    expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
  });

  it("le focus est redemandé juste après (l'onglet n'est parfois affiché qu'ensuite)", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const { render } = setup();
    render();
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.mounts[0]!.focusInput.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.mounts[0]!.focusInput.mock.calls.length).toBe(first + 1);
  });

  it("focusSearch avec plusieurs onglets : seul l'onglet VISIBLE est visé, même s'il n'est pas le dernier", async () => {
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const { render } = setup();
    render();
    const second = render();
    hide(second.element);
    command("focusSearch")!.callback!();
    await settle();
    expect(h.mounts[0]!.focusInput).toHaveBeenCalled();
    expect(h.mounts[1]!.focusInput).not.toHaveBeenCalled();
  });

  it("render(host1) render(host2) render(host1) : focusSearch vise le nouvel onglet de host1", async () => {
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const { render } = setup();
    const host1 = document.createElement("div");
    const host2 = document.createElement("div");
    render(host1);
    render(host2);
    render(host1);
    command("focusSearch")!.callback!();
    await settle();
    expect(h.mounts[0]!.dispose).toHaveBeenCalled(); // l'ancien onglet de host1 est libéré
    expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
    expect(h.mounts[1]!.focusInput).not.toHaveBeenCalled();
    expect(h.mounts[2]!.focusInput).toHaveBeenCalled();
  });

  it("plugin déchargé pendant que openTab est en attente : aucun focus, aucun minuteur, aucun avertissement", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    let release!: () => void;
    vi.mocked(openTab).mockReset().mockImplementation((() => new Promise<void>((res) => (release = res))) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { plugin, render } = setup();
    render();
    command("focusSearch")!.callback!();
    plugin.onunload();
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("plugin déchargé pendant le minuteur de rattrapage : pas de second focus", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const { plugin, render } = setup();
    render();
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.mounts[0]!.focusInput).toHaveBeenCalledTimes(1);
    plugin.onunload();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.mounts[0]!.focusInput).toHaveBeenCalledTimes(1);
  });

  it("rattrapage à 50 ms : champ toujours sans focus => avertissement « Champ de recherche non focalisé »", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { render } = setup();
    render();
    h.mounts[0]!.focusInput.mockReturnValue(false);
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).not.toHaveBeenCalled(); // le premier essai peut échouer : l'onglet n'est parfois affiché qu'ensuite
    await vi.advanceTimersByTimeAsync(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Champ de recherche non focalisé"), undefined);
  });

  it("rattrapage réussi : aucun avertissement", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { render } = setup();
    render();
    h.mounts[0]!.focusInput.mockReturnValueOnce(false).mockReturnValue(true);
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("aucun onglet visible au rattrapage : avertissement", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { render } = setup();
    hide(render().element);
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Champ de recherche non focalisé"), undefined);
  });

  it("focusInput qui lève (vue détruite) au premier essai ou au rattrapage : tracé, sans exception non gérée", async () => {
    vi.useFakeTimers();
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { render } = setup();
    render();
    h.mounts[0]!.focusInput.mockImplementation(() => {
      throw new Error("vue détruite");
    });
    command("focusSearch")!.callback!();
    await vi.advanceTimersByTimeAsync(200);
    const traced = warn.mock.calls.filter(([m, e]) => String(m).includes("champ de recherche") && e instanceof Error);
    expect(traced.length).toBe(2); // premier essai + rattrapage
  });

  it("openTab qui échoue : journalisé, jamais avalé, aucune exception", async () => {
    const { openTab } = await import("siyuan");
    vi.mocked(openTab).mockReset().mockRejectedValue(new Error("refus") as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setup();
    command("focusSearch")!.callback!();
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("champ de recherche"), expect.any(Error));
    vi.mocked(openTab).mockReset().mockImplementation((() => {
      throw new Error("sync");
    }) as never);
    expect(() => command("focusSearch")!.callback!()).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("trace des touches dans le panneau (R6)", () => {
  const traceButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.docseeker-trace-keys")!;
  const traceLog = (el: HTMLElement) => el.querySelector<HTMLElement>(".docseeker-trace-log")!;
  const searchRoot = (): HTMLElement => {
    const el = document.createElement("div");
    el.className = "docseeker-search";
    document.body.append(el);
    return el;
  };
  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };

  it("sans onglet de recherche dans le document : message, rien n'est tracé", () => {
    setup();
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    expect(panel.diagnostic.querySelector(".docseeker-trace-status")!.textContent).toBe("traceKeysNoTab");
  });

  it("avec un onglet : les touches tracées arrivent dans la zone de trace, pas dans le journal des avertissements", () => {
    setup();
    const root = searchRoot();
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    key(root, "ArrowDown");
    expect(traceLog(panel.diagnostic).textContent).toContain("key=ArrowDown");
    expect(panel.log.textContent).not.toContain("key=ArrowDown");
  });

  it("après la fermeture du panneau, un ArrowUp ne produit aucune ligne et un message d'arrêt est journalisé", () => {
    setup();
    const root = searchRoot();
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    key(root, "ArrowDown");
    panel.close();
    key(root, "ArrowUp");
    expect(traceLog(panel.diagnostic).textContent).not.toContain("key=ArrowUp");
    expect(panel.log.textContent).not.toContain("key=ArrowUp");
    expect(panel.log.textContent).toContain("Trace des touches arrêtée (panneau fermé)");
  });

  it("deux onglets dont un caché : la trace vise l'onglet VISIBLE, même s'il n'est pas le premier du document", () => {
    setup();
    const shown = searchRoot();
    const hiddenRoot = searchRoot();
    hiddenRoot.style.display = "none";
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    key(hiddenRoot, "ArrowLeft");
    key(shown, "ArrowRight");
    const text = traceLog(panel.diagnostic).textContent!;
    // Les phases window/document voient toutes les touches ; seule la phase « root » dit quel onglet est suivi.
    expect(text).toContain("root capture key=ArrowRight");
    expect(text).not.toContain("root capture key=ArrowLeft");
  });

  it("deux onglets dont le premier est caché : le second (visible) est tracé", () => {
    setup();
    const hiddenRoot = searchRoot();
    hiddenRoot.style.display = "none";
    const shown = searchRoot();
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    key(shown, "Enter");
    key(hiddenRoot, "Escape");
    const text = traceLog(panel.diagnostic).textContent!;
    expect(text).toContain("root capture key=Enter");
    expect(text).not.toContain("root capture key=Escape");
  });

  it("seul un onglet caché existe : message « aucun onglet », rien n'est tracé", () => {
    setup();
    searchRoot().style.display = "none";
    const panel = openPanel();
    traceButton(panel.diagnostic).click();
    expect(panel.diagnostic.querySelector(".docseeker-trace-status")!.textContent).toBe("traceKeysNoTab");
  });
});

describe("fenêtre flottante ou onglet (J10 10d)", () => {
  type FloatingDeps = {
    floating?: { onPdfOpened(overlay?: { dispose(): void }): void; onOpenInTab(): void; onCloseRequest(): void };
    session?: { initial: { query: string; options: unknown } | undefined; save(state: { query: string; options: unknown }): void };
  };
  const command = (key: string) => h.commands.find((c) => c.langKey === key)!;
  const deps = (index = -1): FloatingDeps => h.mountDeps.at(index) as unknown as FloatingDeps;
  const dialog = () => h.floatingDialogs.at(-1)!;
  const STATE = { query: "chat", options: { sort: { key: "name", direction: "asc" }, filters: { folder: "assets/", includeSubfolders: true, nameContains: "" } } };
  const openTabMock = async () => {
    const { openTab } = await import("siyuan");
    return vi.mocked(openTab).mockReset().mockResolvedValue(undefined as never);
  };
  const startWith = async (stored: unknown = "") => {
    h.loadData.mockResolvedValue(stored);
    const s = setup();
    await flush();
    return s;
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("choix du mode", () => {
    it("openSearchFloating ouvre TOUJOURS la fenêtre flottante, même si le réglage dit « onglet »", async () => {
      const openTab = await openTabMock();
      await startWith({ openMode: "tab" });
      command("openSearchFloating").callback!();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(h.floatingDialogs[0]!.options.title).toBe("Recherche dans les PDF");
      expect(openTab).not.toHaveBeenCalled();
    });

    it("openSearchTab ouvre TOUJOURS un nouvel onglet, même si le réglage dit « fenêtre flottante »", async () => {
      const openTab = await openTabMock();
      await startWith({ openMode: "dialog" });
      command("openSearchTab").callback!();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTab).mock.calls[0]![0]).toMatchObject({ openNewTab: true, custom: { id: "docseekerdocseeker" } });
      expect(h.openFloating).not.toHaveBeenCalled();
    });

    it("openSearch suit le réglage : onglet par défaut (ancien fichier, ou pas de fichier)", async () => {
      const openTab = await openTabMock();
      await startWith("");
      command("openSearch").callback!();
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(h.openFloating).not.toHaveBeenCalled();
    });

    it("openSearch suit le réglage : « fenêtre flottante » ouvre le dialogue, pas d'onglet", async () => {
      const openTab = await openTabMock();
      await startWith({ openMode: "dialog" });
      command("openSearch").callback!();
      await flush();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(openTab).not.toHaveBeenCalled();
    });

    it("l'icône de la barre supérieure suit le réglage, dans un sens comme dans l'autre", async () => {
      const openTab = await openTabMock();
      const s = await startWith({ openMode: "dialog" });
      s.plugin.topBar.callback();
      await flush();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(openTab).not.toHaveBeenCalled();
      await (s.plugin as unknown as { settings: { update(p: unknown): Promise<void> } }).settings.update({ openMode: "tab" });
      s.plugin.topBar.callback();
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(h.openFloating).toHaveBeenCalledTimes(1);
    });

    it("choisir « Fenêtre flottante » dans le panneau est enregistré et change aussitôt l'ouverture", async () => {
      const openTab = await openTabMock();
      await startWith("");
      const panel = openPanel();
      const select = panel.openMode.querySelector<HTMLSelectElement>("select")!;
      select.value = "dialog";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      expect(h.saveData).toHaveBeenCalledWith("settings.json", expect.objectContaining({ openMode: "dialog" }));
      command("openSearch").callback!();
      await flush();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(openTab).not.toHaveBeenCalled();
      panel.close();
    });

    it("changer le mode ne perturbe pas l'indexation automatique (aucune synchronisation, minuterie intacte)", async () => {
      vi.useFakeTimers();
      h.loadData.mockResolvedValue("");
      const s = setup();
      s.plugin.onLayoutReady();
      await vi.advanceTimersByTimeAsync(3100);
      expect(h.start).toHaveBeenCalledTimes(1);
      await (s.plugin as unknown as { settings: { update(p: unknown): Promise<void> } }).settings.update({ openMode: "dialog" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(h.start).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it("un réglage invalide donne l'onglet, avec un avertissement dans le journal", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      await startWith({ openMode: "zzz" });
      command("openSearch").callback!();
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ouverture/i), undefined);
    });
  });

  describe("une seule fenêtre", () => {
    it("une deuxième ouverture ne crée pas de second dialogue : elle refocalise le champ", async () => {
      const openTab = await openTabMock();
      await startWith();
      command("openSearchFloating").callback!();
      command("openSearchFloating").callback!();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(h.mounts).toHaveLength(1);
      expect(h.mounts[0]!.focusInput).toHaveBeenCalledTimes(2); // focus initial + refocalisation de la 2e ouverture, exactement
      command("openSearch").callback!(); // mode onglet par défaut : ouvre un onglet, jamais un second dialogue, sans toucher au champ flottant
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(h.mounts[0]!.focusInput).toHaveBeenCalledTimes(2);
    });

    it("le dialogue monte la même vue que l'onglet, dans son conteneur, avec les mêmes dépendances (index partagé unique)", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      expect(h.mountDeps).toHaveLength(1);
      expect(h.sharedCreated).toBe(1);
      expect(deps().floating).toEqual({ onPdfOpened: expect.any(Function), onOpenInTab: expect.any(Function), onCloseRequest: expect.any(Function) });
      expect(h.mounts[0]!.host).toBe(h.floatingDialogs[0]!.container); // la vue est montée DANS le conteneur du dialogue
    });

    it("un onglet normal n'a ni mode flottant ni session", async () => {
      const s = await startWith();
      s.render();
      expect(deps().floating).toBeUndefined();
      expect(deps().session).toBeUndefined();
    });

    it("un onglet ET une fenêtre peuvent coexister : deux montages, un seul index partagé", async () => {
      const s = await startWith();
      s.render();
      command("openSearchFloating").callback!();
      expect(h.mounts).toHaveLength(2);
      expect(h.sharedCreated).toBe(1);
      s.plugin.onunload();
      expect(h.mounts.every((m) => m.dispose.mock.calls.length === 1)).toBe(true);
    });
  });

  describe("focusSearch", () => {
    it("fenêtre ouverte : focalise son champ, sans ouvrir ni onglet ni seconde fenêtre", async () => {
      const openTab = await openTabMock();
      await startWith();
      command("openSearchFloating").callback!();
      h.mounts[0]!.focusInput.mockClear();
      command("focusSearch").callback!();
      await flush();
      expect(h.mounts[0]!.focusInput).toHaveBeenCalledTimes(1);
      expect(openTab).not.toHaveBeenCalled();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
    });

    it("fenêtre fermée : comportement d'avant (ouvre/ramène l'onglet)", async () => {
      const openTab = await openTabMock();
      await startWith({ openMode: "dialog" });
      command("focusSearch").callback!();
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(h.openFloating).not.toHaveBeenCalled();
    });
  });

  describe("fermeture de la fenêtre", () => {
    it("ouvrir un PDF ferme la fenêtre SANS rendre le focus (focus: false)", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      deps().floating!.onPdfOpened();
      expect(dialog().closeCalls).toEqual([{ focus: false }]);
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
    });

    it("Échap sur un champ vide ferme la fenêtre en rendant le focus", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      deps().floating!.onCloseRequest();
      expect(dialog().closeCalls).toEqual([undefined]);
    });

    it("onunload détruit la fenêtre et libère sa vue ; plus rien ne s'ouvre ensuite", async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      s.plugin.onunload();
      expect(dialog().destroyed).toBe(true);
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
      command("openSearchFloating").callback!();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
    });

    it("onunload avec destruction différée de SiYuan : la vue est libérée tout de suite, une seule fois", async () => {
      h.floatingDeferred = true;
      const s = await startWith();
      command("openSearchFloating").callback!();
      s.plugin.onunload();
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
      dialog().destroy();
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("session et transfert vers un onglet (jeton dans custom.data, relu par init : indépendant de l'ordre)", () => {
    // SiYuan 3.8.9 (bundle main.c73ef160...js) : `openTab({ custom: { id, data } })` crée l'onglet ; son callback appelle
    // `plugin.models[id]({ tab, data: custom.data })` -> `new Custom({ ..., data })` dont le constructeur fait `this.data = data` puis
    // `this.init(this)` : `init` est appelé de façon SYNCHRONE pendant `openTab` quand l'onglet est créé tout de suite, et reçoit
    // `custom.data` dans `this.data`. `model.data` est aussi ce que la mise en page enregistre (`Object.assign({}, model.data)`).
    const sentData = async (index = -1): Promise<unknown> => {
      const { openTab } = await import("siyuan");
      return (vi.mocked(openTab).mock.calls.at(index)![0] as unknown as { custom: { data?: unknown } }).custom.data;
    };
    const openFloatingWithSession = async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      deps().session!.save(STATE);
      return s;
    };

    it("la session mémorisée par la fenêtre est restituée à la réouverture", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      expect(deps().session!.initial).toBeUndefined();
      deps().session!.save(STATE);
      deps().floating!.onCloseRequest();
      command("openSearchFloating").callback!();
      expect(deps().session!.initial).toEqual(STATE);
    });

    it("« Ouvrir dans un nouvel onglet » : ouvre un nouvel onglet avec un jeton dans custom.data, PUIS ferme la fenêtre ; init reçoit la session", async () => {
      const openTab = await openTabMock();
      let resolveOpen: () => void = () => undefined;
      openTab.mockImplementation((() => new Promise<void>((resolve) => (resolveOpen = resolve))) as never);
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTab).mock.calls[0]![0]).toMatchObject({ openNewTab: true, custom: { id: "docseekerdocseeker" } });
      const data = await sentData();
      expect(data).toEqual(expect.any(Object));
      expect(JSON.parse(JSON.stringify(data))).toEqual(data); // sérialisable : SiYuan l'enregistre dans la mise en page
      expect(dialog().closeCalls).toHaveLength(0); // pas fermée tant que l'onglet n'est pas ouvert
      s.render(undefined, data); // SiYuan crée l'onglet : init reçoit custom.data
      expect(deps().session!.initial).toEqual(STATE);
      expect(deps().floating).toBeUndefined(); // c'est bien un onglet, pas un second dialogue
      resolveOpen();
      await flush();
      expect(dialog().closeCalls).toEqual([{ focus: false }]);
    });

    it("init APRÈS la résolution d'openTab : la session n'est pas perdue (le jeton survit à la résolution)", async () => {
      const openTab = await openTabMock();
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      await flush(); // openTab est résolu, la fenêtre est fermée, init n'a pas encore été appelé
      expect(dialog().closeCalls).toEqual([{ focus: false }]);
      s.render(undefined, await sentData());
      expect(deps().session!.initial).toEqual(STATE);
      expect(deps().floating).toBeUndefined();
      expect(openTab).toHaveBeenCalledTimes(1);
    });

    it("le jeton n'est consommé que par UN onglet : un second init avec les mêmes données repart de zéro", async () => {
      await openTabMock();
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      s.render(undefined, data);
      s.render(undefined, data);
      expect(deps(-2).session!.initial).toEqual(STATE);
      expect(deps(-1).session).toBeUndefined();
    });

    it("init consomme le jeton et le retire de model.data (il ne reste pas dans la mise en page enregistrée par SiYuan)", async () => {
      await openTabMock();
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const model = s.render(undefined, await sentData());
      expect(model.data).toBeUndefined();
    });

    it("l'init d'un AUTRE onglet pendant l'attente ne vole pas la session : seul l'onglet portant le jeton la reçoit, quel que soit l'ordre", async () => {
      const openTab = await openTabMock();
      let resolveOpen: () => void = () => undefined;
      openTab.mockImplementation((() => new Promise<void>((resolve) => (resolveOpen = resolve))) as never);
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      s.render(); // un autre onglet (restauré, ou ouvert par l'utilisateur) : ni données ni session
      expect(deps().session).toBeUndefined();
      s.render(undefined, { autre: "donnée" }); // données étrangères : aucune session non plus
      expect(deps().session).toBeUndefined();
      s.render(undefined, data);
      expect(deps().session!.initial).toEqual(STATE);
      resolveOpen();
      await flush();
      s.render(); // et un onglet de plus après la résolution : rien
      expect(deps().session).toBeUndefined();
    });

    it("deux transferts successifs reçoivent chacun leur propre session (jetons distincts)", async () => {
      await openTabMock();
      const s = await startWith();
      command("openSearchFloating").callback!();
      deps().session!.save(STATE);
      deps().floating!.onOpenInTab();
      await flush();
      const first = await sentData();
      const other = { ...STATE, query: "chien" };
      command("openSearchFloating").callback!();
      deps().session!.save(other);
      deps().floating!.onOpenInTab();
      await flush();
      const second = await sentData();
      expect(second).not.toEqual(first);
      s.render(undefined, second);
      expect(deps().session!.initial).toEqual(other);
      s.render(undefined, first);
      expect(deps().session!.initial).toEqual(STATE);
    });

    it("double clic sur « Ouvrir dans un nouvel onglet » pendant le transfert : UN seul onglet, UNE seule fermeture", async () => {
      const openTab = await openTabMock();
      let resolveOpen: () => void = () => undefined;
      openTab.mockImplementation((() => new Promise<void>((resolve) => (resolveOpen = resolve))) as never);
      await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      deps().floating!.onOpenInTab();
      deps().floating!.onOpenInTab();
      expect(openTab).toHaveBeenCalledTimes(1);
      resolveOpen();
      await flush();
      expect(dialog().closeCalls).toHaveLength(1);
      expect(openTab).toHaveBeenCalledTimes(1);
    });

    it("transfert demandé alors que la fenêtre est déjà en cours de fermeture (destruction différée) : ignoré, aucun onglet", async () => {
      h.floatingDeferred = true;
      const openTab = await openTabMock();
      await openFloatingWithSession();
      const requestTransfer = deps().floating!.onOpenInTab;
      dialog().beginDestroy(); // Échap global : la fenêtre est condamnée
      requestTransfer();
      await flush();
      expect(openTab).not.toHaveBeenCalled();
    });

    it("l'ouverture de l'onglet échoue : la fenêtre RESTE ouverte, erreur VISIBLE (toast) et tracée, rien n'est transféré ensuite, un nouvel essai est possible", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockRejectedValue(new Error("openTab KO"));
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      await flush();
      expect(dialog().closeCalls).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "openTab KO" }));
      expect(h.showMessage).toHaveBeenCalledTimes(1);
      expect(h.showMessage).toHaveBeenCalledWith("Impossible d'ouvrir la recherche dans un onglet : la fenêtre reste ouverte", expect.any(Number), "error");
      expect(h.showMessage.mock.calls[0]![0]).not.toMatch(/[<>&]/);
      s.render(undefined, await sentData()); // le jeton a été nettoyé : un init tardif ne reçoit rien
      expect(deps().session).toBeUndefined();
      openTab.mockResolvedValue(undefined as never);
      deps(-2).floating!.onOpenInTab(); // le verrou est levé : on peut réessayer
      await flush();
      expect(openTab).toHaveBeenCalledTimes(2);
    });

    it("openTab qui lève de façon SYNCHRONE pendant le transfert : même traitement (fenêtre ouverte, toast, trace)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockImplementation((() => {
        throw new Error("sync KO");
      }) as never);
      await openFloatingWithSession();
      expect(() => deps().floating!.onOpenInTab()).not.toThrow();
      await flush();
      expect(dialog().closeCalls).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "sync KO" }));
      expect(h.showMessage).toHaveBeenCalledWith(expect.any(String), expect.any(Number), "error");
    });

    it("jamais consommé (openTab ne résout jamais) : au bout du délai, le jeton est nettoyé et l'incident tracé ; le verrou est levé", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/jamais|expir|non consomm/i), undefined);
      s.render(undefined, data);
      expect(deps().session).toBeUndefined(); // un init tardif ne reçoit rien
      expect(dialog().closeCalls).toHaveLength(0); // la fenêtre n'a jamais été fermée : openTab n'a jamais répondu
      const floatingDeps = h.mountDeps.find((d) => (d as FloatingDeps).floating) as unknown as FloatingDeps;
      floatingDeps.floating!.onOpenInTab(); // le verrou est levé : un nouvel essai part
      expect(openTab).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it("openTab résolu mais init jamais appelé : le jeton est nettoyé après le délai, avec une trace (pas de session fantôme)", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await openTabMock();
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/jamais|expir|non consomm/i), undefined);
      s.render(undefined, data);
      expect(deps().session).toBeUndefined();
      vi.useRealTimers();
    });

    it("jeton consommé à temps : aucune trace ni minuterie qui traîne", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await openTabMock();
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      s.render(undefined, await sentData());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it("sans session mémorisée (rien de soumis), le transfert ouvre un onglet vide sans jeton", async () => {
      await openTabMock();
      const s = await startWith();
      command("openSearchFloating").callback!();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      s.render(undefined, data);
      expect(deps().session).toBeUndefined();
    });

    it("le transfert ne rend pas le focus à l'élément ouvrant (l'onglet le prend)", async () => {
      await openTabMock();
      await startWith();
      command("openSearchFloating").callback!();
      deps().floating!.onOpenInTab();
      await flush();
      expect(dialog().closeCalls).toEqual([{ focus: false }]);
    });

    it("plugin déchargé pendant l'ouverture de l'onglet : aucune fermeture tardive, aucune erreur, jeton oublié", async () => {
      const openTab = await openTabMock();
      let release: () => void = () => undefined;
      openTab.mockImplementation((() => new Promise<void>((r) => (release = r))) as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const s = await openFloatingWithSession();
      deps().floating!.onOpenInTab();
      const data = await sentData();
      s.plugin.onunload();
      release();
      await flush();
      expect(warn).not.toHaveBeenCalled();
      expect(dialog().closeCalls).toHaveLength(1); // celle d'onunload seulement
      s.render(undefined, data); // init après le déchargement : rien ne se monte
      expect(h.mountDeps).toHaveLength(1);
    });

    it("transfert demandé après le déchargement : rien ne s'ouvre", async () => {
      const openTab = await openTabMock();
      const s = await openFloatingWithSession();
      const requestTransfer = deps().floating!.onOpenInTab;
      s.plugin.onunload();
      requestTransfer();
      await flush();
      expect(openTab).not.toHaveBeenCalled();
    });
  });

  describe("erreurs d'ouverture (visibles : toast d'erreur en plus du journal)", () => {
    const toasts = () => h.showMessage.mock.calls.map((c) => c as unknown[]);

    it("openSearchTab dont openTab échoue : tracé ET toast d'erreur (texte i18n sans < > &), jamais une promesse rejetée non gérée", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockRejectedValue(new Error("openTab <KO> & co"));
      await startWith();
      command("openSearchTab").callback!();
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "openTab <KO> & co" }));
      expect(toasts()).toEqual([["Impossible d'ouvrir l'onglet de recherche", expect.any(Number), "error"]]);
      expect(String(toasts()[0]![0])).not.toMatch(/[<>&]/); // le détail technique reste dans le journal
    });

    it("openTab qui lève de façon synchrone : tracé, toast, sans exception", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockImplementation((() => {
        throw new Error("sync KO");
      }) as never);
      await startWith();
      expect(() => command("openSearchTab").callback!()).not.toThrow();
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "sync KO" }));
      expect(toasts()).toHaveLength(1);
    });

    it("ouverture réussie d'un onglet : aucun toast", async () => {
      await openTabMock();
      await startWith();
      command("openSearchTab").callback!();
      await flush();
      expect(h.showMessage).not.toHaveBeenCalled();
    });

    it("la fenêtre flottante ne peut pas s'ouvrir (montage en échec) : tracé ET toast d'erreur", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await startWith();
      h.mountError = new Error("montage KO");
      command("openSearchFloating").callback!();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "montage KO" }));
      expect(toasts()).toEqual([["Impossible d'ouvrir la fenêtre de recherche", expect.any(Number), "error"]]);
    });

    it("showMessage qui lève : l'échec de la notification est tracé, jamais propagé", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      openTab.mockRejectedValue(new Error("openTab KO"));
      h.showMessage.mockImplementationOnce(() => {
        throw new Error("toast KO");
      });
      await startWith();
      command("openSearchTab").callback!();
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "toast KO" }));
    });

    it("un surlignage raté après la fermeture de la fenêtre : la vue reçoit un notify qui affiche un toast d'erreur", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      (h.mountDeps.at(-1) as unknown as { notify(message: string): void }).notify("Surlignage indisponible");
      expect(toasts()).toEqual([["Surlignage indisponible", expect.any(Number), "error"]]);
    });

    it("openSearchTab après le déchargement : rien ne s'ouvre, aucun toast", async () => {
      const openTab = await openTabMock();
      const s = await startWith();
      s.plugin.onunload();
      command("openSearchTab").callback!();
      await flush();
      expect(openTab).not.toHaveBeenCalled();
      expect(h.showMessage).not.toHaveBeenCalled();
    });
  });

  describe("réglage « Ouverture de la recherche » lu avant le clic (settings.ready)", () => {
    it("clic AVANT la fin de la lecture des réglages : l'ouverture attend, puis suit le réglage lu (« fenêtre flottante »), au lieu de prendre l'onglet par défaut", async () => {
      const openTab = await openTabMock();
      let resolveLoad: (value: unknown) => void = () => undefined;
      h.loadData.mockReturnValue(new Promise((r) => (resolveLoad = r)));
      setup();
      command("openSearch").callback!();
      await flush();
      expect(openTab).not.toHaveBeenCalled();
      expect(h.openFloating).not.toHaveBeenCalled();
      resolveLoad({ openMode: "dialog" });
      await flush();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      expect(openTab).not.toHaveBeenCalled();
    });

    it("lecture des réglages en échec : repli sur l'onglet, avec une trace", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      h.loadData.mockRejectedValue(new Error("lecture KO"));
      setup();
      command("openSearch").callback!();
      await flush();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(h.openFloating).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it("plugin déchargé pendant l'attente des réglages : rien ne s'ouvre", async () => {
      const openTab = await openTabMock();
      let resolveLoad: (value: unknown) => void = () => undefined;
      h.loadData.mockReturnValue(new Promise((r) => (resolveLoad = r)));
      const s = setup();
      command("openSearch").callback!();
      s.plugin.onunload();
      resolveLoad({ openMode: "dialog" });
      await flush();
      expect(openTab).not.toHaveBeenCalled();
      expect(h.openFloating).not.toHaveBeenCalled();
    });
  });

  describe("destruction lancée par SiYuan (Échap global, voile, croix) : commandes pendant le délai de destruction", () => {
    it("openSearchFloating pendant la destruction : la nouvelle fenêtre s'ouvre une fois l'ancienne détruite (l'action n'est pas perdue)", async () => {
      h.floatingDeferred = true;
      await startWith();
      command("openSearchFloating").callback!();
      dialog().beginDestroy();
      command("openSearchFloating").callback!();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
      dialog().destroy();
      expect(h.openFloating).toHaveBeenCalledTimes(2);
      expect(h.mounts).toHaveLength(2);
    });

    it("focusSearch pendant la destruction (aucun onglet) : la commande ne focalise pas le dialogue condamné, elle ouvre un onglet", async () => {
      h.floatingDeferred = true;
      const openTab = await openTabMock();
      await startWith();
      command("openSearchFloating").callback!();
      h.mounts[0]!.focusInput.mockClear();
      dialog().beginDestroy();
      command("focusSearch").callback!();
      await flush();
      expect(h.mounts[0]!.focusInput).not.toHaveBeenCalled();
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTab).mock.calls[0]![0]).toMatchObject({ openNewTab: true });
    });

    it("onglet ET fenêtre ouverts, fenêtre en cours de fermeture : focusSearch ramène l'ONGLET (openTab sans nouvel onglet) et focalise son champ", async () => {
      vi.useFakeTimers();
      h.floatingDeferred = true;
      const openTab = await openTabMock();
      const s = await startWith();
      s.render();
      command("openSearchFloating").callback!();
      h.mounts[0]!.focusInput.mockClear();
      h.mounts[1]!.focusInput.mockClear();
      dialog().beginDestroy();
      command("focusSearch").callback!();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.mounts[1]!.focusInput).not.toHaveBeenCalled(); // la fenêtre condamnée n'est pas touchée
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTab).mock.calls[0]![0]).not.toHaveProperty("openNewTab"); // SiYuan ramène l'onglet existant
      expect(h.mounts[0]!.focusInput).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("dialogue retiré par SiYuan sans destroyCallback : openSearchFloating ouvre une vraie nouvelle fenêtre", async () => {
      await startWith();
      command("openSearchFloating").callback!();
      dialog().vanish();
      command("openSearchFloating").callback!();
      expect(h.openFloating).toHaveBeenCalledTimes(2);
      expect(h.mounts).toHaveLength(2);
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
    });

    it("focusSearch, fenêtre ouverte mais focus refusé (focusInput faux alors que isOpen vrai) : avertissement, ni onglet ni seconde fenêtre", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const openTab = await openTabMock();
      await startWith();
      command("openSearchFloating").callback!();
      h.mounts[0]!.focusInput.mockReturnValue(false);
      command("focusSearch").callback!();
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Champ de recherche non focalisé"), undefined);
      expect(openTab).not.toHaveBeenCalled();
      expect(h.openFloating).toHaveBeenCalledTimes(1);
    });

    it("focusSearch, fenêtre ouverte dont focusInput lève : tracé, sans exception", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await startWith();
      command("openSearchFloating").callback!();
      h.mounts[0]!.focusInput.mockImplementation(() => {
        throw new Error("vue détruite");
      });
      expect(() => command("focusSearch").callback!()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("champ de recherche"), expect.objectContaining({ message: "vue détruite" }));
    });
  });

  describe("calque de surlignage de la fenêtre flottante : libéré par le plugin", () => {
    const overlay = () => ({ dispose: vi.fn() });

    it("le calque reçu à l'ouverture d'un PDF est gardé, puis libéré au déchargement du plugin", async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      const a = overlay();
      deps().floating!.onPdfOpened(a as never);
      expect(a.dispose).not.toHaveBeenCalled(); // pas libéré par la fermeture de la fenêtre : il appartient au visualiseur
      s.plugin.onunload();
      expect(a.dispose).toHaveBeenCalledTimes(1);
    });

    it("un nouveau calque remplace (et libère) le précédent ; seul le dernier est libéré au déchargement", async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      const a = overlay();
      deps().floating!.onPdfOpened(a as never);
      command("openSearchFloating").callback!();
      const b = overlay();
      deps().floating!.onPdfOpened(b as never);
      expect(a.dispose).toHaveBeenCalledTimes(1);
      expect(b.dispose).not.toHaveBeenCalled();
      s.plugin.onunload();
      expect(a.dispose).toHaveBeenCalledTimes(1);
      expect(b.dispose).toHaveBeenCalledTimes(1);
    });

    it("un dispose de calque qui lève au déchargement : tracé, le reste du déchargement s'exécute quand même", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const s = await startWith();
      s.render();
      command("openSearchFloating").callback!();
      deps().floating!.onPdfOpened({
        dispose: () => {
          throw new Error("calque KO");
        },
      });
      s.plugin.onunload();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "calque KO" }));
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1); // l'onglet a bien été libéré
    });

    it("calque reçu APRÈS le déchargement (ouverture de PDF terminée tard) : libéré tout de suite", async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      const onPdfOpened = deps().floating!.onPdfOpened;
      s.plugin.onunload();
      const late = overlay();
      onPdfOpened(late as never);
      expect(late.dispose).toHaveBeenCalledTimes(1);
    });

    it("le dernier calque n'est pas libéré deux fois (déchargement répété)", async () => {
      const s = await startWith();
      command("openSearchFloating").callback!();
      const a = overlay();
      deps().floating!.onPdfOpened(a as never);
      s.plugin.onunload();
      s.plugin.onunload();
      expect(a.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("robustesse du déchargement", () => {
    it("floating.dispose() qui lève : tracé, et la mise à zéro de la session, des onglets et de la barre a quand même lieu", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const s = await startWith();
      s.render();
      command("openSearchFloating").callback!();
      deps().session!.save(STATE);
      h.floatingDisposeError = new Error("dispose KO");
      expect(() => s.plugin.onunload()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "dispose KO" }));
      expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1); // l'onglet
      expect((s.plugin as unknown as { session: { get(): unknown } }).session.get()).toBeUndefined();
    });
  });
});
