// @vitest-environment jsdom
// Intégration : vue + barre RÉELLES, adaptateur RÉEL (src/siyuan/nativeUi.ts) et faux Menu/Dialog de SiYuan qui se comportent
// comme les vrais (tests/stubs/siyuan.ts : closeCB avant le vidage, élément singleton réutilisé, libellés en innerHTML,
// sous-menus, clavier, fermeture au clic / pointerdown tactile). Les autres tests injectent de faux openMenu qui ne se ferment
// jamais : c'est pourquoi le bug « le menu s'ouvre puis se referme dans le même clic » leur avait échappé.
import { Dialog, Menu } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SearchViewModel } from "../../../src/search/searchController";
import { openDialog, openMenu } from "../../../src/siyuan/nativeUi";
import { SEARCH_STYLE_ID } from "../../../src/ui/searchStyles";
import { mountSearchView, type SearchView } from "../../../src/ui/searchView";

interface StubMenu {
  id?: string;
  opened: boolean;
  element: HTMLElement;
  items: { label?: string; submenu?: { label?: string }[] }[];
}
interface StubDialog {
  destroyCount: number;
  element: HTMLElement;
}
const stubs = {
  Menu: Menu as unknown as { instances: StubMenu[]; current: StubMenu | undefined; reset(): void },
  Dialog: Dialog as unknown as { instances: StubDialog[]; reset(): void; destroyDelayMs: number | undefined },
};

let host: HTMLElement;
let view: SearchView | undefined;
let opts: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let submit: ReturnType<typeof vi.fn>;
let history: string[];
let historyClear: ReturnType<typeof vi.fn>;
let folders: string[];

const vm: SearchViewModel = { kind: "empty-query" };

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  stubs.Menu.reset();
  stubs.Dialog.reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  opts = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    opts = o;
  });
  submit = vi.fn();
  history = ["chat", "chien"];
  folders = ["assets/", "assets/a/"];
  historyClear = vi.fn();
  view = mountSearchView(host, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => () => undefined },
    onOpen: vi.fn(),
    getDocMeta: () => undefined,
    options: { getOptions: () => opts, setOptions: setOptions as (o: SearchOptions) => void, getFolders: () => folders },
    history: { get: () => history, add: vi.fn(), clear: historyClear as () => void },
    openMenu,
    openDialog,
  });
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  stubs.Menu.reset();
  stubs.Dialog.reset();
  vi.useRealTimers();
});

const icon = (name: string) => host.querySelector<HTMLButtonElement>(`.docseeker-icons button[aria-label="${name}"]`)!;
const historyIcon = () => host.querySelector<HTMLButtonElement>("button.docseeker-history-icon")!;
const input = () => host.querySelector<HTMLInputElement>("input")!;
const current = (): StubMenu | undefined => stubs.Menu.current;
const keyboardClick = (b: HTMLElement): void => {
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
};
/** Touche pressée sur l'élément qui a le focus (elle remonte jusqu'à window, où SiYuan écoute le clavier du menu). */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
};
const labelOf = (item: Element | null): string | null => item?.querySelector(":scope > .b3-menu__label")?.textContent ?? null;
/** Item par libellé exact, sous-menus compris (premier de l'arbre). */
const itemByLabel = (text: string): HTMLElement => {
  const found = [...current()!.element.querySelectorAll<HTMLElement>(".b3-menu__item")].find((b) => labelOf(b) === text);
  if (!found) throw new Error(`item de menu introuvable : ${text}`);
  return found;
};
const BUTTONS: [string, () => HTMLButtonElement, string, () => HTMLElement][] = [
  ["Plus", () => icon("Plus"), "docseeker-more", () => icon("Plus")],
  ["Spécifier le chemin", () => icon("Spécifier le chemin"), "docseeker-path", () => icon("Spécifier le chemin")],
  // L'icône d'historique remet le focus au champ (le menu appartient au champ).
  ["icône d'historique", historyIcon, "docseeker-history", input],
];

