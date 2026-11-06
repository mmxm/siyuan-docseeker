// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { MIN_PAGE_BOUND } from "../../../src/search/resultOptions";
import { formatLocalDate, mountSearchToolbar, parseLocalDate, type SearchToolbar } from "../../../src/ui/searchToolbar";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

// Dates de test : « YYYY-MM-DD » <-> UTC, indépendant du fuseau.
const parseDate = (v: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? undefined : ms;
};
const formatDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let folders: string[];
let toolbar: SearchToolbar;

function mount(): SearchToolbar {
  return mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    getFolders: () => folders,
    t,
    parseDate,
    formatDate,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  folders = ["assets/", "assets/a/", "assets/a/sub/", "assets/b/"];
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  toolbar = mount();
  details().open = true;
  toolbar.refresh();
});

const details = () => host.querySelector<HTMLDetailsElement>("details.docseeker-filters")!;
const summary = () => details().querySelector("summary")!.textContent;
function control<T extends HTMLElement>(label: string): T {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent === label);
  if (!l) throw new Error(`label introuvable : ${label}`);
  const el = document.getElementById(l.htmlFor);
  if (!el) throw new Error(`contrôle non lié au libellé : ${label}`);
  return el as T;
}
const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
function commit(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value;
  fire(el, "change");
}
const lastFilters = () => (setOptions.mock.calls.at(-1)![0] as SearchOptions).filters;
const resetBtn = () =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Réinitialiser les filtres")!;

describe("structure", () => {
  it("un details natif avec résumé « Filtres » et six contrôles dont le libellé est lié par for", () => {
    expect(details().tagName).toBe("DETAILS");
    expect(summary()).toBe("Filtres");
    expect(control<HTMLSelectElement>("Dossier").tagName).toBe("SELECT");
    expect(control<HTMLInputElement>("Inclure les sous-dossiers").type).toBe("checkbox");
    expect(control<HTMLInputElement>("Nom du document contient").type).toBe("search");
    const min = control<HTMLInputElement>("Pages au moins");
    const max = control<HTMLInputElement>("Pages au plus");
    expect([min.type, min.min, max.type, max.min]).toEqual(["number", "1", "number", "1"]);
    expect(control<HTMLInputElement>("Modifié après").type).toBe("date");
    expect(resetBtn().tagName).toBe("BUTTON");
    expect(resetBtn().type).toBe("button");
  });

  it("n'écrit jamais innerHTML (montage, saisies, réinitialisation, rafraîchissement)", () => {
    const setter = vi.spyOn(Element.prototype, "innerHTML", "set");
    const other = document.createElement("div");
    document.body.appendChild(other);
    const bar = mountSearchToolbar(other, { getOptions: () => state, setOptions: () => undefined, getFolders: () => folders, t });
    commit(control<HTMLInputElement>("Nom du document contient"), "<b>x</b>");
    bar.refresh();
    bar.reset();
    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
  });

  it("n'a ni région live ni texte masqué", () => {
    expect(details().querySelector("[aria-live],[role=status],[role=alert]")).toBeNull();
    expect(details().querySelector(".sr-only")).toBeNull();
  });

  it("le select commence par « Tous les dossiers » (valeur vide) puis les dossiers indentés", () => {
    const opts = Array.from(control<HTMLSelectElement>("Dossier").options);
    expect(opts.map((o) => o.value)).toEqual(["", "assets/", "assets/a/", "assets/a/sub/", "assets/b/"]);
    expect(opts[0]!.textContent).toBe("Tous les dossiers");
    expect(opts[1]!.textContent).toBe("assets");
    expect(opts[2]!.textContent).toBe("  a");
    expect(opts[3]!.textContent).toBe("    sub");
    expect(opts[2]!.title).toBe("assets/a/");
  });

  it("tous les ids sont uniques et uniques entre deux barres", () => {
    const other = document.createElement("div");
    document.body.appendChild(other);
    mountSearchToolbar(other, { getOptions: () => state, setOptions: () => undefined, getFolders: () => [], t });
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dispose retire la barre du DOM", () => {
    toolbar.dispose();
    expect(host.querySelector("details")).toBeNull();
  });
});

describe("résumé", () => {
  it("indique 1 actif / N actifs d'après les options courantes", () => {
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/" } };
    toolbar.refresh();
    expect(summary()).toBe("Filtres (1 actif)");
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/", minPages: 3, nameContains: "x" } };
    toolbar.refresh();
    expect(summary()).toBe("Filtres (3 actifs)");
    state = { ...state, filters: NO_FILTERS };
    toolbar.refresh();
    expect(summary()).toBe("Filtres");
  });

  it("se met à jour après une application", () => {
    commit(control<HTMLSelectElement>("Dossier"), "assets/b/");
    expect(summary()).toBe("Filtres (1 actif)");
  });
});

