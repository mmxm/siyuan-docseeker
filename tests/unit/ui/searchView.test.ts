// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SearchViewModel } from "../../../src/search/searchController";
import { mountSearchView, type SearchViewDeps, type ThumbnailAttacher } from "../../../src/ui/searchView";
import { SEARCH_STYLE_ID } from "../../../src/ui/searchStyles";
import { createNativeFakes } from "./nativeFakes";

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
function results(
  docs: ReturnType<typeof doc>[],
  partial = false,
  failedCount = 0,
  ranking: "bm25" | "proximity" = "bm25",
  hiddenByFilters = 0,
): SearchViewModel {
  return { kind: "results", query: "chat", docs, partial, total: docs.length, failedCount, ranking, hiddenByFilters };
}

let host: HTMLElement;
let vm: SearchViewModel;
let listener: () => void;
let detach: Mock;
let attach: Mock;
let onOpen: Mock;
let submit: Mock;
let fakes: ReturnType<typeof createNativeFakes>;

function mount(extra: Partial<SearchViewDeps> = {}) {
  const thumbnails: ThumbnailAttacher = { attach: attach as ThumbnailAttacher["attach"] };
  return mountSearchView(host, {
    controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
    subscribe: (l) => {
      listener = l;
      return () => undefined;
    },
    thumbnails,
    onOpen: onOpen as (d: string, p: number, q: string) => void,
    getDocMeta: () => ({ pdfSize: 10, pdfModifiedMs: 20 }),
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
  submit = vi.fn();
  fakes = createNativeFakes();
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
    expect(status()).toBe("Saisissez des mots puis appuyez sur Entrée");
  });

  it("taper ne lance aucune recherche", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "chat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("vider le champ (croix native : événement search) repasse à l'état vide", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "chat";
    input.dispatchEvent(new Event("search", { bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    input.value = "";
    input.dispatchEvent(new Event("search", { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("");
  });

  it("un événement input à valeur vide soumet la chaîne vide, non vide ne soumet rien", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "c";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit).toHaveBeenCalledWith("");
  });

  it("placeholder explicite sur Entrée, aria-label court, enterkeyhint=search", () => {
    mount();
    const input = host.querySelector("input")!;
    expect(input.placeholder).toBe("Rechercher dans vos PDF (Entrée pour lancer)");
    expect(input.getAttribute("aria-label")).toBe("Rechercher dans les PDF");
    expect(input.getAttribute("enterkeyhint")).toBe("search");
  });

  it("Entrée dans le champ soumet le texte courant, et de nouveau à chaque appui", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "chat";
    key(input, "Enter");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenLastCalledWith("chat");
    key(input, "Enter");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith("chat");
  });

  it("Entrée pendant une composition IME ne soumet pas", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "ね";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("Entrée avec un champ vidé soumet la chaîne vide (retour à l'état vide)", () => {
    mount();
    const input = host.querySelector("input")!;
    input.value = "";
    key(input, "Enter");
    expect(submit).toHaveBeenCalledWith("");
  });

  it("annonce l'état vide dans la région de statut, en invitant à appuyer sur Entrée", () => {
    mount();
    expect(status()).toBe("Saisissez des mots puis appuyez sur Entrée");
    expect(host.querySelector(".docseeker-status")!.getAttribute("role")).toBe("status");
  });

  it("affiche seulement le dossier du PDF, le chemin complet en infobulle", () => {
    mount();
    update(results([doc("a", [1])]));
    const el = host.querySelector<HTMLElement>(".docseeker-doc-path")!;
    expect(el.textContent).toBe("/pdf/");
    expect(el.title).toBe("/pdf/a.pdf");
    expect(el.textContent).not.toContain("a.pdf");
  });

  it("E4b : le chemin complet est aussi en texte visible (masqué par le CSS hors tactile), sans HTML interprété", () => {
    mount();
    const d = { ...doc("a", [1]), path: "/x/<img src=x onerror=alert(1)>/a.pdf" };
    update(results([d]));
    const full = host.querySelector<HTMLElement>(".docseeker-doc-fullpath")!;
    expect(full.textContent).toBe("/x/<img src=x onerror=alert(1)>/a.pdf");
    expect(full.querySelector("img")).toBeNull();
    expect(full.hidden).toBe(false);
  });

  it("E4b : le chemin complet est masqué quand le PDF n'a pas de dossier", () => {
    mount();
    update(results([{ ...doc("a", [1]), path: "a.pdf" }]));
    expect(host.querySelector<HTMLElement>(".docseeker-doc-fullpath")!.hidden).toBe(true);
  });

  it("n'interprète pas le HTML d'un chemin", () => {
    mount();
    const d = { ...doc("a", [1]), path: "/x/<img src=x onerror=alert(1)>/a.pdf" };
    update(results([d]));
    const el = host.querySelector<HTMLElement>(".docseeker-doc-path")!;
    expect(el.textContent).toBe("/x/<img src=x onerror=alert(1)>/");
    expect(el.querySelector("img")).toBeNull();
  });

  it("masque la ligne de chemin quand le PDF n'a pas de dossier", () => {
    mount();
    update(results([{ ...doc("a", [1]), path: "a.pdf" }]));
    const el = host.querySelector<HTMLElement>(".docseeker-doc-path")!;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });

  it("compteur du titre : « 1 page » / « 2 pages » sans « correspondante »", () => {
    mount();
    update(results([doc("a", [1]), doc("b", [1, 2])]));
    const counters = Array.from(host.querySelectorAll(".docseeker-doc-count")).map((c) => c.textContent);
    expect(counters).toEqual(["— 1 page", "— 2 pages"]);
  });

  it("affiche les messages de statut", () => {
    mount();
    update({ kind: "no-result", query: "x", partial: false, failedCount: 0, hiddenByFilters: 0 });
    expect(status()).toBe("Aucun résultat");
    update({ kind: "loading", progress: { loaded: 12, total: 47, failed: [] } });
    expect(status()).toBe("Résultats partiels, index en cours de construction (12/47)");
    update({ kind: "error", message: "boum <b>" });
    expect(alertText()).toContain("boum <b>");
    expect(status()).toBe("");
    expect(host.querySelector("b")).toBeNull();
    update({ kind: "no-index", indexing: false });
    expect(status()).toContain("Aucun index : ouvrez les paramètres du plugin pour lancer l'indexation");
    expect(host.querySelector("button.docseeker-open-settings")).toBeNull();
  });

  it("lecture seule (mobile) : « aucun index » ne renvoie pas aux paramètres d'indexation mais explique la synchronisation", () => {
    mount({ readOnly: true });
    update({ kind: "no-index", indexing: false });
    expect(status()).toBe("L'index se construit dans SiYuan sur ordinateur, puis se synchronise");
    expect(status()).not.toContain("lancer l'indexation");
  });

  it("ne propose pas les paramètres pour une simple erreur de recherche (hors index)", () => {
    mount({ onOpenSettings: vi.fn() });
    update({ kind: "error", message: "boum" });
    expect(host.querySelector<HTMLButtonElement>("button.docseeker-open-settings")!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".docseeker-actions")!.hidden).toBe(true);
  });

  it("montre le conteneur d'actions avec le bouton, le masque avec lui", () => {
    mount({ onOpenSettings: vi.fn() });
    const actions = host.querySelector<HTMLElement>(".docseeker-actions")!;
    expect(actions.hidden).toBe(true);
    update({ kind: "no-index", indexing: false });
    expect(actions.hidden).toBe(false);
    update(results([doc("a", [1])]));
    expect(actions.hidden).toBe(true);
  });

  it("ne propose plus de bouton de réindexation dans l'onglet", () => {
    mount({ onOpenSettings: vi.fn() });
    update({ kind: "no-index", indexing: false });
    expect(host.querySelector("button.docseeker-reindex")).toBeNull();
    expect(host.textContent).not.toMatch(/Réindexer/);
  });

  it("propose d'ouvrir les paramètres si onOpenSettings fourni", () => {
    const onOpenSettings = vi.fn();
    mount({ onOpenSettings });
    update({ kind: "no-index", indexing: false });
    const button = host.querySelector<HTMLButtonElement>("button.docseeker-open-settings")!;
    expect(button.textContent).toBe("Ouvrir les paramètres");
    expect(button.type).toBe("button");
    button.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("ne montre le bouton Ouvrir les paramètres que si nécessaire", () => {
    mount({ onOpenSettings: vi.fn() });
    const visible = () => {
      const b = host.querySelector<HTMLButtonElement>("button.docseeker-open-settings");
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
    expect(items[1]!.textContent).toContain("/pdf/");
    expect(items[1]!.querySelector(".docseeker-doc-path")!.textContent).not.toContain("b.pdf");
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
    expect(onOpen).toHaveBeenCalledWith("a", 3, "chat", { alternate: false });
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
    expect(submit).toHaveBeenCalledWith("");
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

    it("garde le bouton Ouvrir les paramètres hors des régions live", () => {
      mount({ onOpenSettings: vi.fn() });
      update({ kind: "no-index", indexing: false });
      const b = host.querySelector("button.docseeker-open-settings")!;
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
      const visible = c.querySelector(".docseeker-thumb .docseeker-card-page")!.textContent!;
      expect(c.getAttribute("aria-label")).toContain(visible);
      expect(c.getAttribute("aria-label")).toBe("Mon titre, p. 4");
    });

    it("le numéro de page est une pastille dans la vignette, sans libellé sous la vignette", () => {
      mount();
      update(results([doc("a", [4], "Mon titre")]));
      const c = cards()[0]!;
      const badge = c.querySelector(".docseeker-thumb > .docseeker-card-page")!;
      expect(badge.textContent).toBe("p. 4");
      expect(c.querySelectorAll(".docseeker-card-page")).toHaveLength(1);
      expect(Array.from(c.children).some((k) => k.classList.contains("docseeker-card-page"))).toBe(false);
    });

    const rowShape = (row: Element): string[] =>
      Array.from(row.children).map((k) =>
        k.matches("button.docseeker-card") ? "card" : k.classList.contains("docseeker-more") ? "more" : k.classList.contains("docseeker-less") ? "less" : k.classList.contains("docseeker-truncated") ? "note" : "autre",
      );
    const rep = (n: number, v: string): string[] => Array.from({ length: n }, () => v);

    it("« et N autres pages » et « Replier » sont dans la rangée, à la suite des cartes", () => {
      mount();
      update(results([doc("a", Array.from({ length: 12 }, (_, i) => i + 1))]));
      const row = host.querySelector(".docseeker-cards")!;
      const more = row.querySelector("button.docseeker-more") as HTMLButtonElement;
      expect(host.querySelector(".docseeker-more-actions")).toBeNull();
      expect(rowShape(row)).toEqual([...rep(5, "card"), "more", "less", "note"]);
      more.focus();
      more.click();
      expect(rowShape(row)).toEqual([...rep(12, "card"), "more", "less", "note"]);
      expect(row.querySelector<HTMLElement>("button.docseeker-less")!.hidden).toBe(false);
    });

    it("deux dépliages puis Replier : cartes, ordre de la rangée et focus conservés", () => {
      mount();
      update(results([doc("a", Array.from({ length: 30 }, (_, i) => i + 1))]));
      const row = host.querySelector(".docseeker-cards")!;
      const more = row.querySelector("button.docseeker-more") as HTMLButtonElement;
      const less = row.querySelector("button.docseeker-less") as HTMLButtonElement;
      more.focus();
      more.click();
      more.click();
      expect(row.querySelectorAll("button.docseeker-card")).toHaveLength(25);
      expect(rowShape(row)).toEqual([...rep(25, "card"), "more", "less", "note"]);
      less.focus();
      less.click();
      expect(row.querySelectorAll("button.docseeker-card")).toHaveLength(5);
      expect(rowShape(row)).toEqual([...rep(5, "card"), "more", "less", "note"]);
      expect(more.hidden).toBe(false);
      expect(less.hidden).toBe(true);
      expect(document.activeElement).toBe(more);
      expect(document.activeElement).not.toBe(document.body);
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
      expect(h.textContent).toMatch(/Titre a.+1 page$/);
    });

    it("restitue le focus à la saisie si la carte focalisée disparaît", () => {
      mount();
      update(results([doc("a", [1]), doc("b", [2])]));
      cards()[1]!.focus();
      update(results([doc("a", [1])]));
      expect(document.activeElement).toBe(host.querySelector("input"));
      cards()[0]!.focus();
      update({ kind: "no-result", query: "x", partial: false, failedCount: 0, hiddenByFilters: 0 });
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

    it("affiche le nombre d'index illisibles avec accès aux paramètres", () => {
      mount({ onOpenSettings: vi.fn() });
      update(results([doc("a", [1])], false, 2));
      expect(status()).toContain("2 index illisibles : réindexez depuis les paramètres (détails dans le journal)");
      expect(host.querySelector<HTMLButtonElement>("button.docseeker-open-settings")!.hidden).toBe(false);
      update({ kind: "no-result", query: "x", partial: false, failedCount: 1, hiddenByFilters: 0 });
      expect(status()).toContain("1 index illisible : réindexez depuis les paramètres (détails dans le journal)");
    });

    it("utilise réellement la fonction de traduction fournie", () => {
      mount({ t: (k) => (k === "noResults" ? "No results" : k) });
      update({ kind: "no-result", query: "x", partial: false, failedCount: 0, hiddenByFilters: 0 });
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
      expect(onOpen).toHaveBeenCalledWith("a", 8, "chat", { alternate: false });
    });

    it("utilise la clé i18n showLess et un libellé par défaut", () => {
      mount({ t: (k) => (k === "showLess" ? "Collapse" : k) });
      update(results([doc("a", range(6))]));
      more()!.click();
      expect(less()!.textContent).toBe("Collapse");
    });
  });
  describe("classement affiné (proximité)", () => {
    const more = () => host.querySelector<HTMLButtonElement>("button.docseeker-more");
    const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
    const REFINED = "Classement affiné par proximité des mots";

    it("n'annonce rien en classement bm25 et annonce une seule fois le passage à proximity", () => {
      mount();
      update(results([doc("a", [1]), doc("b", [1])]));
      expect(status()).not.toContain(REFINED);
      const region = host.querySelector(".docseeker-status")!;
      const texts: string[] = [];
      new MutationObserver(() => texts.push(region.textContent ?? "")).observe(region, {
        childList: true, characterData: true, subtree: true,
      });
      update(results([doc("b", [1]), doc("a", [1])], false, 0, "proximity"));
      expect(status()).toContain(REFINED);
      update(results([doc("a", [1]), doc("b", [1])], false, 0, "proximity")); // fenêtre suivante
      expect(status().match(/affiné/g)).toHaveLength(1);
      return Promise.resolve().then(() => {
        expect(texts.filter((t) => t.includes(REFINED))).toHaveLength(1);
      });
    });

    it("mobile plein écran (readOnly) : la mention est omise, le décompte reste", () => {
      mount({ readOnly: true });
      update(results([doc("a", [1])], false, 0, "proximity"));
      expect(status()).not.toContain(REFINED);
      expect(status()).toMatch(/1 document.*1 page/);
    });

    it("utilise la clé i18n rankingRefined", () => {
      mount({ t: (k) => (k === "rankingRefined" ? "Refined" : k) });
      update(results([doc("a", [1])], false, 0, "proximity"));
      expect(status()).toContain("Refined");
    });

    it("réordonne les documents sans reconstruire leurs cartes", () => {
      mount();
      update(results([doc("a", [1, 2]), doc("b", [1, 2])]));
      const before = attach.mock.calls.length;
      const li = host.querySelector('[data-doc-id="a"]')!.closest("li")!;
      update(results([doc("b", [1, 2]), doc("a", [1, 2])], false, 0, "proximity"));
      expect(attach.mock.calls.length).toBe(before);
      expect(detach).not.toHaveBeenCalled();
      expect(Array.from(host.querySelectorAll("li.docseeker-doc")).map((e) => e.querySelector("button")!.dataset["docId"])).toEqual(["b", "a"]);
      expect(host.querySelector('[data-doc-id="a"]')!.closest("li")).toBe(li);
    });

    it("garde l'état déplié et le focus au ré-ordonnancement des documents", () => {
      mount();
      update(results([doc("a", range(8)), doc("b", range(2))]));
      more()!.click();
      expect(cards().filter((c) => c.dataset["docId"] === "a")).toHaveLength(8);
      const target = cards().find((c) => c.dataset["docId"] === "a" && c.dataset["page"] === "7")!;
      target.focus();
      update(results([doc("b", range(2)), doc("a", range(8))], false, 0, "proximity"));
      expect(cards().filter((c) => c.dataset["docId"] === "a")).toHaveLength(8);
      expect(document.activeElement).toBe(target);
    });

    it("garde l'état déplié quand l'ordre des 5 premières pages change (reconstruction), et le focus par docId|page", () => {
      mount();
      update(results([doc("a", range(8))]));
      more()!.click();
      cards().find((c) => c.dataset["page"] === "7")!.focus();
      update(results([doc("a", [3, 1, 2, 4, 5, 6, 7, 8])], false, 0, "proximity"));
      const pages = cards().map((c) => c.dataset["page"]);
      expect(pages).toEqual(["3", "1", "2", "4", "5", "6", "7", "8"]);
      expect((document.activeElement as HTMLElement).dataset["page"]).toBe("7");
    });

    it("ne reconstruit pas un document dont les 5 premières pages gardent leur ordre", () => {
      mount();
      update(results([doc("a", range(8))]));
      const before = attach.mock.calls.length;
      update(results([doc("a", range(8))], false, 0, "proximity"));
      expect(attach.mock.calls.length).toBe(before);
    });

    it("reconstruit seulement le document dont l'ordre des 5 premières pages a changé", () => {
      mount();
      update(results([doc("a", [1, 2, 3]), doc("b", [1, 2, 3])]));
      const before = attach.mock.calls.length;
      update(results([doc("a", [1, 2, 3]), doc("b", [2, 1, 3])], false, 0, "proximity"));
      expect(attach.mock.calls.length).toBe(before + 3);
      expect(detach).toHaveBeenCalledTimes(3);
    });
  });
});


// ---- Filtres (J10 b) ----
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";

describe("filtres dans la vue", () => {
  let opts: SearchOptions;
  let setOptions: Mock;
  const optionsDeps = (): NonNullable<SearchViewDeps["options"]> => ({
    getOptions: () => opts,
    setOptions: setOptions as (o: SearchOptions) => void,
  });
  beforeEach(() => {
    opts = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
    setOptions = vi.fn((o: SearchOptions) => {
      opts = o;
    });
  });
  const noResult = (hiddenByFilters: number): SearchViewModel => ({
    kind: "no-result", query: "x", partial: false, failedCount: 0, hiddenByFilters,
  });
  const resetButton = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>(".docseeker-actions button")).find(
      (b) => b.textContent === "Réinitialiser les filtres",
    );

  it("sans deps.options, aucune barre de filtres", () => {
    mount();
    expect(host.querySelector(".docseeker-toolbar")).toBeNull();
  });

  it("la barre est entre le champ et la ligne d'indexation, dans div.docseeker-toolbar", () => {
    mountSearchView(host, {
      controller: { submit: submit as (q: string) => void, getViewModel: () => vm },
      subscribe: () => () => undefined,
      thumbnails: { attach: attach as ThumbnailAttacher["attach"] },
      onOpen: onOpen as (d: string, p: number, q: string) => void,
      getDocMeta: () => undefined,
      options: optionsDeps(),
      openMenu: fakes.openMenu,
      openDialog: fakes.openDialog,
      indexActivity: { getSnapshot: () => ({ phase: "idle" }) as never, subscribe: () => () => undefined },
    });
    const root = host.querySelector(".docseeker-search")!;
    const kids = Array.from(root.children).map((c) => c.className.split(" ")[0]);
    expect(kids.slice(0, 3)).toEqual(["docseeker-search-box", "docseeker-toolbar", "docseeker-index-row"]);
    expect(host.querySelector(".docseeker-toolbar > .block__icons.docseeker-icons")).not.toBeNull();
    expect(host.querySelector("details, select")).toBeNull();
  });

  it("statut des résultats : documents masqués au pluriel et au singulier", () => {
    mount({ options: optionsDeps() });
    update(results([doc("a", [1, 2, 3])], false, 0, "bm25", 5));
    expect(status()).toBe("1 document, 3 pages. 5 documents masqués par les filtres");
    update(results([doc("a", [1])], false, 0, "bm25", 1));
    expect(status()).toBe("1 document, 1 page. 1 document masqué par les filtres");
    update(results([doc("a", [1])], false, 0, "bm25", 0));
    expect(status()).toBe("1 document, 1 page");
  });

  it("zéro résultat à cause des filtres : texte avec le nombre de filtres et bouton visible", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, nameContains: "rap", minPages: 3 } };
    mount({ options: optionsDeps() });
    update(noResult(4));
    expect(status()).toBe("Aucun résultat avec 2 filtres actifs. 4 documents masqués par les filtres.");
    const btn = resetButton()!;
    expect(btn.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>(".docseeker-actions")!.hidden).toBe(false);
  });

  it("portée non résolue : « Chargement du chemin… » à la place de « aucun résultat », sans bouton de réinitialisation", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update({ ...(noResult(4) as Extract<SearchViewModel, { kind: "no-result" }>), scopeUnresolved: true });
    expect(status()).toBe("Chargement du chemin…");
    expect(resetButton()!.hidden).toBe(true);
  });

  it("zéro résultat : singulier pour 1 filtre et 1 document masqué", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update(noResult(1));
    expect(status()).toBe("Aucun résultat avec 1 filtre actif. 1 document masqué par les filtres.");
  });

  it("le bouton du statut réinitialise les filtres", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update(noResult(2));
    resetButton()!.click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(opts.filters).toEqual(NO_FILTERS);
  });

  it("pas de bouton ni de texte de filtres quand rien n'est masqué", () => {
    mount({ options: optionsDeps() });
    update(noResult(0));
    expect(status()).toBe("Aucun résultat");
    expect(resetButton()?.hidden ?? true).toBe(true);
  });

  it("après réinitialisation par le bouton du statut, le focus ne reste pas sur <body>", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update(noResult(2));
    resetButton()!.focus();
    resetButton()!.click();
    update(noResult(0));
    expect(document.activeElement).not.toBe(document.body);
  });

  const actionButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".docseeker-actions button")).filter((b) => !b.hidden);

  it("no-result filtré pendant l'indexation : le suffixe « résultats partiels » est ajouté", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update({ kind: "no-result", query: "x", partial: true, failedCount: 0, hiddenByFilters: 1 });
    expect(status()).toBe(
      "Aucun résultat avec 1 filtre actif. 1 document masqué par les filtres (résultats partiels, index en cours de construction).",
    );
  });

  it("no-result filtré avec index illisibles : deux boutons visibles (paramètres et réinitialisation)", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps(), onOpenSettings: () => undefined });
    update({ kind: "no-result", query: "x", partial: false, failedCount: 2, hiddenByFilters: 1 });
    expect(actionButtons().map((b) => b.textContent)).toEqual(["Ouvrir les paramètres", "Réinitialiser les filtres"]);
    expect(status()).toBe(
      "Aucun résultat avec 1 filtre actif. 1 document masqué par les filtres. 2 index illisibles : réindexez depuis les paramètres (détails dans le journal).",
    );
  });

  it("hiddenByFilters > 0 sans deps.options : texte simple, aucun bouton de réinitialisation", () => {
    mount();
    update(noResult(3));
    expect(status()).toBe("Aucun résultat");
    expect(host.querySelector(".docseeker-reset-filters")).toBeNull();
    update(results([doc("a", [1])], false, 0, "bm25", 3));
    expect(status()).toBe("1 document, 1 page. 3 documents masqués par les filtres");
  });

  it("results + classement affiné + documents masqués : ordre des suffixes", () => {
    mount({ options: optionsDeps() });
    update(results([doc("a", [1, 2, 3])], false, 0, "proximity", 5));
    expect(status()).toBe(
      "1 document, 3 pages. 5 documents masqués par les filtres. Classement affiné par proximité des mots et taille de police",
    );
  });

  it("le bouton de réinitialisation se cache sur les results, loading et error suivants", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    const visible = () => resetButton()?.hidden === false;
    for (const next of [
      results([doc("a", [1])]),
      { kind: "loading", progress: { loaded: 1, total: 2, failed: [] } } as SearchViewModel,
      { kind: "error", message: "boom" } as SearchViewModel,
    ]) {
      update(noResult(2));
      expect(visible()).toBe(true);
      update(next);
      expect(visible()).toBe(false);
      expect(host.querySelector<HTMLElement>(".docseeker-actions")!.hidden).toBe(true);
    }
  });

  it("réinitialisation par le bouton du statut : le focus va au bouton « Filtres » de la barre", () => {
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 3 } };
    mount({ options: optionsDeps() });
    update(noResult(2));
    resetButton()!.focus();
    resetButton()!.click();
    expect(document.activeElement).toBe(host.querySelector('.docseeker-icons button[aria-label^="Filtres"]'));
  });

  it("la barre suit les options modifiées de l'extérieur à chaque rendu (chemin et résumé)", () => {
    mount({ options: optionsDeps() });
    opts = { ...opts, filters: { ...NO_FILTERS, minPages: 2, scopes: [{ kind: "notebook", box: "20240101000000-aaaaaaa", label: "Cahier A" }] } };
    update({ kind: "empty-query" });
    expect(host.querySelector(".search__path")!.textContent).toBe("Cahier A");
    expect(host.querySelector('.docseeker-icons button[aria-label^="Filtres"]')!.getAttribute("aria-label")).toBe("Filtres (2 actifs)");
  });

  it("compteur de la rangée : « N documents » avec des résultats, vide sinon", () => {
    mount({ options: optionsDeps() });
    const counter = () => host.querySelector<HTMLElement>(".docseeker-count")!;
    expect(counter().hidden).toBe(true);
    update(results([doc("a", [1, 2]), doc("b", [3])]));
    expect(counter().textContent).toBe("2 documents");
    expect(counter().hidden).toBe(false);
    update(results([doc("a", [1, 2])]));
    expect(counter().textContent).toBe("1 document");
    update(noResult(0));
    expect(counter().hidden).toBe(true);
    expect(counter().textContent).toBe("");
  });

  it("deps.options sans openMenu ou sans openDialog : erreur explicite au montage", () => {
    expect(() => mount({ options: optionsDeps(), openMenu: undefined as unknown as NonNullable<SearchViewDeps["openMenu"]> })).toThrow(/openMenu/);
    expect(() => mount({ options: optionsDeps(), openDialog: undefined as unknown as NonNullable<SearchViewDeps["openDialog"]> })).toThrow(/openDialog/);
  });

  it("deux vues montées ensemble : tous les ids du document sont uniques", () => {
    const second = document.createElement("div");
    document.body.appendChild(second);
    const many = results([doc("a", [1, 2, 3, 4, 5, 6, 7]), doc("b", [1, 2, 3, 4, 5, 6, 7, 8])]);
    for (const h of [host, second]) {
      mountSearchView(h, {
        controller: { submit: submit as (q: string) => void, getViewModel: () => many },
        subscribe: () => () => undefined,
        thumbnails: { attach: attach as ThumbnailAttacher["attach"] },
        onOpen: onOpen as (d: string, p: number, q: string) => void,
        getDocMeta: () => undefined,
        options: optionsDeps(),
        openMenu: fakes.openMenu,
        openDialog: fakes.openDialog,
      });
    }
    for (const h of [host, second]) h.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label^="Filtres"]')!.click(); // ids du dialogue
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
