import { CROP_RENDER_SCALE, DEFAULT_CROP_HEIGHT, DEFAULT_CROP_WIDTH } from "../core/constants";
import {
  calculateCropBounds,
  highlightRectsInCrop,
  wordBoxesToPageRects,
  type CropBounds,
  type FractionBox,
  type PageRect,
  type PixelRect,
} from "../core/crop";

/** Words whose ordinals differ by at most this much belong to the same group. */
export const DEFAULT_MAX_ORDINAL_GAP = 8;

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface ThumbnailPlanOptions {
  readonly targetWidth?: number;
  readonly targetHeight?: number;
  readonly scale?: number;
  readonly maxOrdinalGap?: number;
  /**
   * Query-term index of each ordinal (parallel to `ordinals`). When present and aligned, the crop is the
   * page area covering the most distinct terms; otherwise the legacy "first close group" is used.
   */
  readonly termIndexes?: readonly number[];
}

/** Matched words considered as window anchors (more words are still highlighted when they fall in the crop). */
export const MAX_WINDOW_WORDS = 150;

interface TermWord {
  readonly ordinal: number;
  readonly term: number;
  readonly rect: PageRect;
}

interface Window {
  readonly terms: number;
  readonly words: number;
  readonly x0: number;
  readonly y0: number;
  readonly members: readonly TermWord[];
}

export interface ThumbnailPlan {
  /** Crop area in page points. */
  readonly crop: CropBounds;
  /** Highlight rectangles in crop pixels (crop origin subtracted, times scale). */
  readonly highlights: readonly PixelRect[];
  readonly scale: number;
}

