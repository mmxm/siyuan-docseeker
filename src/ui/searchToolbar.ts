/**
 * Barre d'icônes de l'onglet de recherche, calquée sur celle de la recherche native de SiYuan : DOM natif (aucun
 * innerHTML), aucun accès direct à SiYuan (menus et dialogues injectés).
 *
 * - Une rangée `div.block__icons` de vrais `<button>` : [compteur] [chemin + croix] [Inclure les documents enfants]
 *   [Spécifier le chemin] [Plus] [Filtres] [Élargir] [Réduire].
 * - Dossier, tri et regroupement s'appliquent dès le choix dans le menu ; les autres filtres (nom, pages, date) ne
 *   s'appliquent qu'à « Confirmer » du dialogue, et seulement s'ils sont tous valides.
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
import { DocTreeTooLargeError, type DocTree } from "../search/docTree";
import { IndexUnavailableError } from "../siyuan/kernelApi";
import { criteriaNameKey, sameCriteria, type CriteriaState, type SavedCriteria } from "../search/savedCriteria";
import { canSaveCriteria, criteriaMenuItems, openCriteriaDialog, type CriteriaHost } from "./criteriaMenu";
import { docMenuItems, sameScopeTarget } from "./docMenu";
import { makeIconButton, svgIcon } from "./icons";
import { INDENT, MAX_MENU_INDENT, MAX_MENU_LABEL, truncate } from "./menuLabels";
import {
  MENU_ID_CRITERIA,
  MENU_ID_MORE,
  MENU_ID_PATH,
  type DialogHandle,
  type MenuHandle,
  type NativeDialogOptions,
  type NativeMenuItem,
  type OpenDialog,
  type OpenMenu,
} from "./nativeUiTypes";
import { nextUiId } from "./uniqueId";

export interface SearchToolbarDeps {
  getOptions(): SearchOptions;
  setOptions(next: SearchOptions): void;
  /** Dossiers proposés (tous, triés) : la barre borne ce qu'elle en montre (voir `MAX_FOLDER_ITEMS`). */
  getFolders(): readonly string[];
  /**
   * Arbre des cahiers et documents SiYuan, lu à chaque ouverture du menu « Spécifier le chemin » (le menu s'ouvre une fois la
   * lecture terminée). Absent : le menu ne propose que les dossiers de fichiers.
   */
  getDocTree?(signal?: AbortSignal): Promise<DocTree>;
  /** Trace des incidents (lecture de l'arbre, ouverture du menu) ; par défaut la console. */
  onWarn?(message: string, error?: unknown): void;
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  openMenu: OpenMenu;
  openDialog: OpenDialog;
  /** Fenêtre flottante seulement : bouton « Ouvrir dans un nouvel onglet » (absent : pas de bouton). */
  openInTab?: () => void;
  getGroupByDocument(): boolean;
  setGroupByDocument(next: boolean): void;
  /**
   * Critères de recherche enregistrés (bouton « Critères enregistrés » après le chemin). Absent : pas de bouton.
   * `getQuery` : texte actuel du champ de recherche.
   */
  criteria?: CriteriaHost & { getQuery(): string };
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
/** Bornes du menu des dossiers (le nombre, la profondeur et la longueur viennent des données, donc de l'extérieur). */
export const MAX_FOLDER_ITEMS = 500;
export const MAX_FOLDER_INDENT = MAX_MENU_INDENT;
export const MAX_FOLDER_LABEL = MAX_MENU_LABEL;

/** Filtres sans portée de documents (la clé disparaît : portée et dossier sont exclusifs). */
function withoutScope(filters: ResultFilters): ResultFilters {
  const { scope: _scope, ...rest } = filters;
  return rest;
}

type TreeState =
  | { readonly kind: "ready"; readonly tree: DocTree }
  | { readonly kind: "unavailable" | "tooLarge" | "failed" };