describe("un menu ouvert par un clic reste ouvert (le clic remonte jusqu'à window, où SiYuan ferme les menus)", () => {
  it.each(BUTTONS)("clic souris sur « %s » : le menu est ouvert APRÈS le clic, avec son identifiant", (_name, button, id) => {
    button().click();
    expect(current()?.opened).toBe(true);
    expect(current()?.id).toBe(id);
  });

  it.each(BUTTONS)("activation au clavier (Entrée/Espace -> click detail 0) sur « %s » : le menu reste ouvert", (_name, button) => {
    keyboardClick(button());
    expect(current()?.opened).toBe(true);
  });

  it.each(BUTTONS)("« %s » : rebascule, un second clic referme ; il se rouvre au troisième", (_name, button) => {
    button().click();
    expect(current()?.opened).toBe(true);
    button().click();
    expect(current()).toBeUndefined();
    button().click();
    expect(current()?.opened).toBe(true);
  });

  it.each(BUTTONS)("« %s » : un clic sur un AUTRE bouton remplace le menu dès le premier clic", (name, button, id) => {
    button().click();
    const first = current()!;
    const other = BUTTONS.find(([n]) => n !== name)!;
    other[1]().click();
    expect(first.opened).toBe(false);
    expect(current()?.opened).toBe(true);
    expect(current()?.id).toBe(other[2]);
    expect(current()?.id).not.toBe(id);
  });

  it.each(BUTTONS)("« %s » : un clic ailleurs dans la page referme le menu et rend le focus", (_name, button, _id, focusTarget) => {
    button().focus(); // un vrai clic focalise le bouton (jsdom : `click()` ne le fait pas)
    button().click();
    document.body.click();
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(focusTarget());
  });

  it("Alt+Bas dans le champ : le menu d'historique est ouvert", () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    expect(current()?.opened).toBe(true);
    expect(current()?.id).toBe("docseeker-history");
  });

  it("le menu « Plus » contient Tri et Groupe, rendus comme des sous-menus", () => {
    icon("Plus").click();
    expect(current()!.items.map((i) => i.label)).toEqual(["Tri", "Groupe"]);
    expect(current()!.element.querySelectorAll(":scope > .b3-menu__items > .b3-menu__item > .b3-menu__submenu")).toHaveLength(2);
  });

  it("un clic sur un PARENT de sous-menu (Tri) ne ferme pas le menu et n'applique rien (SiYuan n'y met aucun écouteur)", () => {
    icon("Plus").click();
    itemByLabel("Tri").click();
    expect(current()?.opened).toBe(true);
    expect(setOptions).not.toHaveBeenCalled();
  });
});

describe("clavier : le premier élément est focalisé à l'ouverture", () => {
  it.each([
    ["Plus", "Tri", () => icon("Plus")],
    ["Spécifier le chemin", "Tous les chemins", () => icon("Spécifier le chemin")],
    ["icône d'historique", "chat", historyIcon],
  ])("« %s » : l'élément actif est « %s » (et il porte la classe courante)", (_name, expected, button) => {
    button().click();
    expect(labelOf(document.activeElement)).toBe(expected);
    expect(document.activeElement!.classList.contains("b3-menu__item--current")).toBe(true);
  });

  it("Alt+Bas dans le champ : le premier élément de l'historique prend le focus", () => {
    input().focus();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    expect(labelOf(document.activeElement)).toBe("chat");
  });

  it("Bas puis Entrée dans le menu des dossiers : le dossier est choisi, le focus revient au bouton", () => {
    icon("Spécifier le chemin").focus();
    icon("Spécifier le chemin").click();
    press("ArrowDown"); // « Tous les chemins » -> « assets »
    press("Enter");
    expect(opts.filters.folder).toBe("assets/");
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(icon("Spécifier le chemin"));
  });

  it("Plus > Tri au clavier : Entrée ouvre le sous-menu, Bas descend, Entrée choisit ; le focus revient à « Plus »", () => {
    icon("Plus").focus();
    icon("Plus").click();
    press("Enter"); // « Tri » -> ouvre le sous-menu
    expect(current()?.opened).toBe(true);
    press("ArrowDown"); // « Pertinence » -> « ASC de pertinence »
    press("Enter");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(opts.sort).toEqual({ key: "relevance", direction: "asc" });
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(icon("Plus"));
  });
});

describe("fermeture par Échap : le focus revient à l'élément ouvrant", () => {
  it.each(BUTTONS)("« %s » : Échap ferme le menu et rend le focus", (_name, button, _id, focusTarget) => {
    button().focus();
    button().click();
    expect(document.activeElement).not.toBe(focusTarget()); // un item de menu a le focus
    press("Escape");
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(focusTarget());
  });

  it("Alt+Bas puis Échap : le focus revient au champ de recherche", () => {
    input().focus();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    press("Escape");
    expect(document.activeElement).toBe(input());
  });
});

