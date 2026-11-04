// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_ATTRIBUTE } from "../../../src/ui/highlightOverlay";
import { InvalidPdfPathError, openPdfAtPage, type OpenTabFn } from "../../../src/siyuan/openPdf";

const RECT = { left: 10, top: 20, width: 30, height: 5 };
const APP = { id: "app" };

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
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function base(openTab: OpenTabFn, over: Record<string, unknown> = {}) {
  return { openTab, app: APP, path: "assets/x.pdf", page: 2, rects: [RECT], root, ...over };
}

describe("openPdfAtPage", () => {
  it("calls openTab with the pdf target and attaches the highlight", async () => {
    const openTab = vi.fn<OpenTabFn>().mockImplementation(async () => {
      addPage(root, 2);
    });
    const handle = await openPdfAtPage(base(openTab));
    await handle.ready;
    expect(openTab).toHaveBeenCalledWith({ app: APP, pdf: { path: "assets/x.pdf", page: 2 } });
    expect(root.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("dispose removes the overlay", async () => {
    addPage(root, 2);
    const handle = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    await handle.ready;
    handle.dispose();
    handle.dispose();
    expect(root.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
  });

  it("propagates an openTab rejection and leaves no overlay", async () => {
    const page = addPage(root, 2);
    const error = new Error("boom");
    await expect(openPdfAtPage(base(vi.fn<OpenTabFn>().mockRejectedValue(error)))).rejects.toBe(
      error,
    );
    await flush();
    expect(page.childElementCount).toBe(0);
  });

  it("propagates a synchronous openTab throw", async () => {
    const openTab: OpenTabFn = () => {
      throw new Error("sync");
    };
    await expect(openPdfAtPage(base(openTab))).rejects.toThrow("sync");
  });

  it("disposes the previous overlay on a second call", async () => {
    const p2 = addPage(root, 2);
    const p5 = addPage(root, 5);
    const openTab = vi.fn<OpenTabFn>().mockResolvedValue(undefined);
    const first = await openPdfAtPage(base(openTab));
    await first.ready;
    const second = await openPdfAtPage(base(openTab, { page: 5 }));
    await second.ready;
    expect(p2.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
    expect(p5.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).not.toBeNull();
    first.dispose(); // must not remove the second overlay
    expect(p5.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).not.toBeNull();
  });

  it("does not attach when superseded while openTab is pending", async () => {
    const page = addPage(root, 2);
    let release: () => void = () => undefined;
    const slow = vi.fn<OpenTabFn>().mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const firstPromise = openPdfAtPage(base(slow));
    const second = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    release();
    const first = await firstPromise;
    await first.ready;
    await second.ready;
    expect(page.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
    first.dispose();
    expect(page.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("works when the PDF is already open (page already in the DOM) and scrolls to it", async () => {
    const page = addPage(root, 2);
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), {}),
    );
    await handle.ready;
    const box = page.querySelector(`[${OVERLAY_ATTRIBUTE}] > *`) as HTMLElement;
    expect(box).not.toBeNull();
  });

  it("scrolls to the first highlight once attached", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    addPage(root, 2);
    const handle = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    await handle.ready;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("reports 'timeout' (and warns) when the page never appears", async () => {
    const onWarn = vi.fn();
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), { timeoutMs: 20, onWarn }),
    );
    await expect(handle.ready).resolves.toMatchObject({ status: "timeout", scrolled: false });
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/page 2/));
  });

  it("reports 'attached' with scrolled=false and warns when scrolling is impossible", async () => {
    addPage(root, 2);
    const onWarn = vi.fn();
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), { onWarn }),
    );
    await expect(handle.ready).resolves.toMatchObject({ status: "attached", scrolled: false });
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/scroll/i));
  });

  it("reports scrolled=true when the scroll worked", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    addPage(root, 2);
    const handle = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    await expect(handle.ready).resolves.toMatchObject({ status: "attached", scrolled: true });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("reports 'empty' when every rect is dropped", async () => {
    addPage(root, 2);
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), { rects: [{ ...RECT, width: 0 }], onWarn: vi.fn() }),
    );
    await expect(handle.ready).resolves.toMatchObject({ status: "empty", scrolled: false });
  });

  it("reports 'superseded' for a call overtaken while openTab was pending", async () => {
    addPage(root, 2);
    let release: () => void = () => undefined;
    const slow = vi.fn<OpenTabFn>().mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const firstPromise = openPdfAtPage(base(slow));
    await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    release();
    const first = await firstPromise;
    await expect(first.ready).resolves.toMatchObject({ status: "superseded", scrolled: false });
  });

  it("reports 'superseded' for an overlay replaced by a newer call", async () => {
    addPage(root, 5); // page 2 absent: the first `ready` is still pending when overtaken
    const openTab = vi.fn<OpenTabFn>().mockResolvedValue(undefined);
    const first = await openPdfAtPage(base(openTab));
    await openPdfAtPage(base(openTab, { page: 5 }));
    await expect(first.ready).resolves.toMatchObject({ status: "superseded" });
  });

  it("targets the visible viewer when two documents are open", async () => {
    const make = (visible: boolean): HTMLElement => {
      const viewer = document.createElement("div");
      root.appendChild(viewer);
      const page = addPage(viewer, 2);
      Object.defineProperty(page, "checkVisibility", { value: () => visible });
      return page;
    };
    const hidden = make(false);
    const shown = make(true);
    const handle = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    await handle.ready;
    expect(hidden.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
    expect(shown.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("honours resolvePageRoot for the overlay and the scroll", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const a = document.createElement("div");
    const b = document.createElement("div");
    root.append(a, b);
    const pa = addPage(a, 2);
    const pb = addPage(b, 2);
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), { resolvePageRoot: () => b }),
    );
    await expect(handle.ready).resolves.toMatchObject({ scrolled: true });
    expect(pa.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
    expect(pb.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("dispose releases without opening another PDF, and is idempotent", async () => {
    const page = addPage(root, 2);
    const handle = await openPdfAtPage(base(vi.fn<OpenTabFn>().mockResolvedValue(undefined)));
    await handle.ready;
    handle.dispose();
    handle.dispose();
    expect(page.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
  });

  it("auto-releases when the target page is removed for good (tab closed)", async () => {
    vi.useFakeTimers();
    const page = addPage(root, 2);
    const onWarn = vi.fn();
    const handle = await openPdfAtPage(
      base(vi.fn<OpenTabFn>().mockResolvedValue(undefined), { orphanReleaseMs: 100, onWarn }),
    );
    await handle.ready;
    page.remove();
    await vi.advanceTimersByTimeAsync(150);
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/released/i));
    const late = addPage(root, 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(late.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
  });

  it.each([
    "../secret.pdf",
    "assets/../x.pdf",
    "assets/x.txt",
    "assets/x",
    "/assets/x.pdf",
    "x.pdf",
    "assets\\x.pdf",
    "assets/.pdf",
    "",
    "assets/a..b/../x.pdf",
    "assets/x.pdf\n",
    "assets/%2e%2e/x.pdf",
    "assets/%2E%2E/x.pdf",
    "assets/a%2fb.pdf",
    "assets/a%5cb.pdf",
    "assets/x.pdf?page=3",
    "assets/x.pdf#page=3",
    "assets/a#b/x.pdf",
    "assets/100%.pdf",
  ])("rejects invalid path %j without calling openTab", async (path) => {
    const openTab = vi.fn<OpenTabFn>();
    await expect(openPdfAtPage(base(openTab, { path }))).rejects.toBeInstanceOf(InvalidPdfPathError);
    expect(openTab).not.toHaveBeenCalled();
  });

  it.each(["assets/x.pdf", "assets/sub/My Doc é.PDF", "assets/a..b.pdf"])(
    "accepts path %j",
    async (path) => {
      const openTab = vi.fn<OpenTabFn>().mockResolvedValue(undefined);
      const handle = await openPdfAtPage(base(openTab, { path, timeoutMs: 5 }));
      handle.ready.catch(() => undefined);
      handle.dispose();
      expect(openTab).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, -1, 1.2, Number.NaN])("rejects invalid page %s", async (page) => {
    const openTab = vi.fn<OpenTabFn>();
    await expect(openPdfAtPage(base(openTab, { page }))).rejects.toThrow(RangeError);
    expect(openTab).not.toHaveBeenCalled();
  });
});
