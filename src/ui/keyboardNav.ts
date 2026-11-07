/**
 * Navigation au clavier de l'onglet de recherche : fonctions PURES (aucun accès au DOM).
 * La vue lit les événements, appelle ces fonctions, exécute l'action et n'appelle `preventDefault`
 * que si l'action a réellement eu lieu.
 */

export interface KeyInput {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

export type MoveDirection = "up" | "down" | "left" | "right" | "first" | "last" | "prevDoc" | "nextDoc";

export type NavAction =
  | { readonly type: "move"; readonly direction: MoveDirection }
  /** `alternate` : ouvrir à droite (Ctrl/Cmd/Alt+Entrée, comme Alt+clic). */
  | { readonly type: "open"; readonly alternate: boolean }
  /** Champ : lancer la recherche. */
  | { readonly type: "submit" }
  /** Champ : ouvrir le menu d'historique (Alt+Bas). */
  | { readonly type: "openHistory" }
  /** Carte : revenir au champ SANS le vider. */
  | { readonly type: "backToInput" }
  /** Champ : vider la saisie et relancer la requête vide. */
  | { readonly type: "clear" }
  /** Carte : touche consommée sans rien faire (Maj+Entrée), pour empêcher le clic natif du bouton. */
  | { readonly type: "consume" }
  | { readonly type: "none" };

export type KeyContext = "input" | "card";

const NONE: NavAction = { type: "none" };
const CONSUME: NavAction = { type: "consume" };

const CARD_MOVES: Readonly<Record<string, MoveDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "first",
  End: "last",
  PageUp: "prevDoc",
  PageDown: "nextDoc",
};

/** Action associée à une touche, selon que le focus est dans le champ ou sur une carte. */
export function resolveKey(e: KeyInput, context: KeyContext): NavAction {
  if (e.isComposing) return NONE;
  const ctrl = e.ctrlKey === true || e.metaKey === true;
  const alt = e.altKey === true;
  const shift = e.shiftKey === true;
  if (context === "input") {
    if (e.key === "ArrowDown" && alt && !ctrl && !shift) return { type: "openHistory" };
    if (ctrl || alt || shift) return NONE;
    if (e.key === "Enter") return { type: "submit" };
    if (e.key === "Escape") return { type: "clear" };
    if (e.key === "ArrowDown") return { type: "move", direction: "down" };
    return NONE;
  }
  if (e.key === "Enter") {
    // Une carte est un bouton : Entrée non annulée y déclenche un clic natif, donc toute combinaison
    // d'Entrée est décidée ici. Maj+Entrée n'ouvre rien mais est consommée.
    if (shift) return CONSUME;
    return { type: "open", alternate: ctrl || alt };
  }
  if (ctrl || alt || shift) return NONE;
  if (e.key === "Escape") return { type: "backToInput" };
  const direction = CARD_MOVES[e.key];
  return direction ? { type: "move", direction } : NONE;
}

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Deux bords « top » à moins de ce nombre de pixels sont sur la même ligne. */
export const ROW_TOLERANCE_PX = 2;

/** Rectangle exploitable : quatre valeurs finies et une surface non nulle (un seul côté nul = masquée). */
const isMeasured = (r: Rect): boolean =>
  Number.isFinite(r.top) && Number.isFinite(r.left) && Number.isFinite(r.width) && Number.isFinite(r.height) &&
  r.width > 0 && r.height > 0;
const centerX = (r: Rect): number => r.left + r.width / 2;

/**
 * Indices des cartes sur lesquelles se déplacer : les cartes mesurées (non masquées) plus la carte de départ.
 * Si aucune n'est mesurée (jsdom, tout masqué), toutes, dans l'ordre du DOM.
 */
export function navigableIndices(rects: readonly Rect[], from: number): number[] {
  const all = rects.map((_, i) => i);
  if (!rects.some(isMeasured)) return all;
  return all.filter((i) => i === from || isMeasured(rects[i]!));
}

/**
 * Carte voisine en haut ou en bas, d'après la géométrie : première ligne strictement au-dessus / en dessous,
 * puis carte dont le centre horizontal est le plus proche ; à égalité de distance, celle dont le bord gauche
 * (`left`) est le plus petit, puis la première du DOM.
 * Cartes masquées (un côté nul, négatif ou non fini) : jamais choisies. Si la carte de départ n'est pas
 * mesurée, repli sur l'ordre du DOM ; si elle l'est mais que toutes les autres sont masquées : pas de voisin.
 * `undefined` : pas de voisin (bord de la liste).
 */
export function nextCardIndex(rects: readonly Rect[], from: number, direction: "up" | "down"): number | undefined {
  if (!Number.isInteger(from) || from < 0 || from >= rects.length) return undefined;
  const origin = rects[from]!;
  if (!isMeasured(origin)) {
    const target = direction === "down" ? from + 1 : from - 1;
    return target >= 0 && target < rects.length ? target : undefined;
  }
  const down = direction === "down";
  const candidates: number[] = [];
  rects.forEach((r, i) => {
    if (i === from || !isMeasured(r)) return;
    if (down ? r.top > origin.top + ROW_TOLERANCE_PX : r.top < origin.top - ROW_TOLERANCE_PX) candidates.push(i);
  });
  if (candidates.length === 0) return undefined;
  const rowTop = down
    ? Math.min(...candidates.map((i) => rects[i]!.top))
    : Math.max(...candidates.map((i) => rects[i]!.top));
  const row = candidates.filter((i) => Math.abs(rects[i]!.top - rowTop) <= ROW_TOLERANCE_PX);
  const x = centerX(origin);
  let best = row[0]!;
  for (const i of row) {
    const gap = Math.abs(centerX(rects[i]!) - x);
    const bestGap = Math.abs(centerX(rects[best]!) - x);
    if (gap < bestGap || (gap === bestGap && rects[i]!.left < rects[best]!.left)) best = i;
  }
  return best;
}

/** Première carte du document précédent / suivant (`docIds` : un identifiant par carte, dans l'ordre du DOM). */
export function docBoundaryIndex(docIds: readonly string[], from: number, direction: "prev" | "next"): number | undefined {
  if (!Number.isInteger(from) || from < 0 || from >= docIds.length) return undefined;
  const current = docIds[from];
  if (direction === "next") {
    for (let i = from + 1; i < docIds.length; i += 1) if (docIds[i] !== current) return i;
    return undefined;
  }
  let i = from;
  while (i >= 0 && docIds[i] === current) i -= 1; // dernière carte du document précédent
  if (i < 0) return undefined;
  const previous = docIds[i];
  while (i > 0 && docIds[i - 1] === previous) i -= 1;
  return i;
}