function validOrdinals(ordinals: readonly number[], boxCount: number): number[] {
  const valid = ordinals.filter((o) => Number.isInteger(o) && o >= 0 && o < boxCount);
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

function firstGroup(sorted: readonly number[], maxGap: number): number[] {
  const group: number[] = [];
  for (const ordinal of sorted) {
    const last = group[group.length - 1];
    if (last !== undefined && ordinal - last > maxGap) break;
    group.push(ordinal);
  }
  return group;
}

function unionRect(rects: readonly PageRect[]): PageRect {
  return rects.reduce<PageRect>(
    (acc, [x0, y0, x1, y1]) => [Math.min(acc[0], x0), Math.min(acc[1], y0), Math.max(acc[2], x1), Math.max(acc[3], y1)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

const isIndex = (n: number): boolean => Number.isInteger(n) && n >= 0;

function termWords(
  boxes: readonly FractionBox[],
  ordinals: readonly number[],
  termIndexes: readonly number[],
  page: PageSize,
): TermWord[] {
  const byOrdinal = new Map<number, number>();
  ordinals.forEach((ordinal, i) => {
    const term = termIndexes[i] as number;
    if (!isIndex(ordinal) || ordinal >= boxes.length || !isIndex(term) || byOrdinal.has(ordinal)) return;
    byOrdinal.set(ordinal, term);
  });
  return [...byOrdinal.keys()]
    .sort((a, b) => a - b)
    .map((ordinal) => ({
      ordinal,
      term: byOrdinal.get(ordinal) as number,
      rect: wordBoxesToPageRects([boxes[ordinal] as FractionBox], page.width, page.height)[0] as PageRect,
    }));
}

function better(a: Window, b: Window | undefined): boolean {
  if (b === undefined) return true;
  if (a.terms !== b.terms) return a.terms > b.terms;
  if (a.words !== b.words) return a.words > b.words;
  if (a.y0 !== b.y0) return a.y0 < b.y0;
  return a.x0 < b.x0;
}

/** Tolerance for window edge comparisons (floating point rounding of `(edge - size) + size`). */
const EDGE_EPSILON = 1e-6;

/**
 * Anchors: one occurrence of each distinct term first, then the other words closest (by ordinal) to
 * those, up to the cap. Keeps a frequent term from crowding out the words next to a rare one.
 */
function selectAnchors(words: readonly TermWord[]): TermWord[] {
  if (words.length <= MAX_WINDOW_WORDS) return [...words];
  const chosen = new Set<TermWord>();
  const seen = new Set<number>();
  for (const word of words) {
    if (seen.has(word.term)) continue;
    seen.add(word.term);
    chosen.add(word);
  }
  const seeds = [...chosen];
  const distance = new Map<TermWord, number>();
  for (const word of words) {
    if (chosen.has(word)) continue;
    let d = Infinity;
    for (const seed of seeds) d = Math.min(d, Math.abs(word.ordinal - seed.ordinal));
    distance.set(word, d);
  }
  const rest = [...distance.keys()].sort((a, b) => (distance.get(a) as number) - (distance.get(b) as number) || a.ordinal - b.ordinal);
  for (const word of rest) {
    if (chosen.size >= Math.max(MAX_WINDOW_WORDS, seeds.length)) break;
    chosen.add(word);
  }
  return words.filter((word) => chosen.has(word));
}

function bestWindow(words: readonly TermWord[], page: PageSize, w: number, h: number): Window {
  const anchors = selectAnchors(words);
  const maxX = Math.max(0, page.width - w);
  const maxY = Math.max(0, page.height - h);
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const n = anchors.length;
  const x0s = new Float64Array(n);
  const y0s = new Float64Array(n);
  const x1s = new Float64Array(n);
  const y1s = new Float64Array(n);
  const termIds = new Int32Array(n);
  const denseTerms = new Map<number, number>();
  anchors.forEach(({ rect, term }, i) => {
    x0s[i] = rect[0];
    y0s[i] = rect[1];
    x1s[i] = rect[2];
    y1s[i] = rect[3];
    if (!denseTerms.has(term)) denseTerms.set(term, denseTerms.size);
    termIds[i] = denseTerms.get(term) as number;
  });
  const stamps = new Int32Array(denseTerms.size);
  let stamp = 0;

  const yOrigins = new Set<number>();
  for (let i = 0; i < n; i++) {
    yOrigins.add(clamp(y0s[i] as number, maxY));
    yOrigins.add(clamp((y1s[i] as number) - h, maxY));
  }
  const band = new Int32Array(n);
  let best: { terms: number; words: number; x0: number; y0: number } | undefined;
  for (const y0 of yOrigins) {
    let bandSize = 0;
    for (let i = 0; i < n; i++) {
      if ((y0s[i] as number) >= y0 - EDGE_EPSILON && (y1s[i] as number) <= y0 + h + EDGE_EPSILON) band[bandSize++] = i;
    }
    if (bandSize === 0) continue;
    const xOrigins = new Set<number>();
    for (let k = 0; k < bandSize; k++) {
      const i = band[k] as number;
      xOrigins.add(clamp(x0s[i] as number, maxX));
      xOrigins.add(clamp((x1s[i] as number) - w, maxX));
    }
    for (const x0 of xOrigins) {
      stamp++;
      let words = 0;
      let terms = 0;
      for (let k = 0; k < bandSize; k++) {
        const i = band[k] as number;
        if ((x0s[i] as number) < x0 - EDGE_EPSILON || (x1s[i] as number) > x0 + w + EDGE_EPSILON) continue;
        words++;
        const t = termIds[i] as number;
        if (stamps[t] !== stamp) {
          stamps[t] = stamp;
          terms++;
        }
      }
      if (words === 0) continue;
      const candidate: Window = { terms, words, x0, y0, members: [] };
      if (better(candidate, best as Window | undefined)) best = { terms, words, x0, y0 };
    }
  }
  if (best === undefined) return { terms: 0, words: 0, x0: 0, y0: 0, members: [] };
  const { x0, y0 } = best;
  const members = anchors.filter(
    ({ rect }) =>
      rect[1] >= y0 - EDGE_EPSILON &&
      rect[3] <= y0 + h + EDGE_EPSILON &&
      rect[0] >= x0 - EDGE_EPSILON &&
      rect[2] <= x0 + w + EDGE_EPSILON,
  );
  return { ...best, members };
}

function clipToCrop(rect: PageRect, crop: CropBounds): PageRect | undefined {
  const x0 = Math.max(rect[0], crop.x0);
  const y0 = Math.max(rect[1], crop.y0);
  const x1 = Math.min(rect[2], crop.x0 + crop.width);
  const y1 = Math.min(rect[3], crop.y0 + crop.height);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : undefined;
}

function planByTerms(
  words: readonly TermWord[],
  page: PageSize,
  targetW: number,
  targetH: number,
  scale: number,
): ThumbnailPlan {
  const best = bestWindow(words, page, targetW, targetH);
  // No word fits entirely in the window (giant word, box wider than the crop): center on the first word.
  const members = best.members.length > 0 ? best.members : [words[0] as TermWord];
  const [x0, y0, x1, y1] = unionRect(members.map((m) => m.rect));
  const crop = calculateCropBounds(x0, y0, x1, y1, page.width, page.height, targetW, targetH);
  const visible = words
    .map(({ rect }) => clipToCrop(rect, crop))
    .filter((rect): rect is PageRect => rect !== undefined);
  return { crop, highlights: highlightRectsInCrop(visible, crop, scale), scale };
}

/**
 * Pure thumbnail planning: picks the first group of close matched words, computes the
 * crop area and the highlight rectangles in crop pixels. Without any usable ordinal,
 * falls back to the top of the page with no highlight.
 */
export function planThumbnail(
  boxes: readonly FractionBox[],
  ordinals: readonly number[],
  pageSize: PageSize,
  opts: ThumbnailPlanOptions = {},
): ThumbnailPlan {
  const { width, height } = pageSize;
  const targetW = opts.targetWidth ?? DEFAULT_CROP_WIDTH;
  const targetH = opts.targetHeight ?? DEFAULT_CROP_HEIGHT;
  const scale = opts.scale ?? CROP_RENDER_SCALE;
  const maxGap = opts.maxOrdinalGap ?? DEFAULT_MAX_ORDINAL_GAP;

  const { termIndexes } = opts;
  if (termIndexes && termIndexes.length === ordinals.length) {
    const words = termWords(boxes, ordinals, termIndexes, pageSize);
    if (words.length > 0) return planByTerms(words, pageSize, targetW, targetH, scale);
    const crop = calculateCropBounds(0, 0, width, 0, width, height, targetW, targetH);
    return { crop, highlights: [], scale };
  }

  const group = firstGroup(validOrdinals(ordinals, boxes.length), maxGap);
  if (group.length === 0) {
    const crop = calculateCropBounds(0, 0, width, 0, width, height, targetW, targetH);
    return { crop, highlights: [], scale };
  }
  const selected = group.map((o) => boxes[o] as FractionBox);
  const rects = wordBoxesToPageRects(selected, width, height);
  const [x0, y0, x1, y1] = unionRect(rects);
  const crop = calculateCropBounds(x0, y0, x1, y1, width, height, targetW, targetH);
  return { crop, highlights: highlightRectsInCrop(rects, crop, scale), scale };
}
