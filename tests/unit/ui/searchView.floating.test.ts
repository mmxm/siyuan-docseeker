// @vitest-environment jsdom
// Vue montée dans la fenêtre flottante (deps.floating) : Échap par couches sans fermeture globale en double, bouton « Ouvrir
// dans un nouvel onglet », restauration de la requête. Hors fenêtre flottante, rien de tout cela ne change.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SearchViewModel } from "../../../src/search/searchController";
import { mountSearchView, type SearchView, type SearchViewDeps } from "../../../src/ui/searchView";
import { createNativeFakes } from "./nativeFakes";

const results = (): SearchViewModel => ({
  kind: "results",
  query: "chat",
  docs: [{ docId: "a", title: "Titre a", path: "/pdf/a.pdf", matchingPages: 2, relevance: 1, pages: [{ page: 1, score: 1 }, { page: 2, score: 1 }] }],
  partial: false,
  total: 1,
  failedCount: 0,
  ranking: "bm25",
  hiddenByFilters: 0,
});

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let submit: Mock;
let requestClose: Mock;
let openInTab: Mock;
let history: { add: Mock };
let view: SearchView | undefined;
let reachedWindow: Mock;
let opts: SearchOptions;

function mount(extra: Partial<SearchViewDeps> = {}): SearchView {
  const fakes = createNativeFakes();
  view = mountSearchView(host, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails: { attach: () => () => undefined },
    onOpen: vi.fn(),
    getDocMeta: () => ({ pdfSize: 1, pdfModifiedMs: 2 }),
    options: { getOptions: () => opts, setOptions: (o) => void (opts = o), getFolders: () => [] },
    history: { get: () => [], add: history.add as (q: string) => void, clear: vi.fn() },
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...extra,
  });
  return view;
}
const floating = (): Partial<SearchViewDeps> => ({ floating: { requestClose, openInTab } });
const input = () => host.querySelector<HTMLInputElement>("input")!;
const cards = () => [...host.querySelectorAll<HTMLButtonElement>("button.docseeker-card")];
const toolbarButton = (label: string) => host.querySelector<HTMLButtonElement>(`.docseeker-icons button[aria-label="${label}"]`);
function press(key: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (target ?? document.body).dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  vm = { kind: "empty-query" };
  submit = vi.fn();
  requestClose = vi.fn();
  openInTab = vi.fn();
  history = { add: vi.fn() };
  opts = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
  reachedWindow = vi.fn();
  window.addEventListener("keydown", reachedWindow);
});
afterEach(() => {
  window.removeEventListener("keydown", reachedWindow);
  view?.dispose();
  view = undefined;
});

