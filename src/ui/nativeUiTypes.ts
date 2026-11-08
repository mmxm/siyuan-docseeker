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
  /** Infobulle de l'élément (texte brut posé en attribut `title`, p. ex. pourquoi il est désactivé). Texte fixe du plugin, pas une donnée. */
  readonly title?: string;
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
  /** Vrai tant que CE menu est ouvert ; faux s'il est fermé, remplacé par un autre, ou s'il ne s'est jamais ouvert (même identifiant déjà ouvert : bascule). */
  isOpen(): boolean;
}

/** Dialogue ouvert par `OpenDialog`. */
export interface DialogHandle {
  /** Détruit le dialogue (sans effet s'il est déjà en cours de destruction ou détruit). */
  close(): void;
  /** Vrai tant que le dialogue est à l'écran, destruction différée comprise ; faux dès qu'il est détruit (même sans callback). */
  isOpen(): boolean;
}

/**
 * Fenêtre flottante (comme la recherche globale native : 80vw x 90vh, position mémorisée par SiYuan) : un conteneur vide à
 * remplir en DOM, un titre, la croix native, ni « Annuler » ni « Confirmer ». SiYuan la ferme sur Échap global, voile ou croix.
 */
export interface FloatingDialogOptions {
  /** Texte brut ; l'adaptateur l'échappe (SiYuan l'insère comme HTML). */
  readonly title: string;
  /**
   * « window » (défaut) : fenêtre 80vw x 90vh à position mémorisée (bureau). « fullscreen » : plein écran 100vw x 100dvh (repli vh),
   * sans position mémorisée (mobile).
   */
  readonly layout?: "window" | "fullscreen";
  /** Remplit le conteneur vide (DOM seulement, jamais de chaîne HTML). */
  build(container: HTMLElement): void;
  /**
   * Appelé UNE fois, quand SiYuan a réellement détruit la fenêtre (son `destroyCallback`, après un délai), quelle que soit
   * l'origine : `close()`, Échap global, voile, croix. `focus` est faux si la destruction a demandé de ne pas rendre le focus
   * (`close({ focus: false })`, `destroy({ focus: "false" })` de SiYuan).
   */
  onDestroyed?(info: { readonly focus: boolean }): void;
  /**
   * Appelé UNE fois, dès que la destruction COMMENCE (avant le délai de SiYuan), que `close()` en soit l'origine ou SiYuan lui-même
   * (Échap global, voile, croix : il appelle alors `dialog.destroy()`). Pendant ce délai la fenêtre est condamnée : l'appelant ne
   * doit plus y adresser d'action. `focus` : même sens que pour `onDestroyed`.
   */
  onClosing?(info: { readonly focus: boolean }): void;
}

/** Fenêtre flottante ouverte par `OpenFloatingDialog`. */
export interface FloatingDialogHandle {
  /** Détruit la fenêtre (sans effet si la destruction est déjà en cours). `focus: false` : ne pas rendre le focus (un PDF s'ouvre). */
  close(options?: { readonly focus?: boolean }): void;
  /** Vrai tant que la fenêtre est à l'écran, destruction différée comprise ; faux dès qu'elle est détruite. */
  isOpen(): boolean;
}

/**
 * Dialogue à contenu libre (comme « Spécifier le chemin » de SiYuan) : le plugin fournit tout le corps, boutons compris, déjà
 * construit en DOM. Ni « Annuler » ni « Confirmer » ajoutés par l'adaptateur : Échap, voile et croix ferment comme pour tout
 * dialogue SiYuan, et le contenu ferme lui-même via le handle.
 */
export interface CustomDialogOptions {
  /** Texte brut ; l'adaptateur l'échappe et le place dans le gabarit de titre natif. */
  readonly title: string;
  /** « 50vw », « 420px » : nombre de 1 à 4 chiffres suivi de px, vw ou vh. */
  readonly width: string;
  readonly height: string;
  /** Posé en `data-key` sur la racine du dialogue (a-z, 0-9, tiret). */
  readonly dataKey: string;
  /** Nœuds ajoutés au corps du dialogue (DOM seulement, jamais de chaîne HTML). */
  readonly content: Node;
  /** Appelé UNE fois, quand SiYuan a réellement détruit le dialogue (après son délai), quelle que soit l'origine de la fermeture. */
  onDestroyed?(): void;
}

export interface CustomDialogHandle {
  /** Détruit le dialogue (sans effet s'il est déjà en cours de destruction ou détruit). */
  close(): void;
  /** Vrai tant que le dialogue est à l'écran, destruction différée comprise ; faux dès qu'il est détruit (même sans callback). */
  isOpen(): boolean;
}

/**
 * Dialogue d'entrée (équivalent de `openInputDialog` de SiYuan) : un champ texte, « Annuler » et « Confirmer ». Le dialogue reste
 * ouvert après « Confirmer » (ou Entrée) : c'est l'appelant qui le ferme (`close()`), une fois la saisie validée.
 */
export interface InputDialogOptions {
  /** Texte brut ; l'adaptateur l'échappe. */
  readonly title: string;
  /** Valeur initiale (posée par propriété, jamais en HTML) ; sélectionnée à l'ouverture. */
  readonly value: string;
  readonly placeholder: string;
  /** Posé en `data-key` sur la racine du dialogue (a-z, 0-9, tiret). */
  readonly dataKey: string;
  /** « 520px » : nombre de 1 à 4 chiffres suivi de px. Défaut : 520px. */
  readonly width?: string;
  readonly labels: { readonly cancel: string; readonly confirm: string };
  /** « Confirmer » ou Entrée ; reçoit le texte du champ tel quel (non rogné). */
  onConfirm(value: string): void;
  /** Erreur levée par `onConfirm` (jamais propagée à l'écouteur DOM) ; défaut : console.error. */
  onError?(error: unknown): void;
  /** Appelé UNE fois, quand SiYuan a réellement détruit le dialogue, quelle qu'en soit la cause. */
  onDestroyed?(): void;
}

export interface InputDialogHandle {
  close(): void;
  isOpen(): boolean;
}

/**
 * Dialogue de confirmation (équivalent de `confirmDialog` de SiYuan) : un texte, « Annuler » et « Confirmer ». Il se ferme après
 * l'une ou l'autre.
 */
export interface ConfirmDialogOptions {
  /** Texte brut ; l'adaptateur l'échappe. */
  readonly title: string;
  /** Texte brut (poser en `textContent`) : peut contenir des noms venus des données. */
  readonly text: string;
  readonly labels: { readonly cancel: string; readonly confirm: string };
  onConfirm(): void;
  /** Erreur levée par `onConfirm` (le dialogue est quand même fermé) ; défaut : console.error. */
  onError?(error: unknown): void;
  /** Annuler, Échap ou toute fermeture autre que « Confirmer ». */
  onCancel?(): void;
  /** Appelé UNE fois, quand le dialogue est détruit (après onConfirm ou onCancel). */
  onDestroyed?(): void;
}

export interface ConfirmDialogHandle {
  close(): void;
  isOpen(): boolean;
}

/** Identifiants de menu, un par bouton : SiYuan n'a qu'un menu ouvert, rouvrir le même identifiant le referme. */
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
export type OpenInputDialog = (options: InputDialogOptions) => InputDialogHandle;
export type OpenConfirmDialog = (options: ConfirmDialogOptions) => ConfirmDialogHandle;
export type OpenCustomDialog = (options: CustomDialogOptions) => CustomDialogHandle;
export type OpenFloatingDialog = (options: FloatingDialogOptions) => FloatingDialogHandle;
