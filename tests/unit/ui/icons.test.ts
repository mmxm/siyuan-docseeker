// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ICON_TOOLTIP_POSITION, SVG_NS, XLINK_NS, makeIconButton, svgIcon } from "../../../src/ui/icons";
import * as nativeUiTypes from "../../../src/ui/nativeUiTypes";
import { MENU_ID_HISTORY, MENU_ID_MORE } from "../../../src/ui/nativeUiTypes";

describe("svgIcon", () => {
  it("crée svg > use dans l'espace de noms SVG, avec xlink:href « #id » dans l'espace de noms xlink", () => {
    const svg = svgIcon(document, "iconFolder");
    expect(svg.namespaceURI).toBe(SVG_NS);
    const use = svg.querySelector("use")!;
    expect(use.namespaceURI).toBe(SVG_NS);
    expect(use.getAttributeNS(XLINK_NS, "href")).toBe("#iconFolder");
    expect(svg.children).toHaveLength(1);
  });

  it("className optionnelle : posée via l'attribut class (un SVGElement n'a pas de className texte)", () => {
    expect(svgIcon(document, "iconDown", "search__arrowdown").getAttribute("class")).toBe("search__arrowdown");
    expect(svgIcon(document, "iconDown").hasAttribute("class")).toBe(false);
  });

  it("les constantes d'espaces de noms sont les URI officielles", () => {
    expect(SVG_NS).toBe("http://www.w3.org/2000/svg");
    expect(XLINK_NS).toBe("http://www.w3.org/1999/xlink");
  });
});

describe("makeIconButton", () => {
  it("vrai <button type=button> avec classe + ariaLabel, aria-label, data-position et les icônes", () => {
    const b = makeIconButton(document, "block__icon block__icon--show", "Plus", [svgIcon(document, "iconMore")]);
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.className).toBe("block__icon block__icon--show ariaLabel");
    expect(b.getAttribute("aria-label")).toBe("Plus");
    expect(b.getAttribute("data-position")).toBe(ICON_TOOLTIP_POSITION);
    expect(ICON_TOOLTIP_POSITION).toBe("9south");
    expect(b.querySelectorAll("svg")).toHaveLength(1);
    expect(b.textContent).toBe("");
  });

  it("plusieurs icônes : toutes ajoutées, dans l'ordre ; le libellé est un attribut (jamais interprété)", () => {
    const b = makeIconButton(document, "x", "<b>L</b>", [svgIcon(document, "iconA"), svgIcon(document, "iconB")]);
    expect([...b.querySelectorAll("use")].map((u) => u.getAttributeNS(XLINK_NS, "href"))).toEqual(["#iconA", "#iconB"]);
    expect(b.getAttribute("aria-label")).toBe("<b>L</b>");
    expect(b.children).toHaveLength(2);
  });
});

describe("identifiants de menu partagés", () => {
  it("un identifiant par bouton, au format accepté par l'adaptateur", () => {
    expect([MENU_ID_MORE, MENU_ID_HISTORY]).toEqual(["docseeker-more", "docseeker-history"]);
    // « Spécifier le chemin » ouvre un dialogue : plus d'identifiant de menu pour lui.
    expect(nativeUiTypes).not.toHaveProperty("MENU_ID_PATH");
    for (const id of [MENU_ID_MORE, MENU_ID_HISTORY]) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
