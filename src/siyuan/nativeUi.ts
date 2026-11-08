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
import type {
  CustomDialogHandle,
  ConfirmDialogHandle,
  ConfirmDialogOptions,
  CustomDialogOptions,
  DialogHandle,
  InputDialogHandle,
  InputDialogOptions,
  FloatingDialogHandle,
  FloatingDialogOptions,
  MenuAnchor,
  MenuHandle,
  NativeDialogOptions,
  NativeMenuItem,
} from "../ui/nativeUiTypes";

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
/** Appelle `fn` ; une erreur va à `onError` (défaut : console.error), jamais à l'écouteur DOM qui l'avalerait ou la laisserait non gérée. */
function guarded(fn: () => void, onError: ((error: unknown) => void) | undefined): void {
  try {
    fn();
  } catch (error) {
    try {
      if (onError) onError(error);
      else console.error("[docseeker] Rappel de dialogue en échec", error);
    } catch (inner) {
      console.error("[docseeker] Rappel de dialogue en échec", error, inner);
    }
  }
}

/** Appelle `destroy` ; s'il lève, le drapeau « fermeture en cours » est réarmé (un nouvel essai reste possible). */
function destroyOnce(destroy: () => void, rearm: () => void): void {
  let done = false;
  try {
    destroy();
    done = true;
  } finally {
    if (!done) rearm();
  }
}

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
  // `bind` de SiYuan reçoit l'élément créé : l'infobulle y est posée en attribut, jamais interprétée comme HTML.
  const { title } = item;
  if (title !== undefined) result.bind = (element) => element.setAttribute("title", title);
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
    isOpen: () => !closed,
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

// --- Dialogue à contenu libre ----------------------------------------------------------------------------------

const CSS_SIZE = /^\d{1,4}(px|vw|vh)$/;
const DATA_KEY = /^[a-z0-9-]+$/;

/** Gabarit du titre natif de « Spécifier le chemin » : marge de 8 px et ligne d'indice (vide ici, historique hors périmètre). */
function customTitleHtml(title: string): string {
  return (
    `<div style="padding:8px">${toHtmlText(title)}` +
    '<div style="max-height:16px;line-height:14px" class="ft__smaller ft__on-surface fn__hidescrollbar"></div></div>'
  );
}

/**
 * Ouvre un `Dialog` dont le corps est entièrement fourni par l'appelant (DOM déjà construit). L'adaptateur ne met aucune donnée
 * dans une chaîne HTML : seul le titre, échappé, y passe. Échap est laissé au gestionnaire global de SiYuan (comme le dialogue
 * natif) ; le focus est rendu à l'ouvrant par le `Dialog` de SiYuan à la destruction.
 */
export function openCustomDialog(options: CustomDialogOptions): CustomDialogHandle {
  for (const [what, value] of [["Largeur", options.width], ["Hauteur", options.height]] as const) {
    if (!CSS_SIZE.test(value)) throw new TypeError(`${what} de dialogue refusée : « ${value} » (attendu : 50vw, 70vh ou 420px)`);
  }
  if (!DATA_KEY.test(options.dataKey)) throw new TypeError(`Clé de dialogue refusée : « ${options.dataKey} » (attendu : a-z, 0-9, tiret)`);
  let closing = false;
  let closed = false;
  const dialog: Dialog = new Dialog({
    title: customTitleHtml(options.title),
    content: "",
    width: options.width,
    height: options.height,
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      options.onDestroyed?.();
    },
  });
  // Échap global, voile et croix appellent `dialog.destroy()` sans passer par `close()` : on le sait dès le début de la destruction.
  const siyuanDestroy = dialog.destroy.bind(dialog) as (destroyOptions?: Record<string, unknown>) => void;
  dialog.destroy = (destroyOptions?: Record<string, unknown>): void => {
    closing = true;
    destroyOnce(() => siyuanDestroy(destroyOptions), () => (closing = false));
  };
  try {
    const root = dialog.element;
    root.setAttribute("data-key", options.dataKey);
    root.querySelector<HTMLElement>(".b3-dialog__header")?.style.setProperty("padding", "0");
    const body = root.querySelector<HTMLElement>(".b3-dialog__body");
    if (!body) throw new Error("Corps de dialogue introuvable");
    body.appendChild(options.content);
  } catch (error) {
    dialog.destroy(); // pas de dialogue vide laissé à l'écran
    throw error;
  }
  return {
    close: () => {
      if (!closing) dialog.destroy();
    },
    isOpen: () => !closed && dialog.element.isConnected,
  };
}

