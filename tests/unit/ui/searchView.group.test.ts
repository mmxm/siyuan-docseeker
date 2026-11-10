// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createNativeFakes, findItem } from "./nativeFakes";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SearchViewModel } from "../../../src/search/searchController";
import { MAX_CARDS_PER_DOC, mountSearchView, type SearchViewDeps, type ThumbnailAttacher } from "../../../src/ui/searchView";

function doc(id: string, pages: number[], title = `Titre ${id}`, matchingPages = pages.length) {
  return { docId: id, title, path: `/pdf/${id}.pdf`, matchingPages, relevance: 1, pages: pages.map((page) => ({ page, score: 1 })) };
}
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
function results(docs: ReturnType<typeof doc>[], ranking: "bm25" | "proximity" = "bm25", query = "chat"): SearchViewModel {
  return { kind: "results", query, docs, partial: false, total: docs.length, failedCount: 0, ranking, hiddenByFilters: 0 };
}

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let attach: Mock;
let detach: Mock;
let onOpen: Mock;
let submit: Mock;
let setOptions: Mock;
let opts: SearchOptions;
let onGroup: Mock;
let fakes: ReturnType<typeof createNativeFakes>;

function mount(extra: Partial<SearchViewDeps> = {}, withOptions = true) {
  return mountSearchView(host, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails: { attach: attach as ThumbnailAttacher["attach"] },
    onOpen: onOpen as (d: string, p: number, q: string) => void,
    getDocMeta: () => ({ pdfSize: 10, pdfModifiedMs: 20 }),
    ...(withOptions
      ? { options: { getOptions: () => opts, setOptions: setOptions as (o: SearchOptions) => void } }
      : {}),
    onGroupByDocumentChange: onGroup as (v: boolean) => void,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...extra,
  });
}
function update(next: SearchViewModel): void {
  vm = next;
  listener();
}
const status = () => host.querySelector(".docseeker-status")!.textContent ?? "";
const cards = () => Array.from(host.querySelectorAll<HTMLButtonElement>("li button.docseeker-card"));
const cardKeys = () => cards().map((c) => `${c.dataset["docId"]}|${c.dataset["page"]}`);
const items = () => Array.from(host.querySelectorAll<HTMLLIElement>(".docseeker-list > li"));
const icons = () => host.querySelector(".docseeker-icons")!;
const button = (name: string) => icons().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const MORE = "Plus";
/** Sous-menu « Groupe » tel que la barre l'affiche maintenant. */
const groupMenu = () => {
  button(MORE).click();
  return findItem(fakes.lastMenu().items, "Groupe").submenu!;
};
const isGrouped = (): boolean => groupMenu().find((i) => i.label === "Regrouper par document")!.current === true;
const toggleGroup = (checked: boolean): void => {
  groupMenu().find((i) => i.label === (checked ? "Regrouper par document" : "Aucun regroupement"))!.click!();
};

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  detach = vi.fn();
  attach = vi.fn(() => detach);
  onOpen = vi.fn();
  submit = vi.fn();
  onGroup = vi.fn();
  fakes = createNativeFakes();
  opts = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    opts = o;
  });
});

