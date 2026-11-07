// Stub résolu à la place du paquet `siyuan` (types seulement) ; les tests le remplacent via vi.mock.
export class Plugin {
  /** Enregistre les commandes (comme `addCommand` de SiYuan) pour que les tests puissent les relire. */
  readonly commands: { langKey: string; langText?: string; hotkey?: string; callback?: () => void }[] = [];
  addCommand(command: { langKey: string; langText?: string; hotkey?: string; callback?: () => void }): void {
    this.commands.push(command);
  }
}
/** Comme le vrai `openTab` : renvoie une promesse (de l'onglet). */
export const openTab = (): Promise<unknown> => Promise.resolve(undefined);
export const showMessage = (): void => undefined;
export const confirm = (_title: string, _text: string, onConfirm?: () => void): void => onConfirm?.();
/** Enregistre ses items ; `open()` appelle `createActionElement` de chacun (comme SiYuan à l'ouverture, d'après les types). */
export class Setting {
  readonly items: { title: string; createActionElement?: () => HTMLElement; actionElement?: HTMLElement }[] = [];
  constructor(public readonly options: { destroyCallback?: () => void } = {}) {}
  addItem(item: { title: string; createActionElement?: () => HTMLElement; actionElement?: HTMLElement }): void {
    this.items.push(item);
  }
  open(_name: string): void {
    for (const item of this.items) item.createActionElement?.();
  }
}

/** Élément DOM du stub : absent dans l'environnement `node` (les tests qui n'ont pas de DOM n'en ont pas besoin). */
const hasDom = (): boolean => typeof document !== "undefined";

export interface StubMenuItem {
  label?: string;
  type?: string;
  icon?: string;
  current?: boolean;
  disabled?: boolean;
  click?: (element: HTMLElement, event: MouseEvent) => boolean | void | Promise<boolean | void>;
  submenu?: StubMenuItem[];
}

const CURRENT = "b3-menu__item--current";
const SHOW = "b3-menu__item--show";

/**
 * Enregistre ses items et sa position, et imite le `Menu` de SiYuan 3.8.9 (lu dans main.c73ef160...js) :
 * - un seul élément DOM (singleton `.b3-menu`), réutilisé par tous les menus : jamais retiré du DOM, masqué par `fn__none`
 *   à la fermeture ; `removeImmediately` appelle `closeCB` AU TOUT DÉBUT, PUIS vide `.b3-menu__items` (le focus tombe alors
 *   sur BODY) ;
 * - un seul menu à la fois (le constructeur ferme le précédent) ; même identifiant déjà ouvert = bascule (`isOpen` vrai,
 *   `open()` ne fait rien, et ce menu n'enregistre pas son `closeCB`) ;
 * - libellés insérés en `innerHTML` (comme SiYuan) ; un item n'a d'écouteur de clic que s'il a un `click` (un parent de
 *   sous-menu sans `click` ne ferme donc rien) ; un clic d'item appelle `click`, arrête la propagation et ferme (sauf si
 *   `click` renvoie vrai) ; les sous-menus sont rendus dans l'item parent (classe `b3-menu__item--show` au survol) ;
 * - fermeture : `click` qui atteint `window` (bulle) hors du menu et hors `[data-menu="true"]`, et `pointerdown` en
 *   capture (touch/pen seulement, comme le bundle) ;
 * - clavier (écouteur `keydown` sur window, comme `re()` du bundle) : Bas/Haut déplacent `b3-menu__item--current` SANS
 *   déplacer le focus, Droite/Entrée ouvrent un sous-menu, Entrée sur un item envoie un évènement `click` (CustomEvent) puis
 *   ferme, Échap ferme.
 */
