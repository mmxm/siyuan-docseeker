/**
 * TO VALIDATE against a real SiYuan (spike M0) -- none of this is verified yet:
 *  1. Page numbering: `openTab({ pdf: { path, page } })` takes a 1-based page, and it
 *     matches PDF.js `data-page-number`. (Per the plan; not run.)
 *  2. When `.page[data-page-number=N]` exists: does openTab's promise resolve before,
 *     after, or independently of PDF.js creating the page elements? We do not rely on it:
 *     the overlay waits for the page via MutationObserver (timeout `timeoutMs`).
 *  3. PDF already open in a tab: does openTab focus the tab AND navigate to `page`, or
 *     only focus it? If it does not navigate, we only scroll to the first highlight.
 *  4. Several PDF tabs: hidden tabs may stay in the DOM. By default the VISIBLE
 *     `.page[data-page-number=N]` is chosen (`checkVisibility()`, else non-empty rect);
 *     the exact criterion (display:none? off-screen?) is to validate. Prefer injecting
 *     `resolvePageRoot` returning the active viewer container.
 *  5. Whether PDF.js replaces the page element (not only clears its children) on zoom
 *     or reload; only the latter is handled.
 *  6. The overlay is released automatically once the page stays out of the document for
 *     `orphanReleaseMs` (tab closed); validate that closing a tab removes the `.page`.
 *  7. The returned promise of `openTab` (Tab object) and its failure modes.
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
  const { openTab, app, path, page, rects, focusIndex = 0, root = document, ...rest } = options;
  assertValidPdfPath(path);
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`page must be an integer >= 1, got ${page}`);
  }
  current?.dispose();
  current = null;
  generation += 1;
  const mine = generation;
  await openTab({ app, pdf: { path, page } });
  if (mine !== generation) return supersededHandle(page);
  const handle = attachHighlights({ root, pageNumber: page, rects, ...rest });
  // The overlay only draws sanitized rects: map the index in `rects` to the index among drawn ones.
  const focused = Number.isInteger(focusIndex) ? rects[focusIndex] : undefined;
  const drawnIndex =
    focused && sanitizeRect(focused)
      ? rects.slice(0, focusIndex).filter((r) => sanitizeRect(r) !== null).length
      : 0;
  const lookup = { root, pageNumber: page, ...(rest.resolvePageRoot && { resolvePageRoot: rest.resolvePageRoot }) };
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
