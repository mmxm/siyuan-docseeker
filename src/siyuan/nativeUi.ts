/**
 * Adaptateur des menus et dialogues natifs de SiYuan (`Menu`, `Dialog`) : SEUL module du plugin, avec `index.ts`, à
 * importer ces classes. La barre et la vue reçoivent `openMenu` / `openDialog` par injection (voir `nativeUiTypes`).
 *
 * SiYuan 3.8.9 insère les libellés de menu, le titre et le contenu d'un dialogue comme du HTML (`innerHTML`) : tout texte
 * venu des données (noms de dossiers, requêtes de l'historique) est donc échappé ici, et le contenu d'un dialogue est un
 * squelette statique que l'on remplit ensuite en DOM.
 *
 * Il rend aussi le focus à l'élément ouvrant après la fermeture d'un menu : SiYuan appelle le `closeCB` AU DÉBUT de sa
 * fermeture, avant de vider le menu, puis le focus tombe sur BODY (vérifié dans le bundle 3.8.9 et dans le banc d'essai).
 */
import { Dialog, Menu, type IMenu } from "siyuan";
import type { DialogHandle, MenuAnchor, MenuHandle, NativeDialogOptions, NativeMenuItem } from "../ui/nativeUiTypes";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
/**
 * Texte venu des données (noms de dossiers, requêtes) : sans caractères de format Unicode (\p{Cf} : bidi U+202A-202E et
 * U+2066-2069, espaces de largeur nulle U+200B-D, U+2060, U+FEFF), qui permettraient d'usurper l'affichage, et sans
 * caractères de contrôle (\p{Cc}, remplacés par une espace). Puis échappé, SiYuan insérant le texte comme HTML.
 */
const toHtmlText = (text: string): string => escapeHtml(text.replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " "));
/** Identifiant de symbole du sprite : inséré dans `xlink:href="#..."` par SiYuan, donc strictement alphanumérique. */
const ICON_ID = /^icon[A-Za-z0-9]+$/;
const CURRENT_CLASS = "b3-menu__item--current";
const ITEM_CLASS = "b3-menu__item";
const SELECTED_CLASS = "b3-menu__item--selected";

function toMenuItem(item: NativeMenuItem): IMenu {
  if (item.separator === true) return { type: "separator" };
  const { click } = item;
  const result: IMenu = { label: toHtmlText(item.label ?? "") };
  // SiYuan n'attache d'écouteur qu'aux items qui ont un `click` (bundle 3.8.9) : un parent de sous-menu n'en reçoit pas, sinon
  // un clic dessus fermerait le menu au lieu de montrer le sous-menu. Après `click`, SiYuan ferme sauf valeur vraie.
  if (click && !item.submenu) {
    result.click = () => {
      click();
    };
  }
  if (item.icon !== undefined && ICON_ID.test(item.icon)) result.icon = item.icon;
  if (item.current === true) result.current = true;
  if (item.disabled === true) result.disabled = true;
  if (item.submenu) {
    result.type = "submenu";
    result.submenu = item.submenu.map(toMenuItem);
  }
  return result;
}

/** Clavier : sans cela le menu s'ouvre sans élément actif et Entrée/flèches ne font rien (comme pour la liste des onglets de SiYuan). */
function focusFirstItem(menu: Menu): void {
  const root = menu.element as HTMLElement | undefined;
  if (!root) return;
  // Éléments de premier niveau seulement : ceux des sous-menus existent dans le DOM (masqués) et ne doivent pas être pris.
  const top = ":scope > .b3-menu__items > ";
  const target =
    root.querySelector<HTMLElement>(`${top}.${SELECTED_CLASS}:not([disabled])`) ??
    root.querySelector<HTMLElement>(`${top}.${ITEM_CLASS}:not([disabled])`);
  if (!target) return;
  target.classList.add(CURRENT_CLASS);
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
}

const MENU_ID = /^[a-z0-9-]+$/;
const DEFAULT_MENU_ID = "docseeker";

/** Élément qui avait le focus à l'ouverture, s'il peut le reprendre (focalisable, encore dans le document, pas BODY). */
function focusableOpener(): HTMLElement | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : undefined;
}

/**
 * `id` : identifiant du menu pour SiYuan, qui n'a qu'un menu ouvert à la fois. Rouvrir le MÊME identifiant referme (bascule) ;
 * un identifiant différent remplace le menu ouvert. Un identifiant par bouton donne donc le comportement des boutons natifs.
 *
 * Focus : à toute fermeture, `onClose` s'exécute d'abord, puis, si le focus est encore dans le menu ou perdu (BODY), il est
 * rendu à l'élément qui l'avait à l'ouverture (s'il est encore dans le document). Un focus placé ailleurs (par un `click`,
 * par `onClose`) est respecté. Le focus est rendu synchroniquement, avant que SiYuan vide le menu.
 */
