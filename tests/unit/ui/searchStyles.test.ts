// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SEARCH_CSS, SEARCH_STYLE_ID, ensureSearchStyle } from "../../../src/ui/searchStyles";
import { mountSearchView } from "../../../src/ui/searchView";

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

  it("un bouton de la barre occupé (lecture des documents) est visiblement atténué avec le curseur d'attente", () => {
    const rule = rulesFor('.docseeker-icons .block__icon[aria-busy="true"]').join(" ");
    expect(rule).toContain("cursor: progress");
    expect(rule).toContain("opacity");
  });

  it("la fenêtre flottante a une marge intérieure (le corps du dialogue de SiYuan défile et n'en a pas)", () => {
    expect(rulesFor(".docseeker-floating-body").join(" ")).toMatch(/padding:\s*8px 16px 16px/);
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

  describe("barre d'icônes native (10f)", () => {
    const forced = (): string => SEARCH_CSS.slice(SEARCH_CSS.indexOf("@media (forced-colors: active)"));
    const BTN = ".docseeker-icons .block__icon";

    it("la rangée passe à la ligne, sans largeur fixe (320 px) ni défilement horizontal", () => {
      const rule = rulesFor(".docseeker-icons").join(" ");
      expect(rule).toContain("display: flex");
      expect(rule).toContain("flex-wrap: wrap");
      expect(rule).toContain("min-width: 0");
      expect(rule).not.toMatch(/(?<![-\w])width:\s*\d+px/);
      expect(rule).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    });

    it("le bouton-icône est réinitialisé (fond transparent, sans bordure) et fait au moins 32 px", () => {
      const rule = rulesFor(BTN).join(" ");
      expect(rule).toMatch(/background:\s*transparent/);
      expect(rule).toMatch(/border:\s*0|border:\s*none/);
      expect(rule).toMatch(/min-height:\s*32px/);
      expect(rule).toMatch(/min-width:\s*32px/);
      expect(rule).toContain("justify-content: center");
    });

    it("focus visible fort au clavier", () => {
      expect(rulesFor(`${BTN}:focus-visible`).join(" ")).toContain(FOCUS);
    });

    it("aria-disabled : estompé et non cliquable, mais reste focalisable (pas de pointer-events: none)", () => {
      const rule = rulesFor(`${BTN}[aria-disabled="true"]`).join(" ");
      expect(rule).toMatch(/opacity:\s*0?\.\d+/);
      expect(rule).toContain("cursor: not-allowed");
      expect(rule).not.toContain("pointer-events");
    });

    it("[hidden] respecté (le display du bouton ne le masque pas)", () => {
      expect(rulesFor(`${BTN}[hidden]`).join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-count[hidden]").join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-icons .search__path[hidden]").join(" ")).toContain("display: none");
    });

    it("l'étiquette de chemin s'abrège avec une ellipse et peut rétrécir ; le padding natif de droite est annulé", () => {
      const rule = rulesFor(".docseeker-icons .search__path").join(" ");
      expect(rule).toContain("overflow: hidden");
      expect(rule).toContain("text-overflow: ellipsis");
      expect(rule).toContain("white-space: nowrap");
      expect(rule).toContain("min-width: 0");
      expect(rule).toMatch(/padding-right:\s*0/);
      expect(rule).toMatch(/max-width:\s*100%/);
    });

    it("couleurs forcées : focus Highlight, bouton désactivé GrayText", () => {
      expect(forced()).toContain(`${BTN}:focus-visible`);
      expect(forced()).toMatch(/\.docseeker-icons \.block__icon\[aria-disabled="true"\][^}]*GrayText/);
    });

    it("les anciennes règles du select de tri, de la case, du <details> et des boutons texte ont disparu", () => {
      for (const gone of [".docseeker-sort", ".docseeker-group", ".docseeker-view-options", ".docseeker-filters", ".docseeker-expand-all", ".docseeker-collapse-all", "docseeker-filter-check"]) {
        expect(SEARCH_CSS, gone).not.toContain(gone);
      }
    });

    it("la barre reste un flex qui passe à la ligne", () => {
      const rule = rulesFor(".docseeker-toolbar").join(" ");
      expect(rule).toContain("display: flex");
      expect(rule).toContain("flex-wrap: wrap");
    });

    it("la largeur max d'une carte plate reste liée à la variable --docseeker-thumb-width", () => {
      expect(rulesFor(".docseeker-search").join(" ")).toMatch(/--docseeker-thumb-width:\s*120px/);
      expect(rulesFor(".docseeker-thumb").join(" ")).toContain("width: var(--docseeker-thumb-width)");
      expect(rulesFor(".docseeker-card--flat").join(" ")).toMatch(/max-width:\s*calc\(var\(--docseeker-thumb-width\)\s*\+\s*\d+px\)/);
      expect(SEARCH_CSS).not.toContain("136px");
    });
  });

  describe("dialogue des filtres", () => {
    it("la grille s'adapte à la largeur, sans largeur fixe", () => {
      const rule = rulesFor(".docseeker-filter-grid").join(" ");
      expect(rule).toContain("repeat(auto-fit, minmax(min(100%, 140px), 1fr))");
      expect(rule).not.toMatch(/(?<![-\w])width:\s*\d+px/);
    });

    it("les champs se plient à la largeur de leur cellule et font au moins 32 px", () => {
      const rule = rulesFor(".docseeker-filter-field input").join(" ");
      expect(rule).toContain("width: 100%");
      expect(rule).toContain("box-sizing: border-box");
      expect(rule).toMatch(/min-height:\s*32px/);
      expect(rule).not.toMatch(/(?<![-\w])width:\s*\d+px/);
      expect(rulesFor(".docseeker-filter-field input:focus-visible").join(" ")).toContain(FOCUS);
    });

    it("erreur et champ invalide : couleur d'erreur du thème ; l'erreur masquée n'occupe rien", () => {
      expect(rulesFor(".docseeker-filter-error").join(" ")).toContain("var(--b3-theme-error)");
      expect(rulesFor('.docseeker-filter-field [aria-invalid="true"]').join(" ")).toContain("var(--b3-theme-error)");
      expect(rulesFor(".docseeker-filter-error[hidden]").join(" ")).toContain("display: none");
    });

    it("boutons de réinitialisation : 32 px, focus visible, aria-disabled estompé", () => {
      for (const sel of [".docseeker-filter-reset", ".docseeker-reset-filters"]) {
        expect(rulesFor(sel).join(" "), sel).toMatch(/min-height:\s*32px/);
        expect(rulesFor(`${sel}:focus-visible`).join(" "), sel).toContain(FOCUS);
      }
      expect(rulesFor('.docseeker-filter-reset[aria-disabled="true"]').join(" ")).toContain("cursor: not-allowed");
      expect(rulesFor(".docseeker-reset-filters[hidden]").join(" ")).toContain("display: none");
    });

    it("couleurs forcées : champ invalide, focus et bouton désactivé", () => {
      const block = SEARCH_CSS.slice(SEARCH_CSS.indexOf("@media (forced-colors: active)"));
      expect(block).toContain(".docseeker-filter-field input:focus-visible");
      expect(block).toContain('.docseeker-filter-field [aria-invalid="true"]');
      expect(block).toContain('.docseeker-filter-reset[aria-disabled="true"]');
    });
  });

  describe("liste plate", () => {
    it("cartes en flux, titre à capacité limitée, pied de liste", () => {
      expect(rulesFor(".docseeker-list--flat").join(" ")).toMatch(/display:\s*flex/);
      expect(rulesFor(".docseeker-list--flat").join(" ")).toContain("flex-wrap: wrap");
      expect(rulesFor(".docseeker-card-title").join(" ")).toMatch(/overflow-wrap:\s*anywhere|text-overflow/);
      expect(rulesFor(".docseeker-flat-item").join(" ")).toContain("min-width: 0");
      expect(rulesFor(".docseeker-flat-more").join(" ")).toMatch(/min-height:\s*32px/);
      expect(rulesFor(".docseeker-flat-more:focus-visible").join(" ")).toContain(FOCUS);
      expect(rulesFor(".docseeker-flat-more[hidden]").join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-flat-footer[hidden]").join(" ")).toContain("display: none");
      expect(rulesFor(".docseeker-flat-footer").join(" ")).toMatch(/display:\s*flex/);
    });
  });
});

