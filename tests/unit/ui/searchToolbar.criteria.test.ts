// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SaveCriteriaResult, SavedCriteria } from "../../../src/search/savedCriteria";
import { mountSearchToolbar, type SearchToolbar, type SearchToolbarDeps } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { createNativeFakes, findItem, pick } from "./nativeFakes";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

const crit = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS, nameContains: "x" },
  sort: { key: "name", direction: "asc" },
  groupByDocument: false,
  ...extra,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let host: HTMLElement;
let state: SearchOptions;
let query: string;
let grouped: boolean;
let list: SavedCriteria[];
let fakes: ReturnType<typeof createNativeFakes>;
let toolbar: SearchToolbar;
let onWarn: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn<(c: SavedCriteria) => Promise<SaveCriteriaResult>>>;
let remove: ReturnType<typeof vi.fn<(n: string) => Promise<boolean>>>;
let recall: ReturnType<typeof vi.fn<(c: SavedCriteria) => void>>;
let notify: ReturnType<typeof vi.fn<(text: string) => void>>;
let toolbarListBroken: Error | undefined;

function mount(over: Partial<SearchToolbarDeps> = {}, withCriteria = true): SearchToolbar {
  return mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: (o) => {
      state = o;
    },
    getFolders: () => [],
    onWarn: onWarn as unknown as NonNullable<SearchToolbarDeps["onWarn"]>,
    t,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    getGroupByDocument: () => grouped,
    setGroupByDocument: (g) => {
      grouped = g;
    },
    expansion: { canExpand: () => false, canCollapse: () => false, expandAll: () => undefined, collapseAll: () => undefined },
    ...(withCriteria ? { criteria: { list: () => { if (toolbarListBroken) throw toolbarListBroken; return list; }, save, remove, recall, notify, getQuery: () => query } } : {}),
    ...over,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS } };
  query = "";
  grouped = true;
  list = [];
  toolbarListBroken = undefined;
  fakes = createNativeFakes();
  onWarn = vi.fn();
  save = vi.fn(async (c: SavedCriteria) => {
    const replaced = list.some((e) => e.name.toLowerCase() === c.name.toLowerCase());
    list = replaced ? list.map((e) => (e.name.toLowerCase() === c.name.toLowerCase() ? c : e)) : [...list, c];
    return { replaced };
  });
  remove = vi.fn(async (name: string) => {
    const before = list.length;
    list = list.filter((c) => c.name !== name);
    return list.length !== before;
  });
  recall = vi.fn((c: SavedCriteria) => {
    state = { sort: c.sort, filters: c.filters };
    grouped = c.groupByDocument;
    query = c.query;
  });
  notify = vi.fn();
  toolbar = mount();
});

const row = () => host.querySelector<HTMLElement>("div.block__icons")!;
const critBtn = () => row().querySelector<HTMLButtonElement>('button[aria-label^="Critères"]')!;
const critSvg = () => critBtn().querySelector("svg")!;
const openMenu = () => {
  critBtn().click();
  return fakes.lastMenu();
};
const applyState = (c: SavedCriteria) => {
  state = { sort: c.sort, filters: c.filters };
  grouped = c.groupByDocument;
  query = c.query;
  toolbar.refresh();
};

