// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SearchViewModel } from "../../../src/search/searchController";
import { mountSearchView, type SearchView, type SearchViewDeps } from "../../../src/ui/searchView";
import { createNativeFakes, findItem, pick } from "./nativeFakes";

const XLINK = "http://www.w3.org/1999/xlink";
let host: HTMLElement;
let vm: SearchViewModel;
let submit: Mock;
let view: SearchView | undefined;
let fakes: ReturnType<typeof createNativeFakes>;

function fakeHistory(initial: string[]) {
  let list = [...initial];
  return {
    get: vi.fn(() => list),
    add: vi.fn((q: string) => {
      list = [q, ...list.filter((x) => x !== q)];
    }),
    clear: vi.fn(() => {
      list = [];
    }),
  };
}

function mount(history: ReturnType<typeof fakeHistory> | undefined, extra: Partial<SearchViewDeps> = {}, where: HTMLElement = host): SearchView {
  view = mountSearchView(where, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => () => undefined },
    onOpen: vi.fn(),
    getDocMeta: () => ({ pdfSize: 1, pdfModifiedMs: 2 }),
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...(history ? { history } : {}),
    ...extra,
  });
  return view;
}
const input = () => host.querySelector<HTMLInputElement>("input")!;
const historyIcon = () => host.querySelector<HTMLButtonElement>("button.docseeker-history-icon");
const clearBtn = () => host.querySelector<HTMLButtonElement>("button.docseeker-clear")!;
const labels = () => fakes.lastMenu().items.map((i) => (i.separator ? "---" : i.label));
const CLEAR = "Supprimer tout l'historique";

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(e);
  return e;
}
const altDown = () => press("ArrowDown", { altKey: true });
const withCard = (): SearchViewModel => ({
  kind: "results", query: "chat", partial: false, total: 1, failedCount: 0, ranking: "bm25", hiddenByFilters: 0,
  docs: [{ docId: "a", title: "A", path: "/a.pdf", matchingPages: 1, relevance: 1, pages: [{ page: 1, score: 1 }] }],
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  submit = vi.fn();
  fakes = createNativeFakes();
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.restoreAllMocks();
});

