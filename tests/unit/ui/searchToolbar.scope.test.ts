// @vitest-environment jsdom
// Barre d'icônes : bouton « Spécifier le chemin » (dialogue natif), étiquette du chemin, croix, bouton « Inclure les documents
// enfants » et interaction avec le dialogue « Filtres ».
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { mountSearchToolbar, type SearchToolbar, type SearchToolbarDeps } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import type { PathKernel } from "../../../src/ui/pathDialog";
import { createNativeFakes } from "./nativeFakes";
import { simulateTooltip } from "../helpers/tooltip";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

const XLINK = "http://www.w3.org/1999/xlink";
const NB = "20240101000000-aaaaaaa";
const NB2 = "20240101000000-bbbbbbb";
const id = (n: number): string => `20240102000000-${n.toString(36).padStart(7, "0")}`;
const PATH = "Spécifier le chemin";
const INCLUDE = "Inclure les documents enfants";
const REMOVE = "Supprimer";
const DOC_PATH = `/${id(1)}/${id(2)}.sy`;
const DOC_SCOPE: DocumentScope = { kind: "document", box: NB, docPath: DOC_PATH, label: "Cahier A/Parent/Enfant" };
const NB_SCOPE: DocumentScope = { kind: "notebook", box: NB2, label: "Cahier B" };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let fakes: ReturnType<typeof createNativeFakes>;
let toolbar: SearchToolbar;
let onWarn: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let kernel: { [K in keyof PathKernel]: ReturnType<typeof vi.fn> };

function mount(over: Partial<SearchToolbarDeps> = {}, omit: readonly ("pathKernel" | "openCustomDialog")[] = []): SearchToolbar {
  const path: Partial<SearchToolbarDeps> = {
    ...(omit.includes("pathKernel") ? {} : { pathKernel: kernel as unknown as PathKernel }),
    ...(omit.includes("openCustomDialog") ? {} : { openCustomDialog: fakes.openCustomDialog }),
  };
  return mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    ...path,
    onWarn: onWarn as unknown as NonNullable<SearchToolbarDeps["onWarn"]>,
    notify: notify as unknown as NonNullable<SearchToolbarDeps["notify"]>,
    t,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    getGroupByDocument: () => true,
    setGroupByDocument: () => undefined,
    expansion: { canExpand: () => false, canCollapse: () => false, expandAll: () => undefined, collapseAll: () => undefined },
    ...over,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  onWarn = vi.fn();
  notify = vi.fn();
  fakes = createNativeFakes();
  kernel = {
    lsNotebooks: vi.fn(async () => [
      { id: NB, name: "Cahier A", closed: false, icon: "" },
      { id: NB2, name: "Cahier B", closed: false, icon: "" },
    ]),
    listDocsByPath: vi.fn(async () => [{ path: DOC_PATH, name: "Enfant", icon: "", subFileCount: 0 }]),
    searchDocs: vi.fn(async () => []),
    getHPathsByPaths: vi.fn(async (paths: readonly string[]) => paths.map(() => "Cahier A/Parent/Enfant")),
  };
  toolbar = mount();
});

const row = () => host.querySelector<HTMLElement>("div.block__icons.docseeker-icons")!;
const btn = (name: string): HTMLButtonElement => row().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const pathBtn = () => btn(PATH);
const label = () => row().querySelector<HTMLElement>("span.search__path")!;
const cross = () => label().querySelector<SVGElement>("svg.search__rmpath")!;
const lastFilters = () => (setOptions.mock.calls.at(-1)![0] as SearchOptions).filters;
const withScopes = (scopes: DocumentScope[], extra: Partial<SearchOptions["filters"]> = {}): void => {
  state = { ...state, filters: { ...NO_FILTERS, scopes, ...extra } };
  toolbar.refresh();
};
const dialogBody = () => fakes.lastCustomDialog().container;
const dialogButton = (cls: string) => dialogBody().querySelector<HTMLElement>(`.${cls}`)!;
const filtersBtn = () => row().querySelector<HTMLButtonElement>('button[aria-label^="Filtres"]')!;