export class Menu {
  static instances: Menu[] = [];
  static current: Menu | undefined;
  /** Élément unique réutilisé (`window.siyuan.menus.menu.element`). */
  static singleton: HTMLElement | undefined;
  static reset(): void {
    Menu.current?.close();
    Menu.singleton?.remove();
    Menu.singleton = undefined;
    Menu.instances = [];
    Menu.current = undefined;
  }
  private static ensureElement(): HTMLElement {
    let el = Menu.singleton;
    if (!el) {
      el = document.createElement("div");
      el.className = "b3-menu fn__none";
      const title = document.createElement("div");
      title.className = "b3-menu__title fn__none";
      const items = document.createElement("div");
      items.className = "b3-menu__items";
      el.append(title, items);
      Menu.singleton = el;
    }
    if (!el.isConnected) document.body.appendChild(el);
    return el;
  }
  readonly items: StubMenuItem[] = [];
  position: { x: number; y: number; w?: number; h?: number; isLeft?: boolean } | undefined;
  /** Vrai si un menu de même identifiant était déjà ouvert à la construction (bascule : `open` ne fait alors rien). */
  isOpen = false;
  /** Vrai entre `open` et `close`. */
  opened = false;
  closeCount = 0;
  /** Nombre d'items encore présents dans le DOM au moment où `closeCB` a été appelé (SiYuan : ils existent encore). */
  itemsAtCloseCB: number | undefined;
  element!: HTMLElement;
  private readonly onWindowClick = (e: Event): void => {
    const target = e.target as Element | null;
    if (this.element?.contains(target)) return;
    if (target?.closest?.('[data-menu="true"]')) return;
    this.close();
  };
  private readonly onPointerDown = (e: Event): void => {
    const type = (e as PointerEvent).pointerType;
    if (type !== "touch" && type !== "pen") return;
    this.onWindowClick(e);
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.opened || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const root = this.element;
    const current = root.querySelector<HTMLElement>(`.${CURRENT}`);
    const siblings = (el: HTMLElement): HTMLElement[] =>
      [...(el.parentElement?.children ?? [])].filter((c): c is HTMLElement => c.classList.contains("b3-menu__item") && !c.hasAttribute("disabled"));
    const openSub = (item: HTMLElement): boolean => {
      const sub = item.querySelector<HTMLElement>(":scope > .b3-menu__submenu");
      if (!sub) return false;
      item.classList.remove(CURRENT);
      item.classList.add(SHOW);
      sub.querySelector<HTMLElement>(".b3-menu__item:not([disabled])")?.classList.add(CURRENT);
      return true;
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      const list = current ? siblings(current) : [...root.querySelectorAll<HTMLElement>(":scope > .b3-menu__items > .b3-menu__item:not([disabled])")];
      if (list.length === 0) return;
      const at = current ? list.indexOf(current) : down ? -1 : 0;
      const next = list[(at + (down ? 1 : -1) + list.length) % list.length]!;
      current?.classList.remove(CURRENT, SHOW);
      next.classList.add(CURRENT);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (current) openSub(current);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const inner = root.querySelector<HTMLElement>(`.b3-menu__submenu .${CURRENT}`);
      const parent = inner?.closest<HTMLElement>(`.${SHOW}`);
      if (inner && parent) {
        parent.classList.remove(SHOW);
        parent.classList.add(CURRENT);
        inner.classList.remove(CURRENT);
      }
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      if (openSub(current)) return;
      current.dispatchEvent(new CustomEvent("click"));
      if (this.element.contains(current)) this.close();
    }
  };
  constructor(public readonly id?: string, public readonly closeCB?: () => void) {
    const previous = Menu.current;
    this.isOpen = previous !== undefined && previous.opened && previous.id === id;
    previous?.close();
    this.registered = !this.isOpen;
    Menu.instances.push(this);
  }
  private readonly registered: boolean;
  addItem(option: StubMenuItem): HTMLElement {
    this.items.push(option);
    return undefined as unknown as HTMLElement;
  }
  addSeparator(): HTMLElement {
    this.items.push({ type: "separator" });
    return undefined as unknown as HTMLElement;
  }
  /** Comme `new I(item, menu)` du bundle : libellé en innerHTML, écouteur de clic seulement si `click`, sous-menu rendu. */
  private renderItem(item: StubMenuItem): HTMLElement {
    const b = document.createElement("button");
    if (item.disabled) b.setAttribute("disabled", "disabled");
    if (item.type === "separator") {
      b.classList.add("b3-menu__separator");
      return b;
    }
    b.classList.add("b3-menu__item");
    if (item.current) b.classList.add("b3-menu__item--selected");
    if (item.click) {
      b.addEventListener("click", (e) => {
        if (b.getAttribute("disabled")) return;
        let result = item.click!(b, e as MouseEvent);
        if (result instanceof Promise) result = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (b.parentElement && !result) this.close();
      });
    }
    b.innerHTML = `<svg class="b3-menu__icon"><use xlink:href="#${item.icon ?? ""}"></use></svg><span class="b3-menu__label">${item.label || "&nbsp;"}</span>`;
    if (item.submenu) {
      const sub = document.createElement("div");
      sub.className = "b3-menu__submenu";
      const inner = document.createElement("div");
      inner.className = "b3-menu__items";
      for (const child of item.submenu) inner.append(this.renderItem(child));
      sub.append(inner);
      b.append(sub);
      b.addEventListener("mouseenter", () => b.classList.add(SHOW));
    }
    return b;
  }
  open(position: { x: number; y: number; w?: number; h?: number; isLeft?: boolean }): void {
    if (this.isOpen) return;
    this.position = position;
    this.opened = true;
    Menu.current = this;
    if (!hasDom()) return;
    this.element = Menu.ensureElement();
    const list = this.element.lastElementChild as HTMLElement;
    list.innerHTML = "";
    for (const item of this.items) list.append(this.renderItem(item));
    this.element.classList.remove("fn__none");
    window.addEventListener("click", this.onWindowClick);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown);
  }
  /**
   * Comme `close() { this.menu.remove() }` du bundle : ferme le menu actuellement ouvert, QUEL QU'EN SOIT le propriétaire
   * (l'élément est un singleton) ; sans effet s'il n'y en a aucun.
   */
  close(): void {
    Menu.current?.removeImmediately();
  }
  private removeImmediately(): void {
    if (!this.opened) return;
    this.opened = false;
    this.closeCount += 1;
    if (Menu.current === this) Menu.current = undefined;
    if (hasDom()) {
      window.removeEventListener("click", this.onWindowClick);
      document.removeEventListener("pointerdown", this.onPointerDown, true);
      window.removeEventListener("keydown", this.onKeyDown);
    }
    // SiYuan (removeImmediately) : `removeCB` d'abord, tant que les items existent encore ; ensuite seulement on vide.
    this.itemsAtCloseCB = this.element?.querySelectorAll(".b3-menu__item").length;
    if (this.registered) this.closeCB?.();
    if (this.element) {
      (this.element.lastElementChild as HTMLElement).innerHTML = "";
      this.element.classList.add("fn__none");
    }
  }
}

