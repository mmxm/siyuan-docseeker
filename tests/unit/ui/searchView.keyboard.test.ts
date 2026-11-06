// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SearchViewModel } from "../../../src/search/searchController";
import type { Rect } from "../../../src/ui/keyboardNav";
import { mountSearchView, type SearchView, type SearchViewDeps } from "../../../src/ui/searchView";

function doc(id: string, pages: number[]) {
  return {
    docId: id,
    title: `Titre ${id}`,
    path: `/pdf/${id}.pdf`,
    matchingPages: pages.length,
    relevance: 1,
    pages: pages.map((page) => ({ page, score: 1 })),
  };
}
const results = (docs: ReturnType<typeof doc>[]): SearchViewModel => ({
  kind: "results", query: "chat", docs, partial: false, total: docs.length, failedCount: 0, ranking: "bm25", hiddenByFilters: 0,
});

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let onOpen: Mock;
let submit: Mock;
let view: SearchView | undefined;

function mount(extra: Partial<SearchViewDeps> = {}): SearchView {
  view = mountSearchView(host, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails: { attach: () => () => undefined },
    onOpen: onOpen as SearchViewDeps["onOpen"],
    getDocMeta: () => ({ pdfSize: 1, pdfModifiedMs: 2 }),
    ...extra,
  });
  return view;
}
function update(next: SearchViewModel): void {
  vm = next;
  listener();
}
const cards = () => Array.from(host.querySelectorAll<HTMLButtonElement>("li button.docseeker-card"));
const input = () => host.querySelector<HTMLInputElement>("input[type=search], input[role=combobox]")!;
const focused = () => document.activeElement;

/** Envoie une touche à l'élément qui a le focus (ou à `target`) et renvoie l'événement pour lire defaultPrevented. */
function press(key: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (target ?? document.body).dispatchEvent(e);
  return e;
}

/**
 * Comme `press`, mais simule le comportement natif d'un bouton : Entrée dont le keydown n'est pas annulé
 * déclenche un `click` portant les mêmes modificateurs (hors composition IME).
 */
function pressEnterLikeBrowser(init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement;
  const e = press("Enter", init, target);
  if (!e.defaultPrevented && !init.isComposing && target instanceof HTMLButtonElement) {
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true, cancelable: true,
        ctrlKey: init.ctrlKey ?? false, metaKey: init.metaKey ?? false,
        altKey: init.altKey ?? false, shiftKey: init.shiftKey ?? false,
      }),
    );
  }
  return e;
}