describe("bouton « Critères enregistrés »", () => {
  it("absent quand l'assemblage ne fournit pas de critères", () => {
    host.innerHTML = "";
    mount({}, false);
    expect(host.querySelector('button[aria-label="Critères enregistrés"]')).toBeNull();
  });

  it("placé juste après « Spécifier le chemin » et avant le premier espace", () => {
    const path = row().querySelector('button[aria-label="Spécifier le chemin"]')!;
    expect(path.nextElementSibling).toBe(critBtn());
    expect(critBtn().nextElementSibling?.className).toContain("fn__space");
  });

  it("vrai <button> natif : classes de la barre, libellé, icône iconBookmark d'un identifiant de sprite sûr, data-menu", () => {
    expect(critBtn().tagName).toBe("BUTTON");
    expect(critBtn().type).toBe("button");
    expect(critBtn().className).toContain("block__icon block__icon--show");
    expect(critBtn().getAttribute("aria-label")).toBe("Critères enregistrés");
    expect(critBtn().getAttribute("data-menu")).toBe("true");
    const href = critSvg().querySelector("use")?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    expect(href).toBe("#iconBookmark");
    expect(href?.slice(1)).toMatch(/^icon[A-Za-z0-9]+$/);
  });

  it("ouvre le menu avec son identifiant dédié, ancré sur le bouton, et arrête la propagation du clic", () => {
    const reachedWindow = vi.fn();
    window.addEventListener("click", reachedWindow);
    const menu = openMenu();
    window.removeEventListener("click", reachedWindow);
    expect(menu.id).toBe("docseeker-criteria");
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("rouvrir le même identifiant referme (bascule) : un id par bouton", () => {
    openMenu();
    openMenu();
    expect(fakes.menus.map((m) => m.id)).toEqual(["docseeker-criteria", "docseeker-criteria"]);
  });
});

describe("menu", () => {
  it("rien à enregistrer (requête vide, aucun filtre) : « Enregistrer… » désactivé avec son explication", () => {
    const menu = openMenu();
    const item = findItem(menu.items, "Enregistrer les critères actuels…");
    expect(item.disabled).toBe(true);
    expect(item.title).toContain("Rien à enregistrer");
  });

  it("requête vide avec un filtre : enregistrable", () => {
    state = { ...state, filters: { ...NO_FILTERS, nameContains: "x" } };
    const item = findItem(openMenu().items, "Enregistrer les critères actuels…");
    expect(item.disabled).not.toBe(true);
  });

  it("liste relue à chaque ouverture ; sans critère : une entrée grisée", () => {
    expect(openMenu().items.at(-1)?.label).toBe("Aucun critère enregistré");
    fakes.lastMenu().close();
    list = [crit("a")];
    expect(findItem(openMenu().items, "a")).toBeDefined();
  });

  it("nom hostile : texte brut dans le libellé (échappé par l'adaptateur), aucun HTML construit par la barre", () => {
    list = [crit("<img src=x onerror=alert(1)>")];
    openMenu();
    expect(host.querySelector("img")).toBeNull();
    expect(fakes.lastMenu().items.some((i) => i.label === "<img src=x onerror=alert(1)>")).toBe(true);
  });
});

describe("rappel et état du bouton", () => {
  it("rappeler un critère appelle recall ; une fois appliqué et inchangé, le bouton est actif avec « Critères : nom »", () => {
    list = [crit("Mon critère")];
    const menu = openMenu();
    pick(menu, "Mon critère");
    expect(recall).toHaveBeenCalledWith(list[0]);
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
    expect(critBtn().getAttribute("aria-label")).toBe("Critères : Mon critère");
  });

  it("le critère rappelé et inchangé est « current » dans le menu rouvert", () => {
    list = [crit("a"), crit("b")];
    pick(openMenu(), "b");
    toolbar.refresh();
    const menu = openMenu();
    expect(findItem(menu.items, "b").current).toBe(true);
    expect(findItem(menu.items, "a").current).not.toBe(true);
  });

  it("avant que le rappel soit appliqué (état différent), le bouton reste neutre", () => {
    recall.mockImplementation(() => undefined); // résolution asynchrone en cours : rien n'est encore appliqué
    list = [crit("a")];
    pick(openMenu(), "a");
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(false);
    applyState(list[0]!);
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
  });

  it.each([
    ["la requête", () => { query = "autre"; }],
    ["un filtre", () => { state = { ...state, filters: { ...state.filters, nameContains: "y" } }; }],
    ["le tri", () => { state = { ...state, sort: { key: "modified", direction: "desc" } }; }],
    ["le regroupement", () => { grouped = true; }],
  ])("dès que %s diffère, le bouton redevient neutre", (_n, change) => {
    list = [crit("a")];
    pick(openMenu(), "a");
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
    change();
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(false);
    expect(critBtn().getAttribute("aria-label")).toBe("Critères enregistrés");
  });

  it("la requête est comparée rognée (espaces autour ignorés)", () => {
    list = [crit("a")];
    pick(openMenu(), "a");
    query = "  chat  ";
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
  });

  it("un recall qui lève est tracé, jamais propagé au clic", () => {
    recall.mockImplementation(() => {
      throw new Error("boum");
    });
    list = [crit("a")];
    expect(() => pick(openMenu(), "a")).not.toThrow();
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/critère/i), expect.any(Error));
  });

  it("critère supprimé par une autre fenêtre entre l'ouverture du menu et le clic : rien d'appliqué, message, aucun rejet", async () => {
    list = [crit("a"), crit("b")];
    const menu = openMenu();
    list = [crit("b")]; // l'autre fenêtre a supprimé « a »
    expect(() => pick(menu, "a")).not.toThrow();
    await flush();
    expect(recall).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Ce critère était déjà supprimé.");
    expect(critSvg().classList.contains("ft__primary")).toBe(false);
  });

  it("critère remplacé par une autre fenêtre avant le clic : c'est la version enregistrée qui est appliquée", () => {
    list = [crit("a", { query: "ancien" })];
    const menu = openMenu();
    list = [crit("a", { query: "nouveau" })];
    pick(menu, "a");
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ query: "nouveau" }));
  });

  it("un recall qui lève : message visible pour l'utilisateur (en plus de la trace), le bouton reste neutre", () => {
    recall.mockImplementation(() => {
      throw new Error("boum");
    });
    list = [crit("a")];
    pick(openMenu(), "a");
    expect(notify).toHaveBeenCalledWith("Impossible d'appliquer ce critère (voir le journal dans les paramètres)");
    expect(critSvg().classList.contains("ft__primary")).toBe(false);
    expect(critBtn().getAttribute("aria-label")).toBe("Critères enregistrés");
  });
});

