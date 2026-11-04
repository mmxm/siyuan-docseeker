// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MemoryThumbnailCache, type ThumbnailCache } from "../../../src/search/thumbnailCache";
import { createThumbnailLoader, type ThumbnailRenderer } from "../../../src/ui/thumbnailLoader";

type Entry = { target: Element; isIntersecting: boolean };

function setup(
  overrides: {
    renderer?: Partial<ThumbnailRenderer>;
    getPageMatches?: ReturnType<typeof vi.fn>;
    delay?: number;
    cache?: ThumbnailCache;
  } = {},
) {
  let cb: (e: Entry[]) => void = () => {};
  const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  const renderer: ThumbnailRenderer = {
    getPageSize: vi.fn(async () => ({ width: 600, height: 800 })),
    renderCrop: vi.fn(async () => new Blob(["png"])),
    ...overrides.renderer,
  };
  const getPageMatches =
    overrides.getPageMatches ??
    vi.fn(async () => ({ boxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], ordinals: [0] }));
  const cache = overrides.cache ?? new MemoryThumbnailCache({ maxEntries: 10, maxBytes: 1e6 });
  let n = 0;
  const createObjectUrl = vi.fn(() => `blob:${++n}`);
  const revokeObjectUrl = vi.fn();
  const onWarn = vi.fn();
  const loader = createThumbnailLoader({
    observerFactory: (c) => {
      cb = c;
      return observer;
    },
    getPageMatches: getPageMatches as never,
    renderer,
    cache,
    createObjectUrl,
    revokeObjectUrl,
    docVersion: 1,
    loadDelayMs: overrides.delay ?? 0,
    onWarn,
  });
  const show = (el: Element, v = true) => cb([{ target: el, isIntersecting: v }]);
  return { loader, observer, renderer, getPageMatches, cache, createObjectUrl, revokeObjectUrl, onWarn, show };
}

