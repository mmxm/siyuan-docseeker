import { GOODNOTES_YELLOW_CSS } from "../core/constants";
import type { PercentStyle } from "../core/crop";

/** Marker attribute on every overlay element created by this module. */
export const OVERLAY_ATTRIBUTE = "data-docseeker-overlay";
/** Default maximum wait for the target page to appear in the DOM. */
export const DEFAULT_PAGE_TIMEOUT_MS = 10_000;
/**
 * Default delay after which an overlay whose page was removed (and never came back)
 * is released automatically, e.g. the PDF tab was closed.
 */
export const ORPHAN_RELEASE_MS = 30_000;
/** Maximum number of times the page element may be replaced before giving up. */
export const MAX_PAGE_REPLACEMENTS = 5;

const FULL_PERCENT = 100;
const MIN_PAGE_NUMBER = 1;

/**
 * - attached: overlay injected in the page.
 * - timeout: the page never appeared within `timeoutMs`; nothing injected.
 * - empty: no drawable rectangle (none given, or all dropped by sanitizeRect).
 * - disposed: dispose() was called before the overlay was attached.
 * - superseded: a newer request replaced this one (set by openPdf).
 */
export type AttachStatus = "attached" | "timeout" | "empty" | "disposed" | "superseded";

export interface AttachReport {
  readonly status: AttachStatus;
  readonly pageNumber: number;
  /** Rectangles actually drawn. */
  readonly keptRects: number;
  /** Rectangles discarded by sanitizeRect. */
  readonly droppedRects: number;
}

export type WarnFn = (message: string) => void;

export interface AttachHighlightsOptions {
  readonly root: Document | Element;
  /** 1-based, as in PDF.js `data-page-number`. */
  readonly pageNumber: number;
  readonly rects: readonly PercentStyle[];
  readonly className?: string;
  readonly timeoutMs?: number;
  /** Delay before an overlay whose page vanished is released. Default ORPHAN_RELEASE_MS. */
  readonly orphanReleaseMs?: number;
  /**
   * Returns the container of the ACTIVE viewer (or null when none is active).
   * Defaults to `root`. Use it to avoid picking a page of another open PDF.
   */
  readonly resolvePageRoot?: () => Document | Element | null;
  /** Injectable logger for every non-nominal outcome. Defaults to a no-op. */
  readonly onWarn?: WarnFn;
}

export interface Disposer<R = AttachReport> {
  /** Removes the overlay and disconnects observers. Idempotent. */
  readonly dispose: () => void;
  /** Resolves once with the outcome; never rejects. */
  readonly ready: Promise<R>;
}

export interface PageLookup {
  readonly root: Document | Element;
  readonly pageNumber: number;
  readonly resolvePageRoot?: () => Document | Element | null;
}

function pageSelector(pageNumber: number): string {
  return `.page[data-page-number="${pageNumber}"]`;
}

/**
 * Visibility criterion (TO VALIDATE in a real SiYuan: hidden tabs may use
 * display:none, visibility or off-screen layout): `checkVisibility()` when available,
 * otherwise a non-empty bounding rect.
 */
function isVisible(el: Element): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Finds the page of the active viewer: among all `.page[data-page-number=N]` of the
 * container, the visible one. A lone candidate is used as is (visibility cannot be
 * judged without layout); several candidates and none visible -> null (keep waiting).
 */
export function findPage({ root, pageNumber, resolvePageRoot }: PageLookup): Element | null {
  const container = resolvePageRoot ? resolvePageRoot() : root;
  if (!container) return null;
  const candidates = Array.from(container.querySelectorAll(pageSelector(pageNumber)));
  if (candidates.length === 1) return candidates[0] ?? null;
  return candidates.find(isVisible) ?? null;
}

/**
 * Out-of-bounds policy: rects are clamped to the page [0, 100] %; rects that are
 * non-finite, empty, or entirely outside the page are dropped.
 */
export function sanitizeRect(rect: PercentStyle): PercentStyle | null {
  const values = [rect.left, rect.top, rect.width, rect.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(FULL_PERCENT, rect.left + rect.width);
  const bottom = Math.min(FULL_PERCENT, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function createOverlay(doc: Document, clean: readonly PercentStyle[], className?: string): HTMLElement {
  const overlay = doc.createElement("div");
  overlay.setAttribute(OVERLAY_ATTRIBUTE, "true");
  if (className) overlay.className = className;
  Object.assign(overlay.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  });
  for (const rect of clean) {
    const box = doc.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      left: `${rect.left}%`,
      top: `${rect.top}%`,
      width: `${rect.width}%`,
      height: `${rect.height}%`,
      backgroundColor: GOODNOTES_YELLOW_CSS,
      pointerEvents: "none",
    });
    overlay.appendChild(box);
  }
  return overlay;
}

function documentOf(root: Document | Element): Document {
  return root instanceof Document ? root : (root.ownerDocument ?? document);
}

interface SessionConfig {
  readonly lookup: PageLookup;
  readonly overlay: HTMLElement;
  readonly timeoutMs: number;
  readonly orphanReleaseMs: number;
  readonly onWarn: WarnFn;
  readonly counts: { readonly kept: number; readonly dropped: number };
}

/**
 * Watches the whole document (childList + subtree) so that it notices both the
 * re-rendering of the page children and the replacement/removal of the page element.
 */
