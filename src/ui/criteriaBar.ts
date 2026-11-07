/**
 * Ligne des critères de requête enregistrés, copie de celle de la recherche native de SiYuan 3.8.9 (`initCriteriaMenu`,
 * `saveCriterion` et les clics `set-criteria` / `remove-criteria` de app/src/search) : des puces (le nom du critère, une croix pour le
 * supprimer) puis « Enregistrer les critères de requête » et « Réinitialiser les critères de recherche ».
 *
 * Aucun accès direct à SiYuan (dialogues et réglages injectés) et aucun innerHTML : les noms viennent des données, ils sont posés en
 * `textContent` dans la ligne comme dans les dialogues de confirmation.
 *
 * Écarts assumés avec le natif, qui n'enregistre pas dans le même modèle : la puce est « courante » par calcul (requête, filtres
 * y compris le chemin, tri, regroupement identiques) et non par une classe posée au clic ; l'écriture est asynchrone (réglages du
 * plugin) : le dialogue d'entrée ne se ferme qu'une fois l'écriture faite, et reste ouvert si elle échoue ; l'unicité des noms ignore
 * la casse et les accents.
 */
import {
  planCriteriaSave,
  sameCriteria,
  type CriteriaSavePlan,
  type CriteriaState,
  type SaveCriteriaResult,
  type SavedCriteria,
  criteriaNameKey,
} from "../search/savedCriteria";
import { el } from "./dom";
import { svgIcon } from "./icons";
import type { ConfirmDialogHandle, InputDialogHandle, OpenConfirmDialog, OpenInputDialog } from "./nativeUiTypes";

type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

/** `data-key` du dialogue d'enregistrement natif (`Constants.DIALOG_SAVECRITERION`). */
const DIALOG_KEY = "dialog-savecriterion";
const CHIP_CLASS = "b3-chip b3-chip--middle b3-chip--pointer";
const CHIP_CURRENT_CLASS = `b3-chip--current ${CHIP_CLASS}`;

/** Ce que l'assemblage (onglet) fournit à la vue : liste, écriture, suppression, rappel et message bref. */
export interface CriteriaHost {
  /** Liste courante (relue à chaque `refresh`). */
  list(): readonly SavedCriteria[];
  /** Enregistre `criteria` et retire `removeNames` (renommage, fusion) ; rejette si l'écriture échoue. */
  save(criteria: SavedCriteria, removeNames: readonly string[]): Promise<SaveCriteriaResult>;
  /** Vrai si le critère existait. Rejette si l'écriture échoue. */
  remove(name: string): Promise<boolean>;
  /** Applique requête, filtres (chemin compris), tri et regroupement, et relance la recherche. */
  recall(criteria: SavedCriteria): void;
  /** Message bref (succès ou échec) ; texte brut. */
  notify(text: string): void;
  /**
   * Notification globale de SiYuan (toast), qui survit à l'onglet : seule voie pour dire un échec d'écriture qui se termine APRÈS la
   * fermeture de l'onglet. Texte brut. Absent : l'échec reste tracé (`onWarn`) mais l'utilisateur n'en est pas averti.
   */
  toast?(text: string): void;
}

/** Ce que la vue fournit à la ligne : l'hôte, plus l'état de recherche, la réinitialisation et les dialogues natifs. */
export interface CriteriaBarDeps extends CriteriaHost {
  readonly t: T;
  /** Requête vidée, tri, regroupement et filtres par défaut, chemin conservé. */
  reset(): void;
  /** Requête, filtres, tri et regroupement actuels. */
  getState(): CriteriaState;
  onWarn(message: string, error?: unknown): void;
  openInputDialog: OpenInputDialog;
  openConfirmDialog: OpenConfirmDialog;
}

export interface CriteriaBar {
  /** La ligne `div.search__header`, à insérer sous le champ de recherche. */
  readonly element: HTMLElement;
  /** Relit la liste et recalcule la puce courante (requête, options ou regroupement modifiés). */
  refresh(): void;
  /** Ouvre le dialogue d'enregistrement (bouton, menu « Plus »). */
  openSave(): void;
  /** Réinitialise la recherche (bouton, menu « Plus »). */
  reset(): void;
  /** Retire la ligne et ferme les dialogues qu'elle a ouverts. */
  dispose(): void;
}

