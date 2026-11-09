import { DEFAULT_MAX_OPEN_DOCUMENTS, DEFAULT_RENDER_CONCURRENCY, HEAVY_PDF_BYTES } from "../core/constants";
import type { CropBounds } from "../core/crop";

const DEFAULT_MIME_TYPE = "image/webp";
const DEFAULT_QUALITY = 0.8;
const FALLBACK_MIME_TYPE = "image/png";
const JPEG_MIME_TYPE = "image/jpeg";
const JPEG_QUALITY = 0.8;

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
  /**
   * Taille du fichier PDF en octets, si connue. Les exemplaires supplémentaires (`workersPerDocument`) ne servent
   * que les PDF lourds (>= `HEAVY_PDF_BYTES`) : absente ou plus petite, un seul exemplaire.
   */
  readonly pdfSize?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PdfRenderer {
  getPageSize(
    path: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number }>;
  renderCrop(request: RenderCropRequest): Promise<Blob>;
  /** Nombre de pages du PDF (visionneur de page) : ouvre le document comme les autres appels, sans rendre de page. */
  getPageCount(path: string, signal?: AbortSignal): Promise<number>;
  dispose(): void;
}

export interface PdfRendererDeps {
  readonly loadDocument: (path: string, signal?: AbortSignal) => Promise<RenderableDocument>;
  readonly createCanvas: (width: number, height: number) => RenderCanvas;
  readonly maxOpenDocuments?: number | undefined;
  readonly concurrency?: number | undefined;
  /**
   * Exemplaires ouverts au plus pour un même PDF (un exemplaire = un `loadDocument` = un worker PDF.js) : les rendus
   * d'un même document se répartissent dessus. 1 (défaut) : un seul exemplaire par PDF. `maxOpenDocuments` plafonne le
   * total d'exemplaires, tous PDF confondus.
   */
  readonly workersPerDocument?: number | undefined;
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
  /** Exemplaire supplémentaire d'un PDF déjà ouvert : son échec de chargement retombe sur un autre exemplaire. */
  readonly extra: boolean;
}

interface QueueItem {
  readonly start: () => void;
}

/** Nom lisible d'un type d'image pour les avertissements. */
function encodingLabel(type: string): string {
  return { "image/webp": "WebP", "image/jpeg": "JPEG", "image/png": "PNG" }[type] ?? type;
}

/** Vrai si la taille connue du PDF justifie d'ouvrir plusieurs exemplaires. */
function isHeavy(pdfSize: number | undefined): boolean {
  return pdfSize !== undefined && pdfSize >= HEAVY_PDF_BYTES;
}