// --- Dialogue d'entrée et dialogue de confirmation (copies de ceux de SiYuan) -------------------------------------

const INPUT_WIDTH = "520px";

/** Squelette de `openInputDialog` (app/src/dialog/inputDialog.ts, 3.8.9), sans donnée : valeur et libellés sont posés en DOM. */
const INPUT_CONTENT =
  '<div class="b3-dialog__content"><input spellcheck="false" class="b3-text-field fn__block" value="" data-dialog-input></div>' +
  '<div class="b3-dialog__action">' +
  '<button class="b3-button b3-button--cancel" data-input-cancel></button>' +
  '<div class="fn__space"></div>' +
  '<button class="b3-button b3-button--text" data-input-confirm></button>' +
  "</div>";

function checkDialogKey(dataKey: string): void {
  if (!DATA_KEY.test(dataKey)) throw new TypeError(`Clé de dialogue refusée : « ${dataKey} » (attendu : a-z, 0-9, tiret)`);
}

/**
 * Dialogue d'entrée identique à `openInputDialog` de SiYuan : même DOM, champ focalisé et texte sélectionné, « Confirmer » rend le
 * focus au champ et laisse l'appelant décider de la fermeture, Entrée équivaut à « Confirmer ». Le titre est échappé ; valeur et
 * placeholder passent par propriété (jamais en HTML).
 */
export function openInputDialog(options: InputDialogOptions): InputDialogHandle {
  const width = options.width ?? INPUT_WIDTH;
  if (!/^\d{1,4}px$/.test(width)) throw new TypeError(`Largeur de dialogue refusée : « ${width} » (attendu : 520px)`);
  checkDialogKey(options.dataKey);
  let closing = false;
  let closed = false;
  const dialog: Dialog = new Dialog({
    title: toHtmlText(options.title),
    content: INPUT_CONTENT,
    width,
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      options.onDestroyed?.();
    },
  });
  const close = (): void => {
    if (closing) return;
    closing = true;
    destroyOnce(() => dialog.destroy(), () => (closing = false));
  };
  try {
    const root = dialog.element;
    const input = root.querySelector<HTMLInputElement>("[data-dialog-input]");
    const cancel = root.querySelector<HTMLButtonElement>("[data-input-cancel]");
    const confirm = root.querySelector<HTMLButtonElement>("[data-input-confirm]");
    if (!input || !cancel || !confirm) throw new Error("Squelette de dialogue d'entrée introuvable");
    root.setAttribute("data-key", options.dataKey);
    cancel.textContent = options.labels.cancel;
    confirm.textContent = options.labels.confirm;
    input.placeholder = options.placeholder;
    input.value = options.value;
    cancel.addEventListener("click", close);
    confirm.addEventListener("click", () => {
      input.focus(); // comme SiYuan : une saisie refusée se corrige tout de suite
      guarded(() => options.onConfirm(input.value), options.onError);
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      confirm.click();
    });
    input.focus();
    input.select();
  } catch (error) {
    close(); // pas de dialogue vide laissé à l'écran
    throw error;
  }
  return { close, isOpen: () => !closed && dialog.element.isConnected };
}

/** Squelette de `confirmDialog` (app/src/dialog/confirmDialog.ts, 3.8.9) : identifiants des boutons conservés. */
const CONFIRM_CONTENT =
  '<div class="b3-dialog__content"><div class="ft__breakword"></div></div>' +
  '<div class="b3-dialog__action">' +
  '<button class="b3-button b3-button--cancel" id="cancelDialogConfirmBtn"></button><div class="fn__space"></div>' +
  '<button class="b3-button b3-button--text" id="confirmDialogConfirmBtn"></button>' +
  "</div>";