describe("bouton « Spécifier le chemin » : dialogue natif", () => {
  it("ouvre le dialogue « Spécifier le chemin » (aucun menu), 50vw x 70vh", async () => {
    pathBtn().click();
    await flush();
    expect(fakes.openMenu).not.toHaveBeenCalled();
    const { options } = fakes.lastCustomDialog();
    expect(options.title).toBe("Spécifier le chemin");
    expect([options.width, options.height, options.dataKey]).toEqual(["50vw", "70vh", "dialog-movepathto"]);
    expect(kernel.lsNotebooks).toHaveBeenCalledTimes(1);
  });

  it("le bouton garde son rôle de bouton à icône dossier, sans data-menu", () => {
    expect(pathBtn().getAttribute("data-menu")).toBeNull();
    expect(pathBtn().querySelector("use")!.getAttributeNS(XLINK, "href")).toBe("#iconFolder");
  });

  it("un seul dialogue à la fois : un second clic n'en ouvre pas un autre", async () => {
    pathBtn().click();
    pathBtn().click();
    await flush();
    expect(fakes.openCustomDialog).toHaveBeenCalledTimes(1);
  });

  it("une fois le dialogue fermé, le bouton peut le rouvrir et reçoit le focus", async () => {
    pathBtn().click();
    await flush();
    fakes.lastCustomDialog().destroy();
    expect(document.activeElement).toBe(pathBtn());
    pathBtn().click();
    expect(fakes.openCustomDialog).toHaveBeenCalledTimes(2);
  });

  it("Confirmer sur le cahier présélectionné : portée « cahier », tri et autres filtres conservés, une seule application", async () => {
    state = { ...state, filters: { ...NO_FILTERS, nameContains: "x", minPages: 3 } };
    pathBtn().click();
    await flush();
    dialogButton("b3-button--text").click();
    await flush();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions.mock.calls[0]![0]).toEqual({
      sort: { key: "name", direction: "asc" },
      filters: { ...NO_FILTERS, nameContains: "x", minPages: 3, scopes: [{ kind: "notebook", box: NB, label: "Cahier A" }] },
    });
    expect(fakes.lastCustomDialog().handle.isOpen()).toBe(false);
  });

  it("un document choisi : label complet du noyau, includeSubfolders conservé", async () => {
    state = { ...state, filters: { ...NO_FILTERS, includeSubfolders: false } };
    pathBtn().click();
    await flush();
    dialogBody().querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
    dialogBody().querySelector<HTMLElement>(`li[data-path="${DOC_PATH}"] .b3-list-item__text`)!.click();
    dialogButton("b3-button--text").click();
    await flush();
    expect(lastFilters().scopes).toEqual([{ kind: "document", box: NB, docPath: DOC_PATH, label: "Cahier A/Parent/Enfant" }]);
    expect(lastFilters().includeSubfolders).toBe(false);
  });

  it("seulement des cahiers choisis : l'indicateur n'est pas forcé (comme le natif), le bouton reste désactivé et sans effet", async () => {
    state = { ...state, filters: { ...NO_FILTERS, includeSubfolders: false } };
    pathBtn().click();
    await flush();
    dialogButton("b3-button--text").click();
    await flush();
    expect(lastFilters().includeSubfolders).toBe(false);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
    expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("false");
  });

  it("Annuler : rien n'est appliqué", async () => {
    pathBtn().click();
    await flush();
    dialogButton("b3-button--cancel").click();
    await flush();
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pathBtn());
  });

  it("dispose ferme le dialogue sans rien appliquer ni rendre le focus", async () => {
    pathBtn().click();
    await flush();
    toolbar.dispose();
    expect(fakes.lastCustomDialog().handle.isOpen()).toBe(false);
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("lecture des cahiers en échec : trace via onWarn du dialogue", async () => {
    kernel.lsNotebooks.mockRejectedValueOnce(new Error("noyau"));
    pathBtn().click();
    await flush();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(dialogBody().textContent).toContain("Impossible de lire les documents");
  });

  it("une erreur à l'ouverture du dialogue est tracée, jamais propagée au clic", () => {
    fakes.openCustomDialog.mockImplementationOnce(() => {
      throw new Error("Dialog indisponible");
    });
    expect(() => pathBtn().click()).not.toThrow();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]![0])).toContain("Spécifier le chemin");
    // L'utilisateur est prévenu (message bref), pas seulement le journal.
    expect(notify).toHaveBeenCalledWith("Impossible d'ouvrir le choix du chemin (voir le journal dans les paramètres).");
    pathBtn().click(); // et le bouton reste utilisable
    expect(fakes.openCustomDialog).toHaveBeenCalledTimes(2);
  });

  it("sans noyau ou sans dialogue libre : ni « Spécifier le chemin » ni « Inclure les documents enfants »", () => {
    for (const omit of [["pathKernel"], ["openCustomDialog"]] as const) {
      document.body.innerHTML = "";
      host = document.createElement("div");
      document.body.appendChild(host);
      mount({}, omit);
      expect(host.querySelector(`button[aria-label="${PATH}"]`)).toBeNull();
      expect(host.querySelector(`button[aria-label="${INCLUDE}"]`)).toBeNull();
    }
  });
});