export function createPdfRenderer(deps: PdfRendererDeps): PdfRenderer {
  const maxOpen = Math.max(1, deps.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS);
  const workersPerDocument = Math.max(1, deps.workersPerDocument ?? 1);
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_RENDER_CONCURRENCY);
  const mimeType = deps.mimeType ?? DEFAULT_MIME_TYPE;
  const quality = deps.quality ?? DEFAULT_QUALITY;
  const disposal = new AbortController();
  /** Un élément par exemplaire ouvert ou en cours d'ouverture ; l'ordre du tableau est l'ordre LRU (le plus ancien d'abord). */
  const documents: DocEntry[] = [];
  const pending: QueueItem[] = [];
  let active = 0;

  function forget(entry: DocEntry): void {
    const index = documents.indexOf(entry);
    if (index >= 0) documents.splice(index, 1);
  }

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

  /** Détruit les exemplaires inactifs (les plus anciens d'abord) tant que le pool dépasse `limit`. */
  function evictIdle(limit = maxOpen): void {
    for (const entry of [...documents]) {
      if (documents.length <= limit) return;
      if (entry.refs > 0 || !entry.doc) continue;
      forget(entry);
      destroyDocument(entry, entry.doc, entry.path);
    }
  }

  function startLoad(path: string, extra: boolean): DocEntry {
    const controller = new AbortController();
    const entry: DocEntry = {
      path,
      controller,
      dropped: false,
      destroyed: false,
      refs: 0,
      extra,
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
        forget(entry);
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
      forget(entry);
      return;
    }
    evictIdle();
  }

  /**
   * Choisit l'exemplaire de `path` : un exemplaire libre (refs == 0), sinon un nouveau tant qu'on est sous
   * `workersPerDocument` (sauf `reuseOnly` : on préfère réutiliser), sinon le moins chargé. Un exemplaire
   * SUPPLÉMENTAIRE n'est ouvert que s'il tient dans `maxOpenDocuments` après éviction des exemplaires inactifs.
   */
  function pickEntry(path: string, reuseOnly: boolean): DocEntry {
    const same = documents.filter((e) => e.path === path && !e.dropped);
    const free = same.find((e) => e.refs === 0);
    if (free) return free;
    if (same.length === 0) return startLoad(path, false);
    if (!reuseOnly && same.length < workersPerDocument) {
      evictIdle(maxOpen - 1);
      if (documents.length < maxOpen) return startLoad(path, true);
    }
    return leastLoaded(same);
  }

  /** Le moins chargé ; à charge égale, un exemplaire déjà chargé plutôt qu'en cours d'ouverture. */
  function leastLoaded(entries: readonly DocEntry[]): DocEntry {
    return entries.reduce((best, e) =>
      e.refs < best.refs || (e.refs === best.refs && e.doc && !best.doc) ? e : best,
    );
  }

  /** Prend une référence sur l'exemplaire et attend son chargement. */
  async function open(
    entry: DocEntry,
    signal: AbortSignal,
  ): Promise<{ entry: DocEntry; doc: RenderableDocument }> {
    forget(entry); // refresh recency
    documents.push(entry);
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

  async function acquire(
    path: string,
    signal: AbortSignal,
    reuseOnly = false,
  ): Promise<{ entry: DocEntry; doc: RenderableDocument }> {
    const entry = pickEntry(path, reuseOnly);
    try {
      return await open(entry, signal);
    } catch (error) {
      if (!entry.extra || signal.aborted || isAbortError(error)) throw error;
      // L'exemplaire supplémentaire n'a pas pu s'ouvrir : un exemplaire chargé du même PDF suffit.
      const loaded = documents.filter((e) => e.path === path && e.doc && !e.dropped && e !== entry);
      if (loaded.length === 0) throw error;
      deps.onWarn(`Exemplaire supplémentaire du PDF ${path} non ouvert, exemplaire existant utilisé`, error);
      return await open(leastLoaded(loaded), signal);
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
    reuseOnly: boolean,
    use: (page: RenderablePage) => Promise<T>,
  ): Promise<T> {
    const { entry, doc } = await acquire(path, signal, reuseOnly);
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

  /** Qualité à transmettre : ignorée par le PNG (sans perte). */
  function qualityFor(type: string): number | undefined {
    if (type === FALLBACK_MIME_TYPE) return undefined;
    if (type === JPEG_MIME_TYPE) return JPEG_QUALITY;
    return quality;
  }

  function toBlobOnce(canvas: RenderCanvas, type: string): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, qualityFor(type));
    });
  }

  /** Types essayés dans l'ordre. Par défaut WebP puis JPEG puis PNG ; type imposé par l'appelant : ce type puis PNG. */
  const encodingChain: readonly string[] = deps.mimeType
    ? [...new Set([mimeType, FALLBACK_MIME_TYPE])]
    : [DEFAULT_MIME_TYPE, JPEG_MIME_TYPE, FALLBACK_MIME_TYPE];
  /** Index du premier type à demander : mémorise le repli qui a fonctionné pour ne pas payer deux encodages par image. */
  let chainStart = 0;

  let warnedEncoding = false;
  function warnEncoding(message: string): void {
    if (warnedEncoding) return;
    warnedEncoding = true;
    deps.onWarn(message);
  }

  /**
   * Un navigateur qui ne sait pas encoder le type demandé (Safari pour le WebP) ignore souvent la demande et
   * renvoie un PNG non nul, environ 4 fois plus gros (vignette 450x180 mesurée : WebP 21 Ko, JPEG 0,8 29 Ko,
   * PNG 47 à 114 Ko), ce qui sature vite le cache (16 Mo sur mobile). On compare donc `blob.type` au type
   * demandé (type vide compris) et on passe au type suivant de la chaîne en cas d'écart.
   *
   * Mémorisation : seul un blob non nul d'un autre type fait avancer `chainStart` ; un `null` isolé (échec ponctuel
   * de l'encodeur) n'abaisse jamais durablement la qualité. Si aucun type n'est honoré, on garde le premier blob
   * de type connu (à défaut, de type vide) plutôt que d'échouer, et les vignettes suivantes ne paient qu'un
   * encodage ; `null` partout est une erreur.
   */
  async function toBlob(canvas: RenderCanvas): Promise<Blob> {
    let lastMismatch = -1;
    let kept: Blob | null = null;
    let keptUntyped: Blob | null = null;
    for (let i = chainStart; i < encodingChain.length; i++) {
      const type = encodingChain[i]!;
      const blob = await toBlobOnce(canvas, type);
      if (!blob) continue;
      if (blob.type === type) {
        if (lastMismatch >= 0) chainStart = lastMismatch + 1;
        if (i > 0) {
          warnEncoding(`${encodingLabel(encodingChain[0]!)} non encodé par ce navigateur : ${encodingLabel(type)} utilisé`);
        }
        return blob;
      }
      lastMismatch = i;
      if (blob.type === "") keptUntyped ??= blob;
      else kept ??= blob;
    }
    const result = kept ?? keptUntyped;
    if (!result) throw new PdfRenderError("toBlob a renvoyé null");
    chainStart = lastMismatch;
    warnEncoding(`Aucun type d'image demandé n'est encodé par ce navigateur : ${result.type || "type inconnu"} conservé`);
    return result;
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
          withPage(path, page, signal, true, async (pdfPage) => {
            const { width, height } = pdfPage.getViewport({ scale: 1 });
            return { width, height };
          }),
        );
      } finally {
        linked.cleanup();
      }
    },

    async getPageCount(path, signal) {
      guard();
      const linked = linkSignals(signal);
      try {
        if (linked.signal.aborted) throw abortError();
        const { signal } = linked;
        return await schedule(signal, async () => {
          const { entry, doc } = await acquire(path, signal, true);
          try {
            return doc.numPages;
          } finally {
            release(entry);
          }
        });
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
          withPage(request.path, request.page, signal, !isHeavy(request.pdfSize), (pdfPage) =>
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
      for (const entry of documents) {
        entry.dropped = true;
        if (entry.refs === 0) {
          if (entry.doc) destroyDocument(entry, entry.doc, entry.path);
          else entry.controller.abort();
        }
      }
      documents.length = 0;
    },
  };
}
