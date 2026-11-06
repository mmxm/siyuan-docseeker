import { describe, expect, it } from "vitest";
import {
  docBoundaryIndex,
  navigableIndices,
  nextCardIndex,
  nextHistoryIndex,
  resolveHistoryKey,
  resolveKey,
  type KeyInput,
  type NavAction,
  type Rect,
} from "../../../src/ui/keyboardNav";

const NONE: NavAction = { type: "none" };
const CONSUME: NavAction = { type: "consume" };
const move = (direction: "up" | "down" | "left" | "right" | "first" | "last" | "prevDoc" | "nextDoc"): NavAction => ({
  type: "move",
  direction,
});

describe("resolveKey : contexte carte", () => {
  const cases: readonly [string, Partial<KeyInput>, NavAction][] = [
    ["ArrowDown", {}, move("down")],
    ["ArrowUp", {}, move("up")],
    ["ArrowLeft", {}, move("left")],
    ["ArrowRight", {}, move("right")],
    ["Home", {}, move("first")],
    ["End", {}, move("last")],
    ["PageUp", {}, move("prevDoc")],
    ["PageDown", {}, move("nextDoc")],
    ["Enter", {}, { type: "open", alternate: false }],
    ["Enter", { ctrlKey: true }, { type: "open", alternate: true }],
    ["Enter", { metaKey: true }, { type: "open", alternate: true }],
    ["Escape", {}, { type: "backToInput" }],
    // Modificateurs : rien n'est intercepté (sauf Ctrl/Cmd+Entrée).
    ["ArrowDown", { ctrlKey: true }, NONE],
    ["ArrowDown", { metaKey: true }, NONE],
    ["ArrowDown", { altKey: true }, NONE],
    ["ArrowDown", { shiftKey: true }, NONE],
    ["ArrowLeft", { altKey: true }, NONE],
    ["Home", { ctrlKey: true }, NONE],
    ["End", { metaKey: true }, NONE],
    ["PageDown", { altKey: true }, NONE],
    // Alt+Entrée = ouvrir à droite (comme Alt+clic) ; Maj+Entrée : rien n'est ouvert mais la touche est
    // consommée (sinon le bouton déclenche un clic natif).
    ["Enter", { altKey: true }, { type: "open", alternate: true }],
    ["Enter", { ctrlKey: true, altKey: true }, { type: "open", alternate: true }],
    ["Enter", { shiftKey: true }, CONSUME],
    ["Enter", { ctrlKey: true, shiftKey: true }, CONSUME],
    ["Enter", { altKey: true, shiftKey: true }, CONSUME],
    ["Escape", { ctrlKey: true }, NONE],
    ["Escape", { altKey: true }, NONE],
    // Composition IME : rien, même Entrée.
    ["Enter", { isComposing: true }, NONE],
    ["Enter", { isComposing: true, ctrlKey: true }, NONE],
    ["ArrowDown", { isComposing: true }, NONE],
    ["Escape", { isComposing: true }, NONE],
    // Touches non gérées.
    ["Tab", {}, NONE],
    ["a", {}, NONE],
    [" ", {}, NONE],
    ["Delete", {}, NONE],
  ];
  it.each(cases)("%s %j -> action attendue", (key, mods, expected) => {
    expect(resolveKey({ key, ...mods }, "card")).toEqual(expected);
  });
});

