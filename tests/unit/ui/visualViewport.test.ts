// @vitest-environment jsdom
// Suivi de window.visualViewport (clavier ouvert) : abonnement, valeur écrite, nettoyage. Faux visualViewport (jsdom n'en a pas).
import { describe, expect, it } from "vitest";
import { KEYBOARD_ATTR, VIEWPORT_HEIGHT_VAR, VIEWPORT_TOP_VAR, trackVisualViewport } from "../../../src/ui/visualViewport";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  adds: string[] = [];
  removes: string[] = [];
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null): void {
    this.adds.push(type);
    super.addEventListener(type, cb);
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null): void {
    this.removes.push(type);
    super.removeEventListener(type, cb);
  }
}
const fakeWindow = (vv: FakeViewport | null, innerHeight = 800): Window => ({ visualViewport: vv, innerHeight }) as unknown as Window;

describe("trackVisualViewport", () => {
  it("expose le nom de variable attendu par la feuille de style", () => {
    expect(VIEWPORT_HEIGHT_VAR).toBe("--docseeker-vvh");
  });

  it("écrit tout de suite la hauteur visible, puis la met à jour à chaque resize et scroll", () => {
    const vv = new FakeViewport();
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target);
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("800px");
    vv.height = 420.5; // clavier ouvert
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("420.5px");
    vv.height = 500;
    vv.dispatchEvent(new Event("scroll"));
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("500px");
    expect(vv.adds.sort()).toEqual(["resize", "scroll"]);
  });

  it("le nettoyage retire tout de suite les deux abonnements et ignore les événements suivants", () => {
    const vv = new FakeViewport();
    const target = document.createElement("div");
    const stop = trackVisualViewport(fakeWindow(vv), target);
    stop();
    expect(vv.removes.sort()).toEqual(["resize", "scroll"]);
    vv.height = 300;
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("800px");
  });

  it("le nettoyage laisse les valeurs en place (la fenêtre garde sa hauteur pendant l'animation de fermeture)", () => {
    const vv = new FakeViewport();
    vv.offsetTop = 12;
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target)();
    expect(target.style.getPropertyValue(VIEWPORT_HEIGHT_VAR)).toBe("800px");
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("12px");
  });

  it("le nettoyage est idempotent", () => {
    const vv = new FakeViewport();
    const stop = trackVisualViewport(fakeWindow(vv), document.createElement("div"));
    stop();
    stop();
    expect(vv.removes).toHaveLength(2);
  });

  it("sans visualViewport : ne fait rien, ne lève pas, le nettoyage est un no-op", () => {
    const target = document.createElement("div");
    const stop = trackVisualViewport(fakeWindow(null), target);
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("");
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("");
    expect(target.hasAttribute(KEYBOARD_ATTR)).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("hauteur invalide (%s) : la variable n'est pas écrite (le repli dvh s'applique)", (height) => {
    const vv = new FakeViewport();
    vv.height = height;
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target);
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("");
  });

  it("une hauteur devenue invalide retire la valeur périmée", () => {
    const vv = new FakeViewport();
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target);
    vv.height = 0;
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue("--docseeker-vvh")).toBe("");
  });

  it("deux suivis indépendants ne se gênent pas", () => {
    const vv = new FakeViewport();
    const a = document.createElement("div");
    const b = document.createElement("div");
    const stopA = trackVisualViewport(fakeWindow(vv), a);
    trackVisualViewport(fakeWindow(vv), b);
    stopA();
    vv.height = 610;
    vv.dispatchEvent(new Event("resize"));
    expect(a.style.getPropertyValue("--docseeker-vvh")).toBe("800px"); // arrêté : figé
    expect(b.style.getPropertyValue("--docseeker-vvh")).toBe("610px");
  });
});

describe("trackVisualViewport : décalage vertical (offsetTop) et clavier", () => {
  it("expose les noms attendus par la feuille de style", () => {
    expect(VIEWPORT_TOP_VAR).toBe("--docseeker-vv-top");
    expect(KEYBOARD_ATTR).toBe("data-docseeker-keyboard");
  });

  it("écrit offsetTop (positif, puis nul) dans --docseeker-vv-top à l'abonnement et à chaque événement", () => {
    const vv = new FakeViewport();
    vv.offsetTop = 64.5;
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target);
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("64.5px");
    vv.offsetTop = 0;
    vv.dispatchEvent(new Event("scroll"));
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("0px");
    vv.offsetTop = 30;
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("30px");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number])("offsetTop invalide (%s) : variable retirée", (offsetTop) => {
    const vv = new FakeViewport();
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv), target);
    vv.offsetTop = 20;
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("20px");
    vv.offsetTop = offsetTop;
    vv.dispatchEvent(new Event("resize"));
    expect(target.style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe("");
  });

  it("clavier ouvert (viewport nettement plus court que la fenêtre) : l'attribut est posé, puis retiré à la fermeture du clavier", () => {
    const vv = new FakeViewport();
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv, 800), target);
    expect(target.hasAttribute(KEYBOARD_ATTR)).toBe(false);
    vv.height = 450;
    vv.dispatchEvent(new Event("resize"));
    expect(target.getAttribute(KEYBOARD_ATTR)).toBe("true");
    vv.height = 800;
    vv.dispatchEvent(new Event("resize"));
    expect(target.hasAttribute(KEYBOARD_ATTR)).toBe(false);
  });

  it("une petite différence (barre d'adresse) n'est pas un clavier", () => {
    const vv = new FakeViewport();
    vv.height = 760;
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv, 800), target);
    expect(target.hasAttribute(KEYBOARD_ATTR)).toBe(false);
  });

  it("innerHeight absent ou invalide : pas de clavier détecté, sans erreur", () => {
    const vv = new FakeViewport();
    vv.height = 300;
    const target = document.createElement("div");
    trackVisualViewport(fakeWindow(vv, Number.NaN), target);
    expect(target.hasAttribute(KEYBOARD_ATTR)).toBe(false);
  });
});
