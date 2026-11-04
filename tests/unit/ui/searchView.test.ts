// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SearchViewModel } from "../../../src/search/searchController";
import { mountSearchView, type ThumbnailAttacher } from "../../../src/ui/searchView";
import { SEARCH_STYLE_ID } from "../../../src/ui/searchStyles";

function doc(id: string, pages: number[], title = `Titre ${id}`) {
  return {
    docId: id,
    title,
    path: `/pdf/${id}.pdf`,
    matchingPages: pages.length,
    relevance: 1,
    pages: pages.map((page) => ({ page, score: 1 })),
  };
}
function results(docs: ReturnType<typeof doc>[], partial = false): SearchViewModel {
  return { kind: "results", query: "chat", docs, partial, total: docs.length };
}

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let detach: Mock;
let attach: Mock;
let onOpen: Mock;
let setQuery: Mock;

function mount(extra: { onReindex?: () => void } = {}) {
  const thumbnails: ThumbnailAttacher = { attach: attach as ThumbnailAttacher["attach"] };
  return mountSearchView(host, {
    controller: { setQuery: setQuery as (q: string) => void, getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails,
    onOpen: onOpen as (d: string, p: number, q: string) => void,
    getDocMeta: () => ({ pdfSize: 10, pdfModifiedMs: 20 }),
    ...extra,
  });
}
function update(next: SearchViewModel): void {
  vm = next;
  listener();
}
const status = () => host.querySelector('[aria-live="polite"]')!.textContent ?? "";
const cards = () => Array.from(host.querySelectorAll<HTMLButtonElement>("li button.docseeker-card"));
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  vm = { kind: "empty-query" };
  detach = vi.fn();
  attach = vi.fn(() => detach);
  onOpen = vi.fn();
  setQuery = vi.fn();
});

describe("mountSearchView", () => {
  it("rend la structure accessible et injecte le style une seule fois", () => {
    mount();
    mount();
    expect(host.querySelector('[role="search"]')).not.toBeNull();
    const input = host.querySelector("input")!;
    expect(input.type).toBe("search");
    expect(input.getAttribute("aria-label")).toBeTruthy();
    expect(document.querySelectorAll(`#${SEARCH_STYLE_ID}`)).toHaveLength(1);
    expect(status()).toBe("Saisissez des mots à rechercher");
  });

  it("transmet la saisie au contrôleur", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "chat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(setQuery).toHaveBeenCalledWith("chat");
  });

  it("affiche les messages de statut", () => {
    mount();
    update({ kind: "no-result", query: "x", partial: false });
    expect(status()).toBe("Aucun résultat");
    update({ kind: "loading", progress: { loaded: 12, total: 47, failed: [] } });
    expect(status()).toBe("Résultats partiels, index en cours de construction (12/47)");
    update({ kind: "error", message: "boum <b>" });
    expect(status()).toContain("boum <b>");
    expect(host.querySelector("b")).toBeNull();
    update({ kind: "no-index", indexing: false });
    expect(status()).toContain("Aucun index : lancez la réindexation");
    expect(host.querySelector("button.docseeker-reindex")).toBeNull();
  });

  it("propose la réindexation si onReindex fourni", () => {
    const onReindex = vi.fn();
    mount({ onReindex });
    update({ kind: "no-index", indexing: false });
    host.querySelector<HTMLButtonElement>("button.docseeker-reindex")!.click();
    expect(onReindex).toHaveBeenCalledOnce();
  });

  it("affiche documents, pages et statut avec singulier/pluriel", () => {
    mount();
    update(results([doc("a", [1, 2, 3])]));
    expect(status()).toBe("1 document, 3 pages");
    update(results([doc("a", [1]), doc("b", [4, 5])]));
    expect(status()).toBe("2 documents, 3 pages");
    const items = host.querySelectorAll("ul > li");
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain("Titre b");
    expect(items[1]!.textContent).toContain("/pdf/b.pdf");
  });

  it("ajoute 'résultats partiels' quand partial", () => {
    mount();
    update(results([doc("a", [1])], true));
    expect(status()).toContain("partiels");
  });

  it("limite à 5 cartes, avec aria-label et vignette attachée", () => {
    mount();
    update(results([doc("a", [1, 2, 3, 4, 5, 6, 7])]));
    expect(cards()).toHaveLength(5);
    expect(cards()[1]!.getAttribute("aria-label")).toBe("Titre a, page 2");
    expect(attach).toHaveBeenCalledTimes(5);
    expect(attach.mock.calls[0]![1]).toEqual({
      docId: "a",
      path: "/pdf/a.pdf",
      page: 1,
      query: "chat",
      pdfSize: 10,
      pdfModifiedMs: 20,
    });
  });

  it("n'utilise jamais innerHTML pour les titres", () => {
    mount();
    update(results([doc("a", [1], '<img src=x onerror="1">')]));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror="1">');
  });

  it("ouvre au clic et à Entrée", () => {
    mount();
    update(results([doc("a", [3])]));
    cards()[0]!.click();
    expect(onOpen).toHaveBeenCalledWith("a", 3, "chat");
    onOpen.mockClear();
    key(cards()[0]!, "Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("navigue au clavier avec roving tabindex", () => {
    mount();
    update(results([doc("a", [1, 2]), doc("b", [7])]));
    const input = host.querySelector("input")!;
    input.focus();
    key(input, "ArrowDown");
    const c = cards();
    expect(document.activeElement).toBe(c[0]);
    key(c[0]!, "ArrowDown");
    expect(document.activeElement).toBe(c[1]);
    expect(c[1]!.tabIndex).toBe(0);
    expect(c[0]!.tabIndex).toBe(-1);
    key(c[1]!, "ArrowDown");
    expect(document.activeElement).toBe(c[2]);
    key(c[2]!, "ArrowDown");
    expect(document.activeElement).toBe(c[2]);
    key(c[2]!, "ArrowUp");
    expect(document.activeElement).toBe(c[1]);
    key(c[1]!, "ArrowUp");
    key(c[0]!, "ArrowUp");
    expect(document.activeElement).toBe(input);
  });

  it("Échap vide la saisie", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "chat";
    key(input, "Escape");
    expect(input.value).toBe("");
    expect(setQuery).toHaveBeenCalledWith("");
  });

  it("ne reconstruit pas les cartes inchangées, détache les supprimées", () => {
    mount();
    update(results([doc("a", [1]), doc("b", [2])]));
    const first = cards()[0]!;
    update(results([doc("a", [1])]));
    expect(cards()[0]).toBe(first);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("détache tout au dispose et vide l'hôte", () => {
    const view = mount();
    update(results([doc("a", [1, 2])]));
    view.dispose();
    expect(detach).toHaveBeenCalledTimes(2);
    expect(host.children).toHaveLength(0);
    view.dispose();
    expect(detach).toHaveBeenCalledTimes(2);
  });

  it("focusInput met le focus sur la saisie", () => {
    const view = mount();
    view.focusInput();
    expect(document.activeElement).toBe(host.querySelector("input"));
  });
});
