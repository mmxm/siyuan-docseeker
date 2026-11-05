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
    ".docseeker-reindex:focus-visible",
    ".docseeker-summary:focus-visible",
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
    expect(rulesFor(".docseeker-reindex").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-card").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-more").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-less").join(" ")).toMatch(/min-height:\s*32px/);
  });

  it("masque réellement les boutons de dépliage hidden", () => {
    expect(SEARCH_CSS).toContain(".docseeker-more[hidden], .docseeker-less[hidden] { display: none; }");
  });

  it("gère les couleurs forcées pour les surlignages", () => {
    expect(SEARCH_CSS).toMatch(/@media \(forced-colors: active\)[\s\S]*\.docseeker-highlight[\s\S]*Highlight/);
  });

  it("colore les surlignages en jaune translucide", () => {
    expect(rulesFor(".docseeker-highlight").join(" ")).toContain("rgba(255, 220, 0");
  });
});
