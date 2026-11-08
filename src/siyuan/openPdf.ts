/**
 * Opens a PDF at a page through the plugin API's `openTab`, then draws the highlight overlay.
 *
 * Verified in SiYuan 3.8.9 (webapp): `openTab({ pdf: { path, page } })` takes a 1-based page that matches
 * PDF.js `data-page-number`; the overlay waits for the `.page` element with a MutationObserver (so it does
 * not depend on when openTab resolves); a PDF already open is navigated to the page; several search tabs work.
 *
 * Still to validate by hand:
 *  1. Opening beside (`position: "right"`): the split is created and the overlay lands in the right viewer.
 *     When the opened tab is returned by `openTab` (an object with `panelElement`), the page is looked up in
 *     that panel only, because both viewers are then visible and may show the same page number.
 *  2. The exact visibility criterion of hidden tabs (`checkVisibility()`, else a non-empty rect), used when
 *     several `.page[data-page-number=N]` exist and no panel is known.
 *  3. Whether PDF.js replaces the page element (not only clears its children) on zoom or reload; only the
 *     latter is handled.
 *  4. The overlay is released once the page stays out of the document for `orphanReleaseMs` (tab closed).
 */
import {
  attachHighlights,
  sanitizeRect,
  scrollToFirstHighlight,
  type AttachHighlightsOptions,
  type AttachReport,
  type Disposer,
} from "../ui/highlightOverlay";
import type { PercentStyle } from "../core/crop";

export interface PdfTarget {
  readonly app: unknown;
  readonly pdf: { readonly path: string; readonly page: number };
  /** Split the current window and open beside ("right") or below ("bottom"). */
  readonly position?: "right" | "bottom";
  /** Open in a new tab instead of reusing an existing one. */
  readonly openNewTab?: boolean;
  /** Annulation : un `openTab` qui attend (visionneur natif mobile) en sort sans rien faire une fois annulé. */
  readonly signal?: AbortSignal;
}

/** Injected `openTab` from the SiYuan plugin API (kept loose for testability). */
export type OpenTabFn = (options: PdfTarget) => unknown;

/** Outcome of `ready`: the overlay report plus whether the scroll actually happened. */
export interface OpenPdfReport extends AttachReport {
  readonly scrolled: boolean;
}

export interface OpenPdfOptions
  extends Pick<
    AttachHighlightsOptions,
    "className" | "timeoutMs" | "orphanReleaseMs" | "resolvePageRoot" | "onWarn"
  > {
  readonly openTab: OpenTabFn;
  readonly app: unknown;
  /** Of the form `assets/x.pdf`. */
  readonly path: string;
  /** 1-based. */
  readonly page: number;
  readonly rects: readonly PercentStyle[];
  /** Index in `rects` of the rectangle to center on (default 0 = the first one). */
  readonly focusIndex?: number;
  readonly root?: Document | Element;
  /** Passed to `openTab`: open beside / below. The overlay then targets the opened tab's panel when known. */
  readonly position?: "right" | "bottom";
  readonly openNewTab?: boolean;
  /** Transmis tel quel à `openTab` (`target.signal`). */
  readonly signal?: AbortSignal;
}

export class InvalidPdfPathError extends RangeError {
  constructor(path: string) {
    super(
      `Invalid PDF path (expected assets/<name>.pdf; no "..", "%", "?" or "#"): ${JSON.stringify(path)}`,
    );
    this.name = "InvalidPdfPathError";
  }
}