describe("un choix applique, ferme, et rend le focus (SiYuan appelle closeCB avant de vider le menu : le focus tombait sur BODY)", () => {
  it("choisir un dossier : filtre appliqué une fois, menu fermé, focus sur « Spécifier le chemin »", () => {
    icon("Spécifier le chemin").focus();
    icon("Spécifier le chemin").click();
    itemByLabel("  a").click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(opts.filters.folder).toBe("assets/a/");
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(icon("Spécifier le chemin"));
  });

  it("choisir un tri via Plus > Tri : setOptions une fois, focus sur « Plus »", () => {
    icon("Plus").focus();
    icon("Plus").click();
    itemByLabel("Nom croissant").click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(opts.sort).toEqual({ key: "name", direction: "asc" });
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(icon("Plus"));
  });

  it("choisir un regroupement via Plus > Groupe : liste plate, focus sur « Plus »", () => {
    icon("Plus").focus();
    icon("Plus").click();
    itemByLabel("Aucun regroupement").click();
    expect(host.querySelector(".docseeker-list--flat")).not.toBeNull();
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(icon("Plus"));
  });

  it("choisir une requête de l'historique : champ rempli, recherche lancée, menu refermé, focus au champ", () => {
    historyIcon().click();
    itemByLabel("chien").click();
    expect(input().value).toBe("chien");
    expect(submit).toHaveBeenCalledWith("chien");
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(input());
  });

  it("« Supprimer tout l'historique » : historique vidé, aucune recherche, focus au champ", () => {
    historyIcon().focus();
    historyIcon().click();
    itemByLabel("Supprimer tout l'historique").click();
    expect(historyClear).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(input());
  });
});

describe("libellés issus des données : du texte, jamais du HTML (SiYuan insère les libellés en innerHTML)", () => {
  it("dossiers « A & B » et « <i>x</i> » : le texte est affiché tel quel, aucune balise créée dans le menu", () => {
    folders = ["A & B/", "<i>x</i>/"]; // le « / » de « </i> » fait de la seconde entrée un dossier à deux segments
    icon("Spécifier le chemin").click();
    const menu = current()!.element;
    expect(labelOf(itemByLabel("A & B"))).toBe("A & B");
    expect(labelOf(itemByLabel("\u00a0\u00a0<i>x</i>"))).toBe("\u00a0\u00a0<i>x</i>");
    expect(menu.querySelector("i")).toBeNull();
    expect(menu.querySelector("b")).toBeNull();
  });

  it("requête d'historique « <b>x</b> & y » : texte tel quel, aucune balise", () => {
    history = ["<b>x</b> & y"];
    historyIcon().click();
    const menu = current()!.element;
    expect(labelOf(itemByLabel("<b>x</b> & y"))).toBe("<b>x</b> & y");
    expect(menu.querySelector("b")).toBeNull();
  });

  it("caractères bidi et de contrôle retirés des dossiers comme de l'historique", () => {
    folders = ["fi‮gp.exe/"];
    history = ["req⁦uete\u0007"];
    icon("Spécifier le chemin").click();
    expect(itemByLabel("figp.exe")).toBeTruthy();
    historyIcon().click();
    expect(itemByLabel("requete ")).toBeTruthy();
  });

  it("sélectionner une requête à caractères spéciaux remplit le champ avec le texte ORIGINAL (le nettoyage ne touche que le libellé)", () => {
    history = ["a​b"];
    historyIcon().click();
    itemByLabel("ab").click();
    expect(input().value).toBe("a​b");
    expect(submit).toHaveBeenCalledWith("a​b");
  });
});

