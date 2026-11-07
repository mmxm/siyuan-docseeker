// @vitest-environment jsdom
import { createNativeFakes, pick } from "./nativeFakes";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SearchViewModel } from "../../../src/search/searchController";
import { FLAT_PAGE_SIZE, mountSearchView, type SearchViewDeps, type ThumbnailAttacher } from "../../../src/ui/searchView";

function doc(id: string, pages: number[], matchingPages = pages.length) {
  return { docId: id, title: `Titre ${id}`, path: `/pdf/${id}.pdf`, matchingPages, relevance: 1, pages: pages.map((page) => ({ page, score: 1 })) };
}
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
/** n documents de `perDoc` pages chacun. */
const many = (n: number, perDoc: number) => Array.from({ length: n }, (_, i) => doc(`d${String(i).padStart(4, "0")}`, range(perDoc)));
function results(docs: ReturnType<typeof doc>[], query = "chat"): SearchViewModel {
  return { kind: "results", query, docs, partial: false, total: docs.length, failedCount: 0, ranking: "bm25", hiddenByFilters: 0 };
}

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let attach: Mock;
let detaches: Mock[];
let onGroup: Mock;
let opts: SearchOptions;
let views: { dispose(): void }[];
const fakes = createNativeFakes();

function mount(extra: Partial<SearchViewDeps> = {}) {
  const view = mountSearchView(host, {
    controller: { submit: vi.fn(), getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails: { attach: attach as ThumbnailAttacher["attach"] },
    onOpen: vi.fn(),
    getDocMeta: () => ({ pdfSize: 10, pdfModifiedMs: 20 }),
    options: { getOptions: () => opts, setOptions: vi.fn(), getFolders: () => [] },
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    onGroupByDocumentChange: onGroup as (v: boolean) => void,
    initialGroupByDocument: false,
    ...extra,
  });
  views.push(view);
  return view;
}
function update(next: SearchViewModel): void {
  vm = next;
  listener();
}
const cards = () => Array.from(host.querySelectorAll<HTMLButtonElement>("li button.docseeker-card"));
const keyOf = (c: HTMLElement) => `${c.dataset["docId"]}|${c.dataset["page"]}`;
const moreBtn = () => host.querySelector<HTMLButtonElement>("button.docseeker-flat-more")!;
const footer = () => host.querySelector<HTMLElement>(".docseeker-flat-footer");
const note = () => host.querySelector<HTMLElement>(".docseeker-flat-footer .docseeker-truncated")!;
const activeDetaches = (): number => detaches.filter((d) => d.mock.calls.length === 0).length;

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  detaches = [];
  attach = vi.fn(() => {
    const d = vi.fn();
    detaches.push(d);
    return d;
  });
  onGroup = vi.fn();
  opts = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
  views = [];
});

