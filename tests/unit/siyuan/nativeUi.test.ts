// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Menu } from "siyuan";
import { openDialog, openMenu } from "../../../src/siyuan/nativeUi";
import type { NativeDialogOptions, NativeMenuItem } from "../../../src/ui/nativeUiTypes";

// Le stub (tests/stubs/siyuan.ts) enregistre instances, items et options ; `reset` est propre au stub.
const stubs = { Menu: Menu as unknown as { instances: StubMenu[]; reset(): void }, Dialog: Dialog as unknown as { instances: StubDialog[]; reset(): void } };
interface StubMenuItem {
  label?: string;
  type?: string;
  icon?: string;
  current?: boolean;
  disabled?: boolean;
  click?: (el: HTMLElement, e: MouseEvent) => unknown;
  submenu?: StubMenuItem[];
}
interface StubMenu {
  id?: string;
  items: StubMenuItem[];
  position?: { x: number; y: number; w?: number; h?: number };
  isOpen: boolean;
  opened: boolean;
  closeCount: number;
  itemsAtCloseCB?: number;
  element: HTMLElement;
  closeCB?: () => void;
}
interface StubDialog {
  options: { title?: string; content: string; width?: string; destroyCallback?: () => void };
  element: HTMLElement;
  destroyCount: number;
  destroyCalls: number;
  destroy(): void;
}
const lastMenu = (): StubMenu => stubs.Menu.instances.at(-1)!;
const lastDialog = (): StubDialog => stubs.Dialog.instances.at(-1)!;

beforeEach(() => {
  document.body.innerHTML = "";
  stubs.Menu.reset();
  stubs.Dialog.reset();
});
afterEach(() => vi.restoreAllMocks());

