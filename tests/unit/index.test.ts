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
  mounts: [] as { dispose: ReturnType<typeof vi.fn>; onWarn: (m: string, e?: unknown) => void }[],
}));

vi.mock("siyuan", () => ({
  Plugin: class {
    name = "docseeker";
    app = {};
    i18n: Record<string, string> = {};
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
}));
vi.mock("../../src/siyuan/kernelApi", () => ({ createKernelApi: () => ({}) }));
vi.mock("../../src/siyuan/petalStore", () => ({ createPetalStore: () => ({}) }));
vi.mock("../../src/siyuan/discovery", () => ({ discoverPdfs: vi.fn() }));
vi.mock("../../src/indexer/loadPdf", () => ({ createLoadPdf: () => vi.fn() }));
vi.mock("../../src/indexer/indexer", () => ({
  createIndexer: () => ({
    start: h.start,
    cancel: h.cancel,
    onEvent: (l: (e: unknown) => void) => {
      h.listener = l;
      return h.unsubscribe;
    },
  }),
}));
vi.mock("../../src/search/sharedIndex", () => ({
  createSharedIndex: () => {
    h.sharedCreated++;
    return { start: h.sharedStart, dispose: h.sharedDispose };
  },
}));
vi.mock("../../src/searchTab", async (orig) => {
  const actual = await orig<typeof import("../../src/searchTab")>();
  return {
    ...actual,
    mountSearchTab: (_host: HTMLElement, deps: { onWarn: (m: string, e?: unknown) => void }) => {
      const m = { dispose: vi.fn(), onWarn: deps.onWarn };
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
});

describe("DocSeekerPlugin", () => {
  it("détruire un onglet ne libère pas les autres", () => {
    const s = setup();
    const a = s.render();
    s.render();
    s.destroy(a);
    expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.mounts[1]!.dispose).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    s.destroy(a);
    expect(h.mounts[0]!.dispose).toHaveBeenCalledTimes(1);
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

  it("signale visiblement un échec de indexer.start()", async () => {
    h.start.mockRejectedValue(new Error("noyau KO"));
    const s = setup();
    const tab = s.render();
    const button = tab.element.querySelector<HTMLButtonElement>("button.docseeker-index")!;
    button.click();
    await flush();
    expect(h.showMessage).toHaveBeenCalledWith(expect.stringContaining("noyau KO"), expect.any(Number), "error");
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("utilise aria-disabled plutôt que disabled et ignore les clics pendant l'exécution", async () => {
    let finish: () => void = () => undefined;
    h.start.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const s = setup();
    const tab = s.render();
    const button = tab.element.querySelector<HTMLButtonElement>("button.docseeker-index")!;
    button.click();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    button.click();
    expect(h.start).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("rend les zones de statut accessibles et le résumé focusable", () => {
    const s = setup();
    const tab = s.render();
    expect(tab.element.querySelector("summary")!.classList.contains("docseeker-summary")).toBe(true);
    expect(tab.element.querySelectorAll('[role="status"]').length).toBeGreaterThanOrEqual(2);
  });

  it("affiche un journal borné des avertissements dans la section Avancé", () => {
    const s = setup();
    const tab = s.render();
    for (let i = 0; i < 60; i++) h.mounts[0]!.onWarn(`avert ${i}`);
    const log = tab.element.querySelector<HTMLElement>(".docseeker-log")!;
    expect(log.textContent).toContain("avert 59");
    expect(log.textContent).not.toContain("avert 5\n");
    expect(log.textContent!.trim().split("\n")).toHaveLength(50);
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