describe("dialogue « Filtres » ouvert par un clic", () => {
  const filtersButton = () => host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label^="Filtres"]')!;
  const confirmButton = (d: StubDialog) => d.element.querySelector<HTMLButtonElement>("button.b3-button--text")!;
  const cancelButton = (d: StubDialog) => d.element.querySelector<HTMLButtonElement>("button.b3-button--cancel")!;
  const nameField = (d: StubDialog) => d.element.querySelector<HTMLInputElement>("input[type=search]")!;

  it("reste ouvert après le clic (aucun gestionnaire global ne ferme un dialogue)", () => {
    icon("Filtres").click();
    expect(stubs.Dialog.instances).toHaveLength(1);
    expect(stubs.Dialog.instances[0]!.destroyCount).toBe(0);
    expect(stubs.Dialog.instances[0]!.element.isConnected).toBe(true);
  });

  it("activation au clavier : même résultat", () => {
    keyboardClick(icon("Filtres"));
    expect(stubs.Dialog.instances[0]!.destroyCount).toBe(0);
  });

  it("un menu resté ouvert est refermé par le clic sur « Filtres » (le clic remonte), et le dialogue s'ouvre", () => {
    icon("Plus").click();
    expect(current()?.opened).toBe(true);
    icon("Filtres").click();
    expect(current()).toBeUndefined();
    expect(stubs.Dialog.instances).toHaveLength(1);
  });

  it("Confirmer applique les filtres et ferme ; un seul destroy, un seul setOptions, focus sur « Filtres »", () => {
    icon("Filtres").click();
    const d = stubs.Dialog.instances[0]!;
    nameField(d).value = "abc";
    confirmButton(d).click();
    expect(opts.filters.nameContains).toBe("abc");
    expect(d.destroyCount).toBe(1);
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(filtersButton());
  });

  it("Confirmer deux fois de suite : un seul setOptions", () => {
    icon("Filtres").click();
    const d = stubs.Dialog.instances[0]!;
    nameField(d).value = "abc";
    confirmButton(d).click();
    confirmButton(d).click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(d.destroyCount).toBe(1);
  });

  it("Annuler après modification : rien n'appliqué, focus sur « Filtres »", () => {
    icon("Filtres").click();
    const d = stubs.Dialog.instances[0]!;
    nameField(d).value = "abc";
    cancelButton(d).click();
    expect(setOptions).not.toHaveBeenCalled();
    expect(opts.filters.nameContains).toBe("");
    expect(document.activeElement).toBe(filtersButton());
  });

  it("Échap dans le dialogue : annule, rien n'est appliqué, focus sur « Filtres »", () => {
    icon("Filtres").click();
    press("Escape");
    expect(stubs.Dialog.instances[0]!.destroyCount).toBe(1);
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(filtersButton());
  });

  describe("destruction différée de SiYuan (destroyCallback après un délai)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      stubs.Dialog.destroyDelayMs = 50;
    });

    it("Confirmer : setOptions une fois tout de suite ; le focus n'est posé sur « Filtres » qu'APRÈS la destruction effective", () => {
      icon("Filtres").click();
      const d = stubs.Dialog.instances[0]!;
      nameField(d).value = "abc";
      confirmButton(d).click();
      expect(setOptions).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(filtersButton());
      expect(d.element.isConnected).toBe(true);
      vi.advanceTimersByTime(60);
      expect(d.element.isConnected).toBe(false);
      expect(document.activeElement).toBe(filtersButton());
      expect(setOptions).toHaveBeenCalledTimes(1);
    });

    it("pendant la destruction, un clic sur « Filtres » n'ouvre pas un second dialogue ; après, la réouverture est possible", () => {
      icon("Filtres").click();
      confirmButton(stubs.Dialog.instances[0]!).click();
      icon("Filtres").click();
      expect(stubs.Dialog.instances).toHaveLength(1);
      vi.advanceTimersByTime(60);
      icon("Filtres").click();
      expect(stubs.Dialog.instances).toHaveLength(2);
    });

    it("Annuler : rien appliqué, focus sur « Filtres » seulement à la fin du délai", () => {
      icon("Filtres").click();
      cancelButton(stubs.Dialog.instances[0]!).click();
      expect(document.activeElement).not.toBe(filtersButton());
      vi.advanceTimersByTime(60);
      expect(document.activeElement).toBe(filtersButton());
      expect(setOptions).not.toHaveBeenCalled();
    });
  });

  it("dialogue retiré par SiYuan sans destroyCallback : « Filtres » peut en rouvrir un", () => {
    icon("Filtres").click();
    stubs.Dialog.instances[0]!.element.remove();
    icon("Filtres").click();
    expect(stubs.Dialog.instances).toHaveLength(2);
  });

  it("un setOptions externe pendant le dialogue : le dossier modifié entre-temps n'est pas écrasé par Confirmer", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, folder: "assets/a/" } };
    icon("Filtres").click();
    const d = stubs.Dialog.instances[0]!;
    opts = { ...opts, filters: { ...opts.filters, folder: "assets/" } }; // changement externe
    nameField(d).value = "abc";
    confirmButton(d).click();
    expect(opts.filters.folder).toBe("assets/");
    expect(opts.filters.nameContains).toBe("abc");
  });
});

describe("dispose de la vue avec un menu ou un dialogue ouvert", () => {
  it("menu « Plus » ouvert : fermé par dispose, aucun focus rendu à un bouton détaché", () => {
    icon("Plus").focus();
    icon("Plus").click();
    view!.dispose();
    view = undefined;
    expect(current()).toBeUndefined();
    expect(host.querySelector(".docseeker-icons")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("menu d'historique ouvert : fermé par dispose", () => {
    historyIcon().click();
    view!.dispose();
    view = undefined;
    expect(current()).toBeUndefined();
    expect(document.activeElement).toBe(document.body);
  });

  it("dialogue ouvert : détruit par dispose (un seul destroy), rien appliqué, et la feuille de style reste présente", () => {
    icon("Filtres").click();
    const d = stubs.Dialog.instances[0]!;
    view!.dispose();
    view = undefined;
    expect(d.destroyCount).toBe(1);
    expect(d.element.isConnected).toBe(false);
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.getElementById(SEARCH_STYLE_ID)).not.toBeNull();
  });

  it("dialogue avec destruction différée : dispose ne rend le focus à rien et rien n'est appliqué à la fin du délai", () => {
    vi.useFakeTimers();
    stubs.Dialog.destroyDelayMs = 50;
    icon("Filtres").click();
    view!.dispose();
    view = undefined;
    vi.advanceTimersByTime(60);
    expect(setOptions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