/** « a/b/c/ » -> « a/b/ » ; chaîne vide s'il n'y a pas de parent. */
function parentFolder(folder: string): string {
  const trimmed = folder.endsWith("/") ? folder.slice(0, -1) : folder;
  const cut = trimmed.lastIndexOf("/");
  return cut >= 0 ? trimmed.slice(0, cut + 1) : "";
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
  const pathLabel = doc.createElement("span");
  pathLabel.className = "search__path ft__on-surface fn__flex-center ft__smaller fn__ellipsis";
  pathLabel.hidden = true;
  const pathText = doc.createElement("span");
  pathText.className = "docseeker-path-text";
  pathLabel.appendChild(pathText);
  const removeBtn = makeButton("iconCloseRound", t("removePath"), "docseeker-rmpath");
  removeBtn.hidden = true;
  const grow = doc.createElement("span");
  grow.className = "fn__flex-1";
  const includeBtn = makeButton("iconInclude", t("includeChildren"));
  const pathBtn = makeButton("iconFolder", t("pathSpecify"));
  const criteria = deps.criteria;
  const critBtn = criteria ? makeButton("iconBookmark", t("criteriaMenu")) : undefined;
  const moreBtn = makeButton("iconMore", t("moreMenu"));
  const filtersBtn = makeButton("iconFilter", t("filtersLabel"));
  const expandBtn = makeButton("iconExpand", t("expandAll"));
  const collapseBtn = makeButton("iconContract", t("collapseAll"));
  row.append(counter, pathLabel, removeBtn, grow, includeBtn, pathBtn, ...(critBtn ? [critBtn] : []), space(), moreBtn, filtersBtn, space(), expandBtn, collapseBtn);
  const openInTab = deps.openInTab;
  let openInTabBtn: HTMLButtonElement | undefined;
  if (openInTab) {
    openInTabBtn = makeButton("iconLayoutRight", t("openInNewTab"));
    row.append(space(), openInTabBtn);
  }
  host.appendChild(row);

  const options = (): SearchOptions => deps.getOptions();
  const currentFilters = (): ResultFilters => options().filters;

  // --- Critères enregistrés : état courant de la recherche et critère « rappelé » (nom).
  /** Nom du dernier critère rappelé ou enregistré ; le bouton n'est actif que tant que l'état courant lui est identique. */
  let recalledName: string | undefined;
  const criteriaState = (): CriteriaState => ({
    query: criteria?.getQuery().trim() ?? "",
    filters: currentFilters(),
    sort: options().sort,
    groupByDocument: deps.getGroupByDocument(),
  });
  const findCriteria = (name: string | undefined): SavedCriteria | undefined => {
    if (name === undefined || !criteria) return undefined;
    const wanted = criteriaNameKey(name);
    return criteria.list().find((c) => criteriaNameKey(c.name) === wanted);
  };
  /** Le critère rappelé, s'il existe encore et que requête, filtres, tri et regroupement n'ont pas changé. */
  function appliedCriteria(): SavedCriteria | undefined {
    const found = findCriteria(recalledName);
    return found && sameCriteria(found, criteriaState()) ? found : undefined;
  }

  // --- Synchronisation depuis les options.
  const sync = (): void => {
    const f = currentFilters();
    const { scope } = f;
    const hasPath = f.folder !== "" || scope !== undefined;
    const text = scope ? scope.label : f.folder;
    pathLabel.hidden = !hasPath;
    removeBtn.hidden = !hasPath;
    if (pathText.textContent !== text) pathText.textContent = text;
    // Document : les PDF que nul document ne cite sont exclus (à savoir) ; sinon l'infobulle redonne le chemin complet.
    pathLabel.title = scope?.kind === "document" ? t("docFilterNoPdf") : text;
    const includeActive = hasPath && f.includeSubfolders;
    includeBtn.setAttribute("aria-disabled", String(!hasPath));
    includeBtn.setAttribute("aria-pressed", String(includeActive));
    svgOf(includeBtn)?.classList.toggle("ft__primary", includeActive);
    const n = countActiveFilters(f);
    filtersBtn.setAttribute("aria-label", n === 0 ? t("filtersLabel") : n === 1 ? t("filtersActiveOne") : t("filtersActiveMany", { n }));
    svgOf(filtersBtn)?.classList.toggle("ft__primary", n > 0);
    if (critBtn) {
      const applied = appliedCriteria();
      svgOf(critBtn)?.classList.toggle("ft__primary", applied !== undefined);
      critBtn.setAttribute("aria-label", applied ? t("criteriaApplied", { name: applied.name }) : t("criteriaMenu"));
    }
    const grouped = deps.getGroupByDocument();
    expandBtn.hidden = !grouped;
    collapseBtn.hidden = !grouped;
    expandBtn.setAttribute("aria-disabled", String(!deps.expansion.canExpand()));
    collapseBtn.setAttribute("aria-disabled", String(!deps.expansion.canCollapse()));
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
  /** Lecture en cours de l'arbre des documents (le menu du chemin s'ouvre à sa fin) ; annulée par tout autre menu et au dispose. */
  let treeLoad: AbortController | undefined;
  const pathLabelText = pathBtn.getAttribute("aria-label") ?? "";
  const endTreeLoad = (): void => {
    treeLoad = undefined;
    pathBtn.removeAttribute("aria-busy");
    pathBtn.setAttribute("aria-label", pathLabelText);
  };
  const cancelTreeLoad = (): void => {
    if (!treeLoad) return;
    treeLoad.abort();
    endTreeLoad();
  };
  const showMenu = (button: HTMLElement, id: string, items: readonly NativeMenuItem[], onClose?: () => void): void => {
    cancelTreeLoad(); // le menu d'un autre bouton remplace celui du chemin : son ouverture tardive n'a plus lieu d'être
    // Un identifiant par bouton : bascule sur le même bouton, remplacement du menu d'un autre.
    menuHandle = deps.openMenu(items, anchorOf(button), onClose, id);
  };
  const warn = (message: string, error?: unknown): void => {
    if (deps.onWarn) deps.onWarn(message, error);
    else console.warn(`[docseeker] ${message}`, error);
  };

  /** Dossiers de fichiers : entrées (sans en-tête) selon le dossier courant, bornées (nombre, profondeur, longueur). */
  const folderItems = (wanted: string): NativeMenuItem[] => {
    const all = deps.getFolders();
    const shown = all.slice(0, MAX_FOLDER_ITEMS);
    const displayed = new Set(shown);
    let hidden = all.length - shown.length;
    if (wanted !== "" && !displayed.has(wanted)) {
      // Le dossier courant reste listé (et courant) même hors liste ou au-delà du plafond.
      if (hidden > 0 && new Set(all).has(wanted)) hidden -= 1;
      shown.push(wanted);
      displayed.add(wanted);
    }
    const choose = (folder: string) => (): void => {
      if (disposed || folder === currentFilters().folder) return;
      applyFilters({ ...withoutScope(currentFilters()), folder });
    };
    const folderLabel = (folder: string): string => {
      const parts = folder.split("/").filter((p) => p !== "");
      const depth = Math.max(parts.length - 1, 0);
      // Parent absent de la liste (ou indentation plafonnée) : le segment parent est affiché, pour ne pas confondre a/x et b/x.
      const withParent = depth > 0 && (depth > MAX_FOLDER_INDENT || !displayed.has(parentFolder(folder)));
      const name = withParent ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? folder);
      return INDENT.repeat(Math.min(depth, MAX_FOLDER_INDENT)) + truncate(name, MAX_FOLDER_LABEL);
    };
    const items: NativeMenuItem[] = shown.map((folder) => ({ label: folderLabel(folder), current: folder === wanted, click: choose(folder) }));
    if (hidden > 0) items.push({ label: t(hidden === 1 ? "foldersMoreOne" : "foldersMoreMany", { n: hidden }), disabled: true });
    return items;
  };

  let pathMenu: MenuHandle | undefined;
  /** Ouvre le menu du chemin ; `tree` : état de la lecture des documents (absent : pas de section « Documents SiYuan »). */
  const showPathMenu = (tree: TreeState | undefined): void => {
    const filters = currentFilters();
    const { scope } = filters;
    const wanted = scope === undefined ? filters.folder : "";
    const separator: NativeMenuItem = { separator: true };
    const header = (key: string): NativeMenuItem => ({ label: t(key), disabled: true });
    const items: NativeMenuItem[] = [
      {
        label: t("filterAllFolders"),
        current: wanted === "" && scope === undefined,
        click: () => {
          const now = currentFilters();
          if (disposed || (now.folder === "" && now.scope === undefined)) return;
          applyFilters({ ...withoutScope(now), folder: "" });
        },
      },
    ];
    const folders = folderItems(wanted);
    if (folders.length > 0) items.push(...(tree ? [separator, header("pathSectionFolders")] : []), ...folders);
    let retry = false;
    if (tree) {
      items.push(separator, header("pathSectionDocs"));
      if (tree.kind === "ready" && tree.tree.length === 0) items.push(header("docsNone"));
      else if (tree.kind === "ready") {
        items.push(
          ...docMenuItems({
            tree: tree.tree,
            current: scope,
            t,
            choose: (next) => {
              if (disposed || sameScopeTarget(next, currentFilters().scope)) return;
              applyFilters({ ...currentFilters(), folder: "", scope: next });
            },
          }),
        );
      } else if (tree.kind === "tooLarge") {
        items.push(header("docsTooLarge"));
      } else {
        items.push(header(tree.kind === "unavailable" ? "docsNotReady" : "docsFailed"), {
          label: t("docsRetry"),
          click: () => {
            retry = true;
          },
        });
      }
    }
    // « Réessayer » : SiYuan ferme le menu après le clic ; on le rouvre une fois fermé, le focus d'abord rendu au bouton.
    const onClose =
      tree?.kind === "unavailable" || tree?.kind === "failed"
        ? (): void => {
            if (!retry || disposed) return;
            retry = false;
            pathBtn.focus();
            openPathMenu();
          }
        : undefined;
    showMenu(pathBtn, MENU_ID_PATH, items, onClose);
    pathMenu = menuHandle;
  };
  const openPathMenu = (): void => {
    const getTree = deps.getDocTree;
    if (!getTree) {
      showPathMenu(undefined);
      return;
    }
    // Bascule : le clic sur le bouton referme le menu du chemin ouvert, ou abandonne la lecture en cours.
    if (pathMenu?.isOpen() === true) {
      pathMenu.close();
      return;
    }
    if (treeLoad) {
      cancelTreeLoad();
      return;
    }
    // Un menu ouvert ne se reconstruit pas (la navigation de l'utilisateur y serait perdue) : l'arbre est lu AVANT l'ouverture,
    // et l'attente est visible sur le bouton.
    const mine = new AbortController();
    treeLoad = mine;
    pathBtn.setAttribute("aria-busy", "true");
    pathBtn.setAttribute("aria-label", t("docsLoading"));
    const open = (state: TreeState): void => {
      if (mine.signal.aborted || disposed) return;
      endTreeLoad();
      showPathMenu(state);
    };
    (async () => getTree(mine.signal))()
      .then(
        (tree) => open({ kind: "ready", tree }),
        (error: unknown) => {
          if (mine.signal.aborted || disposed) return;
          if (error instanceof IndexUnavailableError) return open({ kind: "unavailable" });
          if (error instanceof DocTreeTooLargeError) return open({ kind: "tooLarge" });
          warn("Liste des documents SiYuan illisible", error);
          open({ kind: "failed" });
        },
      )
      .catch((error: unknown) => {
        if (treeLoad === mine) endTreeLoad();
        warn("Menu du chemin impossible à ouvrir", error);
      });
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
    ]);
  };

  // --- Dialogue des filtres.
  /** Dialogue ouvert par la barre : « ouvert » se lit sur le handle (destruction différée de SiYuan comprise), pas sur un drapeau. */
  let dialogHandle: DialogHandle | undefined;
  const openFiltersDialog = (): void => {
    if (disposed || dialogHandle?.isOpen() === true) return;
    const initial = currentFilters();
    // Brouillon : dossier et sous-dossiers ne se changent dans ce dialogue que par « Réinitialiser les filtres ». Tant que
    // l'utilisateur n'a pas réinitialisé (`undefined`), Confirmer garde le dossier COURANT, même modifié de l'extérieur
    // pendant que le dialogue était ouvert.
    let draftFolder: string | undefined;
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
        (draftFolder ?? currentFilters().folder) !== "" ||
        (!draftScopeDropped && currentFilters().scope !== undefined);
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
      const scope = draftScopeDropped ? undefined : currentFilters().scope;
      return {
        folder: draftFolder ?? currentFilters().folder,
        includeSubfolders: draftInclude ?? currentFilters().includeSubfolders,
        nameContains: nameInput.value,
        ...(scope !== undefined ? { scope } : {}),
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
        draftFolder = NO_FILTERS.folder;
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

  // --- Critères enregistrés : menu et dialogue.
  /** Message bref de l'assemblage ; un échec est tracé, jamais propagé (ces appels sont faits depuis des promesses). */
  const say = (text: string): void => {
    try {
      criteria?.notify(text);
    } catch (error) {
      warn("Message sur les critères impossible", error);
    }
  };
  const openCriteriaSave = (): void => {
    if (disposed || !criteria || !critBtn || dialogHandle?.isOpen() === true) return;
    const state = criteriaState();
    dialogHandle = openCriteriaDialog({
      doc,
      t,
      openDialog: deps.openDialog,
      state,
      initialName: findCriteria(recalledName)?.name ?? "",
      list: () => criteria.list(),
      save: (c) => criteria.save(c),
      onSaved: ({ name, replaced }) => {
        recalledName = name; // l'état enregistré est l'état courant : le bouton devient actif
        if (!disposed) sync();
        say(t(replaced ? "criteriaReplaced" : "criteriaSaved", { name }));
      },
      onSaveFailed: (error) => {
        warn("Critères non enregistrés", error);
        say(t("criteriaSaveFailed")); // dialogue déjà fermé (annulation pendant l'écriture) : sans cela l'échec serait invisible
      },
      onWarn: warn,
      // Après Enregistrer comme après toute annulation, une fois le dialogue vraiment détruit.
      onDestroyed: () => {
        if (!disposed && critBtn.isConnected) critBtn.focus();
      },
    });
  };
  const recallCriteria = (chosen: SavedCriteria): void => {
    if (disposed || !criteria) return;
    // Le menu a pu être ouvert avant qu'une autre fenêtre supprime ou remplace ce critère : on applique la version enregistrée.
    const current = findCriteria(chosen.name);
    if (!current) {
      say(t("criteriaAlreadyDeleted"));
      sync();
      return;
    }
    try {
      criteria.recall(current);
      recalledName = current.name; // seulement si le rappel a abouti : sinon le bouton afficherait un critère non appliqué
    } catch (error) {
      warn("Rappel du critère en échec", error);
      say(t("criteriaRecallFailed"));
    }
    sync();
  };
  const deleteCriteria = (chosen: SavedCriteria): void => {
    if (!criteria) return;
    criteria.remove(chosen.name).then(
      (existed) => {
        if (!disposed) sync();
        // Déjà supprimé par une autre fenêtre : le dire, pas de silence.
        say(existed ? t("criteriaDeleted", { name: chosen.name }) : t("criteriaAlreadyDeleted"));
      },
      (error: unknown) => {
        warn("Critère non supprimé", error);
        say(t("criteriaDeleteFailed"));
        if (!disposed) sync();
      },
    ).catch((error: unknown) => warn("Suite de la suppression du critère en échec", error)); // jamais de rejet non géré
  };
  const openCriteriaMenu = (): void => {
    if (!criteria || !critBtn) return;
    sync(); // l'état du bouton suit la liste relue (autre fenêtre, suppression)
    showMenu(
      critBtn,
      MENU_ID_CRITERIA,
      criteriaMenuItems({
        list: criteria.list(),
        t,
        appliedName: appliedCriteria()?.name,
        canSave: canSaveCriteria(criteriaState()),
        onSave: openCriteriaSave,
        onRecall: recallCriteria,
        onDelete: deleteCriteria,
      }),
    );
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
  on(pathBtn, openPathMenu, true);
  on(moreBtn, openMoreMenu, true);
  if (critBtn) on(critBtn, openCriteriaMenu, true);
  on(filtersBtn, openFiltersDialog);
  on(removeBtn, () => {
    applyFilters({ ...withoutScope(currentFilters()), folder: "" });
    pathBtn.focus(); // la croix vient de disparaître
  });
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
      treeLoad?.abort();
      menuHandle?.close();
      dialogHandle?.close();
    },
  };
}