describe("resolveKey : contexte champ", () => {
  const cases: readonly [string, Partial<KeyInput>, NavAction][] = [
    ["Enter", {}, { type: "submit" }],
    ["ArrowDown", {}, move("down")],
    ["ArrowDown", { altKey: true }, { type: "openHistory" }],
    ["Escape", {}, { type: "clear" }],
    // Pas d'interception avec Ctrl/Cmd/Alt hors Alt+Bas.
    ["Enter", { ctrlKey: true }, NONE],
    ["Enter", { metaKey: true }, NONE],
    ["Enter", { altKey: true }, NONE],
    ["Enter", { shiftKey: true }, NONE],
    ["Escape", { shiftKey: true }, NONE],
    ["ArrowDown", { ctrlKey: true }, NONE],
    ["ArrowDown", { metaKey: true }, NONE],
    ["ArrowDown", { shiftKey: true }, NONE],
    ["ArrowDown", { altKey: true, ctrlKey: true }, NONE],
    ["ArrowDown", { altKey: true, shiftKey: true }, NONE],
    ["Escape", { ctrlKey: true }, NONE],
    ["Escape", { altKey: true }, NONE],
    // Les autres flèches et Début/Fin restent au champ de texte.
    ["ArrowUp", {}, NONE],
    ["ArrowLeft", {}, NONE],
    ["ArrowRight", {}, NONE],
    ["Home", {}, NONE],
    ["End", {}, NONE],
    ["PageDown", {}, NONE],
    // Composition IME.
    ["Enter", { isComposing: true }, NONE],
    ["ArrowDown", { isComposing: true }, NONE],
    ["ArrowDown", { altKey: true, isComposing: true }, NONE],
    ["Escape", { isComposing: true }, NONE],
    ["a", {}, NONE],
  ];
  it.each(cases)("%s %j -> action attendue", (key, mods, expected) => {
    expect(resolveKey({ key, ...mods }, "input")).toEqual(expected);
  });
});

describe("resolveHistoryKey", () => {
  const cases: readonly [string, Partial<KeyInput>, ReturnType<typeof resolveHistoryKey>][] = [
    ["ArrowDown", {}, { type: "move", direction: "next" }],
    ["ArrowUp", {}, { type: "move", direction: "prev" }],
    ["Enter", {}, { type: "choose" }],
    ["Escape", {}, { type: "close", consume: true }],
    ["Tab", {}, { type: "close", consume: false }],
    ["Delete", { shiftKey: true }, { type: "removeActive" }],
    ["Delete", {}, { type: "none" }],
    ["ArrowDown", { altKey: true }, { type: "none" }],
    ["ArrowDown", { ctrlKey: true }, { type: "none" }],
    ["ArrowUp", { metaKey: true }, { type: "none" }],
    ["Enter", { ctrlKey: true }, { type: "none" }],
    ["Escape", { altKey: true }, { type: "none" }],
    ["Enter", { isComposing: true }, { type: "none" }],
    ["Escape", { isComposing: true }, { type: "none" }],
    ["ArrowDown", { isComposing: true }, { type: "none" }],
    ["ArrowLeft", {}, { type: "none" }],
    ["a", {}, { type: "none" }],
  ];
  it.each(cases)("%s %j", (key, mods, expected) => {
    expect(resolveHistoryKey({ key, ...mods })).toEqual(expected);
  });
});

describe("nextHistoryIndex", () => {
  it("avance depuis « aucune » sur la première requête", () => {
    expect(nextHistoryIndex(-1, 3, "next")).toBe(0);
  });
  it("recule depuis « aucune » sur la DERNIÈRE requête, pas sur « Supprimer tout »", () => {
    expect(nextHistoryIndex(-1, 3, "prev")).toBe(2);
  });
  it("parcourt les requêtes puis « Supprimer tout » (index = nombre de requêtes), puis reboucle", () => {
    expect(nextHistoryIndex(0, 3, "next")).toBe(1);
    expect(nextHistoryIndex(2, 3, "next")).toBe(3);
    expect(nextHistoryIndex(3, 3, "next")).toBe(0);
  });
  it("reboucle vers l'arrière", () => {
    expect(nextHistoryIndex(1, 3, "prev")).toBe(0);
    expect(nextHistoryIndex(0, 3, "prev")).toBe(3);
    expect(nextHistoryIndex(3, 3, "prev")).toBe(2);
  });
  it("une seule requête", () => {
    expect(nextHistoryIndex(-1, 1, "next")).toBe(0);
    expect(nextHistoryIndex(-1, 1, "prev")).toBe(0);
    expect(nextHistoryIndex(0, 1, "next")).toBe(1);
    expect(nextHistoryIndex(1, 1, "next")).toBe(0);
  });
  it("aucune requête : aucune option active", () => {
    expect(nextHistoryIndex(-1, 0, "next")).toBe(-1);
    expect(nextHistoryIndex(-1, 0, "prev")).toBe(-1);
  });
});

