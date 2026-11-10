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
  it("conteneur et document resserrés, miniature 96px", () => {
    const search = rulesFor(".docseeker-search", base);
    expect(search).toContain("--docseeker-thumb-width: 96px");
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
    expect(rulesFor(".docseeker-cards", base)).toMatch(/gap: 4px;\s*margin-top: 2px/);
    const card = rulesFor(".docseeker-card", base);
    expect(card).toMatch(/gap: 0/);
    expect(card).toMatch(/padding: 2px/);
    expect(rulesFor(".docseeker-card-page", base)).toMatch(/line-height: 1\.2/);
  });

  it("boutons « et N autres pages » compacts sur bureau, 44px sous coarse", () => {
    for (const s of [".docseeker-more", ".docseeker-flat-more"]) {
      const r = rulesFor(s, base);
      expect(r).toContain("min-height: var(--docseeker-hit-compact)");
      expect(r).toContain("padding: 0 8px");
      expect(r).toContain("font-size: 12px");
    }
    expect(rulesFor(".docseeker-less", base)).toContain("min-height: var(--docseeker-hit-compact)");
    expect(rulesFor(".docseeker-more-actions", base)).toMatch(/gap: 4px;\s*margin-top: 2px/);
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
