/**
 * Fenêtre flottante de la recherche (comme la recherche globale native de SiYuan) : un SEUL dialogue à la fois, qui monte la
 * même vue que l'onglet. Dépendances injectées : ce module n'importe rien de « siyuan » (voir `openFloatingDialog` dans
 * `nativeUi.ts`) et se teste avec un faux dialogue.
 *
 * - Un deuxième `open()` refocalise le champ au lieu d'ouvrir un autre dialogue ; pendant la fermeture (SiYuan détruit le
 *   dialogue après un délai) il est mis en attente et le dialogue suivant s'ouvre une fois l'ancien réellement détruit. La fermeture
 *   est connue dès son DÉBUT, même quand c'est SiYuan qui la lance (`onClosing`) : `isOpen()` est faux pendant tout le délai.
 *   Si SiYuan retire le dialogue sans jamais appeler `destroyCallback`, `open()` le constate (élément déconnecté) et rouvre.
 * - La session (requête soumise et options) est restituée au montage et mémorisée à chaque changement : à la réouverture la
 *   recherche est RELANCÉE par la vue (aucun instantané des résultats).
 * - À la fermeture, le focus retourne à l'élément qui l'avait à l'ouverture (s'il est encore dans le document et que le focus est
 *   perdu), sauf quand on ferme parce qu'un PDF s'ouvre (`restoreFocus: false`).
 * - La vue est libérée à la destruction RÉELLE du dialogue, quelle qu'en soit l'origine (Échap global, voile, croix, `close()`).
 */
import type { SearchSessionState, SearchSessionStore } from "../search/searchSession";
import type { FloatingDialogHandle, OpenFloatingDialog } from "../ui/nativeUiTypes";

export interface CloseOptions {
  /** Faux : ne pas rendre le focus à l'élément ouvrant (un PDF s'ouvre, ou un onglet prend le relais). Vrai par défaut. */
  readonly restoreFocus?: boolean;
}

export interface FloatingMountOptions {
  /** Session mémorisée à restituer (requête soumise : la vue relance la recherche ; sinon seulement les options). */
  readonly initial: SearchSessionState | undefined;
  /** À appeler à chaque soumission et à chaque changement d'options. */
  save(state: SearchSessionState): void;
  /** Demande la fermeture de la fenêtre (Échap sur un champ vide, ouverture d'un PDF, transfert vers un onglet). */
  close(options?: CloseOptions): void;
}

export interface FloatingSearchView {
  dispose(): void;
  focusInput(): boolean;
}

export interface FloatingSearchDeps {
  readonly openDialog: OpenFloatingDialog;
  /** Titre du dialogue (texte brut, échappé par l'adaptateur). */
  readonly title: string;
  readonly session: SearchSessionStore;
  /** Monte la vue de recherche dans le conteneur du dialogue. */
  mount(host: HTMLElement, options: FloatingMountOptions): FloatingSearchView;
  onWarn(message: string, error?: unknown): void;
  /** Message d'erreur visible (toast) : texte brut SANS `<`, `>` ni `&` (SiYuan l'insère comme HTML). Absent : le journal seul. */
  readonly notify?: (message: string) => void;
  /** Texte de `notify` quand la fenêtre ne peut pas s'ouvrir. */
  readonly openFailedText?: string;
  /** Document des éléments focalisés (défaut : `document`). */
  readonly doc?: Document;
}

export interface FloatingSearch {
  /** Ouvre la fenêtre, ou refocalise son champ si elle est déjà ouverte. Ne lève jamais (l'échec est tracé). */
  open(): void;
  /** Ferme la fenêtre ; sans effet si elle est fermée ou déjà en cours de fermeture. */
  close(options?: CloseOptions): void;
  /** Vrai tant que la fenêtre est ouverte ET n'est pas en cours de fermeture. */
  isOpen(): boolean;
  /** Focalise le champ de recherche ; faux si la fenêtre n'est pas ouverte ou si le focus est refusé. */
  focusInput(): boolean;
  /** Déchargement du plugin : détruit la fenêtre et libère la vue tout de suite (idempotent). */
  dispose(): void;
}

interface Instance {
  view: FloatingSearchView | undefined;
  handle: FloatingDialogHandle | undefined;
  opener: HTMLElement | undefined;
  closing: boolean;
  noFocus: boolean;
  done: boolean;
}