const makeSpan = (doc: Document, className: string): HTMLSpanElement => el(doc, "span", className);

export function createCriteriaBar(doc: Document, deps: CriteriaBarDeps): CriteriaBar {
  const { t } = deps;
  let disposed = false;
  const listeners = new AbortController();
  const { signal } = listeners;

  // --- DOM natif (initCriteriaMenu, version bureau).
  const header = el(doc, "div", "search__header");
  const chipsEl = el(doc, "div", "b3-chips fn__none");
  const saveBtn = el(doc, "button", "b3-button b3-button--small b3-button--outline fn__flex-center", { "data-type": "saveCriterion", type: "button" });
  saveBtn.textContent = t("criteriaSave");
  const resetBtn = el(doc, "button", "ariaLabel b3-button b3-button--small b3-button--outline fn__flex-center fn__flex-shrink", {
    "data-type": "removeCriterion",
    type: "button",
    "aria-label": t("criteriaResetHint"),
    "data-position": "9south",
  });
  resetBtn.textContent = t("criteriaReset");
  header.append(chipsEl, makeSpan(doc, "fn__flex-1"), saveBtn, makeSpan(doc, "fn__space"), resetBtn, makeSpan(doc, "fn__space"));

  const warn = (message: string, error?: unknown): void => {
    try {
      deps.onWarn(message, error);
    } catch (inner) {
      console.warn(`[docseeker] ${message}`, error, inner);
    }
  };
  /** Message de l'assemblage ; un échec est tracé, jamais propagé (appels faits depuis des promesses). */
  const say = (text: string, durable = false): void => {
    if (disposed) {
      // Onglet fermé pendant l'écriture : un ÉCHEC doit quand même être dit, par le canal global (le reste est sans objet).
      if (!durable) return;
      try {
        deps.toast?.(text);
      } catch (error) {
        warn("Notification globale sur les critères impossible", error);
      }
      return;
    }
    try {
      deps.notify(text);
    } catch (error) {
      warn("Message sur les critères impossible", error);
    }
  };

  // --- Puces.
  /** Nom du critère de chaque puce affichée (jamais relu depuis le texte). */
  const chipNames = new Map<HTMLElement, string>();
  let renderedNames: readonly string[] | undefined;

  const buildChip = (name: string): HTMLElement => {
    const chip = el(doc, "div", CHIP_CLASS, { "data-type": "set-criteria", tabindex: "0", role: "button" });
    const close = svgIcon(doc, "iconClose", "b3-chip__close");
    close.setAttribute("data-type", "remove-criteria");
    chip.append(doc.createTextNode(name), close);
    chipNames.set(chip, name);
    return chip;
  };

  const refresh = (): void => {
    if (disposed) return;
    const list = deps.list();
    const names = list.map((c) => c.name);
    if (renderedNames === undefined || names.length !== renderedNames.length || names.some((n, i) => n !== renderedNames?.[i])) {
      chipNames.clear();
      chipsEl.replaceChildren(...names.map(buildChip));
      renderedNames = names;
    }
    chipsEl.classList.toggle("fn__none", names.length === 0);
    const state = deps.getState();
    for (const [chip, name] of chipNames) {
      const criterion = list.find((c) => c.name === name);
      const className = criterion !== undefined && sameCriteria(criterion, state) ? CHIP_CURRENT_CLASS : CHIP_CLASS;
      if (chip.className !== className) chip.className = className;
    }
  };

  const findByName = (name: string): SavedCriteria | undefined => {
    const list = deps.list();
    return list.find((c) => c.name === name) ?? list.find((c) => criteriaNameKey(c.name) === criteriaNameKey(name));
  };

  const doReset = (): void => {
    if (disposed) return;
    try {
      deps.reset();
    } catch (error) {
      warn("Réinitialisation des critères de recherche en échec", error);
      say(t("criteriaResetFailed"));
    }
    refresh();
  };

  const applyChip = (name: string): void => {
    const criterion = findByName(name);
    if (!criterion) {
      // Supprimé par une autre fenêtre entre-temps : le dire, pas de silence.
      say(t("criteriaAlreadyDeleted"));
      refresh();
      return;
    }
    try {
      deps.recall(criterion);
    } catch (error) {
      warn("Rappel du critère en échec", error);
      say(t("criteriaRecallFailed"));
    }
    refresh();
  };

  /** Rend le focus à la puce voisine (même rang, sinon la précédente), à défaut au bouton « Enregistrer » : la puce supprimée n'existe plus. */
  const refocusAfterRemoval = (rank: number): void => {
    const rest = [...chipNames.keys()];
    const target = rest[Math.min(rank, rest.length - 1)] ?? (saveBtn.isConnected ? saveBtn : undefined);
    target?.focus();
  };

  const removeChip = (name: string): void => {
    const criterion = findByName(name);
    const hadFocus = header.contains(doc.activeElement);
    const rank = renderedNames?.indexOf(name) ?? -1;
    // Comme le natif : supprimer la puce courante réinitialise aussi la recherche.
    const wasCurrent = criterion !== undefined && sameCriteria(criterion, deps.getState());
    void (async () => deps.remove(name))()
      .then(
        (existed) => {
          if (disposed) return;
          if (existed && wasCurrent) doReset();
          else refresh();
          if (hadFocus && !header.contains(doc.activeElement)) refocusAfterRemoval(Math.max(rank, 0));
        },
        (error: unknown) => {
          warn("Critère non supprimé", error);
          say(t("criteriaDeleteFailed"), true);
          refresh();
        },
      )
      .catch((error: unknown) => warn("Suite de la suppression du critère en échec", error)); // jamais de rejet non géré
  };

  // --- Enregistrement : dialogue d'entrée puis, selon le cas, confirmation (mêmes cas que `saveCriterion` du natif).
  let inputHandle: InputDialogHandle | undefined;
  let confirmHandle: ConfirmDialogHandle | undefined;
  let saving = false;

  const commit = (plan: Extract<CriteriaSavePlan, { name: string }>, state: CriteriaState): void => {
    if (disposed) return;
    if (saving) {
      // Le dialogue de confirmation vient de se fermer alors qu'une autre écriture est en cours : ne rien dire serait un silence.
      warn("Critères non enregistrés : une écriture est déjà en cours", undefined);
      say(t("criteriaSaveFailed"));
      return;
    }
    saving = true;
    const criteria: SavedCriteria = {
      name: plan.name,
      query: state.query.trim(),
      filters: state.filters,
      sort: state.sort,
      groupByDocument: state.groupByDocument,
    };
    const failed = (error: unknown): void => {
      warn("Critères non enregistrés", error);
      say(t("criteriaSaveFailed"), true);
    };
    void (async () => deps.save(criteria, plan.removeNames))()
      .then(
        (result) => {
          saving = false;
          if (disposed) return;
          if ("error" in result) {
            if (result.error === "limit") say(t("criteriaErrLimit"));
            else failed(new Error(`Critères refusés : ${result.error}`));
            return;
          }
          inputHandle?.close();
          refresh();
        },
        (error: unknown) => {
          saving = false;
          failed(error);
          refresh(); // le magasin a restauré la liste : la ligne doit la montrer
        },
      )
      .catch((error: unknown) => warn("Suite de l'enregistrement des critères en échec", error));
  };

  /** Un rappel de dialogue a levé (jamais propagé à l'écouteur DOM) : trace et message. */
  const saveCallbackFailed = (error: unknown): void => {
    warn("Enregistrement des critères en échec", error);
    say(t("criteriaSaveFailed"));
  };

  const confirmThen = (text: string, plan: Extract<CriteriaSavePlan, { name: string }>, state: CriteriaState): void => {
    if (confirmHandle?.isOpen() === true) return;
    confirmHandle = deps.openConfirmDialog({
      title: t("dialogConfirm"),
      text,
      labels: { cancel: t("dialogCancel"), confirm: t("dialogConfirm") },
      onConfirm: () => commit(plan, state),
      onError: saveCallbackFailed,
    });
  };

  const onInputConfirm = (rawName: string): void => {
    if (disposed || saving) return;
    const state = deps.getState();
    const plan = planCriteriaSave(deps.list(), rawName, state);
    switch (plan.kind) {
      case "empty":
        say(t("criteriaErrEmpty"));
        return;
      case "tooLong":
        say(t("criteriaErrTooLong"));
        return;
      case "query":
        say(t("criteriaErrQuery"));
        return;
      case "limit":
        say(t("criteriaErrLimit"));
        return;
      case "noop":
        inputHandle?.close();
        return;
      case "save":
        commit(plan, state);
        return;
      case "overwrite":
        confirmThen(t("criteriaOverwrite"), plan, state);
        return;
      case "rename":
        confirmThen(t("criteriaRename", { x: plan.from, y: plan.name }), plan, state);
        return;
      case "merge":
        confirmThen(t("criteriaMerge", { x: plan.from, y: plan.name }), plan, state);
        return;
    }
  };

  const openSave = (): void => {
    if (disposed || inputHandle?.isOpen() === true) return;
    refresh();
    const currentName = [...chipNames].find(([chip]) => chip.classList.contains("b3-chip--current"))?.[1] ?? "";
    try {
      inputHandle = deps.openInputDialog({
        title: t("criteriaSave"),
        value: currentName,
        placeholder: t("criteriaMemo"),
        dataKey: DIALOG_KEY,
        labels: { cancel: t("dialogCancel"), confirm: t("dialogConfirm") },
        onConfirm: onInputConfirm,
        onError: saveCallbackFailed,
        // Après Enregistrer comme après toute annulation, quand SiYuan a vraiment détruit le dialogue.
        onDestroyed: () => {
          if (!disposed && saveBtn.isConnected) saveBtn.focus();
        },
      });
    } catch (error) {
      warn("Dialogue « Enregistrer les critères de requête » impossible à ouvrir", error);
      say(t("criteriaSaveFailed"));
    }
  };

  // --- Événements : un seul écouteur délégué, comme le natif (data-type sur la puce, sa croix et les boutons).
  header.addEventListener(
    "click",
    (event) => {
      let target = event.target instanceof Element ? event.target : null;
      while (target && target !== header) {
        const type = target.getAttribute("data-type");
        if (type === "remove-criteria") {
          const name = chipNames.get(target.parentElement as HTMLElement);
          event.stopPropagation();
          event.preventDefault();
          if (name !== undefined) removeChip(name);
          return;
        }
        if (type === "set-criteria") {
          const name = chipNames.get(target as HTMLElement);
          event.stopPropagation();
          event.preventDefault();
          if (name !== undefined) applyChip(name);
          return;
        }
        if (type === "saveCriterion") {
          event.stopPropagation();
          openSave();
          return;
        }
        if (type === "removeCriterion") {
          event.stopPropagation();
          event.preventDefault();
          doReset();
          return;
        }
        target = target.parentElement;
      }
    },
    { signal },
  );
  // Clavier : la puce est focalisable (Entrée ou Espace l'applique, Suppr la supprime), ce que le natif ne propose pas à la souris seule.
  header.addEventListener(
    "keydown",
    (event) => {
      const chip = event.target instanceof HTMLElement ? event.target : null;
      const name = chip ? chipNames.get(chip) : undefined;
      if (!chip || name === undefined || event.isComposing) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applyChip(name);
      } else if (event.key === "Delete") {
        event.preventDefault();
        removeChip(name);
      }
    },
    { signal },
  );

  refresh();

  return {
    element: header,
    refresh,
    openSave,
    reset: doReset,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      header.remove();
      // Après le retrait : les rappels `onDestroyed` ne rendent le focus à aucun bouton détaché.
      inputHandle?.close();
      confirmHandle?.close();
      chipNames.clear();
    },
  };
}