class HighlightSession {
  private page: Element | null = null;
  private lost = false;
  private replacements = 0;
  private disposed = false;
  private settled = false;
  private observer: MutationObserver | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveReady: (report: AttachReport) => void = () => undefined;
  readonly ready = new Promise<AttachReport>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(private readonly cfg: SessionConfig) {}

  start(): void {
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(documentOf(this.cfg.lookup.root), { childList: true, subtree: true });
    this.waitTimer = setTimeout(this.onWaitTimeout, this.cfg.timeoutMs);
    this.sync();
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.clearTimers();
    this.cfg.overlay.remove();
    this.settle("disposed");
  };

  private readonly sync = (): void => {
    if (this.disposed) return;
    if (this.page?.isConnected) {
      this.ensureOverlay(this.page);
      return;
    }
    const found = findPage(this.cfg.lookup);
    if (found) this.adopt(found);
    else if (this.page && !this.lost) this.markLost();
  };

  private ensureOverlay(page: Element): void {
    if (this.cfg.overlay.parentNode !== page) page.appendChild(this.cfg.overlay);
  }

  private adopt(found: Element): void {
    if (this.page) {
      this.replacements += 1;
      if (this.replacements > MAX_PAGE_REPLACEMENTS) {
        this.cfg.onWarn(`PDF page replaced more than ${MAX_PAGE_REPLACEMENTS} times: overlay released`);
        this.dispose();
        return;
      }
    }
    this.lost = false;
    this.clearOrphanTimer();
    this.page = found;
    this.ensureOverlay(found);
    this.clearWaitTimer();
    this.settle("attached");
  }

  private markLost(): void {
    this.lost = true;
    this.orphanTimer = setTimeout(() => {
      this.cfg.onWarn(`PDF page ${this.cfg.lookup.pageNumber} removed: overlay released`);
      this.dispose();
    }, this.cfg.orphanReleaseMs);
  }

  private readonly onWaitTimeout = (): void => {
    this.waitTimer = null;
    if (this.settled) return;
    const { pageNumber } = this.cfg.lookup;
    this.cfg.onWarn(`PDF page ${pageNumber} did not appear within ${this.cfg.timeoutMs} ms`);
    this.settle("timeout");
    this.dispose();
  };

  private settle(status: AttachStatus): void {
    if (this.settled) return;
    this.settled = true;
    const { counts, lookup } = this.cfg;
    this.resolveReady(
      Object.freeze({
        status,
        pageNumber: lookup.pageNumber,
        keptRects: status === "attached" ? counts.kept : 0,
        droppedRects: counts.dropped,
      }),
    );
  }

  private clearWaitTimer(): void {
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  private clearOrphanTimer(): void {
    if (this.orphanTimer !== null) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
  }

  private clearTimers(): void {
    this.clearWaitTimer();
    this.clearOrphanTimer();
  }
}

function emptyDisposer(options: AttachHighlightsOptions, dropped: number): Disposer {
  const report: AttachReport = Object.freeze({
    status: "empty",
    pageNumber: options.pageNumber,
    keptRects: 0,
    droppedRects: dropped,
  });
  return { dispose: () => undefined, ready: Promise.resolve(report) };
}

/**
 * Injects a percent-positioned highlight overlay into `.page[data-page-number=N]` of the
 * active viewer, waiting for the page if needed, re-injecting it when PDF.js clears or
 * REPLACES the page element (bounded by MAX_PAGE_REPLACEMENTS), and releasing itself
 * when the page stays removed for `orphanReleaseMs`.
 */
export function attachHighlights(options: AttachHighlightsOptions): Disposer {
  const { root, pageNumber, rects, className, resolvePageRoot } = options;
  if (!Number.isInteger(pageNumber) || pageNumber < MIN_PAGE_NUMBER) {
    throw new RangeError(`pageNumber must be an integer >= 1, got ${pageNumber}`);
  }
  const onWarn = options.onWarn ?? (() => undefined);
  const clean = rects.map(sanitizeRect).filter((r): r is PercentStyle => r !== null);
  const dropped = rects.length - clean.length;
  if (clean.length === 0) {
    onWarn(`No drawable highlight rectangle for page ${pageNumber} (${rects.length} given)`);
    return emptyDisposer(options, dropped);
  }
  const session = new HighlightSession({
    lookup: resolvePageRoot ? { root, pageNumber, resolvePageRoot } : { root, pageNumber },
    overlay: createOverlay(documentOf(root), clean, className),
    timeoutMs: options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
    orphanReleaseMs: options.orphanReleaseMs ?? ORPHAN_RELEASE_MS,
    onWarn,
    counts: { kept: clean.length, dropped },
  });
  session.start();
  return { dispose: session.dispose, ready: session.ready };
}

export type ScrollTarget = PageLookup;

/**
 * Scrolls so that the first highlight rectangle of the page is centered.
 * Returns false if the page, the rectangle or scrollIntoView is unavailable.
 */
export function scrollToFirstHighlight(target: ScrollTarget): boolean {
  const page = findPage(target);
  const overlay = page && Array.from(page.children).find((c) => c.hasAttribute(OVERLAY_ATTRIBUTE));
  const first = overlay?.firstElementChild as HTMLElement | null | undefined;
  if (!first || typeof first.scrollIntoView !== "function") return false;
  first.scrollIntoView({ block: "center", inline: "center" });
  return true;
}