describe("SEARCH_CSS : champ de recherche, icône d'historique et croix (10f)", () => {
  const ICON = ".docseeker-search-box .docseeker-history-icon";
  const CLEAR = ".docseeker-search-box .docseeker-clear";

  it("le conteneur du champ est le repère de positionnement des deux icônes", () => {
    expect(rulesFor(".docseeker-search-box").join(" ")).toMatch(/position:\s*relative/);
  });

  it("l'icône d'historique est posée à gauche dans le champ, la croix à droite, chacune d'au moins 32 px", () => {
    const icon = rulesFor(ICON).join(" ");
    expect(icon).toMatch(/position:\s*absolute/);
    expect(icon).toMatch(/left:\s*0/);
    expect(icon).toMatch(/min-width:\s*32px/);
    const clear = rulesFor(CLEAR).join(" ");
    expect(clear).toMatch(/position:\s*absolute/);
    expect(clear).toMatch(/right:\s*0/);
    expect(clear).toMatch(/min-width:\s*32px/);
    for (const rule of [icon, clear]) {
      expect(rule).toMatch(/background:\s*transparent/);
      expect(rule).toMatch(/border:\s*0|border:\s*none/);
      expect(rule).toMatch(/top:\s*0/);
      expect(rule).toMatch(/bottom:\s*0/);
    }
  });

  it("le champ laisse la place aux deux icônes (padding gauche et droit) sans largeur fixe", () => {
    const rule = rulesFor('.docseeker-search-box input[type="search"]').join(" ");
    expect(rule).toMatch(/padding-left:\s*\d+px/);
    expect(rule).toMatch(/padding-right:\s*\d+px/);
    expect(rule).not.toMatch(/(?<![-\w])width:\s*\d+px/);
  });

  it("focus visible fort pour l'icône et la croix, et [hidden] respecté pour la croix", () => {
    expect(rulesFor(`${ICON}:focus-visible`).join(" ")).toContain(FOCUS);
    expect(rulesFor(`${CLEAR}:focus-visible`).join(" ")).toContain(FOCUS);
    expect(rulesFor(`${CLEAR}[hidden]`).join(" ")).toContain("display: none");
  });

  it("la croix native du type=search est masquée (une seule croix)", () => {
    expect(SEARCH_CSS).toMatch(/input\[type="search"\]::-webkit-search-cancel-button\s*\{[^}]*display:\s*none/);
  });

  it("couleurs forcées : focus de l'icône et de la croix en Highlight", () => {
    const block = SEARCH_CSS.slice(SEARCH_CSS.indexOf("@media (forced-colors: active)"));
    expect(block).toContain(`${ICON}:focus-visible`);
    expect(block).toContain(`${CLEAR}:focus-visible`);
  });

  it("plus aucune règle pour la liste d'historique maison", () => {
    for (const gone of ["docseeker-history-list", "docseeker-history-option", "docseeker-history-toggle", "docseeker-history-clear"]) {
      expect(SEARCH_CSS, gone).not.toContain(gone);
    }
  });
});