describe("étiquette du chemin (comme le natif), croix et bouton « Inclure les documents enfants »", () => {
  it("sans chemin : étiquette et croix masquées", () => {
    expect(label().hidden).toBe(true);
    expect(label().nextElementSibling?.className).toBe("fn__space");
    expect((label().nextElementSibling as HTMLElement).hidden).toBe(true);
  });

  it("DOM natif : span.search__path ariaLabel, texte = libellés, aria-label = libellés joints par une espace, croix SVG, puis fn__space", () => {
    withScopes([NB_SCOPE, DOC_SCOPE]);
    expect(label().className).toBe("search__path ft__on-surface fn__flex-center ft__smaller fn__ellipsis ariaLabel");
    expect(label().hidden).toBe(false);
    expect(label().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(label().firstChild?.textContent).toBe("Cahier B Cahier A/Parent/Enfant");
    expect(label().getAttribute("aria-label")).toBe("Cahier B Cahier A/Parent/Enfant");
    expect(cross().parentElement).toBe(label());
    expect(cross().querySelector("use")!.getAttributeNS(XLINK, "href")).toBe("#iconCloseRound");
    const space = label().nextElementSibling as HTMLElement;
    expect([space.tagName, space.className, space.hidden]).toEqual(["SPAN", "fn__space", false]);
  });

  it("une étiquette avec des balises reste du texte", () => {
    withScopes([{ ...NB_SCOPE, label: "<img src=x onerror=alert(1)>" }]);
    expect(label().querySelector("img")).toBeNull();
    expect(label().firstChild?.textContent).toBe("<img src=x onerror=alert(1)>");
    // L'infobulle de SiYuan insère aria-label comme HTML : la valeur est échappée, et l'infobulle reste lisible.
    expect(label().getAttribute("aria-label")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    const shown = simulateTooltip(label());
    expect(shown.querySelector("img")).toBeNull();
    expect(shown.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("infobulle : aucun élément créé par un nom de document, de cahier ou une apostrophe/guillemet/esperluette", () => {
    withScopes([{ ...NB_SCOPE, label: `<b id="x">A</b> & "B" 'C'` }, { ...DOC_SCOPE, label: "<img src=x onerror=alert(1)>/Doc" }]);
    const shown = simulateTooltip(label());
    expect(shown.children).toHaveLength(0);
    expect(shown.textContent).toBe(`<b id="x">A</b> & "B" 'C' <img src=x onerror=alert(1)>/Doc`);
  });

  it("infobulle « PDF exclus » seulement quand un document est choisi", () => {
    withScopes([DOC_SCOPE]);
    expect(label().title).toBe("Les PDF qu'aucun document ne cite sont exclus.");
    withScopes([NB_SCOPE]);
    expect(label().hasAttribute("title")).toBe(false);
  });

  it("la croix retire les portées (clé absente) et le focus revient à « Spécifier le chemin »", () => {
    withScopes([DOC_SCOPE, NB_SCOPE], { includeSubfolders: false });
    cross().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters()).toEqual({ ...NO_FILTERS, includeSubfolders: false });
    expect("scopes" in lastFilters()).toBe(false);
    expect(label().hidden).toBe(true);
    expect(document.activeElement).toBe(pathBtn());
  });

  it("croix : sans bouton « Spécifier le chemin » dans la rangée, le focus se replie sur un autre élément focalisable", () => {
    withScopes([DOC_SCOPE]);
    pathBtn().remove();
    cross().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setOptions).toHaveBeenCalledTimes(1);
    const active = document.activeElement as HTMLElement;
    expect(active).not.toBe(document.body);
    expect(row().contains(active)).toBe(true);
  });

  it("la croix est accessible au clavier (focalisable, Entrée et Espace)", () => {
    withScopes([DOC_SCOPE]);
    expect(cross().getAttribute("tabindex")).toBe("0");
    expect(cross().getAttribute("role")).toBe("button");
    expect(cross().getAttribute("aria-label")).toBe(REMOVE);
    cross().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(setOptions).not.toHaveBeenCalled();
    cross().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(setOptions).toHaveBeenCalledTimes(1);
    withScopes([DOC_SCOPE]);
    cross().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(setOptions).toHaveBeenCalledTimes(2);
  });

  it("« Inclure » : désactivé sans chemin, désactivé si tous les chemins sont des cahiers", () => {
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
    withScopes([NB_SCOPE]);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
    expect(btn(INCLUDE).querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
    btn(INCLUDE).click();
    expect(setOptions).not.toHaveBeenCalled();
    withScopes([NB_SCOPE, { ...NB_SCOPE, box: NB, label: "A" }]);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
  });

  it("« Inclure » : actif et ft__primary dès qu'un document est choisi (enfants inclus par défaut), et bascule", () => {
    withScopes([DOC_SCOPE]);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
    expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("true");
    expect(btn(INCLUDE).querySelector("svg")!.classList.contains("ft__primary")).toBe(true);
    btn(INCLUDE).click();
    expect(lastFilters()).toMatchObject({ scopes: [DOC_SCOPE], includeSubfolders: false });
    expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("false");
    expect(btn(INCLUDE).querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
  });

  it("« Inclure » : actif aussi avec un mélange cahier + document", () => {
    withScopes([NB_SCOPE, DOC_SCOPE]);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
  });

  it("une portée compte comme un filtre actif (une seule fois pour une liste)", () => {
    withScopes([NB_SCOPE, DOC_SCOPE]);
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres (1 actif)");
  });
});

describe("dialogue « Filtres » et réinitialisation avec une portée", () => {
  const confirmFilters = (): void => {
    filtersBtn().click();
    fakes.lastDialog().confirm();
  };

  it("Confirmer conserve la liste de portées", () => {
    withScopes([NB_SCOPE, DOC_SCOPE]);
    confirmFilters();
    expect(lastFilters().scopes).toEqual([NB_SCOPE, DOC_SCOPE]);
  });

  it("« Réinitialiser les filtres » puis Confirmer retire la portée", () => {
    withScopes([DOC_SCOPE]);
    filtersBtn().click();
    const dialog = fakes.lastDialog();
    const reset = [...dialog.container.querySelectorAll("button")].find((b) => b.textContent === "Réinitialiser les filtres")!;
    expect(reset.getAttribute("aria-disabled")).toBe("false");
    reset.click();
    dialog.confirm();
    expect("scopes" in lastFilters()).toBe(false);
  });

  it("toolbar.reset() efface aussi la portée", () => {
    withScopes([DOC_SCOPE]);
    toolbar.reset();
    expect(setOptions.mock.calls.at(-1)![0]).toEqual({ sort: state.sort, filters: NO_FILTERS });
  });
});