describe("suppression", () => {
  it("clic dans « Supprimer un critère » : suppression directe puis message « Critère supprimé : nom »", async () => {
    list = [crit("a"), crit("b")];
    pick(openMenu(), "Supprimer un critère", "a");
    await flush();
    expect(remove).toHaveBeenCalledWith("a");
    expect(notify).toHaveBeenCalledWith("Critère supprimé : a");
    expect(list.map((c) => c.name)).toEqual(["b"]);
  });

  it("supprimer le critère rappelé : le bouton redevient neutre", async () => {
    list = [crit("a")];
    pick(openMenu(), "a");
    toolbar.refresh();
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
    pick(openMenu(), "Supprimer un critère", "a");
    await flush();
    expect(critSvg().classList.contains("ft__primary")).toBe(false);
    expect(critBtn().getAttribute("aria-label")).toBe("Critères enregistrés");
  });

  it("critère déjà supprimé ailleurs : pas de message de succès, mais « déjà supprimé » (jamais le silence)", async () => {
    list = [crit("a")];
    const menu = openMenu();
    list = [];
    pick(menu, "Supprimer un critère", "a");
    await flush();
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Critère supprimé"));
    expect(notify).toHaveBeenCalledWith("Ce critère était déjà supprimé.");
  });

  it("un traitement qui lève après la suppression est tracé : aucun rejet non géré", async () => {
    const boom = new Error("liste KO");
    list = [crit("a")];
    pick(openMenu(), "a"); // critère rappelé : sync() relit alors la liste
    const menu = openMenu();
    toolbarListBroken = boom; // sync() relit la liste à la fin de la suppression : elle lève
    pick(menu, "Supprimer un critère", "a");
    await flush();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it("échec : message d'échec visible ET trace", async () => {
    const boom = new Error("disque");
    remove.mockRejectedValueOnce(boom);
    list = [crit("a")];
    pick(openMenu(), "Supprimer un critère", "a");
    await flush();
    expect(notify).toHaveBeenCalledWith("Impossible de supprimer le critère (voir le journal dans les paramètres)");
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/critère/i), boom);
  });
});