export function openMenu(items: readonly NativeMenuItem[], anchor: MenuAnchor, onClose?: () => void, id: string = DEFAULT_MENU_ID): MenuHandle {
  if (!MENU_ID.test(id)) throw new TypeError(`Identifiant de menu refusé : « ${id} » (attendu : a-z, 0-9, tiret)`);
  const opener = focusableOpener();
  let closed = false;
  const giveFocusBack = (): void => {
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const insideMenu = active !== null && menu.element?.contains(active) === true;
    if ((lost || insideMenu) && opener?.isConnected === true) opener.focus();
  };
  const menu: Menu = new Menu(id, () => {
    closed = true;
    try {
      onClose?.();
    } finally {
      giveFocusBack();
    }
  });
  for (const item of items) menu.addItem(toMenuItem(item));
  menu.open({
    x: anchor.x,
    y: anchor.y,
    ...(anchor.w !== undefined ? { w: anchor.w } : {}),
    ...(anchor.h !== undefined ? { h: anchor.h } : {}),
  });
  // Même identifiant déjà ouvert : SiYuan a refermé l'ancien menu et celui-ci ne s'ouvre pas (son `closeCB` n'est jamais appelé).
  if (menu.isOpen) closed = true;
  else focusFirstItem(menu);
  return {
    close: () => {
      if (closed) return; // déjà fermé, ou remplacé par un autre menu : ne jamais fermer le menu d'un autre
      menu.close();
    },
  };
}

// --- Dialogue --------------------------------------------------------------------------------------------------

/** Squelette natif (`b3-dialog__content` + pied `b3-dialog__action`) : aucune donnée dynamique, libellés posés en DOM. */
const DIALOG_CONTENT =
  '<div class="b3-dialog__content"><div class="docseeker-dialog-body"></div></div>' +
  '<div class="b3-dialog__action">' +
  '<button type="button" class="b3-button b3-button--cancel"></button>' +
  '<div class="fn__space"></div>' +
  '<button type="button" class="b3-button b3-button--text"></button>' +
  "</div>";
const WIDTH_PATTERN = /^\d{1,4}px$/;

export function openDialog(options: NativeDialogOptions): DialogHandle {
  if (options.width !== undefined && !WIDTH_PATTERN.test(options.width)) {
    throw new TypeError(`Largeur de dialogue refusée : « ${options.width} » (attendu : 420px)`);
  }
  // SiYuan n'appelle `destroyCallback` qu'après un délai : `closing` coupe tout de suite les clics suivants.
  let closing = false;
  let closed = false;
  let confirmed = false;
  const dialog: Dialog = new Dialog({
    title: toHtmlText(options.title),
    content: DIALOG_CONTENT,
    ...(options.width !== undefined ? { width: options.width } : {}),
    // Appelé par SiYuan à toute destruction (Échap global, voile, bouton de fermeture) comme par nos boutons.
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      try {
        if (!confirmed) options.onCancel?.();
      } finally {
        options.onDestroyed?.();
      }
    },
  });
  const close = (): void => {
    if (closing) return;
    closing = true;
    dialog.destroy();
  };
  try {
    const root = dialog.element;
    const body = root.querySelector<HTMLElement>(".docseeker-dialog-body");
    const cancel = root.querySelector<HTMLButtonElement>("button.b3-button--cancel");
    const confirm = root.querySelector<HTMLButtonElement>("button.b3-button--text");
    if (!body || !cancel || !confirm) throw new Error("Squelette de dialogue introuvable");
    cancel.textContent = options.labels.cancel;
    confirm.textContent = options.labels.confirm;
    const confirmNow = (): void => {
      if (closing) return;
      if (options.onConfirm() === false) return; // saisie invalide : le dialogue reste ouvert
      confirmed = true;
      close();
    };
    cancel.addEventListener("click", close);
    confirm.addEventListener("click", confirmNow);
    root.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // le dialogue se ferme ici : pas une seconde fois par le gestionnaire global
        close();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        confirmNow();
      }
    });
    options.build(body);
    body.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  } catch (error) {
    close(); // pas de dialogue vide laissé à l'écran
    throw error;
  }
  // « Ouvert » tant que SiYuan ne l'a pas détruit : destruction différée comprise (pas de réouverture pendant le délai), et
  // faux dès que l'élément a quitté le document, même si SiYuan ne rappelle pas `destroyCallback`.
  return { close, isOpen: () => !closed && dialog.element.isConnected };
}
