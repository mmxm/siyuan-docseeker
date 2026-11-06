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

  describe("barre de filtres", () => {
    it.each([
      ".docseeker-filters > summary:focus-visible",
      ".docseeker-filter-field input:focus-visible",
      ".docseeker-filter-field select:focus-visible",
      ".docseeker-filter-reset:focus-visible",
      ".docseeker-reset-filters:focus-visible",
    ])("donne un focus visible fort à %s", (selector) => {
      expect(rulesFor(selector).join(" ")).toContain(FOCUS);
    });

    it("la barre est un flex qui passe à la ligne, avec un espace de 8px", () => {
      const rule = rulesFor(".docseeker-toolbar").join(" ");
      expect(rule).toContain("display: flex");
      expect(rule).toContain("flex-wrap: wrap");
      expect(rule).toContain("gap: 8px");
    });

    it("la grille s'adapte à la largeur, sans largeur fixe (320 px)", () => {
      const rule = rulesFor(".docseeker-filter-grid").join(" ");
      expect(rule).toContain("repeat(auto-fit, minmax(min(100%, 140px), 1fr))");
      expect(rule).not.toMatch(/(?<!max-|min-)width:\s*\d+px/);
    });

    it("les champs et le select se plient à la largeur de leur cellule, sans largeur fixe en px", () => {
      for (const selector of ['.docseeker-filter-field input:not([type="checkbox"])', ".docseeker-filter-field select"]) {
        const rule = rulesFor(selector).join(" ");
        expect(rule, selector).not.toBe("");
        expect(rule, selector).toContain("width: 100%");
        expect(rule, selector).toContain("box-sizing: border-box");
        expect(rule, selector).not.toMatch(/(?<![-\w])width:\s*\d+px/);
      }
    });

    it("garantit 32px de hauteur minimale aux contrôles, au résumé et au bouton", () => {
      for (const selector of [
        '.docseeker-filter-field input:not([type="checkbox"])',
        ".docseeker-filter-field select",
        ".docseeker-filters > summary",
        ".docseeker-filter-reset",
        ".docseeker-reset-filters",
      ]) {
        expect(rulesFor(selector).join(" "), selector).toMatch(/min-height:\s*32px/);
      }
    });

    it("l'erreur utilise la couleur d'erreur du thème et le champ invalide un contour", () => {
      expect(rulesFor(".docseeker-filter-error").join(" ")).toContain("var(--b3-theme-error)");
      expect(rulesFor('.docseeker-filter-field [aria-invalid="true"]').join(" ")).toContain("var(--b3-theme-error)");
    });

    it("le bouton aria-disabled est visiblement inactif ; l'erreur masquée n'occupe rien", () => {
      expect(rulesFor('.docseeker-filter-reset[aria-disabled="true"]').join(" ")).toContain("cursor: not-allowed");
      expect(rulesFor(".docseeker-filter-error[hidden]").join(" ")).toContain("display: none");
    });

    it("prévoit un bloc forced-colors pour le focus des filtres", () => {
      const idx = SEARCH_CSS.indexOf("@media (forced-colors: active)");
      expect(idx).toBeGreaterThan(-1);
      const block = SEARCH_CSS.slice(idx);
      expect(block).toContain(".docseeker-filter-field");
      expect(block).toContain("Highlight");
    });
  });

  describe("tri et regroupement (10c)", () => {
    const forced = (): string => SEARCH_CSS.slice(SEARCH_CSS.indexOf("@media (forced-colors: active)"));

    it("la barre d'outils est sur une ligne flex-wrap ; tri, regroupement et Filtres en sont les enfants", () => {
      const toolbar = rulesFor(".docseeker-toolbar").join(" ");
      expect(toolbar).toContain("display: flex");
      expect(toolbar).toContain("flex-wrap: wrap");
      expect(rulesFor(".docseeker-sort").join(" ")).toMatch(/display:\s*flex/);
      expect(rulesFor(".docseeker-view-options").join(" ")).toMatch(/display:\s*flex/);
      expect(rulesFor(".docseeker-view-options").join(" ")).toContain("flex-wrap: wrap");
    });

    it("le panneau Filtres ne prend toute la largeur que déplié (sinon il partage la ligne)", () => {
      expect(rulesFor(".docseeker-filters").join(" ")).not.toMatch(/flex:\s*1 1 100%/);
      expect(rulesFor(".docseeker-filters[open]").join(" ")).toMatch(/flex:\s*1 1 100%/);
    });

    it("le sélecteur, la case, Élargir et Réduire font au moins 32px", () => {
      expect(rulesFor(".docseeker-sort select").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-group").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-expand-all").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-collapse-all").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-expand-all").join(" ")).toMatch(/min-width:\s*32px/);
    });

    it("rien ne dépasse 320px de large : le sélecteur se réduit (min-width: 0, max-width: 100%)", () => {
      const rule = rulesFor(".docseeker-sort select").join(" ");
      expect(rule).toContain("max-width: 100%");
      expect(rulesFor(".docseeker-sort").join(" ")).toContain("min-width: 0");
      expect(SEARCH_CSS).not.toMatch(/\.docseeker-(sort|view-options|group)[^{]*\{[^}]*(?<!max-)(?<!min-)width:\s*\d{3,}px/);
    });

    it.each([
      ".docseeker-sort select:focus-visible",
      ".docseeker-group input:focus-visible",
      ".docseeker-expand-all:focus-visible",
      ".docseeker-collapse-all:focus-visible",
    ])("focus visible fort : %s", (selector) => {
      expect(rulesFor(selector).join(" ")).toContain(FOCUS);
    });

    it("Élargir / Réduire aria-disabled : estompés et non cliquables, et visibles en couleurs forcées", () => {
      for (const b of [".docseeker-expand-all", ".docseeker-collapse-all"]) {
        const rule = rulesFor(`${b}[aria-disabled="true"]`).join(" ");
        expect(rule).toMatch(/opacity:\s*0?\.\d+/);
        expect(rule).toContain("cursor: not-allowed");
        expect(forced()).toContain(`${b}[aria-disabled="true"]`);
      }
      expect(rulesFor(".docseeker-expand-all[hidden]").join(" ")).toContain("display: none");
    });

    it("couleurs forcées : le focus des nouveaux contrôles utilise Highlight", () => {
      const media = forced();
      for (const sel of [".docseeker-sort select:focus-visible", ".docseeker-group input:focus-visible", ".docseeker-expand-all:focus-visible", ".docseeker-collapse-all:focus-visible"]) {
        expect(media).toContain(sel);
      }
    });

    it("liste plate : cartes en flux, titre de la carte à capacité limitée", () => {
      expect(rulesFor(".docseeker-list--flat").join(" ")).toMatch(/display:\s*flex/);
      expect(rulesFor(".docseeker-list--flat").join(" ")).toContain("flex-wrap: wrap");
      expect(rulesFor(".docseeker-card-title").join(" ")).toMatch(/overflow-wrap:\s*anywhere|text-overflow/);
      expect(rulesFor(".docseeker-flat-item").join(" ")).toContain("min-width: 0");
    });

    it("la largeur max d'une carte plate est liée à la largeur de la vignette (variable CSS), sans 136px en dur", () => {
      expect(rulesFor(".docseeker-search").join(" ")).toMatch(/--docseeker-thumb-width:\s*120px/);
      expect(rulesFor(".docseeker-thumb").join(" ")).toContain("width: var(--docseeker-thumb-width)");
      const flat = rulesFor(".docseeker-card--flat").join(" ");
      expect(flat).toMatch(/max-width:\s*calc\(var\(--docseeker-thumb-width\)\s*\+\s*\d+px\)/);
      expect(SEARCH_CSS).not.toContain("136px");
    });

    it("pied de la liste plate : bouton et note ont une taille de cible suffisante, focus visible, [hidden] respecté", () => {
      expect(rulesFor(".docseeker-flat-more").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-flat-more:focus-visible").join(" ")).toContain(FOCUS);
      expect(rulesFor(".docseeker-flat-more[hidden]").join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-flat-footer[hidden]").join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-flat-footer").join(" ")).toMatch(/display:\s*flex/);
    });
  });
});