describe("regroupement : commandes", () => {
  it("regroupement par défaut : le menu « Groupe » marque « Regrouper par document » comme courant", () => {
    mount();
    expect(groupMenu().map((i) => [i.label, i.current === true])).toEqual([
      ["Aucun regroupement", false],
      ["Regrouper par document", true],
    ]);
  });

  it("« Élargir » et « Réduire » sont des boutons-icônes de la rangée, après « Filtres » (ordre de tabulation)", () => {
    mount();
    const names = Array.from(icons().querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(names.slice(-2)).toEqual(["Élargir", "Réduire"]);
    expect(names.indexOf("Filtres")).toBeLessThan(names.indexOf("Élargir"));
    for (const name of ["Élargir", "Réduire"]) expect(button(name).type).toBe("button");
  });

  it("aucune commande de regroupement sans barre d'outils (pas de deps.options)", () => {
    mount({}, false);
    expect(host.querySelector(".docseeker-toolbar")).toBeNull();
  });

  it("initialGroupByDocument=false : case décochée, liste plate, boutons Élargir/Réduire masqués", () => {
    vm = results([doc("a", [1, 2]), doc("b", [3])]);
    mount({ initialGroupByDocument: false });
    expect(isGrouped()).toBe(false);
    expect(items()).toHaveLength(3);
    expect(button("Élargir").hidden).toBe(true);
    expect(button("Réduire").hidden).toBe(true);
  });
});

describe("regroupement : après dispose", () => {
  it("dispose avec le menu « Plus » ouvert : fermé ; un clic tardif sur « Aucun regroupement » ne change rien et ne mémorise rien", () => {
    const view = mount();
    button(MORE).click();
    const menu = fakes.lastMenu();
    view.dispose();
    expect(menu.closed).toBe(true);
    findItem(menu.items, "Groupe", "Aucun regroupement").click!();
    expect(onGroup).not.toHaveBeenCalled();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("view.setGroupByDocument après dispose : sans effet", () => {
    const view = mount();
    view.dispose();
    view.setGroupByDocument(false);
    expect(onGroup).not.toHaveBeenCalled();
  });
});

describe("regroupement : liste plate", () => {
  const sample = () => results([doc("b", [4, 2], "Beta"), doc("a", [7], "Alpha")]);

  it("décocher : un <li> par page, dans l'ordre des documents puis des pages, sans relancer de recherche", () => {
    vm = sample();
    mount();
    expect(items()).toHaveLength(2);
    toggleGroup(false);
    expect(items()).toHaveLength(3);
    expect(items().every((li) => li.querySelectorAll("button.docseeker-card").length === 1)).toBe(true);
    expect(cardKeys()).toEqual(["b|4", "b|2", "a|7"]);
    expect(submit).not.toHaveBeenCalled();
    expect(setOptions).not.toHaveBeenCalled();
    expect(onGroup).toHaveBeenCalledWith(false);
    expect(host.querySelector(".docseeker-doc-heading")).toBeNull();
  });

  it("chaque carte affiche le titre du document et la page", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    const first = cards()[0]!;
    expect(first.textContent).toContain("Beta");
    expect(first.querySelector(".docseeker-thumb > .docseeker-card-page")!.textContent).toBe("p. 4");
    expect(first.getAttribute("aria-label")).toBe("Beta, p. 4");
    expect(cards()[2]!.textContent).toContain("Alpha");
  });

  it("toutes les pages de chaque document sont listées (au-delà de 5), le titre passe par textContent", () => {
    vm = results([doc("a", range(12), "<b>x</b> & y")]);
    mount({ initialGroupByDocument: false });
    expect(cards()).toHaveLength(12);
    expect(cards()[0]!.querySelector("b")).toBeNull();
    expect(cards()[0]!.textContent).toContain("<b>x</b> & y");
  });

  it("clic sur une carte plate : ouvre le bon document à la bonne page avec la requête", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    expect(items()).toHaveLength(3); // liste plate : un <li> par page
    cards()[1]!.click();
    expect(onOpen).toHaveBeenCalledWith("b", 2, "chat", { alternate: false });
  });

  it("une seule carte est tabbable (tabindex 0), navigation Flèche bas", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    expect(items()).toHaveLength(3); // liste plate : un <li> par page
    expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    cards()[0]!.focus();
    cards()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cards()[1]);
  });

  it("le focus reste sur « Plus » après bascule, dans les deux sens", () => {
    vm = sample();
    mount();
    button(MORE).focus();
    toggleGroup(false);
    expect(document.activeElement).toBe(button(MORE));
    toggleGroup(true);
    expect(document.activeElement).toBe(button(MORE));
    expect(host.querySelectorAll(".docseeker-doc-heading")).toHaveLength(2);
    expect(onGroup).toHaveBeenLastCalledWith(true);
  });

  it("re-tri de la liste plate : les <li> existants sont déplacés, les vignettes ne sont pas reconstruites, le focus est gardé par clé", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    expect(items()).toHaveLength(3); // liste plate : un <li> par page
    const attaches = attach.mock.calls.length;
    const before = new Map(cards().map((c) => [`${c.dataset["docId"]}|${c.dataset["page"]}`, c.closest("li")!]));
    const focused = cards()[2]!; // a|7
    focused.focus();
    update(results([doc("a", [7], "Alpha"), doc("b", [4, 2], "Beta")]));
    expect(cardKeys()).toEqual(["a|7", "b|4", "b|2"]);
    expect(attach.mock.calls.length).toBe(attaches);
    expect(detach).not.toHaveBeenCalled();
    for (const c of cards()) expect(c.closest("li")).toBe(before.get(`${c.dataset["docId"]}|${c.dataset["page"]}`));
    expect(document.activeElement).toBe(focused);
    expect(focused.tabIndex).toBe(0);
  });

  it("une page qui disparaît détache sa vignette, celle qui reste n'est pas reconstruite", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    expect(items()).toHaveLength(3); // liste plate : un <li> par page
    const attaches = attach.mock.calls.length;
    update(results([doc("a", [7], "Alpha")]));
    expect(cards()).toHaveLength(1);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls.length).toBe(attaches);
  });

  it("état vide / sans résultat : la liste plate est vidée", () => {
    vm = sample();
    mount({ initialGroupByDocument: false });
    expect(items()).toHaveLength(3); // liste plate : un <li> par page
    update({ kind: "empty-query" });
    expect(items()).toHaveLength(0);
    expect(detach).toHaveBeenCalledTimes(3);
  });
});

