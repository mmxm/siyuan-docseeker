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
