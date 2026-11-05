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

function focusFirst(): void {
  cards()[0]!.focus();
}

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

  describe("dépliage des pages restantes", () => {
    const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const more = () => host.querySelector<HTMLButtonElement>("button.docseeker-more");
    const less = () => host.querySelector<HTMLButtonElement>("button.docseeker-less");
    const visible = (b: HTMLButtonElement | null) => b !== null && !b.hidden;

    it("n'affiche aucun bouton quand il y a 5 pages ou moins", () => {
      mount();
      update(results([doc("a", range(5))]));
      expect(more()).toBeNull();
      expect(less()).toBeNull();
    });

    it("rend un vrai bouton replié avec le libellé du reste", () => {
      mount();
      update(results([doc("a", range(8))]));
      const b = more()!;
      expect(b.tagName).toBe("BUTTON");
      expect(b.type).toBe("button");
      expect(b.className).toBe("docseeker-more b3-button b3-button--outline");
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(b.textContent).toBe("et 3 autres pages");
      expect(visible(less())).toBe(false);
    });

    it("déplie par lots de 10 et met à jour libellé et aria-expanded", () => {
      mount();
      update(results([doc("a", range(27))]));
      expect(more()!.textContent).toBe("et 22 autres pages");
      more()!.click();
      expect(cards()).toHaveLength(15);
      expect(more()!.textContent).toBe("et 12 autres pages");
      expect(more()!.getAttribute("aria-expanded")).toBe("true");
      more()!.click();
      expect(cards()).toHaveLength(25);
      expect(more()!.textContent).toBe("et 2 autres pages");
      more()!.click();
      expect(cards()).toHaveLength(27);
      expect(visible(more())).toBe(false);
      expect(cards().map((c) => c.dataset["page"])).toEqual(range(27).map(String));
    });

    it("utilise le singulier pour un seul reste", () => {
      mount();
      update(results([doc("a", range(6))]));
      expect(more()!.textContent).toBe("et 1 autre page");
    });

    it("garde le focus sur le bouton après dépliage et le passe à Replier quand tout est affiché", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.focus();
      more()!.click();
      expect(cards()).toHaveLength(12);
      expect(visible(more())).toBe(false);
      expect(document.activeElement).toBe(less());
      expect(less()!.textContent).toBe("Replier");
    });

    it("garde le focus sur le bouton quand il reste des pages", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.focus();
      more()!.click();
      expect(document.activeElement).toBe(more());
    });

    it("replie vers les 5 premières cartes, détache les vignettes ajoutées et rend le focus à Plus", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      expect(attach).toHaveBeenCalledTimes(12);
      less()!.focus();
      less()!.click();
      expect(cards()).toHaveLength(5);
      expect(detach).toHaveBeenCalledTimes(7);
      expect(visible(less())).toBe(false);
      expect(more()!.getAttribute("aria-expanded")).toBe("false");
      expect(more()!.textContent).toBe("et 7 autres pages");
      expect(document.activeElement).toBe(more());
      expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    });

    it("annonce le vrai reste tant que des pages sont dépliables, puis une note non interactive", () => {
      mount();
      const d = { ...doc("a", range(200)), matchingPages: 250 };
      update(results([d]));
      expect(more()!.textContent).toBe("et 245 autres pages");
      expect(host.querySelector<HTMLElement>(".docseeker-truncated")!.hidden).toBe(true);
      for (let i = 0; i < 20 && visible(more()); i++) more()!.click();
      expect(cards()).toHaveLength(200);
      expect(visible(more())).toBe(false);
      expect(visible(less())).toBe(true);
      expect(document.activeElement === document.body || document.activeElement === less()).toBe(true);
      const note = host.querySelector<HTMLElement>(".docseeker-truncated")!;
      expect(note.hidden).toBe(false);
      expect(note.tagName).not.toBe("BUTTON");
      expect(note.textContent).toBe("50 pages non affichées");
      expect(host.querySelector(".docseeker-doc-count")!.textContent).toContain("250");
    });

    it("plafond de bout en bout : 200 pages, Plus masqué, Replier focalisé, 200 cartes", () => {
      mount();
      update(results([doc("a", range(200))]));
      more()!.focus();
      for (let i = 0; i < 30 && visible(more()); i++) more()!.click();
      expect(cards()).toHaveLength(200);
      expect(visible(more())).toBe(false);
      expect(visible(less())).toBe(true);
      expect(document.activeElement).toBe(less());
      expect(host.querySelector<HTMLElement>(".docseeker-truncated")!.hidden).toBe(true);
    });

    it("oublie l'expansion d'un document qui rétrécit à 5 pages ou moins", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update(results([doc("a", range(4))]));
      expect(more()).toBeNull();
      update(results([doc("a", range(30))]));
      expect(cards()).toHaveLength(5);
      expect(more()!.getAttribute("aria-expanded")).toBe("false");
    });

    it("reste replié après déplier, replier puis re-rendu", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      less()!.click();
      update(results([doc("a", range(30))]));
      expect(cards()).toHaveLength(5);
    });

    it("donne aux boutons un nom contenant le titre, aria-controls et aria-expanded cohérents", () => {
      mount();
      update(results([doc("a", range(12), "Mon doc")]));
      const m = more()!;
      expect(m.getAttribute("aria-label")).toBe("et 7 autres pages, Mon doc");
      const controlled = host.querySelector(`#${m.getAttribute("aria-controls")}`)!;
      expect(controlled.className).toBe("docseeker-cards");
      m.click();
      expect(less()!.getAttribute("aria-label")).toBe("Replier, Mon doc");
      expect(less()!.getAttribute("aria-controls")).toBe(m.getAttribute("aria-controls"));
      expect(less()!.getAttribute("aria-expanded")).toBe("true");
      expect(m.getAttribute("aria-expanded")).toBe("true");
    });

    it("utilise des identifiants aria-controls uniques par document", () => {
      mount();
      update(results([doc("a", range(8)), doc("b", range(8))]));
      const ids = Array.from(host.querySelectorAll("button.docseeker-more")).map((b) => b.getAttribute("aria-controls"));
      expect(new Set(ids).size).toBe(2);
    });

    it("annonce le changement dans la région de statut", () => {
      mount();
      update(results([doc("a", range(12), "Mon doc")]));
      more()!.click();
      expect(status()).toBe("12 pages affichées pour Mon doc");
      less()!.click();
      expect(status()).toBe("5 pages affichées pour Mon doc");
    });

    it("rend le focus à Plus quand la carte focalisée est retirée au repli", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      cards()[9]!.focus();
      less()!.click();
      expect(document.activeElement).toBe(more());
    });

    it("garde un seul arrêt tabulation réel : ArrowRight jusqu'à la carte 10 puis Replier", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      cards()[0]!.focus();
      for (let i = 0; i < 9; i++) key(document.activeElement!, "ArrowRight");
      expect(document.activeElement).toBe(cards()[9]);
      less()!.click();
      expect(cards().map((c) => c.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    });

    it("conserve le focus de Plus à travers un re-rendu à signature modifiée", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.focus();
      update(results([doc("a", [...range(30), 31])]));
      expect(document.activeElement).toBe(more());
    });

    it("conserve le focus de Replier à travers un re-rendu à signature modifiée", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      expect(document.activeElement === less() || document.activeElement === document.body).toBe(true);
      less()!.focus();
      update(results([doc("a", [...range(12), 13])]));
      expect(document.activeElement).toBe(less());
    });

    it("bascule le focus sur Replier quand le Plus focalisé devient masqué par un re-rendu", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      more()!.focus();
      update(results([doc("a", range(15))]));
      expect(visible(more())).toBe(false);
      expect(document.activeElement).toBe(less());
    });

    it("détache exactement 12 fois au total après repli puis dispose", () => {
      const view = mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      less()!.click();
      view.dispose();
      expect(detach).toHaveBeenCalledTimes(12);
    });

    it("détache exactement 12 fois au total après repli puis disparition du document", () => {
      mount();
      update(results([doc("a", range(12))]));
      more()!.click();
      less()!.click();
      update(results([doc("b", [1])]));
      expect(detach).toHaveBeenCalledTimes(12);
    });

    it("détecte un changement d'ordre ou de contenu au-delà des premières pages", () => {
      mount();
      const base = range(100);
      update(results([doc("a", base)]));
      attach.mockClear();
      const swapped = [...base];
      [swapped[80], swapped[81]] = [swapped[81]!, swapped[80]!];
      update(results([doc("a", swapped)]));
      expect(attach).toHaveBeenCalledTimes(5);
      attach.mockClear();
      update(results([doc("a", swapped)]));
      expect(attach).not.toHaveBeenCalled();
    });

    it("l'état déplié est abandonné quand la vue passe par un état transitoire (loading)", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update({ kind: "loading", progress: { loaded: 1, total: 2, failed: [] } });
      update(results([doc("a", range(30))]));
      expect(cards()).toHaveLength(5);
    });

    it("conserve l'état déplié lors d'un re-rendu à requête identique", () => {
      mount();
      update(results([doc("a", range(30)), doc("b", range(7))]));
      more()!.click();
      attach.mockClear();
      detach.mockClear();
      update(results([doc("a", range(30)), doc("b", range(7))]));
      expect(more()!.textContent).toBe("et 15 autres pages");
      expect(more()!.getAttribute("aria-expanded")).toBe("true");
      expect(cards().filter((c) => c.dataset["docId"] === "a")).toHaveLength(15);
      expect(attach).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    });

    it("conserve l'état déplié quand le contenu du document change (tri, indexation à chaud)", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update(results([doc("a", [...range(30), 31, 32])]));
      expect(cards().slice(0, 15).map((c) => c.dataset["page"])).toEqual(range(15).map(String));
      expect(cards()).toHaveLength(15);
      expect(more()!.textContent).toBe("et 17 autres pages");
      update(results([doc("a", range(30).reverse())]));
      expect(cards()[0]!.dataset["page"]).toBe("30");
      expect(cards()).toHaveLength(15);
    });

    it("réinitialise l'état à une nouvelle requête", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update({ ...(results([doc("a", range(30))]) as Extract<SearchViewModel, { kind: "results" }>), query: "chien" });
      expect(cards()).toHaveLength(5);
      expect(more()!.getAttribute("aria-expanded")).toBe("false");
    });

    it("réinitialise l'état quand les résultats disparaissent", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update({ kind: "empty-query" });
      update(results([doc("a", range(30))]));
      expect(cards()).toHaveLength(5);
    });

    it("ne fuit pas de détacheurs : tout est détaché au dispose", () => {
      const view = mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      more()!.click();
      expect(attach).toHaveBeenCalledTimes(25);
      view.dispose();
      expect(detach).toHaveBeenCalledTimes(25);
    });

    it("détache les cartes dépliées quand le document disparaît", () => {
      mount();
      update(results([doc("a", range(30))]));
      more()!.click();
      update(results([doc("b", [1])]));
      expect(detach).toHaveBeenCalledTimes(15);
    });

    it("attache les vignettes des cartes ajoutées avec la bonne requête", () => {
      mount();
      update(results([doc("a", range(8))]));
      more()!.click();
      expect(attach).toHaveBeenCalledTimes(8);
      expect(attach.mock.calls[7]![1]).toMatchObject({ docId: "a", page: 8, query: "chat", pdfSize: 10 });
    });

    it("inclut les cartes dépliées dans la navigation clavier", () => {
      mount();
      update(results([doc("a", range(8)), doc("b", [1])]));
      more()!.click();
      focusFirst();
      key(document.activeElement!, "End");
      expect(document.activeElement).toBe(cards()[cards().length - 1]);
      expect(cards()[cards().length - 1]!.dataset["docId"]).toBe("b");
      key(document.activeElement!, "ArrowLeft");
      expect(document.activeElement).toBe(cards()[7]);
      expect(cards()[7]!.dataset["page"]).toBe("8");
      key(document.activeElement!, "Home");
      expect(document.activeElement).toBe(cards()[0]);
      expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    });

    it("ouvre le PDF à la bonne page depuis une carte dépliée", () => {
      mount();
      update(results([doc("a", range(8))]));
      more()!.click();
      cards()[7]!.click();
      expect(onOpen).toHaveBeenCalledWith("a", 8, "chat");
    });

    it("utilise la clé i18n showLess et un libellé par défaut", () => {
      mount({ t: (k) => (k === "showLess" ? "Collapse" : k) });
      update(results([doc("a", range(6))]));
      more()!.click();
      expect(less()!.textContent).toBe("Collapse");
    });
  });
});
