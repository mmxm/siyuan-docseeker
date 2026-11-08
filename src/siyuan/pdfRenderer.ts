import { DEFAULT_MAX_OPEN_DOCUMENTS, DEFAULT_RENDER_CONCURRENCY } from "../core/constants";
import type { CropBounds } from "../core/crop";

const DEFAULT_MIME_TYPE = "image/webp";
const DEFAULT_QUALITY = 0.8;
const FALLBACK_MIME_TYPE = "image/png";

/** Minimal 2D canvas surface (HTMLCanvasElement or OffscreenCanvas wrapper). */
export interface RenderCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface RenderViewport {
  readonly width: number;
  readonly height: number;
}

export interface RenderTask {
  readonly promise: Promise<unknown>;
  cancel?(): void;
}

export interface RenderParams {
  readonly canvasContext: unknown;
  readonly canvas: unknown;
  readonly viewport: RenderViewport;
  readonly transform: readonly number[];
}

export interface RenderablePage {
  getViewport(params: { scale: number }): RenderViewport;
  render(params: RenderParams): RenderTask;
}

export interface RenderableDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<RenderablePage>;
  destroy(): Promise<void> | void;
}

export interface RenderCropRequest {
  readonly path: string;
  readonly page: number;
  readonly crop: CropBounds;
  readonly scale: number;
  readonly signal?: AbortSignal | undefined;
}

export interface PdfRenderer {
  getPageSize(
    path: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number }>;
  renderCrop(request: RenderCropRequest): Promise<Blob>;
  dispose(): void;
}

export interface PdfRendererDeps {
  readonly loadDocument: (path: string, signal?: AbortSignal) => Promise<RenderableDocument>;
  readonly createCanvas: (width: number, height: number) => RenderCanvas;
  readonly maxOpenDocuments?: number | undefined;
  readonly concurrency?: number | undefined;
  /** Output image type for toBlob (default image/webp, PNG fallback). */
  readonly mimeType?: string | undefined;
  readonly quality?: number | undefined;
  readonly onWarn: (message: string, error?: unknown) => void;
}

export class PdfLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PdfLoadError";
  }
}

export class PdfRenderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PdfRenderError";
  }
}