/**
 * Dialogue de confirmation identique à `confirmDialog` de SiYuan (520px, `data-key="dialog-confirm"`, « Confirmer » focalisé,
 * clics et évènements `detail` « Enter » / « Escape » envoyés par SiYuan sur le dialogue). Le texte est posé en `textContent` :
 * il peut contenir des noms venus des données. Le focus est rendu à l'élément qui l'avait à l'ouverture.
 */
export function openConfirmDialog(options: ConfirmDialogOptions): ConfirmDialogHandle {
  const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  let handled = false;
  let closing = false;
  let closed = false;
  const handleCancel = (): void => {
    if (handled) return;
    handled = true;
    options.onCancel?.();
  };
  const dialog: Dialog = new Dialog({
    title: toHtmlText(options.title),
    content: CONFIRM_CONTENT,
    width: INPUT_WIDTH,
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      try {
        handleCancel(); // fermeture par SiYuan (Échap global, voile, croix) : annulation
        options.onDestroyed?.();
      } finally {
        const active = document.activeElement;
        if (previousActive?.isConnected === true && (active === null || active === document.body)) previousActive.focus({ preventScroll: true });
      }
    },
  });
  const close = (): void => {
    if (closing) return;
    closing = true;
    destroyOnce(() => dialog.destroy(), () => (closing = false));
  };
  try {
    const root = dialog.element;
    const text = root.querySelector<HTMLElement>(".ft__breakword");
    const cancel = root.querySelector<HTMLButtonElement>("#cancelDialogConfirmBtn");
    const confirm = root.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn");
    if (!text || !cancel || !confirm) throw new Error("Squelette de dialogue de confirmation introuvable");
    root.setAttribute("data-key", "dialog-confirm");
    text.textContent = options.text;
    cancel.textContent = options.labels.cancel;
    confirm.textContent = options.labels.confirm;
    root.addEventListener("click", (event) => {
      const detail: unknown = event.detail;
      const dispatched = typeof detail === "string";
      let target = event.target instanceof Element ? event.target : null;
      while ((target !== null && target !== root) || dispatched) {
        if (target?.id === "cancelDialogConfirmBtn" || (dispatched && detail === "Escape")) {
          handleCancel();
          close();
          return;
        }
        if (target?.id === "confirmDialogConfirmBtn" || (dispatched && detail === "Enter")) {
          handled = true;
          try {
            guarded(() => options.onConfirm(), options.onError);
          } finally {
            close(); // même si l'appelant lève : pas de dialogue condamné laissé à l'écran
          }
          return;
        }
        if (dispatched) return;
        target = target?.parentElement ?? null;
      }
    });
    confirm.focus({ preventScroll: true });
  } catch (error) {
    close();
    throw error;
  }
  return { close, isOpen: () => !closed && dialog.element.isConnected };
}

// --- Fenêtre flottante -----------------------------------------------------------------------------------------

/** Dimensions de la recherche globale native (relevées dans le bundle 3.8.9) et clé de mémorisation de la position. */
const FLOATING_WIDTH = "80vw";
const FLOATING_HEIGHT = "90vh";
const FLOATING_POSITION_ID = "docseeker-search";
/** Plein écran (mobile) : `vh` transmis à SiYuan, puis `dvh` posé sur le conteneur (un moteur qui ne le connaît pas garde le `vh`). */
const FULLSCREEN_WIDTH = "100vw";
const FULLSCREEN_HEIGHT = "100vh";
const FULLSCREEN_DYNAMIC_HEIGHT = "100dvh";

/** Squelette statique : aucun pied (ni Annuler ni Confirmer), un seul conteneur que l'appelant remplit en DOM. */
const FLOATING_CONTENT = '<div class="docseeker-floating-body"></div>';

/**
 * Fenêtre flottante de la recherche (comme la recherche globale native : 80vw x 90vh, position et taille mémorisées par SiYuan
 * sous `positionId`). Pas de gestionnaire Échap ici : l'Échap GLOBAL de SiYuan ferme le dernier dialogue (après avoir fermé un menu
 * ouvert au-dessus), et c'est à la vue de consommer (`stopPropagation`) les frappes qu'elle traite elle-même.
 */
