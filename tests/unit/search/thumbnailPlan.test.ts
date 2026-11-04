import { describe, expect, it } from "vitest";
import { CROP_RENDER_SCALE, DEFAULT_CROP_HEIGHT, DEFAULT_CROP_WIDTH } from "../../../src/core/constants";
import type { FractionBox } from "../../../src/core/crop";
import { planThumbnail } from "../../../src/search/thumbnailPlan";

const PAGE = { width: 600, height: 800 };
const box = (x: number, y: number, width = 0.1, height = 0.02): FractionBox => ({ x, y, width, height });

describe("planThumbnail", () => {
  it("centers the crop on the highlighted word and expresses highlights in crop pixels", () => {
    const boxes = [box(0.5, 0.5)];
    const plan = planThumbnail(boxes, [0], PAGE);
    expect(plan.scale).toBe(CROP_RENDER_SCALE);
    expect(plan.crop.width).toBe(DEFAULT_CROP_WIDTH);
    expect(plan.crop.height).toBe(DEFAULT_CROP_HEIGHT);
    // word rect in points: x 300..360, y 400..416 ; center (330, 408)
    expect(plan.crop.x0).toBeCloseTo(330 - DEFAULT_CROP_WIDTH / 2);
    expect(plan.crop.y0).toBeCloseTo(408 - DEFAULT_CROP_HEIGHT / 2);
    expect(plan.highlights).toHaveLength(1);
    const h = plan.highlights[0]!;
    expect(h.x).toBeCloseTo((300 - plan.crop.x0) * CROP_RENDER_SCALE);
    expect(h.y).toBeCloseTo((400 - plan.crop.y0) * CROP_RENDER_SCALE);
    expect(h.width).toBeCloseTo(60 * CROP_RENDER_SCALE);
    expect(h.height).toBeCloseTo(16 * CROP_RENDER_SCALE);
  });

  it("keeps the crop inside the page for boxes on the page border", () => {
    const topLeft = planThumbnail([box(0, 0)], [0], PAGE);
    expect(topLeft.crop.x0).toBe(0);
    expect(topLeft.crop.y0).toBe(0);
    const bottomRight = planThumbnail([box(0.9, 0.98)], [0], PAGE);
    expect(bottomRight.crop.x0 + bottomRight.crop.width).toBeLessThanOrEqual(PAGE.width);
    expect(bottomRight.crop.y0 + bottomRight.crop.height).toBeLessThanOrEqual(PAGE.height);
    expect(bottomRight.crop.width).toBe(DEFAULT_CROP_WIDTH);
  });

  it("shrinks the crop when the page is smaller than the target", () => {
    const plan = planThumbnail([box(0.4, 0.4)], [0], { width: 100, height: 50 });
    expect(plan.crop).toEqual({ x0: 0, y0: 0, width: 100, height: 50 });
  });

  it("falls back to the top of the page without highlights when there is no ordinal", () => {
    const plan = planThumbnail([box(0.5, 0.5)], [], PAGE);
    expect(plan.highlights).toEqual([]);
    expect(plan.crop.y0).toBe(0);
    expect(plan.crop.height).toBe(DEFAULT_CROP_HEIGHT);
    expect(plan.crop.x0).toBeCloseTo((PAGE.width - DEFAULT_CROP_WIDTH) / 2);
  });

  it("ignores ordinals outside the boxes array (and invalid ones)", () => {
    const boxes = [box(0.5, 0.5)];
    const plan = planThumbnail(boxes, [5, -1, 1.5, Number.NaN, 0], PAGE);
    expect(plan.highlights).toHaveLength(1);
    const onlyInvalid = planThumbnail(boxes, [5, -1], PAGE);
    expect(onlyInvalid.highlights).toEqual([]);
    expect(onlyInvalid.crop.y0).toBe(0);
  });

  it("shows only the first group of close words when groups are far apart", () => {
    const boxes = Array.from({ length: 100 }, (_, i) => box(0.1, 0.01 * (i % 90)));
    const plan = planThumbnail(boxes, [50, 51, 90, 91], PAGE, { maxOrdinalGap: 3 });
    expect(plan.highlights).toHaveLength(2);
    const expectedY = (0.5 * 800 - plan.crop.y0) * CROP_RENDER_SCALE;
    expect(plan.highlights[0]!.y).toBeCloseTo(expectedY);
  });

  it("groups by sorted, de-duplicated ordinals whatever the input order", () => {
    const boxes = Array.from({ length: 30 }, (_, i) => box(0.1, 0.02 * i));
    const a = planThumbnail(boxes, [20, 2, 3, 2], PAGE, { maxOrdinalGap: 2 });
    expect(a.highlights).toHaveLength(2);
    expect(a.crop.y0).toBeLessThan(0.1 * 800);
  });

  it("honors custom target size and scale", () => {
    const plan = planThumbnail([box(0.5, 0.5)], [0], PAGE, { targetWidth: 200, targetHeight: 100, scale: 2 });
    expect(plan.crop.width).toBe(200);
    expect(plan.crop.height).toBe(100);
    expect(plan.scale).toBe(2);
    expect(plan.highlights[0]!.width).toBeCloseTo(120);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const boxes = [box(0.2, 0.3), box(0.3, 0.3)];
    const ordinals = [1, 0];
    const first = planThumbnail(boxes, ordinals, PAGE);
    const second = planThumbnail(boxes, ordinals, PAGE);
    expect(second).toEqual(first);
    expect(ordinals).toEqual([1, 0]);
  });

  it("rejects non-finite page sizes through calculateCropBounds", () => {
    expect(() => planThumbnail([box(0.1, 0.1)], [0], { width: Number.NaN, height: 10 })).toThrow(RangeError);
  });
});
