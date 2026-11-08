// @vitest-environment jsdom
// E4b : plein écran mobile de openFloatingDialog : classe de zone sûre, suivi du clavier (visualViewport), barre basse « Fermer ».
import { Dialog } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFloatingDialog } from "../../../src/siyuan/nativeUi";

interface StubDialog { element: HTMLElement }
const stub = Dialog as unknown as { instances: StubDialog[]; reset(): void };
const last = (): StubDialog => stub.instances.at(-1)!;
const container = (): HTMLElement => last().element.querySelector<HTMLElement>(".b3-dialog__container")!;

class FakeViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
}
let vv: FakeViewport;
const listeners = new Map<string, number>();

beforeEach(() => {
  document.body.innerHTML = "";
  stub.reset();
  vv = new FakeViewport();
  listeners.clear();
  const add = vv.addEventListener.bind(vv);
  const remove = vv.removeEventListener.bind(vv);
  vv.addEventListener = (type: string, cb: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions): void => {
    listeners.set(type, (listeners.get(type) ?? 0) + 1);
    add(type, cb, o);
  };
  vv.removeEventListener = (type: string, cb: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions): void => {
    listeners.set(type, (listeners.get(type) ?? 0) - 1);
    remove(type, cb, o);
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
});
afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
  vi.useRealTimers();
});

describe("plein écran : zone sûre et clavier", () => {
  it("le conteneur porte la classe docseeker-fullscreen et la hauteur visible, suivie au clavier", () => {
    openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect(container().classList.contains("docseeker-fullscreen")).toBe(true);
    expect(container().style.getPropertyValue("--docseeker-vvh")).toBe("700px");
    vv.height = 380;
    vv.dispatchEvent(new Event("resize"));
    expect(container().style.getPropertyValue("--docseeker-vvh")).toBe("380px");
  });

  it("E4b : aucune hauteur ni maxHeight en ligne (sinon ils l'emportent sur la feuille et --docseeker-vvh serait sans effet)", () => {
    openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect(container().style.height).toBe("");
    expect(container().style.maxHeight).toBe("");
    expect(container().style.maxWidth).toBe("100vw");
  });

  it("E4b : offsetTop du viewport est suivi dans --docseeker-vv-top", () => {
    vv.offsetTop = 40;
    openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect(container().style.getPropertyValue("--docseeker-vv-top")).toBe("40px");
  });

  it("E4b : la feuille de style est injectée même si la vue ne l'a pas fait (elle porte maintenant la hauteur)", () => {
    document.getElementById("docseeker-search-style")?.remove();
    openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect(document.getElementById("docseeker-search-style")).not.toBeNull();
  });

  it("destruction directe (croix, Échap, voile) : suivi arrêté UNE fois ; close() puis destroy() ne retire rien deux fois", () => {
    const handle = openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    const dialog = stub.instances.at(-1) as unknown as { destroy(o?: Record<string, unknown>): void };
    dialog.destroy(); // comme la croix native
    expect([listeners.get("resize"), listeners.get("scroll")]).toEqual([0, 0]);
    handle.close();
    dialog.destroy();
    expect([listeners.get("resize"), listeners.get("scroll")]).toEqual([0, 0]);
  });

  it("close() puis un second destroy direct : le décompte des abonnements reste à zéro", () => {
    const handle = openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    handle.close();
    (stub.instances.at(-1) as unknown as { destroy(): void }).destroy();
    expect([listeners.get("resize"), listeners.get("scroll")]).toEqual([0, 0]);
  });

  it("fenêtre secondaire : le viewport est celui de ownerDocument.defaultView, pas de window", () => {
    const other = new FakeViewport();
    other.height = 321;
    const win = { visualViewport: other, innerHeight: 321 } as unknown as Window;
    const original = Object.getOwnPropertyDescriptor(document, "defaultView");
    Object.defineProperty(document, "defaultView", { configurable: true, value: win });
    try {
      openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    } finally {
      if (original) Object.defineProperty(document, "defaultView", original);
      else Reflect.deleteProperty(document, "defaultView");
    }
    expect(container().style.getPropertyValue("--docseeker-vvh")).toBe("321px");
  });

  it("la fermeture désabonne resize et scroll (close, croix ou Échap passent tous par destroy)", () => {
    const handle = openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect([listeners.get("resize"), listeners.get("scroll")]).toEqual([1, 1]);
    handle.close();
    expect([listeners.get("resize"), listeners.get("scroll")]).toEqual([0, 0]);
  });

  it("un build qui lève ne laisse aucun abonnement", () => {
    expect(() =>
      openFloatingDialog({ title: "T", layout: "fullscreen", build: () => { throw new Error("KO"); } }),
    ).toThrow("KO");
    expect([listeners.get("resize") ?? 0, listeners.get("scroll") ?? 0]).toEqual([0, 0]);
  });

  it("la disposition fenêtre (bureau) n'a ni classe, ni variable, ni abonnement", () => {
    openFloatingDialog({ title: "T", closeLabel: "Fermer", build: () => undefined });
    expect(container().classList.contains("docseeker-fullscreen")).toBe(false);
    expect(container().style.getPropertyValue("--docseeker-vvh")).toBe("");
    expect(listeners.size).toBe(0);
  });
});

describe("plein écran : barre basse « Fermer »", () => {
  it("avec closeLabel : un bouton après la vue, dans le corps, et le corps passe en colonne", () => {
    let body: HTMLElement | undefined;
    openFloatingDialog({ title: "T", layout: "fullscreen", closeLabel: "Fermer", build: (c) => { body = c; c.append(document.createElement("section")); } });
    expect(body!.classList.contains("docseeker-floating-body--fullscreen")).toBe(true);
    const bar = body!.lastElementChild as HTMLElement;
    expect(bar.className).toBe("docseeker-floating-bar");
    const button = bar.querySelector<HTMLButtonElement>("button.docseeker-floating-close")!;
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Fermer");
    expect(body!.firstElementChild!.tagName).toBe("SECTION");
  });

  it("le libellé est posé en texte (jamais en HTML)", () => {
    openFloatingDialog({ title: "T", layout: "fullscreen", closeLabel: "<img src=x onerror=1>", build: () => undefined });
    const button = last().element.querySelector("button.docseeker-floating-close")!;
    expect(button.textContent).toBe("<img src=x onerror=1>");
    expect(button.querySelector("img")).toBeNull();
  });

  it("un clic ferme la fenêtre et appelle onClosing puis onDestroyed", () => {
    vi.useFakeTimers();
    const onClosing = vi.fn();
    const onDestroyed = vi.fn();
    openFloatingDialog({ title: "T", layout: "fullscreen", closeLabel: "Fermer", build: () => undefined, onClosing, onDestroyed });
    last().element.querySelector<HTMLButtonElement>("button.docseeker-floating-close")!.click();
    expect(onClosing).toHaveBeenCalledWith({ focus: true });
    vi.runAllTimers();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("sans closeLabel (visionneur, qui a sa propre barre) ou en fenêtre : aucun bouton ajouté", () => {
    openFloatingDialog({ title: "T", layout: "fullscreen", build: () => undefined });
    expect(last().element.querySelectorAll("button")).toHaveLength(0);
    openFloatingDialog({ title: "T", closeLabel: "Fermer", build: () => undefined });
    expect(last().element.querySelectorAll("button")).toHaveLength(0);
  });

  it("closeLabel vide : aucun bouton (pas de bouton sans nom)", () => {
    openFloatingDialog({ title: "T", layout: "fullscreen", closeLabel: "", build: () => undefined });
    expect(last().element.querySelectorAll("button")).toHaveLength(0);
  });
});
