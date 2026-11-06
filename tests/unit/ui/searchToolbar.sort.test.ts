// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, sortToValue, type SearchOptions } from "../../../src/search/resultOptions";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { mountSearchToolbar, type SearchToolbar } from "../../../src/ui/searchToolbar";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let toolbar: SearchToolbar;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "relevance", direction: "desc" }, filters: NO_FILTERS };
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  toolbar = mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    getFolders: () => ["assets/"],
    t,
  });
});

const sortLabel = () => Array.from(host.querySelectorAll("label")).find((l) => l.textContent === "Trier par");
const sortSelect = (): HTMLSelectElement => {
  const label = sortLabel();
  if (!label) throw new Error("libellé « Trier par » introuvable");
  return document.getElementById(label.htmlFor) as HTMLSelectElement;
};
const choose = (value: string): void => {
  const select = sortSelect();
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("sélecteur « Trier par »", () => {
  it("un <select> lié à un libellé visible « Trier par »", () => {
    const label = sortLabel()!;
    expect(label).toBeDefined();
    expect(label.hidden).toBe(false);
    expect(label.closest("[hidden]")).toBeNull();
    expect(sortSelect().tagName).toBe("SELECT");
    expect(label.htmlFor).toBe(sortSelect().id);
    expect(sortSelect().id).not.toBe("");
  });

  it("huit options exactes (valeur, libellé), dans l'ordre", () => {
    expect(Array.from(sortSelect().options).map((o) => [o.value, o.textContent])).toEqual([
      ["relevance:desc", "Pertinence"],
      ["relevance:asc", "ASC de pertinence"],
      ["modified:asc", "Modifier le temps croissant"],
      ["modified:desc", "Modifier le temps décroissant"],
      ["name:asc", "Nom croissant"],
      ["name:desc", "Nom décroissant"],
      ["path:asc", "Chemin croissant"],
      ["matches:desc", "Pages correspondantes décroissant"],
    ]);
  });

  it("aucune chaîne du sélecteur ne contient < > &", () => {
    const texts = [sortLabel()!.textContent!, ...Array.from(sortSelect().options).map((o) => o.textContent!)];
    for (const text of texts) expect(text).not.toMatch(/[<>&]/);
  });

  it("la valeur initiale est le tri des options (défaut : pertinence)", () => {
    expect(sortSelect().value).toBe("relevance:desc");
  });

  it("le sélecteur est sur la même ligne que « Filtres » : même parent, placé avant, hors du panneau déplié", () => {
    const details = host.querySelector("details.docseeker-filters")!;
    const field = sortSelect().closest(".docseeker-sort")!;
    expect(field).not.toBeNull();
    expect(field.parentElement).toBe(details.parentElement);
    expect(field.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details.contains(sortSelect())).toBe(false);
  });

  it("change : setOptions({ ...options, sort }) avec les filtres inchangés", () => {
    state = { ...state, filters: { ...NO_FILTERS, nameContains: "abc", minPages: 2 } };
    choose("name:desc");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions).toHaveBeenCalledWith({
      sort: { key: "name", direction: "desc" },
      filters: { ...NO_FILTERS, nameContains: "abc", minPages: 2 },
    });
  });

  it.each(["relevance:asc", "modified:asc", "modified:desc", "name:asc", "path:asc", "matches:desc"])("choisir %s transmet ce tri", (value) => {
    choose(value);
    expect(sortToValue((setOptions.mock.calls[0]![0] as SearchOptions).sort)).toBe(value);
  });

  it("le focus reste sur le sélecteur après un changement", () => {
    sortSelect().focus();
    choose("name:asc");
    expect(document.activeElement).toBe(sortSelect());
  });

  it("une valeur hors liste (aucune option sélectionnée) est ignorée", () => {
    choose("foo:asc");
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("changer le tri n'écoute pas input et ne touche pas aux filtres affichés", () => {
    const select = sortSelect();
    select.value = "name:asc";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("refresh() resynchronise le sélecteur avec les options (modifiées de l'extérieur)", () => {
    state = { ...state, sort: { key: "path", direction: "asc" } };
    toolbar.refresh();
    expect(sortSelect().value).toBe("path:asc");
  });

  it("reset() des filtres conserve le tri", () => {
    state = { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, nameContains: "x" } };
    toolbar.refresh();
    toolbar.reset();
    expect((setOptions.mock.calls.at(-1)![0] as SearchOptions).sort).toEqual({ key: "name", direction: "asc" });
  });

  it("dispose() retire le sélecteur et son écouteur", () => {
    const select = sortSelect();
    toolbar.dispose();
    expect(host.querySelector(".docseeker-sort")).toBeNull();
    select.value = "name:asc";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setOptions).not.toHaveBeenCalled();
  });
});