describe("regroupement : Élargir / Réduire", () => {
  const big = () => results([doc("a", range(12), "A"), doc("b", range(7), "B"), doc("c", [1, 2, 3], "C")]);
  const counts = () => items().map((li) => li.querySelectorAll("button.docseeker-card").length);

  it("état initial : 5, 5, 3 cartes ; Élargir actif, Réduire désactivé (aria-disabled)", () => {
    vm = big();
    mount();
    expect(counts()).toEqual([MAX_CARDS_PER_DOC, MAX_CARDS_PER_DOC, 3]);
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("false");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("true");
  });

  it("Élargir affiche toutes les pages de tous les documents, bascule les états, garde le focus sur le bouton", () => {
    vm = big();
    mount();
    const expand = button("Élargir");
    expand.focus();
    expand.click();
    expect(counts()).toEqual([12, 7, 3]);
    expect(expand.getAttribute("aria-disabled")).toBe("true");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(expand);
    expect(attach).toHaveBeenCalledTimes(5 + 5 + 3 + 7 + 2);
  });

  it("Réduire revient à l'état initial (5, 5, 3), garde le focus sur le bouton", () => {
    vm = big();
    mount();
    button("Élargir").click();
    const collapse = button("Réduire");
    collapse.focus();
    collapse.click();
    expect(counts()).toEqual([MAX_CARDS_PER_DOC, MAX_CARDS_PER_DOC, 3]);
    expect(collapse.getAttribute("aria-disabled")).toBe("true");
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(collapse);
    expect(detach).toHaveBeenCalledTimes(9);
  });

  it("un clic sur un bouton aria-disabled ne fait rien", () => {
    vm = big();
    mount();
    const before = attach.mock.calls.length;
    button("Réduire").click();
    expect(counts()).toEqual([5, 5, 3]);
    button("Élargir").click();
    button("Élargir").click();
    expect(attach.mock.calls.length).toBe(before + 9);
  });

  it("tous les documents tiennent dans 5 pages : les deux boutons sont désactivés", () => {
    vm = results([doc("a", [1, 2]), doc("b", [3])]);
    mount();
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("true");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("true");
  });

  it("sans résultat, les boutons sont désactivés", () => {
    mount();
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("true");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("true");
  });

  it("respecte le plafond existant : 200 pages affichées sur 300 correspondantes, le reste signalé", () => {
    vm = results([doc("a", range(200), "A", 300)]);
    mount();
    button("Élargir").click();
    expect(cards()).toHaveLength(200);
    expect(items()[0]!.querySelector(".docseeker-truncated")!.textContent).toBe("100 pages non affichées");
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("true");
  });

  it("le bouton « et N autres pages » d'un document met à jour les états (réutilise la logique existante)", () => {
    vm = results([doc("b", range(7), "B")]);
    mount();
    items()[0]!.querySelector<HTMLButtonElement>("button.docseeker-more")!.click();
    expect(cards()).toHaveLength(7);
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("true");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("false");
    items()[0]!.querySelector<HTMLButtonElement>("button.docseeker-less")!.click();
    expect(button("Élargir").getAttribute("aria-disabled")).toBe("false");
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("true");
  });

  it("Élargir : un document partiellement déplié à la main est complété, les boutons du document suivent", () => {
    vm = results([doc("a", range(30), "A")]);
    mount();
    items()[0]!.querySelector<HTMLButtonElement>("button.docseeker-more")!.click(); // 15
    button("Élargir").click();
    expect(cards()).toHaveLength(30);
    const li = items()[0]!;
    expect(li.querySelector<HTMLButtonElement>("button.docseeker-more")!.hidden).toBe(true);
    expect(li.querySelector<HTMLButtonElement>("button.docseeker-less")!.hidden).toBe(false);
  });

  it("l'état déplié survit à un re-tri (mêmes documents, autre ordre) sans reconstruire les vignettes", () => {
    vm = big();
    mount();
    button("Élargir").click();
    const attaches = attach.mock.calls.length;
    update(results([doc("c", [1, 2, 3], "C"), doc("b", range(7), "B"), doc("a", range(12), "A")]));
    expect(counts()).toEqual([3, 7, 12]);
    expect(attach.mock.calls.length).toBe(attaches);
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("false");
  });

  it("re-tri groupé : le focus d'une carte est conservé par clé docId|page", () => {
    vm = big();
    mount();
    const target = cards().find((c) => c.dataset["docId"] === "c" && c.dataset["page"] === "2")!;
    target.focus();
    update(results([doc("c", [1, 2, 3], "C"), doc("a", range(12), "A"), doc("b", range(7), "B")]));
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(0);
    expect(items()[0]!.contains(target)).toBe(true);
  });

  it("basculer en liste plate puis revenir : Élargir/Réduire réapparaissent avec le bon état", () => {
    vm = big();
    mount();
    button("Élargir").click();
    toggleGroup(false);
    expect(button("Élargir").hidden).toBe(true);
    toggleGroup(true);
    expect(button("Élargir").hidden).toBe(false);
    expect(counts()).toEqual([12, 7, 3]);
    expect(button("Réduire").getAttribute("aria-disabled")).toBe("false");
  });
});

