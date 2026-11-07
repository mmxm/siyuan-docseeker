/**
 * Critères de recherche enregistrés : entrées du menu du bouton « Critères enregistrés » et dialogue « Enregistrer les critères ».
 * Aucun accès direct à SiYuan (menus et dialogues injectés, voir `nativeUiTypes`) et aucun innerHTML : les noms viennent des données
 * (settings.json), ils restent du texte brut que l'adaptateur échappe pour les menus et que le dialogue pose en `textContent`.
 */
import { SORT_CHOICES, countActiveFilters, sortToValue } from "../search/resultOptions";
import {
  MAX_CRITERIA,
  MAX_CRITERIA_NAME,
  MAX_CRITERIA_QUERY,
  cleanCriteriaName,
  criteriaNameKey,
  type CriteriaState,
  type SaveCriteriaResult,
  type SavedCriteria,
} from "../search/savedCriteria";
import { MAX_MENU_LABEL, truncate } from "./menuLabels";
import type { DialogHandle, NativeMenuItem, OpenDialog } from "./nativeUiTypes";
import { nextUiId } from "./uniqueId";

type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

/** Ce que la barre demande à l'assemblage (onglet) : liste, écriture, suppression, rappel et message bref. */
export interface CriteriaHost {
  list(): readonly SavedCriteria[];
  save(criteria: SavedCriteria): Promise<SaveCriteriaResult>;
  /** Vrai si le critère existait. */
  remove(name: string): Promise<boolean>;
  /** Applique filtres, tri et regroupement, restaure la requête et relance la recherche. */
  recall(criteria: SavedCriteria): void;
  /** Message bref dans la zone de messages (succès ou échec) ; texte brut. */
  notify(text: string): void;
}

/** Il faut une requête ou au moins un filtre pour qu'il y ait quelque chose à enregistrer. */
export function canSaveCriteria(state: CriteriaState): boolean {
  return state.query.trim() !== "" || countActiveFilters(state.filters) > 0;
}

const SUMMARY_QUERY_MAX = 60;
const SEPARATOR = " · ";

/** Résumé d'une ligne : « Requête : … · Filtres (2 actifs) · Tri : … · Regrouper par document ». */
export function criteriaSummary(state: CriteriaState, t: T): string {
  const parts: string[] = [];
  const query = state.query.trim();
  if (query !== "") parts.push(t("criteriaSummary", { query: truncate(query, SUMMARY_QUERY_MAX) }));
  const filters = countActiveFilters(state.filters);
  if (filters > 0) parts.push(filters === 1 ? t("filtersActiveOne") : t("filtersActiveMany", { n: filters }));
  const value = sortToValue(state.sort);
  const choice = SORT_CHOICES.find((c) => sortToValue(c.spec) === value);
  parts.push(`${t("sortMenu")} : ${choice ? t(choice.labelKey) : value}`);
  parts.push(t(state.groupByDocument ? "groupByDocument" : "groupNone"));
  return parts.join(SEPARATOR);
}

let collator: Intl.Collator | undefined;
const byName = (a: SavedCriteria, b: SavedCriteria): number => (collator ??= new Intl.Collator("fr", { numeric: true, sensitivity: "base" })).compare(a.name, b.name);

export interface CriteriaMenuArgs {
  readonly list: readonly SavedCriteria[];
  readonly t: T;
  /** Nom du critère rappelé et inchangé, ou undefined. */
  readonly appliedName: string | undefined;
  readonly canSave: boolean;
  onSave(): void;
  onRecall(criteria: SavedCriteria): void;
  onDelete(criteria: SavedCriteria): void;
}

/** Enregistrer, séparateur, critères (tri alphabétique), séparateur, « Supprimer un critère » ; liste vide : une seule entrée grisée. */
export function criteriaMenuItems({ list, t, appliedName, canSave, onSave, onRecall, onDelete }: CriteriaMenuArgs): NativeMenuItem[] {
  const save: NativeMenuItem = canSave
    ? { label: t("criteriaSave"), click: onSave }
    : { label: t("criteriaSave"), disabled: true, title: t("criteriaErrNothing") };
  if (list.length === 0) return [save, { separator: true }, { label: t("criteriaEmpty"), disabled: true }];
  const sorted = [...list].sort(byName);
  const applied = appliedName === undefined ? undefined : criteriaNameKey(appliedName);
  return [
    save,
    { separator: true },
    ...sorted.map((c): NativeMenuItem => {
      const item = { label: truncate(c.name, MAX_MENU_LABEL), click: () => onRecall(c) };
      return applied !== undefined && criteriaNameKey(c.name) === applied ? { ...item, current: true } : item;
    }),
    { separator: true },
    {
      label: t("criteriaDelete"),
      submenu: sorted.map((c): NativeMenuItem => ({ label: truncate(c.name, MAX_MENU_LABEL), click: () => onDelete(c) })),
    },
  ];
}

// --- Dialogue --------------------------------------------------------------------------------------------------

const DIALOG_WIDTH = "420px";

export interface CriteriaDialogArgs {
  readonly doc: Document;
  readonly t: T;
  readonly openDialog: OpenDialog;
  /** Instantané pris à l'ouverture : requête, filtres, tri, regroupement. */
  readonly state: CriteriaState;
  /** Nom pré-rempli (critère rappelé) ; vide sinon. */
  readonly initialName: string;
  list(): readonly SavedCriteria[];
  save(criteria: SavedCriteria): Promise<SaveCriteriaResult>;
  /** L'écriture a abouti (même si le dialogue a été détruit entre-temps). */
  onSaved(info: { readonly name: string; readonly replaced: boolean }): void;
  /** L'écriture a échoué ou été refusée de façon inattendue : à tracer (le message est déjà affiché sous le champ). */
  onSaveFailed(error: unknown): void;
  /** Le dialogue est vraiment détruit (après Enregistrer comme après toute annulation) : rendre le focus. */
  onDestroyed(): void;
  /** Trace d'un rappel de l'appelant qui lève (jamais avalé ni propagé : l'écriture, elle, a déjà abouti ou échoué). */
  onWarn(message: string, error: unknown): void;
}

