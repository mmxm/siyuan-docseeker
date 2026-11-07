/**
 * Contrat des menus et dialogues natifs de SiYuan, tel que la barre et la vue le voient : types et identifiants de menu
 * partagés, aucune dépendance au paquet « siyuan » (l'adaptateur `src/siyuan/nativeUi.ts` est seul à l'importer). Le texte
 * des libellés est TOUJOURS du texte brut : c'est l'adaptateur qui le nettoie et l'échappe pour SiYuan, qui l'insère comme HTML.
 */
export interface NativeMenuItem {
  readonly label?: string;
  /** Identifiant du sprite SiYuan (« iconFolder »...), sans « # ». */
  readonly icon?: string;
  /** Élément choisi (rendu par SiYuan avec la classe `b3-menu__item--selected`). */
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly separator?: boolean;
  readonly submenu?: readonly NativeMenuItem[];
  readonly click?: () => void;
}

export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
}

export interface NativeDialogOptions {
  /** Texte brut ; l'adaptateur l'échappe (SiYuan l'insère comme HTML). */
  readonly title: string;
  /** « 420px » exactement ce format. */
  readonly width?: string;
  /** Remplit le conteneur vide du dialogue (DOM seulement, jamais de chaîne HTML). */
  build(container: HTMLElement): void;
  /** Retourner `false` garde le dialogue ouvert (saisie invalide). */
  onConfirm(): boolean | void;
  /** Appelé à toute fermeture autre que « Confirmer » (Annuler, Échap, clic hors du dialogue, `close()` du handle). */
  onCancel?(): void;
  /**
   * Appelé UNE fois, quand SiYuan a réellement détruit le dialogue (son `destroyCallback`, après un délai) : après
   * « Confirmer » comme après toute annulation, et APRÈS `onCancel`. C'est ici que le focus peut être rendu.
   */
  onDestroyed?(): void;
  readonly labels: { readonly cancel: string; readonly confirm: string };
}

/** Menu ouvert par `OpenMenu` : `close()` le ferme s'il est encore ouvert (sans effet sinon, jamais un autre menu). */
export interface MenuHandle {
  close(): void;
}

/** Dialogue ouvert par `OpenDialog`. */
export interface DialogHandle {
  /** Détruit le dialogue (sans effet s'il est déjà en cours de destruction ou détruit). */
  close(): void;
  /** Vrai tant que le dialogue est à l'écran, destruction différée comprise ; faux dès qu'il est détruit (même sans callback). */
  isOpen(): boolean;
}

/** Identifiants de menu, un par bouton : SiYuan n'a qu'un menu ouvert, rouvrir le même identifiant le referme. */
export const MENU_ID_PATH = "docseeker-path";
export const MENU_ID_MORE = "docseeker-more";
export const MENU_ID_HISTORY = "docseeker-history";

/**
 * `id` (optionnel) : identifiant du menu, un par bouton. SiYuan n'ouvre qu'un menu à la fois : rouvrir le même
 * identifiant referme le menu (bascule), un autre identifiant remplace le menu ouvert.
 * `onClose` : appelé à toute fermeture (choix, Échap, clic ailleurs, remplacement, `close()`). Le focus est rendu à l'élément
 * ouvrant par l'adaptateur : l'appelant n'a pas à s'en occuper.
 */
export type OpenMenu = (items: readonly NativeMenuItem[], anchor: MenuAnchor, onClose?: () => void, id?: string) => MenuHandle;
export type OpenDialog = (options: NativeDialogOptions) => DialogHandle;
