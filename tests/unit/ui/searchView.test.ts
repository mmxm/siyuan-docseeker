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
function results(docs: ReturnType<typeof doc>[], partial = false, failedCount = 0): SearchViewModel {
  return { kind: "results", query: "chat", docs, partial, total: docs.length, failedCount };
}

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let detach: Mock;
let attach: Mock;
let onOpen: Mock;
let setQuery: Mock;

function mount(extra: { onReindex?: () => void; t?: (key: string) => string } = {}) {
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
const status = () => host.querySelector(".docseeker-status")!.textContent ?? "";
const alertText = () => host.querySelector('[role="alert"]')!.textContent ?? "";
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
    update({ kind: "no-result", query: "x", partial: false, failedCount: 0 });
    expect(status()).toBe("Aucun résultat");
    update({ kind: "loading", progress: { loaded: 12, total: 47, failed: [] } });
    expect(status()).toBe("Résultats partiels, index en cours de construction (12/47)");
    update({ kind: "error", message: "boum <b>" });
    expect(alertText()).toContain("boum <b>");
    expect(status()).toBe("");
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

  it("ne montre le bouton Réindexer que si nécessaire", () => {
    mount({ onReindex: vi.fn() });
    const visible = () => {
      const b = host.querySelector<HTMLButtonElement>("button.docseeker-reindex");
      return !!b && !b.hidden && host.contains(b);
    };
    update({ kind: "no-index", indexing: false });
    expect(visible()).toBe(true);
    update(results([doc("a", [1])]));
    expect(visible()).toBe(false);
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
    expect(cards()[1]!.getAttribute("aria-label")).toBe("Titre a, p. 2");
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

  describe("accessibilité et robustesse (relectures)", () => {
    it("pose lang=fr et deux régions live présentes dès le montage", () => {
      mount();
      expect(host.querySelector<HTMLElement>(".docseeker-search")!.lang).toBe("fr");
      const st = host.querySelector('[role="status"]')!;
      expect(st.getAttribute("aria-live")).toBe("polite");
      expect(st.getAttribute("aria-atomic")).toBe("true");
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });

    it("garde le bouton Réindexer hors des régions live", () => {
      mount({ onReindex: vi.fn() });
      update({ kind: "no-index", indexing: false });
      const b = host.querySelector("button.docseeker-reindex")!;
      expect(b.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    });

    it("ne réécrit pas le texte d'état s'il est identique", () => {
      mount();
      update(results([doc("a", [1])]));
      const node = host.querySelector(".docseeker-status")!.firstChild;
      update(results([doc("a", [1])]));
      expect(host.querySelector(".docseeker-status")!.firstChild).toBe(node);
    });

    it("vide l'alerte quand l'erreur disparaît", () => {
      mount();
      update({ kind: "error", message: "x" });
      update(results([doc("a", [1])]));
      expect(alertText()).toBe("");
    });

    it("le nom accessible de la carte contient le texte visible", () => {
      mount();
      update(results([doc("a", [4], "Mon titre")]));
      const c = cards()[0]!;
      const visible = c.querySelector(".docseeker-card-page")!.textContent!;
      expect(c.getAttribute("aria-label")).toContain(visible);
      expect(c.getAttribute("aria-label")).toBe("Mon titre, p. 4");
    });

    it("annonce les pages non affichées au-delà de 5", () => {
      mount();
      update(results([doc("a", [1, 2, 3, 4, 5, 6, 7, 8])]));
      expect(host.querySelector("li")!.textContent).toContain("et 3 autres pages");
      update(results([doc("a", [1, 2, 3, 4, 5, 6])]));
      expect(host.querySelector("li")!.textContent).toContain("et 1 autre page");
      update(results([doc("a", [1, 2])]));
      expect(host.querySelector("li")!.textContent).not.toContain("autre");
    });

    it("structure : liste nommée, titre de document en h3", () => {
      mount();
      update(results([doc("a", [1], "Titre a")]));
      expect(host.querySelector("ul")!.getAttribute("aria-label")).toBeTruthy();
      const h = host.querySelector("li h3")!;
      expect(h.textContent).toContain("Titre a");
      expect(h.textContent).toMatch(/Titre a.+1 page correspondante/);
    });

    it("restitue le focus à la saisie si la carte focalisée disparaît", () => {
      mount();
      update(results([doc("a", [1]), doc("b", [2])]));
      cards()[1]!.focus();
      update(results([doc("a", [1])]));
      expect(document.activeElement).toBe(host.querySelector("input"));
      cards()[0]!.focus();
      update({ kind: "no-result", query: "x", partial: false, failedCount: 0 });
      expect(document.activeElement).toBe(host.querySelector("input"));
    });

    it("Home/End et flèches gauche/droite naviguent entre cartes", () => {
      mount();
      update(results([doc("a", [1, 2]), doc("b", [7])]));
      const c = cards();
      c[0]!.focus();
      key(c[0]!, "End");
      expect(document.activeElement).toBe(c[2]);
      key(c[2]!, "ArrowLeft");
      expect(document.activeElement).toBe(c[1]);
      key(c[1]!, "ArrowRight");
      expect(document.activeElement).toBe(c[2]);
      key(c[2]!, "Home");
      expect(document.activeElement).toBe(c[0]);
    });

    it("affiche le nombre d'index illisibles avec réindexation", () => {
      mount({ onReindex: vi.fn() });
      update(results([doc("a", [1])], false, 2));
      expect(status()).toContain("2 index illisibles : réindexer");
      expect(host.querySelector<HTMLButtonElement>("button.docseeker-reindex")!.hidden).toBe(false);
      update({ kind: "no-result", query: "x", partial: false, failedCount: 1 });
      expect(status()).toContain("1 index illisible : réindexer");
    });

    it("utilise réellement la fonction de traduction fournie", () => {
      mount({ t: (k) => (k === "noResults" ? "No results" : k) });
      update({ kind: "no-result", query: "x", partial: false, failedCount: 0 });
      expect(status()).toBe("No results");
    });
  });
});