describe("Échap par couches dans la fenêtre flottante", () => {
  it("champ NON vide : il est vidé, la requête vide est soumise, la fenêtre reste ouverte, et la touche n'atteint pas le gestionnaire global", () => {
    mount(floating());
    input().value = "chat";
    input().focus();
    const e = press("Escape");
    expect(input().value).toBe("");
    expect(submit).toHaveBeenCalledWith("");
    expect(requestClose).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("champ VIDE : demande la fermeture, une seule fois, en consommant la touche (preventDefault + stopPropagation)", () => {
    mount(floating());
    input().focus();
    const e = press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("deux Échap de suite sur un champ plein : le premier vide, le second ferme (jamais les deux d'un coup)", () => {
    mount(floating());
    input().value = "chat";
    input().focus();
    press("Escape");
    expect(requestClose).not.toHaveBeenCalled();
    press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("focus sur une carte : retour au champ SANS le vider ni fermer, touche consommée", () => {
    mount(floating());
    vm = results();
    listener();
    input().value = "chat";
    cards()[0]!.focus();
    const e = press("Escape");
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("chat");
    expect(requestClose).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("composition IME : Échap est ignoré (ni fermeture ni consommation)", () => {
    mount(floating());
    input().focus();
    press("Escape", { isComposing: true });
    expect(requestClose).not.toHaveBeenCalled();
    expect(reachedWindow).toHaveBeenCalledTimes(1);
  });

  it("Échap avec modificateur : non traité, donc jamais de fermeture par la vue", () => {
    mount(floating());
    input().focus();
    for (const init of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) press("Escape", init);
    expect(requestClose).not.toHaveBeenCalled();
  });

  it("HORS fenêtre flottante (onglet) : champ vide, Échap ne ferme rien et ne consomme rien de plus qu'avant (pas de stopPropagation)", () => {
    mount();
    input().focus();
    press("Escape");
    expect(requestClose).not.toHaveBeenCalled();
    expect(reachedWindow).toHaveBeenCalledTimes(1);
    input().value = "chat";
    press("Escape");
    expect(input().value).toBe("");
    expect(reachedWindow).toHaveBeenCalledTimes(2);
  });
});

describe("Échap avec le menu d'historique ouvert (fenêtre flottante)", () => {
  const withHistory = (): { fakes: ReturnType<typeof createNativeFakes>; view: SearchView } => {
    const fakes = createNativeFakes();
    const v = mount({ ...floating(), history: { get: () => ["chat"], add: vi.fn(), clear: vi.fn() }, openMenu: fakes.openMenu, openDialog: fakes.openDialog });
    return { fakes, view: v };
  };
  const openHistory = (): void => {
    input().focus();
    press("ArrowDown", { altKey: true });
  };

  it("le focus restant dans le champ, Échap ferme le MENU d'abord : ni fermeture de la fenêtre ni champ vidé, touche consommée", () => {
    const { fakes } = withHistory();
    input().value = "chat";
    openHistory();
    expect(fakes.menus.at(-1)!.closed).toBe(false);
    const e = press("Escape");
    expect(fakes.menus.at(-1)!.closed).toBe(true);
    expect(requestClose).not.toHaveBeenCalled();
    expect(input().value).toBe("chat");
    expect(e.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled(); // ni l'Alt+Bas d'ouverture ni l'Échap n'atteignent window
  });

  it("une fois le menu fermé (choix ou Échap), l'Échap suivant reprend son rôle : champ vide => fermeture", () => {
    const { fakes } = withHistory();
    openHistory();
    fakes.menus.at(-1)!.close(); // SiYuan ferme le menu (choix, clic ailleurs, Échap global)
    press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("hors fenêtre flottante, le comportement d'avant est inchangé (le champ est vidé, la touche se propage au menu)", () => {
    const fakes = createNativeFakes();
    mount({ history: { get: () => ["chat"], add: vi.fn(), clear: vi.fn() }, openMenu: fakes.openMenu, openDialog: fakes.openDialog });
    input().value = "chat";
    openHistory();
    press("Escape");
    expect(input().value).toBe("");
    expect(requestClose).not.toHaveBeenCalled();
  });
});

describe("menu d'historique : l'état « ouvert » vient du HANDLE du menu, jamais d'un drapeau levé avant l'ouverture (Échap ne doit jamais être piégé)", () => {
  type FakeHandle = { close: Mock; isOpen: Mock };
  const mountWith = (openMenu: Mock, onWarn: Mock = vi.fn()): { onWarn: Mock } => {
    mount({
      ...floating(),
      history: { get: () => ["chat"], add: vi.fn(), clear: vi.fn() },
      openMenu: openMenu as unknown as NonNullable<SearchViewDeps["openMenu"]>,
      onWarn,
    });
    return { onWarn };
  };
  const altDown = (): KeyboardEvent => {
    input().focus();
    return press("ArrowDown", { altKey: true });
  };

  it("openMenu qui LÈVE : l'erreur est tracée (onWarn) et Échap sur un champ vide ferme la fenêtre (ni piégé ni muet)", () => {
    const openMenu = vi.fn(() => {
      throw new Error("menu KO");
    });
    const { onWarn } = mountWith(openMenu);
    expect(() => altDown()).not.toThrow();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "menu KO" }));
    press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("openMenu qui lève : le clic sur l'icône d'historique ne lève pas non plus, et Échap champ plein vide puis ferme", () => {
    const openMenu = vi.fn(() => {
      throw new Error("menu KO");
    });
    mountWith(openMenu);
    input().value = "chat";
    expect(() => host.querySelector<HTMLButtonElement>("button.docseeker-history-icon")!.click()).not.toThrow();
    press("Escape");
    expect(input().value).toBe("");
    expect(requestClose).not.toHaveBeenCalled();
    press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("menu ouvert qui ne rappelle JAMAIS onClose : le premier Échap le ferme (handle.close), le suivant ferme la fenêtre", () => {
    const handle: FakeHandle = { close: vi.fn(), isOpen: vi.fn(() => true) };
    mountWith(vi.fn(() => handle));
    altDown();
    press("Escape");
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(requestClose).not.toHaveBeenCalled();
    press("Escape");
    expect(handle.close).toHaveBeenCalledTimes(1); // l'état est retombé : le menu n'est plus visé
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("bascule (même identifiant) : le menu ne s'est jamais ouvert (handle.isOpen() faux, aucun onClose à venir) : Échap champ vide ferme la fenêtre", () => {
    const handle: FakeHandle = { close: vi.fn(), isOpen: vi.fn(() => false) };
    mountWith(vi.fn(() => handle));
    altDown();
    press("Escape");
    expect(handle.close).not.toHaveBeenCalled();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("menu fermé de façon SYNCHRONE pendant openMenu (onClose avant le retour du handle) : il n'est pas considéré ouvert", () => {
    const handle: FakeHandle = { close: vi.fn(), isOpen: vi.fn(() => true) };
    const openMenu = vi.fn((_items: unknown, _anchor: unknown, onClose?: () => void) => {
      onClose?.();
      return handle;
    });
    mountWith(openMenu);
    altDown();
    press("Escape");
    expect(handle.close).not.toHaveBeenCalled();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("dispose ferme le menu ouvert (une fois) et plus aucun état ne subsiste", () => {
    const handle: FakeHandle = { close: vi.fn(), isOpen: vi.fn(() => true) };
    mountWith(vi.fn(() => handle));
    altDown();
    view!.dispose();
    expect(handle.close).toHaveBeenCalledTimes(1);
    view!.dispose();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("dispose avec un menu dont close() lève : tracé, la vue est tout de même libérée", () => {
    const handle: FakeHandle = {
      close: vi.fn(() => {
        throw new Error("close KO");
      }),
      isOpen: vi.fn(() => true),
    };
    const { onWarn } = mountWith(vi.fn(() => handle));
    altDown();
    expect(() => view!.dispose()).not.toThrow();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "close KO" }));
    expect(host.querySelector(".docseeker-search")).toBeNull();
  });

  it("Échap avec un menu dont close() lève : tracé, la touche est consommée et l'état retombe (Échap suivant ferme la fenêtre)", () => {
    const handle: FakeHandle = {
      close: vi.fn(() => {
        throw new Error("close KO");
      }),
      isOpen: vi.fn(() => true),
    };
    const { onWarn } = mountWith(vi.fn(() => handle));
    altDown();
    const e = press("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "close KO" }));
    press("Escape");
    expect(requestClose).toHaveBeenCalledTimes(1);
  });
});

describe("bouton « Ouvrir dans un nouvel onglet »", () => {
  it("absent hors fenêtre flottante", () => {
    mount();
    expect(toolbarButton("Ouvrir dans un nouvel onglet")).toBeNull();
    expect(host.querySelector('use[*|href="#iconLayoutRight"]')).toBeNull();
  });

  it("présent en mode flottant : vrai <button> au libellé natif exact, icône #iconLayoutRight, dans la rangée d'icônes", () => {
    mount(floating());
    const b = toolbarButton("Ouvrir dans un nouvel onglet")!;
    expect(b).not.toBeNull();
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.hidden).toBe(false);
    expect(b.getAttribute("tabindex")).not.toBe("-1");
    expect(b.querySelector("use")!.getAttribute("xlink:href")).toBe("#iconLayoutRight");
    expect(b.closest(".block__icons")).not.toBeNull();
  });

  it("le clic appelle openInTab une fois", () => {
    mount(floating());
    toolbarButton("Ouvrir dans un nouvel onglet")!.click();
    expect(openInTab).toHaveBeenCalledTimes(1);
  });

  it("reste visible même quand le regroupement est coupé (Élargir/Réduire, eux, disparaissent)", () => {
    mount({ ...floating(), initialGroupByDocument: false });
    expect(toolbarButton("Élargir")!.hidden).toBe(true);
    expect(toolbarButton("Ouvrir dans un nouvel onglet")!.hidden).toBe(false);
  });

  it("après dispose, la rangée est retirée et plus rien n'est appelé", () => {
    const v = mount(floating());
    const b = toolbarButton("Ouvrir dans un nouvel onglet")!;
    v.dispose();
    b.click();
    expect(openInTab).not.toHaveBeenCalled();
    expect(host.querySelector(".docseeker-icons")).toBeNull();
  });
});

describe("restoreQuery", () => {
  it("remplit le champ et relance la recherche, sans écrire dans l'historique", () => {
    const v = mount(floating());
    v.restoreQuery("chat noir");
    expect(input().value).toBe("chat noir");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("chat noir");
    expect(history.add).not.toHaveBeenCalled();
  });

  it("affiche la croix « Effacer » (le champ est plein)", () => {
    const v = mount(floating());
    v.restoreQuery("chat");
    expect(host.querySelector<HTMLElement>("button.docseeker-clear")!.hidden).toBe(false);
  });

  it("après dispose : sans effet", () => {
    const v = mount(floating());
    v.dispose();
    v.restoreQuery("chat");
    expect(submit).not.toHaveBeenCalled();
  });
});
