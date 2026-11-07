// @vitest-environment jsdom
// Critères enregistrés dans la vue : ligne `search__header` sous le champ, puce courante suivant la saisie, réinitialisation
// (chemin conservé), commandes du menu « Plus ». Dialogues réels (src/siyuan/nativeUi) sur le faux Dialog de SiYuan.
import { Dialog, Menu } from "siyuan";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SORT, NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { upsertCriteria, type SavedCriteria } from "../../../src/search/savedCriteria";
import { openConfirmDialog, openInputDialog } from "../../../src/siyuan/nativeUi";
import type { CriteriaHost } from "../../../src/ui/criteriaBar";
import { DEFAULT_STRINGS, mountSearchView, type SearchView } from "../../../src/ui/searchView";
import { createNativeFakes, pick } from "./nativeFakes";

const SCOPE = { kind: "notebook", box: "20240101120000-abcdefg", label: "Cahier A" } as const;
const crit: SavedCriteria = {
  name: "Mon critère",
  query: "chat",
  filters: { ...NO_FILTERS, nameContains: "x" },
  sort: { key: "name", direction: "asc" },
  groupByDocument: false,
};

let fakes: ReturnType<typeof createNativeFakes>;
let host: HTMLElement;
let opts: SearchOptions;
let list: SavedCriteria[];
let submit: ReturnType<typeof vi.fn<(q: string) => void>>;
let onGroup: ReturnType<typeof vi.fn<(g: boolean) => void>>;
let notify: ReturnType<typeof vi.fn<(text: string) => void>>;
let view: SearchView;

function mount(over: { remove?: (name: string) => Promise<boolean>; toast?: (t: string) => void; withCriteria?: boolean; withOptions?: boolean; withDialogs?: boolean; grouped?: boolean } = {}): void {
  const { toast, remove, withCriteria = true, withOptions = true, withDialogs = true, grouped = true } = over;
  const criteria: CriteriaHost = {
    list: () => list,
    save: async (c, remove) => {
      const out = upsertCriteria(list, c, remove);
      if ("error" in out) return out;
      list = out.list;
      return { replaced: out.replaced };
    },
    remove: remove ?? (async (name) => {
      const before = list.length;
      list = list.filter((c) => c.name !== name);
      return list.length !== before;
    }),
    recall: (c) => {
      opts = { sort: c.sort, filters: c.filters };
      view.refreshOptions();
      view.setGroupByDocument(c.groupByDocument);
      view.restoreQuery(c.query);
    },
    notify,
    ...(toast ? { toast } : {}),
  };
  view = mountSearchView(host, {
    controller: { submit, getViewModel: () => ({ kind: "empty-query" }) as never },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => () => undefined } as never,
    onOpen: () => undefined,
    getDocMeta: () => undefined,
    ...(withOptions ? { options: { getOptions: () => opts, setOptions: (o: SearchOptions) => (opts = o) } } : {}),
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...(withDialogs ? { openInputDialog, openConfirmDialog } : {}),
    ...(withCriteria ? { criteria } : {}),
    initialGroupByDocument: grouped,
    onGroupByDocumentChange: onGroup,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  (Dialog as unknown as { reset(): void }).reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  fakes = createNativeFakes();
  opts = { sort: { ...DEFAULT_SORT }, filters: { ...NO_FILTERS } };
  list = [crit];
  submit = vi.fn();
  onGroup = vi.fn();
  notify = vi.fn();
});

const header = (): HTMLElement | null => host.querySelector<HTMLElement>(".search__header");
const field = (): HTMLInputElement => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const chip = (): HTMLElement => host.querySelector<HTMLElement>('[data-type="set-criteria"]')!;
const isCurrent = (): boolean => chip().classList.contains("b3-chip--current");
const moreBtn = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!;