const rect = (left: number, top: number, width = 120, height = 80): Rect => ({ left, top, width, height });
/** Grille 3 x 2 (observée dans SiYuan : tops 282 et 367, lefts 302/442/582). */
const GRID: Rect[] = [
  rect(302, 282), rect(442, 282), rect(582, 282),
  rect(302, 367), rect(442, 367), rect(582, 367),
];
const ZERO: Rect = { top: 0, left: 0, width: 0, height: 0 };

describe("nextCardIndex", () => {
  it("Bas va à la carte du DESSOUS, pas à la suivante du DOM", () => {
    expect(nextCardIndex(GRID, 0, "down")).toBe(3);
    expect(nextCardIndex(GRID, 1, "down")).toBe(4);
    expect(nextCardIndex(GRID, 2, "down")).toBe(5);
  });
  it("Haut est symétrique", () => {
    expect(nextCardIndex(GRID, 3, "up")).toBe(0);
    expect(nextCardIndex(GRID, 4, "up")).toBe(1);
    expect(nextCardIndex(GRID, 5, "up")).toBe(2);
  });
  it("dernière ligne : Bas ne donne rien (pas de bouclage)", () => {
    expect(nextCardIndex(GRID, 3, "down")).toBeUndefined();
    expect(nextCardIndex(GRID, 5, "down")).toBeUndefined();
  });
  it("première ligne : Haut ne donne rien (la vue passera au champ)", () => {
    expect(nextCardIndex(GRID, 0, "up")).toBeUndefined();
    expect(nextCardIndex(GRID, 2, "up")).toBeUndefined();
  });
  it("une seule carte", () => {
    expect(nextCardIndex([rect(0, 0)], 0, "down")).toBeUndefined();
    expect(nextCardIndex([rect(0, 0)], 0, "up")).toBeUndefined();
  });
  it("ligne du dessous plus courte : centre horizontal le plus proche", () => {
    const rects = [rect(0, 0), rect(140, 0), rect(280, 0), rect(0, 100)];
    expect(nextCardIndex(rects, 2, "down")).toBe(3); // seule carte du dessous
    const rects2 = [rect(0, 0), rect(140, 0), rect(280, 0), rect(140, 100)];
    expect(nextCardIndex(rects2, 2, "down")).toBe(3);
    expect(nextCardIndex(rects2, 0, "down")).toBe(3);
  });
  it("choisit le centre le plus proche, à égalité la plus à gauche", () => {
    const rects = [rect(100, 0), rect(0, 100), rect(200, 100)]; // centres 160 ; 60 et 260
    expect(nextCardIndex(rects, 0, "down")).toBe(1);
  });
  it("origine {left:0,width:200} (centre 100) : candidates de centres 30/100/170 dans le désordre", () => {
    const origin = rect(0, 0, 200);
    const c170 = rect(110, 100, 120); // centre 170
    const c30 = rect(-30, 100, 120); // centre 30
    const c100 = rect(40, 100, 120); // centre 100
    expect(nextCardIndex([origin, c170, c30, c100], 0, "down")).toBe(3);
    expect(nextCardIndex([origin, c100, c170, c30], 0, "down")).toBe(1);
    expect(nextCardIndex([origin, c30, c100, c170], 0, "down")).toBe(2);
  });
  it("même centre, largeurs différentes : la plus à gauche (par left), pas la première du DOM", () => {
    const origin = rect(0, 0, 200); // centre 100
    const narrow = rect(70, 100, 60); // centre 100, left 70
    const wide = rect(0, 100, 200); // centre 100, left 0
    expect(nextCardIndex([origin, narrow, wide], 0, "down")).toBe(2);
    expect(nextCardIndex([origin, wide, narrow], 0, "down")).toBe(1);
  });
  it("égalité de distance (centres 50 et 150, origine 100) avec le DOM inversé : la plus à gauche par left", () => {
    const origin = rect(40, 0, 120); // centre 100
    const left = rect(-10, 100, 120); // centre 50
    const right = rect(90, 100, 120); // centre 150
    expect(nextCardIndex([origin, right, left], 0, "down")).toBe(2);
    expect(nextCardIndex([origin, left, right], 0, "down")).toBe(1);
  });
  it("dernière ligne incomplète (3 colonnes, 1 carte) : depuis les colonnes 2 et 3, la seule carte; Haut en revient", () => {
    const rects = [rect(0, 0), rect(140, 0), rect(280, 0), rect(0, 100)];
    expect(nextCardIndex(rects, 1, "down")).toBe(3);
    expect(nextCardIndex(rects, 2, "down")).toBe(3);
    expect(nextCardIndex(rects, 3, "up")).toBe(0); // colonne 1
  });
  it("Haut depuis une ligne incomplète : centre le plus proche de la ligne complète", () => {
    const rects = [rect(0, 0), rect(140, 0), rect(280, 0), rect(150, 100)]; // dernière carte sous la colonne 2
    expect(nextCardIndex(rects, 3, "up")).toBe(1);
  });
  it("tolérance de 2 px : la même ligne n'est pas « en dessous »", () => {
    const rects = [rect(0, 100), rect(140, 102), rect(280, 200)];
    expect(nextCardIndex(rects, 0, "down")).toBe(2);
    const rects2 = [rect(0, 100), rect(140, 103), rect(280, 300)];
    expect(nextCardIndex(rects2, 0, "down")).toBe(1);
  });
  it("une ligne légèrement décalée (2 px) reste la même ligne pour le choix horizontal", () => {
    const rects = [rect(0, 0), rect(0, 100), rect(140, 101)];
    expect(nextCardIndex(rects, 0, "down")).toBe(1);
    expect(nextCardIndex([rect(140, 0), rect(0, 100), rect(140, 101)], 0, "down")).toBe(2);
  });
  it("saute les lignes vides : prend la première ligne strictement en dessous", () => {
    const rects = [rect(0, 0), rect(0, 500), rect(0, 100)];
    expect(nextCardIndex(rects, 0, "down")).toBe(2);
    expect(nextCardIndex(rects, 1, "up")).toBe(2);
  });
  it("cartes de documents différents : la ligne du document suivant est la ligne du dessous", () => {
    // doc A : 2 cartes (ligne 282), doc B : 2 cartes (ligne 420, après l'en-tête).
    const rects = [rect(302, 282), rect(442, 282), rect(302, 420), rect(442, 420)];
    expect(nextCardIndex(rects, 1, "down")).toBe(3);
    expect(nextCardIndex(rects, 2, "up")).toBe(0);
  });
  it("tous les rectangles nuls (jsdom, masqués) : repli sur l'ordre linéaire du DOM", () => {
    const zeros = [ZERO, ZERO, ZERO];
    expect(nextCardIndex(zeros, 0, "down")).toBe(1);
    expect(nextCardIndex(zeros, 1, "down")).toBe(2);
    expect(nextCardIndex(zeros, 2, "down")).toBeUndefined();
    expect(nextCardIndex(zeros, 2, "up")).toBe(1);
    expect(nextCardIndex(zeros, 0, "up")).toBeUndefined();
  });
  it("une carte masquée (rectangle nul) n'est jamais choisie quand les autres ont une géométrie", () => {
    const rects = [rect(0, 0), ZERO, rect(0, 100)];
    expect(nextCardIndex(rects, 0, "down")).toBe(2);
    expect(nextCardIndex(rects, 2, "up")).toBe(0);
  });
  it("départ mesuré mais toutes les voisines nulles : rien (jamais une carte masquée)", () => {
    const rects = [rect(0, 0), ZERO, ZERO];
    expect(nextCardIndex(rects, 0, "down")).toBeUndefined();
    expect(nextCardIndex(rects, 0, "up")).toBeUndefined();
  });
  it.each([
    ["largeur nulle seule", { top: 100, left: 0, width: 0, height: 80 }],
    ["hauteur nulle seule", { top: 100, left: 0, width: 120, height: 0 }],
    ["largeur négative", { top: 100, left: 0, width: -5, height: 80 }],
    ["hauteur négative", { top: 100, left: 0, width: 120, height: -5 }],
    ["NaN", { top: NaN, left: 0, width: 120, height: 80 }],
    ["left NaN", { top: 100, left: NaN, width: 120, height: 80 }],
    ["Infinity", { top: 100, left: 0, width: Infinity, height: 80 }],
  ] as [string, Rect][])("carte à demi nulle ou non finie ignorée : %s", (_name, bad) => {
    const rects = [rect(0, 0), bad, rect(0, 200)];
    expect(nextCardIndex(rects, 0, "down")).toBe(2);
    expect(nextCardIndex(rects, 2, "up")).toBe(0);
    expect(nextCardIndex([rect(0, 0), bad], 0, "down")).toBeUndefined();
  });
  it("la carte de départ masquée avec des voisines mesurées : repli linéaire", () => {
    const rects = [rect(0, 0), ZERO, rect(0, 100)];
    expect(nextCardIndex(rects, 1, "down")).toBe(2);
    expect(nextCardIndex(rects, 1, "up")).toBe(0);
  });
  it("index de départ hors bornes ou liste vide : rien", () => {
    expect(nextCardIndex([], 0, "down")).toBeUndefined();
    expect(nextCardIndex(GRID, -1, "down")).toBeUndefined();
    expect(nextCardIndex(GRID, 6, "up")).toBeUndefined();
  });
});

