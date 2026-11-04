import { describe, expect, it } from "vitest";
import {
  calculateCropBounds,
  highlightRectsInCrop,
  rectToPercentStyle,
  wordBoxesToPageRects,
} from "../../src/core/crop";
import {
  CROP_RENDER_SCALE,
  DEFAULT_CROP_HEIGHT,
  DEFAULT_CROP_WIDTH,
  GOODNOTES_YELLOW_CSS,
} from "../../src/core/constants";

describe("constants", () => {
  it("match crop-worker.js", () => {
    expect(CROP_RENDER_SCALE).toBe(1.5);
    expect(DEFAULT_CROP_WIDTH).toBe(300);
    expect(DEFAULT_CROP_HEIGHT).toBe(120);
    expect(GOODNOTES_YELLOW_CSS).toBe("rgba(255, 226, 0, 0.45)");
  });
});

describe("calculateCropBounds", () => {
  const PW = 600;
  const PH = 800;

  it("centers the crop on a box in the middle of the page (hand case 1)", () => {
    expect(calculateCropBounds(290, 390, 310, 410, PW, PH)).toEqual({
      x0: 150, y0: 340, width: 300, height: 120,
    });
  });

  it("clamps at the top-left edges (hand case 2)", () => {
    expect(calculateCropBounds(0, 0, 20, 10, PW, PH)).toEqual({
      x0: 0, y0: 0, width: 300, height: 120,
    });
  });

  it("shifts back inside the page at the bottom-right corner (hand case 3)", () => {
    expect(calculateCropBounds(590, 790, 600, 800, PW, PH)).toEqual({
      x0: 300, y0: 680, width: 300, height: 120,
    });
  });

  it("clamps at the right edge only", () => {
    const b = calculateCropBounds(595, 400, 600, 410, PW, PH);
    expect(b.x0).toBe(300);
    expect(b.y0).toBe(345);
  });

  it("clamps at the bottom edge only", () => {
    const b = calculateCropBounds(300, 795, 310, 800, PW, PH);
    expect(b.y0).toBe(680);
    expect(b.x0).toBe(155);
  });

  it("returns the whole page when smaller than the default crop", () => {
    expect(calculateCropBounds(10, 10, 20, 20, 200, 100)).toEqual({
      x0: 0, y0: 0, width: 200, height: 100,
    });
  });

  it("enforces a minimum size of 1", () => {
    const b = calculateCropBounds(0, 0, 0, 0, 0, 0);
    expect(b.width).toBe(1);
    expect(b.height).toBe(1);
  });

  it("handles a degenerate zero box", () => {
    expect(calculateCropBounds(300, 400, 300, 400, PW, PH)).toEqual({
      x0: 150, y0: 340, width: 300, height: 120,
    });
  });

  it("handles a box larger than the crop (centered on its center)", () => {
    expect(calculateCropBounds(100, 100, 500, 700, PW, PH)).toEqual({
      x0: 150, y0: 340, width: 300, height: 120,
    });
  });

  it("honours custom target sizes", () => {
    expect(calculateCropBounds(300, 400, 300, 400, PW, PH, 100, 50)).toEqual({
      x0: 250, y0: 375, width: 100, height: 50,
    });
  });
});

describe("highlightRectsInCrop", () => {
  const crop = { x0: 150, y0: 340, width: 300, height: 120 };

  it("translates and scales rectangles", () => {
    expect(highlightRectsInCrop([[290, 390, 310, 410]], crop, 1.5)).toEqual([
      { x: 210, y: 75, width: 30, height: 30 },
    ]);
  });

  it("keeps partially outside rectangles unclipped", () => {
    expect(highlightRectsInCrop([[100, 330, 200, 350]], crop, 1)).toEqual([
      { x: -50, y: -10, width: 100, height: 20 },
    ]);
  });

  it("returns an empty array for no rectangles", () => {
    expect(highlightRectsInCrop([], crop, 1.5)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const rects = [[290, 390, 310, 410]] as const;
    const copy = JSON.parse(JSON.stringify(rects));
    highlightRectsInCrop(rects, crop, 1.5);
    expect(JSON.parse(JSON.stringify(rects))).toEqual(copy);
  });
});

describe("wordBoxesToPageRects / rectToPercentStyle", () => {
  it("converts fractions to page points", () => {
    expect(
      wordBoxesToPageRects([{ x: 0.5, y: 0.25, w: 0.1, h: 0.05 }], 600, 800),
    ).toEqual([[300, 200, 360, 240]]);
  });

  it("returns empty for empty input", () => {
    expect(wordBoxesToPageRects([], 600, 800)).toEqual([]);
  });

  it("converts a rect to percent style", () => {
    expect(rectToPercentStyle([300, 200, 360, 240], 600, 800)).toEqual({
      left: 50, top: 25, width: 10, height: 5,
    });
  });

  it("round-trips fractions -> points -> percentages", () => {
    const box = { x: 0.125, y: 0.0625, w: 0.25, h: 0.5 };
    const [rect] = wordBoxesToPageRects([box], 612, 792);
    expect(rect).toBeDefined();
    const style = rectToPercentStyle(rect!, 612, 792);
    expect(style.left).toBeCloseTo(box.x * 100, 9);
    expect(style.top).toBeCloseTo(box.y * 100, 9);
    expect(style.width).toBeCloseTo(box.w * 100, 9);
    expect(style.height).toBeCloseTo(box.h * 100, 9);
  });

  it("returns zeros for a zero-sized page instead of NaN", () => {
    expect(rectToPercentStyle([1, 1, 2, 2], 0, 0)).toEqual({
      left: 0, top: 0, width: 0, height: 0,
    });
  });
});