describe("aucun rejet non géré : un message qui lève est tracé", () => {
  it("notify qui lève après une suppression", async () => {
    const boom = new Error("notify KO");
    notify.mockImplementation(() => {
      throw boom;
    });
    list = [crit("a")];
    pick(openMenu(), "Supprimer un critère", "a");
    await flush();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it("notify qui lève après un enregistrement", async () => {
    const boom = new Error("notify KO");
    notify.mockImplementation(() => {
      throw boom;
    });
    query = "chat";
    pick(openMenu(), "Enregistrer les critères actuels…");
    const field = fakes.lastDialog().container.querySelector<HTMLInputElement>("input")!;
    field.value = "a";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    fakes.lastDialog().confirm();
    await flush();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

describe("enregistrement", () => {
  const openSave = () => {
    query = "chat";
    pick(openMenu(), "Enregistrer les critères actuels…");
    return fakes.lastDialog();
  };
  const input = () => fakes.lastDialog().container.querySelector<HTMLInputElement>("input")!;
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("ouvre le dialogue « Enregistrer les critères » avec le nom du critère rappelé pré-rempli", () => {
    list = [crit("Ancien")];
    pick(openMenu(), "Ancien");
    toolbar.refresh();
    pick(openMenu(), "Enregistrer les critères actuels…");
    expect(fakes.lastDialog().options.title).toBe("Enregistrer les critères");
    expect(input().value).toBe("Ancien");
  });

  it("sans critère rappelé : champ vide", () => {
    openSave();
    expect(input().value).toBe("");
  });

  it("enregistre l'état courant (requête rognée, filtres, tri, regroupement), message de succès, bouton actif, focus rendu au bouton", async () => {
    state = { sort: { key: "modified", direction: "desc" }, filters: { ...NO_FILTERS, minPages: 3 } };
    grouped = false;
    query = "  chat ";
    pick(openMenu(), "Enregistrer les critères actuels…");
    type("Nouveau");
    fakes.lastDialog().confirm();
    await flush();
    expect(save).toHaveBeenCalledWith({ name: "Nouveau", query: "chat", filters: state.filters, sort: state.sort, groupByDocument: false });
    expect(notify).toHaveBeenCalledWith("Critères enregistrés : Nouveau");
    expect(critSvg().classList.contains("ft__primary")).toBe(true);
    expect(critBtn().getAttribute("aria-label")).toBe("Critères : Nouveau");
    expect(document.activeElement).toBe(critBtn());
  });

  it("remplacement : message « Critères remplacés : nom »", async () => {
    list = [crit("a", { query: "vieux" })];
    openSave();
    type("a");
    fakes.lastDialog().confirm();
    fakes.lastDialog().confirm();
    await flush();
    expect(notify).toHaveBeenCalledWith("Critères remplacés : a");
  });

  it("échec d'écriture après annulation du dialogue : message dans la zone de messages (jamais seulement la trace)", async () => {
    let fail!: (e: unknown) => void;
    save.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    openSave();
    type("a");
    fakes.lastDialog().confirm();
    fakes.lastDialog().cancel();
    fail(new Error("disque plein"));
    await flush();
    expect(notify).toHaveBeenCalledWith("Impossible d'enregistrer les critères (voir le journal dans les paramètres)");
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/critères/i), expect.any(Error));
  });

  it("échec d'écriture : le dialogue reste ouvert avec l'erreur, la trace est faite, aucun message de succès", async () => {
    const boom = new Error("disque plein");
    save.mockRejectedValueOnce(boom);
    openSave();
    type("a");
    fakes.lastDialog().confirm();
    await flush();
    expect(fakes.lastDialog().handle.isOpen()).toBe(true);
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/critères/i), boom);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("enregistrés"));
  });

  it("annulation : focus rendu au bouton, rien d'écrit", () => {
    openSave();
    document.body.focus();
    fakes.lastDialog().cancel();
    expect(document.activeElement).toBe(critBtn());
    expect(save).not.toHaveBeenCalled();
  });

  it("un seul dialogue à la fois : pas d'enregistrement par-dessus le dialogue des filtres", () => {
    row().querySelector<HTMLButtonElement>('button[aria-label="Filtres"]')!.click();
    query = "chat";
    pick(openMenu(), "Enregistrer les critères actuels…");
    expect(fakes.dialogs).toHaveLength(1);
  });

  it("dispose AVANT la fin du dialogue : dialogue fermé, aucune erreur, aucun focus sur un bouton détaché", async () => {
    let release!: () => void;
    save.mockImplementationOnce(() => new Promise((r) => (release = () => r({ replaced: false }))));
    openSave();
    type("a");
    fakes.lastDialog().confirm();
    const detached = critBtn();
    toolbar.dispose();
    expect(fakes.lastDialog().handle.isOpen()).toBe(false);
    release();
    await flush();
    expect(detached.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(detached);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("dispose ferme aussi le menu ouvert", () => {
    const menu = openMenu();
    toolbar.dispose();
    expect(menu.closed).toBe(true);
  });
});