describe("searchView : ligne des critères", () => {
  it("la ligne est juste sous le champ de recherche, avant la barre d'icônes", () => {
    mount();
    const root = host.querySelector(".docseeker-search")!;
    const kids = [...root.children].map((c) => c.className.split(" ")[0]);
    expect(kids.slice(0, 3)).toEqual(["docseeker-search-box", "search__header", "docseeker-toolbar"]);
  });

  it("aucun bouton signet « Critères enregistrés » dans la barre", () => {
    mount();
    expect(host.querySelector('.docseeker-icons button[aria-label^="Critères"]')).toBeNull();
    expect(host.querySelector('.docseeker-icons use[*|href="#iconBookmark"]')).toBeNull();
  });

  it("criteria.toast est transmis à la ligne : un échec de suppression survenu après la fermeture est notifié globalement", async () => {
    const toast = vi.fn();
    let fail!: (e: Error) => void;
    mount({ toast, remove: () => new Promise<boolean>((_resolve, reject) => (fail = reject)) });
    chip().querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    view.dispose();
    fail(new Error("disque plein"));
    await new Promise((r) => setTimeout(r, 0));
    expect(toast).toHaveBeenCalledWith("Impossible de supprimer le critère (voir le journal dans les paramètres)");
    expect(notify).not.toHaveBeenCalled();
  });

  it("pas de ligne sans critères ni sans barre de filtres ; sans dialogues d'entrée et de confirmation, le montage lève", () => {
    mount({ withCriteria: false });
    expect(header()).toBeNull();
    host.innerHTML = "";
    mount({ withOptions: false });
    expect(header()).toBeNull();
    host.innerHTML = "";
    expect(() => mount({ withDialogs: false })).toThrow(/openInputDialog/);
  });

  it("la puce de la liste est affichée ; le menu « Plus » propose les deux commandes natives", () => {
    mount();
    expect(chip().textContent).toBe("Mon critère");
    moreBtn().click();
    const labels = fakes.lastMenu().items.map((i) => i.label);
    expect(labels.slice(-2)).toEqual(["Enregistrer les critères", "Réinitialiser les critères"]);
  });

  it("clic sur la puce : requête restaurée dans le champ et relancée, options appliquées, puce courante", () => {
    mount();
    chip().click();
    expect(field().value).toBe("chat");
    expect(submit).toHaveBeenCalledWith("chat");
    expect(opts.sort).toEqual({ key: "name", direction: "asc" });
    expect(opts.filters.nameContains).toBe("x");
    expect(isCurrent()).toBe(true);
  });

  it("taper dans le champ après un rappel retire aussitôt la puce courante", () => {
    mount();
    chip().click();
    field().value = "chat et chien";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(isCurrent()).toBe(false);
  });

  it("changer le tri depuis le menu « Plus » retire la puce courante (la ligne suit la barre)", () => {
    mount();
    chip().click();
    moreBtn().click();
    pick(fakes.lastMenu(), DEFAULT_STRINGS["sortMenu"]!, DEFAULT_STRINGS["sortRelevanceDesc"]!);
    expect(isCurrent()).toBe(false);
  });

  it("« Enregistrer… » du menu « Plus » lit la requête du champ et ouvre le dialogue natif", () => {
    mount();
    field().value = "  loup ";
    moreBtn().click();
    pick(fakes.lastMenu(), "Enregistrer les critères");
    expect(document.querySelector('[data-key="dialog-savecriterion"]')).not.toBeNull();
    document.querySelector<HTMLInputElement>("[data-dialog-input]")!.value = "Loup";
    document.querySelector<HTMLButtonElement>("[data-input-confirm]")!.click();
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(list.at(-1)).toMatchObject({ name: "Loup", query: "loup" });
    });
  });

  it("dispose retire la ligne et ferme ses dialogues", () => {
    mount();
    host.querySelector<HTMLButtonElement>('button[data-type="saveCriterion"]')!.click();
    expect(document.querySelector('[data-key="dialog-savecriterion"]')).not.toBeNull();
    view.dispose();
    expect(document.querySelector('[data-key="dialog-savecriterion"]')).toBeNull();
    expect(header()).toBeNull();
  });
});

describe("searchView : réinitialiser les critères de recherche", () => {
  const resetButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[data-type="removeCriterion"]')!;

  it("requête vidée et relancée à vide, tri et regroupement par défaut, filtres par défaut, CHEMIN CONSERVÉ", () => {
    opts = {
      sort: { key: "name", direction: "asc" },
      filters: { includeSubfolders: false, nameContains: "x", minPages: 2, maxPages: 9, modifiedAfterMs: 5, scopes: [SCOPE] },
    };
    mount({ grouped: false });
    field().value = "loup";
    resetButton().click();
    expect(field().value).toBe("");
    expect(submit).toHaveBeenLastCalledWith("");
    expect(opts.sort).toEqual({ key: "relevance", direction: "desc" });
    expect(opts.filters).toEqual({ includeSubfolders: false, nameContains: "", scopes: [SCOPE] });
    expect(onGroup).toHaveBeenCalledWith(true);
    expect(host.querySelector(".docseeker-clear")!.hasAttribute("hidden")).toBe(true);
  });

  it("sans chemin : aucun chemin ajouté, includeSubfolders par défaut", () => {
    opts = { sort: { key: "name", direction: "desc" }, filters: { ...NO_FILTERS, nameContains: "x", includeSubfolders: false } };
    mount();
    resetButton().click();
    expect(opts.filters).toEqual({ includeSubfolders: true, nameContains: "" });
    expect(opts.filters).not.toHaveProperty("scopes");
  });

  it("regroupement déjà par défaut : onGroupByDocumentChange n'est pas rappelé", () => {
    mount();
    resetButton().click();
    expect(onGroup).not.toHaveBeenCalled();
  });

  it("la puce courante est réinitialisée", () => {
    mount();
    chip().click();
    expect(isCurrent()).toBe(true);
    resetButton().click();
    expect(isCurrent()).toBe(false);
  });

  it("supprimer la puce COURANTE réinitialise aussi la recherche (natif) ; le chemin reste", async () => {
    list = [{ ...crit, filters: { ...crit.filters, scopes: [SCOPE] } }];
    mount();
    chip().click();
    expect(isCurrent()).toBe(true);
    chip().querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(list).toEqual([]);
    expect(field().value).toBe("");
    expect(opts.filters.scopes).toEqual([SCOPE]);
  });

  it("commande « Réinitialiser… » du menu « Plus » : même effet", () => {
    mount();
    field().value = "loup";
    moreBtn().click();
    pick(fakes.lastMenu(), "Réinitialiser les critères");
    expect(field().value).toBe("");
    expect(submit).toHaveBeenLastCalledWith("");
  });
});
