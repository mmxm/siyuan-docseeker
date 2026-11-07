// @vitest-environment jsdom
// Intégration du dialogue « Spécifier le chemin » : barre RÉELLE, dialogue RÉEL (src/ui/pathDialog.ts), adaptateur RÉEL
// (src/siyuan/nativeUi.ts `openCustomDialog`) et faux Dialog de SiYuan fidèle (destruction différée, Échap global, voile,
// focus précédent rendu). Le noyau est simulé.
import { Dialog, Menu } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { openCustomDialog, openDialog, openMenu } from "../../../src/siyuan/nativeUi";
import type { PathKernel } from "../../../src/ui/pathDialog";
import { mountSearchToolbar, type SearchToolbar } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";

interface StubDialog {
  element: HTMLElement;
  destroyCount: number;
  destroyCalls: number;
}
const stubDialog = Dialog as unknown as { instances: StubDialog[]; stack: StubDialog[]; reset(): void; destroyDelayMs: number | undefined };
const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));
const NB = "20240101000000-aaaaaaa";
const DOC = "/20240102000000-0000001.sy";
const EVIL = "<img src=x onerror=alert(1)>";
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let kernel: { [K in keyof PathKernel]: ReturnType<typeof vi.fn> };
let toolbar: SearchToolbar;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  stubDialog.reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  kernel = {
    lsNotebooks: vi.fn(async () => [{ id: NB, name: EVIL, closed: false, icon: "" }]),
    listDocsByPath: vi.fn(async () => [{ path: DOC, name: EVIL, icon: "", subFileCount: 0 }]),
    searchDocs: vi.fn(async () => []),
    getHPathsByPaths: vi.fn(async () => [`${EVIL}/${EVIL}`]),
  };
  toolbar = mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    pathKernel: kernel as unknown as PathKernel,
    openCustomDialog,
    t,
    openMenu,
    openDialog,
    getGroupByDocument: () => true,
    setGroupByDocument: () => undefined,
    expansion: { canExpand: () => false, canCollapse: () => false, expandAll: () => undefined, collapseAll: () => undefined },
  });
});
afterEach(() => {
  toolbar.dispose();
  stubDialog.reset();
  vi.useRealTimers();
});

const pathBtn = () => host.querySelector<HTMLButtonElement>('button[aria-label="Spécifier le chemin"]')!;
const root = (): HTMLElement => stubDialog.instances.at(-1)!.element;
const body = (): HTMLElement => root().querySelector<HTMLElement>(".b3-dialog__body")!;
const row = (path: string): HTMLElement => body().querySelector<HTMLElement>(`li.b3-list-item[data-path="${path}"]`)!;
const confirmButton = (): HTMLElement => body().querySelector<HTMLElement>(".b3-button--text")!;
const open = async (): Promise<void> => {
  pathBtn().focus();
  pathBtn().click();
  await flush();
};
const escape = (): void => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
};

describe("dialogue du chemin avec l'adaptateur réel", () => {
  it("un vrai Dialog de 50vw x 70vh, data-key natif, titre échappé, champ de recherche focalisé", async () => {
    await open();
    const container = root().querySelector<HTMLElement>(".b3-dialog__container")!;
    expect(container.style.width).toBe("50vw");
    expect(container.style.height).toBe("70vh");
    expect(root().getAttribute("data-key")).toBe("dialog-movepathto");
    expect(root().querySelector(".b3-dialog__header")!.textContent).toBe("Spécifier le chemin");
    expect(document.activeElement).toBe(body().querySelector("input"));
  });

  it("noms de cahier et de document hostiles : du texte, aucune balise créée dans tout le dialogue", async () => {
    await open();
    row("/").querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
    expect(root().querySelector("img")).toBeNull();
    expect(root().innerHTML).not.toContain("<img");
    expect(row(DOC).querySelector(".b3-list-item__text")!.textContent).toBe(EVIL);
  });

  it("choisir un document puis Confirmer : portée appliquée une fois, dialogue détruit une fois, focus sur « Spécifier le chemin »", async () => {
    await open();
    row("/").querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
    row(DOC).querySelector<HTMLElement>(".b3-list-item__text")!.click();
    confirmButton().click();
    await flush();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(state.filters.scopes).toEqual([{ kind: "document", box: NB, docPath: DOC, label: `${EVIL}/${EVIL}` }]);
    expect(stubDialog.instances).toHaveLength(1);
    expect(stubDialog.instances[0]!.destroyCount).toBe(1);
    expect(root().isConnected).toBe(false);
    expect(document.activeElement).toBe(pathBtn());
    expect(host.querySelector(".search__path")!.firstChild!.textContent).toBe(`${EVIL}/${EVIL}`);
    expect(host.querySelector(".search__path img")).toBeNull();
  });

  it("Échap (gestionnaire global de SiYuan) : rien n'est appliqué, focus sur « Spécifier le chemin »", async () => {
    await open();
    escape();
    expect(setOptions).not.toHaveBeenCalled();
    expect(root().isConnected).toBe(false);
    expect(document.activeElement).toBe(pathBtn());
  });

  it("clic sur le voile : annule de la même façon", async () => {
    await open();
    root().querySelector<HTMLElement>(".b3-dialog__scrim")!.click();
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pathBtn());
  });

  it("Entrée dans le champ confirme (le cahier présélectionné)", async () => {
    await open();
    body().querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(state.filters.scopes).toEqual([{ kind: "notebook", box: NB, label: EVIL }]);
  });

  it("destruction différée (~190 ms) : un clic pendant le délai n'ouvre pas un second dialogue ; après, on peut rouvrir", async () => {
    vi.useFakeTimers();
    stubDialog.destroyDelayMs = 190;
    await open();
    escape();
    pathBtn().click();
    await flush();
    expect(stubDialog.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(document.activeElement).toBe(pathBtn());
    pathBtn().click();
    await flush();
    expect(stubDialog.instances).toHaveLength(2);
  });

  it("Confirmer pendant la lecture des libellés puis Échap : rien n'est appliqué", async () => {
    let release: (v: string[]) => void = () => undefined;
    kernel.getHPathsByPaths.mockReturnValueOnce(new Promise<string[]>((resolve) => (release = resolve)));
    await open();
    row("/").querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
    row(DOC).querySelector<HTMLElement>(".b3-list-item__text")!.click();
    confirmButton().click();
    escape();
    release(["X/Y"]);
    await flush();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("dispose de la barre : le dialogue est détruit (un seul destroy), rien n'est appliqué", async () => {
    await open();
    toolbar.dispose();
    expect(stubDialog.instances[0]!.destroyCount).toBe(1);
    expect(root().isConnected).toBe(false);
    expect(setOptions).not.toHaveBeenCalled();
  });
});