export interface StubDialogOptions {
  title?: string;
  content: string;
  width?: string;
  destroyCallback?: () => void;
}

/** Enregistre ses options ; l'élément reproduit le squelette de SiYuan (le contenu est inséré comme HTML). */
export class Dialog {
  static instances: Dialog[] = [];
  static reset(): void {
    for (const d of Dialog.instances) d.element?.remove();
    Dialog.instances = [];
    Dialog.destroyDelayMs = undefined;
  }
  /** Délai (ms) avant `destroyCallback`, comme le setTimeout de SiYuan ; `undefined` : synchrone (par défaut dans les tests). */
  static destroyDelayMs: number | undefined = undefined;
  element!: HTMLElement;
  /** Nombre d'appels à `destroy()` qui ont réellement détruit (SiYuan ignore les suivants : `this.destroying`). */
  destroyCount = 0;
  destroyCalls = 0;
  private destroying = false;
  constructor(public readonly options: StubDialogOptions) {
    Dialog.instances.push(this);
    if (!hasDom()) return;
    this.element = document.createElement("div");
    this.element.innerHTML = `<div class="b3-dialog__container"><div class="b3-dialog__header">${options.title ?? ""}</div><div class="b3-dialog__body">${options.content}</div></div>`;
    document.body.appendChild(this.element);
  }
  destroy(): void {
    this.destroyCalls += 1;
    if (this.destroying) return;
    this.destroying = true;
    this.destroyCount += 1;
    const finish = (): void => {
      this.element?.remove();
      this.options.destroyCallback?.();
    };
    if (Dialog.destroyDelayMs === undefined) finish();
    else setTimeout(finish, Dialog.destroyDelayMs);
  }
}
