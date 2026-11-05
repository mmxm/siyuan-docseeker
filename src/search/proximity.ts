/**
 * Proximité des mots de la requête et reclassement multi-termes, portés de search-core
 * (matching.rs : regroupement en occurrences ; processing.rs : bonus ; sql.rs : départage par titre).
 * Module pur, sans DOM.
 */
import { compareCodePoints } from "../core/bm25";
import type { WordBox } from "../core/codec/format";
import {
  ASSUMED_PAGE_WIDTH_PT,
  MULTI_TERMS_ALL_MATCHED_BONUS,
  MULTI_TERMS_PARTIAL_MATCHED_BONUS,
  OCCURRENCE_MAX_GAP_PT,
  SAME_LINE_OVERLAP,
} from "../core/constants";

export interface Occurrence {
  /** Nombre de mots de la requête distincts dans l'occurrence. */
  readonly distinct: number;
  /** Ordinaux des mots de l'occurrence, en ordre de lecture. */
  readonly ordinals: readonly number[];
}

function isSameVisualLine(prev: WordBox, next: WordBox): boolean {
  const minHeight = Math.min(prev.height, next.height);
  if (!(minHeight > 0)) return false;
  const overlap = Math.max(0, Math.min(prev.y + prev.height, next.y + next.height) - Math.max(prev.y, next.y));
  return overlap / minHeight >= SAME_LINE_OVERLAP;
}

function isAdjacent(prev: WordBox, next: WordBox): boolean {
  const gapPt = (next.x - (prev.x + prev.width)) * ASSUMED_PAGE_WIDTH_PT;
  return gapPt >= 0 && gapPt < OCCURRENCE_MAX_GAP_PT && isSameVisualLine(prev, next);
}

/**
 * Regroupe les mots trouvés (`ordinals` croissants, `termIndexes` parallèle) en occurrences :
 * un mot rejoint le groupe courant s'il est sur la même ligne visuelle que le mot précédent
 * et à moins de 25 pt à sa droite.
 */
export function groupOccurrences(
  boxes: readonly WordBox[],
  ordinals: readonly number[],
  termIndexes: readonly number[],
): readonly Occurrence[] {
  if (ordinals.length !== termIndexes.length) {
    throw new RangeError(`${ordinals.length} ordinals but ${termIndexes.length} term indexes`);
  }
  const groups: { terms: Set<number>; ordinals: number[]; last: WordBox }[] = [];
  ordinals.forEach((ordinal, i) => {
    const current = boxes[ordinal];
    if (!current) throw new RangeError(`Ordinal ${ordinal} outside the ${boxes.length} boxes`);
    const term = termIndexes[i] as number;
    const group = groups[groups.length - 1];
    if (group && isAdjacent(group.last, current)) {
      group.terms.add(term);
      group.ordinals.push(ordinal);
      group.last = current;
    } else {
      groups.push({ terms: new Set([term]), ordinals: [ordinal], last: current });
    }
  });
  return groups.map((g) => ({ distinct: g.terms.size, ordinals: g.ordinals }));
}

/** Bonus de score d'un document (processing.rs) ; `termCount` = nombre de mots de la requête. */
export function multiTermBonus(maxDistinct: number, termCount: number): number {
  if (termCount <= 1) return 0;
  if (maxDistinct >= termCount) return MULTI_TERMS_ALL_MATCHED_BONUS;
  if (maxDistinct >= 2) return (maxDistinct / termCount) * MULTI_TERMS_PARTIAL_MATCHED_BONUS;
  return 0;
}

/** Mots distincts décroissants, puis meilleur score de page (score élevé = meilleur), puis page croissante. */
export function orderTopPages<T extends { readonly page: number; readonly score: number }>(
  pages: readonly T[],
  distinctByPage: ReadonlyMap<number, number>,
): readonly T[] {
  const distinct = (p: T): number => distinctByPage.get(p.page) ?? 0;
  return [...pages].sort((a, b) => distinct(b) - distinct(a) || b.score - a.score || a.page - b.page);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Re-trie chaque fenêtre de `windowSize` documents consécutifs par (relevance + bonus) arrondi à 2 décimales
 * décroissant, puis titre croissant (ordre binaire). Tri stable ; les rangs hors fenêtre ne bougent pas.
 */
export function rerankWindows<T extends { readonly docId: string; readonly title: string; readonly relevance: number }>(
  docs: readonly T[],
  bonusByDoc: ReadonlyMap<string, number>,
  windowSize: number,
): readonly T[] {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new RangeError(`Invalid window size ${windowSize}`);
  const score = (d: T): number => round2(d.relevance + (bonusByDoc.get(d.docId) ?? 0));
  const out: T[] = [];
  for (let start = 0; start < docs.length; start += windowSize) {
    const window = docs
      .slice(start, start + windowSize)
      .map((doc) => ({ doc, score: score(doc) }))
      .sort((a, b) => b.score - a.score || compareCodePoints(a.doc.title, b.doc.title));
    out.push(...window.map((w) => w.doc));
  }
  return out;
}
