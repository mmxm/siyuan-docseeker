// @vitest-environment jsdom
// Adaptateur de la fenêtre flottante (openFloatingDialog) contre le faux Dialog de SiYuan (tests/stubs/siyuan.ts), qui reproduit
// la destruction DIFFÉRÉE, la pile `window.siyuan.dialogs`, le z-index croissant et le gestionnaire Échap global du bundle 3.8.9.
import { readFileSync } from "node:fs";
import { Dialog } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFloatingDialog } from "../../../src/siyuan/nativeUi";

interface StubDialog {
  options: { title?: string; content: string; width?: string; height?: string; positionId?: string; hideCloseIcon?: boolean; disableClose?: boolean };
  element: HTMLElement;
  destroyCount: number;
  destroyCalls: number;
  lastDestroyOptions: Record<string, unknown> | undefined;
}
const stub = Dialog as unknown as { instances: StubDialog[]; stack: StubDialog[]; reset(): void; destroyDelayMs: number | undefined };
const last = (): StubDialog => stub.instances.at(-1)!;
const escape = (target: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.innerHTML = "";
  stub.reset();
});
afterEach(() => {
  stub.reset();
  vi.useRealTimers();
});

describe("openFloatingDialog : création", () => {
  it("crée UN dialogue 80vw x 90vh avec la clé de position native, sans croix masquée ni verrou de fermeture", () => {
    openFloatingDialog({ title: "Recherche dans les PDF", build: () => undefined });
    expect(stub.instances).toHaveLength(1);
    expect(last().options.width).toBe("80vw");
    expect(last().options.height).toBe("90vh");
    expect(last().options.positionId).toBe("docseeker-search");
    expect(last().options.hideCloseIcon).not.toBe(true);
    expect(last().options.disableClose).not.toBe(true);
  });

  it("le contenu est un conteneur div statique vide : ni pied Annuler/Confirmer ni bouton", () => {
    let seen: HTMLElement | undefined;
    let childrenAtBuild = -1;
    openFloatingDialog({
      title: "T",
      build: (container) => {
        seen = container;
        childrenAtBuild = container.childNodes.length;
      },
    });
    expect(seen?.tagName).toBe("DIV");
    expect(childrenAtBuild).toBe(0);
    expect(last().element.contains(seen!)).toBe(true);
    expect(last().element.querySelector(".b3-dialog__action")).toBeNull();
    expect(last().element.querySelector("button.b3-button--cancel, button.b3-button--text")).toBeNull();
    expect(last().element.querySelectorAll("button")).toHaveLength(0);
  });

  it("le titre est du texte brut échappé : aucune balise ni gestionnaire n'est inséré", () => {
    openFloatingDialog({ title: '<img src=x onerror="alert(1)"> & "q"', build: () => undefined });
    const header = last().element.querySelector(".b3-dialog__header")!;
    expect(header.querySelector("img")).toBeNull();
    expect(header.textContent).toBe('<img src=x onerror="alert(1)"> & "q"');
  });

  it("build qui lève : le dialogue est détruit, l'erreur est relancée et onDestroyed est appelé une fois", () => {
    const onDestroyed = vi.fn();
    expect(() =>
      openFloatingDialog({
        title: "T",
        build: () => {
          throw new Error("montage KO");
        },
        onDestroyed,
      }),
    ).toThrow("montage KO");
    expect(last().destroyCount).toBe(1);
    expect(stub.stack).toHaveLength(0);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });
});