describe("docBoundaryIndex", () => {
  const ids = ["a", "a", "b", "b", "b", "c"];
  it("Page bas : première carte du document suivant", () => {
    expect(docBoundaryIndex(ids, 0, "next")).toBe(2);
    expect(docBoundaryIndex(ids, 3, "next")).toBe(5);
  });
  it("Page haut : première carte du document précédent", () => {
    expect(docBoundaryIndex(ids, 5, "prev")).toBe(2);
    expect(docBoundaryIndex(ids, 3, "prev")).toBe(0);
  });
  it("aux bords : rien", () => {
    expect(docBoundaryIndex(ids, 5, "next")).toBeUndefined();
    expect(docBoundaryIndex(ids, 0, "prev")).toBeUndefined();
    expect(docBoundaryIndex(ids, 1, "prev")).toBeUndefined();
  });
  it("un seul document ou index invalide : rien", () => {
    expect(docBoundaryIndex(["a", "a"], 0, "next")).toBeUndefined();
    expect(docBoundaryIndex(ids, -1, "next")).toBeUndefined();
    expect(docBoundaryIndex(ids, 9, "prev")).toBeUndefined();
  });
});

describe("navigableIndices", () => {
  it("écarte les cartes masquées ou non finies", () => {
    expect(navigableIndices([rect(0, 0), ZERO, rect(0, 100), { top: NaN, left: 0, width: 1, height: 1 }], 0)).toEqual([0, 2]);
  });
  it("garde toujours la carte de départ, même masquée", () => {
    expect(navigableIndices([rect(0, 0), ZERO, rect(0, 100)], 1)).toEqual([0, 1, 2]);
  });
  it("aucune carte mesurée (jsdom) : toutes, dans l'ordre du DOM", () => {
    expect(navigableIndices([ZERO, ZERO, ZERO], 1)).toEqual([0, 1, 2]);
  });
});
