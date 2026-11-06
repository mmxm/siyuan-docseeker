/**
 * Barre de filtres de l'onglet de recherche : DOM natif, aucun innerHTML, aucun accès à SiYuan.
 *
 * - Un `<details>` natif contient les filtres : dossier, sous-dossiers, nom, pages min/max, date.
 * - Un filtre s'applique sur `change` seulement (jamais sur `input`, pas de recherche à la frappe) ; le contrôleur
 *   relance alors la requête déjà soumise, ou se contente de mémoriser les options s'il n'y en a pas.
 * - Une valeur invalide est signalée sur le champ (aria-invalid, message lié) et son filtre est ignoré.
 */
import {
  MIN_PAGE_BOUND,
  NO_FILTERS,
  SORT_CHOICES,
  countActiveFilters,
  isPageBound,
  isValidPageRange,
  sortFromValue,
  sortToValue,
  type ResultFilters,
  type SearchOptions,
} from "../search/resultOptions";
import { nextUiId } from "./uniqueId";

export interface SearchToolbarDeps {
  getOptions(): SearchOptions;
  setOptions(next: SearchOptions): void;
  getFolders(): readonly string[];
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  /** « AAAA-MM-JJ » -> millisecondes (minuit local) ; undefined si illisible. Injectable pour les tests. */
  parseDate?(value: string): number | undefined;
  /** Millisecondes -> « AAAA-MM-JJ », inverse de `parseDate`. */
  formatDate?(ms: number): string;
}

