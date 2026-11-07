// @vitest-environment jsdom
// Dialogues d'entrée et de confirmation : structure et comportement de `openInputDialog` et `confirmDialog` de SiYuan 3.8.9
// (app/src/dialog/inputDialog.ts et confirmDialog.ts), sur le faux `Dialog` fidèle de tests/stubs/siyuan.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Menu } from "siyuan";
import { openConfirmDialog, openInputDialog } from "../../../src/siyuan/nativeUi";
import type { ConfirmDialogOptions, InputDialogOptions } from "../../../src/ui/nativeUiTypes";

interface StubDialog {
  options: { title?: string; content: string; width?: string; destroyCallback?: () => void };
  element: HTMLElement;
  destroyCount: number;
}
const stub = Dialog as unknown as { instances: StubDialog[]; reset(): void; destroyDelayMs: number | undefined };
const last = (): StubDialog => stub.instances.at(-1)!;
const HOSTILE = "<img src=x onerror=alert(1)>";

beforeEach(() => {
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  stub.reset();
});
afterEach(() => vi.restoreAllMocks());

function inputOptions(over: Partial<InputDialogOptions> = {}): InputDialogOptions {
  return {
    title: "Enregistrer les critères de requête",
    value: "Ma requête",
    placeholder: "Remarques",
    dataKey: "dialog-savecriterion",
    labels: { cancel: "Annuler", confirm: "Confirmer" },
    onConfirm: vi.fn(),
    ...over,
  };
}
const field = (): HTMLInputElement => last().element.querySelector<HTMLInputElement>("[data-dialog-input]")!;
const button = (selector: string): HTMLButtonElement => last().element.querySelector<HTMLButtonElement>(selector)!;

describe("openInputDialog : structure native", () => {
  it("largeur 520px par défaut, data-key, titre en texte", () => {
    openInputDialog(inputOptions());
    expect(last().options.width).toBe("520px");
    expect(last().element.getAttribute("data-key")).toBe("dialog-savecriterion");
    expect(last().element.querySelector(".b3-dialog__header")!.textContent).toBe("Enregistrer les critères de requête");
  });

  it(".b3-dialog__content > input.b3-text-field.fn__block[data-dialog-input] est le seul enfant du contenu", () => {
    openInputDialog(inputOptions());
    const content = last().element.querySelector(".b3-dialog__content")!;
    expect(content.children).toHaveLength(1);
    const input = content.firstElementChild as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.className).toBe("b3-text-field fn__block");
    expect(input.hasAttribute("data-dialog-input")).toBe(true);
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.placeholder).toBe("Remarques");
  });

  it("pied : Annuler (b3-button--cancel), espace, Confirmer (b3-button--text), dans cet ordre", () => {
    openInputDialog(inputOptions());
    const action = last().element.querySelector(".b3-dialog__action")!;
    expect([...action.children].map((c) => c.className)).toEqual(["b3-button b3-button--cancel", "fn__space", "b3-button b3-button--text"]);
    expect(action.children[0]!.textContent).toBe("Annuler");
    expect(action.children[2]!.textContent).toBe("Confirmer");
    expect(action.children[0]!.hasAttribute("data-input-cancel")).toBe(true);
    expect(action.children[2]!.hasAttribute("data-input-confirm")).toBe(true);
  });

  it("valeur initiale posée, texte sélectionné, champ focalisé", () => {
    openInputDialog(inputOptions());
    expect(field().value).toBe("Ma requête");
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("Ma requête".length);
    expect(document.activeElement).toBe(field());
  });

  it("valeur initiale vide : champ vide focalisé", () => {
    openInputDialog(inputOptions({ value: "" }));
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
  });

  it("titre, valeur et placeholder hostiles restent du texte (aucun nœud créé)", () => {
    openInputDialog(inputOptions({ title: HOSTILE, value: HOSTILE, placeholder: HOSTILE }));
    expect(last().element.querySelector("img")).toBeNull();
    expect(last().element.querySelector(".b3-dialog__header")!.textContent).toBe(HOSTILE);
    expect(field().value).toBe(HOSTILE);
    expect(field().placeholder).toBe(HOSTILE);
  });

  it.each(["50%", "520", "99999px", "520px;x"])("refuse la largeur « %s »", (width) => {
    expect(() => openInputDialog(inputOptions({ width }))).toThrow(/Largeur de dialogue refusée/);
    expect(stub.instances).toHaveLength(0);
  });

  it.each(['"><x', "Dialog Key", "", "a_b"])("refuse la clé data-key « %s »", (dataKey) => {
    expect(() => openInputDialog(inputOptions({ dataKey }))).toThrow(/Clé de dialogue refusée/);
    expect(stub.instances).toHaveLength(0);
  });
});