const req = { docId: "d", path: "a.pdf", page: 2, query: "foo", pdfSize: 10, pdfModifiedMs: 5 };
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("thumbnailLoader", () => {
  it("starts idle and observes the element", () => {
    const s = setup();
    const el = document.createElement("div");
    s.loader.attach(el, req);
    expect(el.dataset.state).toBe("idle");
    expect(s.observer.observe).toHaveBeenCalledWith(el);
  });

  it("renders, caches and displays image with percent highlights", async () => {
    const s = setup();
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    expect(el.dataset.state).toBe("loading");
    await flush();
    expect(el.dataset.state).toBe("ready");
    const img = el.querySelector("img");
    expect(img?.getAttribute("src")).toBe("blob:1");
    const hl = el.querySelectorAll<HTMLElement>("[data-docseeker-highlight]");
    expect(hl.length).toBe(1);
    expect(hl[0]?.style.left.endsWith("%")).toBe(true);
    expect(hl[0]?.style.position).toBe("absolute");
    expect(s.renderer.renderCrop).toHaveBeenCalledTimes(1);
  });

  it("crops on the area covering most query terms (termIndexes forwarded to the plan)", async () => {
    const wb = (xPt: number, yPt: number) => ({ x: xPt / 600, y: yPt / 800, width: 0.05, height: 0.015 });
    const getPageMatches = vi.fn(async () => ({
      boxes: [wb(50, 40), wb(50, 500), wb(120, 510)],
      ordinals: [0, 1, 2],
      termIndexes: [1, 0, 1],
    }));
    const s = setup({ getPageMatches });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    const call = (s.renderer.renderCrop as unknown as { mock: { calls: [{ crop: { y0: number; height: number } }][] } }).mock
      .calls[0]![0];
    expect(call.crop.y0).toBeGreaterThan(300);
    expect(call.crop.y0 + call.crop.height).toBeGreaterThanOrEqual(522);
  });

  it("uses cache on second attach without rendering", async () => {
    const s = setup();
    const a = document.createElement("div");
    s.loader.attach(a, req);
    s.show(a);
    await flush();
    const b = document.createElement("div");
    s.loader.attach(b, req);
    s.show(b);
    await flush();
    expect(b.dataset.state).toBe("ready");
    expect(s.renderer.renderCrop).toHaveBeenCalledTimes(1);
    expect(b.querySelectorAll("[data-docseeker-highlight]").length).toBe(1);
  });

  it("uses different cache entries for different queries and pdf stamps", async () => {
    const s = setup();
    for (const r of [req, { ...req, query: "bar" }, { ...req, pdfSize: 11 }]) {
      const el = document.createElement("div");
      s.loader.attach(el, r);
      s.show(el);
      await flush();
    }
    expect(s.renderer.renderCrop).toHaveBeenCalledTimes(3);
  });

  it("aborts when leaving the viewport and revokes nothing unready", async () => {
    let signal: AbortSignal | undefined;
    const s = setup({
      renderer: {
        renderCrop: vi.fn(({ signal: sg }) => {
          signal = sg;
          return new Promise<Blob>(() => {});
        }),
      },
    });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    expect(signal?.aborted).toBe(false);
    s.show(el, false);
    expect(signal?.aborted).toBe(true);
    expect(el.dataset.state).toBe("idle");
  });

  it("ignores a result arriving after abort", async () => {
    let resolve!: (b: Blob) => void;
    const s = setup({ renderer: { renderCrop: vi.fn(() => new Promise<Blob>((r) => (resolve = r))) } });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    s.show(el, false);
    resolve(new Blob(["x"]));
    await flush();
    expect(el.dataset.state).toBe("idle");
    expect(s.createObjectUrl).not.toHaveBeenCalled();
  });

  it("sets error state without throwing and warns", async () => {
    const s = setup({ renderer: { renderCrop: vi.fn(async () => Promise.reject(new Error("boom"))) } });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    expect(el.dataset.state).toBe("error");
    expect(el.textContent).toContain("Aperçu indisponible");
    expect(s.onWarn).toHaveBeenCalled();
  });

  it("does not warn on AbortError", async () => {
    const err = Object.assign(new Error("a"), { name: "AbortError" });
    const s = setup({ getPageMatches: vi.fn(async () => Promise.reject(err)) });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    expect(s.onWarn).not.toHaveBeenCalled();
  });

  it("revokes object URL and unobserves on detach, idempotently", async () => {
    const s = setup();
    const el = document.createElement("div");
    const detach = s.loader.attach(el, req);
    s.show(el);
    await flush();
    detach();
    detach();
    expect(s.revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(s.revokeObjectUrl).toHaveBeenCalledWith("blob:1");
    expect(s.observer.unobserve).toHaveBeenCalledWith(el);
    expect(el.querySelector("img")).toBeNull();
  });

  it("dispose revokes all, disconnects and aborts", async () => {
    const s = setup();
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    s.loader.dispose();
    expect(s.revokeObjectUrl).toHaveBeenCalledWith("blob:1");
    expect(s.observer.disconnect).toHaveBeenCalled();
  });

  it("reloads after leaving and re-entering, revoking the old url", async () => {
    const s = setup();
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    s.show(el, false);
    expect(s.revokeObjectUrl).toHaveBeenCalledWith("blob:1");
    s.show(el);
    await flush();
    expect(el.dataset.state).toBe("ready");
    expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:2");
  });

  it("ignores entries for unknown elements and repeated intersections", async () => {
    const s = setup();
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(document.createElement("div"));
    s.show(el);
    s.show(el);
    await flush();
    expect(s.getPageMatches).toHaveBeenCalledTimes(1);
  });

  it("falls back to no highlight when there are no matches", async () => {
    const s = setup({ getPageMatches: vi.fn(async () => ({ boxes: [], ordinals: [] })) });
    const el = document.createElement("div");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    expect(el.dataset.state).toBe("ready");
    expect(el.querySelectorAll("[data-docseeker-highlight]").length).toBe(0);
  });
});

describe("thumbnailLoader (review fixes)", () => {
  const readyEl = async (s: ReturnType<typeof setup>, r = req) => {
    const el = document.createElement("div");
    s.loader.attach(el, r);
    s.show(el);
    await flush();
    return el;
  };

  it("marks highlights with a class, aria-hidden and fills the image to match percentages", async () => {
    const s = setup();
    const el = await readyEl(s);
    const hl = el.querySelector<HTMLElement>("[data-docseeker-highlight]")!;
    expect(hl.className).toBe("docseeker-highlight");
    expect(hl.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector("img")!.style.objectFit).toBe("fill");
  });

  it("sets the frame aspect ratio from the crop as soon as the plan is known", async () => {
    const s = setup();
    const el = await readyEl(s);
    const ratio = el.style.getPropertyValue("aspect-ratio") || el.dataset["aspectRatio"] || "";
    const [w, h] = ratio.split("/").map((x) => Number(x));
    expect(w! / h!).toBeGreaterThan(0);
    expect(Number.isFinite(w! / h!)).toBe(true);
    expect(el.dataset["aspectRatio"]).toBeTruthy();
  });

  it("still shows the image when cache.get and cache.put throw, and warns", async () => {
    const cache: ThumbnailCache = {
      get: async () => {
        throw new Error("idb get");
      },
      put: async () => {
        throw new Error("idb put");
      },
      clear: async () => undefined,
    };
    const s = setup({ cache });
    const el = await readyEl(s);
    expect(el.dataset.state).toBe("ready");
    expect(el.querySelector("img")).not.toBeNull();
    expect(s.onWarn).toHaveBeenCalled();
  });

  it("creates nodes with the element's own document", async () => {
    const s = setup();
    const other = document.implementation.createHTMLDocument("x");
    const el = other.createElement("div");
    const spy = vi.spyOn(document, "createElement");
    s.loader.attach(el, req);
    s.show(el);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(el.querySelector("img")!.ownerDocument).toBe(other);
  });

  it("shows visible fallback text and warns with docId, page and path on failure", async () => {
    const s = setup({ renderer: { renderCrop: vi.fn(async () => Promise.reject(new Error("boom"))) } });
    const el = await readyEl(s);
    expect(el.dataset.state).toBe("error");
    expect(el.textContent).toContain("Aperçu indisponible");
    const message = String(s.onWarn.mock.calls[0]![0]);
    expect(message).toContain("d");
    expect(message).toContain("2");
    expect(message).toContain("a.pdf");
  });

  describe("load delay", () => {
    it("waits before loading and cancels when the element leaves first", async () => {
      vi.useFakeTimers();
      try {
        const s = setup({ delay: 100 });
        const el = document.createElement("div");
        s.loader.attach(el, req);
        s.show(el);
        await vi.advanceTimersByTimeAsync(50);
        s.show(el, false);
        await vi.advanceTimersByTimeAsync(200);
        await flush();
        expect(s.getPageMatches).not.toHaveBeenCalled();
        s.show(el);
        await vi.advanceTimersByTimeAsync(100);
        await flush();
        expect(s.getPageMatches).toHaveBeenCalledTimes(1);
        expect(el.dataset.state).toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not leave a timer behind after detach", () => {
      vi.useFakeTimers();
      try {
        const s = setup({ delay: 100 });
        const el = document.createElement("div");
        const detach = s.loader.attach(el, req);
        s.show(el);
        detach();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
