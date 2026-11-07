// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Menu } from "siyuan";
import { openCustomDialog } from "../../../src/siyuan/nativeUi";
import type { CustomDialogOptions } from "../../../src/ui/nativeUiTypes";

interface StubDialog {
  options: { title?: string; content: string; width?: string; height?: string; destroyCallback?: () => void };
  element: HTMLElement;
  destroyCount: number;
  destroyCalls: number;
  destroy(): void;
}
const stub = Dialog as unknown as { instances: StubDialog[]; stack: StubDialog[]; reset(): void; destroyDelayMs: number | undefined };
const lastDialog = (): StubDialog => stub.instances.at(-1)!;

function options(over: Partial<CustomDialogOptions> = {}): CustomDialogOptions {
  const content = document.createDocumentFragment();
  const a = document.createElement("div");
  a.className = "first";
  const b = document.createElement("div");
  b.className = "second";
  content.append(a, b);
  return { title: "Spécifier le chemin", width: "50vw", height: "70vh", dataKey: "dialog-movepathto", content, ...over };
}

beforeEach(() => {
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  stub.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openCustomDialog : structure", () => {
  it("transmet largeur et hauteur, sans contenu HTML : le DOM fourni est inséré dans le corps, dans l'ordre", () => {
    openCustomDialog(options());
    const dialog = lastDialog();
    expect(dialog.options.width).toBe("50vw");
    expect(dialog.options.height).toBe("70vh");
    expect(dialog.options.content).toBe("");
    const body = dialog.element.querySelector(".b3-dialog__body")!;
    expect([...body.children].map((c) => c.className)).toEqual(["first", "second"]);
  });

  it("pose data-key sur la racine et un en-tête sans marge intérieure", () => {
    openCustomDialog(options());
    const dialog = lastDialog();
    expect(dialog.element.getAttribute("data-key")).toBe("dialog-movepathto");
    expect(dialog.element.querySelector<HTMLElement>(".b3-dialog__header")!.style.padding).toBe("0px");
  });

  it("le titre reprend le gabarit natif (padding 8px + ligne d'indice vide)", () => {
    openCustomDialog(options());
    const header = lastDialog().element.querySelector(".b3-dialog__header")!;
    const outer = header.firstElementChild as HTMLElement;
    expect(outer.getAttribute("style")).toBe("padding:8px");
    expect(outer.firstChild?.textContent).toBe("Spécifier le chemin");
    const hint = outer.firstElementChild as HTMLElement;
    expect(hint.className).toBe("ft__smaller ft__on-surface fn__hidescrollbar");
    expect(hint.getAttribute("style")).toBe("max-height:16px;line-height:14px");
    expect(hint.textContent).toBe("");
  });

  it("le titre est du texte : balises échappées, caractères de format retirés", () => {
    openCustomDialog(options({ title: '<img src=x onerror=alert(1)>‮' }));
    const header = lastDialog().element.querySelector(".b3-dialog__header")!;
    expect(header.querySelector("img")).toBeNull();
    expect((header.firstElementChild as HTMLElement).firstChild?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it.each(["50%", "50", "vw", "99999px", "50vw;x", "calc(1px)"])("refuse la largeur « %s »", (width) => {
    expect(() => openCustomDialog(options({ width }))).toThrow(/Largeur de dialogue refusée/);
    expect(stub.instances).toHaveLength(0);
  });

  it.each(["70", "70em", "70vh\"", ""])("refuse la hauteur « %s »", (height) => {
    expect(() => openCustomDialog(options({ height }))).toThrow(/Hauteur de dialogue refusée/);
  });

  it.each(['"><x', "Dialog Key", "", "a_b"])("refuse la clé data-key « %s »", (dataKey) => {
    expect(() => openCustomDialog(options({ dataKey }))).toThrow(/Clé de dialogue refusée/);
  });
});

describe("openCustomDialog : cycle de vie", () => {
  it("isOpen tant que le dialogue est à l'écran ; close le détruit une seule fois", () => {
    const onDestroyed = vi.fn();
    const handle = openCustomDialog(options({ onDestroyed }));
    expect(handle.isOpen()).toBe(true);
    handle.close();
    handle.close();
    expect(lastDialog().destroyCount).toBe(1);
    expect(lastDialog().destroyCalls).toBe(1);
    expect(handle.isOpen()).toBe(false);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("destruction différée (~190 ms) : toujours ouvert pendant le délai, onDestroyed une fois à la fin", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 190;
    const onDestroyed = vi.fn();
    const handle = openCustomDialog(options({ onDestroyed }));
    handle.close();
    expect(handle.isOpen()).toBe(true);
    expect(onDestroyed).not.toHaveBeenCalled();
    handle.close(); // deuxième close pendant le délai : sans effet
    vi.advanceTimersByTime(190);
    expect(handle.isOpen()).toBe(false);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(lastDialog().destroyCalls).toBe(1);
  });

  it("destruction par SiYuan (voile) : onDestroyed est appelé une fois, le handle se ferme", () => {
    const onDestroyed = vi.fn();
    const handle = openCustomDialog(options({ onDestroyed }));
    lastDialog().element.querySelector<HTMLElement>(".b3-dialog__scrim")!.click();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("Échap n'est pas consommé : le gestionnaire global de SiYuan détruit le dialogue", () => {
    const onDestroyed = vi.fn();
    const handle = openCustomDialog(options({ onDestroyed }));
    const input = document.createElement("input");
    lastDialog().element.querySelector(".b3-dialog__body")!.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(handle.isOpen()).toBe(false);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("le dialogue retiré de l'écran sans rappel n'est plus ouvert", () => {
    const handle = openCustomDialog(options());
    lastDialog().element.remove();
    expect(handle.isOpen()).toBe(false);
  });

  it("un onDestroyed qui lève ne casse pas la destruction et l'erreur remonte", () => {
    const handle = openCustomDialog(options({ onDestroyed: () => { throw new Error("boom"); } }));
    expect(() => handle.close()).toThrow("boom");
    expect(handle.isOpen()).toBe(false);
  });

  it("le focus revient à l'élément qui ouvrait", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const handle = openCustomDialog(options());
    expect(document.activeElement).not.toBe(opener);
    handle.close();
    expect(document.activeElement).toBe(opener);
  });
});

describe("openCustomDialog : close() qui lève (H)", () => {
  it("le drapeau « fermeture en cours » est réarmé : un nouvel essai détruit le dialogue", () => {
    vi.spyOn(Dialog.prototype, "destroy").mockImplementationOnce(() => {
      throw new Error("destroy en échec");
    });
    const handle = openCustomDialog(options());
    expect(() => handle.close()).toThrow("destroy en échec");
    handle.close();
    expect(handle.isOpen()).toBe(false);
  });
});
