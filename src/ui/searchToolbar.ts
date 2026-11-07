/**
 * Barre d'icônes de l'onglet de recherche, calquée sur celle de la recherche native de SiYuan : DOM natif (aucun
 * innerHTML), aucun accès direct à SiYuan (menus et dialogues injectés).
 *
 * - Une rangée `div.block__icons` de vrais `<button>` : [compteur] [chemin + croix] [Inclure les documents enfants]
 *   [Spécifier le chemin] [Plus] [Filtres] [Élargir] [Réduire].
 * - « Spécifier le chemin » ouvre le dialogue natif (arbre des cahiers et documents, voir `pathDialog.ts`) ; le chemin choisi
 *   s'applique à « Confirmer » de ce dialogue. Tri et regroupement s'appliquent dès le choix dans le menu ; les autres filtres
 *   (nom, pages, date) ne s'appliquent qu'à « Confirmer » du dialogue « Filtres », et seulement s'ils sont tous valides.
 */
import {
  MIN_PAGE_BOUND,
  NO_FILTERS,
  SORT_CHOICES,
  countActiveFilters,
  isPageBound,
  isValidPageRange,
  sortToValue,
  type ResultFilters,
  type SearchOptions,
  type SortSpec,
} from "../search/resultOptions";
import type { DocumentScope } from "../search/docScope";
import { makeIconButton, svgIcon } from "./icons";
import {
  MENU_ID_MORE,
  type CustomDialogHandle,
  type DialogHandle,
  type MenuHandle,
  type NativeDialogOptions,
  type NativeMenuItem,
  type OpenCustomDialog,
  type OpenDialog,
  type OpenMenu,
} from "./nativeUiTypes";
import { openPathDialog, type PathKernel } from "./pathDialog";
import { escapeForTooltip } from "./tooltip";
import { nextUiId } from "./uniqueId";

export interface SearchToolbarDeps {
  getOptions(): SearchOptions;
  setOptions(next: SearchOptions): void;
  /**
   * Noyau SiYuan pour le dialogue « Spécifier le chemin » (cahiers, documents, recherche, chemins lisibles). Absent, comme
   * `openCustomDialog` : ni « Spécifier le chemin » ni « Inclure les documents enfants » (sans chemin possible, ils seraient inertes).
   */
  pathKernel?: PathKernel;
  openCustomDialog?: OpenCustomDialog;
  /** Trace des incidents (lecture des documents, ouverture du dialogue) ; par défaut la console. */
  onWarn?(message: string, error?: unknown): void;
  /** Message bref à l'utilisateur (échec visible : ouverture du dialogue de chemin) ; texte brut. */
  notify?(text: string): void;
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  openMenu: OpenMenu;
  openDialog: OpenDialog;
  /** Fenêtre flottante seulement : bouton « Ouvrir dans un nouvel onglet » (absent : pas de bouton). */
  openInTab?: () => void;
  getGroupByDocument(): boolean;
  setGroupByDocument(next: boolean): void;
  /**
   * Commandes des critères enregistrés du menu « Plus », comme la recherche native (« Enregistrer les critères de requête » et
   * « Réinitialiser les critères de recherche »). Absent : pas de ces commandes (la ligne des critères est montée par la vue).
   */
  criteriaActions?: { save(): void; reset(): void };
  /** Appelé après chaque resynchronisation (options, chemin, tri, regroupement) : la ligne des critères recalcule la puce courante. */
  onStateChange?(): void;
  /** « Élargir » / « Réduire » : état et actions de la liste de résultats. */
  expansion: {
    canExpand(): boolean;
    canCollapse(): boolean;
    expandAll(): void;
    collapseAll(): void;
  };
  /** « AAAA-MM-JJ » -> millisecondes (minuit local) ; undefined si illisible. Injectable pour les tests. */
  parseDate?(value: string): number | undefined;
  /** Millisecondes -> « AAAA-MM-JJ », inverse de `parseDate`. */
  formatDate?(ms: number): string;
}

