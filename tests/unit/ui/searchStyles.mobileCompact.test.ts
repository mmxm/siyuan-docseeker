// @vitest-environment jsdom
// Mobile plein écran : gain de place. jsdom ne calcule pas la cascade : on teste la présence et le scoping des règles.
import { describe, expect, it } from "vitest";
import { SEARCH_CSS } from "../../../src/ui/searchStyles";

const SCOPE = /\.docseeker-floating-body--fullscreen|\.docseeker-fullscreen/;
const MARK = "/* mobile-compact */";
const start = SEARCH_CSS.indexOf(MARK);
const end = SEARCH_CSS.indexOf("/* /mobile-compact */");
const block = start >= 0 && end > start ? SEARCH_CSS.slice(start, end) : "";
const rules = [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.replace(/\/\*.*?\*\//g, "").trim(), body: m[2]! }));
const body = (needle: string): string => rules.filter((r) => (needle.endsWith(" {") ? r.sel.split(",").some((x) => x.trim().endsWith(needle.slice(0, -2)) && !/\s[.\w]/.test(x.trim().slice(x.trim().lastIndexOf(needle.slice(0, -2)) + needle.length - 2))) : r.sel.includes(needle))).map((r) => r.body).join(" ");

describe("compactage mobile plein écran", () => {
  it("le bloc existe et chaque sélecteur est scopé au plein écran", () => {
    expect(rules.length).toBeGreaterThan(8);
    for (const r of rules) for (const s of r.sel.split(",")) expect(s.trim(), s).toMatch(SCOPE);
  });

  it("le bloc est dans un @media (pointer: coarse) ou sans règle de base globale (aucune règle hors scope ailleurs)", () => {
    expect(SEARCH_CSS.split(MARK)).toHaveLength(2);
  });

  it("boutons critères : petits, côte à côte, largeur égale, espacés d'au moins 8px", () => {
    const b = body("search__header button");
    expect(b).toMatch(/font-size: 13px/);
    expect(b).toMatch(/flex: 1 1 0/);
    expect(b).toMatch(/min-height: 30px/);
    expect(b).toMatch(/position: relative/);
    expect(b).not.toContain("var(--docseeker-hit)");
    expect(body(".search__header {")).toMatch(/gap: [^;]*8px|gap: 8px/);
    expect(body("fn__space")).toContain("display: none");
    expect(body("fn__flex-1")).toContain("display: none");
  });

  it("zone de clic 44px via ::after transparent, sans chevauchement horizontal", () => {
    const a = body("::after");
    expect(a).toContain('content: ""');
    expect(a).toMatch(/position: absolute/);
    expect(a).toMatch(/top: -7px/);
    expect(a).toMatch(/bottom: -7px/);
    expect(a).toMatch(/left: -4px/);
    expect(a).toMatch(/right: -4px/);
    expect(a).not.toMatch(/background|border/);
  });

  it("barre d'icônes sur une seule ligne, compteur masqué", () => {
    const i = body(".docseeker-icons {");
    expect(i).toContain("flex-wrap: nowrap");
    expect(i).toContain("justify-content: space-between");
    expect(body(".docseeker-icons .block__icon")).toMatch(/flex: 1 1 0|flex: 0 1 auto/);
    expect(body(".docseeker-count")).toContain("display: none");
    expect(body(".docseeker-toolbar")).toContain("flex-wrap: nowrap");
  });

  it("marges réduites à 8px et vignettes sur 2 colonnes", () => {
    expect(body(".docseeker-floating-body--fullscreen {")).toMatch(/padding: 8px/);
    expect(body(".docseeker-cards")).toMatch(/display: grid/);
    expect(body(".docseeker-cards")).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(body(".docseeker-cards")).toMatch(/gap: 4px/);
    expect(body(".docseeker-thumb")).toContain("width: 100%");
  });

  it("titre 16px gras sur 2 lignes max, chemin petit gris sur une ligne", () => {
    const t = body(".docseeker-doc-title");
    expect(t).toMatch(/font-size: 16px/);
    expect(t).toMatch(/font-weight: bold|font-weight: 600/);
    expect(t).toContain("-webkit-line-clamp: 2");
    expect(t).toContain("text-overflow: ellipsis");
    const p = body(".docseeker-doc-fullpath");
    expect(p).toMatch(/font-size: 12px/);
    expect(p).toContain("white-space: nowrap");
    expect(p).toContain("text-overflow: ellipsis");
    expect(p).toContain("var(--b3-theme-on-surface)");
  });

  it("aucune couleur en dur dans le bloc", () => {
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