describe("champ de recherche : structure (icône d'historique, croix « Effacer »)", () => {
  it("sans deps.history : pas d'icône d'historique, le champ reste un champ de recherche simple", () => {
    mount(undefined);
    expect(historyIcon()).toBeNull();
    expect(input().type).toBe("search");
  });

  it("plus de combobox ni de liste maison : aucun rôle combobox/listbox/option, aucune aria-expanded", () => {
    mount(fakeHistory(["a"]));
    altDown();
    expect(host.querySelector('[role="combobox"], [role="listbox"], [role="option"], [aria-expanded], [aria-activedescendant]')).toBeNull();
    expect(host.querySelector(".docseeker-history-list, .docseeker-history-toggle, .docseeker-history-option")).toBeNull();
  });

  it("icône d'historique : vrai <button type=button>, aria-label « ⌥↓ », svg #iconSearch + svg.search__arrowdown #iconDown", () => {
    mount(fakeHistory(["a"]));
    const b = historyIcon()!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("⌥↓");
    expect(b.classList.contains("ariaLabel")).toBe(true);
    expect(b.getAttribute("data-position")).toBe("9south");
    const svgs = Array.from(b.querySelectorAll("svg"));
    expect(svgs).toHaveLength(2);
    expect(svgs[0]!.querySelector("use")!.getAttributeNS(XLINK, "href")).toBe("#iconSearch");
    expect(svgs[1]!.classList.contains("search__arrowdown")).toBe(true);
    expect(svgs[1]!.querySelector("use")!.getAttributeNS(XLINK, "href")).toBe("#iconDown");
    expect(svgs[0]!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("croix « Effacer » : <button type=button> aria-label « Effacer », svg #iconCloseRound", () => {
    mount(fakeHistory([]));
    const b = clearBtn();
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("Effacer");
    expect(b.querySelector("svg")!.classList.contains("b3-form__icon-clear")).toBe(true);
    expect(b.querySelector("use")!.getAttributeNS(XLINK, "href")).toBe("#iconCloseRound");
  });

  it("la croix existe aussi sans historique", () => {
    mount(undefined);
    expect(clearBtn()).not.toBeNull();
  });

  it("ordre de tabulation : champ, icône d'historique, croix (visible) — le champ reste le premier arrêt", () => {
    mount(fakeHistory(["a"]));
    input().value = "x";
    input().dispatchEvent(new Event("input"));
    const box = host.querySelector(".docseeker-search-box")!;
    const tabbables = Array.from(box.querySelectorAll<HTMLElement>("input, button")).filter((e) => !e.hidden && e.tabIndex >= 0);
    expect(tabbables).toEqual([input(), historyIcon(), clearBtn()]);
  });

  it("aucune région live ni texte masqué ajouté pour l'historique ou la croix", () => {
    mount(fakeHistory(["a"]));
    altDown();
    const box = input().closest(".docseeker-search-box")!;
    expect(box.querySelector("[aria-live], [role=status], [role=alert], [aria-hidden]")).toBeNull();
  });

  it("n'écrit jamais innerHTML", () => {
    const setter = vi.spyOn(Element.prototype, "innerHTML", "set");
    mount(fakeHistory(["<b>x</b>"]));
    historyIcon()!.click();
    clearBtn().click();
    expect(setter).not.toHaveBeenCalled();
  });
});

describe("croix « Effacer »", () => {
  it("cachée quand le champ est vide ; visible dès qu'il y a du texte ; recachée quand il est vidé", () => {
    mount(undefined);
    expect(clearBtn().hidden).toBe(true);
    input().value = "chat";
    input().dispatchEvent(new Event("input"));
    expect(clearBtn().hidden).toBe(false);
    input().value = "";
    input().dispatchEvent(new Event("input"));
    expect(clearBtn().hidden).toBe(true);
  });

  it("clic : vide le champ, relance la requête vide (submit(\"\")), rend le focus au champ, se cache, ne mémorise rien", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    input().value = "chat";
    input().dispatchEvent(new Event("input"));
    clearBtn().focus();
    clearBtn().click();
    expect(input().value).toBe("");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(input());
    expect(clearBtn().hidden).toBe(true);
    expect(history.add).not.toHaveBeenCalled();
  });

  it("Échap dans le champ (vider) cache aussi la croix", () => {
    mount(undefined);
    input().value = "chat";
    input().dispatchEvent(new Event("input"));
    press("Escape");
    expect(input().value).toBe("");
    expect(clearBtn().hidden).toBe(true);
  });

  it("un texte rempli par un choix de l'historique montre la croix", () => {
    mount(fakeHistory(["chat"]));
    historyIcon()!.click();
    pick(fakes.lastMenu(), "chat");
    expect(clearBtn().hidden).toBe(false);
  });

  it("la croix native du type=search est masquée par le CSS (une seule croix visible)", async () => {
    const { SEARCH_CSS } = await import("../../../src/ui/searchStyles");
    expect(SEARCH_CSS).toMatch(/::-webkit-search-cancel-button\s*\{[^}]*display:\s*none/);
  });
});

describe("menu d'historique : ouverture", () => {
  it("clic sur l'icône : UN menu (requêtes, séparateur, « Supprimer tout l'historique »)", () => {
    mount(fakeHistory(["chat", "chien"]));
    historyIcon()!.click();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(["chat", "chien", "---", CLEAR]);
  });

  it("Alt+Bas dans le champ : même menu, événement annulé, focus toujours au champ", () => {
    mount(fakeHistory(["chat"]));
    view!.focusInput();
    const e = altDown();
    expect(e.defaultPrevented).toBe(true);
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(["chat", "---", CLEAR]);
    expect(document.activeElement).toBe(input());
  });

  it("Alt+Bas ne saute PAS à la première carte de résultat, même avec des résultats", () => {
    vm = withCard();
    mount(fakeHistory(["a"]));
    view!.focusInput();
    altDown();
    expect(document.activeElement).toBe(input());
  });

  it("Bas seul saute toujours à la carte (clavier des cartes inchangé)", () => {
    vm = withCard();
    mount(fakeHistory(["a"]));
    view!.focusInput();
    press("ArrowDown");
    expect(document.activeElement).toBe(host.querySelector("button.docseeker-card"));
    expect(fakes.openMenu).not.toHaveBeenCalled();
  });

  it("Alt+Bas sans deps.history : aucun menu, événement non annulé, pas de saut à la carte", () => {
    vm = withCard();
    mount(undefined);
    view!.focusInput();
    const e = altDown();
    expect(e.defaultPrevented).toBe(false);
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input());
  });

  it("Alt+Maj+Bas, Ctrl+Alt+Bas et Alt+Bas en composition IME : rien", () => {
    mount(fakeHistory(["a"]));
    press("ArrowDown", { altKey: true, shiftKey: true });
    press("ArrowDown", { altKey: true, ctrlKey: true });
    press("ArrowDown", { altKey: true, isComposing: true });
    expect(fakes.openMenu).not.toHaveBeenCalled();
  });

  it("l'ancre est le cadre du champ (bas-gauche, largeur, hauteur)", () => {
    mount(fakeHistory(["a"]));
    const box = host.querySelector<HTMLElement>(".docseeker-search-box")!;
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ left: 8, bottom: 48, width: 304, height: 32 } as DOMRect);
    historyIcon()!.click();
    expect(fakes.lastMenu().anchor).toEqual({ x: 8, y: 48, w: 304, h: 32 });
  });

  it("l'historique est relu à chaque ouverture", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    historyIcon()!.click();
    history.add("b");
    historyIcon()!.click();
    expect(labels()).toEqual(["b", "a", "---", CLEAR]);
  });

  it("le texte des entrées est transmis tel quel (l'adaptateur échappe ; la vue n'interprète rien)", () => {
    mount(fakeHistory(["<b>x</b> & y"]));
    historyIcon()!.click();
    expect(fakes.lastMenu().items[0]!.label).toBe("<b>x</b> & y");
  });

  it("historique VIDE : le menu s'ouvre avec un seul élément désactivé « Historique vide » (ni séparateur ni « Supprimer tout »)", () => {
    mount(fakeHistory([]));
    historyIcon()!.click();
    expect(fakes.lastMenu().items).toHaveLength(1);
    expect(fakes.lastMenu().items[0]).toMatchObject({ label: "Historique vide", disabled: true });
    expect(fakes.lastMenu().items[0]!.click).toBeUndefined();
  });

  it("historique vide et Alt+Bas : même menu, événement annulé (pas de saut à la carte)", () => {
    vm = withCard();
    mount(fakeHistory([]));
    view!.focusInput();
    const e = altDown();
    expect(e.defaultPrevented).toBe(true);
    expect(labels()).toEqual(["Historique vide"]);
    expect(document.activeElement).toBe(input());
  });

  it("le focus n'est pas géré par la vue : le rappel de fermeture ne le déplace pas (l'adaptateur le rend à l'élément ouvrant)", () => {
    mount(fakeHistory(["a"]));
    historyIcon()!.click();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    const onClose = fakes.openMenu.mock.calls[0]![2];
    expect(typeof onClose).toBe("function"); // le rappel existe vraiment (un `?.()` sur undefined ne prouverait rien)
    onClose!();
    expect(document.activeElement).toBe(elsewhere);
    // ... et le rappel a bien baissé l'état « menu ouvert » : le menu est considéré fermé (une réouverture ne passe pas par un handle périmé)
    historyIcon()!.click();
    expect(fakes.openMenu).toHaveBeenCalledTimes(2);
  });

  it("le clic sur l'icône place d'abord le focus dans le champ : c'est lui que le menu retrouvera à sa fermeture", () => {
    mount(fakeHistory(["a"]));
    historyIcon()!.focus();
    historyIcon()!.click();
    expect(document.activeElement).toBe(input());
  });
});