describe("ensureSearchStyle : la feuille sert aussi aux dialogues (hors de la vue)", () => {
  const countStyles = (): number => document.querySelectorAll(`style#${SEARCH_STYLE_ID}`).length;
  const mount = (host: HTMLElement) =>
    mountSearchView(host, {
      controller: { submit: () => undefined, getViewModel: () => ({ kind: "empty-query" }) },
      subscribe: () => () => undefined,
      thumbnails: { attach: () => () => undefined },
      onOpen: () => undefined,
      getDocMeta: () => undefined,
    });

  it("idempotent : deux appels, une seule feuille, avec le CSS complet", () => {
    document.head.innerHTML = "";
    ensureSearchStyle(document);
    ensureSearchStyle(document);
    expect(countStyles()).toBe(1);
    expect(document.getElementById(SEARCH_STYLE_ID)!.textContent).toBe(SEARCH_CSS);
  });

  it("le dispose de la DERNIÈRE vue ne retire pas la feuille (un dialogue qui s'ouvre ou se détruit encore en a besoin)", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = mount(host);
    expect(countStyles()).toBe(1);
    view.dispose();
    expect(countStyles()).toBe(1);
  });

  it("deux vues : une seule feuille, toujours là après le dispose des deux", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const [a, b] = [document.createElement("div"), document.createElement("div")];
    document.body.append(a, b);
    const [one, two] = [mount(a), mount(b)];
    expect(countStyles()).toBe(1);
    one.dispose();
    two.dispose();
    expect(countStyles()).toBe(1);
  });
});

describe("SEARCH_CSS : dialogue des critères enregistrés", () => {
  it("le résumé est discret, retourne à la ligne et reste lisible (couleur du thème, pas de débordement)", () => {
    const rule = rulesFor(".docseeker-criteria-summary").join(" ");
    expect(rule).toContain("overflow-wrap: anywhere");
    expect(rule).toContain("var(--b3-theme-on-surface)");
    expect(rule).toMatch(/font-size:\s*12px/);
  });
});