export function openCriteriaDialog(args: CriteriaDialogArgs): DialogHandle {
  const { doc, t, state } = args;
  let input: HTMLInputElement;
  let message: HTMLElement;
  let handle: DialogHandle | undefined;
  /** Clé du nom pour lequel « Remplacer » a été demandé ; undefined hors de ce mode. */
  let replaceFor: string | undefined;
  let busy = false;
  let finished = false;

  const clearMessage = (): void => {
    message.textContent = "";
    message.hidden = true;
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  };
  const showMessage = (text: string): void => {
    message.textContent = text;
    message.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", message.id);
    input.focus();
  };
  /** Erreur sous le champ au format « Erreur : … » ; renvoie `false` (valeur de retour de `onConfirm`). */
  const showError = (key: string): false => {
    showMessage(`${t("filterError")}${t(key)}`);
    return false;
  };
  const setConfirm = (key: string): void => handle?.setConfirmLabel?.(t(key));
  const leaveReplaceMode = (): void => {
    if (replaceFor === undefined) return;
    replaceFor = undefined;
    setConfirm("criteriaSaveConfirm");
  };

  const build = (container: HTMLElement): void => {
    const field = doc.createElement("div");
    field.className = "docseeker-filter-field";
    input = doc.createElement("input");
    input.type = "text";
    input.className = "b3-text-field";
    input.maxLength = MAX_CRITERIA_NAME;
    input.id = nextUiId("docseeker-criteria");
    input.value = args.initialName;
    const label = doc.createElement("label");
    label.htmlFor = input.id;
    label.textContent = t("criteriaName");
    message = doc.createElement("p");
    message.className = "docseeker-filter-error";
    message.id = nextUiId("docseeker-criteria-error");
    message.hidden = true;
    const summary = doc.createElement("p");
    summary.className = "docseeker-criteria-summary";
    summary.textContent = criteriaSummary(state, t);
    field.append(label, input, message, summary);
    container.appendChild(field);
    // Toute modification du nom efface le message et annule le mode « Remplacer » ; rien n'est validé à la frappe.
    input.addEventListener("input", () => {
      clearMessage();
      leaveReplaceMode();
    });
    input.select();
  };

  const onConfirm = (): boolean => {
    if (busy || finished) return false;
    const name = cleanCriteriaName(input.value);
    if (name === "") return showError("criteriaErrEmpty");
    if (Array.from(name).length > MAX_CRITERIA_NAME) return showError("criteriaErrTooLong");
    if (!canSaveCriteria(state)) return showError("criteriaErrNothing");
    if (Array.from(state.query.trim()).length > MAX_CRITERIA_QUERY) return showError("criteriaErrQuery");
    const key = criteriaNameKey(name);
    const list = args.list();
    const exists = list.some((c) => criteriaNameKey(c.name) === key);
    if (exists && replaceFor !== key) {
      replaceFor = key;
      setConfirm("criteriaReplaceConfirm");
      showMessage(t("criteriaReplaceAsk", { name }));
      return false;
    }
    if (!exists && list.length >= MAX_CRITERIA) return showError("criteriaErrLimit");
    busy = true;
    const criteria: SavedCriteria = { name, query: state.query.trim(), filters: state.filters, sort: state.sort, groupByDocument: state.groupByDocument };
    const stop = (): void => {
      busy = false;
    };
    /** Rappel de l'appelant : s'il lève, on trace et on continue (fermeture, nouvel essai), jamais de rejet non géré. */
    const guard = (what: string, call: () => void): void => {
      try {
        call();
      } catch (error) {
        args.onWarn(what, error);
      }
    };
    const failed = (error: unknown): void => {
      stop();
      if (!finished) showError("criteriaSaveFailed");
      guard("Rappel d'échec d'enregistrement des critères en échec", () => args.onSaveFailed(error));
    };
    void (async () => args.save(criteria))().then(
      (result) => {
        if ("error" in result) {
          if (result.error === "limit") {
            stop();
            if (!finished) showError("criteriaErrLimit");
            return;
          }
          failed(new Error(`Critères refusés : ${result.error}`));
          return;
        }
        stop();
        // L'écriture a eu lieu : un rappel qui lève n'en fait pas un échec et ne doit pas laisser « Remplacer » re-cliquable.
        guard("Rappel de fin d'enregistrement des critères en échec", () => args.onSaved({ name, replaced: result.replaced }));
        if (!finished) guard("Fermeture du dialogue des critères en échec", () => handle?.close());
      },
      failed,
    ).catch((error: unknown) => args.onWarn("Suite de l'enregistrement des critères en échec", error));
    return false; // le dialogue se ferme à la fin de l'écriture, pour pouvoir y montrer un échec
  };

  const opened = args.openDialog({
    title: t("criteriaSaveTitle"),
    width: DIALOG_WIDTH,
    labels: { cancel: t("dialogCancel"), confirm: t("criteriaSaveConfirm") },
    build,
    onConfirm,
    onDestroyed: () => {
      finished = true;
      args.onDestroyed();
    },
  });
  handle = opened;
  return opened;
}
