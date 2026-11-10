// @vitest-environment jsdom
// E4b : ergonomie tactile. jsdom ne calcule pas les @media : on teste la présence et la structure des règles générées.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEARCH_CSS } from "../../../src/ui/searchStyles";

const FOCUS = "outline: 2px solid var(--b3-theme-primary); outline-offset: 2px";
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;

/** Contenu (accolades comprises) de tous les blocs `@media <query> { ... }`, par comptage d'accolades. */
function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  const head = `@media ${query} {`;
  let from = 0;
  for (;;) {
    const start = css.indexOf(head, from);
    if (start < 0) return blocks;
    let depth = 1;
    let i = start + head.length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(start + head.length, i - 1));
    from = i;
  }
}
/** Le CSS sans aucun bloc @media (règles de base, valables partout). */
function withoutMedia(css: string): string {
  let out = css;
  for (;;) {
    const start = out.indexOf("@media");
    if (start < 0) return out;
    const open = out.indexOf("{", start);
    let depth = 1;
    let i = open + 1;
    while (i < out.length && depth > 0) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      i++;
    }
    out = out.slice(0, start) + out.slice(i);
  }
}
function rulesIn(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1]!.split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]!);
}
const base = withoutMedia(SEARCH_CSS);
const coarse = mediaBlocks(SEARCH_CSS, "(pointer: coarse)").join("\n");

