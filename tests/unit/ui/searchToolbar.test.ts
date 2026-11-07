// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MIN_PAGE_BOUND, NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { formatLocalDate, mountSearchToolbar, parseLocalDate, type SearchToolbar, type SearchToolbarDeps } from "../../../src/ui/searchToolbar";
import { createNativeFakes, findItem, pick } from "./nativeFakes";

const XLINK = "http://www.w3.org/1999/xlink";
const SVG_NS = "http://www.w3.org/2000/svg";
const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

// Dates de test : « YYYY-MM-DD » <-> UTC, indépendant du fuseau.
const parseDate = (v: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? undefined : ms;
};
const formatDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const INCLUDE = "Inclure les documents enfants";
const PATH = "Spécifier le chemin";
const MORE = "Plus";
const EXPAND = "Élargir";
const COLLAPSE = "Réduire";
const REMOVE = "Supprimer";

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let folders: string[];
let group: boolean;
let setGroup: ReturnType<typeof vi.fn>;
let expansion: {
  canExpand: Mock<() => boolean>;
  canCollapse: Mock<() => boolean>;
  expandAll: Mock<() => void>;
  collapseAll: Mock<() => void>;
};
let fakes: ReturnType<typeof createNativeFakes>;
let toolbar: SearchToolbar;

function mount(over: Partial<SearchToolbarDeps> = {}, where: HTMLElement = host): SearchToolbar {
  return mountSearchToolbar(where, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    getFolders: () => folders,
    t,
    parseDate,
    formatDate,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    getGroupByDocument: () => group,
    setGroupByDocument: setGroup as (v: boolean) => void,
    expansion,
    ...over,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  folders = ["assets/", "assets/a/", "assets/a/sub/", "assets/b/"];
  group = true;
  setGroup = vi.fn((v: boolean) => {
    group = v;
  });
  expansion = { canExpand: vi.fn(() => true), canCollapse: vi.fn(() => false), expandAll: vi.fn(() => undefined), collapseAll: vi.fn(() => undefined) };
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  fakes = createNativeFakes();
  toolbar = mount();
});

const row = () => host.querySelector<HTMLElement>("div.block__icons.docseeker-icons")!;
const btn = (name: string): HTMLButtonElement => {
  const b = row().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!b) throw new Error(`bouton introuvable : ${name}`);
  return b;
};
const buttons = () => Array.from(row().querySelectorAll<HTMLButtonElement>("button"));
const visibleNames = () => buttons().filter((b) => !b.hidden).map((b) => b.getAttribute("aria-label"));
const useHref = (b: Element) => b.querySelector("use")!.getAttributeNS(XLINK, "href");
const filtersBtn = () => row().querySelector<HTMLButtonElement>('button[aria-label^="Filtres"]')!;
const lastFilters = () => (setOptions.mock.calls.at(-1)![0] as SearchOptions).filters;
const withFolder = (folder: string, extra: Partial<SearchOptions["filters"]> = {}): void => {
  state = { ...state, filters: { ...NO_FILTERS, folder, ...extra } };
  toolbar.refresh();
};

