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

  describe("multi-term window selection (termIndexes)", () => {
    // Page 600x800 points; box y fractions: 0.05 -> 40pt, 0.625 -> 500pt.
    const at = (xPt: number, yPt: number): FractionBox => box(xPt / 600, yPt / 800, 0.05, 0.015);
    const rectTop = (plan: ReturnType<typeof planThumbnail>) => plan.crop.y0;

    it("prefers the area covering the most distinct terms over the first group", () => {
      // 0: "bpco" in a title at the top ; 1-2: "classification" + "bpco" in a paragraph lower down
      const boxes = [at(50, 40), at(50, 500), at(120, 510), at(50, 700)];
      const plan = planThumbnail(boxes, [0, 1, 2], PAGE, { termIndexes: [1, 0, 1] });
      expect(plan.crop.y0).toBeLessThanOrEqual(500);
      expect(plan.crop.y0 + plan.crop.height).toBeGreaterThanOrEqual(526);
      expect(plan.highlights).toHaveLength(2);
    });

    it("on equal distinct terms prefers more highlighted words, then the highest area", () => {
      // area A (y~100): terms {0,1}, 2 words ; area B (y~400): terms {0,1}, 3 words ; area C (y~700): same as B
      const boxes = [
        at(50, 100), at(120, 100),
        at(50, 400), at(120, 400), at(190, 400),
        at(50, 700), at(120, 700), at(190, 700),
      ];
      const ordinals = [0, 1, 2, 3, 4, 5, 6, 7];
      const termIndexes = [0, 1, 0, 1, 1, 0, 1, 1];
      const plan = planThumbnail(boxes, ordinals, PAGE, { termIndexes });
      expect(plan.highlights).toHaveLength(3);
      expect(rectTop(plan)).toBeGreaterThan(300);
      expect(rectTop(plan)).toBeLessThan(400);

      const tie = planThumbnail(boxes.slice(0, 2), [0, 1], PAGE, { termIndexes: [0, 1] });
      expect(tie.highlights).toHaveLength(2);
    });

    it("breaks a full tie by the highest area in the page", () => {
      const boxes = [at(50, 600), at(120, 600), at(50, 100), at(120, 100)];
      const plan = planThumbnail(boxes, [0, 1, 2, 3], PAGE, { termIndexes: [0, 1, 0, 1] });
      expect(plan.crop.y0).toBeLessThan(100);
      expect(plan.highlights).toHaveLength(2);
    });

    it("highlights every matched word falling in the crop, even beyond the ordinal gap", () => {
      const boxes = Array.from({ length: 40 }, (_, i) => at(50 + (i % 4) * 60, 500 + Math.floor(i / 4) * 5));
      const plan = planThumbnail(boxes, [0, 1, 30, 31], PAGE, { termIndexes: [0, 1, 0, 1] });
      expect(plan.highlights).toHaveLength(4);
    });

    it("clips highlights to the crop and never exceeds the crop size", () => {
      const boxes = [at(50, 300), at(120, 300), at(50, 700)];
      const plan = planThumbnail(boxes, [0, 1, 2], PAGE, { termIndexes: [0, 1, 0] });
      const w = plan.crop.width * plan.scale;
      const h = plan.crop.height * plan.scale;
      for (const r of plan.highlights) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(w + 1e-6);
        expect(r.y + r.height).toBeLessThanOrEqual(h + 1e-6);
      }
      expect(plan.crop.width).toBe(DEFAULT_CROP_WIDTH);
      expect(plan.crop.height).toBe(DEFAULT_CROP_HEIGHT);
    });

    it("single term: covers the densest area", () => {
      const boxes = [at(50, 40), at(50, 500), at(120, 505), at(190, 510)];
      const plan = planThumbnail(boxes, [0, 1, 2, 3], PAGE, { termIndexes: [0, 0, 0, 0] });
      expect(plan.highlights).toHaveLength(3);
    });

    it("single occurrence: same as the legacy behavior", () => {
      const boxes = [box(0.5, 0.5)];
      expect(planThumbnail(boxes, [0], PAGE, { termIndexes: [0] })).toEqual(planThumbnail(boxes, [0], PAGE));
    });

    it("falls back to the legacy grouping when termIndexes is missing or misaligned", () => {
      const boxes = [at(50, 40), at(50, 500), at(120, 510)];
      const legacy = planThumbnail(boxes, [0, 1, 2], PAGE);
      expect(planThumbnail(boxes, [0, 1, 2], PAGE, { termIndexes: [0, 1] })).toEqual(legacy);
      expect(planThumbnail(boxes, [0, 1, 2], PAGE, { termIndexes: [] })).toEqual(legacy);
    });

    it("ignores invalid ordinals and invalid term indexes", () => {
      const boxes = [at(50, 500), at(120, 510)];
      const plan = planThumbnail(boxes, [0, 1, 9, -1], PAGE, { termIndexes: [0, 1, 0, 1] });
      expect(plan.highlights).toHaveLength(2);
      const none = planThumbnail(boxes, [0, 1], PAGE, { termIndexes: [-1, Number.NaN] });
      expect(none.highlights).toEqual([]);
      expect(none.crop.y0).toBe(0);
      const empty = planThumbnail([], [], PAGE, { termIndexes: [] });
      expect(empty.highlights).toEqual([]);
    });

    it("stays fast with thousands of matched words", () => {
      const boxes = Array.from({ length: 5000 }, (_, i) => at((i * 7) % 550, (i * 13) % 780));
      const ordinals = boxes.map((_, i) => i);
      const termIndexes = ordinals.map((i) => i % 3);
      const start = Date.now();
      const plan = planThumbnail(boxes, ordinals, PAGE, { termIndexes });
      expect(Date.now() - start).toBeLessThan(500);
      expect(plan.highlights.length).toBeGreaterThan(0);
    });

    const expectValidCrop = (plan: ReturnType<typeof planThumbnail>) => {
      for (const v of [plan.crop.x0, plan.crop.y0, plan.crop.width, plan.crop.height]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(plan.crop.width).toBeGreaterThan(0);
      expect(plan.crop.height).toBeGreaterThan(0);
    };

    it("returns a valid crop when a word is taller than the crop", () => {
      const boxes = [box(0.1, 0.1, 0.1, 0.3), box(0.5, 0.6, 0.05, 0.015)];
      const plan = planThumbnail(boxes, [0, 1], PAGE, { termIndexes: [0, 1] });
      expectValidCrop(plan);
    });

    it("returns a valid crop when a word is wider than the crop", () => {
      const boxes = [box(0.05, 0.5, 0.9, 0.015)];
      const plan = planThumbnail(boxes, [0], PAGE, { termIndexes: [0] });
      expectValidCrop(plan);
      expect(plan.crop.y0).toBeLessThanOrEqual(400);
    });

    it("tolerates floating point rounding on the band edge", () => {
      // height exactly the crop height: (y1 - h) + h may be below y1 in floating point
      const h = DEFAULT_CROP_HEIGHT / 800;
      const boxes = [box(0.1, 0.1234567, 0.05, h)];
      const plan = planThumbnail(boxes, [0], PAGE, { termIndexes: [0] });
      expectValidCrop(plan);
      expect(plan.highlights).toHaveLength(1);
    });

    it("covers both terms even when the first term floods the page before the first rare term", () => {
      const flood = Array.from({ length: 400 }, (_, i) => at(10 + (i % 8) * 60, 20 + Math.floor(i / 8) * 2));
      const rare = [at(50, 700), at(120, 700)];
      const boxes = [...flood, ...rare];
      const ordinals = boxes.map((_, i) => i);
      const termIndexes = boxes.map((_, i) => (i === 400 ? 1 : 0));
      const plan = planThumbnail(boxes, ordinals, PAGE, { termIndexes });
      // "rapport" (ordinal 400, y=700) and a "le" next to it (ordinal 401) must share the crop
      expect(plan.crop.y0 + plan.crop.height).toBeGreaterThanOrEqual(715);
      expect(plan.crop.y0).toBeLessThanOrEqual(700);
    });
  });
});