export interface SearchToolbar {
  /** Resynchronise les boutons (chemin, état actif, Filtres, Élargir/Réduire) avec les options et la vue. */
  refresh(): void;
  /** Efface tous les filtres immédiatement (bouton du statut « aucun résultat ») et place le focus sur « Filtres ». */
  reset(): void;
  /** Texte du compteur en tête de rangée ; vide : masqué. Texte brut. */
  setCounter(text: string): void;
  /** Retire la barre, ferme le menu et le dialogue qu'elle a ouverts (sans rien appliquer) et coupe ses écouteurs. */
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
const DIALOG_WIDTH = "420px";

/** Filtres sans portée de documents (la clé disparaît). */
function withoutScope(filters: ResultFilters): ResultFilters {
  const { scopes: _scopes, ...rest } = filters;
  return rest;
}

export function mountSearchToolbar(host: HTMLElement, deps: SearchToolbarDeps): SearchToolbar {
  const doc = host.ownerDocument;
  const { t } = deps;
  const parseDate = deps.parseDate ?? parseLocalDate;
  const formatDate = deps.formatDate ?? formatLocalDate;
  let disposed = false;
  const listeners = new AbortController();
  const { signal } = listeners;

  // --- Construction de la rangée.
  const row = doc.createElement("div");
  row.className = "block__icons docseeker-icons";

  const makeButton = (icon: string, label: string, extraClass = ""): HTMLButtonElement =>
    makeIconButton(doc, `block__icon block__icon--show${extraClass ? ` ${extraClass}` : ""}`, label, [svgIcon(doc, icon)]);
  const space = (): HTMLSpanElement => {
    const s = doc.createElement("span");
    s.className = "fn__space";
    return s;
  };
  const svgOf = (b: HTMLElement): Element | null => b.querySelector("svg");

  const counter = doc.createElement("span");
  counter.className = "docseeker-count ft__on-surface ft__smaller fn__flex-center";
  counter.hidden = true;
  // Étiquette du chemin, comme la recherche native : texte brut, croix SVG, puis une espace.
  const pathLabel = doc.createElement("span");
  pathLabel.className = "search__path ft__on-surface fn__flex-center ft__smaller fn__ellipsis ariaLabel";
  pathLabel.hidden = true;
  const pathText = doc.createTextNode("");
  // Native : simple SVG cliquable. Ici focalisable au clavier (Entrée, Espace) en plus : sinon le retrait serait réservé à la souris.
  const removeIcon = svgIcon(doc, "iconCloseRound", "search__rmpath");
  removeIcon.setAttribute("tabindex", "0");
  removeIcon.setAttribute("role", "button");
  removeIcon.setAttribute("aria-label", t("removePath"));
  pathLabel.append(pathText, removeIcon);
  const pathSpace = space();
  pathSpace.hidden = true;
  const grow = doc.createElement("span");
  grow.className = "fn__flex-1";
  const includeBtn = makeButton("iconInclude", t("includeChildren"));
  const pathBtn = makeButton("iconFolder", t("pathSpecify"));
  const moreBtn = makeButton("iconMore", t("moreMenu"));
  const filtersBtn = makeButton("iconFilter", t("filtersLabel"));
  const expandBtn = makeButton("iconExpand", t("expandAll"));
  const collapseBtn = makeButton("iconContract", t("collapseAll"));
  // Sans noyau ni dialogue libre aucun chemin ne peut être choisi : les deux boutons seraient inertes, ils sont omis.
  const pathKernel = deps.pathKernel;
  const openCustomDialog = deps.openCustomDialog;
  const canChoosePath = pathKernel !== undefined && openCustomDialog !== undefined;
  row.append(
    counter,
    pathLabel,
    pathSpace,
    grow,
    ...(canChoosePath ? [includeBtn, pathBtn] : []),
    space(),
    moreBtn,
    filtersBtn,
    space(),
    expandBtn,
    collapseBtn,
  );
  const openInTab = deps.openInTab;
  let openInTabBtn: HTMLButtonElement | undefined;
  if (openInTab) {
    openInTabBtn = makeButton("iconLayoutRight", t("openInNewTab"));
    row.append(space(), openInTabBtn);
  }
  host.appendChild(row);

  const options = (): SearchOptions => deps.getOptions();
  const currentFilters = (): ResultFilters => options().filters;

  // --- Synchronisation depuis les options.
  const sync = (): void => {
    const f = currentFilters();
    const { scopes } = f;
    const hasPath = scopes !== undefined;
    // Comme la recherche native : les libellés des portées, joints par un espace (aussi dans l'infobulle native).
    const text = scopes ? scopes.map((s) => s.label).join(" ") : "";
    pathLabel.hidden = !hasPath;
    pathSpace.hidden = !hasPath;
    if (pathText.data !== text) pathText.data = text;
    // Infobulle native de SiYuan : aria-label est inséré comme HTML, les noms de documents sont des données non fiables.
    pathLabel.setAttribute("aria-label", escapeForTooltip(text));
    // Document : les PDF que nul document ne cite sont exclus (à savoir).
    const hasDocument = scopes?.some((s) => s.kind === "document") === true;
    if (hasDocument) pathLabel.title = t("docFilterNoPdf");
    else pathLabel.removeAttribute("title");
    // Comme le natif : « enfants » n'a de sens que pour un document ; un cahier contient toujours tous ses documents (l'indicateur
    // n'est jamais forcé : il est ignoré par la requête quand il n'y a que des cahiers).
    const includeActive = hasDocument && f.includeSubfolders;
    includeBtn.setAttribute("aria-disabled", String(!hasDocument));
    includeBtn.setAttribute("aria-pressed", String(includeActive));
    svgOf(includeBtn)?.classList.toggle("ft__primary", includeActive);
    const n = countActiveFilters(f);
    filtersBtn.setAttribute("aria-label", n === 0 ? t("filtersLabel") : n === 1 ? t("filtersActiveOne") : t("filtersActiveMany", { n }));
    svgOf(filtersBtn)?.classList.toggle("ft__primary", n > 0);
    const grouped = deps.getGroupByDocument();
    expandBtn.hidden = !grouped;
    collapseBtn.hidden = !grouped;
    expandBtn.setAttribute("aria-disabled", String(!deps.expansion.canExpand()));
    collapseBtn.setAttribute("aria-disabled", String(!deps.expansion.canCollapse()));
    deps.onStateChange?.();
  };

  const applyFilters = (filters: ResultFilters): void => {
    if (disposed) return;
    deps.setOptions({ sort: options().sort, filters });
    sync();
  };

  // --- Menus.
  const anchorOf = (el: HTMLElement): { x: number; y: number; w: number; h: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom, w: r.width, h: r.height };
  };
  /** Menu ouvert par la barre (un seul à la fois, comme SiYuan) : fermé au dispose. Le focus est rendu par l'adaptateur. */
  let menuHandle: MenuHandle | undefined;
  const showMenu = (button: HTMLElement, id: string, items: readonly NativeMenuItem[], onClose?: () => void): void => {
    // Un identifiant par bouton : bascule sur le même bouton, remplacement du menu d'un autre.
    menuHandle = deps.openMenu(items, anchorOf(button), onClose, id);
  };
  const warn = (message: string, error?: unknown): void => {
    if (deps.onWarn) deps.onWarn(message, error);
    else console.warn(`[docseeker] ${message}`, error);
  };