/** Mesure injectée : rectangle de chaque carte par son (docId, page). */
function gridMeasure(layout: Record<string, Rect>): (el: HTMLElement) => Rect {
  return (el) => layout[`${el.dataset["docId"]}|${el.dataset["page"]}`] ?? { top: 0, left: 0, width: 0, height: 0 };
}
const r = (left: number, top: number): Rect => ({ left, top, width: 120, height: 80 });
/** 6 cartes d'un seul document en grille de 3 colonnes (observée dans SiYuan : top 282 puis 367). */
const GRID_LAYOUT: Record<string, Rect> = {
  "a|1": r(302, 282), "a|2": r(442, 282), "a|3": r(582, 282),
  "a|4": r(302, 367), "a|5": r(442, 367), "a|6": r(582, 367),
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  onOpen = vi.fn();
  submit = vi.fn();
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("navigation au clavier : flèches Haut/Bas spatiales", () => {
  beforeEach(() => {
    mount({ measure: gridMeasure(GRID_LAYOUT) });
    update(results([doc("a", [1, 2, 3, 4, 5])]));
    // 5 cartes max par document avant « et N autres » : déplier pour avoir 6 cartes.
  });

  it("Bas depuis une carte va à la carte du DESSOUS (pas à la suivante du DOM)", () => {
    // Le document n'a que 5 cartes : 3 en haut (a|1..a|3), 2 en bas (a|4, a|5).
    const c = cards();
    c[0]!.focus();
    const e = press("ArrowDown");
    expect(focused()).toBe(c[3]);
    expect(e.defaultPrevented).toBe(true);
    c[1]!.focus();
    press("ArrowDown");
    expect(focused()).toBe(c[4]);
  });

  it("Haut remonte à la carte du dessus ; roving tabindex suit le focus", () => {
    const c = cards();
    c[4]!.focus();
    press("ArrowUp");
    expect(focused()).toBe(c[1]);
    expect(c.filter((x) => x.tabIndex === 0)).toEqual([c[1]]);
  });

  it("Bas depuis la dernière ligne : rien ne bouge et l'événement n'est PAS annulé", () => {
    const c = cards();
    c[3]!.focus();
    const e = press("ArrowDown");
    expect(focused()).toBe(c[3]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Haut depuis la première ligne : le champ de recherche prend le focus (événement annulé)", () => {
    const c = cards();
    c[2]!.focus();
    const e = press("ArrowUp");
    expect(focused()).toBe(input());
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl, Cmd, Alt ou Maj + Bas : rien n'est intercepté", () => {
    const c = cards();
    c[0]!.focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      const e = press("ArrowDown", init);
      expect(focused()).toBe(c[0]);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it("scrollIntoView absent (jsdom) : aucune erreur ; présent : appelé sur la carte focalisée", () => {
    const c = cards();
    c[0]!.focus();
    expect(() => press("ArrowDown")).not.toThrow();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    press("ArrowUp");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("navigation au clavier : sans géométrie (jsdom, rectangles nuls)", () => {
  it("Bas et Haut suivent l'ordre du DOM", () => {
    mount();
    update(results([doc("a", [1, 2, 3])]));
    const c = cards();
    c[0]!.focus();
    press("ArrowDown");
    expect(focused()).toBe(c[1]);
    press("ArrowDown");
    expect(focused()).toBe(c[2]);
    const e = press("ArrowDown");
    expect(focused()).toBe(c[2]);
    expect(e.defaultPrevented).toBe(false);
    press("ArrowUp");
    press("ArrowUp");
    expect(focused()).toBe(c[0]);
    press("ArrowUp");
    expect(focused()).toBe(input());
  });

  it("la mesure par défaut est getBoundingClientRect de la carte", () => {
    mount();
    update(results([doc("a", [1, 2])]));
    const c = cards();
    const spy = vi.spyOn(c[0]!, "getBoundingClientRect");
    c[0]!.focus();
    press("ArrowDown");
    expect(spy).toHaveBeenCalled();
    expect(focused()).toBe(c[1]);
  });
});

describe("navigation au clavier : cartes masquées", () => {
  const layout: Record<string, Rect> = { "a|1": r(0, 0), "a|3": r(0, 200) }; // a|2 absent => rectangle nul
  beforeEach(() => {
    mount({ measure: gridMeasure(layout) });
    update(results([doc("a", [1, 2, 3])]));
  });

  it("Bas saute une carte masquée placée entre deux cartes mesurées", () => {
    const c = cards();
    c[0]!.focus();
    press("ArrowDown");
    expect(focused()).toBe(c[2]);
    press("ArrowUp");
    expect(focused()).toBe(c[0]);
  });

  it("Droite, Gauche, Fin et Début sautent aussi la carte masquée", () => {
    const c = cards();
    c[0]!.focus();
    press("ArrowRight");
    expect(focused()).toBe(c[2]);
    press("ArrowLeft");
    expect(focused()).toBe(c[0]);
    press("End");
    expect(focused()).toBe(c[2]);
    press("Home");
    expect(focused()).toBe(c[0]);
  });
});

describe("navigation au clavier : gauche/droite, début/fin, document précédent/suivant", () => {
  beforeEach(() => {
    mount();
    update(results([doc("a", [1, 2]), doc("b", [3, 4, 5]), doc("c", [6])]));
  });

  it("Droite/Gauche suivent l'ordre du DOM ; aux bords rien ne bouge et l'événement n'est pas annulé", () => {
    const c = cards();
    c[0]!.focus();
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(focused()).toBe(c[0]);
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(focused()).toBe(c[1]);
    c[c.length - 1]!.focus();
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(focused()).toBe(c[c.length - 1]);
  });

  it("Début et Fin", () => {
    const c = cards();
    c[2]!.focus();
    expect(press("End").defaultPrevented).toBe(true);
    expect(focused()).toBe(c[5]);
    press("Home");
    expect(focused()).toBe(c[0]);
  });

  it("Page bas : première carte du document suivant ; Page haut : du précédent", () => {
    const c = cards(); // a1 a2 | b3 b4 b5 | c6
    c[1]!.focus();
    expect(press("PageDown").defaultPrevented).toBe(true);
    expect(focused()).toBe(c[2]);
    c[3]!.focus();
    press("PageDown");
    expect(focused()).toBe(c[5]);
    press("PageUp");
    expect(focused()).toBe(c[2]);
    c[4]!.focus();
    press("PageUp");
    expect(focused()).toBe(c[0]);
  });

  it("Page haut/bas aux bords : rien ne bouge et l'événement n'est PAS annulé", () => {
    const c = cards();
    c[0]!.focus();
    expect(press("PageUp").defaultPrevented).toBe(false);
    expect(focused()).toBe(c[0]);
    c[5]!.focus();
    expect(press("PageDown").defaultPrevented).toBe(false);
    expect(focused()).toBe(c[5]);
  });
});

describe("navigation au clavier : ouverture", () => {
  beforeEach(() => {
    mount();
    update(results([doc("a", [3, 4])]));
  });

  it("Entrée ouvre une seule fois, sans alternative (pas de clic natif en plus)", () => {
    cards()[1]!.focus();
    const e = pressEnterLikeBrowser();
    expect(e.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith("a", 4, "chat", { alternate: false });
  });

  it("Ctrl, Cmd et Alt + Entrée ouvrent à droite, une seule fois chacun", () => {
    cards()[1]!.focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      onOpen.mockClear();
      expect(pressEnterLikeBrowser(init).defaultPrevented).toBe(true);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith("a", 4, "chat", { alternate: true });
    }
  });

  it("Maj+Entrée (avec ou sans Ctrl/Alt) : n'ouvre rien et est annulée, donc pas de clic natif", () => {
    cards()[0]!.focus();
    for (const init of [{ shiftKey: true }, { shiftKey: true, ctrlKey: true }, { shiftKey: true, altKey: true }]) {
      expect(pressEnterLikeBrowser(init).defaultPrevented).toBe(true);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Entrée pendant une composition IME : n'ouvre rien et n'est pas annulée", () => {
    cards()[0]!.focus();
    expect(pressEnterLikeBrowser({ isComposing: true }).defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clic : alternate faux ; Alt+clic : alternate vrai", () => {
    const c = cards();
    c[0]!.click();
    expect(onOpen).toHaveBeenLastCalledWith("a", 3, "chat", { alternate: false });
    c[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    expect(onOpen).toHaveBeenLastCalledWith("a", 3, "chat", { alternate: true });
  });

  it("Échap sur une carte revient au champ SANS le vider ni relancer la requête", () => {
    input().value = "chat";
    cards()[0]!.focus();
    const e = press("Escape");
    expect(focused()).toBe(input());
    expect(input().value).toBe("chat");
    expect(submit).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Tab, lettres et Espace sur une carte ne sont pas interceptés", () => {
    cards()[0]!.focus();
    for (const k of ["Tab", "a", " "]) expect(press(k).defaultPrevented).toBe(false);
  });
});

describe("navigation au clavier : champ de recherche", () => {
  beforeEach(() => {
    mount();
  });

  it("Entrée lance la recherche (événement annulé)", () => {
    input().focus();
    input().value = "chat";
    const e = press("Enter");
    expect(submit).toHaveBeenCalledWith("chat");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Entrée pendant une composition IME : rien, événement non annulé", () => {
    input().focus();
    input().value = "ch";
    const e = press("Enter", { isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Maj+Entrée et Maj+Échap : rien, ni soumission ni effacement", () => {
    input().focus();
    input().value = "chat";
    expect(press("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press("Escape", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(input().value).toBe("chat");
  });

  it("Ctrl+Entrée, Alt+Entrée : rien", () => {
    input().focus();
    input().value = "chat";
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press("Enter", init).defaultPrevented).toBe(false);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("Bas (sans modificateur) va à la première carte ; sans carte, rien et événement non annulé", () => {
    input().focus();
    const none = press("ArrowDown");
    expect(none.defaultPrevented).toBe(false);
    expect(focused()).toBe(input());
    update(results([doc("a", [1, 2])]));
    input().focus();
    const e = press("ArrowDown");
    expect(focused()).toBe(cards()[0]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl/Cmd/Maj + Bas dans le champ : ne saute pas à la carte", () => {
    update(results([doc("a", [1])]));
    input().focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(press("ArrowDown", init).defaultPrevented).toBe(false);
      expect(focused()).toBe(input());
    }
  });

  it("Alt+Bas sans historique : ne saute PAS à la carte et n'est pas annulé", () => {
    update(results([doc("a", [1])]));
    input().focus();
    const e = press("ArrowDown", { altKey: true });
    expect(focused()).toBe(input());
    expect(e.defaultPrevented).toBe(false);
  });

  it("Échap vide le champ et relance la requête vide (comportement actuel)", () => {
    input().focus();
    input().value = "chat";
    const e = press("Escape");
    expect(input().value).toBe("");
    expect(submit).toHaveBeenCalledWith("");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Échap : rien", () => {
    input().focus();
    input().value = "chat";
    expect(press("Escape", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(input().value).toBe("chat");
  });
});

describe("navigation au clavier : liste plate", () => {
  it("Bas/Haut spatiaux aussi (une carte par <li>)", () => {
    const layout: Record<string, Rect> = {
      "a|1": r(0, 0), "a|2": r(140, 0), "b|1": r(0, 100), "b|2": r(140, 100),
    };
    mount({ measure: gridMeasure(layout), initialGroupByDocument: false });
    update(results([doc("a", [1, 2]), doc("b", [1, 2])]));
    const c = cards();
    c[1]!.focus();
    press("ArrowDown");
    expect(focused()).toBe(c[3]);
    press("ArrowUp");
    expect(focused()).toBe(c[1]);
  });
});

describe("navigation au clavier : touches avec focus réel et hôte attaché", () => {
  it("séquence complète : champ, Bas, Droite, Bas, Entrée à droite, Échap", () => {
    const layout: Record<string, Rect> = {
      "a|1": r(0, 0), "a|2": r(140, 0), "a|3": r(0, 100),
    };
    mount({ measure: gridMeasure(layout) });
    update(results([doc("a", [1, 2, 3])]));
    input().focus();
    press("ArrowDown");
    const c = cards();
    expect(focused()).toBe(c[0]);
    press("ArrowRight");
    expect(focused()).toBe(c[1]);
    press("ArrowDown"); // dessous de la 2e colonne : seule carte de la ligne => la plus proche (a|3)
    expect(focused()).toBe(c[2]);
    press("Enter", { ctrlKey: true });
    expect(onOpen).toHaveBeenLastCalledWith("a", 3, "chat", { alternate: true });
    press("Escape");
    expect(focused()).toBe(input());
  });
});