describe("application des filtres", () => {
  it("dossier : change applique le préfixe et garde le tri", () => {
    commit(control<HTMLSelectElement>("Dossier"), "assets/a/");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters().folder).toBe("assets/a/");
    expect((setOptions.mock.calls[0]![0] as SearchOptions).sort).toEqual({ key: "name", direction: "asc" });
  });

  it("le dossier courant reste affiché même absent de la liste", () => {
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/gone/" } };
    toolbar.refresh();
    expect(control<HTMLSelectElement>("Dossier").value).toBe("assets/gone/");
  });

  it("sous-dossiers : désactivé sans dossier, change applique includeSubfolders", () => {
    const box = control<HTMLInputElement>("Inclure les sous-dossiers");
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    commit(control<HTMLSelectElement>("Dossier"), "assets/a/");
    expect(box.disabled).toBe(false);
    box.checked = false;
    fire(box, "change");
    expect(lastFilters()).toMatchObject({ folder: "assets/a/", includeSubfolders: false });
  });

  it("nom : jamais sur input, seulement sur change", () => {
    const name = control<HTMLInputElement>("Nom du document contient");
    name.value = "anesth";
    fire(name, "input");
    expect(setOptions).not.toHaveBeenCalled();
    fire(name, "change");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters().nameContains).toBe("anesth");
  });

  it("pages : jamais sur input, seulement sur change", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    min.value = "5";
    fire(min, "input");
    fire(min, "keyup");
    expect(setOptions).not.toHaveBeenCalled();
    fire(min, "change");
    expect(lastFilters().minPages).toBe(5);
    const max = control<HTMLInputElement>("Pages au plus");
    commit(max, "50");
    expect(lastFilters()).toMatchObject({ minPages: 5, maxPages: 50 });
  });

  it("date : change convertit via parseDate", () => {
    commit(control<HTMLInputElement>("Modifié après"), "2024-03-05");
    expect(lastFilters().modifiedAfterMs).toBe(Date.UTC(2024, 2, 5));
  });

  it("vider un champ retire le critère", () => {
    commit(control<HTMLInputElement>("Pages au moins"), "5");
    commit(control<HTMLInputElement>("Pages au moins"), "");
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("aucune application sur simple focus ou clic dans un champ", () => {
    const name = control<HTMLInputElement>("Nom du document contient");
    name.focus();
    name.click();
    expect(setOptions).not.toHaveBeenCalled();
  });
});