  // --- Chemin : dialogue natif « Spécifier le chemin ».
  let pathHandle: CustomDialogHandle | undefined;
  const applyScopes = (scopes: readonly DocumentScope[]): void => {
    if (disposed) return;
    const filters = currentFilters();
    // Comme le natif : l'indicateur « enfants » est conservé tel quel (désactivé pour des cahiers seuls, qui contiennent tout).
    applyFilters({ ...filters, scopes });
  };
  const openPathChooser = (): void => {
    if (disposed || !pathKernel || !openCustomDialog || pathHandle?.isOpen() === true) return;
    try {
      pathHandle = openPathDialog({
        doc,
        t,
        kernel: pathKernel,
        openCustomDialog,
        onWarn: warn,
        onConfirm: applyScopes,
        // Après Confirmer, Annuler ou Échap, quand SiYuan a vraiment détruit le dialogue.
        onDestroyed: () => {
          if (!disposed && pathBtn.isConnected) pathBtn.focus();
        },
      });
    } catch (error) {
      warn("Dialogue « Spécifier le chemin » impossible à ouvrir", error);
      try {
        deps.notify?.(t("pathDialogOpenFailed"));
      } catch (inner) {
        warn("Message sur le dialogue de chemin impossible", inner);
      }
    }
  };
  const openMoreMenu = (): void => {
    const currentSort = sortToValue(options().sort);
    const grouped = deps.getGroupByDocument();
    const chooseSort = (sort: SortSpec) => (): void => {
      if (disposed || sortToValue(sort) === sortToValue(options().sort)) return;
      deps.setOptions({ sort, filters: currentFilters() });
      sync();
    };
    const chooseGroup = (next: boolean) => (): void => {
      if (disposed || next === deps.getGroupByDocument()) return;
      deps.setGroupByDocument(next);
      sync();
    };
    const criteriaActions = deps.criteriaActions;
    showMenu(moreBtn, MENU_ID_MORE, [
      {
        label: t("sortMenu"),
        submenu: SORT_CHOICES.map((c) => ({ label: t(c.labelKey), current: sortToValue(c.spec) === currentSort, click: chooseSort(c.spec) })),
      },
      {
        label: t("groupMenu"),
        submenu: [
          { label: t("groupNone"), current: !grouped, click: chooseGroup(false) },
          { label: t("groupByDocument"), current: grouped, click: chooseGroup(true) },
        ],
      },
      ...(criteriaActions
        ? [
            { separator: true },
            { label: t("criteriaSave"), click: () => !disposed && criteriaActions.save() },
            { label: t("criteriaReset"), click: () => !disposed && criteriaActions.reset() },
          ]
        : []),
    ]);
  };

