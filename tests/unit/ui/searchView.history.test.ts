// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SearchViewModel } from "../../../src/search/searchController";
import { mountSearchView, type SearchView, type SearchViewDeps } from "../../../src/ui/searchView";

let host: HTMLElement;
let vm: SearchViewModel;
let submit: Mock;
let view: SearchView | undefined;

function fakeHistory(initial: string[]) {
  let list = [...initial];
  return {
    get: vi.fn(() => list),
    add: vi.fn((q: string) => {
      list = [q, ...list.filter((x) => x !== q)];
    }),
    remove: vi.fn((q: string) => {
      list = list.filter((x) => x !== q);
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
    ...(history ? { history } : {}),
    ...extra,
  });
  return view;
}
const input = () => host.querySelector<HTMLInputElement>("input")!;
const listbox = () => host.querySelector<HTMLElement>('[role="listbox"]');
const optionEls = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
const optionTexts = () => optionEls().map((o) => o.textContent);
const toggle = () => host.querySelector<HTMLButtonElement>("button.docseeker-history-toggle");
const isOpen = () => input().getAttribute("aria-expanded") === "true";
const active = () => input().getAttribute("aria-activedescendant");
const activeText = () => optionEls().find((o) => o.id === active())?.textContent;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(e);
  return e;
}
const altDown = () => press("ArrowDown", { altKey: true });
const CLEAR = "Supprimer tout l'historique";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  submit = vi.fn();
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.restoreAllMocks();
});