describe("--docseeker-hit : cible tactile", () => {
  it("vaut 32px par défaut (rendu bureau inchangé) et 44px sous pointer: coarse", () => {
    expect(rulesIn(base, ":root").join(" ")).toContain("--docseeker-hit: 32px");
    expect(rulesIn(coarse, ":root").join(" ")).toContain("--docseeker-hit: 44px");
  });

  it("aucun 32px en dur ne subsiste : toutes les tailles minimales passent par la variable", () => {
    const withoutDefinition = SEARCH_CSS.replace("--docseeker-hit: 32px", "");
    expect(withoutDefinition).not.toMatch(/\b32px/);
    expect(SEARCH_CSS.match(/var\(--docseeker-hit\)/g)?.length ?? 0).toBeGreaterThanOrEqual(13);
  });

  it.each([
    ".docseeker-icons .block__icon",
    ".docseeker-card",
    ".docseeker-more, .docseeker-less",
    ".docseeker-flat-more",
    ".docseeker-action",
  ])("la cible %s a une taille minimale égale à la variable", (selectors) => {
    const first = selectors.split(",")[0]!.trim();
    expect(rulesIn(base, first).join(" ")).toMatch(/min-(height|width): var\(--docseeker-hit(-compact)?\)/);
  });

  it("les cases à cocher : c'est le <label> qui grandit (pas l'input), sous pointer: coarse seulement", () => {
    expect(coarse).toMatch(/label:has\(> input\[type="checkbox"\]\)[^{]*\{[^}]*min-height: var\(--docseeker-hit\)/);
    const inputRules = [...SEARCH_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(",").some((sel) => sel.trim().endsWith('input[type="checkbox"]')));
    expect(inputRules.map((m) => m[2]).join(" ")).not.toContain("--docseeker-hit");
  });

  it.each([
    ".docseeker-icons .search__rmpath",
    ".docseeker-search .search__header .b3-chip",
    ".docseeker-search .search__header button",
    ".docseeker-dialog .b3-dialog__action .b3-button",
  ])("%s atteint la cible tactile sous pointer: coarse seulement", (selector) => {
    expect(rulesIn(coarse, selector).join(" ")).toMatch(/min-height: var\(--docseeker-hit\)/);
    expect(rulesIn(base, selector).join(" ")).not.toContain("--docseeker-hit");
  });

  it("champs et listes déroulantes : hauteur minimale sous coarse", () => {
    expect(coarse).toMatch(/\.docseeker-settings-section select[^{]*\{[^}]*min-height: var\(--docseeker-hit\)/);
    expect(coarse).toMatch(/\.docseeker-settings-section input\[type="text"\][^{]*\{[^}]*min-height: var\(--docseeker-hit\)/);
  });
});

describe("champs de saisie : pas de zoom automatique d'iOS", () => {
  it("passent à 16px de police sous pointer: coarse et pas ailleurs", () => {
    expect(coarse).toMatch(/input\[type="search"\][^{]*\{[^}]*font-size: 16px/);
    expect(coarse).toMatch(/\.docseeker-filter-field input[^{]*\{[^}]*font-size: 16px/);
    expect(coarse).toMatch(/data-dialog-input[^{]*\{[^}]*font-size: 16px/);
    expect(coarse).toMatch(/\.docseeker-settings-section select[^{]*\{[^}]*font-size: 16px/);
    expect(base).not.toMatch(/input[^{]*\{[^}]*font-size: 16px/);
  });
});

describe("hauteur, clavier et zones sûres", () => {
  it("le conteneur plein écran utilise --docseeker-vvh avec repli dvh puis vh, et les marges env(safe-area-inset-*)", () => {
    const rule = rulesIn(base, ".b3-dialog__container.docseeker-fullscreen").join(" ");
    expect(rule).toMatch(/height: 100vh;\s*height: 100dvh;\s*height: var\(--docseeker-vvh, 100dvh\)/);
    expect(rule).toMatch(/max-height: var\(--docseeker-vvh, 100dvh\)/);
    expect(rule).toContain("padding-top: env(safe-area-inset-top");
    expect(rule).toContain("padding-bottom: env(safe-area-inset-bottom");
    expect(rule).toContain("padding-left: env(safe-area-inset-left");
    expect(rule).toContain("padding-right: env(safe-area-inset-right");
    expect(rule).toContain("transform: translateY(var(--docseeker-vv-top, 0px))");
    expect(rule).toContain("box-sizing: border-box");
  });

  it("le conteneur plein écran s'aligne en haut : .b3-dialog le centre sinon, et sa moitié haute passe sous le clavier iOS", () => {
    const rule = rulesIn(base, ".b3-dialog__container.docseeker-fullscreen").join(" ");
    expect(rule).toContain("align-self: flex-start");
  });

  it("la feuille ne fixe la hauteur qu'à un endroit : l'ordre vh, dvh, vvh de height et de max-height est celui du repli", () => {
    const rule = rulesIn(base, ".b3-dialog__container.docseeker-fullscreen").join(" ");
    expect(rule.indexOf("height: 100vh")).toBeLessThan(rule.indexOf("height: 100dvh"));
    expect(rule.indexOf("height: 100dvh")).toBeLessThan(rule.indexOf("height: var(--docseeker-vvh, 100dvh)"));
    expect(rule).not.toContain("!important");
  });

  it("clavier ouvert : la barre basse est masquée et la marge basse du conteneur retirée", () => {
    const keyboard = '.b3-dialog__container.docseeker-fullscreen[data-docseeker-keyboard]';
    expect(rulesIn(base, `${keyboard} .docseeker-floating-bar`).join(" ")).toContain("display: none");
    expect(rulesIn(base, keyboard).join(" ")).toContain("padding-bottom: 0");
  });

  it("la liste défilante peut rétrécir (min-height: 0) et ne propage pas son défilement", () => {
    const rule = rulesIn(base, ".docseeker-list").join(" ");
    expect(rule).toContain("min-height: 0");
    expect(rule).not.toContain("overscroll-behavior"); // bureau : ne bloque jamais la molette
    expect(rulesIn(SEARCH_CSS, ".docseeker-floating-body--fullscreen .docseeker-list").join(" ")).toContain("overscroll-behavior: contain");
  });

  it("la vue de recherche en plein écran remplit l'espace restant au-dessus de la barre basse", () => {
    expect(rulesIn(base, ".docseeker-floating-body--fullscreen").join(" ")).toMatch(/display: flex;[^}]*flex-direction: column/);
    expect(rulesIn(base, ".docseeker-floating-body--fullscreen > .docseeker-search").join(" ")).toContain("min-height: 0");
  });
});

describe("survol et appui", () => {
  it("aucune règle :hover hors de @media (hover: hover)", () => {
    expect(base).not.toContain(":hover");
    expect(coarse).not.toContain(":hover");
  });

  it("chaque :hover du bloc (hover: hover) a son équivalent :active", () => {
    const hover = mediaBlocks(SEARCH_CSS, "(hover: hover)").join("\n");
    expect(hover).toContain(":hover");
    const hoverSelectors = [...hover.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    const withActive = new Set([...SEARCH_CSS.matchAll(/([^{}@]+)\{/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())));
    for (const selector of hoverSelectors) {
      expect(withActive.has(selector.replace(":hover", ":active")), selector).toBe(true);
    }
  });

  it.each([
    ".docseeker-card",
    ".docseeker-icons .block__icon",
    ".docseeker-more",
    ".docseeker-less",
    ".docseeker-action",
    ".docseeker-viewer-button",
    ".docseeker-floating-close",
    ".docseeker-flat-more",
  ])("%s a touch-action: manipulation (pas de zoom au double appui)", (selector) => {
    const rules = [...SEARCH_CSS.matchAll(/([^{}]+)\{([^}]*touch-action: manipulation[^}]*)\}/g)];
    expect(rules.some((m) => m[1]!.split(",").some((s) => s.trim() === selector))).toBe(true);
  });
});

describe("barre basse « Fermer » et chemin complet (mobile)", () => {
  it("la barre basse fait 48px de haut au moins, avec focus visible et zone sûre en bas", () => {
    const button = rulesIn(base, ".docseeker-floating-close").join(" ");
    expect(button).toMatch(/min-height: 48px/);
    expect(rulesIn(base, ".docseeker-floating-close:focus-visible").join(" ")).toContain(FOCUS);
    expect(rulesIn(base, ".docseeker-floating-bar").join(" ")).not.toContain("env(");
  });

  it("bureau inchangé : le dossier tronqué n'est masqué que sous coarse, le chemin complet est masqué par défaut", () => {
    expect(rulesIn(base, ".docseeker-doc-path").join(" ")).not.toContain("display: none");
    expect(rulesIn(base, ".docseeker-doc-fullpath").join(" ")).toContain("display: none");
    expect(rulesIn(base, ".docseeker-list").join(" ")).not.toContain("overscroll-behavior");
  });

  it("le chemin complet est masqué par défaut et remplace le dossier tronqué sous pointer: coarse", () => {
    expect(rulesIn(base, ".docseeker-doc-fullpath").join(" ")).toContain("display: none");
    expect(rulesIn(coarse, ".docseeker-doc-fullpath").join(" ")).toMatch(/display: block/);
    expect(rulesIn(coarse, ".docseeker-doc-fullpath").join(" ")).toContain("overflow-wrap: anywhere");
    expect(rulesIn(coarse, ".docseeker-doc-path").join(" ")).toContain("display: none");
  });
});

describe("thème et contraste", () => {
  it("les blocs tactiles et la barre basse n'ont aucune couleur en dur", () => {
    const own = [coarse, ...[".docseeker-floating-close", ".docseeker-floating-bar", ".docseeker-doc-fullpath"].map((s) => rulesIn(base, s).join(" "))];
    expect(own.join("\n")).not.toMatch(COLOR_LITERAL);
    expect(own.join("\n")).toContain("--b3-");
  });

  it("le focus clavier reste visible, y compris en couleurs forcées, pour la barre basse", () => {
    const forced = mediaBlocks(SEARCH_CSS, "(forced-colors: active)").join("\n");
    expect(forced).toContain(".docseeker-floating-close:focus-visible");
    expect(forced).toMatch(/\.docseeker-floating-close[^{]*\.docseeker-viewer-button[^{]*\{[^}]*border-color: ButtonText|\.docseeker-viewer-button[^{]*\.docseeker-floating-close[^{]*\{[^}]*border-color: ButtonText/);
    expect(forced).toMatch(/\.docseeker-viewer-button:disabled[^{]*\{[^}]*(color|border-color): GrayText/);
  });
});

describe("journal des réglages", () => {
  it("le style du bloc de texte est une classe CSS (retour à la ligne, texte sélectionnable)", () => {
    const rule = rulesIn(base, ".docseeker-text-block").join(" ");
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("user-select: text");
  });

  it("settingsPanel n'écrit plus de style en ligne sur le <pre>", () => {
    expect(readFileSync("src/ui/settingsPanel.ts", "utf8")).not.toMatch(/pre\.style\./);
  });
});