  // --- Dialogue des filtres.
  /** Dialogue ouvert par la barre : « ouvert » se lit sur le handle (destruction différée de SiYuan comprise), pas sur un drapeau. */
  let dialogHandle: DialogHandle | undefined;
  const openFiltersDialog = (): void => {
    if (disposed || dialogHandle?.isOpen() === true) return;
    const initial = currentFilters();
    // Brouillon : la portée de documents et « sous-documents » ne se changent dans ce dialogue que par « Réinitialiser les
    // filtres ». Tant que l'utilisateur n'a pas réinitialisé (`undefined`), Confirmer garde l'état COURANT, même modifié de
    // l'extérieur pendant que le dialogue était ouvert.
    let draftInclude: boolean | undefined;
    let draftScopeDropped = false; // « Réinitialiser les filtres » retire aussi la portée de documents
    const errorFields = new Map<FieldKey, { readonly control: HTMLElement; readonly message: HTMLElement }>();
    let nameInput: HTMLInputElement;
    let minInput: HTMLInputElement;
    let maxInput: HTMLInputElement;
    let dateInput: HTMLInputElement;
    let resetButton: HTMLButtonElement;

    const makeInput = (type: string): HTMLInputElement => {
      const input = doc.createElement("input");
      input.type = type;
      input.className = "b3-text-field";
      return input;
    };
    const makeField = (labelKey: string, control: HTMLElement, errorKey?: FieldKey): HTMLElement => {
      const field = doc.createElement("div");
      field.className = "docseeker-filter-field";
      control.id = nextUiId("docseeker-filter");
      const label = doc.createElement("label");
      label.htmlFor = control.id;
      label.textContent = t(labelKey);
      field.append(label, control);
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
    const showError = (key: FieldKey, message: string | undefined): void => {
      const field = errorFields.get(key);
      if (!field) return;
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
    const updateReset = (): void => {
      const dirty =
        [nameInput, minInput, maxInput, dateInput].some((i) => i.value !== "") ||
        [...errorFields.values()].some((f) => f.control.getAttribute("aria-invalid") === "true") ||
        (!draftScopeDropped && currentFilters().scopes !== undefined);
      resetButton.setAttribute("aria-disabled", String(!dirty));
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
      if (dateInput.validity?.badInput === true) return { error: t("filterErrDate") };
      if (dateInput.value === "") return {};
      const ms = parseDate(dateInput.value);
      return ms === undefined ? { error: t("filterErrDate") } : { value: ms };
    };

    /** Lit les champs, signale les erreurs ; `undefined` si au moins un champ est invalide (rien n'est alors appliqué). */
    const read = (): ResultFilters | undefined => {
      const min = parseBound(minInput);
      const max = parseBound(maxInput);
      const day = parseDay();
      let minError = min.error;
      let maxError = max.error;
      if (min.error === undefined && max.error === undefined && !isValidPageRange(min.value, max.value)) {
        minError = t("filterErrMinMax");
        maxError = t("filterErrMinMax");
      }
      showError("min", minError);
      showError("max", maxError);
      showError("date", day.error);
      updateReset();
      if (minError !== undefined || maxError !== undefined || day.error !== undefined) {
        const firstInvalid = [minInput, maxInput, dateInput].find((i) => i.getAttribute("aria-invalid") === "true");
        firstInvalid?.focus();
        return undefined;
      }
      const scopes = draftScopeDropped ? undefined : currentFilters().scopes;
      return {
        includeSubfolders: draftInclude ?? currentFilters().includeSubfolders,
        nameContains: nameInput.value,
        ...(scopes !== undefined ? { scopes } : {}),
        ...(min.value !== undefined ? { minPages: min.value } : {}),
        ...(max.value !== undefined ? { maxPages: max.value } : {}),
        ...(day.value !== undefined ? { modifiedAfterMs: day.value } : {}),
      };
    };

    const build = (container: HTMLElement): void => {
      const grid = doc.createElement("div");
      grid.className = "docseeker-filter-grid";
      nameInput = makeInput("search");
      minInput = makeInput("number");
      maxInput = makeInput("number");
      for (const input of [minInput, maxInput]) {
        input.min = String(MIN_PAGE_BOUND);
        input.step = "1";
      }
      dateInput = makeInput("date");
      nameInput.value = initial.nameContains;
      minInput.value = initial.minPages === undefined ? "" : String(initial.minPages);
      maxInput.value = initial.maxPages === undefined ? "" : String(initial.maxPages);
      dateInput.value = initial.modifiedAfterMs === undefined ? "" : formatDate(initial.modifiedAfterMs);
      resetButton = doc.createElement("button");
      resetButton.type = "button";
      resetButton.className = "b3-button b3-button--outline docseeker-filter-reset";
      resetButton.textContent = t("filterReset");
      const actions = doc.createElement("div");
      actions.className = "docseeker-filter-actions";
      actions.appendChild(resetButton);
      grid.append(
        makeField("filterName", nameInput),
        makeField("filterMinPages", minInput, "min"),
        makeField("filterMaxPages", maxInput, "max"),
        makeField("filterModifiedAfter", dateInput, "date"),
        actions,
      );
      container.appendChild(grid);
      for (const input of [nameInput, minInput, maxInput, dateInput]) {
        input.addEventListener("input", updateReset);
        input.addEventListener("change", updateReset);
      }
      resetButton.addEventListener("click", () => {
        if (resetButton.getAttribute("aria-disabled") === "true") return;
        nameInput.value = "";
        minInput.value = "";
        maxInput.value = "";
        dateInput.value = "";
        for (const key of errorFields.keys()) showError(key, undefined);
        draftInclude = NO_FILTERS.includeSubfolders;
        draftScopeDropped = true;
        updateReset();
        nameInput.focus();
      });
      updateReset();
    };

    const dialog: NativeDialogOptions = {
      title: t("filtersLabel"),
      width: DIALOG_WIDTH,
      labels: { cancel: t("dialogCancel"), confirm: t("dialogConfirm") },
      build,
      onConfirm: () => {
        if (disposed) return true;
        const filters = read();
        if (!filters) return false;
        applyFilters(filters);
        return true; // l'adaptateur ferme ; le focus revient dans onDestroyed, une fois le dialogue réellement détruit
      },
      // Après Confirmer comme après toute annulation, quand SiYuan a vraiment détruit le dialogue.
      onDestroyed: () => {
        if (!disposed) filtersBtn.focus();
      },
    };
    dialogHandle = deps.openDialog(dialog);
  };

  // --- Événements.
  const on = (button: HTMLElement, handler: () => void, opensMenu = false): void => {
    if (opensMenu) button.setAttribute("data-menu", "true"); // exclusion native du gestionnaire tactile de SiYuan
    button.addEventListener(
      "click",
      (e) => {
        // SiYuan ferme les menus ouverts sur tout clic qui atteint `window` : sans cela le menu s'ouvre puis se referme
        // dans le même clic (les boutons natifs appellent aussi stopPropagation). Valable pour la souris comme pour
        // Entrée/Espace, qui produisent le même `click`.
        if (opensMenu) e.stopPropagation();
        if (!disposed) handler();
      },
      { signal },
    );
  };
  on(pathBtn, openPathChooser);
  on(moreBtn, openMoreMenu, true);
  on(filtersBtn, openFiltersDialog);
  const removePath = (): void => {
    applyFilters(withoutScope(currentFilters()));
    // La croix vient de disparaître : le focus va au bouton du chemin, à défaut à un autre bouton de la rangée.
    const target = pathBtn.isConnected ? pathBtn : [filtersBtn, moreBtn, expandBtn].find((b) => b.isConnected && !b.hidden);
    target?.focus();
  };
  removeIcon.addEventListener("click", () => !disposed && removePath(), { signal });
  removeIcon.addEventListener(
    "keydown",
    (e) => {
      if (disposed || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      removePath();
    },
    { signal },
  );
  on(includeBtn, () => {
    if (includeBtn.getAttribute("aria-disabled") === "true") return;
    applyFilters({ ...currentFilters(), includeSubfolders: !currentFilters().includeSubfolders });
  });
  if (openInTabBtn && openInTab) on(openInTabBtn, openInTab);
  on(expandBtn, () => {
    if (expandBtn.getAttribute("aria-disabled") === "true") return;
    deps.expansion.expandAll();
    sync();
  });
  on(collapseBtn, () => {
    if (collapseBtn.getAttribute("aria-disabled") === "true") return;
    deps.expansion.collapseAll();
    sync();
  });

  sync();

  return {
    refresh() {
      if (!disposed) sync();
    },
    reset() {
      if (disposed) return;
      deps.setOptions({ sort: options().sort, filters: { ...NO_FILTERS } });
      sync();
      filtersBtn.focus();
    },
    setCounter(text) {
      if (disposed) return;
      counter.textContent = text;
      counter.hidden = text === "";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      row.remove();
      // Après le retrait de la rangée : l'adaptateur ne rend alors le focus à aucun bouton détaché.
      menuHandle?.close();
      dialogHandle?.close();
      pathHandle?.close();
    },
  };
}