// Excludes backslash, control chars and the URL/encoding metacharacters % ? #.
const PDF_PATH_PATTERN = /^assets\/[^\\\0-\x1f%?#]*[^\\\0-\x1f%?#/]\.pdf$/i;
const NO_ATTACH_COUNTS = 0;

let current: Disposer<OpenPdfReport> | null = null;
let generation = 0;

export function assertValidPdfPath(path: string): void {
  const segments = path.split("/");
  if (!PDF_PATH_PATTERN.test(path) || segments.includes("..") || segments.includes(".")) {
    throw new InvalidPdfPathError(path);
  }
}

const NO_PANEL_WARNING = "openTab n'a pas renvoyé de panneau exploitable : recherche globale de la page";

/**
 * `panelElement` of the Tab returned by `openTab`, when it is a connected element. The test is structural
 * (`nodeType === 1`), not `instanceof Element`, which fails for an element of another window (detached window).
 */
function panelOf(opened: unknown): Element | undefined {
  if (typeof opened !== "object" || opened === null) return undefined;
  const panel = (opened as { panelElement?: unknown }).panelElement;
  if (typeof panel !== "object" || panel === null) return undefined;
  const node = panel as Element;
  return node.nodeType === 1 && node.isConnected === true ? node : undefined;
}

function documentOfRoot(root: Document | Element): Document | null {
  return root.nodeType === 9 ? (root as Document) : root.ownerDocument;
}

function supersededHandle(pageNumber: number): Disposer<OpenPdfReport> {
  const report: OpenPdfReport = Object.freeze({
    status: "superseded",
    pageNumber,
    keptRects: NO_ATTACH_COUNTS,
    droppedRects: NO_ATTACH_COUNTS,
    scrolled: false,
  });
  return { dispose: () => undefined, ready: Promise.resolve(report) };
}

/** Completes the attach report: scroll (result checked) and 'superseded' mapping. */
async function finish(
  handle: Disposer,
  isCurrent: () => boolean,
  scroll: () => boolean,
  warn: (message: string) => void,
): Promise<OpenPdfReport> {
  const report = await handle.ready;
  if (report.status === "disposed" && !isCurrent()) {
    return Object.freeze({ ...report, status: "superseded", scrolled: false });
  }
  if (report.status !== "attached" || !isCurrent()) return Object.freeze({ ...report, scrolled: false });
  const scrolled = scroll();
  if (!scrolled) warn(`Could not scroll to the first highlight of page ${report.pageNumber}`);
  return Object.freeze({ ...report, scrolled });
}

/**
 * Opens a PDF at a page via the injected `openTab`, then attaches the highlight overlay.
 * Resolves right after openTab; `handle.ready` resolves (never rejects) with an
 * OpenPdfReport. A newer call disposes the previous overlay (also if the older openTab
 * is still pending) and the older `ready` reports 'superseded'. Call `dispose()` to
 * release explicitly (idempotent); it also self-releases when the page is gone for good.
 */
export async function openPdfAtPage(options: OpenPdfOptions): Promise<Disposer<OpenPdfReport>> {
  const { openTab, app, path, page, rects, focusIndex = 0, root = document, position, openNewTab, signal, ...rest } = options;
  assertValidPdfPath(path);
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`page must be an integer >= 1, got ${page}`);
  }
  current?.dispose();
  current = null;
  generation += 1;
  const mine = generation;
  const target: PdfTarget = {
    app,
    pdf: { path, page },
    ...(position !== undefined && { position }),
    ...(openNewTab !== undefined && { openNewTab }),
    ...(signal !== undefined && { signal }),
  };
  const opened = await openTab(target);
  if (mine !== generation) return supersededHandle(page);
  // Side by side, both viewers are visible and may show the same page number: look in the opened tab's panel only.
  const wantsPanel = position !== undefined && !rest.resolvePageRoot;
  const panel = wantsPanel ? panelOf(opened) : undefined;
  if (wantsPanel && !panel) rest.onWarn?.(NO_PANEL_WARNING);
  const scoped = panel ? { ...rest, resolvePageRoot: () => panel } : rest;
  // A panel living in another document (detached window): watch and look up that document, not the main one.
  const lookupRoot = panel && panel.ownerDocument && panel.ownerDocument !== documentOfRoot(root) ? panel.ownerDocument : root;
  const handle = attachHighlights({ root: lookupRoot, pageNumber: page, rects, ...scoped });
  // The overlay only draws sanitized rects: map the index in `rects` to the index among drawn ones.
  const focused = Number.isInteger(focusIndex) ? rects[focusIndex] : undefined;
  const drawnIndex =
    focused && sanitizeRect(focused)
      ? rects.slice(0, focusIndex).filter((r) => sanitizeRect(r) !== null).length
      : 0;
  const lookup = { root: lookupRoot, pageNumber: page, ...(scoped.resolvePageRoot && { resolvePageRoot: scoped.resolvePageRoot }) };
  const ready = finish(
    handle,
    () => mine === generation,
    () => scrollToFirstHighlight({ ...lookup, index: drawnIndex }),
    rest.onWarn ?? (() => undefined),
  );
  const result: Disposer<OpenPdfReport> = {
    dispose: () => {
      handle.dispose();
      if (current === result) current = null;
    },
    ready,
  };
  current = result;
  return result;
}

/** Ouvre une URL dans une nouvelle fenêtre ; renvoie la fenêtre, ou null si le navigateur la bloque. */
export type OpenWindowFn = (url: string, target: string) => { opener: unknown } | null;

export interface BrowserPdfOptions {
  /** Forme `assets/x.pdf` (même validation que pour `openPdfAtPage`). */
  readonly path: string;
  /** 1-based. */
  readonly page: number;
  /** Injectable pour les tests ; par défaut `window.open`. */
  readonly open?: OpenWindowFn;
  /** Trace d'un incident sans gravité pour l'ouverture (la fenêtre est ouverte malgré tout). */
  readonly onWarn?: (message: string, error?: unknown) => void;
}

/**
 * Repli mobile (`openTab` y est un stub) : ouvre le PDF dans le navigateur à la page demandée (`/assets/x.pdf#page=N`), sans
 * surlignage ni garantie de page (le lecteur PDF d'iOS ignore souvent `#page`). C'est le SEUL appel à `window.open` du plugin.
 * Renvoie faux si le navigateur bloque la fenêtre ; une erreur de `open` est propagée à l'appelant, qui la trace.
 */
export function openPdfInBrowser(options: BrowserPdfOptions): boolean {
  const { path, page } = options;
  assertValidPdfPath(path);
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`page must be an integer >= 1, got ${page}`);
  }
  const open: OpenWindowFn = options.open ?? ((url, target) => window.open(url, target));
  const url = `/${path.split("/").map(encodeURIComponent).join("/")}#page=${page}`;
  const opened = open(url, "_blank");
  if (opened === null) return false;
  try {
    opened.opener = null; // la page ouverte ne garde pas la main sur SiYuan (pas de `noopener` : il rendrait l'échec indétectable)
  } catch (error) {
    // La fenêtre EST ouverte : un `opener` non modifiable ne doit pas passer pour un échec « bloqué ». On trace et on réussit.
    options.onWarn?.("Impossible de couper l'opener de la fenêtre du PDF", error);
  }
  return true;
}