describe("liste plate : plafond global", () => {
  it("le plafond initial est de 60 cartes", () => {
    expect(FLAT_PAGE_SIZE).toBe(60);
  });

  it("1 500 cartes : seules 60 sont créées (et rattachées), avec un bouton « Afficher plus » donnant le reste", () => {
    mount();
    update(results(many(150, 10)));
    expect(cards()).toHaveLength(60);
    expect(attach).toHaveBeenCalledTimes(60);
    expect(footer()!.hidden).toBe(false);
    expect(moreBtn().hidden).toBe(false);
    expect(moreBtn().textContent).toBe("Afficher plus (1440 pages restantes)");
  });

  it("2 000 cartes dans un seul document : même plafond", () => {
    mount();
    update(results([doc("big", range(200)), ...many(9, 200)]));
    expect(cards()).toHaveLength(60);
    expect(moreBtn().textContent).toBe("Afficher plus (1940 pages restantes)");
  });

  it("un clic ajoute 60 cartes sans reconstruire les premières ; le nombre restant suit", () => {
    mount();
    update(results(many(150, 10)));
    const first = cards()[0]!;
    moreBtn().click();
    expect(cards()).toHaveLength(120);
    expect(cards()[0]).toBe(first);
    expect(attach).toHaveBeenCalledTimes(120);
    expect(moreBtn().textContent).toBe("Afficher plus (1380 pages restantes)");
  });

  it("singulier : une page restante", () => {
    mount();
    update(results([doc("a", range(61))]));
    expect(moreBtn().textContent).toBe("Afficher plus (1 page restante)");
    moreBtn().click();
    expect(cards()).toHaveLength(61);
    expect(moreBtn().hidden).toBe(true);
  });

  it("jusqu'à 60 cartes : pas de bouton", () => {
    mount();
    update(results([doc("a", range(60))]));
    expect(cards()).toHaveLength(60);
    expect(moreBtn().hidden).toBe(true);
  });

  it("les libellés n'ont ni < ni > ni &", () => {
    mount();
    update(results([doc("a", range(62))]));
    expect(moreBtn().textContent).not.toMatch(/[<>&]/);
    expect(moreBtn().getAttribute("aria-label") ?? "").not.toMatch(/[<>&]/);
  });

  it("aucun aria-live ni role=status/alert n'est ajouté par le pied de liste", () => {
    mount();
    update(results(many(10, 10)));
    expect(footer()!.querySelector("[aria-live], [role]")).toBeNull();
    expect(footer()!.hasAttribute("aria-live")).toBe(false);
  });

  it("le bouton garde le focus tant qu'il reste des pages ; au dernier clic le focus passe à la première carte ajoutée", () => {
    mount();
    update(results([doc("a", range(130))]));
    moreBtn().focus();
    moreBtn().click();
    expect(document.activeElement).toBe(moreBtn());
    moreBtn().click();
    expect(moreBtn().hidden).toBe(true);
    expect(cards()).toHaveLength(130);
    expect(keyOf(document.activeElement as HTMLElement)).toBe("a|121");
  });

  it("un nouveau rendu (même requête, autre ordre) conserve le plafond étendu", () => {
    mount();
    const docs = many(150, 10);
    update(results(docs));
    moreBtn().click();
    expect(cards()).toHaveLength(120);
    update(results([...docs].reverse())); // re-tri
    expect(cards()).toHaveLength(120);
    expect(keyOf(cards()[0]!)).toBe(`${docs[149]!.docId}|1`);
  });

  it("un changement de filtre (même requête, liste réduite puis élargie) conserve le plafond", () => {
    mount();
    const docs = many(150, 10);
    update(results(docs));
    moreBtn().click();
    update(results(docs.slice(0, 100)));
    expect(cards()).toHaveLength(120);
  });

  it("une nouvelle requête remet le plafond à 60", () => {
    mount();
    update(results(many(150, 10)));
    moreBtn().click();
    update(results(many(150, 10), "chien"));
    expect(cards()).toHaveLength(60);
  });

  it("un état transitoire (chargement) puis la même requête conserve le plafond ; le champ vidé le remet à 60", () => {
    mount();
    const docs = many(150, 10);
    update(results(docs));
    moreBtn().click();
    update({ kind: "loading", progress: { loaded: 1, total: 2 } } as SearchViewModel);
    update(results(docs));
    expect(cards()).toHaveLength(120);
    update({ kind: "empty-query" });
    update(results(docs));
    expect(cards()).toHaveLength(60);
  });

  it("focus sur une carte qui passe au-delà du plafond après un re-tri : le plafond s'étend jusqu'à elle, focus conservé", () => {
    mount();
    const docs = many(150, 10);
    update(results(docs));
    const target = cards()[3]!;
    const key = keyOf(target);
    target.focus();
    update(results([...docs].reverse())); // la carte passe vers la fin (rang ~1 496)
    const still = cards().find((c) => keyOf(c) === key);
    expect(still).toBeDefined();
    expect(document.activeElement).toBe(still);
    expect(cards().length).toBeGreaterThanOrEqual(1497);
    expect(cards().length).toBeLessThan(1500 + 1);
    expect(cards().length % FLAT_PAGE_SIZE === 0 || cards().length === 1500).toBe(true);
  });

  it("aucune fuite : détacher tout (passage en mode regroupé, état transitoire, dispose) libère chaque rattachement", () => {
    const view = mount();
    update(results(many(150, 10)));
    moreBtn().click();
    expect(attach).toHaveBeenCalledTimes(120);
    expect(activeDetaches()).toBe(120);
    update({ kind: "empty-query" });
    expect(activeDetaches()).toBe(0);
    expect(footer()!.hidden).toBe(true);
    update(results(many(150, 10)));
    expect(activeDetaches()).toBe(60);
    view.dispose();
    expect(activeDetaches()).toBe(0);
  });

  it("le passage au mode regroupé détache les cartes plates et masque le pied de liste ; setGroupByDocument(false) les remet à 60", () => {
    const view = mount();
    update(results(many(150, 10)));
    host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!.click();
    pick(fakes.lastMenu(), "Groupe", "Regrouper par document");
    expect(footer()!.hidden).toBe(true);
    expect(onGroup).toHaveBeenCalledWith(true);
    view.setGroupByDocument(false);
    expect(footer()!.hidden).toBe(false);
    expect(cards()).toHaveLength(60);
  });

  it("note de troncature : pages au-delà de 200 par document, affichée une fois tout le reste montré", () => {
    mount();
    update(results([doc("a", range(30), 50)]));
    expect(moreBtn().hidden).toBe(true);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toBe("20 pages non affichées");
  });

  it("note de troncature masquée tant qu'il reste des cartes à afficher", () => {
    mount();
    update(results([doc("a", range(100), 150)]));
    expect(note().hidden).toBe(true);
    moreBtn().click();
    expect(note().hidden).toBe(false);
    expect(note().textContent).toBe("50 pages non affichées");
  });

  it("le nombre restant compte les cartes à afficher, pas les pages au-delà de 200 par document", () => {
    mount();
    update(results([doc("a", range(100), 150)]));
    expect(moreBtn().textContent).toBe("Afficher plus (40 pages restantes)");
  });
});

describe("API de la vue pour les réglages différés", () => {
  it("setGroupByDocument met à jour la case, la liste et NE notifie PAS onGroupByDocumentChange", () => {
    const view = mount({ initialGroupByDocument: true });
    update(results(many(3, 2)));
    expect(host.querySelector(".docseeker-list--flat")).toBeNull();
    view.setGroupByDocument(false);
    host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!.click();
    expect(fakes.lastMenu().items.find((i) => i.label === "Groupe")!.submenu!.map((i) => i.current === true)).toEqual([true, false]);
    expect(host.querySelector(".docseeker-list--flat")).not.toBeNull();
    expect(onGroup).not.toHaveBeenCalled();
  });

  it("refreshOptions rafraîchit la barre d'outils (le menu Tri suit les options)", () => {
    const view = mount();
    const more = host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!;
    more.click();
    expect(fakes.lastMenu().items[0]!.submenu!.find((i) => i.current)?.label).toBe("Pertinence");
    opts = { sort: { key: "name", direction: "desc" }, filters: NO_FILTERS };
    view.refreshOptions();
    more.click();
    expect(fakes.lastMenu().items[0]!.submenu!.find((i) => i.current)?.label).toBe("Nom décroissant");
  });
});
