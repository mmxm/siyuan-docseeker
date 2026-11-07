// @vitest-environment jsdom
// Critères enregistrés dans la barre : plus de bouton signet ; le menu « Plus » propose, comme la recherche native, « Enregistrer les
// critères de requête » et « Réinitialiser les critères » ; la barre signale à la ligne des critères que l'état a changé.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { mountSearchToolbar, type SearchToolbar, type SearchToolbarDeps } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { createNativeFakes, pick } from "./nativeFakes";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

let host: HTMLElement;
let state: SearchOptions;
let grouped: boolean;
let fakes: ReturnType<typeof createNativeFakes>;
let toolbar: SearchToolbar;

function mount(over: Partial<SearchToolbarDeps> = {}): SearchToolbar {
  return mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: (o) => {
      state = o;
    },
    t,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    getGroupByDocument: () => grouped,
    setGroupByDocument: (g) => {
      grouped = g;
    },
    expansion: { canExpand: () => false, canCollapse: () => false, expandAll: () => undefined, collapseAll: () => undefined },
    ...over,
  });
}
const moreBtn = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-label="Plus"]')!;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  fakes = createNativeFakes();
  state = { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS } };
  grouped = true;
});

describe("barre : plus de bouton « Critères enregistrés »", () => {
  it("aucun bouton signet, avec ou sans actions de critères", () => {
    toolbar = mount({ criteriaActions: { save: vi.fn(), reset: vi.fn() } });
    expect(host.querySelector('use[*|href="#iconBookmark"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Critères"]')).toBeNull();
    expect(host.querySelectorAll(".docseeker-icons button")).toHaveLength(4); // Plus, Filtres, Élargir, Réduire
  });
});

describe("menu « Plus » : commandes des critères", () => {
  it("sans actions : seulement Tri et Groupe", () => {
    toolbar = mount();
    moreBtn().click();
    expect(fakes.lastMenu().items.map((i) => i.label ?? "—")).toEqual(["Trier", "Regrouper"].map((l) => (DEFAULT_STRINGS[l === "Trier" ? "sortMenu" : "groupMenu"] ?? l)));
  });

  it("avec actions : séparateur puis les deux commandes natives, dans cet ordre", () => {
    toolbar = mount({ criteriaActions: { save: vi.fn(), reset: vi.fn() } });
    moreBtn().click();
    const items = fakes.lastMenu().items;
    expect(items.map((i) => (i.separator ? "—" : i.label))).toEqual([
      t("sortMenu"),
      t("groupMenu"),
      "—",
      "Enregistrer les critères",
      "Réinitialiser les critères",
    ]);
  });

  it("choisir « Enregistrer… » appelle save, « Réinitialiser… » appelle reset", () => {
    const save = vi.fn();
    const reset = vi.fn();
    toolbar = mount({ criteriaActions: { save, reset } });
    moreBtn().click();
    pick(fakes.lastMenu(), "Enregistrer les critères");
    expect(save).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    moreBtn().click();
    pick(fakes.lastMenu(), "Réinitialiser les critères");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("après dispose, un clic tardif sur la commande n'appelle rien", () => {
    const save = vi.fn();
    toolbar = mount({ criteriaActions: { save, reset: vi.fn() } });
    moreBtn().click();
    const menu = fakes.lastMenu();
    toolbar.dispose();
    const item = menu.items.find((i) => i.label === "Enregistrer les critères")!;
    item.click!();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("onStateChange : la ligne des critères suit la barre", () => {
  it("appelé au montage, à refresh, et après un changement d'options ou de regroupement fait depuis la barre", () => {
    const onStateChange = vi.fn();
    toolbar = mount({ onStateChange });
    const base = onStateChange.mock.calls.length;
    expect(base).toBeGreaterThan(0);
    toolbar.refresh();
    expect(onStateChange.mock.calls.length).toBe(base + 1);
    moreBtn().click();
    pick(fakes.lastMenu(), t("sortMenu"), t("sortNameAsc"));
    expect(onStateChange.mock.calls.length).toBe(base + 2);
    moreBtn().click();
    pick(fakes.lastMenu(), t("groupMenu"), t("groupNone"));
    expect(onStateChange.mock.calls.length).toBe(base + 3);
  });

  it("jamais appelé après dispose", () => {
    const onStateChange = vi.fn();
    toolbar = mount({ onStateChange });
    toolbar.dispose();
    onStateChange.mockClear();
    toolbar.refresh();
    expect(onStateChange).not.toHaveBeenCalled();
  });
});