export interface SearchToolbar {
  /** Met à jour le résumé et, si le panneau est ouvert, la liste des dossiers. */
  refresh(): void;
  /** Efface tous les filtres (comme le bouton) et place le focus sur « Dossier ». */
  reset(): void;
  dispose(): void;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** « AAAA-MM-JJ » -> minuit local ; undefined si le format ou le calendrier est invalide (31 février...). */
export function parseLocalDate(value: string): number | undefined {
  const m = DATE_PATTERN.exec(value);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return date.getTime();
}

/** Jour local -> « AAAA-MM-JJ ». */
export function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

type FieldKey = "min" | "max" | "date";
const INDENT = "  ";

export function mountSearchToolbar(host: HTMLElement, deps: SearchToolbarDeps): SearchToolbar {
  const doc = host.ownerDocument;
  const { t } = deps;
  const parseDate = deps.parseDate ?? parseLocalDate;
  const formatDate = deps.formatDate ?? formatLocalDate;

  const details = doc.createElement("details");
  details.className = "docseeker-filters";
  const summary = doc.createElement("summary");
  summary.className = "docseeker-filters-summary";
  const grid = doc.createElement("div");
  grid.className = "docseeker-filter-grid";
  details.append(summary, grid);

  /** Un champ avec message d'erreur : le contrôle, son message, et leur état. */
  const errorFields = new Map<FieldKey, { readonly control: HTMLElement; readonly message: HTMLElement }>();

  const makeLabel = (text: string, forId: string): HTMLLabelElement => {
    const label = doc.createElement("label");
    label.htmlFor = forId;
    label.textContent = text;
    return label;
  };
  const makeField = (labelKey: string, control: HTMLElement, errorKey?: FieldKey): HTMLElement => {
    const field = doc.createElement("div");
    field.className = "docseeker-filter-field";
    control.id = nextUiId("docseeker-filter");
    field.append(makeLabel(t(labelKey), control.id), control);
    if (errorKey) {
      const err = doc.createElement("p");
      err.className = "docseeker-filter-error";
      err.id = nextUiId("docseeker-filter-error");
      err.hidden = true;
      field.appendChild(err);
      errorFields.set(errorKey, { control, message: err });
    }
    return field;
  };
  const makeInput = (type: string): HTMLInputElement => {
    const input = doc.createElement("input");
    input.type = type;
    input.className = "b3-text-field";
    return input;
  };

  const folderSelect = doc.createElement("select");
  folderSelect.className = "b3-select";
  const subfolders = makeInput("checkbox");
  subfolders.className = "";
  subfolders.checked = true;
  const nameInput = makeInput("search");
  const minInput = makeInput("number");
  const maxInput = makeInput("number");
  for (const input of [minInput, maxInput]) {
    input.min = String(MIN_PAGE_BOUND);
    input.step = "1";
  }
  const dateInput = makeInput("date");
  const resetButton = doc.createElement("button");
  resetButton.type = "button";
  resetButton.className = "b3-button b3-button--outline docseeker-filter-reset";
  resetButton.id = nextUiId("docseeker-filter");
  resetButton.textContent = t("filterReset");

  const subfoldersField = makeField("filterSubfolders", subfolders);
  subfoldersField.classList.add("docseeker-filter-check");
  // Case à cocher : le libellé suit la case, sur la même ligne.
  const subfoldersLabel = subfoldersField.firstElementChild;
  if (subfoldersLabel) subfoldersField.append(subfoldersLabel);
  const actions = doc.createElement("div");
  actions.className = "docseeker-filter-actions";
  actions.appendChild(resetButton);
  grid.append(
    makeField("filterFolder", folderSelect),
    subfoldersField,
    makeField("filterName", nameInput),
    makeField("filterMinPages", minInput, "min"),
    makeField("filterMaxPages", maxInput, "max"),
    makeField("filterModifiedAfter", dateInput, "date"),
    actions,
  );
  // Tri : sur la même ligne que « Filtres » (la barre est un conteneur flex-wrap), avant le panneau.
  const sortField = doc.createElement("div");
  sortField.className = "docseeker-sort";
  const sortSelect = doc.createElement("select");
  sortSelect.className = "b3-select docseeker-sort-select";
  sortSelect.id = nextUiId("docseeker-sort");
  for (const choice of SORT_CHOICES) {
    const option = doc.createElement("option");
    option.value = sortToValue(choice.spec);
    option.textContent = t(choice.labelKey);
    sortSelect.appendChild(option);
  }
  sortField.append(makeLabel(t("sortBy"), sortSelect.id), sortSelect);
  host.append(sortField, details);

  let disposed = false;
  /** Retire tous les écouteurs d'un coup à `dispose`. */
  const listeners = new AbortController();
  const { signal } = listeners;

  // --- Résumé, état du bouton.
  const currentFilters = (): ResultFilters => deps.getOptions().filters;
  const updateChrome = (): void => {
    const n = countActiveFilters(currentFilters());
    summary.textContent = n === 0 ? t("filtersLabel") : n === 1 ? t("filtersActiveOne") : t("filtersActiveMany", { n });
    const resettable = n > 0 || [...errorFields.values()].some((f) => f.control.getAttribute("aria-invalid") === "true");
    resetButton.setAttribute("aria-disabled", resettable ? "false" : "true");
    subfolders.disabled = folderSelect.value === "";
  };

  // --- Dossiers.
  let foldersSignature = "";
  const folderLabel = (folder: string): { text: string; depth: number } => {
    const parts = folder.split("/").filter((p) => p !== "");
    const depth = Math.max(parts.length - 1, 0);
    return { text: INDENT.repeat(depth) + (parts[parts.length - 1] ?? folder), depth };
  };
  const rebuildFolders = (): void => {
    const wanted = currentFilters().folder;
    const folders = deps.getFolders();
    const list = wanted === "" || folders.includes(wanted) ? folders : [...folders, wanted];
    const signature = list.join("\n");
    if (signature === foldersSignature) {
      folderSelect.value = wanted; // même liste : seule la sélection a pu changer (options modifiées de l'extérieur)
      return;
    }
    foldersSignature = signature;
    const all = doc.createElement("option");
    all.value = "";
    all.textContent = t("filterAllFolders");
    const options = list.map((folder) => {
      const option = doc.createElement("option");
      option.value = folder;
      option.textContent = folderLabel(folder).text;
      option.title = folder;
      return option;
    });
    folderSelect.replaceChildren(all, ...options);
    folderSelect.value = wanted;
  };

  // --- Erreurs.
  const showError = (key: FieldKey, message: string | undefined): void => {
    const field = errorFields.get(key);
    if (!field) return; // clé sans champ : impossible par construction (FieldKey est fermé)
    const { control, message: err } = field;
    if (message === undefined) {
      err.textContent = "";
      err.hidden = true;
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
      return;
    }
    err.textContent = `${t("filterError")}${message}`;
    err.hidden = false;
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", err.id);
  };

  type Parsed = { value?: number; error?: string };
  const parseBound = (input: HTMLInputElement): Parsed => {
    const raw = input.value.trim();
    if (input.validity?.badInput === true) return { error: t("filterErrInteger") };
    if (raw === "") return {};
    const n = Number(raw);
    return isPageBound(n) ? { value: n } : { error: t("filterErrInteger") };
  };
  const parseDay = (): Parsed => {
    const raw = dateInput.value;
    if (dateInput.validity?.badInput === true) return { error: t("filterErrDate") };
    if (raw === "") return {};
    const ms = parseDate(raw);
    return ms === undefined ? { error: t("filterErrDate") } : { value: ms };
  };

  /** Lit les champs, signale les erreurs, transmet les filtres valides (les invalides sont ignorés). */
  const apply = (): void => {
    if (disposed) return;
    const min = parseBound(minInput);
    const max = parseBound(maxInput);
    const day = parseDay();
    let minValue = min.value;
    let maxValue = max.value;
    let minError = min.error;
    let maxError = max.error;
    if (!isValidPageRange(minValue, maxValue)) {
      minError = t("filterErrMinMax");
      maxError = t("filterErrMinMax");
      minValue = undefined;
      maxValue = undefined;
    }
    showError("min", minError);
    showError("max", maxError);
    showError("date", day.error);
    const filters: ResultFilters = {
      folder: folderSelect.value,
      includeSubfolders: subfolders.checked,
      nameContains: nameInput.value,
      ...(minValue !== undefined ? { minPages: minValue } : {}),
      ...(maxValue !== undefined ? { maxPages: maxValue } : {}),
      ...(day.value !== undefined ? { modifiedAfterMs: day.value } : {}),
    };
    deps.setOptions({ sort: deps.getOptions().sort, filters });
    updateChrome();
  };

  const syncFromOptions = (): void => {
    syncSort();
    const f = currentFilters();
    rebuildFolders();
    folderSelect.value = f.folder;
    subfolders.checked = f.includeSubfolders;
    nameInput.value = f.nameContains;
    minInput.value = f.minPages === undefined ? "" : String(f.minPages);
    maxInput.value = f.maxPages === undefined ? "" : String(f.maxPages);
    dateInput.value = f.modifiedAfterMs === undefined ? "" : formatDate(f.modifiedAfterMs);
    for (const key of errorFields.keys()) showError(key, undefined);
    updateChrome();
  };

  const syncSort = (): void => {
    const wanted = sortToValue(deps.getOptions().sort);
    // Tri non proposé (options venues d'ailleurs) : aucune option sélectionnée plutôt qu'une fausse.
    sortSelect.value = wanted;
    if (sortSelect.value !== wanted) sortSelect.selectedIndex = -1;
  };

  /** Le tri s'applique sur `change` seulement ; le focus reste sur le sélecteur (rien ne le déplace). */
  const applySort = (): void => {
    if (disposed) return;
    const sort = sortFromValue(sortSelect.value);
    if (!sort) return;
    const options = deps.getOptions();
    deps.setOptions({ sort, filters: options.filters });
  };

  const reset = (): void => {
    if (disposed) return;
    deps.setOptions({ sort: deps.getOptions().sort, filters: { ...NO_FILTERS } });
    syncFromOptions();
    folderSelect.focus();
  };

  // --- Événements : `change` seulement (jamais `input`).
  for (const control of [folderSelect, subfolders, nameInput, minInput, maxInput, dateInput]) {
    control.addEventListener("change", apply, { signal });
  }
  sortSelect.addEventListener("change", applySort, { signal });
  const clearable: readonly HTMLInputElement[] = [nameInput, minInput, maxInput, dateInput];
  details.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const target = clearable.find((c) => c === e.target); // pas de cast : seulement les champs à vider
      if (!target || target.value === "") return;
      e.preventDefault();
      e.stopPropagation();
      target.value = "";
      apply();
    },
    { signal },
  );
  resetButton.addEventListener(
    "click",
    () => {
      if (resetButton.getAttribute("aria-disabled") === "true") return;
      reset();
    },
    { signal },
  );
  details.addEventListener(
    "toggle",
    () => {
      if (!disposed && details.open) rebuildFolders();
    },
    { signal },
  );

  syncFromOptions();

  return {
    refresh() {
      if (disposed) return;
      syncSort();
      if (details.open) rebuildFolders();
      updateChrome();
    },
    reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      sortField.remove();
      details.remove();
    },
  };
}
