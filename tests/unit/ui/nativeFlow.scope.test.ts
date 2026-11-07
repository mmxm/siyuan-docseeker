// @vitest-environment jsdom
// Intégration du menu « Spécifier le chemin » avec l'arbre des documents : barre RÉELLE, adaptateur RÉEL (src/siyuan/nativeUi.ts)
// et faux Menu de SiYuan fidèle (libellés insérés en innerHTML, closeCB avant le vidage, bascule sur le même identifiant).
import { Menu } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocTree } from "../../../src/search/docTree";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { IndexUnavailableError } from "../../../src/siyuan/kernelApi";
import { openDialog, openMenu } from "../../../src/siyuan/nativeUi";
import { mountSearchToolbar, type SearchToolbar } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";

interface StubMenu {
  opened: boolean;
  element: HTMLElement;
}
const stubMenu = Menu as unknown as { current: StubMenu | undefined; reset(): void };
const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));
const NB = "20240101000000-aaaaaaa";
const EVIL = "<img src=x onerror=alert(1)>";
const TREE: DocTree = [
  { kind: "notebook", box: NB, hpath: "", label: EVIL, depth: 0 },
  { kind: "document", box: NB, docPath: "/20240102000000-0000001.sy", hpath: `/${EVIL}`, label: EVIL, depth: 1 },
];
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let getDocTree: ReturnType<typeof vi.fn>;
let toolbar: SearchToolbar;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  stubMenu.reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  getDocTree = vi.fn(async () => TREE);
  toolbar = mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    getFolders: () => [],
    getDocTree: getDocTree as unknown as (signal?: AbortSignal) => Promise<DocTree>,
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
  stubMenu.reset();
});

const pathBtn = () => host.querySelector<HTMLButtonElement>("button[data-menu='true']")!;
const current = (): StubMenu | undefined => stubMenu.current;
const labelOf = (item: Element | null): string | null => item?.querySelector(":scope > .b3-menu__label")?.textContent ?? null;
const itemByLabel = (text: string): HTMLElement => {
  const found = [...current()!.element.querySelectorAll<HTMLElement>(".b3-menu__item")].find((b) => labelOf(b) === text);
  if (!found) throw new Error(`item de menu introuvable : ${text}`);
  return found;
};

describe("menu des documents avec l'adaptateur réel", () => {
  it("le titre d'un document contenant du HTML est affiché comme texte : aucune balise créée dans le menu", async () => {
    pathBtn().focus();
    pathBtn().click();
    await flush();
    const menu = current()!.element;
    expect(labelOf(itemByLabel(EVIL))).toBe(EVIL);
    expect(menu.querySelector("img")).toBeNull();
    expect(menu.innerHTML).not.toContain("<img");
  });

  it("choisir un document ferme le menu et rend le focus à « Spécifier le chemin »", async () => {
    pathBtn().focus();
    pathBtn().click();
    await flush();
    itemByLabel(`  ${EVIL}`).click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(state.filters.scope).toMatchObject({ kind: "document", label: `${EVIL} / ${EVIL}` });
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(pathBtn());
  });

  it("un second clic sur le bouton referme le menu ouvert (bascule), sans relire l'arbre", async () => {
    pathBtn().focus();
    pathBtn().click();
    await flush();
    expect(current()).toBeDefined();
    pathBtn().click();
    await flush();
    expect(current()).toBeUndefined();
    expect(getDocTree).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(pathBtn());
  });

  it("« Réessayer » : le menu se ferme, le focus est rendu au bouton, puis un nouveau menu s'ouvre avec l'arbre relu", async () => {
    getDocTree.mockRejectedValueOnce(new IndexUnavailableError(200, -1, "document metadata is not ready"));
    pathBtn().focus();
    pathBtn().click();
    await flush();
    expect(labelOf(itemByLabel("Réessayer"))).toBe("Réessayer");
    itemByLabel("Réessayer").click();
    await flush();
    expect(getDocTree).toHaveBeenCalledTimes(2);
    expect(current()).toBeDefined();
    expect(labelOf(itemByLabel(EVIL))).toBe(EVIL);
    // Fermer ce second menu (bascule) rend bien le focus au bouton.
    pathBtn().click();
    await flush();
    expect(document.activeElement).toBe(pathBtn());
  });
});