describe("historique : structure combobox", () => {
  it("sans deps.history : aucun combobox, aucun bouton, aucune liste", () => {
    mount(undefined);
    expect(input().getAttribute("role")).toBeNull();
    expect(toggle()).toBeNull();
    expect(listbox()).toBeNull();
  });

  it("avec deps.history : champ combobox fermé, relié à une liste masquée", () => {
    mount(fakeHistory(["a"]));
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-haspopup")).toBe("listbox");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    const list = listbox()!;
    expect(list.tagName).toBe("UL");
    expect(list.id).not.toBe("");
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    expect(list.hidden).toBe(true);
    expect(list.getAttribute("aria-label")).toBe("Historique des requêtes");
  });

  it("deux vues : identifiants de liste distincts", () => {
    mount(fakeHistory(["a"]));
    const first = listbox()!.id;
    const other = document.createElement("div");
    document.body.appendChild(other);
    const second = mountSearchView(other, {
      controller: { submit: vi.fn(), getViewModel: () => vm },
      subscribe: () => () => undefined,
      thumbnails: { attach: () => () => undefined },
      onOpen: vi.fn(),
      getDocMeta: () => undefined,
      history: fakeHistory(["b"]),
    });
    expect(other.querySelector('[role="listbox"]')!.id).not.toBe(first);
    second.dispose();
  });

  it("aucune région live ni texte masqué ajouté pour l'historique", () => {
    mount(fakeHistory(["a"]));
    altDown();
    const box = input().closest(".docseeker-search-box")!;
    expect(box.querySelector("[aria-live]")).toBeNull();
    expect(box.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(box.querySelector("[aria-hidden]")).toBeNull();
  });

  it("bouton « Historique » : tabindex -1, nom constant, cible de 32 px par CSS", () => {
    mount(fakeHistory(["a"]));
    const b = toggle()!;
    expect(b.tabIndex).toBe(-1);
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("Afficher l'historique des requêtes");
    expect(b.getAttribute("aria-controls")).toBe(listbox()!.id);
    b.click();
    expect(b.getAttribute("aria-label")).toBe("Afficher l'historique des requêtes");
    expect(b.hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("historique : ouverture et options", () => {
  it("Alt+Bas ouvre la liste : requêtes puis « Supprimer tout l'historique », focus dans le champ, événement annulé", () => {
    mount(fakeHistory(["chien", "chat"]));
    input().focus();
    const e = altDown();
    expect(e.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(listbox()!.hidden).toBe(false);
    expect(optionTexts()).toEqual(["chien", "chat", CLEAR]);
    expect(optionEls().every((o) => o.id !== "")).toBe(true);
    expect(new Set(optionEls().map((o) => o.id)).size).toBe(3);
    expect(document.activeElement).toBe(input());
    expect(active()).toBeNull();
    expect(optionEls().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("historique vide : Alt+Bas ne s'ouvre pas et n'est pas annulé", () => {
    mount(fakeHistory([]));
    input().focus();
    const e = altDown();
    expect(isOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(listbox()!.hidden).toBe(true);
  });

  it("le texte des entrées passe par textContent (aucun HTML interprété)", () => {
    mount(fakeHistory(['<img src=x onerror="alert(1)">&amp;']));
    altDown();
    expect(listbox()!.querySelector("img")).toBeNull();
    expect(optionTexts()[0]).toBe('<img src=x onerror="alert(1)">&amp;');
  });

  it("la liste se relit à chaque ouverture", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    altDown();
    expect(optionTexts()).toEqual(["a", CLEAR]);
    press("Escape");
    history.add("b");
    altDown();
    expect(optionTexts()).toEqual(["b", "a", CLEAR]);
  });

  it("bouton : ouvre, rend le focus au champ, referme au second clic ; vide : n'ouvre pas", () => {
    mount(fakeHistory(["a"]));
    toggle()!.click();
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(input());
    toggle()!.click();
    expect(isOpen()).toBe(false);
    view!.dispose();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(fakeHistory([]));
    toggle()!.click();
    expect(isOpen()).toBe(false);
  });

  it("mousedown sur le bouton et sur une option : preventDefault (le focus reste dans le champ)", () => {
    mount(fakeHistory(["a"]));
    const b = toggle()!;
    expect(b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))).toBe(false);
    altDown();
    expect(optionEls()[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))).toBe(false);
  });
});

describe("historique : option active au clavier", () => {
  it("Bas parcourt les requêtes puis « Supprimer tout », et reboucle ; aria-activedescendant suit", () => {
    mount(fakeHistory(["a", "b"]));
    input().focus();
    altDown();
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(activeText()).toBe("a");
    expect(optionEls()[0]!.getAttribute("aria-selected")).toBe("true");
    press("ArrowDown");
    expect(activeText()).toBe("b");
    press("ArrowDown");
    expect(activeText()).toBe(CLEAR);
    press("ArrowDown");
    expect(activeText()).toBe("a");
    expect(optionEls().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(document.activeElement).toBe(input());
  });

  it("Haut depuis « aucune » va à la dernière REQUÊTE (pas à « Supprimer tout »), puis recule et reboucle", () => {
    mount(fakeHistory(["a", "b"]));
    altDown();
    press("ArrowUp");
    expect(activeText()).toBe("b");
    press("ArrowUp");
    expect(activeText()).toBe("a");
    press("ArrowUp");
    expect(activeText()).toBe(CLEAR);
  });

  it("Bas avec la liste ouverte ne saute pas à une carte de résultat", () => {
    vm = {
      kind: "results", query: "chat", partial: false, total: 1, failedCount: 0, ranking: "bm25", hiddenByFilters: 0,
      docs: [{ docId: "a", title: "A", path: "/a.pdf", matchingPages: 1, relevance: 1, pages: [{ page: 1, score: 1 }] }],
    };
    mount(fakeHistory(["a"]));
    view!.focusInput();
    altDown();
    press("ArrowDown");
    expect(document.activeElement).toBe(input());
  });

  it("Entrée sur une requête : remplit le champ ET lance la recherche, mémorise, ferme", () => {
    const history = fakeHistory(["a", "b"]);
    mount(history);
    input().value = "autre";
    altDown();
    press("ArrowDown");
    press("ArrowDown");
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(input().value).toBe("b");
    expect(submit).toHaveBeenCalledWith("b");
    expect(history.add).toHaveBeenCalledWith("b");
    expect(isOpen()).toBe(false);
    expect(listbox()!.hidden).toBe(true);
    expect(active()).toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("Entrée sur « Supprimer tout » : vide l'historique, ne lance aucune recherche, ferme", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    input().value = "garde";
    altDown();
    press("ArrowUp");
    press("ArrowDown"); // a -> CLEAR
    expect(activeText()).toBe(CLEAR);
    press("Enter");
    expect(history.clear).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(input().value).toBe("garde");
    expect(isOpen()).toBe(false);
  });

  it("Entrée sans option active : recherche normale du texte saisi, mémorisée, liste fermée", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    input().value = "chat";
    altDown();
    press("Enter");
    expect(submit).toHaveBeenCalledWith("chat");
    expect(history.add).toHaveBeenCalledWith("chat");
    expect(isOpen()).toBe(false);
  });

  it("Entrée pendant une composition IME avec la liste ouverte : rien", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    altDown();
    press("ArrowDown");
    const e = press("Enter", { isComposing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  it("Échap ferme sans vider le champ ni relancer ; Échap suivant vide (comportement actuel)", () => {
    mount(fakeHistory(["a"]));
    input().value = "chat";
    altDown();
    const e = press("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(false);
    expect(input().value).toBe("chat");
    expect(submit).not.toHaveBeenCalled();
    press("Escape");
    expect(input().value).toBe("");
    expect(submit).toHaveBeenCalledWith("");
  });

  it("Tab ferme la liste sans annuler l'événement (le focus part normalement)", () => {
    mount(fakeHistory(["a"]));
    altDown();
    const e = press("Tab");
    expect(isOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("une frappe dans le champ ferme la liste", () => {
    mount(fakeHistory(["a"]));
    altDown();
    input().value = "x";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it("les autres touches (gauche, lettres) restent au champ, liste ouverte", () => {
    mount(fakeHistory(["a"]));
    altDown();
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(press("a").defaultPrevented).toBe(false);
    expect(isOpen()).toBe(true);
  });

  it("Maj+Suppr retire la requête active et garde la liste ouverte ; la dernière retirée la ferme", () => {
    const history = fakeHistory(["a", "b"]);
    mount(history);
    altDown();
    press("ArrowDown");
    const e = press("Delete", { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(history.remove).toHaveBeenCalledWith("a");
    expect(optionTexts()).toEqual(["b", CLEAR]);
    expect(isOpen()).toBe(true);
    press("ArrowDown");
    press("Delete", { shiftKey: true });
    expect(history.remove).toHaveBeenCalledWith("b");
    expect(isOpen()).toBe(false);
  });

  it("Maj+Suppr sans option active ou sur « Supprimer tout » : rien", () => {
    const history = fakeHistory(["a"]);
    mount(history);
    altDown();
    expect(press("Delete", { shiftKey: true }).defaultPrevented).toBe(false);
    press("ArrowUp");
    press("ArrowDown"); // CLEAR
    expect(press("Delete", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(history.remove).not.toHaveBeenCalled();
    expect(history.clear).not.toHaveBeenCalled();
  });
});

describe("historique : souris", () => {
  it("clic sur une requête : remplit, lance, mémorise, ferme, focus au champ", () => {
    const history = fakeHistory(["a", "b"]);
    mount(history);
    altDown();
    optionEls()[1]!.click();
    expect(input().value).toBe("b");
    expect(submit).toHaveBeenCalledWith("b");
    expect(history.add).toHaveBeenCalledWith("b");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it("clic sur « Supprimer tout l'historique » : vide la liste, ferme", () => {
    const history = fakeHistory(["a", "b"]);
    mount(history);
    altDown();
    host.querySelector<HTMLElement>(".docseeker-history-clear")!.click();
    expect(history.clear).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("clic (mousedown) à l'extérieur ferme ; dans la liste ou sur le champ, non", () => {
    mount(fakeHistory(["a"]));
    altDown();
    optionEls()[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    input().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isOpen()).toBe(false);
    altDown();
    document.body.click();
    expect(isOpen()).toBe(false);
  });

  it("dispose retire l'écouteur du document", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    mount(fakeHistory(["a"]));
    const added = add.mock.calls.filter(([type]) => type === "mousedown" || type === "click");
    expect(added.length).toBeGreaterThan(0);
    view!.dispose();
    view = undefined;
    for (const [type, fn] of added) expect(remove).toHaveBeenCalledWith(type, fn, expect.anything());
  });
});

describe("historique : requêtes soumises", () => {
  it("Entrée dans le champ mémorise la requête (liste fermée)", () => {
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
    expect(history.add).not.toHaveBeenCalled();
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