describe("menu d'historique : le clic d'ouverture ne doit pas atteindre window (SiYuan ferme alors le menu aussitôt)", () => {
  it("clic souris sur l'icône : n'atteint ni document ni window", () => {
    mount(fakeHistory(["a"]));
    const onDoc = vi.fn();
    const onWin = vi.fn();
    document.addEventListener("click", onDoc);
    window.addEventListener("click", onWin);
    try {
      historyIcon()!.click();
    } finally {
      document.removeEventListener("click", onDoc);
      window.removeEventListener("click", onWin);
    }
    expect(onDoc).not.toHaveBeenCalled();
    expect(onWin).not.toHaveBeenCalled();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
  });

  it("activation au clavier (Entrée/Espace -> click detail 0) : idem", () => {
    mount(fakeHistory(["a"]));
    const onDoc = vi.fn();
    document.addEventListener("click", onDoc);
    try {
      historyIcon()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    } finally {
      document.removeEventListener("click", onDoc);
    }
    expect(onDoc).not.toHaveBeenCalled();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
  });

  it("Alt+Bas traité : la frappe n'atteint pas document (aucun raccourci global de SiYuan ne la reprend)", () => {
    mount(fakeHistory(["a"]));
    const onDoc = vi.fn();
    document.addEventListener("keydown", onDoc);
    try {
      altDown();
      press("a"); // une autre touche, elle, remonte normalement
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
    expect(onDoc).toHaveBeenCalledTimes(1);
    expect((onDoc.mock.calls[0]![0] as KeyboardEvent).key).toBe("a");
  });

  it("Alt+Bas non traité (pas d'historique branché) : la frappe remonte normalement", () => {
    mount(undefined);
    const onDoc = vi.fn();
    document.addEventListener("keydown", onDoc);
    try {
      altDown();
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
    expect(onDoc).toHaveBeenCalledTimes(1);
  });

  it("l'icône porte data-menu=\"true\" et le menu l'identifiant « docseeker-history » (le même pour Alt+Bas)", () => {
    mount(fakeHistory(["a"]));
    expect(historyIcon()!.getAttribute("data-menu")).toBe("true");
    historyIcon()!.click();
    altDown();
    expect(fakes.openMenu.mock.calls.map((c) => c[3])).toEqual(["docseeker-history", "docseeker-history"]);
  });

  it("la croix « Effacer » n'ouvre rien : son clic remonte (SiYuan peut fermer un menu resté ouvert)", () => {
    mount(fakeHistory(["a"]));
    input().value = "x";
    input().dispatchEvent(new Event("input"));
    const onDoc = vi.fn();
    document.addEventListener("click", onDoc);
    try {
      clearBtn().click();
    } finally {
      document.removeEventListener("click", onDoc);
    }
    expect(onDoc).toHaveBeenCalledTimes(1);
  });
});

describe("menu d'historique : choix", () => {
  it("une requête : remplit le champ ET lance la recherche, la mémorise, focus au champ", () => {
    const history = fakeHistory(["chat", "chien"]);
    mount(history);
    historyIcon()!.click();
    pick(fakes.lastMenu(), "chien");
    expect(input().value).toBe("chien");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("chien");
    expect(history.add).toHaveBeenCalledWith("chien");
    expect(document.activeElement).toBe(input());
  });

  it("« Supprimer tout l'historique » : vide l'historique, ne lance aucune recherche, ne touche pas au champ", () => {
    const history = fakeHistory(["chat"]);
    mount(history);
    input().value = "texte";
    historyIcon()!.click();
    pick(fakes.lastMenu(), CLEAR);
    expect(history.clear).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(input().value).toBe("texte");
    historyIcon()!.click();
    expect(labels()).toEqual(["Historique vide"]);
  });

  it("le séparateur est un élément séparateur sans action ni libellé", () => {
    mount(fakeHistory(["a"]));
    historyIcon()!.click();
    const sep = fakes.lastMenu().items[1]!;
    expect(sep.separator).toBe(true);
    expect(sep.click).toBeUndefined();
    expect(sep.label).toBeUndefined();
  });
});

describe("historique : requêtes soumises", () => {
  it("Entrée dans le champ mémorise la requête", () => {
    const history = fakeHistory([]);
    mount(history);
    input().value = "  chat  ";
    press("Enter");
    expect(submit).toHaveBeenCalledWith("  chat  ");
    expect(history.add).toHaveBeenCalledWith("  chat  ");
  });

  it("une requête vide ou d'espaces n'est pas mémorisée", () => {
    const history = fakeHistory([]);
    mount(history);
    input().value = "   ";
    press("Enter");
    input().value = "";
    press("Enter");
    expect(history.add).not.toHaveBeenCalled();
  });

  it("Échap (requête vide) et croix du champ ne mémorisent rien", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    input().value = "x";
    press("Escape");
    input().value = "";
    input().dispatchEvent(new Event("search"));
    expect(history.add).not.toHaveBeenCalled();
  });
});

describe("cycle de vie", () => {
  it("dispose retire l'icône et la croix ; aucun écouteur sur document n'a été ajouté", () => {
    const added: string[] = [];
    const spy = vi.spyOn(document, "addEventListener").mockImplementation((type: string) => {
      added.push(type);
    });
    mount(fakeHistory(["a"]));
    spy.mockRestore();
    expect(added).toEqual([]);
    view!.dispose();
    view = undefined;
    expect(host.querySelector(".docseeker-history-icon, .docseeker-clear")).toBeNull();
  });

  it("dispose avec le menu d'historique ouvert : le menu est fermé (handle.close)", () => {
    mount(fakeHistory(["a"]));
    historyIcon()!.click();
    const menu = fakes.lastMenu();
    view!.dispose();
    view = undefined;
    expect(menu.closed).toBe(true);
  });

  it("dispose, puis un clic tardif sur une requête de l'historique : ni champ rempli, ni recherche, ni mémorisation", () => {
    const history = fakeHistory(["chat"]);
    mount(history);
    historyIcon()!.click();
    const menu = fakes.lastMenu();
    const field = input();
    view!.dispose();
    view = undefined;
    findItem(menu.items, "chat").click!();
    expect(field.value).toBe("");
    expect(submit).not.toHaveBeenCalled();
    expect(history.add).not.toHaveBeenCalled();
  });

  it("dispose, puis un clic tardif sur « Supprimer tout l'historique » : l'historique n'est pas vidé", () => {
    const history = fakeHistory(["chat"]);
    mount(history);
    historyIcon()!.click();
    const menu = fakes.lastMenu();
    view!.dispose();
    view = undefined;
    findItem(menu.items, CLEAR).click!();
    expect(history.clear).not.toHaveBeenCalled();
  });

  it("dispose sans menu ouvert : aucun close, aucune erreur", () => {
    mount(fakeHistory(["a"]));
    expect(() => view!.dispose()).not.toThrow();
    view = undefined;
    expect(fakes.openMenu).not.toHaveBeenCalled();
  });
});