describe("SEARCH_CSS : historique des requêtes (J10 10e)", () => {
  it("le conteneur du champ est le repère de positionnement de la liste", () => {
    expect(rulesFor(".docseeker-search-box").join(" ")).toMatch(/position:\s*relative/);
  });

  it("la liste est posée sous le champ, ne dépasse pas la largeur, défile en interne", () => {
    const css = rulesFor(".docseeker-history-list").join(" ");
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/top:\s*100%/);
    expect(css).toMatch(/left:\s*0/);
    expect(css).toMatch(/right:\s*0/);
    expect(css).toMatch(/max-height:\s*\d+px/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/z-index:\s*\d+/);
    expect(css).not.toMatch(/(^|[^-])width:\s*\d+px/); // aucune largeur fixe (320 px)
  });

  it("la liste masquée l'est réellement", () => {
    expect(rulesFor(".docseeker-history-list[hidden]").join(" ")).toMatch(/display:\s*none/);
  });

  it("options et bouton ont une cible de 32 px, l'option active est visible (fond + contour)", () => {
    expect(rulesFor(".docseeker-history-option").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-history-toggle").join(" ")).toMatch(/min-height:\s*32px/);
    expect(rulesFor(".docseeker-history-toggle").join(" ")).toMatch(/min-width:\s*32px/);
    const selected = rulesFor('.docseeker-history-option[aria-selected="true"]').join(" ");
    expect(selected).toMatch(/background/);
    expect(selected).toMatch(/outline:\s*2px solid var\(--b3-theme-primary\)/);
  });

  it("le bouton a un focus visible fort", () => {
    expect(rulesFor(".docseeker-history-toggle:focus-visible").join(" ")).toContain(FOCUS);
  });

  it("le texte long d'une requête passe à la ligne", () => {
    expect(rulesFor(".docseeker-history-option").join(" ")).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