describe("libellé de statut selon le tri", () => {
  const refined = "Pages classées par proximité et taille de police";
  const legacy = "Classement affiné par proximité des mots et taille de police";

  it("tri par pertinence : libellé d'origine", () => {
    mount();
    update(results([doc("a", [1])], "proximity"));
    expect(status()).toContain(legacy);
    expect(status()).not.toContain(refined);
  });

  it.each([
    [{ key: "name", direction: "asc" }],
    [{ key: "modified", direction: "desc" }],
    [{ key: "path", direction: "asc" }],
    [{ key: "matches", direction: "desc" }],
  ] as const)("tri %j : « Pages classées par proximité et taille de police »", (sort) => {
    opts = { ...opts, sort };
    mount();
    update(results([doc("a", [1])], "proximity"));
    expect(status()).toBe(`1 document, 1 page. ${refined}`);
  });

  it("le libellé suit le tri quand il change (re-rendu sans nouveau résultat)", () => {
    mount();
    update(results([doc("a", [1])], "proximity"));
    opts = { ...opts, sort: { key: "name", direction: "asc" } };
    listener();
    expect(status()).toContain(refined);
    opts = { ...opts, sort: { key: "relevance", direction: "desc" } };
    listener();
    expect(status()).toContain(legacy);
  });

  it("sans re-classement affiné (bm25) : aucun des deux libellés", () => {
    opts = { ...opts, sort: { key: "name", direction: "asc" } };
    mount();
    update(results([doc("a", [1])], "bm25"));
    expect(status()).toBe("1 document, 1 page");
  });
});
