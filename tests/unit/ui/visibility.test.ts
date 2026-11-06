// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isShown } from "../../../src/ui/visibility";

afterEach(() => {
  document.body.replaceChildren();
});

describe("isShown", () => {
  it("élément détaché du document : non visible", () => {
    expect(isShown(document.createElement("div"))).toBe(false);
  });

  it("élément connecté et sans masquage : visible", () => {
    const el = document.createElement("div");
    document.body.append(el);
    expect(isShown(el)).toBe(true);
  });

  it("utilise checkVisibility() quand il existe", () => {
    const el = document.createElement("div");
    document.body.append(el);
    Object.defineProperty(el, "checkVisibility", { value: () => false, configurable: true });
    expect(isShown(el)).toBe(false);
    Object.defineProperty(el, "checkVisibility", { value: () => true, configurable: true });
    expect(isShown(el)).toBe(true);
  });

  it("sans checkVisibility : un ancêtre en display:none ou hidden masque l'élément", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.append(inner);
    document.body.append(outer);
    expect(isShown(inner)).toBe(true);
    outer.style.display = "none";
    expect(isShown(inner)).toBe(false);
    outer.style.display = "";
    outer.hidden = true;
    expect(isShown(inner)).toBe(false);
  });

  it("checkVisibility qui lève : repli sur l'ancêtre masqué, jamais d'exception", () => {
    const el = document.createElement("div");
    document.body.append(el);
    Object.defineProperty(el, "checkVisibility", {
      value: () => {
        throw new Error("boum");
      },
      configurable: true,
    });
    expect(isShown(el)).toBe(true);
  });
});
