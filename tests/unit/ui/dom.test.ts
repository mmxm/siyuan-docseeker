// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { el } from "../../../src/ui/dom";

describe("el", () => {
  it("crée l'élément avec ses classes et ses attributs", () => {
    const li = el(document, "li", "b3-list-item b3-list-item--focus", { "data-path": "/", "data-box": "b" });
    expect(li.tagName).toBe("LI");
    expect(li.className).toBe("b3-list-item b3-list-item--focus");
    expect(li.getAttribute("data-path")).toBe("/");
    expect(li.getAttribute("data-box")).toBe("b");
  });

  it("classes et attributs sont facultatifs : aucun attribut class vide", () => {
    const div = el(document, "div");
    expect(div.hasAttribute("class")).toBe(false);
    expect(div.attributes).toHaveLength(0);
  });

  it("une valeur d'attribut est du texte : jamais interprétée comme HTML", () => {
    const span = el(document, "span", "", { "aria-label": '<img src=x onerror=alert(1)>' });
    expect(span.getAttribute("aria-label")).toBe('<img src=x onerror=alert(1)>');
    expect(span.children).toHaveLength(0);
  });

  it.each(["onclick", "onerror", "ONLOAD"])("refuse l'attribut de gestionnaire d'évènement %s", (name) => {
    expect(() => el(document, "span", "", { [name]: "alert(1)" })).toThrow(TypeError);
  });
});
