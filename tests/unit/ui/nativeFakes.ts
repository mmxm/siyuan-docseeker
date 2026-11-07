import { vi } from "vitest";
import type { DialogHandle, MenuAnchor, MenuHandle, NativeDialogOptions, NativeMenuItem } from "../../../src/ui/nativeUiTypes";

export interface OpenedMenu {
  readonly items: readonly NativeMenuItem[];
  readonly anchor: MenuAnchor;
  readonly onClose: (() => void) | undefined;
  /** Identifiant passé à `openMenu` (un par bouton). */
  readonly id: string | undefined;
  closed: boolean;
  /** Ferme comme SiYuan : `onClose` une seule fois, sans effet ensuite. */
  close(): void;
}

export interface OpenedDialog {
  readonly options: NativeDialogOptions;
  readonly container: HTMLElement;
  /** Comme le bouton « Confirmer » : faux si le dialogue reste ouvert (saisie invalide). */
  confirm(): boolean;
  /** Comme « Annuler », Échap ou un clic hors du dialogue. */
  cancel(): void;
  /** Handle renvoyé à l'appelant (`close()` annule comme SiYuan). */
  readonly handle: DialogHandle;
  /** SiYuan retire le dialogue de l'écran SANS rappeler `destroyCallback` : ni onCancel ni onDestroyed. */
  vanish(): void;
}

/** Remplaçants injectables de `openMenu` / `openDialog` : ils enregistrent tout et se pilotent à la main. */
export function createNativeFakes() {
  const menus: OpenedMenu[] = [];
  const dialogs: OpenedDialog[] = [];
  const openMenu = vi.fn((items: readonly NativeMenuItem[], anchor: MenuAnchor, onClose?: () => void, id?: string): MenuHandle => {
    const menu: OpenedMenu = {
      items,
      anchor,
      onClose,
      id,
      closed: false,
      close() {
        if (menu.closed) return;
        menu.closed = true;
        onClose?.();
      },
    };
    menus.push(menu);
    return { close: () => menu.close() };
  });
  const openDialog = vi.fn((options: NativeDialogOptions): DialogHandle => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    options.build(container);
    let done = false;
    /** Destruction effective (le `destroyCallback` de SiYuan) : une fois ; onCancel sauf si confirmé. */
    const destroy = (confirmed: boolean): void => {
      if (done) return;
      done = true;
      container.remove();
      if (!confirmed) options.onCancel?.();
      options.onDestroyed?.();
    };
    const handle: DialogHandle = { close: () => destroy(false), isOpen: () => !done };
    dialogs.push({
      options,
      container,
      handle,
      confirm() {
        if (done) return false;
        const result = options.onConfirm();
        const closed = result !== false;
        if (closed) destroy(true);
        return closed;
      },
      cancel() {
        destroy(false);
      },
      vanish() {
        done = true;
        container.remove();
      },
    });
    return handle;
  });
  const lastMenu = (): OpenedMenu => {
    const menu = menus.at(-1);
    if (!menu) throw new Error("aucun menu ouvert");
    return menu;
  };
  const lastDialog = (): OpenedDialog => {
    const dialog = dialogs.at(-1);
    if (!dialog) throw new Error("aucun dialogue ouvert");
    return dialog;
  };
  return { openMenu, openDialog, menus, dialogs, lastMenu, lastDialog };
}

/** Élément d'un menu par chemin de libellés (sous-menus compris) ; lève s'il manque. */
export function findItem(items: readonly NativeMenuItem[], ...path: string[]): NativeMenuItem {
  let level = items;
  let found: NativeMenuItem | undefined;
  for (const label of path) {
    found = level.find((i) => i.label === label);
    if (!found) throw new Error(`élément de menu introuvable : ${path.join(" > ")}`);
    level = found.submenu ?? [];
  }
  if (!found) throw new Error("chemin vide");
  return found;
}

/**
 * Choisit un élément de menu comme SiYuan : appelle son `click` puis ferme le menu (donc `onClose`). Un élément sans `click`
 * (parent de sous-menu, élément désactivé) lève : SiYuan n'y attache aucun écouteur, le clic ne fait rien.
 */
export function pick(menu: OpenedMenu, ...path: string[]): void {
  const item = findItem(menu.items, ...path);
  if (!item.click) throw new Error(`élément sans action : ${path.join(" > ")}`);
  if (menu.closed) throw new Error("menu déjà fermé");
  item.click();
  menu.close();
}