export function createFloatingSearch(deps: FloatingSearchDeps): FloatingSearch {
  const doc = deps.doc ?? document;
  let current: Instance | undefined;
  let pendingReopen = false;
  let disposed = false;

  const warn = (message: string, error: unknown): void => deps.onWarn(message, error);

  /** Fin de vie d'une instance (destruction réelle du dialogue, ou déchargement) : libère la vue, rend le focus, rouvre si demandé. */
  const finish = (inst: Instance, restoreFocus: boolean): void => {
    if (inst.done) return;
    inst.done = true;
    const view = inst.view;
    inst.view = undefined;
    if (current === inst) current = undefined;
    try {
      view?.dispose();
    } catch (error) {
      warn("Libération de la recherche flottante en échec", error);
    }
    if (restoreFocus && !disposed && !inst.noFocus) {
      const active = doc.activeElement;
      // Le dialogue vient de quitter le document : le focus qu'il avait est perdu (BODY). Un focus placé ailleurs est respecté.
      if ((active === null || active === doc.body) && inst.opener?.isConnected === true) inst.opener.focus();
    }
    if (pendingReopen) {
      pendingReopen = false;
      if (!disposed) open();
    }
  };

  /** Demande la destruction au dialogue ; un échec est tracé, jamais propagé. Sans handle (montage en cours), sans effet. */
  const closeHandle = (inst: Instance): void => {
    try {
      inst.handle?.close(inst.noFocus ? { focus: false } : undefined);
    } catch (error) {
      warn("Fermeture de la recherche flottante en échec", error);
    }
  };

  const requestClose = (inst: Instance, options?: CloseOptions): void => {
    if (inst.closing) return;
    inst.closing = true;
    inst.noFocus = options?.restoreFocus === false;
    closeHandle(inst);
  };

  /** La destruction COMMENCE (même lancée par SiYuan : Échap global, voile, croix) : l'instance est condamnée jusqu'à `onDestroyed`. */
  const markClosing = (inst: Instance, info: { readonly focus: boolean }): void => {
    if (inst.closing) return;
    inst.closing = true;
    inst.noFocus = !info.focus;
  };

  function open(): void {
    if (disposed) return;
    if (current && current.handle?.isOpen() === false) {
      // SiYuan a retiré le dialogue sans jamais appeler `destroyCallback` : l'instance est morte, on la libère et on rouvre pour de bon.
      pendingReopen = false;
      finish(current, false);
    }
    if (current) {
      if (current.closing) pendingReopen = true; // l'ancienne fenêtre disparaît d'abord : une seule nouvelle fenêtre ensuite
      else focusInput();
      return;
    }
    const active = doc.activeElement;
    const inst: Instance = {
      view: undefined,
      handle: undefined,
      opener: active instanceof HTMLElement && active !== doc.body ? active : undefined,
      closing: false,
      noFocus: false,
      done: false,
    };
    current = inst;
    try {
      inst.handle = deps.openDialog({
        title: deps.title,
        build: (container) => {
          inst.view = deps.mount(container, {
            initial: deps.session.get(),
            save: (state) => deps.session.set(state),
            close: (options) => requestClose(inst, options),
          });
        },
        onClosing: (info) => markClosing(inst, info),
        onDestroyed: (info) => finish(inst, info.focus),
      });
    } catch (error) {
      finish(inst, false); // le dialogue (s'il existe) est détruit par l'adaptateur ; la vue éventuelle est libérée
      warn("Ouverture de la recherche flottante impossible", error);
      if (deps.notify) {
        try {
          deps.notify(deps.openFailedText ?? "Impossible d'ouvrir la recherche flottante.");
        } catch (notifyError) {
          warn("Notification d'erreur impossible", notifyError);
        }
      }
      return;
    }
    if (inst.closing) {
      closeHandle(inst); // fermeture demandée pendant le montage : le handle n'existait pas encore
      return;
    }
    focusInput();
  }

  function focusInput(): boolean {
    const inst = current;
    if (!inst || inst.closing || !inst.view) return false;
    try {
      return inst.view.focusInput();
    } catch (error) {
      warn("Accès au champ de recherche flottante impossible", error);
      return false;
    }
  }

  return {
    open,
    close(options) {
      if (current) requestClose(current, options);
    },
    isOpen: () => current !== undefined && !current.closing && current.handle?.isOpen() === true,
    focusInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingReopen = false;
      const inst = current;
      if (!inst) return;
      requestClose(inst, { restoreFocus: false });
      finish(inst, false); // sans attendre le destroyCallback différé de SiYuan, qui sera ignoré
    },
  };
}