export function openFloatingDialog(options: FloatingDialogOptions): FloatingDialogHandle {
  const layout = options.layout ?? "window";
  if (layout !== "window" && layout !== "fullscreen") {
    throw new TypeError(`Disposition de fenêtre refusée : « ${String(layout)} » (attendu : window ou fullscreen)`);
  }
  const fullscreen = layout === "fullscreen";
  let closing = false;
  let closed = false;
  let noFocus = false;
  const dialog: Dialog = new Dialog({
    title: toHtmlText(options.title),
    content: FLOATING_CONTENT,
    width: fullscreen ? FULLSCREEN_WIDTH : FLOATING_WIDTH,
    height: fullscreen ? FULLSCREEN_HEIGHT : FLOATING_HEIGHT,
    // Plein écran : pas de position à mémoriser (et SiYuan rétablirait une taille et une place de bureau).
    ...(fullscreen ? {} : { positionId: FLOATING_POSITION_ID }),
    // SiYuan transmet à `destroyCallback` l'argument de `destroy` (ex. `{ focus: "false" }` après l'ouverture d'un résultat).
    destroyCallback: (info) => {
      if (closed) return;
      closed = true;
      options.onDestroyed?.({ focus: !noFocus && info?.["focus"] !== "false" });
    },
  });
  // Échap global, voile et croix appellent `dialog.destroy()` SANS passer par `close()` : on enveloppe `destroy` sur l'instance pour
  // connaître le DÉBUT de la destruction (SiYuan ne rappelle `destroyCallback` qu'après ~190 ms, fenêtre pendant laquelle un
  // `open()` retomberait sur un dialogue condamné). Les arguments d'origine sont transmis tels quels.
  const siyuanDestroy = dialog.destroy.bind(dialog) as (destroyOptions?: Record<string, unknown>) => void;
  dialog.destroy = (destroyOptions?: Record<string, unknown>): void => {
    if (!closing) {
      closing = true;
      noFocus = destroyOptions?.["focus"] === "false";
      try {
        options.onClosing?.({ focus: !noFocus });
      } finally {
        siyuanDestroy(destroyOptions);
      }
      return;
    }
    siyuanDestroy(destroyOptions);
  };
  const close = (closeOptions?: { readonly focus?: boolean }): void => {
    if (closing) return;
    dialog.destroy(closeOptions?.focus === false ? { focus: "false" } : undefined);
  };
  try {
    if (fullscreen) {
      const container = dialog.element.querySelector<HTMLElement>(".b3-dialog__container");
      if (!container) throw new Error("Conteneur de fenêtre flottante introuvable");
      // Le CSS natif plafonne le conteneur : on lève les plafonds. L'assignation `dvh` est ignorée par un moteur qui ne la connaît pas.
      container.style.maxWidth = FULLSCREEN_WIDTH;
      // Ordre voulu : `vh` d'abord (valeur de repli), puis `dvh`. Un moteur qui ne connaît pas `dvh` rejette la 2e assignation et garde
      // la 1re ; un moteur qui le connaît retient `dvh` (hauteur utile, sans la barre d'adresse mobile).
      container.style.maxHeight = FULLSCREEN_HEIGHT;
      container.style.maxHeight = FULLSCREEN_DYNAMIC_HEIGHT;
      container.style.height = FULLSCREEN_DYNAMIC_HEIGHT;
    }
    const body = dialog.element.querySelector<HTMLElement>(".docseeker-floating-body");
    if (!body) throw new Error("Squelette de fenêtre flottante introuvable");
    options.build(body);
  } catch (error) {
    close(); // pas de fenêtre vide laissée à l'écran
    throw error;
  }
  // « Ouverte » tant que SiYuan ne l'a pas détruite (destruction différée comprise), et fausse dès que l'élément a quitté le document.
  return { close, isOpen: () => !closed && dialog.element.isConnected };
}
