import { describe, expect, it } from "vitest";
import { SEARCH_CSS } from "../../../src/ui/searchStyles";

const FOCUS = "outline: 2px solid var(--b3-theme-primary); outline-offset: 2px";

function rulesFor(selector: string): string[] {
  return [...SEARCH_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]!);
}

describe("SEARCH_CSS", () => {
  it.each([
    ".docseeker-card:focus-visible",
    ".docseeker-search input[type=\"search\"]:focus-visible",
    ".docseeker-open-settings:focus-visible",
    ".docseeker-action:focus-visible",
    ".docseeker-log:focus-visible",
    ".docseeker-more:focus-visible",
    ".docseeker-less:focus-visible",
  ])("donne un focus visible fort à %s", (selector) => {
    expect(rulesFor(selector).join(" ")).toContain(FOCUS);
  });

  it("n'utilise aucune taille de texte inférieure à 12px", () => {
    const sizes = [...SEARCH_CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  });

  it("garantit des cibles d'au moins 32px pour les boutons", () => {
    expect(rulesFor(".docseeker-open-settings").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-card").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-more").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-less").join(" ")).toMatch(/min-height:\s*32px/);
  });

  it("n'a plus de règle pour l'ancienne section « Avancé »", () => {
    expect(SEARCH_CSS).not.toContain("docseeker-summary");
  });

  it("montre qu'un bouton d'action aria-disabled est inactif", () => {
    const rule = rulesFor('.docseeker-action[aria-disabled="true"]').join(" ");
    expect(rule).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule).toContain("cursor: not-allowed");
  });

  it("rend le journal défilable et sans débordement horizontal", () => {
    const rule = rulesFor(".docseeker-log").join(" ");
    expect(rule).toMatch(/max-height:/);
    expect(rule).toContain("overflow: auto");
    expect(rule).toContain("overflow-wrap: anywhere");
  });

  it("espace verticalement le contenu d'une action sans dépendre de display (SiYuan lui ajoute fn__block)", () => {
    const rule = rulesFor(".docseeker-setting-action").join(" ");
    expect(rule).not.toContain("display: flex"); // fn__block impose display:block
    expect(rulesFor(".docseeker-setting-action > * + *").join(" ")).toContain("margin-top");
    expect(rule).not.toMatch(/(?<!max-)width:\s*\d+px/); // pas de largeur fixe
  });

  it("le bouton d'action garde sa largeur naturelle et les blocs de texte prennent toute la largeur", () => {
    expect(rulesFor(".docseeker-action").join(" ")).toContain("width: auto");
    expect(rulesFor(".docseeker-setting-action pre").join(" ")).toContain("box-sizing: border-box");
  });

  it("le journal occupe la pleine largeur, défile au-delà d'une hauteur max, sans largeur fixe", () => {
    const rule = rulesFor(".docseeker-log").join(" ");
    expect(rule).toContain("width: 100%");
    expect(rule).toContain("box-sizing: border-box");
    expect(rule).not.toMatch(/(?<!max-)width:\s*\d+px/);
  });

  it("garantit des cibles d'au moins 32px pour les boutons d'action des paramètres", () => {
    expect(rulesFor(".docseeker-action").join(" ")).toMatch(/min-height:\s*32px/);
  });

  it("masque réellement les boutons de dépliage hidden", () => {
    expect(SEARCH_CSS).toContain(".docseeker-more[hidden], .docseeker-less[hidden] { display: none; }");
    expect(SEARCH_CSS).toContain(".docseeker-index-settings[hidden] { display: none; }");
  });

  it("les descriptions du panneau ne sont pas coupées au milieu des mots, pour nos seuls items", () => {
    expect(SEARCH_CSS).toContain(
      ".config-item:has(.docseeker-setting-action) .b3-label__text { word-break: normal; overflow-wrap: break-word; }",
    );
    // La règle est restreinte à nos items : aucune règle globale sur .b3-label__text.
    const rules = SEARCH_CSS.split("\n").filter((l) => l.includes(".b3-label__text"));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain(":has(.docseeker-setting-action)");
  });

  it("gère les couleurs forcées pour les surlignages", () => {
    expect(SEARCH_CSS).toMatch(/@media \(forced-colors: active\)[\s\S]*\.docseeker-highlight[\s\S]*Highlight/);
  });

  it("colore les surlignages en jaune translucide", () => {
    expect(rulesFor(".docseeker-highlight").join(" ")).toContain("rgba(255, 220, 0");
  });

  it("tronque le chemin par le début (la fin du dossier reste visible)", () => {
    const outer = rulesFor(".docseeker-doc-path").join(" ");
    expect(outer).toContain("direction: rtl");
    expect(outer).toContain("text-overflow: ellipsis");
    expect(outer).toContain("white-space: nowrap");
    expect(outer).toContain("overflow: hidden");
    const inner = rulesFor(".docseeker-doc-path-text").join(" ");
    expect(inner).toContain("direction: ltr");
    expect(inner).toContain("unicode-bidi: bidi-override");
  });
});