describe("structure : la rangée d'icônes native", () => {
  it("une seule rangée div.block__icons.docseeker-icons dans l'hôte", () => {
    expect(host.querySelectorAll(".block__icons")).toHaveLength(1);
    expect(row().parentElement).toBe(host);
  });

  it("ni details, ni select, ni case à cocher, ni summary, ni région live, ni texte masqué", () => {
    expect(host.querySelector("details, summary, select, input, [aria-live], [role=status], [role=alert], .sr-only")).toBeNull();
  });

  it("chaque bouton est un vrai <button type=button> de classes natives, avec infobulle = nom accessible et data-position", () => {
    for (const b of buttons()) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.type).toBe("button");
      expect(b.classList.contains("block__icon")).toBe(true);
      expect(b.classList.contains("block__icon--show")).toBe(true);
      expect(b.classList.contains("ariaLabel")).toBe(true);
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("data-position")).toBe("9south");
      expect(b.hasAttribute("title")).toBe(false); // l'infobulle est celle de SiYuan (aria-label), pas un doublon natif
    }
  });

  it.each([
    [INCLUDE, "#iconInclude"],
    [PATH, "#iconFolder"],
    [MORE, "#iconMore"],
    ["Filtres", "#iconFilter"],
    [EXPAND, "#iconExpand"],
    [COLLAPSE, "#iconContract"],
  ])("« %s » : svg > use avec xlink:href exact %s, créé dans l'espace de noms SVG", (name, href) => {
    const b = btn(name);
    const svgs = b.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0]!.namespaceURI).toBe(SVG_NS);
    const use = b.querySelector("use")!;
    expect(use.namespaceURI).toBe(SVG_NS);
    expect(useHref(b)).toBe(href);
    expect(b.textContent).toBe(""); // icône seule
  });

  it("ordre de tabulation (sans chemin) : Inclure, Spécifier, Plus, Filtres, Élargir, Réduire", () => {
    expect(visibleNames()).toEqual([INCLUDE, PATH, MORE, "Filtres", EXPAND, COLLAPSE]);
    expect(buttons().every((b) => b.tabIndex === 0)).toBe(true);
  });

  it("avec un chemin : la croix « Supprimer » vient en premier, avant « Inclure... »", () => {
    withFolder("assets/a/");
    expect(visibleNames()).toEqual([REMOVE, INCLUDE, PATH, MORE, "Filtres (1 actif)", EXPAND, COLLAPSE]);
  });

  it("séparateurs natifs span.fn__space entre les groupes d'icônes", () => {
    expect(row().querySelectorAll("span.fn__space").length).toBeGreaterThanOrEqual(1);
  });

  it("n'écrit jamais innerHTML (montage, clics, dialogue, rafraîchissement)", () => {
    const setter = vi.spyOn(Element.prototype, "innerHTML", "set");
    const other = document.createElement("div");
    document.body.appendChild(other);
    const bar = mount({}, other);
    bar.refresh();
    bar.reset();
    bar.setCounter("<b>3</b>");
    other.querySelector<HTMLButtonElement>('button[aria-label="Filtres"]')!.click();
    other.querySelector<HTMLButtonElement>(`button[aria-label="${PATH}"]`)!.click();
    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
  });

  it("tous les ids sont uniques, y compris entre deux barres", () => {
    const other = document.createElement("div");
    document.body.appendChild(other);
    mount({}, other);
    btn("Filtres").click();
    other.querySelector<HTMLButtonElement>('button[aria-label="Filtres"]')!.click();
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("clics qui ouvrent un menu : SiYuan ferme les menus sur tout clic qui atteint window (bug réel du banc d'essai)", () => {
  let reached: Event[];
  let onDocClick: (e: Event) => void;
  beforeEach(() => {
    reached = [];
    onDocClick = (e) => reached.push(e);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });
  const keyboardClick = (b: HTMLElement): void => {
    // Entrée ou Espace sur un <button> : le navigateur envoie un `click` (detail 0) qui remonte comme les autres.
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  };

  it.each([PATH, MORE])("« %s » : le clic souris n'atteint PAS document (stopPropagation)", (name) => {
    btn(name).click();
    expect(reached).toHaveLength(0);
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
  });

  it.each([PATH, MORE])("« %s » : l'activation au clavier (Entrée/Espace -> click detail 0) n'atteint pas document non plus", (name) => {
    keyboardClick(btn(name));
    expect(reached).toHaveLength(0);
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
  });

  it("un clic qui ouvre un menu n'atteint pas window non plus (le gestionnaire global de SiYuan y est posé)", () => {
    const onWindow = vi.fn();
    window.addEventListener("click", onWindow);
    try {
      btn(PATH).click();
      btn(MORE).click();
    } finally {
      window.removeEventListener("click", onWindow);
    }
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("les boutons qui ouvrent un menu portent data-menu=\"true\" (exclusion native du gestionnaire de pointerdown tactile)", () => {
    expect(btn(PATH).getAttribute("data-menu")).toBe("true");
    expect(btn(MORE).getAttribute("data-menu")).toBe("true");
  });

  it("les menus ont un identifiant par bouton (bascule sur le même bouton, remplacement d'un autre)", () => {
    btn(PATH).click();
    btn(MORE).click();
    const ids = fakes.openMenu.mock.calls.map((c) => c[3]);
    expect(ids).toEqual(["docseeker-path", "docseeker-more"]);
  });

  it("les boutons qui n'ouvrent rien (Inclure, Supprimer, Élargir) laissent le clic remonter : SiYuan referme ainsi un menu resté ouvert", () => {
    withFolder("assets/a/");
    btn(INCLUDE).click();
    btn(EXPAND).click();
    btn(REMOVE).click();
    expect(reached).toHaveLength(3);
  });

  it("« Filtres » : le clic remonte (aucun gestionnaire global ne ferme un dialogue ; il referme en revanche un menu ouvert)", () => {
    filtersBtn().click();
    expect(reached).toHaveLength(1);
    expect(fakes.openDialog).toHaveBeenCalledTimes(1);
  });
});

describe("compteur", () => {
  const counter = () => row().querySelector<HTMLElement>(".docseeker-count")!;

  it("caché et vide au départ", () => {
    expect(counter().hidden).toBe(true);
    expect(counter().textContent).toBe("");
  });

  it("setCounter affiche le texte (textContent) dans le premier élément de la rangée, sans région live", () => {
    toolbar.setCounter("3 documents");
    expect(counter().hidden).toBe(false);
    expect(counter().textContent).toBe("3 documents");
    expect(row().firstElementChild).toBe(counter());
    expect(counter().hasAttribute("aria-live")).toBe(false);
    expect(counter().classList.contains("ft__on-surface")).toBe(true);
  });

  it("le texte est brut : une balise reste du texte", () => {
    toolbar.setCounter("<b>x</b>");
    expect(counter().children).toHaveLength(0);
    expect(counter().textContent).toBe("<b>x</b>");
  });

  it("setCounter(\"\") le masque à nouveau", () => {
    toolbar.setCounter("3 documents");
    toolbar.setCounter("");
    expect(counter().hidden).toBe(true);
    expect(counter().textContent).toBe("");
  });
});

describe("« Spécifier le chemin » : menu des dossiers", () => {
  it("ouvre UN menu : « Tous les dossiers » puis les dossiers indentés (espaces insécables), « Tous » courant", () => {
    btn(PATH).click();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
    const items = fakes.lastMenu().items;
    expect(items.map((i) => i.label)).toEqual([
      "Tous les dossiers",
      "assets",
      "  a",
      "    sub",
      "  b",
    ]);
    expect(items.map((i) => i.current === true)).toEqual([true, false, false, false, false]);
    expect(items.every((i) => !i.separator && !i.submenu)).toBe(true);
  });

  it("l'ancre est le bas-gauche du bouton, avec sa largeur et sa hauteur", () => {
    vi.spyOn(btn(PATH), "getBoundingClientRect").mockReturnValue({ left: 10, bottom: 50, width: 30, height: 32 } as DOMRect);
    btn(PATH).click();
    expect(fakes.lastMenu().anchor).toEqual({ x: 10, y: 50, w: 30, h: 32 });
  });

  it("le dossier courant est « current » ; les autres non", () => {
    withFolder("assets/a/");
    btn(PATH).click();
    const items = fakes.lastMenu().items;
    expect(items.find((i) => i.current)?.label).toBe("  a");
    expect(items.filter((i) => i.current)).toHaveLength(1);
  });

  it("un dossier courant absent de la liste est ajouté (et courant)", () => {
    withFolder("assets/gone/");
    btn(PATH).click();
    const items = fakes.lastMenu().items;
    expect(items.at(-1)).toMatchObject({ label: "  gone", current: true });
  });

  it("choisir un dossier applique le filtre IMMÉDIATEMENT (une seule fois), en gardant tri et sous-dossiers", () => {
    state = { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, includeSubfolders: false } };
    toolbar.refresh();
    btn(PATH).click();
    pick(fakes.lastMenu(), "  b");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions.mock.calls[0]![0]).toEqual({
      sort: { key: "name", direction: "asc" },
      filters: { ...NO_FILTERS, includeSubfolders: false, folder: "assets/b/" },
    });
  });

  it("choisir le dossier déjà courant ne fait rien", () => {
    withFolder("assets/a/");
    btn(PATH).click();
    pick(fakes.lastMenu(), "  a");
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("« Tous les dossiers » vide le dossier", () => {
    withFolder("assets/a/");
    btn(PATH).click();
    pick(fakes.lastMenu(), "Tous les dossiers");
    expect(lastFilters().folder).toBe("");
  });

  it("conserve les autres filtres (nom, pages, date) en changeant de dossier", () => {
    withFolder("assets/a/", { nameContains: "abc", minPages: 2, modifiedAfterMs: 5 });
    btn(PATH).click();
    pick(fakes.lastMenu(), "  b");
    expect(lastFilters()).toEqual({ ...NO_FILTERS, folder: "assets/b/", nameContains: "abc", minPages: 2, modifiedAfterMs: 5 });
  });

  it("la liste des dossiers est relue à chaque ouverture", () => {
    btn(PATH).click();
    folders = ["x/"];
    btn(PATH).click();
    expect(fakes.lastMenu().items.map((i) => i.label)).toEqual(["Tous les dossiers", "x"]);
  });

  it("200 dossiers : tous listés (le menu natif défile), sans troncature", () => {
    folders = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(3, "0")}/`);
    btn(PATH).click();
    expect(fakes.lastMenu().items).toHaveLength(201);
  });

  it("le focus n'est plus géré par la barre : openMenu est appelé sans onClose (l'adaptateur rend le focus à l'ouvrant)", () => {
    btn(PATH).click();
    expect(fakes.openMenu.mock.calls[0]![2]).toBeUndefined();
    expect(fakes.lastMenu().onClose).toBeUndefined();
  });

  describe("liste bornée (dossiers arbitrairement nombreux, profonds ou longs)", () => {
    const labels = () => fakes.lastMenu().items.map((i) => i.label ?? "");
    const NBSP2 = "\u00a0\u00a0";

    it("10 000 dossiers profonds : au plus 500 dossiers + « Tous » + une ligne « … N autres dossiers » désactivée, vite", () => {
      folders = Array.from({ length: 10_000 }, (_, i) => `${"d/".repeat(20)}x${String(i).padStart(5, "0")}/`);
      const t0 = performance.now();
      btn(PATH).click();
      const elapsed = performance.now() - t0;
      const items = fakes.lastMenu().items;
      expect(items).toHaveLength(1 + 500 + 1);
      const last = items.at(-1)!;
      expect(last.label).toBe("… 9500 autres dossiers");
      expect(last.disabled).toBe(true);
      expect(last.click).toBeUndefined();
      expect(elapsed).toBeLessThan(1000);
    });

    it("singulier à 1 dossier restant ; la ligne n'a ni < ni > ni & (SiYuan l'insère comme HTML) et n'apparaît pas sous le plafond", () => {
      folders = Array.from({ length: 501 }, (_, i) => `d${String(i).padStart(3, "0")}/`);
      btn(PATH).click();
      expect(labels().at(-1)).toBe("… 1 autre dossier");
      expect(labels().at(-1)).not.toMatch(/[<>&]/);
      folders = Array.from({ length: 500 }, (_, i) => `d${String(i).padStart(3, "0")}/`);
      btn(PATH).click();
      expect(fakes.lastMenu().items).toHaveLength(501);
      expect(labels().some((l) => l.includes("autres dossiers"))).toBe(false);
    });

    it("un dossier courant au-delà du plafond reste listé (et courant), avant la ligne « autres dossiers »", () => {
      folders = Array.from({ length: 800 }, (_, i) => `d${String(i).padStart(3, "0")}/`);
      withFolder("d799/");
      btn(PATH).click();
      const items = fakes.lastMenu().items;
      expect(items.find((i) => i.current)?.label).toBe("d799");
      expect(items.at(-1)!.label).toBe("… 299 autres dossiers"); // 800 - 500 listés - le courant, listé en plus
    });

    it("l'indentation est plafonnée à 8 niveaux, même pour un dossier à 40 niveaux", () => {
      const deep = `${Array.from({ length: 40 }, (_, i) => `n${i}`).join("/")}/`;
      folders = [deep];
      btn(PATH).click();
      const label = labels()[1]!;
      const indent = /^(\u00a0*)/.exec(label)![1]!.length;
      expect(indent).toBe(8 * 2);
    });

    it("un libellé trop long est tronqué à 120 caractères avec « … »", () => {
      folders = [`${"é".repeat(300)}/`];
      btn(PATH).click();
      const label = labels()[1]!;
      expect([...label]).toHaveLength(120);
      expect(label.endsWith("…")).toBe(true);
      expect(label.startsWith("éé")).toBe(true);
    });

    it("la troncature ne coupe pas un emoji (paire de substituts)", () => {
      folders = [`${"😀".repeat(200)}/`];
      btn(PATH).click();
      const label = labels()[1]!;
      expect([...label]).toHaveLength(120);
      expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    it("un libellé de 120 caractères exactement n'est pas tronqué", () => {
      folders = [`${"a".repeat(120)}/`];
      btn(PATH).click();
      expect(labels()[1]).toBe("a".repeat(120));
    });

    it("dossiers homonymes dont l'ancêtre n'est pas listé (a/x/ et b/x/) : le segment parent est affiché, pas deux « x » identiques", () => {
      folders = ["a/x/", "b/x/"];
      btn(PATH).click();
      expect(labels().slice(1)).toEqual([`${NBSP2}a/x`, `${NBSP2}b/x`]);
    });

    it("dossiers homonymes avec leurs ancêtres (cas de listFolders) : disposition en arbre, chaque « x » sous son parent", () => {
      folders = ["a/", "a/x/", "b/", "b/x/"];
      btn(PATH).click();
      expect(labels().slice(1)).toEqual(["a", `${NBSP2}x`, "b", `${NBSP2}x`]);
    });

    it("au-delà du plafond d'indentation, le segment parent est affiché pour lever l'ambiguïté", () => {
      const path = (leafParent: string) => `${Array.from({ length: 9 }, (_, i) => `n${i}`).join("/")}/${leafParent}/x/`;
      folders = [path("p"), path("q")];
      btn(PATH).click();
      const [one, two] = labels().slice(1);
      expect(one!.trim()).toBe("p/x");
      expect(two!.trim()).toBe("q/x");
    });
  });
});

describe("étiquette de chemin et croix « Supprimer »", () => {
  const label = () => row().querySelector<HTMLElement>("span.search__path")!;

  it("sans dossier : étiquette et croix cachées", () => {
    expect(label().hidden).toBe(true);
    expect(btn(REMOVE).hidden).toBe(true);
  });

  it("avec un dossier : étiquette aux classes natives, texte = dossier, infobulle = dossier", () => {
    withFolder("assets/a/");
    expect(label().hidden).toBe(false);
    for (const c of ["search__path", "ft__on-surface", "fn__flex-center", "ft__smaller", "fn__ellipsis"]) {
      expect(label().classList.contains(c), c).toBe(true);
    }
    expect(label().textContent).toBe("assets/a/");
    expect(label().title).toBe("assets/a/");
    expect(btn(REMOVE).hidden).toBe(false);
    expect(useHref(btn(REMOVE))).toBe("#iconCloseRound");
  });

  it("un nom de dossier avec des balises reste du texte", () => {
    withFolder("<img src=x>/");
    expect(label().children.length).toBe(1); // le seul enfant est le span du texte
    expect(label().textContent).toBe("<img src=x>/");
    expect(label().querySelector("img")).toBeNull();
  });

  it("« Supprimer » remet « Tous les dossiers » (une seule application), cache l'étiquette et rend le focus à « Spécifier le chemin »", () => {
    withFolder("assets/a/", { includeSubfolders: false });
    btn(REMOVE).focus();
    btn(REMOVE).click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters()).toEqual({ ...NO_FILTERS, includeSubfolders: false });
    expect(label().hidden).toBe(true);
    expect(btn(REMOVE).hidden).toBe(true);
    expect(document.activeElement).toBe(btn(PATH));
  });
});

describe("« Inclure les documents enfants »", () => {
  const svg = () => btn(INCLUDE).querySelector("svg")!;

  it("sans dossier : aria-disabled, jamais actif, le clic ne fait rien", () => {
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
    expect(svg().classList.contains("ft__primary")).toBe(false);
    btn(INCLUDE).click();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("avec un dossier et sous-dossiers inclus : actif (svg.ft__primary, aria-pressed), non désactivé", () => {
    withFolder("assets/a/");
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
    expect(svg().classList.contains("ft__primary")).toBe(true);
    expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("true");
  });

  it("le clic bascule includeSubfolders, met à jour l'état et garde le focus sur le bouton", () => {
    withFolder("assets/a/");
    btn(INCLUDE).focus();
    btn(INCLUDE).click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters()).toMatchObject({ folder: "assets/a/", includeSubfolders: false });
    expect(svg().classList.contains("ft__primary")).toBe(false);
    expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(btn(INCLUDE));
    btn(INCLUDE).click();
    expect(lastFilters().includeSubfolders).toBe(true);
    expect(svg().classList.contains("ft__primary")).toBe(true);
  });

  it("un dossier choisi dans le menu active le bouton", () => {
    btn(PATH).click();
    pick(fakes.lastMenu(), "assets");
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
  });
});

describe("« Plus » : menu Tri / Groupe", () => {
  it("deux sous-menus : « Tri » puis « Groupe »", () => {
    btn(MORE).click();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
    const items = fakes.lastMenu().items;
    expect(items.map((i) => i.label)).toEqual(["Tri", "Groupe"]);
    expect(items.every((i) => Array.isArray(i.submenu))).toBe(true);
  });

  it("« Tri » : les huit choix, libellés natifs, dans l'ordre, tri courant « current »", () => {
    btn(MORE).click();
    const sub = findItem(fakes.lastMenu().items, "Tri").submenu!;
    expect(sub.map((i) => i.label)).toEqual([
      "Pertinence",
      "ASC de pertinence",
      "Modifier le temps croissant",
      "Modifier le temps décroissant",
      "Nom croissant",
      "Nom décroissant",
      "Chemin croissant",
      "Pages correspondantes décroissant",
    ]);
    expect(sub.filter((i) => i.current).map((i) => i.label)).toEqual(["Nom croissant"]);
  });

  it("un tri hors des choix proposés (path:desc) : aucun élément courant", () => {
    state = { ...state, sort: { key: "path", direction: "desc" } };
    btn(MORE).click();
    expect(findItem(fakes.lastMenu().items, "Tri").submenu!.some((i) => i.current)).toBe(false);
  });

  it.each([
    ["Pertinence", "relevance", "desc"],
    ["ASC de pertinence", "relevance", "asc"],
    ["Modifier le temps croissant", "modified", "asc"],
    ["Modifier le temps décroissant", "modified", "desc"],
    ["Nom décroissant", "name", "desc"],
    ["Chemin croissant", "path", "asc"],
    ["Pages correspondantes décroissant", "matches", "desc"],
  ])("choisir « %s » : setOptions({ sort: %s:%s, filters inchangés }) une seule fois", (label, key, direction) => {
    state = { ...state, filters: { ...NO_FILTERS, nameContains: "abc", minPages: 2 } };
    btn(MORE).click();
    pick(fakes.lastMenu(), "Tri", label);
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions).toHaveBeenCalledWith({ sort: { key, direction }, filters: { ...NO_FILTERS, nameContains: "abc", minPages: 2 } });
  });

  it("choisir le tri déjà courant ne fait rien", () => {
    btn(MORE).click();
    pick(fakes.lastMenu(), "Tri", "Nom croissant");
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("le tri courant du menu suit les options (relu à chaque ouverture)", () => {
    btn(MORE).click();
    state = { ...state, sort: { key: "matches", direction: "desc" } };
    btn(MORE).click();
    expect(findItem(fakes.lastMenu().items, "Tri").submenu!.find((i) => i.current)?.label).toBe("Pages correspondantes décroissant");
  });

  it("« Groupe » : « Aucun regroupement » et « Regrouper par document », le mode courant « current »", () => {
    btn(MORE).click();
    const sub = findItem(fakes.lastMenu().items, "Groupe").submenu!;
    expect(sub.map((i) => i.label)).toEqual(["Aucun regroupement", "Regrouper par document"]);
    expect(sub.map((i) => i.current === true)).toEqual([false, true]);
    group = false;
    btn(MORE).click();
    expect(findItem(fakes.lastMenu().items, "Groupe").submenu!.map((i) => i.current === true)).toEqual([true, false]);
  });

  it("choisir un regroupement appelle setGroupByDocument (jamais setOptions) ; le mode courant ne fait rien", () => {
    btn(MORE).click();
    pick(fakes.lastMenu(), "Groupe", "Regrouper par document");
    expect(setGroup).not.toHaveBeenCalled();
    btn(MORE).click(); // le premier choix a refermé le menu
    pick(fakes.lastMenu(), "Groupe", "Aucun regroupement");
    expect(setGroup).toHaveBeenCalledTimes(1);
    expect(setGroup).toHaveBeenCalledWith(false);
    expect(setOptions).not.toHaveBeenCalled();
  });
});

describe("« Élargir » / « Réduire »", () => {
  it("visibles seulement quand le regroupement est actif (refresh suit l'état)", () => {
    expect(btn(EXPAND).hidden).toBe(false);
    group = false;
    toolbar.refresh();
    expect(btn(EXPAND).hidden).toBe(true);
    expect(btn(COLLAPSE).hidden).toBe(true);
    expect(visibleNames()).not.toContain(EXPAND);
    group = true;
    toolbar.refresh();
    expect(btn(EXPAND).hidden).toBe(false);
  });

  it("aria-disabled suit canExpand / canCollapse", () => {
    expect(btn(EXPAND).getAttribute("aria-disabled")).toBe("false");
    expect(btn(COLLAPSE).getAttribute("aria-disabled")).toBe("true");
    expansion.canExpand.mockReturnValue(false);
    expansion.canCollapse.mockReturnValue(true);
    toolbar.refresh();
    expect(btn(EXPAND).getAttribute("aria-disabled")).toBe("true");
    expect(btn(COLLAPSE).getAttribute("aria-disabled")).toBe("false");
  });

  it("le clic actif appelle expandAll / collapseAll, garde le focus et resynchronise", () => {
    btn(EXPAND).focus();
    btn(EXPAND).click();
    expect(expansion.expandAll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn(EXPAND));
    expansion.canCollapse.mockReturnValue(true);
    btn(COLLAPSE).focus();
    toolbar.refresh();
    btn(COLLAPSE).click();
    expect(expansion.collapseAll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn(COLLAPSE));
  });

  it("le clic sur un bouton aria-disabled ne fait rien", () => {
    btn(COLLAPSE).click();
    expect(expansion.collapseAll).not.toHaveBeenCalled();
    expansion.canExpand.mockReturnValue(false);
    toolbar.refresh();
    btn(EXPAND).click();
    expect(expansion.expandAll).not.toHaveBeenCalled();
  });

  it("un bouton aria-disabled reste dans l'ordre de tabulation (focus conservé)", () => {
    expect(btn(COLLAPSE).tabIndex).toBe(0);
    expect(btn(COLLAPSE).hasAttribute("disabled")).toBe(false);
  });
});

describe("« Filtres » : bouton et résumé", () => {
  it("infobulle = nom : « Filtres », « Filtres (1 actif) », « Filtres (N actifs) »", () => {
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres");
    withFolder("assets/a/");
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres (1 actif)");
    withFolder("assets/a/", { minPages: 3, nameContains: "x" });
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres (3 actifs)");
  });

  it("svg.ft__primary seulement quand des filtres sont actifs", () => {
    expect(filtersBtn().querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
    withFolder("assets/a/");
    expect(filtersBtn().querySelector("svg")!.classList.contains("ft__primary")).toBe(true);
    state = { ...state, filters: NO_FILTERS };
    toolbar.refresh();
    expect(filtersBtn().querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
  });
});

describe("« Filtres » : dialogue", () => {
  const open = () => {
    filtersBtn().click();
    return fakes.lastDialog();
  };
  function field<T extends HTMLElement>(d: { container: HTMLElement }, label: string): T {
    const l = Array.from(d.container.querySelectorAll("label")).find((x) => x.textContent === label);
    if (!l) throw new Error(`label introuvable : ${label}`);
    const el = document.getElementById(l.htmlFor);
    if (!el) throw new Error(`contrôle non lié au libellé : ${label}`);
    return el as T;
  }
  const setVal = (el: HTMLInputElement, v: string): void => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const resetBtn = (d: { container: HTMLElement }) =>
    Array.from(d.container.querySelectorAll("button")).find((b) => b.textContent === "Réinitialiser les filtres")!;

  it("le clic ouvre UN dialogue : titre « Filtres », largeur 420px, libellés Annuler / Confirmer", () => {
    open();
    expect(fakes.openDialog).toHaveBeenCalledTimes(1);
    const o = fakes.lastDialog().options;
    expect(o.title).toBe("Filtres");
    expect(o.width).toBe("420px");
    expect(o.labels).toEqual({ cancel: "Annuler", confirm: "Confirmer" });
    expect(`${o.title}${o.labels.cancel}${o.labels.confirm}`).not.toMatch(/[<>&]/);
  });

  it("le contenu : quatre champs liés par for (search, number min=1 step=1 x2, date) + bouton de réinitialisation, sans select/details/case", () => {
    const d = open();
    expect(field<HTMLInputElement>(d, "Nom du document contient").type).toBe("search");
    const min = field<HTMLInputElement>(d, "Pages au moins");
    const max = field<HTMLInputElement>(d, "Pages au plus");
    expect([min.type, min.min, min.step, max.type, max.min, max.step]).toEqual(["number", "1", "1", "number", "1", "1"]);
    expect(field<HTMLInputElement>(d, "Modifié après").type).toBe("date");
    expect(resetBtn(d).type).toBe("button");
    expect(d.container.querySelector("select, details, input[type=checkbox], [aria-live]")).toBeNull();
    expect([min.min, min.step]).toEqual([String(MIN_PAGE_BOUND), "1"]);
  });

  it("les champs reflètent les options courantes à l'ouverture (et sont relus à chaque ouverture)", () => {
    state = {
      sort: { key: "relevance", direction: "desc" },
      filters: { folder: "assets/a/", includeSubfolders: false, nameContains: "abc", minPages: 2, maxPages: 8, modifiedAfterMs: Date.UTC(2024, 0, 31) },
    };
    toolbar.refresh();
    const d = open();
    expect(field<HTMLInputElement>(d, "Nom du document contient").value).toBe("abc");
    expect(field<HTMLInputElement>(d, "Pages au moins").value).toBe("2");
    expect(field<HTMLInputElement>(d, "Pages au plus").value).toBe("8");
    expect(field<HTMLInputElement>(d, "Modifié après").value).toBe("2024-01-31");
    d.cancel();
    state = { ...state, filters: { ...state.filters, nameContains: "autre" } };
    const d2 = open();
    expect(field<HTMLInputElement>(d2, "Nom du document contient").value).toBe("autre");
  });

  it("le focus est laissé à l'adaptateur (build ne déplace pas le focus lui-même hors du conteneur)", () => {
    const before = document.activeElement;
    open();
    expect(document.activeElement).toBe(before);
  });

  it("saisir ne relance rien : aucune application avant « Confirmer » (input, change, clavier)", () => {
    const d = open();
    const name = field<HTMLInputElement>(d, "Nom du document contient");
    setVal(name, "anesth");
    name.dispatchEvent(new KeyboardEvent("keyup", { key: "h", bubbles: true }));
    setVal(field<HTMLInputElement>(d, "Pages au moins"), "5");
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("Confirmer (valide) : UN seul setOptions avec tous les filtres, tri, dossier et sous-dossiers conservés", () => {
    state = { sort: { key: "modified", direction: "desc" }, filters: { ...NO_FILTERS, folder: "assets/a/", includeSubfolders: false } };
    toolbar.refresh();
    const d = open();
    setVal(field<HTMLInputElement>(d, "Nom du document contient"), "anesth");
    setVal(field<HTMLInputElement>(d, "Pages au moins"), "5");
    setVal(field<HTMLInputElement>(d, "Pages au plus"), "50");
    setVal(field<HTMLInputElement>(d, "Modifié après"), "2024-03-05");
    expect(d.confirm()).toBe(true);
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions.mock.calls[0]![0]).toEqual({
      sort: { key: "modified", direction: "desc" },
      filters: {
        folder: "assets/a/", includeSubfolders: false, nameContains: "anesth", minPages: 5, maxPages: 50, modifiedAfterMs: Date.UTC(2024, 2, 5),
      },
    });
  });

  it("Confirmer avec des champs vides : pas de clés minPages / maxPages / modifiedAfterMs", () => {
    const d = open();
    expect(d.confirm()).toBe(true);
    expect(lastFilters()).toEqual(NO_FILTERS);
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("après Confirmer : le résumé suit et le focus revient au bouton « Filtres »", () => {
    const d = open();
    setVal(field<HTMLInputElement>(d, "Pages au moins"), "5");
    d.confirm();
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres (1 actif)");
    expect(document.activeElement).toBe(filtersBtn());
  });

  it("Annuler / Échap : rien n'est appliqué, les saisies sont perdues, le focus revient au bouton", () => {
    const d = open();
    setVal(field<HTMLInputElement>(d, "Pages au moins"), "5");
    d.cancel();
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(filtersBtn());
    const d2 = open();
    expect(field<HTMLInputElement>(d2, "Pages au moins").value).toBe("");
  });

  it("un second clic sur « Filtres » pendant que le dialogue est ouvert n'en ouvre pas un deuxième", () => {
    open();
    filtersBtn().click();
    expect(fakes.openDialog).toHaveBeenCalledTimes(1);
  });

  it("un dialogue retiré par SiYuan sans destroyCallback ne bloque pas : on peut en rouvrir un", () => {
    const d = open();
    d.vanish();
    filtersBtn().click();
    expect(fakes.openDialog).toHaveBeenCalledTimes(2);
  });

  it("un dialogue refermé (Annuler) se rouvre ; ouvert, un second clic n'en crée pas", () => {
    const d = open();
    filtersBtn().click();
    expect(fakes.openDialog).toHaveBeenCalledTimes(1);
    d.cancel();
    filtersBtn().click();
    expect(fakes.openDialog).toHaveBeenCalledTimes(2);
  });

  it("Confirmer : onCancel n'est jamais appelé ; le focus est rendu à « Filtres » par onDestroyed (destruction effective)", () => {
    const d = open();
    const onCancel = vi.fn();
    (d.options as { onCancel?: () => void }).onCancel = onCancel; // la barre n'en pose plus : on le branche pour le surveiller
    d.confirm();
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(filtersBtn());
  });

  it("onConfirm lui-même ne touche pas au focus (il revient seulement après la destruction)", () => {
    const d = open();
    const name = field<HTMLInputElement>(d, "Nom du document contient");
    name.focus();
    d.options.onConfirm();
    expect(document.activeElement).toBe(name);
    d.handle.close();
    expect(document.activeElement).toBe(filtersBtn());
  });

  describe("brouillon : le dossier et « sous-dossiers » ne sont touchés que si l'utilisateur les a changés dans le dialogue", () => {
    it("un dossier modifié de l'extérieur pendant le dialogue n'est pas écrasé par le dossier d'ouverture", () => {
      withFolder("assets/a/");
      const d = open();
      state = { ...state, filters: { ...state.filters, folder: "assets/b/" } }; // changement externe (setOptions d'ailleurs)
      setVal(field<HTMLInputElement>(d, "Nom du document contient"), "x");
      d.confirm();
      expect(lastFilters().folder).toBe("assets/b/");
      expect(lastFilters().nameContains).toBe("x");
    });

    it("« sous-dossiers » modifié de l'extérieur : conservé aussi", () => {
      withFolder("assets/a/");
      const d = open();
      state = { ...state, filters: { ...state.filters, includeSubfolders: false } };
      d.confirm();
      expect(lastFilters().includeSubfolders).toBe(false);
      expect(lastFilters().folder).toBe("assets/a/");
    });

    it("dossier vidé de l'extérieur pendant le dialogue : il reste vide après Confirmer", () => {
      withFolder("assets/a/");
      const d = open();
      state = { ...state, filters: { ...state.filters, folder: "" } };
      d.confirm();
      expect(lastFilters().folder).toBe("");
    });

    it("« Réinitialiser » est un choix de l'utilisateur : il l'emporte sur un changement externe de dossier", () => {
      withFolder("assets/a/");
      const d = open();
      resetBtn(d).click();
      state = { ...state, filters: { ...state.filters, folder: "assets/b/", includeSubfolders: false } };
      d.confirm();
      expect(lastFilters().folder).toBe("");
      expect(lastFilters().includeSubfolders).toBe(true);
    });

    it("le bouton « Réinitialiser » tient compte du dossier COURANT (changé de l'extérieur), pas de celui d'ouverture", () => {
      const d = open();
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("true");
      state = { ...state, filters: { ...state.filters, folder: "assets/b/" } };
      setVal(field<HTMLInputElement>(d, "Nom du document contient"), "x");
      setVal(field<HTMLInputElement>(d, "Nom du document contient"), "");
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("false");
    });
  });

  it("si openDialog lève, l'erreur remonte et le bouton reste utilisable", () => {
    fakes.openDialog.mockImplementationOnce(() => {
      throw new Error("pas de dialogue");
    });
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      filtersBtn().click(); // levée dans un écouteur : signalée à la fenêtre, jamais avalée
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors.map((e) => (e as Error).message)).toEqual(["pas de dialogue"]);
    fakes.openDialog.mockClear();
    filtersBtn().click();
    expect(fakes.openDialog).toHaveBeenCalledTimes(1);
  });

  describe("valeurs invalides : le dialogue reste ouvert", () => {
    const err = (d: { container: HTMLElement }, label: string) => field<HTMLElement>(d, label).parentElement!.querySelector(".docseeker-filter-error")!;

    it("min > max : Confirmer renvoie false, aria-invalid sur les deux, message lié, rien d'appliqué", () => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      const max = field<HTMLInputElement>(d, "Pages au plus");
      setVal(min, "9");
      setVal(max, "2");
      expect(d.confirm()).toBe(false);
      for (const el of [min, max]) {
        expect(el.getAttribute("aria-invalid")).toBe("true");
        const msg = document.getElementById(el.getAttribute("aria-describedby")!)!;
        expect(msg.textContent).toBe("Erreur : Pages au moins ne peut pas dépasser Pages au plus.");
        expect(msg.hidden).toBe(false);
      }
      expect(setOptions).not.toHaveBeenCalled();
      expect(d.container.isConnected).toBe(true);
    });

    it("correction puis Confirmer : l'erreur disparaît, le filtre s'applique, le dialogue se ferme", () => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      const max = field<HTMLInputElement>(d, "Pages au plus");
      setVal(min, "9");
      setVal(max, "2");
      d.confirm();
      setVal(max, "20");
      const message = err(d, "Pages au plus");
      expect(d.confirm()).toBe(true);
      expect(min.hasAttribute("aria-invalid")).toBe(false);
      expect(max.hasAttribute("aria-describedby")).toBe(false);
      expect(message.textContent).toBe("");
      expect(lastFilters()).toMatchObject({ minPages: 9, maxPages: 20 });
    });

    it.each(["2.5", "0", "-3"])("nombre %s : entier supérieur ou égal à 1 exigé", (value) => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      setVal(min, value);
      expect(d.confirm()).toBe(false);
      expect(min.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(min.getAttribute("aria-describedby")!)!.textContent).toBe(
        "Erreur : Saisissez un nombre entier supérieur ou égal à 1.",
      );
      expect(setOptions).not.toHaveBeenCalled();
    });

    it("entier non sûr (9007199254740993) : refusé", () => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      setVal(min, "9007199254740993");
      expect(d.confirm()).toBe(false);
      expect(min.getAttribute("aria-invalid")).toBe("true");
    });

    it("« 1e2 » est l'entier 100 ; « 5 » est accepté", () => {
      const d = open();
      setVal(field<HTMLInputElement>(d, "Pages au moins"), "1e2");
      expect(d.confirm()).toBe(true);
      expect(lastFilters().minPages).toBe(100);
    });

    it("saisie illisible (validity.badInput) : message d'entier, rien d'appliqué", () => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      Object.defineProperty(min, "validity", { value: { badInput: true } });
      setVal(min, "abc");
      expect(d.confirm()).toBe(false);
      expect(document.getElementById(min.getAttribute("aria-describedby")!)!.textContent).toBe(
        "Erreur : Saisissez un nombre entier supérieur ou égal à 1.",
      );
    });

    it("date illisible (parseDate renvoie undefined) : message de date", () => {
      document.body.innerHTML = "";
      host = document.createElement("div");
      document.body.appendChild(host);
      fakes = createNativeFakes();
      toolbar = mount({ parseDate: () => undefined });
      const d = open();
      const date = field<HTMLInputElement>(d, "Modifié après");
      setVal(date, "2024-03-05");
      expect(d.confirm()).toBe(false);
      expect(date.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(date.getAttribute("aria-describedby")!)!.textContent).toBe("Erreur : Saisissez une date valide.");
    });

    it("date illisible (validity.badInput) : même message", () => {
      const d = open();
      const date = field<HTMLInputElement>(d, "Modifié après");
      Object.defineProperty(date, "validity", { value: { badInput: true } });
      setVal(date, "2024-01-01");
      expect(d.confirm()).toBe(false);
      expect(document.getElementById(date.getAttribute("aria-describedby")!)!.textContent).toBe("Erreur : Saisissez une date valide.");
    });

    it("un champ invalide empêche TOUT l'enregistrement (les autres filtres valides ne sont pas appliqués à moitié)", () => {
      const d = open();
      setVal(field<HTMLInputElement>(d, "Pages au moins"), "0");
      setVal(field<HTMLInputElement>(d, "Nom du document contient"), "abc");
      expect(d.confirm()).toBe(false);
      expect(setOptions).not.toHaveBeenCalled();
    });

    it("le focus va au premier champ invalide", () => {
      const d = open();
      setVal(field<HTMLInputElement>(d, "Pages au plus"), "0");
      d.confirm();
      expect(document.activeElement).toBe(field<HTMLInputElement>(d, "Pages au plus"));
    });

    it("pas de région live ajoutée pour les erreurs", () => {
      const d = open();
      setVal(field<HTMLInputElement>(d, "Pages au moins"), "0");
      d.confirm();
      expect(d.container.querySelector("[aria-live], [role=alert], [role=status]")).toBeNull();
    });
  });

  describe("« Réinitialiser les filtres » dans le dialogue", () => {
    it("aria-disabled sans rien à effacer ; le clic ne fait rien", () => {
      const d = open();
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("true");
      const name = field<HTMLInputElement>(d, "Nom du document contient");
      name.focus();
      resetBtn(d).click();
      expect(document.activeElement).toBe(name);
    });

    it("avec des saisies : actif ; efface les champs et les erreurs, SANS appliquer avant Confirmer", () => {
      const d = open();
      const min = field<HTMLInputElement>(d, "Pages au moins");
      setVal(min, "0");
      setVal(field<HTMLInputElement>(d, "Nom du document contient"), "abc");
      d.confirm();
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("false");
      resetBtn(d).click();
      expect(min.value).toBe("");
      expect(field<HTMLInputElement>(d, "Nom du document contient").value).toBe("");
      expect(min.hasAttribute("aria-invalid")).toBe(false);
      expect(min.hasAttribute("aria-describedby")).toBe(false);
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("true");
      expect(setOptions).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field<HTMLInputElement>(d, "Nom du document contient"));
    });

    it("un dossier actif rend le bouton actif ; réinitialiser puis Confirmer vide aussi le dossier et rétablit les sous-dossiers", () => {
      state = { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, folder: "assets/a/", includeSubfolders: false } };
      toolbar.refresh();
      const d = open();
      expect(resetBtn(d).getAttribute("aria-disabled")).toBe("false");
      resetBtn(d).click();
      expect(setOptions).not.toHaveBeenCalled();
      d.confirm();
      expect(lastFilters()).toEqual(NO_FILTERS);
      expect(setOptions.mock.calls[0]![0].sort).toEqual({ key: "name", direction: "asc" });
    });

    it("sans réinitialisation, Confirmer conserve le dossier courant", () => {
      withFolder("assets/b/");
      const d = open();
      d.confirm();
      expect(lastFilters().folder).toBe("assets/b/");
    });

    it("réinitialiser puis Annuler ne change rien", () => {
      withFolder("assets/b/", { nameContains: "x" });
      const d = open();
      resetBtn(d).click();
      d.cancel();
      expect(setOptions).not.toHaveBeenCalled();
      expect(state.filters.folder).toBe("assets/b/");
    });
  });
});

describe("reset() (bouton « Réinitialiser les filtres » du statut zéro-résultat)", () => {
  it("applique immédiatement NO_FILTERS en gardant le tri, resynchronise et met le focus sur « Filtres »", () => {
    withFolder("assets/a/", { nameContains: "abc", minPages: 3, modifiedAfterMs: 5 });
    toolbar.reset();
    expect(setOptions).toHaveBeenCalledTimes(1);
    const next = setOptions.mock.calls[0]![0] as SearchOptions;
    expect(next.filters).toEqual(NO_FILTERS);
    expect(next.sort).toEqual({ key: "name", direction: "asc" });
    expect(btn("Filtres")).toBe(filtersBtn());
    expect(document.activeElement).toBe(filtersBtn());
    expect(row().querySelector<HTMLElement>("span.search__path")!.hidden).toBe(true);
  });
});

describe("refresh() : synchronisation depuis les options", () => {
  it("chemin, Inclure et Filtres suivent des options modifiées de l'extérieur", () => {
    state = { sort: state.sort, filters: { ...NO_FILTERS, folder: "assets/b/", includeSubfolders: false, minPages: 2 } };
    toolbar.refresh();
    expect(row().querySelector("span.search__path")!.textContent).toBe("assets/b/");
    expect(btn(INCLUDE).querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
    expect(filtersBtn().getAttribute("aria-label")).toBe("Filtres (2 actifs)");
  });

  it("ne reconstruit pas les boutons (les mêmes éléments gardent le focus)", () => {
    const before = buttons();
    btn(MORE).focus();
    toolbar.refresh();
    expect(buttons()).toEqual(before);
    expect(document.activeElement).toBe(btn(MORE));
  });

  it("ne lit pas la liste des dossiers tant qu'aucun menu n'est ouvert (getFolders paresseux)", () => {
    const getFolders = vi.fn(() => folders);
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    toolbar = mount({ getFolders });
    toolbar.refresh();
    expect(getFolders).not.toHaveBeenCalled();
  });
});

describe("cycle de vie", () => {
  it("dispose retire la rangée ; refresh, reset et setCounter sont ensuite sans effet", () => {
    withFolder("assets/a/"); // « Inclure » est alors actif : son clic appellerait setOptions s'il restait branché
    const includeBtn = btn(INCLUDE);
    const pathBtn = btn(PATH);
    toolbar.dispose();
    expect(host.querySelector(".block__icons")).toBeNull();
    includeBtn.click();
    pathBtn.click();
    toolbar.refresh();
    toolbar.reset();
    toolbar.setCounter("x");
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("dispose avec le menu « Plus » ouvert : le menu est fermé (handle.close)", () => {
    withFolder("assets/a/");
    btn(MORE).click();
    const menu = fakes.lastMenu();
    expect(menu.closed).toBe(false);
    toolbar.dispose();
    expect(menu.closed).toBe(true);
  });

  it("dispose avec le menu des dossiers ouvert : fermé aussi", () => {
    btn(PATH).click();
    const menu = fakes.lastMenu();
    toolbar.dispose();
    expect(menu.closed).toBe(true);
  });

  it("dispose sans menu ouvert, ou avec un menu déjà fermé : aucun close superflu, aucune erreur", () => {
    btn(PATH).click();
    const menu = fakes.lastMenu();
    pick(menu, "assets");
    expect(menu.closed).toBe(true);
    expect(() => toolbar.dispose()).not.toThrow();
  });

  it("ouvrir Plus, dispose, puis un clic tardif sur Tri / Groupe : setOptions et setGroupByDocument ne sont PAS appelés", () => {
    withFolder("assets/a/");
    btn(MORE).click();
    const menu = fakes.lastMenu();
    toolbar.dispose();
    // Le menu est fermé ; on invoque tout de même les actions (menu natif encore dans le DOM d'un SiYuan lent).
    findItem(menu.items, "Tri", "Chemin croissant").click!();
    findItem(menu.items, "Groupe", "Aucun regroupement").click!();
    expect(setOptions).not.toHaveBeenCalled();
    expect(setGroup).not.toHaveBeenCalled();
  });

  it("dispose, puis un clic tardif sur un dossier du menu : rien n'est appliqué", () => {
    btn(PATH).click();
    const menu = fakes.lastMenu();
    toolbar.dispose();
    findItem(menu.items, "assets").click!();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("dispose pendant un dialogue ouvert : le dialogue est fermé (handle.close), sans onConfirm ni setOptions ni focus volé", () => {
    filtersBtn().click();
    const d = fakes.lastDialog();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    toolbar.dispose();
    expect(d.handle.isOpen()).toBe(false);
    expect(d.container.isConnected).toBe(false);
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });

  it("dispose pendant un dialogue ouvert : un Confirmer tardif n'applique rien", () => {
    filtersBtn().click();
    const d = fakes.lastDialog();
    toolbar.dispose();
    d.confirm();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("dispose deux fois est sans danger", () => {
    toolbar.dispose();
    expect(() => toolbar.dispose()).not.toThrow();
  });

  it("deux barres sont indépendantes", () => {
    const hostB = document.createElement("div");
    document.body.appendChild(hostB);
    const setB = vi.fn();
    mount({ setOptions: setB }, hostB);
    btn(PATH).click();
    pick(fakes.lastMenu(), "assets");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setB).not.toHaveBeenCalled();
  });
});

describe("codec de date local par défaut", () => {
  it("parseLocalDate : minuit local, aller-retour avec formatLocalDate", () => {
    expect(parseLocalDate("2024-03-05")).toBe(new Date(2024, 2, 5).getTime());
    expect(formatLocalDate(new Date(2024, 2, 5).getTime())).toBe("2024-03-05");
    expect(formatLocalDate(new Date(2024, 11, 31, 23, 59).getTime())).toBe("2024-12-31");
  });

  it.each(["", "2024-02-31", "2024-13-01", "05/03/2024", "2024-3-5", "abcd-ef-gh"])("parseLocalDate refuse %j", (v) => {
    expect(parseLocalDate(v)).toBeUndefined();
  });
});

describe("parseLocalDate (vrai calendrier, fuseau fixé)", () => {
  const previousTz = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "Europe/Paris";
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previousTz;
  });

  it("accepte le 29 février d'une année bissextile, à minuit heure de Paris", () => {
    expect(parseLocalDate("2024-02-29")).toBe(Date.UTC(2024, 1, 28, 23, 0, 0));
    expect(parseLocalDate("2024-07-01")).toBe(Date.UTC(2024, 5, 30, 22, 0, 0));
  });

  it.each(["2023-02-29", "2024-04-31", "0000-01-01", " 2024-01-01", "0050-01-01", "2024-01-01 ", "2024-00-10", "2024-01-00"])("refuse %j", (v) => {
    expect(parseLocalDate(v)).toBeUndefined();
  });

  it("sans parseDate injecté, le dialogue accepte 2024-02-29", () => {
    const other = document.createElement("div");
    document.body.appendChild(other);
    let current: SearchOptions = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
    const f = createNativeFakes();
    const { parseDate: _p, formatDate: _f, ...rest } = { parseDate, formatDate };
    void rest;
    mountSearchToolbar(other, {
      getOptions: () => current,
      setOptions: (o) => {
        current = o;
      },
      getFolders: () => [],
      t,
      openMenu: f.openMenu,
      openDialog: f.openDialog,
      getGroupByDocument: () => true,
      setGroupByDocument: () => undefined,
      expansion,
    });
    other.querySelector<HTMLButtonElement>('button[aria-label="Filtres"]')!.click();
    const date = f.lastDialog().container.querySelector<HTMLInputElement>("input[type=date]")!;
    date.value = "2024-02-29";
    expect(f.lastDialog().confirm()).toBe(true);
    expect(current.filters.modifiedAfterMs).toBe(parseLocalDate("2024-02-29"));
  });
});