function abortError(): Error {
  return new DOMException("Rendu PDF annulé", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Settles with `promise`, or rejects with AbortError as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The PDF.js API differs between versions: older ones take `canvasContext`, newer ones `canvas`
 * (and deprecate `canvasContext`). The exact version bundled in SiYuan 6.4.299 is uncertain,
 * so both are supplied. `transform` shifts the page so that only the crop lands on the canvas.
 */
function buildRenderParams(
  canvas: RenderCanvas,
  context: unknown,
  viewport: RenderViewport,
  crop: CropBounds,
  scale: number,
): RenderParams {
  return {
    canvasContext: context,
    canvas,
    viewport,
    transform: [1, 0, 0, 1, -crop.x0 * scale, -crop.y0 * scale],
  };
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
}

function assertCrop(crop: CropBounds): void {
  if (!Number.isFinite(crop.x0) || !Number.isFinite(crop.y0)) {
    throw new RangeError("crop origin must be finite");
  }
  assertPositiveFinite("crop.width", crop.width);
  assertPositiveFinite("crop.height", crop.height);
}

function assertPage(page: number, numPages: number): void {
  if (!Number.isInteger(page) || page < 1 || page > numPages) {
    throw new RangeError(`page ${page} out of range [1, ${numPages}]`);
  }
}

interface DocEntry {
  readonly path: string;
  readonly controller: AbortController;
  readonly promise: Promise<RenderableDocument>;
  doc?: RenderableDocument;
  refs: number;
  /** Removed from the cache: destroy as soon as nobody uses it. */
  dropped: boolean;
  /** destroy() already requested: never call it twice. */
  destroyed: boolean;
}

interface QueueItem {
  readonly start: () => void;
}

export function createPdfRenderer(deps: PdfRendererDeps): PdfRenderer {
  const maxOpen = Math.max(1, deps.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS);
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_RENDER_CONCURRENCY);
  const mimeType = deps.mimeType ?? DEFAULT_MIME_TYPE;
  const quality = deps.quality ?? DEFAULT_QUALITY;
  const disposal = new AbortController();
  /** Map insertion order is the LRU order (oldest first). */
  const documents = new Map<string, DocEntry>();
  const pending: QueueItem[] = [];
  let active = 0;

  function destroyDocument(entry: DocEntry, doc: RenderableDocument, path: string): void {
    if (entry.destroyed) return;
    entry.destroyed = true;
    try {
      Promise.resolve(doc.destroy()).catch((error: unknown) =>
        deps.onWarn(`Échec de destroy() du PDF ${path}`, error),
      );
    } catch (error) {
      deps.onWarn(`Échec de destroy() du PDF ${path}`, error);
    }
  }

  function evictIdle(): void {
    for (const [path, entry] of documents) {
      if (documents.size <= maxOpen) return;
      if (entry.refs > 0 || !entry.doc) continue;
      documents.delete(path);
      destroyDocument(entry, entry.doc, path);
    }
  }

  function startLoad(path: string): DocEntry {
    const controller = new AbortController();
    const entry: DocEntry = {
      path,
      controller,
      dropped: false,
      destroyed: false,
      refs: 0,
      promise: Promise.resolve().then(() => deps.loadDocument(path, controller.signal)),
    };
    // Replace the raw promise by the tracked one (readonly for consumers only).
    (entry as { promise: Promise<RenderableDocument> }).promise = entry.promise.then(
      (doc) => {
        entry.doc = doc;
        if (entry.dropped) {
          destroyDocument(entry, doc, path);
          throw abortError();
        }
        return doc;
      },
      (error: unknown) => {
        if (documents.get(path) === entry) documents.delete(path);
        throw isAbortError(error) ? error : new PdfLoadError(`Chargement impossible : ${path}`, error);
      },
    );
    entry.promise.catch(() => undefined);
    return entry;
  }

  function release(entry: DocEntry): void {
    entry.refs--;
    if (entry.refs > 0) return;
    if (entry.dropped) {
      if (entry.doc) destroyDocument(entry, entry.doc, entry.path);
      return;
    }
    if (!entry.doc) {
      // Nobody waits for this load any more: cancel it and forget it.
      entry.dropped = true;
      entry.controller.abort();
      if (documents.get(entry.path) === entry) documents.delete(entry.path);
      return;
    }
    evictIdle();
  }

  async function acquire(
    path: string,
    signal: AbortSignal,
  ): Promise<{ entry: DocEntry; doc: RenderableDocument }> {
    let entry = documents.get(path);
    if (entry) {
      documents.delete(path); // refresh recency
    } else {
      entry = startLoad(path);
    }
    documents.set(path, entry);
    entry.refs++;
    try {
      const doc = await raceAbort(entry.promise, signal);
      evictIdle();
      return { entry, doc };
    } catch (error) {
      release(entry);
      throw error;
    }
  }

  function pump(): void {
    while (active < concurrency) {
      const item = pending.shift();
      if (!item) return;
      item.start();
    }
  }

  function schedule<T>(signal: AbortSignal, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        start: () => {
          signal.removeEventListener("abort", onAbort);
          active++;
          job()
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        },
      };
      const onAbort = (): void => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.push(item);
      pump();
    });
  }

  /** Signal aborted by the caller's signal or by dispose(); `cleanup` detaches the listeners. */
  function linkSignals(external: AbortSignal | undefined): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const sources = [external, disposal.signal].filter((s): s is AbortSignal => s !== undefined);
    const onAbort = (): void => controller.abort();
    for (const source of sources) {
      if (source.aborted) controller.abort();
      else source.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => sources.forEach((s) => s.removeEventListener("abort", onAbort)),
    };
  }

  async function withPage<T>(
    path: string,
    page: number,
    signal: AbortSignal,
    use: (page: RenderablePage) => Promise<T>,
  ): Promise<T> {
    const { entry, doc } = await acquire(path, signal);
    try {
      assertPage(page, doc.numPages);
      let pdfPage: RenderablePage;
      try {
        pdfPage = await raceAbort(doc.getPage(page), signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new PdfRenderError(`Page ${page} illisible : ${path}`, error);
      }
      return await use(pdfPage);
    } finally {
      release(entry);
    }
  }

  async function renderToBlob(
    pdfPage: RenderablePage,
    request: RenderCropRequest,
    signal: AbortSignal,
  ): Promise<Blob> {
    const { crop, scale } = request;
    const canvas = deps.createCanvas(Math.ceil(crop.width * scale), Math.ceil(crop.height * scale));
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new PdfRenderError("Contexte 2D indisponible");
      const viewport = pdfPage.getViewport({ scale });
      const task = pdfPage.render(buildRenderParams(canvas, context, viewport, crop, scale));
      const onAbort = (): void => {
        try {
          task.cancel?.();
        } catch {
          // Cancelling an already finished task is harmless.
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await raceAbort(task.promise, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      return await raceAbort(toBlob(canvas), signal);
    } catch (error) {
      if (isAbortError(error) || error instanceof PdfRenderError) throw error;
      throw new PdfRenderError(`Rendu impossible : ${request.path} p.${request.page}`, error);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function toBlobOnce(canvas: RenderCanvas, type: string): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, type === mimeType ? quality : undefined);
    });
  }

  /** Requested type first; PNG when the browser answers null (unsupported type or encoder failure). */
  async function toBlob(canvas: RenderCanvas): Promise<Blob> {
    const first = await toBlobOnce(canvas, mimeType);
    if (first) return first;
    if (mimeType !== FALLBACK_MIME_TYPE) {
      const second = await toBlobOnce(canvas, FALLBACK_MIME_TYPE);
      if (second) return second;
    }
    throw new PdfRenderError("toBlob a renvoyé null");
  }

  function guard(): void {
    if (disposal.signal.aborted) throw new Error("PdfRenderer disposé");
  }

  return {
    async getPageSize(path, page, signal) {
      guard();
      const linked = linkSignals(signal);
      try {
        if (linked.signal.aborted) throw abortError();
        const { signal } = linked;
        return await schedule(signal, () =>
          withPage(path, page, signal, async (pdfPage) => {
            const { width, height } = pdfPage.getViewport({ scale: 1 });
            return { width, height };
          }),
        );
      } finally {
        linked.cleanup();
      }
    },

    async renderCrop(request) {
      guard();
      assertPositiveFinite("scale", request.scale);
      assertCrop(request.crop);
      const linked = linkSignals(request.signal);
      try {
        if (linked.signal.aborted) throw abortError();
        const { signal } = linked;
        return await schedule(signal, () =>
          withPage(request.path, request.page, signal, (pdfPage) =>
            renderToBlob(pdfPage, request, signal),
          ),
        );
      } finally {
        linked.cleanup();
      }
    },

    dispose() {
      if (disposal.signal.aborted) return;
      disposal.abort();
      pending.length = 0;
      for (const [path, entry] of documents) {
        entry.dropped = true;
        if (entry.refs === 0) {
          if (entry.doc) destroyDocument(entry, entry.doc, path);
          else entry.controller.abort();
        }
      }
      documents.clear();
    },
  };
}