describe("openFloatingDialog : fermeture", () => {
  it("close() détruit via SiYuan ; onDestroyed reçoit focus: true", () => {
    const onDestroyed = vi.fn();
    const handle = openFloatingDialog({ title: "T", build: () => undefined, onDestroyed });
    expect(handle.isOpen()).toBe(true);
    handle.close();
    expect(last().destroyCount).toBe(1);
    expect(last().lastDestroyOptions).toBeUndefined(); // aucun argument à destroy() : SiYuan rendra le focus
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(onDestroyed).toHaveBeenCalledWith({ focus: true });
    expect(handle.isOpen()).toBe(false);
  });

  it("close({ focus: false }) demande à SiYuan de ne pas rendre le focus (destroy({ focus: \"false\" })) ; onDestroyed reçoit focus: false", () => {
    const onDestroyed = vi.fn();
    const handle = openFloatingDialog({ title: "T", build: () => undefined, onDestroyed });
    handle.close({ focus: false });
    expect(last().lastDestroyOptions).toEqual({ focus: "false" }); // c'est le destroyCallback de SiYuan qui reçoit cette option
    expect(onDestroyed).toHaveBeenCalledWith({ focus: false });
  });

  it("destruction DIFFÉRÉE : isOpen reste vrai jusqu'au destroyCallback, les close() suivants sont ignorés, onDestroyed une seule fois", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 200;
    const onDestroyed = vi.fn();
    const handle = openFloatingDialog({ title: "T", build: () => undefined, onDestroyed });
    handle.close();
    handle.close();
    handle.close({ focus: false });
    expect(handle.isOpen()).toBe(true);
    expect(onDestroyed).not.toHaveBeenCalled();
    expect(last().destroyCount).toBe(1);
    vi.advanceTimersByTime(200);
    expect(handle.isOpen()).toBe(false);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(onDestroyed).toHaveBeenCalledWith({ focus: true }); // le premier close() décide
    handle.close();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("Échap global de SiYuan (focus dans la fenêtre) : détruite UNE fois, onDestroyed({ focus: true })", () => {
    const onDestroyed = vi.fn();
    const handle = openFloatingDialog({ title: "T", build: (c) => c.append(document.createElement("input")), onDestroyed });
    last().element.querySelector("input")!.focus();
    escape(document.activeElement!);
    expect(last().destroyCount).toBe(1);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("clic sur le voile et destroy({ focus: \"false\" }) de SiYuan : onDestroyed({ focus: false })", () => {
    const onDestroyed = vi.fn();
    openFloatingDialog({ title: "T", build: () => undefined, onDestroyed });
    (last() as unknown as { destroy(o: Record<string, unknown>): void }).destroy({ focus: "false" });
    expect(onDestroyed).toHaveBeenCalledWith({ focus: false });
  });

  it("élément retiré du document sans destroyCallback : isOpen est faux (pas de fenêtre fantôme)", () => {
    const handle = openFloatingDialog({ title: "T", build: () => undefined });
    last().element.remove();
    expect(handle.isOpen()).toBe(false);
  });
});

describe("openFloatingDialog : début de destruction (onClosing)", () => {
  const siyuanDestroy = (o?: Record<string, unknown>): void => (stub.stack[0] as unknown as { destroy(o?: Record<string, unknown>): void }).destroy(o);

  it("destroy() lancé par SiYuan (Échap global, voile, croix) : onClosing est appelé tout de suite, AVANT le délai et onDestroyed", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 200;
    const order: string[] = [];
    const onClosing = vi.fn(() => order.push("closing"));
    const onDestroyed = vi.fn(() => order.push("destroyed"));
    openFloatingDialog({ title: "T", build: () => undefined, onClosing, onDestroyed });
    siyuanDestroy();
    expect(onClosing).toHaveBeenCalledTimes(1);
    expect(onClosing).toHaveBeenCalledWith({ focus: true });
    expect(onDestroyed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(order).toEqual(["closing", "destroyed"]);
  });

  it("destroy({ focus: \"false\" }) lancé par SiYuan : onClosing({ focus: false })", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 200;
    const onClosing = vi.fn();
    openFloatingDialog({ title: "T", build: () => undefined, onClosing });
    siyuanDestroy({ focus: "false" });
    expect(onClosing).toHaveBeenCalledWith({ focus: false });
  });

  it("close() de l'adaptateur : onClosing UNE seule fois (pas de doublon), et les destroy() suivants de SiYuan ne le rappellent pas", () => {
    vi.useFakeTimers();
    stub.destroyDelayMs = 200;
    const onClosing = vi.fn();
    const handle = openFloatingDialog({ title: "T", build: () => undefined, onClosing });
    handle.close({ focus: false });
    siyuanDestroy();
    handle.close();
    expect(onClosing).toHaveBeenCalledTimes(1);
    expect(onClosing).toHaveBeenCalledWith({ focus: false });
  });

  it("l'instance de SiYuan reçoit toujours les arguments d'origine (destroy enveloppé, pas remplacé)", () => {
    openFloatingDialog({ title: "T", build: () => undefined });
    siyuanDestroy({ focus: "false" });
    expect(last().lastDestroyOptions).toEqual({ focus: "false" });
    expect(last().destroyCount).toBe(1);
  });

  it("un onClosing qui lève ne bloque pas la destruction", () => {
    const onDestroyed = vi.fn();
    openFloatingDialog({
      title: "T",
      build: () => undefined,
      onClosing: () => {
        throw new Error("closing KO");
      },
      onDestroyed,
    });
    expect(() => siyuanDestroy()).toThrow("closing KO"); // l'erreur remonte à l'appelant (pas d'avalement), mais...
    expect(last().destroyCount).toBe(1); // ...le dialogue est bien détruit
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("build qui lève : onClosing est appelé une fois", () => {
    const onClosing = vi.fn();
    expect(() =>
      openFloatingDialog({
        title: "T",
        build: () => {
          throw new Error("montage KO");
        },
        onClosing,
      }),
    ).toThrow("montage KO");
    expect(onClosing).toHaveBeenCalledTimes(1);
  });
});

describe("openFloatingDialog : lien entre le squelette et la feuille de style", () => {
  it("le conteneur fourni à build porte la classe que la feuille de style cible (docseeker-floating-body)", () => {
    let seen: HTMLElement | undefined;
    openFloatingDialog({ title: "T", build: (c) => void (seen = c) });
    expect(seen?.classList.contains("docseeker-floating-body")).toBe(true);
    expect(seen?.parentElement?.classList.contains("b3-dialog__body")).toBe(true);
    const css = readFileSync("src/ui/searchStyles.ts", "utf8");
    expect(css).toContain(".docseeker-floating-body {");
  });
});

describe("openFloatingDialog : empilement avec un dialogue ou un menu ouvert par-dessus", () => {
  it("un second dialogue (Filtres) passe au-dessus : Échap ferme le dernier d'abord, puis la fenêtre de recherche", async () => {
    const { openDialog } = await import("../../../src/siyuan/nativeUi");
    const onDestroyed = vi.fn();
    openFloatingDialog({ title: "Recherche", build: () => undefined, onDestroyed });
    const filters = openDialog({ title: "Filtres", labels: { cancel: "Annuler", confirm: "OK" }, build: () => undefined, onConfirm: () => true });
    const z = (d: StubDialog): number => Number((d.element.querySelector(".b3-dialog") as HTMLElement).style.zIndex);
    expect(z(stub.instances[1]!)).toBeGreaterThan(z(stub.instances[0]!));
    escape(stub.instances[1]!.element);
    expect(filters.isOpen()).toBe(false);
    expect(onDestroyed).not.toHaveBeenCalled(); // la fenêtre de recherche reste ouverte
    escape(stub.instances[0]!.element);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });
});
