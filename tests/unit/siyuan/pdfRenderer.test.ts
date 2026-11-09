import { describe, expect, it, vi } from "vitest";
import {
  createPdfRenderer,
  PdfLoadError,
  PdfRenderError,
  type RenderableDocument,
  type RenderCanvas,
} from "../../../src/siyuan/pdfRenderer";

const CROP = { x0: 10, y0: 20, width: 100, height: 50 };

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeOptions {
  numPages?: number;
  pageSize?: { width: number; height: number };
  /** If set, render() waits for this before resolving. */
  gate?: () => Promise<void>;
  renderError?: Error;
  destroyError?: Error;
}

function makeDoc(opts: FakeOptions = {}) {
  const renders: Array<Record<string, unknown>> = [];
  const cancels: number[] = [];
  const state = { active: 0, maxActive: 0 };
  const destroy = vi.fn(() => {
    if (opts.destroyError) throw opts.destroyError;
  });
  const doc: RenderableDocument = {
    numPages: opts.numPages ?? 3,
    getPage: async () => ({
      getViewport: ({ scale }) => {
        const size = opts.pageSize ?? { width: 600, height: 800 };
        return { width: size.width * scale, height: size.height * scale };
      },
      render: (params) => {
        renders.push(params as unknown as Record<string, unknown>);
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        const gate = opts.gate?.() ?? Promise.resolve();
        const cancelled = deferred();
        const promise = Promise.race([
          gate.then(() => {
            if (opts.renderError) throw opts.renderError;
          }),
          cancelled.promise.then(() => {
            throw new Error("RenderingCancelledException");
          }),
        ]).finally(() => {
          state.active--;
        });
        return {
          promise,
          cancel: () => {
            cancels.push(1);
            cancelled.resolve();
          },
        };
      },
    }),
    destroy,
  };
  return { doc, renders, cancels, state, destroy };
}

/**
 * Sans blob imposé, le faux canvas se comporte comme un navigateur qui sait encoder le type demandé
 * (le blob porte le type reçu) : un PNG renvoyé pour une demande WebP déclencherait désormais, à juste titre,
 * le repli JPEG.
 */
function makeCanvases(blob?: Blob | null) {
  const canvases: Array<RenderCanvas & { toBlobArgs?: unknown[] }> = [];
  const createCanvas = (w: number, h: number): RenderCanvas => {
    const canvas: RenderCanvas & { toBlobArgs?: unknown[] } = {
      width: w,
      height: h,
      getContext: () => ({ tag: "ctx" }),
      toBlob: (cb, type, quality) => {
        canvas.toBlobArgs = [type, quality];
        cb(blob === undefined ? new Blob(["x"], { type: type ?? "" }) : blob);
      },
    };
    canvases.push(canvas);
    return canvas;
  };
  return { canvases, createCanvas };
}

function setup(opts: FakeOptions & { max?: number; concurrency?: number } = {}) {
  const fake = makeDoc(opts);
  const { canvases, createCanvas } = makeCanvases();
  const loadDocument = vi.fn(async (_path: string, _signal?: AbortSignal) => fake.doc);
  const onWarn = vi.fn();
  const renderer = createPdfRenderer({
    loadDocument,
    createCanvas,
    maxOpenDocuments: opts.max,
    concurrency: opts.concurrency,
    onWarn,
  });
  return { fake, canvases, loadDocument, onWarn, renderer };
}

