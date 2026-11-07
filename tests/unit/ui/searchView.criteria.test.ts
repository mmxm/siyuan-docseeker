// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { SavedCriteria } from "../../../src/search/savedCriteria";
import type { CriteriaHost } from "../../../src/ui/criteriaMenu";
import { mountSearchView, type SearchView } from "../../../src/ui/searchView";
import { createNativeFakes, pick } from "./nativeFakes";

const crit: SavedCriteria = {
  name: "Mon critère",
  query: "chat",
  filters: { ...NO_FILTERS, nameContains: "x" },
  sort: { key: "name", direction: "asc" },
  groupByDocument: true,
};

let fakes: ReturnType<typeof createNativeFakes>;
let host: HTMLElement;
let opts: SearchOptions;
let submit: ReturnType<typeof vi.fn<(q: string) => void>>;
let view: SearchView;

function mount(withCriteria = true, withOptions = true): void {
  const criteria: CriteriaHost = {
    list: () => [crit],
    save: async () => ({ replaced: false }),
    remove: async () => true,
    recall: (c) => {
      opts = { sort: c.sort, filters: c.filters };
      view.refreshOptions();
      view.restoreQuery(c.query);
    },
    notify: () => undefined,
  };
  view = mountSearchView(host, {
    controller: { submit, getViewModel: () => ({ kind: "empty-query" }) as never },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => () => undefined } as never,
    onOpen: () => undefined,
    getDocMeta: () => undefined,
    ...(withOptions ? { options: { getOptions: () => opts, setOptions: (o: SearchOptions) => (opts = o), getFolders: () => [] } } : {}),
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...(withCriteria ? { criteria } : {}),
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  fakes = createNativeFakes();
  opts = { sort: { key: "relevance", direction: "desc" }, filters: { ...NO_FILTERS } };
  submit = vi.fn();
});

const critBtn = () => host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label^="Critères"]');
const field = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;

describe("searchView : critères enregistrés", () => {
  it("le bouton est dans la barre quand les critères ET les options sont fournis", () => {
    mount();
    expect(critBtn()).not.toBeNull();
  });
  it("pas de bouton sans critères, ni sans barre de filtres", () => {
    mount(false);
    expect(critBtn()).toBeNull();
    host.innerHTML = "";
    mount(true, false);
    expect(critBtn()).toBeNull();
  });

  it("Enregistrer lit la requête dans le champ de recherche", () => {
    mount();
    field().value = "  loup ";
    critBtn()!.click();
    pick(fakes.lastMenu(), "Enregistrer les critères actuels…");
    expect(fakes.lastDialog().container.querySelector(".docseeker-criteria-summary")?.textContent).toContain("Requête : loup");
  });

  it("rappel : requête restaurée dans le champ et relancée, bouton actif", () => {
    mount();
    critBtn()!.click();
    pick(fakes.lastMenu(), "Mon critère");
    expect(field().value).toBe("chat");
    expect(submit).toHaveBeenCalledWith("chat");
    expect(critBtn()!.querySelector("svg")!.classList.contains("ft__primary")).toBe(true);
  });

  it("taper dans le champ après un rappel rend aussitôt le bouton neutre", () => {
    mount();
    critBtn()!.click();
    pick(fakes.lastMenu(), "Mon critère");
    field().value = "chat et chien";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    expect(critBtn()!.querySelector("svg")!.classList.contains("ft__primary")).toBe(false);
    expect(critBtn()!.getAttribute("aria-label")).toBe("Critères enregistrés");
  });

  it("dispose retire le bouton et ferme le menu", () => {
    mount();
    critBtn()!.click();
    view.dispose();
    expect(fakes.lastMenu().closed).toBe(true);
    expect(critBtn()).toBeNull();
  });
});