describe("valeurs invalides", () => {
  const err = (label: string) => control<HTMLElement>(label).parentElement!.querySelector(".docseeker-filter-error")!;

  it("min > max : aria-invalid sur les deux, message lié, filtre de pages ignoré", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    const max = control<HTMLInputElement>("Pages au plus");
    commit(min, "9");
    commit(max, "2");
    for (const el of [min, max]) {
      expect(el.getAttribute("aria-invalid")).toBe("true");
      const msg = document.getElementById(el.getAttribute("aria-describedby")!)!;
      expect(msg.textContent).toBe("Erreur : Pages au moins ne peut pas dépasser Pages au plus.");
    }
    expect(lastFilters()).not.toHaveProperty("minPages");
    expect(lastFilters()).not.toHaveProperty("maxPages");
    expect(summary()).toBe("Filtres");
  });

  it("correction : l'erreur disparaît et le filtre s'applique", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    const max = control<HTMLInputElement>("Pages au plus");
    commit(min, "9");
    commit(max, "2");
    commit(max, "20");
    expect(min.hasAttribute("aria-invalid")).toBe(false);
    expect(max.hasAttribute("aria-invalid")).toBe(false);
    expect(max.hasAttribute("aria-describedby")).toBe(false);
    expect(err("Pages au plus").textContent).toBe("");
    expect(lastFilters()).toMatchObject({ minPages: 9, maxPages: 20 });
  });

  it.each(["2.5", "0", "-3"])("nombre %s : entier supérieur ou égal à 1 exigé", (value) => {
    const min = control<HTMLInputElement>("Pages au moins");
    commit(min, value);
    expect(min.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(min.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Erreur : Saisissez un nombre entier supérieur ou égal à 1.",
    );
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("date illisible (parseDate renvoie undefined) : message dédié, filtre ignoré", () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    mountSearchToolbar(host, {
      getOptions: () => state,
      setOptions: setOptions as (o: SearchOptions) => void,
      getFolders: () => folders,
      t,
      parseDate: () => undefined,
      formatDate,
    });
    const date = control<HTMLInputElement>("Modifié après");
    commit(date, "2024-03-05");
    expect(date.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(date.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Erreur : Saisissez une date valide.",
    );
    expect(lastFilters()).not.toHaveProperty("modifiedAfterMs");
  });

  it("un champ invalide n'empêche pas d'appliquer les autres filtres", () => {
    commit(control<HTMLInputElement>("Pages au moins"), "0");
    commit(control<HTMLInputElement>("Nom du document contient"), "abc");
    expect(lastFilters().nameContains).toBe("abc");
    expect(control<HTMLInputElement>("Pages au moins").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Échap", () => {
  const esc = (el: Element) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  it("vide un champ non vide, applique, et consomme la touche", () => {
    const name = control<HTMLInputElement>("Nom du document contient");
    commit(name, "abc");
    setOptions.mockClear();
    const e = esc(name);
    expect(name.value).toBe("");
    expect(e.defaultPrevented).toBe(true);
    expect(lastFilters().nameContains).toBe("");
  });

  it("ne fait rien sur un champ déjà vide (la touche n'est pas consommée)", () => {
    const name = control<HTMLInputElement>("Nom du document contient");
    const e = esc(name);
    expect(e.defaultPrevented).toBe(false);
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("vide aussi les champs nombre et date", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    commit(min, "4");
    esc(min);
    expect(min.value).toBe("");
    const date = control<HTMLInputElement>("Modifié après");
    commit(date, "2024-01-01");
    esc(date);
    expect(date.value).toBe("");
    expect(lastFilters()).not.toHaveProperty("modifiedAfterMs");
  });
});

describe("réinitialisation", () => {
  it("aria-disabled sans filtre actif, et le clic ne fait rien", () => {
    expect(resetBtn().getAttribute("aria-disabled")).toBe("true");
    resetBtn().click();
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("avec des filtres : actif, efface tous les champs, garde le tri, focus sur Dossier", () => {
    commit(control<HTMLSelectElement>("Dossier"), "assets/a/");
    commit(control<HTMLInputElement>("Nom du document contient"), "abc");
    commit(control<HTMLInputElement>("Pages au moins"), "3");
    commit(control<HTMLInputElement>("Modifié après"), "2024-01-01");
    expect(resetBtn().getAttribute("aria-disabled")).toBe("false");
    setOptions.mockClear();
    resetBtn().click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    const next = setOptions.mock.calls[0]![0] as SearchOptions;
    expect(next.filters).toEqual(NO_FILTERS);
    expect(next.sort).toEqual({ key: "name", direction: "asc" });
    expect(control<HTMLSelectElement>("Dossier").value).toBe("");
    expect(control<HTMLInputElement>("Nom du document contient").value).toBe("");
    expect(control<HTMLInputElement>("Pages au moins").value).toBe("");
    expect(control<HTMLInputElement>("Modifié après").value).toBe("");
    expect(document.activeElement).toBe(control<HTMLSelectElement>("Dossier"));
    expect(resetBtn().getAttribute("aria-disabled")).toBe("true");
    expect(summary()).toBe("Filtres");
  });

  it("efface aussi les erreurs de saisie", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    commit(min, "0");
    commit(control<HTMLInputElement>("Nom du document contient"), "x");
    resetBtn().click();
    expect(min.hasAttribute("aria-invalid")).toBe(false);
    expect(min.hasAttribute("aria-describedby")).toBe(false);
  });

  it("reset() programmatique (bouton de la vue) a le même effet", () => {
    commit(control<HTMLInputElement>("Nom du document contient"), "x");
    toolbar.reset();
    expect(state.filters).toEqual(NO_FILTERS);
    expect(control<HTMLInputElement>("Nom du document contient").value).toBe("");
  });
});

describe("synchronisation depuis les options", () => {
  it("à l'ouverture, les champs reflètent les options courantes", () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    state = {
      sort: { key: "relevance", direction: "desc" },
      filters: {
        folder: "assets/a/",
        includeSubfolders: false,
        nameContains: "abc",
        minPages: 2,
        maxPages: 8,
        modifiedAfterMs: Date.UTC(2024, 0, 31),
      },
    };
    mount();
    details().open = true;
    expect(control<HTMLInputElement>("Nom du document contient").value).toBe("abc");
    expect(control<HTMLInputElement>("Pages au moins").value).toBe("2");
    expect(control<HTMLInputElement>("Pages au plus").value).toBe("8");
    expect(control<HTMLInputElement>("Modifié après").value).toBe("2024-01-31");
    expect(control<HTMLInputElement>("Inclure les sous-dossiers").checked).toBe(false);
    expect(summary()).toBe("Filtres (5 actifs)");
  });
});

describe("codec de date local par défaut", () => {
  it("parseLocalDate : minuit local, aller-retour avec formatLocalDate", () => {
    expect(parseLocalDate("2024-03-05")).toBe(new Date(2024, 2, 5).getTime());
    expect(formatLocalDate(new Date(2024, 2, 5).getTime())).toBe("2024-03-05");
    expect(formatLocalDate(new Date(2024, 11, 31, 23, 59).getTime())).toBe("2024-12-31");
  });

  it.each(["", "2024-02-31", "2024-13-01", "05/03/2024", "2024-3-5", "abcd-ef-gh"])("parseLocalDate refuse %j", (v) => {
    expect(parseLocalDate(v)).toBeUndefined();
  });
});

describe("valeurs numériques, cas limites", () => {
  const min = () => control<HTMLInputElement>("Pages au moins");

  it("« 5 » est accepté ; « 1e2 » aussi (c'est l'entier 100 pour Number et pour un champ number)", () => {
    commit(min(), "5");
    expect(lastFilters().minPages).toBe(5);
    commit(min(), "1e2");
    expect(min().hasAttribute("aria-invalid")).toBe(false);
    expect(lastFilters().minPages).toBe(100);
  });

  it("espaces autour : jsdom assainit un champ number invalide en vide (aucune erreur, critère retiré)", () => {
    commit(min(), " 5 ");
    expect(min().value).toBe("");
    expect(min().hasAttribute("aria-invalid")).toBe(false);
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("entier non sûr (9007199254740993) : refusé comme invalide", () => {
    commit(min(), "9007199254740993");
    expect(min().getAttribute("aria-invalid")).toBe("true");
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("saisie illisible (validity.badInput) : aria-invalid et message, filtre ignoré", () => {
    Object.defineProperty(min(), "validity", { value: { badInput: true } });
    commit(min(), "abc");
    expect(min().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(min().getAttribute("aria-describedby")!)!.textContent).toBe(
      "Erreur : Saisissez un nombre entier supérieur ou égal à 1.",
    );
    expect(lastFilters()).not.toHaveProperty("minPages");
  });

  it("date illisible (validity.badInput) : aria-invalid et message de date", () => {
    const date = control<HTMLInputElement>("Modifié après");
    Object.defineProperty(date, "validity", { value: { badInput: true } });
    commit(date, "2024-01-01");
    expect(date.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(date.getAttribute("aria-describedby")!)!.textContent).toBe("Erreur : Saisissez une date valide.");
  });

  it("les bornes min et step du champ viennent de MIN_PAGE_BOUND", () => {
    expect([min().min, min().step]).toEqual([String(MIN_PAGE_BOUND), "1"]);
  });
});

describe("parseLocalDate (vrai calendrier, fuseau fixé)", () => {
  const previousTz = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "Europe/Paris";
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previousTz;
  });

  it("accepte le 29 février d'une année bissextile, à minuit heure de Paris", () => {
    expect(parseLocalDate("2024-02-29")).toBe(Date.UTC(2024, 1, 28, 23, 0, 0)); // UTC+1 en hiver
    expect(parseLocalDate("2024-07-01")).toBe(Date.UTC(2024, 5, 30, 22, 0, 0)); // UTC+2 en été
  });

  it.each(["2023-02-29", "2024-04-31", "0000-01-01", " 2024-01-01", "0050-01-01", "2024-01-01 ", "2024-00-10", "2024-01-00"])(
    "refuse %j",
    (v) => {
      expect(parseLocalDate(v)).toBeUndefined();
    },
  );

  it("sans stub, la barre accepte 2024-02-29 et affiche l'aller-retour", () => {
    const other = document.createElement("div");
    document.body.appendChild(other);
    let current: SearchOptions = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
    mountSearchToolbar(other, {
      getOptions: () => current,
      setOptions: (o) => {
        current = o;
      },
      getFolders: () => [],
      t,
    });
    const date = other.querySelector<HTMLInputElement>("input[type=date]")!;
    date.value = "2024-02-29";
    fire(date, "change");
    expect(current.filters.modifiedAfterMs).toBe(parseLocalDate("2024-02-29"));
    expect(date.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("réinitialisation, erreurs seules", () => {
  it("avec seulement une erreur de saisie : bouton actif, le clic efface l'erreur", () => {
    const min = control<HTMLInputElement>("Pages au moins");
    commit(min, "0");
    expect(state.filters).toEqual(NO_FILTERS);
    expect(resetBtn().getAttribute("aria-disabled")).toBe("false");
    resetBtn().click();
    expect(min.hasAttribute("aria-invalid")).toBe(false);
    expect(min.value).toBe("");
    expect(resetBtn().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Échap, cas supplémentaires", () => {
  const esc = (el: Element) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  it("sur le select Dossier ou la case : ne fait rien et ne consomme pas la touche", () => {
    commit(control<HTMLSelectElement>("Dossier"), "assets/a/");
    setOptions.mockClear();
    for (const el of [control<HTMLSelectElement>("Dossier"), control<HTMLInputElement>("Inclure les sous-dossiers")]) {
      expect(esc(el).defaultPrevented).toBe(false);
    }
    expect(setOptions).not.toHaveBeenCalled();
    expect(control<HTMLSelectElement>("Dossier").value).toBe("assets/a/");
  });

  it("vide aussi « Pages au plus », applique et consomme la touche", () => {
    const max = control<HTMLInputElement>("Pages au plus");
    commit(max, "9");
    setOptions.mockClear();
    const e = esc(max);
    expect(max.value).toBe("");
    expect(e.defaultPrevented).toBe(true);
    expect(lastFilters()).not.toHaveProperty("maxPages");
  });
});

describe("cycle de vie", () => {
  it("après dispose : un change tardif, refresh et reset n'appellent ni setOptions ni getFolders", () => {
    const name = control<HTMLInputElement>("Nom du document contient");
    const getFolders = vi.fn(() => folders);
    const other = document.createElement("div");
    document.body.appendChild(other);
    const bar = mountSearchToolbar(other, { getOptions: () => state, setOptions: setOptions as (o: SearchOptions) => void, getFolders, t });
    const otherName = other.querySelector<HTMLInputElement>("input[type=search]")!;
    getFolders.mockClear();
    bar.dispose();
    setOptions.mockClear();
    otherName.value = "x";
    fire(otherName, "change");
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/" } };
    bar.refresh();
    bar.reset();
    expect(setOptions).not.toHaveBeenCalled();
    expect(getFolders).not.toHaveBeenCalled();
    expect(name.isConnected).toBe(true); // la première barre n'est pas touchée
  });

  it("deux barres sont indépendantes ; un id n'est jamais réutilisé après dispose", () => {
    const hostB = document.createElement("div");
    document.body.appendChild(hostB);
    const setB = vi.fn();
    const bar = mountSearchToolbar(hostB, { getOptions: () => state, setOptions: setB, getFolders: () => folders, t, parseDate, formatDate });
    const nameA = control<HTMLInputElement>("Nom du document contient");
    commit(nameA, "abc");
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setB).not.toHaveBeenCalled();
    const idsBefore = new Set(Array.from(hostB.querySelectorAll("[id]")).map((e) => e.id));
    bar.dispose();
    const hostC = document.createElement("div");
    document.body.appendChild(hostC);
    mountSearchToolbar(hostC, { getOptions: () => state, setOptions: () => undefined, getFolders: () => folders, t });
    for (const e of Array.from(hostC.querySelectorAll("[id]"))) expect(idsBefore.has(e.id)).toBe(false);
  });

  it("choisir un dossier puis rafraîchir ne reconstruit pas les options (même éléments)", () => {
    const before = Array.from(control<HTMLSelectElement>("Dossier").options);
    commit(control<HTMLSelectElement>("Dossier"), "assets/b/");
    toolbar.refresh();
    const after = Array.from(control<HTMLSelectElement>("Dossier").options);
    expect(after).toEqual(before);
    expect(after.every((o, i) => o === before[i])).toBe(true);
    expect(control<HTMLSelectElement>("Dossier").value).toBe("assets/b/");
  });

  it("une option modifiée de l'extérieur vers un dossier connu met la sélection à jour au rafraîchissement", () => {
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/" } };
    toolbar.refresh();
    expect(control<HTMLSelectElement>("Dossier").value).toBe("assets/a/");
  });

  it("la sélection du dossier est conservée quand la liste change", () => {
    commit(control<HTMLSelectElement>("Dossier"), "assets/b/");
    folders = ["assets/", "assets/a/", "assets/b/", "assets/c/"];
    toolbar.refresh();
    const select = control<HTMLSelectElement>("Dossier");
    expect(select.value).toBe("assets/b/");
    expect(Array.from(select.options).map((o) => o.value)).toContain("assets/c/");
  });
});
