// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachHighlights,
  MAX_PAGE_REPLACEMENTS,
  ORPHAN_RELEASE_MS,
  OVERLAY_ATTRIBUTE,
  scrollToFirstHighlight,
} from "../../../src/ui/highlightOverlay";

const RECT = { left: 10, top: 20, width: 30, height: 5 };
const OVERLAY_SELECTOR = `[${OVERLAY_ATTRIBUTE}]`;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function addPage(root: Element, n: number): HTMLElement {
  const page = document.createElement("div");
  page.className = "page";
  page.dataset["pageNumber"] = String(n);
  root.appendChild(page);
  return page;
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("attachHighlights", () => {
  it("injects the overlay into an existing page with percent positions", async () => {
    const page = addPage(root, 3);
    const handle = attachHighlights({ root, pageNumber: 3, rects: [RECT] });
    await handle.ready;
    const overlay = page.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    expect(overlay).not.toBeNull();
    expect(overlay?.style.pointerEvents).toBe("none");
    const box = overlay?.firstElementChild as HTMLElement;
    expect(box.style.left).toBe("10%");
    expect(box.style.top).toBe("20%");
    expect(box.style.width).toBe("30%");
    expect(box.style.height).toBe("5%");
    expect(box.style.backgroundColor).toContain("255, 226, 0");
    handle.dispose();
  });

  it("applies the optional className", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], className: "x" });
    await handle.ready;
    expect(page.querySelector(".x")).not.toBeNull();
  });

  it("waits for a page that appears later", async () => {
    const handle = attachHighlights({ root, pageNumber: 2, rects: [RECT] });
    await flush();
    expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
    const page = addPage(root, 2);
    await handle.ready;
    expect(page.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
  });

  it("ignores other pages", async () => {
    const other = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 2, rects: [RECT] });
    await flush();
    expect(other.querySelector(OVERLAY_SELECTOR)).toBeNull();
    handle.dispose();
  });

  it("re-injects after the page is re-rendered, without duplicates", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    page.replaceChildren(); // PDF.js reset
    await flush();
    expect(page.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    page.replaceChildren(document.createElement("canvas"));
    await flush();
    expect(page.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    page.appendChild(document.createElement("div")); // unrelated mutation
    await flush();
    expect(page.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("does not loop: a single re-render causes a bounded number of insertions", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    const spy = vi.spyOn(page, "appendChild");
    page.replaceChildren();
    await flush();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    handle.dispose();
  });

  it("dispose removes the overlay, stops re-injection and is idempotent", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    handle.dispose();
    handle.dispose();
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
    page.replaceChildren();
    await flush();
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("dispose before the page appears prevents injection and settles ready", async () => {
    const handle = attachHighlights({ root, pageNumber: 4, rects: [RECT] });
    handle.dispose();
    const page = addPage(root, 4);
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
    await flush();
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("resolves ready with status 'timeout' and warns after the timeout", async () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const handle = attachHighlights({ root, pageNumber: 9, rects: [RECT], timeoutMs: 500, onWarn });
    await vi.advanceTimersByTimeAsync(501);
    await expect(handle.ready).resolves.toMatchObject({ status: "timeout", pageNumber: 9 });
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/page 9/));
    const page = addPage(root, 9);
    await flush();
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("clears the timeout once attached (no late rejection)", async () => {
    vi.useFakeTimers();
    addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], timeoutMs: 500 });
    await handle.ready;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(handle.ready).resolves.toMatchObject({ status: "attached" });
    handle.dispose();
  });

  it("reports 'empty' (no overlay, warning) for an empty rect list", async () => {
    const page = addPage(root, 1);
    const onWarn = vi.fn();
    const handle = attachHighlights({ root, pageNumber: 1, rects: [], onWarn });
    await expect(handle.ready).resolves.toMatchObject({ status: "empty", keptRects: 0 });
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("reports 'empty' when sanitizeRect drops every rectangle", async () => {
    const page = addPage(root, 1);
    const onWarn = vi.fn();
    const bad = [{ left: 200, top: 0, width: 5, height: 5 }, { ...RECT, width: 0 }];
    const handle = attachHighlights({ root, pageNumber: 1, rects: bad, onWarn });
    await expect(handle.ready).resolves.toMatchObject({
      status: "empty",
      keptRects: 0,
      droppedRects: 2,
    });
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("clamps out-of-bounds rects and drops invalid or empty ones", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({
      root,
      pageNumber: 1,
      rects: [
        { left: -10, top: 95, width: 120, height: 20 }, // clamped to 0,95,100,5
        { left: 120, top: 0, width: 5, height: 5 }, // entirely outside
        { left: 10, top: 10, width: 0, height: 5 }, // empty
        { left: Number.NaN, top: 0, width: 5, height: 5 },
        { left: 10, top: 10, width: -3, height: 5 },
      ],
    });
    await handle.ready;
    const boxes = page.querySelectorAll<HTMLElement>(`${OVERLAY_SELECTOR} > *`);
    expect(boxes).toHaveLength(1);
    const box = boxes[0] as HTMLElement;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual([
      "0%",
      "95%",
      "100%",
      "5%",
    ]);
  });

  it("does not mutate the input rects", async () => {
    addPage(root, 1);
    const rects = Object.freeze([Object.freeze({ ...RECT, left: -5 })]);
    const handle = attachHighlights({ root, pageNumber: 1, rects });
    await handle.ready;
    expect(rects[0]?.left).toBe(-5);
  });

  it("handles several pages in parallel independently", async () => {
    const p1 = addPage(root, 1);
    const handleA = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    const handleB = attachHighlights({ root, pageNumber: 2, rects: [RECT, RECT] });
    const p2 = addPage(root, 2);
    await Promise.all([handleA.ready, handleB.ready]);
    expect(p1.querySelectorAll(`${OVERLAY_SELECTOR} > *`)).toHaveLength(1);
    expect(p2.querySelectorAll(`${OVERLAY_SELECTOR} > *`)).toHaveLength(2);
    p1.replaceChildren();
    p2.replaceChildren();
    await flush();
    expect(p1.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    expect(p2.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handleA.dispose();
    expect(p1.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(p2.querySelector(OVERLAY_SELECTOR)).not.toBeNull();
    handleB.dispose();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid page number %s", (pageNumber) => {
    expect(() => attachHighlights({ root, pageNumber, rects: [] })).toThrow(RangeError);
  });

  it("works with a Document root", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root: document, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    expect(page.querySelector(OVERLAY_SELECTOR)).not.toBeNull();
    handle.dispose(); // a Document-root session would otherwise leak into later tests
  });
});

function setVisible(el: Element, visible: boolean): void {
  Object.defineProperty(el, "checkVisibility", { value: () => visible, configurable: true });
}

function addViewer(visible: boolean, pages: readonly number[]): { viewer: HTMLElement; pages: HTMLElement[] } {
  const viewer = document.createElement("div");
  root.appendChild(viewer);
  const made = pages.map((n) => {
    const page = addPage(viewer, n);
    setVisible(page, visible);
    return page;
  });
  return { viewer, pages: made };
}

describe("page replaced or removed (orphan overlay)", () => {
  it("re-injects when PDF.js replaces the page element itself", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    const replacement = document.createElement("div");
    replacement.className = "page";
    replacement.dataset["pageNumber"] = "1";
    page.replaceWith(replacement);
    await flush();
    expect(replacement.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
    handle.dispose();
  });

  it("waits for a new page when the page is removed, then re-injects", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    page.remove();
    await flush();
    const next = addPage(root, 1);
    await flush();
    expect(next.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("gives up after MAX_PAGE_REPLACEMENTS replacements and warns", async () => {
    let page = addPage(root, 1);
    const onWarn = vi.fn();
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], onWarn });
    await handle.ready;
    for (let i = 0; i <= MAX_PAGE_REPLACEMENTS; i += 1) {
      page.remove();
      await flush();
      page = addPage(root, 1);
      await flush();
    }
    expect(page.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/replace/i));
  });

  it("auto-disposes when the page stays removed for ORPHAN_RELEASE_MS", async () => {
    vi.useFakeTimers();
    const page = addPage(root, 1);
    const onWarn = vi.fn();
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], onWarn });
    await handle.ready;
    page.remove();
    await vi.advanceTimersByTimeAsync(ORPHAN_RELEASE_MS - 1);
    expect(onWarn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/released/i));
    const late = addPage(root, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(late.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("cancels the orphan release if a new page shows up in time", async () => {
    vi.useFakeTimers();
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    page.remove();
    await vi.advanceTimersByTimeAsync(ORPHAN_RELEASE_MS - 10);
    const next = addPage(root, 1);
    await vi.advanceTimersByTimeAsync(ORPHAN_RELEASE_MS * 2);
    expect(next.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("honours a custom orphanReleaseMs", async () => {
    vi.useFakeTimers();
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], orphanReleaseMs: 50 });
    await handle.ready;
    page.remove();
    await vi.advanceTimersByTimeAsync(60);
    const late = addPage(root, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(late.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });
});

describe("which document (several viewers)", () => {
  it("picks the visible page among several .page with the same number", async () => {
    const hidden = addViewer(false, [1]);
    const shown = addViewer(true, [1]);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await expect(handle.ready).resolves.toMatchObject({ status: "attached" });
    expect(hidden.pages[0]?.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(shown.pages[0]?.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("falls back to a non-zero bounding rect when checkVisibility is unavailable", async () => {
    const a = addViewer(true, [1]).pages[0] as HTMLElement;
    const b = addViewer(true, [1]).pages[0] as HTMLElement;
    for (const el of [a, b]) Object.defineProperty(el, "checkVisibility", { value: undefined });
    const rect = { width: 10, height: 10 } as DOMRect;
    b.getBoundingClientRect = () => rect;
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    expect(a.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(b.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("waits (does not guess) when several candidates exist and none is visible", async () => {
    const a = addViewer(false, [1]);
    const b = addViewer(false, [1]);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await flush();
    expect(a.pages[0]?.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(b.pages[0]?.querySelector(OVERLAY_SELECTOR)).toBeNull();
    setVisible(b.pages[0] as HTMLElement, true);
    b.viewer.appendChild(document.createElement("i")); // triggers a mutation
    await expect(handle.ready).resolves.toMatchObject({ status: "attached" });
    expect(b.pages[0]?.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
  });

  it("uses resolvePageRoot to target the active viewer", async () => {
    const first = addViewer(true, [1]);
    const second = addViewer(true, [1]);
    const handle = attachHighlights({
      root,
      pageNumber: 1,
      rects: [RECT],
      resolvePageRoot: () => second.viewer,
    });
    await handle.ready;
    expect(first.pages[0]?.querySelector(OVERLAY_SELECTOR)).toBeNull();
    expect(second.pages[0]?.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("keeps waiting while resolvePageRoot returns null", async () => {
    const viewer = addViewer(true, [1]);
    let active: Element | null = null;
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT], resolvePageRoot: () => active });
    await flush();
    expect(viewer.pages[0]?.querySelector(OVERLAY_SELECTOR)).toBeNull();
    active = viewer.viewer;
    viewer.viewer.appendChild(document.createElement("i"));
    await handle.ready;
    expect(viewer.pages[0]?.querySelectorAll(OVERLAY_SELECTOR)).toHaveLength(1);
    handle.dispose();
  });

  it("scrollToFirstHighlight targets the visible document too", async () => {
    const hidden = addViewer(false, [1]);
    const shown = addViewer(true, [1]);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    const stubHidden = vi.fn();
    const stubShown = vi.fn();
    const hiddenBox = document.createElement("div");
    hiddenBox.setAttribute(OVERLAY_ATTRIBUTE, "true");
    hiddenBox.appendChild(document.createElement("span")).scrollIntoView = stubHidden;
    hidden.pages[0]?.appendChild(hiddenBox);
    const shownBox = shown.pages[0]?.firstElementChild?.firstElementChild as HTMLElement;
    shownBox.scrollIntoView = stubShown;
    expect(scrollToFirstHighlight({ root, pageNumber: 1 })).toBe(true);
    expect(stubShown).toHaveBeenCalledTimes(1);
    expect(stubHidden).not.toHaveBeenCalled();
    handle.dispose();
  });
});

describe("scrollToFirstHighlight", () => {
  it("centers the first rectangle with scrollIntoView", async () => {
    const page = addPage(root, 1);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT, { ...RECT, top: 50 }] });
    await handle.ready;
    const first = page.querySelector(`${OVERLAY_SELECTOR} > *`) as HTMLElement;
    const stub = vi.fn();
    first.scrollIntoView = stub;
    expect(scrollToFirstHighlight({ root, pageNumber: 1 })).toBe(true);
    expect(stub).toHaveBeenCalledWith({ block: "center", inline: "center" });
  });

  it("returns false when there is no page, no rectangle or no scrollIntoView", async () => {
    expect(scrollToFirstHighlight({ root, pageNumber: 1 })).toBe(false);
    const page = addPage(root, 1);
    expect(scrollToFirstHighlight({ root, pageNumber: 1 })).toBe(false);
    const handle = attachHighlights({ root, pageNumber: 1, rects: [RECT] });
    await handle.ready;
    const first = page.querySelector(`${OVERLAY_SELECTOR} > *`) as HTMLElement;
    Object.defineProperty(first, "scrollIntoView", { value: undefined });
    expect(scrollToFirstHighlight({ root, pageNumber: 1 })).toBe(false);
  });
});

describe("scrollToFirstHighlight with an index", () => {
  async function setup(): Promise<HTMLElement[]> {
    const page = addPage(root, 1);
    const handle = await attachHighlights({ root, pageNumber: 1, rects: [RECT, { ...RECT, top: 40 }, { ...RECT, top: 60 }] });
    await handle.ready;
    const boxes = Array.from(page.querySelectorAll(`${OVERLAY_SELECTOR} > *`)) as HTMLElement[];
    boxes.forEach((b) => (b.scrollIntoView = vi.fn()));
    return boxes;
  }

  it("centers the rectangle at the given index", async () => {
    const boxes = await setup();
    expect(scrollToFirstHighlight({ root, pageNumber: 1, index: 2 })).toBe(true);
    expect(boxes[2]!.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
    expect(boxes[0]!.scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to the first rectangle when the index is out of bounds or invalid", async () => {
    const boxes = await setup();
    for (const index of [3, -1, 1.5, Number.NaN]) {
      expect(scrollToFirstHighlight({ root, pageNumber: 1, index })).toBe(true);
    }
    expect(boxes[0]!.scrollIntoView).toHaveBeenCalledTimes(4);
    expect(boxes[1]!.scrollIntoView).not.toHaveBeenCalled();
  });
});