describe("getPageSize", () => {
  it("returns the scale 1 viewport size (rotation included)", async () => {
    const { renderer } = setup({ pageSize: { width: 800, height: 600 } });
    expect(await renderer.getPageSize("a.pdf", 1)).toEqual({ width: 800, height: 600 });
  });

  it.each([0, 4, 1.5, -1, Number.NaN])("rejects page %s with RangeError", async (page) => {
    const { renderer } = setup({ numPages: 3 });
    await expect(renderer.getPageSize("a.pdf", page)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("renderCrop", () => {
  it("renders only the crop area on a sized offscreen canvas", async () => {
    const { renderer, fake, canvases } = setup();
    const blob = await renderer.renderCrop({ path: "a.pdf", page: 2, crop: CROP, scale: 1.5 });
    expect(blob).toBeInstanceOf(Blob);
    expect(canvases[0]!.toBlobArgs).toEqual(["image/webp", 0.8]);
    const params = fake.renders[0] as {
      viewport: { width: number };
      transform: number[];
      canvasContext: unknown;
      canvas: unknown;
    };
    expect(params.viewport.width).toBe(900);
    expect(params.transform).toEqual([1, 0, 0, 1, -15, -30]);
    // Both parameter styles are supplied (PDF.js canvasContext and canvas variants).
    expect(params.canvasContext).toEqual({ tag: "ctx" });
    expect(params.canvas).toBe(canvases[0]!);
  });

  it("sizes the canvas with ceil(crop * scale) while rendering", async () => {
    const gate = deferred();
    const { renderer, canvases } = setup({ gate: () => gate.promise });
    const p = renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1.25 });
    await tick();
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([125, 63]);
    gate.resolve();
    await p;
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([0, 0]);
  });

  it("uses the injected mime type and quality", async () => {
    const fake = makeDoc();
    const { canvases, createCanvas } = makeCanvases();
    const renderer = createPdfRenderer({
      loadDocument: async () => fake.doc,
      createCanvas,
      mimeType: "image/webp",
      quality: 0.8,
      onWarn: vi.fn(),
    });
    await renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    expect(canvases[0]!.toBlobArgs).toEqual(["image/webp", 0.8]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects scale %s", async (scale) => {
    const { renderer } = setup();
    await expect(
      renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects an empty crop", async () => {
    const { renderer } = setup();
    await expect(
      renderer.renderCrop({ path: "a.pdf", page: 1, crop: { ...CROP, width: 0 }, scale: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects an out-of-range page with RangeError", async () => {
    const { renderer } = setup({ numPages: 2 });
    await expect(
      renderer.renderCrop({ path: "a.pdf", page: 3, crop: CROP, scale: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("reuses the open document across renders", async () => {
    const { renderer, loadDocument } = setup();
    await renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    await renderer.renderCrop({ path: "a.pdf", page: 2, crop: CROP, scale: 1 });
    await renderer.getPageSize("a.pdf", 3);
    expect(loadDocument).toHaveBeenCalledTimes(1);
  });

  it("wraps a toBlob null result in PdfRenderError and frees the canvas", async () => {
    const fake = makeDoc();
    const { canvases, createCanvas } = makeCanvases(null);
    const renderer = createPdfRenderer({
      loadDocument: async () => fake.doc,
      createCanvas,
      onWarn: vi.fn(),
    });
    await expect(
      renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 }),
    ).rejects.toBeInstanceOf(PdfRenderError);
    expect(canvases[0]!.width).toBe(0);
  });
});

describe("errors", () => {
  it("wraps load errors in PdfLoadError and does not cache them", async () => {
    const fake = makeDoc();
    const { createCanvas } = makeCanvases();
    const cause = new Error("boom");
    const loadDocument = vi
      .fn<(p: string, s?: AbortSignal) => Promise<RenderableDocument>>()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue(fake.doc);
    const renderer = createPdfRenderer({ loadDocument, createCanvas, onWarn: vi.fn() });

    const err = await renderer
      .renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLoadError);
    expect((err as PdfLoadError).cause).toBe(cause);

    await expect(
      renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 }),
    ).resolves.toBeInstanceOf(Blob);
    expect(loadDocument).toHaveBeenCalledTimes(2);
  });

  it("wraps synchronous loadDocument throws in PdfLoadError", async () => {
    const { createCanvas } = makeCanvases();
    const renderer = createPdfRenderer({
      loadDocument: () => {
        throw new Error("sync");
      },
      createCanvas,
      onWarn: vi.fn(),
    });
    await expect(renderer.getPageSize("a.pdf", 1)).rejects.toBeInstanceOf(PdfLoadError);
  });

  it("wraps render errors in PdfRenderError, frees the canvas, keeps nothing cached", async () => {
    const { renderer, canvases, fake } = setup({ renderError: new Error("bad page") });
    const err = await renderer
      .renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as PdfRenderError).cause).toEqual(new Error("bad page"));
    expect(canvases[0]!.width).toBe(0);
    expect(fake.renders).toHaveLength(1);
  });
});

describe("document LRU", () => {
  function multi(max: number) {
    const docs = new Map<string, ReturnType<typeof makeDoc>>();
    const { createCanvas } = makeCanvases();
    const gates = new Map<string, Deferred>();
    const loadDocument = vi.fn(async (path: string) => {
      const fake = makeDoc({ gate: () => gates.get(path)?.promise ?? Promise.resolve() });
      docs.set(path, fake);
      return fake.doc;
    });
    const renderer = createPdfRenderer({
      loadDocument,
      createCanvas,
      maxOpenDocuments: max,
      onWarn: vi.fn(),
    });
    return { docs, gates, loadDocument, renderer };
  }
  const render = (r: ReturnType<typeof multi>["renderer"], path: string) =>
    r.renderCrop({ path, page: 1, crop: CROP, scale: 1 });

  it("destroys the least recently used document on eviction", async () => {
    const { renderer, docs } = multi(2);
    await render(renderer, "a");
    await render(renderer, "b");
    await render(renderer, "a"); // a becomes most recent
    await render(renderer, "c"); // evicts b
    expect(docs.get("b")?.destroy).toHaveBeenCalledTimes(1);
    expect(docs.get("a")?.destroy).not.toHaveBeenCalled();
    expect(docs.get("c")?.destroy).not.toHaveBeenCalled();
  });

  it("never destroys a document that is rendering; evicts an idle one instead", async () => {
    const { renderer, docs, gates } = multi(1);
    gates.set("a", deferred());
    const pa = render(renderer, "a");
    await tick();
    await render(renderer, "b");
    await tick();
    // Over capacity, but a is busy: only the idle b can go.
    expect(docs.get("a")?.destroy).not.toHaveBeenCalled();
    expect(docs.get("b")?.destroy).toHaveBeenCalledTimes(1);
    gates.get("a")?.resolve();
    await pa;
    expect(docs.get("a")?.destroy).not.toHaveBeenCalled();
  });

  it("reports destroy failures through onWarn", async () => {
    const fake = makeDoc({ destroyError: new Error("nope") });
    const { createCanvas } = makeCanvases();
    const onWarn = vi.fn();
    const renderer = createPdfRenderer({
      loadDocument: async () => fake.doc,
      createCanvas,
      maxOpenDocuments: 1,
      onWarn,
    });
    await renderer.getPageSize("a", 1);
    await renderer.getPageSize("b", 1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency", () => {
  it("never runs more renders than the limit", async () => {
    const gate = deferred();
    const { renderer, fake } = setup({ concurrency: 2, gate: () => gate.promise });
    const all = [1, 2, 3, 1].map((page) =>
      renderer.renderCrop({ path: "a.pdf", page, crop: CROP, scale: 1 }),
    );
    await tick();
    expect(fake.state.active).toBe(2);
    gate.resolve();
    await Promise.all(all);
    expect(fake.state.maxActive).toBe(2);
    expect(fake.renders).toHaveLength(4);
  });

  it("defaults to a concurrency of 2", async () => {
    const gate = deferred();
    const { renderer, fake } = setup({ gate: () => gate.promise });
    const all = [1, 2, 3].map((page) =>
      renderer.renderCrop({ path: "a.pdf", page, crop: CROP, scale: 1 }),
    );
    await tick();
    expect(fake.state.active).toBe(2);
    gate.resolve();
    await Promise.all(all);
  });
});

describe("abort", () => {
  it("rejects with AbortError when already aborted, without loading", async () => {
    const { renderer, loadDocument } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await renderer
      .renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1, signal: ctrl.signal })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it("cancels the render task and frees the canvas on abort", async () => {
    const gate = deferred();
    const { renderer, fake, canvases } = setup({ gate: () => gate.promise });
    const ctrl = new AbortController();
    const p = renderer.renderCrop({
      path: "a.pdf",
      page: 1,
      crop: CROP,
      scale: 1,
      signal: ctrl.signal,
    });
    await tick();
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(fake.cancels).toHaveLength(1);
    await tick();
    expect(canvases[0]!.width).toBe(0);
    expect(fake.state.active).toBe(0);
  });

  it("drops a queued request without loading or rendering it", async () => {
    const gate = deferred();
    const { renderer, loadDocument } = setup({ concurrency: 1, gate: () => gate.promise });
    const first = renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    const ctrl = new AbortController();
    const queued = renderer.renderCrop({
      path: "b.pdf",
      page: 1,
      crop: CROP,
      scale: 1,
      signal: ctrl.signal,
    });
    await tick();
    ctrl.abort();
    const err = await queued.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    gate.resolve();
    await first;
    expect(loadDocument).toHaveBeenCalledTimes(1);
  });

  it("aborts the document load when its only waiter aborts, and does not cache it", async () => {
    const fake = makeDoc();
    const { createCanvas } = makeCanvases();
    const pending = deferred<RenderableDocument>();
    let loadSignal: AbortSignal | undefined;
    const loadDocument = vi
      .fn<(p: string, s?: AbortSignal) => Promise<RenderableDocument>>()
      .mockImplementationOnce((_p, s) => {
        loadSignal = s;
        return pending.promise;
      })
      .mockResolvedValue(fake.doc);
    const renderer = createPdfRenderer({ loadDocument, createCanvas, onWarn: vi.fn() });
    const ctrl = new AbortController();
    const p = renderer.getPageSize("a.pdf", 1, ctrl.signal);
    await tick();
    ctrl.abort();
    expect(((await p.catch((e: unknown) => e)) as Error).name).toBe("AbortError");
    expect(loadSignal?.aborted).toBe(true);

    // The late document is destroyed, never leaked.
    const late = makeDoc();
    pending.resolve(late.doc);
    await tick();
    expect(late.destroy).toHaveBeenCalledTimes(1);

    await expect(renderer.getPageSize("a.pdf", 1)).resolves.toBeDefined();
    expect(loadDocument).toHaveBeenCalledTimes(2);
  });
});

describe("dispose", () => {
  it("destroys open documents and rejects later calls", async () => {
    const { renderer, fake } = setup();
    await renderer.getPageSize("a.pdf", 1);
    renderer.dispose();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    await expect(renderer.getPageSize("a.pdf", 1)).rejects.toThrow();
    renderer.dispose(); // idempotent
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("aborts running renders and destroys their document once released", async () => {
    const gate = deferred();
    const { renderer, fake } = setup({ gate: () => gate.promise });
    const p = renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    await tick();
    renderer.dispose();
    expect(((await p.catch((e: unknown) => e)) as Error).name).toBe("AbortError");
    await tick();
    expect(fake.cancels).toHaveLength(1);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("robustness (review fixes)", () => {
  it("destroy() is called once when dispose() happens during acquire", async () => {
    const load = deferred<RenderableDocument>();
    const fake = makeDoc();
    const renderer = createPdfRenderer({
      loadDocument: () => load.promise,
      createCanvas: makeCanvases().createCanvas,
      onWarn: vi.fn(),
    });
    const p = renderer.getPageSize("a.pdf", 1).catch((e: unknown) => e);
    await tick();
    renderer.dispose();
    load.resolve(fake.doc);
    await p;
    await tick();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("getPageSize goes through the same concurrency queue as renderCrop", async () => {
    const gate = deferred();
    const { renderer } = setup({ gate: () => gate.promise, concurrency: 1 });
    const render = renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    await tick();
    let sized = false;
    const size = renderer.getPageSize("a.pdf", 2).then((s) => {
      sized = true;
      return s;
    });
    await tick();
    expect(sized).toBe(false);
    gate.resolve();
    await render;
    expect(await size).toEqual({ width: 600, height: 800 });
  });

  it("falls back to PNG when toBlob returns null for the default WebP", async () => {
    const fake = makeDoc();
    const calls: Array<string | undefined> = [];
    const renderer = createPdfRenderer({
      loadDocument: async () => fake.doc,
      createCanvas: () => ({
        width: 1,
        height: 1,
        getContext: () => ({}),
        toBlob: (cb, type) => {
          calls.push(type);
          cb(type === "image/png" ? new Blob(["p"], { type: "image/png" }) : null);
        },
      }),
      onWarn: vi.fn(),
    });
    const blob = await renderer.renderCrop({ path: "a.pdf", page: 1, crop: CROP, scale: 1 });
    expect(blob.type).toBe("image/png");
    expect(calls).toEqual(["image/webp", "image/jpeg", "image/png"]);
  });

  function sniffingRenderer(
    answer: (type: string) => Blob | null,
    calls: unknown[][],
    mimeType?: string,
    onWarn: (message: string) => void = vi.fn(),
  ) {
    const fake = makeDoc();
    return createPdfRenderer({
      loadDocument: async () => fake.doc,
      createCanvas: () => ({
        width: 1,
        height: 1,
        getContext: () => ({}),
        toBlob: (cb, type, quality) => {
          calls.push([type, quality]);
          cb(answer(type ?? ""));
        },
      }),
      ...(mimeType ? { mimeType } : {}),
      onWarn,
    });
  }
  const crop = { path: "a.pdf", page: 1, crop: CROP, scale: 1 };

  it("re-encodes to JPEG 0.8 when the browser ignores WebP and returns a PNG, then remembers it", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer(
      (t) => new Blob(["x"], { type: t === "image/webp" ? "image/png" : t }),
      calls,
    );
    expect((await renderer.renderCrop(crop)).type).toBe("image/jpeg");
    expect(calls).toEqual([["image/webp", 0.8], ["image/jpeg", 0.8]]);
    calls.length = 0;
    expect((await renderer.renderCrop(crop)).type).toBe("image/jpeg");
    expect(calls).toEqual([["image/jpeg", 0.8]]);
  });

  it("treats an empty blob type as a mismatch", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer((t) => new Blob(["x"], { type: t === "image/webp" ? "" : t }), calls);
    expect((await renderer.renderCrop(crop)).type).toBe("image/jpeg");
  });

  it("keeps the first non-null blob when JPEG is not honoured either", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer(() => new Blob(["x"], { type: "image/png" }), calls);
    expect((await renderer.renderCrop(crop)).type).toBe("image/png");
    expect(calls).toHaveLength(3);
  });

  it("when no requested type is honoured, remembers it: the next thumbnails pay a single encoding", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer(() => new Blob(["x"], { type: "image/gif" }), calls);
    expect((await renderer.renderCrop(crop)).type).toBe("image/gif");
    calls.length = 0;
    expect((await renderer.renderCrop(crop)).type).toBe("image/gif");
    expect(calls).toHaveLength(1);
  });

  it("a one-off null never degrades durably: the next render starts again with WebP", async () => {
    const calls: unknown[][] = [];
    let first = true;
    const renderer = sniffingRenderer((t) => {
      if (first && t === "image/webp") {
        first = false;
        return null;
      }
      return new Blob(["x"], { type: t });
    }, calls);
    expect((await renderer.renderCrop(crop)).type).toBe("image/jpeg");
    calls.length = 0;
    expect((await renderer.renderCrop(crop)).type).toBe("image/webp");
    expect(calls.map((c) => c[0])).toEqual(["image/webp"]);
  });

  it("warns once per renderer when the format changes", async () => {
    const calls: unknown[][] = [];
    const onWarn = vi.fn();
    const renderer = sniffingRenderer(
      (t) => new Blob(["x"], { type: t === "image/webp" ? "image/png" : t }),
      calls,
      undefined,
      onWarn,
    );
    await renderer.renderCrop(crop);
    await renderer.renderCrop(crop);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toMatch(/WebP.*JPEG/);
  });

  it("warns once when it keeps a blob of a type that was not requested", async () => {
    const calls: unknown[][] = [];
    const onWarn = vi.fn();
    const renderer = sniffingRenderer(() => new Blob(["x"], { type: "image/gif" }), calls, undefined, onWarn);
    await renderer.renderCrop(crop);
    await renderer.renderCrop(crop);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when WebP works", async () => {
    const onWarn = vi.fn();
    const renderer = sniffingRenderer((t) => new Blob(["x"], { type: t }), [], undefined, onWarn);
    await renderer.renderCrop(crop);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("an empty-type blob is not a best result: the chain goes on to PNG", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer((t) => new Blob(["x"], { type: t === "image/png" ? t : "" }), calls);
    expect((await renderer.renderCrop(crop)).type).toBe("image/png");
    expect(calls.map((c) => c[0])).toEqual(["image/webp", "image/jpeg", "image/png"]);
  });

  it("still returns an empty-type blob when nothing better exists", async () => {
    const renderer = sniffingRenderer(() => new Blob(["x"], { type: "" }), []);
    expect((await renderer.renderCrop(crop)).size).toBe(1);
  });

  it("keeps the first blob when JPEG returns null", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer(
      (t) => (t === "image/webp" ? new Blob(["x"], { type: "image/png" }) : null),
      calls,
    );
    expect((await renderer.renderCrop(crop)).type).toBe("image/png");
  });

  it("does not memorise anything when WebP works", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer((t) => new Blob(["x"], { type: t }), calls);
    await renderer.renderCrop(crop);
    await renderer.renderCrop(crop);
    expect(calls.map((c) => c[0])).toEqual(["image/webp", "image/webp"]);
  });

  it("with an explicit mimeType, falls back to PNG on a type mismatch", async () => {
    const calls: unknown[][] = [];
    const renderer = sniffingRenderer(
      (t) => new Blob(["x"], { type: t === "image/avif" ? "image/gif" : t }),
      calls,
      "image/avif",
    );
    expect((await renderer.renderCrop(crop)).type).toBe("image/png");
    expect(calls.map((c) => c[0])).toEqual(["image/avif", "image/png"]);
  });
});

describe("getPageCount", () => {
  it("renvoie le nombre de pages du PDF, sans rendre ni lire de page", async () => {
    const { renderer, fake } = setup({ numPages: 7 });
    expect(await renderer.getPageCount("a.pdf")).toBe(7);
    expect(fake.renders).toHaveLength(0);
  });

  it("réutilise le document ouvert (une seule ouverture avec getPageSize)", async () => {
    const { renderer, loadDocument } = setup({ numPages: 3 });
    await renderer.getPageSize("a.pdf", 1);
    await renderer.getPageCount("a.pdf");
    expect(loadDocument).toHaveBeenCalledTimes(1);
  });

  it("signale l'échec d'ouverture en PdfLoadError, cause d'origine conservée", async () => {
    const onWarn = vi.fn();
    const boom = new Error("illisible");
    const renderer = createPdfRenderer({ loadDocument: async () => Promise.reject(boom), createCanvas: () => makeCanvases().createCanvas(1, 1), onWarn });
    await expect(renderer.getPageCount("a.pdf")).rejects.toMatchObject({ name: "PdfLoadError", cause: boom });
  });

  it("est annulable : un signal déjà annulé rejette en AbortError", async () => {
    const { renderer } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(renderer.getPageCount("a.pdf", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuse un renderer disposé", async () => {
    const { renderer } = setup();
    renderer.dispose();
    await expect(renderer.getPageCount("a.pdf")).rejects.toThrow(/dispos/);
  });
});

const HEAVY_PDF_BYTES = 20 * 1024 * 1024;

describe("workersPerDocument", () => {
  function pool(opts: { workers?: number; max?: number; concurrency?: number } = {}) {
    const { createCanvas } = makeCanvases();
    const gate = { current: deferred() };
    const instances: Array<{ path: string; fake: ReturnType<typeof makeDoc>; signal?: AbortSignal | undefined }> = [];
    const loadDocument = vi.fn(async (path: string, signal?: AbortSignal) => {
      const fake = makeDoc({ gate: () => gate.current.promise });
      instances.push({ path, fake, signal });
      return fake.doc;
    });
    const onWarn = vi.fn();
    const renderer = createPdfRenderer({
      loadDocument,
      createCanvas,
      workersPerDocument: opts.workers,
      maxOpenDocuments: opts.max,
      concurrency: opts.concurrency ?? 8,
      onWarn,
    });
    const render = (path: string, page = 1, pdfSize: number | undefined = HEAVY_PDF_BYTES) =>
      renderer.renderCrop({ path, page, crop: CROP, scale: 1, ...(pdfSize === undefined ? {} : { pdfSize }) });
    return { renderer, loadDocument, instances, gate, onWarn, render };
  }

  it("par défaut (1) : les rendus simultanés d'un même PDF partagent un seul exemplaire", async () => {
    const p = pool({ max: 6 });
    const all = [p.render("a"), p.render("a"), p.render("a")];
    await tick();
    expect(p.loadDocument).toHaveBeenCalledTimes(1);
    p.gate.current.resolve();
    await Promise.all(all);
  });

  it("ouvre jusqu'à N exemplaires pour des rendus simultanés, puis répartit sur le moins chargé", async () => {
    const p = pool({ workers: 2, max: 6 });
    const all = [p.render("a", 1), p.render("a", 2), p.render("a", 3), p.render("a", 1)];
    await tick();
    expect(p.loadDocument).toHaveBeenCalledTimes(2);
    expect(p.instances.map((i) => i.fake.renders.length)).toEqual([2, 2]);
    p.gate.current.resolve();
    await Promise.all(all);
    expect(p.instances.map((i) => i.fake.destroy.mock.calls.length)).toEqual([0, 0]);
  });

  it("réutilise un exemplaire libre déjà chargé au lieu d'en ouvrir un nouveau", async () => {
    const p = pool({ workers: 3, max: 6 });
    p.gate.current.resolve();
    await p.render("a");
    await p.render("a");
    await p.render("a");
    expect(p.loadDocument).toHaveBeenCalledTimes(1);
  });

  it("le plafond maxOpenDocuments compte les exemplaires : un exemplaire inactif est détruit", async () => {
    const p = pool({ workers: 2, max: 2 });
    const first = [p.render("a"), p.render("a")];
    await tick();
    p.gate.current.resolve();
    await Promise.all(first);
    expect(p.loadDocument).toHaveBeenCalledTimes(2);
    await p.render("b");
    const destroyed = p.instances.filter((i) => i.fake.destroy.mock.calls.length > 0);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.path).toBe("a");
    expect(p.instances.find((i) => i.path === "b")!.fake.destroy).not.toHaveBeenCalled();
  });

  it("n'évince jamais un exemplaire en cours d'usage", async () => {
    const p = pool({ workers: 2, max: 1 });
    const busy = p.render("a");
    await tick();
    const other = p.render("b");
    await tick();
    // Au-dessus du plafond, mais les deux exemplaires travaillent : aucun n'est détruit.
    expect(p.instances.every((i) => i.fake.destroy.mock.calls.length === 0)).toBe(true);
    p.gate.current.resolve();
    await Promise.all([busy, other]);
  });

  it("getPageSize et getPageCount réutilisent un exemplaire existant, même occupé", async () => {
    const p = pool({ workers: 3, max: 6 });
    const busy = p.render("a");
    await tick();
    expect(await p.renderer.getPageCount("a")).toBe(3);
    expect(p.loadDocument).toHaveBeenCalledTimes(1);
    p.gate.current.resolve();
    await busy;
    await p.renderer.getPageSize("a", 1);
    expect(p.loadDocument).toHaveBeenCalledTimes(1);
  });

  it("n'inscrit pas en cache un chargement en échec, le suivant réessaie", async () => {
    const { createCanvas } = makeCanvases();
    const fake = makeDoc();
    const loadDocument = vi.fn<(p: string, s?: AbortSignal) => Promise<RenderableDocument>>();
    const gate = deferred();
    const gated = makeDoc({ gate: () => gate.promise });
    loadDocument.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(gated.doc).mockResolvedValue(fake.doc);
    const renderer = createPdfRenderer({ loadDocument, createCanvas, workersPerDocument: 2, concurrency: 4, onWarn: vi.fn() });
    const r = (page: number) => renderer.renderCrop({ path: "a", page, crop: CROP, scale: 1, pdfSize: HEAVY_PDF_BYTES });
    expect(await r(1).catch((e: unknown) => e)).toBeInstanceOf(PdfLoadError);
    // L'échec n'a laissé aucun exemplaire fantôme : deux rendus simultanés rouvrent deux exemplaires.
    const one = r(1);
    const two = r(2);
    await tick();
    expect(loadDocument).toHaveBeenCalledTimes(3);
    gate.resolve();
    await Promise.all([one, two]);
  });

  it("l'annulation d'un rendu n'abandonne que son propre chargement", async () => {
    const p = pool({ workers: 2, max: 6 });
    const hold = deferred<RenderableDocument>();
    p.loadDocument.mockImplementationOnce(async (path: string, signal?: AbortSignal) => {
      const fake = makeDoc({ gate: () => p.gate.current.promise });
      p.instances.push({ path, fake, signal });
      return fake.doc;
    });
    const first = p.render("a");
    await tick();
    const controller = new AbortController();
    p.loadDocument.mockImplementationOnce((path: string, signal?: AbortSignal) => {
      p.instances.push({ path, fake: makeDoc(), signal });
      return hold.promise;
    });
    const second = p.renderer.renderCrop({
      path: "a",
      page: 1,
      crop: CROP,
      scale: 1,
      pdfSize: HEAVY_PDF_BYTES,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(p.instances[0]!.signal?.aborted).toBe(false);
    expect(p.instances[1]!.signal?.aborted).toBe(true);
    p.gate.current.resolve();
    await first;
  });

  it("dispose() détruit tous les exemplaires, une seule fois", async () => {
    const p = pool({ workers: 2, max: 6 });
    const all = [p.render("a"), p.render("a"), p.render("b")];
    await tick();
    p.gate.current.resolve();
    await Promise.all(all);
    p.renderer.dispose();
    p.renderer.dispose();
    expect(p.instances).toHaveLength(3);
    for (const i of p.instances) expect(i.fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("dispose() pendant l'usage : destruction à la fin du rendu, sans doublon", async () => {
    const p = pool({ workers: 2, max: 6 });
    const busy = p.render("a").catch((e: unknown) => e);
    await tick();
    p.renderer.dispose();
    p.gate.current.resolve();
    await busy;
    await tick();
    for (const i of p.instances) expect(i.fake.destroy.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("PDF léger ou taille inconnue : un seul exemplaire malgré workersPerDocument", async () => {
    const p = pool({ workers: 3, max: 6 });
    const all = [p.render("a", 1, undefined), p.render("a", 2, 600_000), p.render("a", 3, HEAVY_PDF_BYTES - 1)];
    await tick();
    expect(p.loadDocument).toHaveBeenCalledTimes(1);
    p.gate.current.resolve();
    await Promise.all(all);
  });

  it("PDF lourd (>= HEAVY_PDF_BYTES) : plusieurs exemplaires", async () => {
    const p = pool({ workers: 3, max: 6 });
    const all = [p.render("a", 1), p.render("a", 2), p.render("a", 3)];
    await tick();
    expect(p.loadDocument).toHaveBeenCalledTimes(3);
    p.gate.current.resolve();
    await Promise.all(all);
  });

  it("le pic d'exemplaires d'un même PDF ne dépasse jamais maxOpenDocuments", async () => {
    const p = pool({ workers: 4, max: 2 });
    const all = [p.render("a", 1), p.render("a", 2), p.render("a", 3), p.render("a", 1)];
    await tick();
    expect(p.loadDocument).toHaveBeenCalledTimes(2);
    p.gate.current.resolve();
    await Promise.all(all);
  });

  it("avant d'ouvrir un exemplaire supplémentaire, évince un exemplaire inactif d'un autre PDF", async () => {
    const p = pool({ workers: 2, max: 2 });
    p.gate.current.resolve();
    await p.render("b");
    p.gate.current = deferred();
    const all = [p.render("a", 1), p.render("a", 2)];
    await tick();
    const b = p.instances.find((i) => i.path === "b")!;
    expect(b.fake.destroy).toHaveBeenCalledTimes(1);
    expect(p.instances.filter((i) => i.path === "a")).toHaveLength(2);
    p.gate.current.resolve();
    await Promise.all(all);
  });

  it("l'échec d'un exemplaire supplémentaire retombe sur un exemplaire chargé du même PDF", async () => {
    const { createCanvas } = makeCanvases();
    const gate = deferred();
    const gated = makeDoc({ gate: () => gate.promise });
    const loadDocument = vi.fn<(p: string, s?: AbortSignal) => Promise<RenderableDocument>>();
    loadDocument.mockResolvedValueOnce(gated.doc).mockRejectedValueOnce(new Error("boom"));
    const onWarn = vi.fn();
    const renderer = createPdfRenderer({ loadDocument, createCanvas, workersPerDocument: 2, concurrency: 4, onWarn });
    const r = (page: number) =>
      renderer.renderCrop({ path: "a", page, crop: CROP, scale: 1, pdfSize: HEAVY_PDF_BYTES });
    const first = r(1);
    await tick();
    const second = r(2);
    await tick();
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(onWarn).toHaveBeenCalled();
    expect(gated.renders).toHaveLength(2);
  });

  it("l'échec du premier exemplaire reste une erreur", async () => {
    const { createCanvas } = makeCanvases();
    const loadDocument = vi.fn(async () => {
      throw new Error("boom");
    });
    const renderer = createPdfRenderer({ loadDocument, createCanvas, workersPerDocument: 2, onWarn: vi.fn() });
    await expect(
      renderer.renderCrop({ path: "a", page: 1, crop: CROP, scale: 1, pdfSize: HEAVY_PDF_BYTES }),
    ).rejects.toBeInstanceOf(PdfLoadError);
  });
});
