import { DEFAULT_CROP_HEIGHT, DEFAULT_CROP_WIDTH } from "./constants";

/** Rectangle in page points: [x0, y0, x1, y1], origin top-left. */
export type PageRect = readonly [number, number, number, number];

export interface CropBounds {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

/** Box in fractions of the page (origin top-left, all values in [0, 1]). */
export interface FractionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangle in crop pixels. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** CSS percentages of the page, for an absolutely positioned overlay. */
export interface PercentStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const MIN_CROP_SIZE = 1;
const PERCENT = 100;

interface AxisCrop {
  readonly origin: number;
  readonly size: number;
}

function cropAxis(center: number, target: number, pageSize: number): AxisCrop {
  let origin = Math.max(0, center - target / 2);
  const end = Math.min(origin + target, pageSize);
  if (end === pageSize) origin = Math.max(0, end - target);
  return { origin, size: Math.max(MIN_CROP_SIZE, end - origin) };
}

function assertFinite(inputs: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(inputs)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} must be a finite number, got ${value}`);
    }
  }
}

/**
 * Faithful port of crop-worker.js / crop.rs calculate_crop_bounds.
 * Throws RangeError if any input is not finite. A finite page size <= 0 yields size 1.
 */
export function calculateCropBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pageWidth: number,
  pageHeight: number,
  targetW: number = DEFAULT_CROP_WIDTH,
  targetH: number = DEFAULT_CROP_HEIGHT,
): CropBounds {
  assertFinite({ x0, y0, x1, y1, pageWidth, pageHeight, targetW, targetH });
  const horizontal = cropAxis((x0 + x1) / 2, targetW, pageWidth);
  const vertical = cropAxis((y0 + y1) / 2, targetH, pageHeight);
  return {
    x0: horizontal.origin,
    y0: vertical.origin,
    width: horizontal.size,
    height: vertical.size,
  };
}

/** Highlight rectangles in crop pixels: (rect - crop origin) * scale. Not clipped. */
export function highlightRectsInCrop(
  rects: readonly PageRect[],
  cropBounds: CropBounds,
  scale: number,
): readonly PixelRect[] {
  return rects.map(([rx0, ry0, rx1, ry1]) => ({
    x: (rx0 - cropBounds.x0) * scale,
    y: (ry0 - cropBounds.y0) * scale,
    width: (rx1 - rx0) * scale,
    height: (ry1 - ry0) * scale,
  }));
}

/** Converts page-fraction boxes to [x0, y0, x1, y1] rectangles in page points. */
export function wordBoxesToPageRects(
  boxesFraction: readonly FractionBox[],
  pageWidth: number,
  pageHeight: number,
): readonly PageRect[] {
  return boxesFraction.map(({ x, y, width, height }): PageRect => [
    x * pageWidth,
    y * pageHeight,
    (x + width) * pageWidth,
    (y + height) * pageHeight,
  ]);
}

/** Converts a page-point rectangle to CSS percentages of the page. */
export function rectToPercentStyle(
  rect: PageRect,
  pageWidth: number,
  pageHeight: number,
): PercentStyle {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const [x0, y0, x1, y1] = rect;
  return {
    left: (x0 / pageWidth) * PERCENT,
    top: (y0 / pageHeight) * PERCENT,
    width: ((x1 - x0) / pageWidth) * PERCENT,
    height: ((y1 - y0) / pageHeight) * PERCENT,
  };
}
