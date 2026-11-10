// @vitest-environment jsdom
// Résultats compacts sur bureau ; les cibles tactiles (pointer: coarse) restent intactes.
import { describe, expect, it } from "vitest";
import { SEARCH_CSS } from "../../../src/ui/searchStyles";

function rulesFor(selector: string, css = SEARCH_CSS): string {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]!)
    .join(" ");
}
const coarseStart = SEARCH_CSS.indexOf("@media (pointer: coarse)");
const coarse = SEARCH_CSS.slice(coarseStart + "@media (pointer: coarse) {".length, SEARCH_CSS.indexOf("/* mobile-compact */"));
const base = SEARCH_CSS.slice(0, coarseStart);

describe("rendu compact (bureau)", () => {
  it("conteneur et document resserrés, miniature 240px", () => {
    const search = rulesFor(".docseeker-search", base);
    expect(search).toContain("--docseeker-thumb-width: 240px");
    expect(search).toMatch(/padding: 6px;\s*gap: 4px/);
    expect(rulesFor(".docseeker-doc", base)).toMatch(/padding: 4px 0/);
  });

  it("titre et chemin sur la même ligne, chemin complet toujours disponible", () => {
    expect(rulesFor(".docseeker-doc", base)).toMatch(/display: flex/);
    expect(rulesFor(".docseeker-doc", base)).toMatch(/flex-wrap: wrap/);
    expect(rulesFor(".docseeker-doc-title", base)).toMatch(/font-size: 14px/);
    expect(rulesFor(".docseeker-doc-heading", base)).toMatch(/line-height: 1\.25/);
    expect(rulesFor(".docseeker-doc-path", base)).toMatch(/flex: 1 1 0/);
    expect(rulesFor(".docseeker-doc-path", base)).toContain("text-overflow: ellipsis");
  });

  it("cartes et libellé de page resserrés", () => {
    expect(rulesFor(".docseeker-cards", base)).toMatch(/gap: 4px/);
    const card = rulesFor(".docseeker-card", base);
    expect(card).toMatch(/gap: 0/);
    expect(card).toMatch(/padding: 0/);
    expect(rulesFor(".docseeker-card-page", base)).toMatch(/line-height: 1\.2/);
  });

  it("rangée de vignettes : défilement horizontal, sans overscroll-behavior, pastille de page", () => {
    const row = rulesFor(".docseeker-cards", base);
    for (const d of ["display: flex", "flex-wrap: nowrap", "overflow-x: auto", "overflow-y: hidden", "gap: 4px", "scroll-snap-type: x proximity", "scrollbar-width: thin", "padding-bottom"]) expect(row).toContain(d);
    expect(row).not.toContain("overscroll-behavior");
    expect(SEARCH_CSS).not.toMatch(/\.docseeker-cards[^{]*\{[^}]*overscroll-behavior/);
    const card = rulesFor(".docseeker-card", base);
    expect(card).toContain("flex: none");
    expect(card).toContain("scroll-snap-align: start");
    expect(card).toMatch(/scroll-margin-inline: \d+px/);
    const badge = rulesFor(".docseeker-card-page", base);
    for (const d of ["position: absolute", "bottom: 4px", "left: 4px", "pointer-events: none", "border-radius: 4px", "font-weight: bold", "color: #fff"]) expect(badge).toContain(d);
    expect(badge).toMatch(/rgba\(30, 30, 30, 0?\.75\)/);
    expect(badge).toMatch(/z-index: \d/);
    expect(rulesFor(".docseeker-more", base) + rulesFor(".docseeker-less", base)).toMatch(/width: 110px/);
    expect(rulesFor(".docseeker-list--flat", base)).toMatch(/gap: 4px/);
  });

  it("boutons « et N autres pages » compacts sur bureau, 44px sous coarse", () => {
    for (const s of [".docseeker-more", ".docseeker-flat-more"]) {
      const r = rulesFor(s, base);
      expect(r).toContain("min-height: var(--docseeker-hit-compact)");
      expect(r).toContain("padding: 0 8px");
      expect(r).toContain("font-size: 12px");
    }
    expect(rulesFor(".docseeker-less", base)).toContain("min-height: var(--docseeker-hit-compact)");
    expect(rulesFor(":root", base)).toContain("--docseeker-hit-compact: 24px");
    expect(rulesFor(":root", coarse)).toContain("--docseeker-hit-compact: 44px");
    expect(rulesFor(":root", coarse)).toContain("--docseeker-hit: 44px");
  });

  it("critères, icônes et statuts compacts", () => {
    expect(rulesFor(".docseeker-search .search__header", base)).toMatch(/gap: 2px 0/);
    expect(rulesFor(".docseeker-search .search__header button", base)).toContain("min-height: 24px");
    expect(rulesFor(".docseeker-search .search__header button", base)).toContain("padding-top: 0");
    expect(rulesFor(".docseeker-icons", base)).toContain("min-height: var(--docseeker-hit-compact)");
    expect(rulesFor(".docseeker-icons .block__icon", base)).toContain("min-height: var(--docseeker-hit-compact)");
    expect(rulesFor(".docseeker-status:empty", base)).toContain("display: none");
    expect(rulesFor(".docseeker-status", base)).not.toContain("min-height");
  });
});

describe("hauteur bornée : la liste est le vrai conteneur de défilement", () => {
  it("onglet : conteneur et hôte en colonne flex de hauteur 100 %, padding 16px", () => {
    const tab = rulesFor(".docseeker-tab", base);
    expect(tab).toMatch(/display: flex/);
    expect(tab).toMatch(/flex-direction: column/);
    expect(tab).toMatch(/height: 100%/);
    expect(tab).toMatch(/box-sizing: border-box/);
    expect(tab).toMatch(/padding: 16px/);
    const host = rulesFor(".docseeker-tab-search", base);
    expect(host).toMatch(/display: flex/);
    expect(host).toMatch(/flex-direction: column/);
    expect(host).toMatch(/flex: 1 1 auto/);
    expect(host).toMatch(/min-height: 0/);
  });

  it("fenêtre flottante bureau : corps en colonne flex borné, recherche flex 1 1 auto", () => {
    const body = rulesFor(".docseeker-floating-body", base);
    expect(body).toMatch(/display: flex/);
    expect(body).toMatch(/flex-direction: column/);
    expect(body).toMatch(/height: 100%/);
    expect(body).toMatch(/min-height: 0/);
    const search = rulesFor(".docseeker-floating-body > .docseeker-search", base);
    expect(search).toMatch(/flex: 1 1 auto/);
    expect(search).toMatch(/min-height: 0/);
  });

  it("overscroll-behavior seulement en plein écran, jamais sur la liste bureau", () => {
    expect(rulesFor(".docseeker-list", base)).not.toContain("overscroll-behavior");
    expect(rulesFor(".docseeker-floating-body--fullscreen .docseeker-list", SEARCH_CSS)).toContain("overscroll-behavior: contain");
  });
});

describe("vignette en attente de chargement", () => {
  it("a le format du recadrage par défaut (300 x 120 pt) : une vignette pas encore chargée n'agrandit pas la rangée", () => {
    expect(rulesFor(".docseeker-thumb", base)).toMatch(/aspect-ratio:\s*300\s*\/\s*120/);
    expect(rulesFor(".docseeker-thumb", base)).not.toMatch(/aspect-ratio:\s*3\s*\/\s*4/);
    expect(rulesFor(".docseeker-thumb", base)).toMatch(/max-width:\s*100%/);
  });
});