describe("openInputDialog : comportement", () => {
  it("Confirmer : focus rendu au champ, onConfirm reçoit la valeur courante non rognée, le dialogue reste ouvert", () => {
    const onConfirm = vi.fn();
    const handle = openInputDialog(inputOptions({ onConfirm }));
    field().value = "  autre  ";
    (document.body as HTMLElement).focus();
    button("[data-input-confirm]").click();
    expect(onConfirm).toHaveBeenCalledWith("  autre  ");
    expect(document.activeElement).toBe(field());
    expect(handle.isOpen()).toBe(true);
  });

  it("Entrée dans le champ confirme ; Entrée pendant une composition (IME) ne fait rien", () => {
    const onConfirm = vi.fn();
    openInputDialog(inputOptions({ onConfirm }));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Annuler détruit le dialogue sans appeler onConfirm ; onDestroyed une seule fois", () => {
    const onConfirm = vi.fn();
    const onDestroyed = vi.fn();
    const handle = openInputDialog(inputOptions({ onConfirm, onDestroyed }));
    button("[data-input-cancel]").click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
    handle.close();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("close() détruit ; Échap global (dialogue détruit par SiYuan) appelle aussi onDestroyed", () => {
    const onDestroyed = vi.fn();
    const handle = openInputDialog(inputOptions({ onDestroyed }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("isOpen reste vrai pendant la destruction différée de SiYuan, close() n'est alors pas rejoué", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 190;
    const onDestroyed = vi.fn();
    const handle = openInputDialog(inputOptions({ onDestroyed }));
    handle.close();
    handle.close();
    expect(last().destroyCount).toBe(1);
    expect(handle.isOpen()).toBe(true);
    vi.advanceTimersByTime(190);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
    vi.useRealTimers();
  });
});

function confirmOptions(over: Partial<ConfirmDialogOptions> = {}): ConfirmDialogOptions {
  return { title: "Confirmer", text: "Le nom de la requête est dupliqué, voulez-vous l'écraser ?", labels: { cancel: "Annuler", confirm: "Confirmer" }, onConfirm: vi.fn(), ...over };
}

describe("openConfirmDialog : structure native", () => {
  it("520px, data-key dialog-confirm, titre", () => {
    openConfirmDialog(confirmOptions());
    expect(last().options.width).toBe("520px");
    expect(last().element.getAttribute("data-key")).toBe("dialog-confirm");
    expect(last().element.querySelector(".b3-dialog__header")!.textContent).toBe("Confirmer");
  });

  it("contenu : .b3-dialog__content > .ft__breakword avec le texte", () => {
    openConfirmDialog(confirmOptions());
    const content = last().element.querySelector(".b3-dialog__content")!;
    expect(content.children).toHaveLength(1);
    expect(content.firstElementChild!.className).toBe("ft__breakword");
    expect(content.firstElementChild!.textContent).toBe("Le nom de la requête est dupliqué, voulez-vous l'écraser ?");
  });

  it("pied : cancelDialogConfirmBtn, espace, confirmDialogConfirmBtn (b3-button--text), confirmation focalisée", () => {
    openConfirmDialog(confirmOptions());
    const action = last().element.querySelector(".b3-dialog__action")!;
    expect([...action.children].map((c) => c.className)).toEqual(["b3-button b3-button--cancel", "fn__space", "b3-button b3-button--text"]);
    expect(action.children[0]!.id).toBe("cancelDialogConfirmBtn");
    expect(action.children[2]!.id).toBe("confirmDialogConfirmBtn");
    expect(document.activeElement).toBe(action.children[2]);
  });

  it("texte hostile : posé en texte, aucun nœud créé", () => {
    openConfirmDialog(confirmOptions({ text: `Mettre à jour le nom ${HOSTILE} en ${HOSTILE} ?`, title: HOSTILE }));
    expect(last().element.querySelector("img")).toBeNull();
    expect(last().element.querySelector(".ft__breakword")!.textContent).toBe(`Mettre à jour le nom ${HOSTILE} en ${HOSTILE} ?`);
    expect(last().element.querySelector(".b3-dialog__header")!.textContent).toBe(HOSTILE);
  });
});

describe("openConfirmDialog : comportement", () => {
  it("Confirmer : onConfirm puis destruction ; onCancel jamais", () => {
    const calls: string[] = [];
    const handle = openConfirmDialog(confirmOptions({ onConfirm: () => calls.push("confirm"), onCancel: () => calls.push("cancel"), onDestroyed: () => calls.push("destroyed") }));
    button("#confirmDialogConfirmBtn").click();
    expect(calls).toEqual(["confirm", "destroyed"]);
    expect(handle.isOpen()).toBe(false);
  });

  it("Annuler : onCancel puis destruction ; onConfirm jamais", () => {
    const onConfirm = vi.fn();
    const calls: string[] = [];
    openConfirmDialog(confirmOptions({ onConfirm, onCancel: () => calls.push("cancel"), onDestroyed: () => calls.push("destroyed") }));
    button("#cancelDialogConfirmBtn").click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["cancel", "destroyed"]);
  });

  it("fermeture par SiYuan (Échap global, voile) : annulation, une seule fois", () => {
    const onCancel = vi.fn();
    openConfirmDialog(confirmOptions({ onCancel }));
    (last().element.querySelector(".b3-dialog__scrim") as HTMLElement).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("évènements de clavier de SiYuan (clic avec detail « Enter » / « Escape » sur le dialogue)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    openConfirmDialog(confirmOptions({ onConfirm, onCancel }));
    last().element.dispatchEvent(new CustomEvent("click", { detail: "Enter" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    openConfirmDialog(confirmOptions({ onConfirm, onCancel }));
    last().element.dispatchEvent(new CustomEvent("click", { detail: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("onConfirm qui lève : le dialogue est tout de même détruit et l'erreur est tracée (console par défaut)", () => {
    const boom = new Error("boum");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = openConfirmDialog(confirmOptions({ onConfirm: () => { throw boom; } }));
    button("#confirmDialogConfirmBtn").click();
    expect(handle.isOpen()).toBe(false);
    expect(spy.mock.calls.some((c) => c.includes(boom))).toBe(true);
  });

  it("le focus revient à l'élément qui l'avait à l'ouverture", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    openConfirmDialog(confirmOptions());
    expect(document.activeElement).not.toBe(opener);
    button("#cancelDialogConfirmBtn").click();
    expect(document.activeElement).toBe(opener);
  });
});

describe("onConfirm qui lève (H) : tracé, jamais propagé à l'écouteur DOM", () => {
  it("openInputDialog : onError reçoit l'erreur, le dialogue reste ouvert", () => {
    const boom = new Error("onConfirm en échec");
    const onError = vi.fn();
    const handle = openInputDialog(inputOptions({ onConfirm: () => { throw boom; }, onError }));
    expect(() => button("[data-input-confirm]").click()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(handle.isOpen()).toBe(true);
  });

  it("openInputDialog : sans onError, la console reçoit l'erreur (jamais d'erreur avalée)", () => {
    const boom = new Error("onConfirm en échec");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openInputDialog(inputOptions({ onConfirm: () => { throw boom; } }));
    button("[data-input-confirm]").click();
    expect(spy.mock.calls.some((c) => c.includes(boom))).toBe(true);
  });

  it("openConfirmDialog : onError reçoit l'erreur et le dialogue est quand même fermé", () => {
    const boom = new Error("onConfirm en échec");
    const onError = vi.fn();
    const handle = openConfirmDialog(confirmOptions({ onConfirm: () => { throw boom; }, onError }));
    expect(() => button("#confirmDialogConfirmBtn").click()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(handle.isOpen()).toBe(false);
  });

  it("openConfirmDialog : sans onError, la console reçoit l'erreur", () => {
    const boom = new Error("onConfirm en échec");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openConfirmDialog(confirmOptions({ onConfirm: () => { throw boom; } }));
    button("#confirmDialogConfirmBtn").click();
    expect(spy.mock.calls.some((c) => c.includes(boom))).toBe(true);
  });

  it("close() dont la destruction lève : le drapeau est réarmé, un nouvel essai détruit le dialogue", () => {
    const destroy = vi.spyOn(Dialog.prototype, "destroy").mockImplementationOnce(() => {
      throw new Error("destroy en échec");
    });
    const input = openInputDialog(inputOptions());
    expect(() => input.close()).toThrow("destroy en échec");
    input.close();
    expect(input.isOpen()).toBe(false);
    const confirm = openConfirmDialog(confirmOptions());
    destroy.mockImplementationOnce(() => {
      throw new Error("destroy en échec");
    });
    expect(() => confirm.close()).toThrow("destroy en échec");
    confirm.close();
    expect(confirm.isOpen()).toBe(false);
  });
});