describe("openMenu : traduction vers IMenu", () => {
  it("ouvre un menu à la position donnée (x, y, w, h) et transmet la fermeture", () => {
    const onClose = vi.fn();
    openMenu([{ label: "A" }], { x: 10, y: 50, w: 30, h: 32 }, onClose);
    const menu = lastMenu();
    expect(stubs.Menu.instances).toHaveLength(1);
    expect(menu.opened).toBe(true);
    expect(menu.position).toEqual({ x: 10, y: 50, w: 30, h: 32 });
    menu.closeCB!();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("w et h absents ne sont pas transmis (pas de clé undefined)", () => {
    openMenu([{ label: "A" }], { x: 1, y: 2 });
    expect(lastMenu().position).toEqual({ x: 1, y: 2 });
    expect(Object.keys(lastMenu().position!)).toEqual(["x", "y"]);
  });

  it("libellé, icône, current, disabled : copiés tels quels (libellé échappé)", () => {
    openMenu([{ label: "Tous", icon: "iconFolder", current: true }, { label: "Gris", disabled: true }], { x: 0, y: 0 });
    expect(lastMenu().items).toEqual([
      { label: "Tous", icon: "iconFolder", current: true },
      { label: "Gris", disabled: true },
    ]);
  });

  it("current n'est posé que s'il est vrai ; disabled aussi", () => {
    openMenu([{ label: "A", current: false, disabled: false }], { x: 0, y: 0 });
    const item = lastMenu().items[0]!;
    expect(item.current).toBeUndefined();
    expect(item.disabled).toBeUndefined();
  });

  it("séparateur -> type « separator » sans libellé", () => {
    openMenu([{ label: "A" }, { separator: true }, { label: "B" }], { x: 0, y: 0 });
    expect(lastMenu().items.map((i) => i.type ?? i.label)).toEqual(["A", "separator", "B"]);
  });

  it("sous-menu -> type « submenu » avec ses éléments traduits récursivement (current compris)", () => {
    openMenu(
      [{ label: "Tri", submenu: [{ label: "Nom", current: true }, { separator: true }, { label: "Date" }] }],
      { x: 0, y: 0 },
    );
    const parent = lastMenu().items[0]!;
    expect(parent.type).toBe("submenu");
    expect(parent.label).toBe("Tri");
    expect(parent.submenu!.map((i) => i.type ?? i.label)).toEqual(["Nom", "separator", "Date"]);
    expect(parent.submenu![0]!.current).toBe(true);
  });

  it("click : appelé SANS argument (l'événement de SiYuan n'est pas transmis), le menu se ferme (valeur non vraie)", () => {
    const click = vi.fn();
    openMenu([{ label: "A", click }], { x: 0, y: 0 });
    const result = lastMenu().items[0]!.click!(document.createElement("button"), new MouseEvent("click"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("une erreur levée par click remonte (rien n'est avalé)", () => {
    openMenu([{ label: "A", click: () => { throw new Error("boom"); } }], { x: 0, y: 0 });
    expect(() => lastMenu().items[0]!.click!(document.createElement("button"), new MouseEvent("click"))).toThrow("boom");
  });

  it("élément sans click : l'élément de SiYuan n'a pas d'action propre (rien n'est appelé)", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    expect(() => lastMenu().items[0]!.click?.(document.createElement("button"), new MouseEvent("click"))).not.toThrow();
  });
});

describe("openMenu : échappement (SiYuan insère le libellé comme HTML)", () => {
  it("échappe & < > \" ' dans les libellés, y compris dans un sous-menu", () => {
    openMenu(
      [{ label: `<img src=x onerror=alert(1)> & "q" 'a'`, submenu: [{ label: "</b>" }] }],
      { x: 0, y: 0 },
    );
    const item = lastMenu().items[0]!;
    expect(item.label).toBe("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;a&#39;");
    expect(item.submenu![0]!.label).toBe("&lt;/b&gt;");
  });

  it("une fois interprété comme HTML, le libellé échappé redonne exactement le texte d'origine et aucune balise", () => {
    const raw = `Dossier <b>&amp; "x"`;
    openMenu([{ label: raw }], { x: 0, y: 0 });
    const holder = document.createElement("span");
    holder.innerHTML = lastMenu().items[0]!.label!; // reproduit l'insertion de SiYuan
    expect(holder.textContent).toBe(raw);
    expect(holder.children).toHaveLength(0);
  });

  it("n'altère pas les espaces insécables (indentation des dossiers) ni les accents", () => {
    openMenu([{ label: "  Éléphant" }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.label).toBe("  Éléphant");
  });

  it("une icône qui n'est pas un identifiant de sprite sûr est écartée", () => {
    openMenu([{ label: "A", icon: `iconX"><script>` }, { label: "B", icon: "iconFolder" }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.icon).toBeUndefined();
    expect(lastMenu().items[1]!.icon).toBe("iconFolder");
  });
});

describe("openMenu : clavier", () => {
  it("donne le focus à l'élément courant (classe b3-menu__item--current ajoutée), sinon au premier actif", () => {
    openMenu([{ label: "A", disabled: true }, { label: "B" }, { label: "C", current: true }], { x: 0, y: 0 });
    const buttons = Array.from(lastMenu().element.querySelectorAll<HTMLElement>(".b3-menu__item"));
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons[2]!.classList.contains("b3-menu__item--current")).toBe(true);
  });

  it("sans élément courant : le premier élément non désactivé", () => {
    openMenu([{ label: "A", disabled: true }, { label: "B" }], { x: 0, y: 0 });
    const buttons = Array.from(lastMenu().element.querySelectorAll<HTMLElement>(".b3-menu__item"));
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("un élément « current » d'un SOUS-MENU (masqué) n'est jamais pris pour le premier élément : le focus va au premier élément de premier niveau", () => {
    openMenu([{ label: "Tri", submenu: [{ label: "Nom", current: true }] }, { label: "B" }], { x: 0, y: 0 });
    const label = document.activeElement?.querySelector(":scope > .b3-menu__label")?.textContent;
    expect(label).toBe("Tri");
    expect(lastMenu().element.querySelectorAll(".b3-menu__item--current")).toHaveLength(1);
    expect(lastMenu().element.querySelector(".b3-menu__submenu .b3-menu__item--current")).toBeNull();
  });

  it("tous désactivés : aucun focus, aucune erreur", () => {
    expect(() => openMenu([{ label: "Historique vide", disabled: true }], { x: 0, y: 0 })).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("openDialog : squelette statique", () => {
  const options = (over: Partial<NativeDialogOptions> = {}): NativeDialogOptions => ({
    title: "Filtres",
    width: "420px",
    build: () => undefined,
    onConfirm: () => undefined,
    labels: { cancel: "Annuler", confirm: "Confirmer" },
    ...over,
  });

  it("le contenu est une chaîne STATIQUE : identique quels que soient le titre, les libellés et le contenu construit", () => {
    openDialog(options());
    const first = lastDialog().options.content;
    openDialog(options({ title: "Autre", labels: { cancel: "Non", confirm: "Oui" }, build: (c) => c.append("x") }));
    expect(lastDialog().options.content).toBe(first);
    for (const word of ["Filtres", "Autre", "Annuler", "Confirmer", "Non", "Oui"]) expect(first).not.toContain(word);
  });

  it("le squelette a la structure native : b3-dialog__content (conteneur vide), b3-dialog__action avec Annuler / fn__space / Confirmer", () => {
    openDialog(options());
    const el = lastDialog().element;
    const content = el.querySelector(".b3-dialog__content")!;
    expect(content).not.toBeNull();
    expect(content.querySelector(".docseeker-dialog-body")).not.toBeNull();
    const action = el.querySelector(".b3-dialog__action")!;
    expect(Array.from(action.children).map((c) => c.className)).toEqual([
      "b3-button b3-button--cancel",
      "fn__space",
      "b3-button b3-button--text",
    ]);
    expect(action.querySelector("button.b3-button--cancel")).not.toBeNull();
    expect(action.querySelector("button.b3-button--text")).not.toBeNull();
    expect(action.children[1]!.tagName).toBe("DIV");
  });

  it("les libellés sont posés en textContent (jamais interprétés), les boutons sont de vrais <button type=button>", () => {
    openDialog(options({ labels: { cancel: "<b>Non</b>", confirm: "A & B" } }));
    const el = lastDialog().element;
    const cancel = el.querySelector<HTMLButtonElement>("button.b3-button--cancel")!;
    const confirm = el.querySelector<HTMLButtonElement>("button.b3-button--text")!;
    expect(cancel.textContent).toBe("<b>Non</b>");
    expect(confirm.textContent).toBe("A & B");
    expect(cancel.children).toHaveLength(0);
    expect([cancel.type, confirm.type]).toEqual(["button", "button"]);
  });

  it("titre et largeur sont transmis à Dialog", () => {
    openDialog(options());
    expect(lastDialog().options.title).toBe("Filtres");
    expect(lastDialog().options.width).toBe("420px");
  });

  it("titre contenant < > & : ÉCHAPPÉ (SiYuan l'insère comme HTML), le dialogue s'ouvre quand même", () => {
    for (const title of ["<b>x</b>", "A & B", "a>b"]) {
      expect(() => openDialog(options({ title }))).not.toThrow();
      const dialog = lastDialog();
      expect(dialog.options.title).not.toMatch(/[<>]/);
      const header = dialog.element.querySelector(".b3-dialog__header")!;
      expect(header.textContent).toBe(title); // une fois interprété comme HTML, le texte d'origine exact
      expect(header.children).toHaveLength(0); // et aucune balise
    }
    expect(stubs.Dialog.instances).toHaveLength(3);
  });

  it("largeur hors format « 123px » : refusée", () => {
    for (const width of ['420px;"onload=1', "50%", "px", "420"]) {
      expect(() => openDialog(options({ width }))).toThrow(TypeError);
    }
    expect(stubs.Dialog.instances).toHaveLength(0);
  });

  it("sans largeur : aucune clé width transmise", () => {
    const { width: _w, ...rest } = options();
    openDialog(rest as NativeDialogOptions);
    expect("width" in lastDialog().options).toBe(false);
  });

  it("build reçoit le conteneur vide, dans le dialogue, une seule fois", () => {
    const build = vi.fn((c: HTMLElement) => {
      expect(c.childElementCount).toBe(0);
      expect(lastDialog().element.contains(c)).toBe(true);
      expect(c.classList.contains("docseeker-dialog-body")).toBe(true);
      c.appendChild(document.createElement("input"));
    });
    openDialog(options({ build }));
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("le focus va au premier champ construit", () => {
    openDialog(options({ build: (c) => { c.append(document.createElement("input"), document.createElement("input")); } }));
    expect(document.activeElement).toBe(lastDialog().element.querySelector("input"));
  });

  it("build qui lève : le dialogue est détruit et l'erreur remonte", () => {
    expect(() => openDialog(options({ build: () => { throw new Error("build KO"); } }))).toThrow("build KO");
    expect(lastDialog().destroyCount).toBe(1);
  });
});

describe("openDialog : actions", () => {
  const make = (over: Partial<NativeDialogOptions> = {}) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    openDialog({
      title: "Filtres",
      build: (c) => { c.appendChild(document.createElement("input")); },
      onConfirm,
      onCancel,
      labels: { cancel: "Annuler", confirm: "Confirmer" },
      ...over,
    });
    const el = lastDialog().element;
    return {
      onConfirm, onCancel,
      cancel: el.querySelector<HTMLButtonElement>("button.b3-button--cancel")!,
      confirm: el.querySelector<HTMLButtonElement>("button.b3-button--text")!,
      input: el.querySelector<HTMLInputElement>("input")!,
    };
  };

  it("Annuler : ferme une fois, appelle onCancel une fois, jamais onConfirm", () => {
    const a = make();
    a.cancel.click();
    expect(lastDialog().destroyCount).toBe(1);
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(a.onConfirm).not.toHaveBeenCalled();
  });

  it("Confirmer : onConfirm, puis fermeture SANS onCancel", () => {
    const a = make();
    a.confirm.click();
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    expect(lastDialog().destroyCount).toBe(1);
    expect(a.onCancel).not.toHaveBeenCalled();
  });

  it("Confirmer avec onConfirm() === false : le dialogue reste ouvert, ni onCancel ni fermeture", () => {
    const a = make({ onConfirm: () => false });
    a.confirm.click();
    expect(lastDialog().destroyCount).toBe(0);
    expect(a.onCancel).not.toHaveBeenCalled();
    expect(lastDialog().element.isConnected).toBe(true);
  });

  it("onConfirm qui lève : le dialogue reste ouvert et l'erreur est signalée à la fenêtre (pas d'avalement)", () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      const a = make({ onConfirm: () => { throw new Error("KO"); } });
      a.confirm.click();
      expect(lastDialog().destroyCount).toBe(0);
      expect(a.onCancel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors.map((e) => (e as Error).message)).toEqual(["KO"]);
  });

  it("fermeture par SiYuan (Échap global, clic sur le voile) : destroy() -> onCancel une fois", () => {
    const a = make();
    lastDialog().destroy();
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(a.onConfirm).not.toHaveBeenCalled();
  });

  it("Échap dans le dialogue : annule et consomme la touche", () => {
    const a = make();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    a.input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(lastDialog().destroyCount).toBe(1);
    expect(a.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Entrée dans un champ : confirme (comme le bouton)", () => {
    const a = make();
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    a.input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    expect(lastDialog().destroyCount).toBe(1);
  });

  it("Entrée sur un bouton, avec Maj, ou pendant une composition IME : ne confirme pas", () => {
    const a = make({ build: (c) => { c.append(document.createElement("input"), Object.assign(document.createElement("button"), { type: "button" })); } });
    const el = lastDialog().element;
    el.querySelector(".docseeker-dialog-body button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    a.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    a.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(a.onConfirm).not.toHaveBeenCalled();
  });

  it("une fois fermé, un second clic sur Confirmer ou Annuler est sans effet (jamais deux destroy)", () => {
    const a = make();
    a.confirm.click();
    a.confirm.click();
    a.cancel.click();
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    expect(a.onCancel).not.toHaveBeenCalled();
    expect(lastDialog().destroyCalls).toBe(1);
  });

  it("aucune donnée hostile n'atteint innerHTML sous forme de balise (espion sur le setter, sans analyse de pile)", () => {
    const written: string[] = [];
    const proto = Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "innerHTML")!;
    Object.defineProperty(proto, "innerHTML", {
      configurable: true,
      get: original.get!,
      set(this: Element, v: string) {
        written.push(v);
        original.set!.call(this, v);
      },
    });
    try {
      make({ title: "<img src=x onerror=1> & T", build: (c) => { c.textContent = "<b>x</b>"; } });
      openMenu([{ label: "<b>hostile</b> & <img src=x onerror=1>", submenu: [{ label: "<i>sub</i>" }] }], { x: 0, y: 0 });
    } finally {
      Object.defineProperty(proto, "innerHTML", original);
    }
    expect(written.length).toBeGreaterThan(0); // l'espion voit bien les écritures du stub (qui imite SiYuan)
    for (const html of written) {
      expect(html).not.toMatch(/<b>hostile|<img src=x|<i>sub|<b>x<\/b>/);
    }
    expect(written.some((html) => html.includes("&lt;b&gt;hostile&lt;/b&gt;"))).toBe(true);
  });

  it("le code de src n'écrit jamais innerHTML / outerHTML / insertAdjacentHTML (balayage des sources)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith(".ts")) {
          const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
          if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(code)) offenders.push(path);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

describe("fidélité du faux Menu (garde-fou : il se ferme comme celui de SiYuan 3.8.9)", () => {
  const outside = (): HTMLElement => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    return el;
  };

  it("un clic hors du menu qui atteint window le ferme et appelle onClose", () => {
    const onClose = vi.fn();
    openMenu([{ label: "A" }], { x: 0, y: 0 }, onClose);
    outside().click();
    expect(lastMenu().opened).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un clic dans le menu ne le ferme pas par le gestionnaire global ; un clic sur un item appelle click puis ferme", () => {
    const click = vi.fn();
    openMenu([{ label: "A", click }], { x: 0, y: 0 });
    lastMenu().element.click();
    expect(lastMenu().opened).toBe(true);
    lastMenu().element.querySelector<HTMLElement>(".b3-menu__item")!.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(lastMenu().opened).toBe(false);
  });

  it("un clic dans un ancêtre [data-menu=\"true\"] ne le ferme pas (exclusion du gestionnaire global)", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    const opener = outside();
    opener.setAttribute("data-menu", "true");
    opener.click();
    expect(lastMenu().opened).toBe(true);
  });

  it("le bug réel : ouvrir un menu dans un clic qui remonte jusqu'à window le ferme aussitôt", () => {
    const btn = outside();
    btn.addEventListener("click", () => openMenu([{ label: "A" }], { x: 0, y: 0 }));
    btn.click();
    expect(lastMenu().opened).toBe(false);
  });

  it("avec stopPropagation dans le clic d'ouverture, le menu reste ouvert", () => {
    const btn = outside();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu([{ label: "A" }], { x: 0, y: 0 });
    });
    btn.click();
    expect(lastMenu().opened).toBe(true);
  });
});

describe("openMenu : identifiant (bascule et remplacement, comme le constructeur de Menu de SiYuan)", () => {
  it("l'identifiant par défaut est « docseeker » ; un identifiant précisé est transmis", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    expect(lastMenu().id).toBe("docseeker");
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    expect(lastMenu().id).toBe("docseeker-more");
  });

  it("un identifiant qui n'est pas [a-z0-9-] est refusé (TypeError), aucun menu créé", () => {
    for (const id of ['x"y', "a b", "", "<b>"]) {
      expect(() => openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, id)).toThrow(TypeError);
    }
    expect(stubs.Menu.instances).toHaveLength(0);
  });

  it("même identifiant déjà ouvert : le second appel referme (bascule) au lieu de rouvrir", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    const first = lastMenu();
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    expect(first.opened).toBe(false);
    expect(lastMenu().opened).toBe(false);
  });

  it("identifiant différent : le nouveau menu remplace l'ancien et s'ouvre", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    const first = lastMenu();
    openMenu([{ label: "B" }], { x: 0, y: 0 }, undefined, "docseeker-path");
    expect(first.opened).toBe(false);
    expect(lastMenu().opened).toBe(true);
  });
});

describe("openDialog : destruction différée de SiYuan (destroyCallback arrive après un délai)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubs.Dialog.reset();
    (Dialog as unknown as { destroyDelayMs: number | undefined }).destroyDelayMs = 50;
  });
  afterEach(() => {
    vi.useRealTimers();
    (Dialog as unknown as { destroyDelayMs: number | undefined }).destroyDelayMs = undefined;
  });
  const make = () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    openDialog({ title: "T", build: () => undefined, onConfirm, onCancel, labels: { cancel: "Annuler", confirm: "Confirmer" } });
    const el = lastDialog().element;
    return { onConfirm, onCancel, cancel: el.querySelector<HTMLButtonElement>("button.b3-button--cancel")!, confirm: el.querySelector<HTMLButtonElement>("button.b3-button--text")! };
  };

  it("deux clics rapides sur Confirmer avant la fin de la destruction : onConfirm une seule fois", () => {
    const a = make();
    a.confirm.click();
    a.confirm.click();
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    expect(a.onCancel).not.toHaveBeenCalled();
  });

  it("Annuler puis Confirmer avant la fin : Confirmer est ignoré, onCancel une fois (à la fin)", () => {
    const a = make();
    a.cancel.click();
    a.confirm.click();
    vi.advanceTimersByTime(60);
    expect(a.onConfirm).not.toHaveBeenCalled();
    expect(a.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Échap puis Entrée avant la fin : un seul destroy effectif, pas de confirmation", () => {
    const a = make();
    lastDialog().element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    lastDialog().element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    vi.advanceTimersByTime(60);
    expect(a.onConfirm).not.toHaveBeenCalled();
    expect(lastDialog().destroyCount).toBe(1);
    expect(a.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("openMenu : sous-menus (SiYuan n'attache d'écouteur de clic qu'aux items qui ont un `click`)", () => {
  it("un parent de sous-menu n'a PAS de click : un clic dessus ne ferme pas le menu (lu dans le bundle 3.8.9)", () => {
    openMenu([{ label: "Tri", submenu: [{ label: "Nom", click: vi.fn() }] }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.click).toBeUndefined();
    const parent = lastMenu().element.querySelector<HTMLElement>(".b3-menu__item")!;
    parent.click();
    expect(lastMenu().opened).toBe(true);
  });

  it("un élément du sous-menu appelle son click puis ferme tout le menu", () => {
    const click = vi.fn();
    openMenu([{ label: "Tri", submenu: [{ label: "Nom", click }] }], { x: 0, y: 0 });
    const child = lastMenu().element.querySelector<HTMLElement>(".b3-menu__submenu .b3-menu__item")!;
    child.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(lastMenu().opened).toBe(false);
  });
});

describe("openMenu : libellés sans caractères de format ni de contrôle (usurpation d'affichage)", () => {
  it.each([
    ["bidi LRE..RLO (U+202A-202E)", "a‪b‫c‬d‭e‮f", "abcdef"],
    ["isolats bidi (U+2066-2069)", "a⁦b⁧c⁨d⁩e", "abcde"],
    ["espaces de largeur nulle (U+200B-200D), U+2060 et U+FEFF", "a​b‌c‍d⁠e﻿f", "abcdef"],
  ])("%s : retirés", (_name, raw, expected) => {
    openMenu([{ label: raw, submenu: [{ label: raw }] }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.label).toBe(expected);
    expect(lastMenu().items[0]!.submenu![0]!.label).toBe(expected);
  });

  it("caractères de contrôle (\\p{Cc} : retour ligne, tabulation, NUL, BEL, DEL) : remplacés par une espace", () => {
    openMenu([{ label: "a\nb\tc\u0000d\u0007e\u007Ff" }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.label).toBe("a b c d e f");
  });

  it("l'espace insécable de l'indentation, les accents et les emojis simples sont conservés", () => {
    openMenu([{ label: "  Éléphant 😀" }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.label).toBe("  Éléphant 😀");
  });

  it("le nettoyage précède l'échappement (un caractère de format ne peut pas casser « &lt; »)", () => {
    openMenu([{ label: "<​b>" }], { x: 0, y: 0 });
    expect(lastMenu().items[0]!.label).toBe("&lt;b&gt;");
  });
});

describe("openMenu : handle et focus (le closeCB de SiYuan passe AVANT le vidage du menu : le focus tombait sur BODY)", () => {
  const opener = (): HTMLButtonElement => {
    const b = document.createElement("button");
    document.body.appendChild(b);
    b.focus();
    return b;
  };
  const escape = (): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  };

  it("renvoie un handle : close() ferme le menu et appelle onClose une fois ; un second close() est sans effet", () => {
    const onClose = vi.fn();
    const handle = openMenu([{ label: "A" }], { x: 0, y: 0 }, onClose);
    expect(lastMenu().opened).toBe(true);
    handle.close();
    expect(lastMenu().opened).toBe(false);
    handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("le handle d'un menu déjà REMPLACÉ ne ferme pas le menu qui l'a remplacé", () => {
    const first = openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    openMenu([{ label: "B" }], { x: 0, y: 0 }, undefined, "docseeker-path");
    const second = lastMenu();
    first.close();
    expect(second.opened).toBe(true);
  });

  it("le handle d'un menu refermé par bascule (même identifiant) est inerte", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    const toggled = openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    openMenu([{ label: "B" }], { x: 0, y: 0 }, undefined, "docseeker-path");
    toggled.close();
    expect(lastMenu().opened).toBe(true);
  });

  it("choisir un item sans toucher au focus : le focus revient à l'élément qui avait le focus à l'ouverture", () => {
    const btn = opener();
    openMenu([{ label: "A", click: vi.fn() }, { label: "B" }], { x: 0, y: 0 });
    expect(document.activeElement).not.toBe(btn); // le premier item a pris le focus
    lastMenu().element.querySelector<HTMLElement>(".b3-menu__item")!.click();
    expect(lastMenu().opened).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("Échap : fermeture et focus rendu à l'élément ouvrant", () => {
    const btn = opener();
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    escape();
    expect(lastMenu().opened).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("clic ailleurs dans la page : le focus revient à l'élément ouvrant", () => {
    const btn = opener();
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    document.body.click();
    expect(document.activeElement).toBe(btn);
  });

  it("close() du handle : le focus revient aussi", () => {
    const btn = opener();
    const handle = openMenu([{ label: "A" }], { x: 0, y: 0 });
    handle.close();
    expect(document.activeElement).toBe(btn);
  });

  it("fermeture par bascule (même identifiant) : le focus revient à l'élément ouvrant du premier menu", () => {
    const btn = opener();
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    expect(document.activeElement).toBe(btn);
  });

  it("un focus volontairement placé ailleurs par le click n'est PAS volé", () => {
    const btn = opener();
    const field = document.createElement("input");
    document.body.appendChild(field);
    openMenu([{ label: "A", click: () => field.focus() }], { x: 0, y: 0 });
    lastMenu().element.querySelector<HTMLElement>(".b3-menu__item")!.click();
    expect(document.activeElement).toBe(field);
    expect(document.activeElement).not.toBe(btn);
  });

  it("l'élément ouvrant a été retiré du DOM entre-temps : aucun focus tenté, aucune erreur", () => {
    const btn = opener();
    const handle = openMenu([{ label: "A" }], { x: 0, y: 0 });
    btn.remove();
    const focus = vi.spyOn(btn, "focus");
    expect(() => handle.close()).not.toThrow(); // appel direct : une erreur dans un écouteur ne remonterait pas ici
    expect(focus).not.toHaveBeenCalled();
  });

  it("rien n'avait le focus à l'ouverture (BODY) : le focus n'est pas forcé sur un élément arbitraire", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    escape();
    expect(document.activeElement).toBe(document.body);
  });

  it("onClose est appelé AVANT que le focus soit rendu mais le focus est rendu même si onClose lève (l'erreur remonte)", () => {
    const btn = opener();
    const handle = openMenu([{ label: "A" }], { x: 0, y: 0 }, () => { throw new Error("onClose KO"); });
    expect(() => handle.close()).toThrow("onClose KO");
    expect(document.activeElement).toBe(btn);
  });

  it("onClose observe le DOM comme SiYuan : les items existent encore à ce moment", () => {
    opener();
    let itemsDuringClose = -1;
    openMenu([{ label: "A" }, { label: "B" }], { x: 0, y: 0 }, () => {
      itemsDuringClose = lastMenu().element.querySelectorAll(".b3-menu__item").length;
    });
    escape();
    expect(itemsDuringClose).toBe(2);
  });
});

describe("openDialog : handle, destroyCallback réel et onDestroyed", () => {
  const options = (over: Partial<NativeDialogOptions> = {}): NativeDialogOptions => ({
    title: "T",
    build: () => undefined,
    onConfirm: () => undefined,
    labels: { cancel: "Annuler", confirm: "Confirmer" },
    ...over,
  });
  const delay = (ms: number | undefined): void => {
    (Dialog as unknown as { destroyDelayMs: number | undefined }).destroyDelayMs = ms;
  };

  it("renvoie un handle : isOpen() vrai à l'ouverture ; close() détruit une fois et déclenche onCancel puis onDestroyed", () => {
    const calls: string[] = [];
    const handle = openDialog(options({ onCancel: () => calls.push("cancel"), onDestroyed: () => calls.push("destroyed") }));
    expect(handle.isOpen()).toBe(true);
    handle.close();
    handle.close();
    expect(lastDialog().destroyCalls).toBe(1);
    expect(handle.isOpen()).toBe(false);
    expect(calls).toEqual(["cancel", "destroyed"]);
  });

  it("Confirmer : onDestroyed est appelé après la destruction, SANS onCancel", () => {
    const calls: string[] = [];
    openDialog(options({ onConfirm: () => { calls.push("confirm"); }, onCancel: () => calls.push("cancel"), onDestroyed: () => calls.push("destroyed") }));
    lastDialog().element.querySelector<HTMLButtonElement>("button.b3-button--text")!.click();
    expect(calls).toEqual(["confirm", "destroyed"]);
  });

  it("destruction différée : isOpen() reste VRAI pendant le délai (réouverture impossible), onDestroyed arrive à la fin", () => {
    vi.useFakeTimers();
    try {
      delay(50);
      const onDestroyed = vi.fn();
      const handle = openDialog(options({ onDestroyed }));
      lastDialog().element.querySelector<HTMLButtonElement>("button.b3-button--cancel")!.click();
      expect(handle.isOpen()).toBe(true);
      expect(onDestroyed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(handle.isOpen()).toBe(false);
      expect(onDestroyed).toHaveBeenCalledTimes(1);
    } finally {
      delay(undefined);
      vi.useRealTimers();
    }
  });

  it("SiYuan retire le dialogue SANS destroyCallback : isOpen() devient faux (jamais bloqué à vrai)", () => {
    const handle = openDialog(options());
    lastDialog().element.remove();
    expect(handle.isOpen()).toBe(false);
  });

  it("onDestroyed qui lève : l'erreur remonte (non avalée)", () => {
    openDialog(options({ onDestroyed: () => { throw new Error("KO destroyed"); } }));
    expect(() => lastDialog().destroy()).toThrow("KO destroyed");
  });
});

describe("fidélité du faux Menu : ce que le stub garantit à tous les tests (bundle 3.8.9)", () => {
  it("closeCB est appelé AVANT le vidage ; l'élément singleton reste dans le DOM, masqué (fn__none), sans items", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    openMenu([{ label: "A" }, { label: "B" }], { x: 0, y: 0 });
    const element = lastMenu().element;
    expect(element.classList.contains("fn__none")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(lastMenu().itemsAtCloseCB).toBe(2);
    expect(element.isConnected).toBe(true);
    expect(element.classList.contains("fn__none")).toBe(true);
    expect(element.querySelectorAll(".b3-menu__item")).toHaveLength(0);
  });

  it("l'élément est réutilisé d'un menu à l'autre (singleton)", () => {
    openMenu([{ label: "A" }], { x: 0, y: 0 }, undefined, "docseeker-more");
    const first = lastMenu().element;
    openMenu([{ label: "B" }], { x: 0, y: 0 }, undefined, "docseeker-path");
    expect(lastMenu().element).toBe(first);
    expect(document.querySelectorAll(".b3-menu")).toHaveLength(1);
  });

  it("les libellés sont insérés en innerHTML : l'entité « &amp; » donne « & » dans le texte", () => {
    openMenu([{ label: "A & B" }], { x: 0, y: 0 });
    expect(lastMenu().element.querySelector(".b3-menu__label")!.textContent).toBe("A & B");
  });

  it("Bas / Haut déplacent b3-menu__item--current sans déplacer le focus ; Entrée active l'item courant et ferme", () => {
    const first = vi.fn();
    const second = vi.fn();
    openMenu([{ label: "A", click: first }, { label: "B", click: second }, { label: "C", disabled: true }], { x: 0, y: 0 });
    const items = [...lastMenu().element.querySelectorAll<HTMLElement>(".b3-menu__item")];
    const key = (k: string): void => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    };
    items[0]!.classList.add("b3-menu__item--current");
    key("ArrowDown");
    expect(items.map((i) => i.classList.contains("b3-menu__item--current"))).toEqual([false, true, false]);
    key("ArrowDown"); // C est désactivé : retour à A
    expect(items[0]!.classList.contains("b3-menu__item--current")).toBe(true);
    key("ArrowUp");
    expect(items[1]!.classList.contains("b3-menu__item--current")).toBe(true);
    key("Enter");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(lastMenu().opened).toBe(false);
  });

  it("Entrée sur un parent de sous-menu ouvre le sous-menu (rien n'est appelé, le menu reste ouvert) ; Entrée choisit ensuite", () => {
    const click = vi.fn();
    openMenu([{ label: "Tri", submenu: [{ label: "Nom", click }] }], { x: 0, y: 0 });
    const key = (k: string): void => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    };
    key("ArrowDown");
    key("Enter");
    expect(lastMenu().opened).toBe(true);
    expect(lastMenu().element.querySelector(".b3-menu__item--show")).not.toBeNull();
    key("Enter");
    expect(click).toHaveBeenCalledTimes(1);
    expect(lastMenu().opened).toBe(false);
  });

  it("pointerdown tactile (touch/pen) hors du menu le ferme ; la souris non ; un ancêtre [data-menu] non (comme le bundle)", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const fire = (target: Element, pointerType: string): void => {
      const e = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(e, "pointerType", { value: pointerType });
      target.dispatchEvent(e);
    };
    openMenu([{ label: "A" }], { x: 0, y: 0 });
    fire(outside, "mouse");
    expect(lastMenu().opened).toBe(true);
    fire(lastMenu().element, "touch");
    expect(lastMenu().opened).toBe(true);
    outside.setAttribute("data-menu", "true");
    fire(outside, "touch");
    expect(lastMenu().opened).toBe(true);
    outside.removeAttribute("data-menu");
    fire(outside, "pen");
    expect(lastMenu().opened).toBe(false);
  });

  it("le clavier est débranché à la fermeture (aucun écouteur ne reste sur window)", () => {
    const click = vi.fn();
    openMenu([{ label: "A", click }], { x: 0, y: 0 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(click).not.toHaveBeenCalled();
  });
});

// Vérifie que NativeMenuItem reste utilisable en lecture seule.
const _typecheck: readonly NativeMenuItem[] = [{ label: "x" }];
void _typecheck;
