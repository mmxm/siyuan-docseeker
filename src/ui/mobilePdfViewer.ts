/**
 * Visionneur de page du PDF pour mobile (E5) : `openTab` y est un stub, donc le PDF s'ouvre dans un SECOND dialogue plein écran,
 * empilé sur la recherche (qui reste ouverte dessous). La page ENTIÈRE est rendue par `renderCrop` (rectangle = page), à la
 * largeur de l'écran (`devicePixelRatio` plafonné à 2, pixels plafonnés), et les mots recherchés sont superposés en `<div>`
 * de surlignage, comme sur les vignettes (pas `highlightOverlay`, taillé pour le visualiseur de SiYuan).
 *
 * Un seul rendu en vol (annulable) ; l'image est libérée (URL révoquée) au changement de page et à la fermeture. Le canvas du
 * rendu est celui du `PdfRenderer`, qui le remet à 0 x 0 après chaque rendu. Le document PDF reste géré par le renderer partagé
 * (plafond `maxOpenDocuments` du profil). Aucune prise de focus automatique ; aucun HTML construit à partir de données.
 */
import type { CropBounds, PercentStyle } from "../core/crop";
import { assertValidPdfPath, type OpenPdfReport } from "../siyuan/openPdf";
import type { PdfRenderer } from "../siyuan/pdfRenderer";
import { sanitizeRect, type Disposer } from "./highlightOverlay";
import type { OpenFloatingDialog } from "./nativeUiTypes";
import { HIGHLIGHT_ATTRIBUTE, HIGHLIGHT_CLASS } from "./thumbnailLoader";

/** Textes par défaut (identiques à `i18n/fr_FR.json`, vérifié par test). `{n}` et `{total}` sont substitués. */
export const VIEWER_STRINGS: Readonly<Record<string, string>> = {
  viewerTitle: "Aperçu de la page",
  viewerPage: "Page {n} / {total}",
  viewerPageUnknown: "Page {n}",
  viewerPrev: "Page précédente",
  viewerNext: "Page suivante",
  viewerClose: "Fermer",
  viewerRetry: "Réessayer",
  viewerLoading: "Chargement de la page…",
  viewerRenderError: "Impossible d'afficher cette page.",
  viewerUnreadable: "Ce PDF est illisible ou protégé par un mot de passe.",
  viewerOutOfRange: "Cette page n'existe pas dans ce PDF.",
  viewerNoHighlights: "Surlignage indisponible sur cette page.",
};

export type ViewerRenderer = Pick<PdfRenderer, "getPageCount" | "getPageSize" | "renderCrop">;

export interface MobilePdfViewerOptions {
  /** Dialogue plein écran natif (`openFloatingDialog`) ; le visionneur demande lui-même `layout: "fullscreen"`. */
  readonly openDialog: OpenFloatingDialog;
  readonly renderer: ViewerRenderer;
  /** Forme `assets/x.pdf` (même validation que `openPdfAtPage`). */
  readonly path: string;
  /** 1-based. */
  readonly page: number;
  /** Rectangles des mots recherchés sur la page demandée, en pourcentages de la page. */
  getHighlights(page: number, signal: AbortSignal): Promise<readonly PercentStyle[]>;
  readonly t?: (key: string) => string;
  readonly onWarn: (message: string, error?: unknown) => void;
  /** Appelé UNE fois quand le dialogue est réellement détruit. `focus` faux : ne pas rendre le focus (dispose, ouverture d'autre chose). */
  readonly onClosed?: (info: { readonly focus: boolean }) => void;
  /** Appelé UNE fois dès le début de la destruction (avant le délai de SiYuan) : l'appelant y lève ce qu'il avait bloqué (inert). */
  readonly onClosing?: (info: { readonly focus: boolean }) => void;
  /** Délai maximum d'une demande au renderer (nombre de pages, taille, rendu), en ms (défaut 30 s) ; au-delà : état erreur + Réessayer. */
  readonly requestTimeoutMs?: number;
  /** Largeur utile en pixels CSS (défaut : celle du conteneur, sinon de la fenêtre). */
  readonly getViewportWidth?: () => number;
  readonly devicePixelRatio?: number;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_PAGE_PIXELS = 8_000_000;
const PIXEL_MARGIN = 0.99;
const FALLBACK_WIDTH = 360;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Nombre maximal de <div> de surlignage par page ; l'excédent est compté dans `droppedRects`. */
const MAX_HIGHLIGHT_DIVS = 500;
/** Noms d'exception de PDF.js (chargement) qui rendent le PDF définitivement inutilisable : réessayer ne sert à rien. */
const UNREADABLE_ERRORS = new Set(["PasswordException", "InvalidPDFException", "MissingPDFException"]);

type State = "loading" | "ready" | "error" | "unreadable" | "outOfRange";

function isUnreadable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (UNREADABLE_ERRORS.has(current.name)) return true;
    current = current.cause;
  }
  return false;
}

function deviceFactor(ratio: number | undefined): number {
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, MAX_DEVICE_PIXEL_RATIO) : 1;
}

/** Échelle de rendu : largeur de l'écran x ratio plafonné, sans dépasser MAX_PAGE_PIXELS pixels. */
function renderScale(cssWidth: number, factor: number, size: { width: number; height: number }): number {
  if (!(size.width > 0) || !(size.height > 0) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    throw new RangeError(`Taille de page invalide : ${size.width} x ${size.height}`);
  }
  const wanted = (cssWidth * factor) / size.width;
  const cap = Math.sqrt(MAX_PAGE_PIXELS / (size.width * size.height)) * PIXEL_MARGIN;
  return Math.min(wanted, cap);
}

export async function openMobilePdfViewer(options: MobilePdfViewerOptions): Promise<Disposer<OpenPdfReport>> {
  const { renderer, path, getHighlights, onWarn } = options;
  assertValidPdfPath(path);
  if (!Number.isInteger(options.page) || options.page < 1) {
    throw new RangeError(`page must be an integer >= 1, got ${options.page}`);
  }
  const text = (key: string, vars: Readonly<Record<string, number>> = {}): string => {
    const custom = options.t?.(key);
    const template = custom && custom !== key ? custom : (VIEWER_STRINGS[key] ?? key);
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
  };
  const createUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  /** Rejette si la demande ne répond pas à temps (le minuteur est toujours libéré). */
  const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Délai dépassé (${timeoutMs} ms) : ${what}`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  let page = options.page;
  let total: number | undefined;
  let closed = false;
  let notified = false;
  let closeFocus = true;
  let controller: AbortController | undefined;
  let url: string | undefined;
  let settled = false;
  let resolveReady: (report: OpenPdfReport) => void = () => undefined;
  const ready = new Promise<OpenPdfReport>((resolve) => {
    resolveReady = resolve;
  });
  const settle = (status: OpenPdfReport["status"], keptRects: number, droppedRects: number, scrolled: boolean): void => {
    if (settled) return;
    settled = true;
    resolveReady(Object.freeze({ status, pageNumber: page, keptRects, droppedRects, scrolled }));
  };

  let doc: Document | undefined;
  let stage: HTMLElement;
  let labelEl: HTMLElement;
  let prevButton: HTMLButtonElement;
  let nextButton: HTMLButtonElement;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
    const node = (doc as Document).createElement(tag);
    node.className = className;
    return node;
  };
  const button = (action: string, label: string, extra = ""): HTMLButtonElement => {
    const b = el("button", `docseeker-viewer-button${extra}`);
    b.type = "button";
    b.dataset["action"] = action;
    b.textContent = label;
    b.setAttribute("aria-label", label);
    return b;
  };

  function releaseImage(): void {
    // Retirer `src` avant de détruire l'image : iOS libère sinon tard la mémoire décodée d'une image de plusieurs millions de pixels.
    stage?.querySelectorAll("img").forEach((image) => image.removeAttribute("src"));
    stage?.replaceChildren();
    if (url !== undefined) {
      const old = url;
      url = undefined;
      try {
        revokeUrl(old);
      } catch (error) {
        onWarn("Libération de l'image de la page impossible", error);
      }
    }
  }

  function updateBar(): void {
    labelEl.textContent = total === undefined ? text("viewerPageUnknown", { n: page }) : text("viewerPage", { n: page, total });
    prevButton.disabled = page <= 1;
    nextButton.disabled = total === undefined || page >= total;
  }

  function showState(state: State): void {
    releaseImage();
    if (state === "loading") {
      stage.setAttribute("aria-busy", "true");
      const message = el("div", "docseeker-viewer-message");
      message.textContent = text("viewerLoading");
      stage.append(message);
      return;
    }
    stage.removeAttribute("aria-busy");
    const wrap = el("div", "docseeker-viewer-state");
    const message = el("div", "docseeker-viewer-message");
    message.textContent = text(
      state === "unreadable" ? "viewerUnreadable" : state === "outOfRange" ? "viewerOutOfRange" : "viewerRenderError",
    );
    wrap.append(message);
    if (state === "error") {
      const retry = button("retry", text("viewerRetry"));
      retry.addEventListener("click", () => launch(page));
      wrap.append(retry);
    }
    stage.append(wrap);
  }

  function drawPage(
    blob: Blob,
    size: { width: number; height: number },
    rects: readonly PercentStyle[] | undefined,
    onImageError: () => void,
  ): number {
    releaseImage();
    stage.removeAttribute("aria-busy");
    url = createUrl(blob);
    const pageEl = el("div", "docseeker-viewer-page");
    const ratio = `${size.width} / ${size.height}`;
    pageEl.style.setProperty("aspect-ratio", ratio);
    pageEl.dataset["aspectRatio"] = ratio;
    const img = (doc as Document).createElement("img");
    img.src = url;
    img.alt = "";
    img.className = "docseeker-viewer-image";
    img.addEventListener("error", onImageError);
    pageEl.append(img);
    let kept = 0;
    for (const rect of rects ?? []) {
      if (kept >= MAX_HIGHLIGHT_DIVS) break; // l'excédent est compté par l'appelant (given - drawn)
      const clean = sanitizeRect(rect);
      if (!clean) continue;
      const mark = el("div", HIGHLIGHT_CLASS);
      mark.setAttribute("aria-hidden", "true");
      mark.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
      mark.style.cssText =
        `position:absolute;left:${clean.left}%;top:${clean.top}%;width:${clean.width}%;height:${clean.height}%;pointer-events:none`;
      pageEl.append(mark);
      kept++;
    }
    stage.append(pageEl);
    if (rects === undefined) {
      const note = el("div", "docseeker-viewer-note");
      note.textContent = text("viewerNoHighlights");
      stage.append(note);
    }
    return kept;
  }

  /** Affiche la page `target` : annule le rendu précédent, un seul est en vol. */
  async function load(target: number): Promise<void> {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const { signal } = mine;
    const stale = (): boolean => closed || controller !== mine;
    try {
      page = target;
      showState("loading");
      updateBar();
      if (total === undefined) {
        let count: number;
        try {
          count = await withTimeout(renderer.getPageCount(path, signal), "nombre de pages");
        } catch (error) {
          if (stale()) return;
          mine.abort();
          onWarn(`PDF illisible (${path})`, error);
          showState(isUnreadable(error) ? "unreadable" : "error");
          settle("empty", 0, 0, false);
          return;
        }
        if (stale()) return;
        if (!Number.isInteger(count) || count < 1) {
          onWarn(`Nombre de pages invalide (${String(count)}) pour ${path}`);
          showState("unreadable");
          settle("empty", 0, 0, false);
          return;
        }
        total = count;
        updateBar();
      }
      if (target > total) {
        showState("outOfRange");
        settle("empty", 0, 0, false);
        return;
      }
      // Surlignages et rendu en parallèle ; l'échec des premiers ne bloque jamais la page.
      let highlightFailed = false;
      const highlights = getHighlights(target, signal).catch((error: unknown): undefined => {
        // Seule l'obsolescence est silencieuse : un AbortError qui n'en est pas une est un vrai problème.
        if (!stale()) {
          highlightFailed = true;
          onWarn(`Surlignages indisponibles (page ${target}, ${path})`, error);
        }
        return undefined;
      });
      const size = await withTimeout(renderer.getPageSize(path, target, signal), "taille de la page");
      if (stale()) return;
      const cssWidth = options.getViewportWidth?.() ?? ((stage.clientWidth || (doc as Document).defaultView?.innerWidth) ?? 0);
      const scale = renderScale(cssWidth > 0 ? cssWidth : FALLBACK_WIDTH, deviceFactor(options.devicePixelRatio ?? (doc as Document).defaultView?.devicePixelRatio), size);
      const crop: CropBounds = { x0: 0, y0: 0, width: size.width, height: size.height };
      const blob = await withTimeout(renderer.renderCrop({ path, page: target, crop, scale, signal }), "rendu de la page");
      const rects = await highlights;
      if (stale()) return;
      const drawn = drawPage(blob, size, highlightFailed ? undefined : rects, () => {
        if (stale()) return;
        onWarn(`Image de la page ${target} illisible (${path})`);
        showState("error");
      });
      const given = highlightFailed ? 0 : (rects?.length ?? 0);
      settle("attached", drawn, given - drawn, true);
    } catch (error) {
      if (stale()) return;
      mine.abort(); // un délai dépassé doit aussi libérer le travail resté en vol
      onWarn(`Rendu de la page ${target} impossible (${path})`, error);
      showState("error");
      settle("empty", 0, 0, false);
    }
  }

  /** Lance `load` sans jamais laisser un rejet non géré : toute défaillance est tracée et règle `ready`. */
  function launch(target: number): void {
    load(target).catch((error: unknown) => {
      onWarn(`Chargement de la page ${target} en échec (${path})`, error);
      settle("empty", 0, 0, false);
    });
  }

  function go(target: number): void {
    if (closed) return;
    launch(target);
  }

  /** Début de la destruction (bouton, Échap, croix, dispose) : plus aucun travail, plus d'image. */
  function onClosing(info: { readonly focus: boolean }): void {
    if (closed) return;
    closed = true;
    closeFocus = info.focus;
    controller?.abort();
    releaseImage();
    settle("disposed", 0, 0, false);
    try {
      options.onClosing?.(info);
    } catch (error) {
      onWarn("Fermeture du visionneur : rappel de début de fermeture en échec", error);
    }
  }

  function notifyClosed(): void {
    if (notified) return;
    notified = true;
    try {
      options.onClosed?.({ focus: closeFocus });
    } catch (error) {
      onWarn("Fermeture du visionneur : rappel en échec", error);
    }
  }

  const handle = options.openDialog({
    title: text("viewerTitle"),
    layout: "fullscreen",
    build(container) {
      doc = container.ownerDocument;
      const root = el("div", "docseeker-viewer");
      stage = el("div", "docseeker-viewer-stage");
      const bar = el("div", "docseeker-viewer-bar");
      prevButton = button("prev", text("viewerPrev"));
      nextButton = button("next", text("viewerNext"));
      labelEl = el("div", "docseeker-viewer-label");
      prevButton.addEventListener("click", () => go(Math.min(page - 1, total ?? page - 1)));
      nextButton.addEventListener("click", () => go(page + 1));
      bar.append(prevButton, labelEl, nextButton);
      const close = button("close", text("viewerClose"), " docseeker-viewer-close");
      close.addEventListener("click", () => handle.close());
      root.append(stage, bar, close);
      container.append(root);
    },
    onClosing,
    onDestroyed: (info) => {
      onClosing(info);
      notifyClosed();
    },
  });
  // Garde-fou : un dialogue déjà détruit à l'ouverture ne rappellerait jamais l'appelant (qui garde la recherche inerte).
  if (!handle.isOpen()) {
    onClosing({ focus: false });
    notifyClosed();
  } else {
    launch(page);
  }

  return {
    dispose() {
      if (closed) return;
      closeFocus = false;
      try {
        handle.close({ focus: false });
      } finally {
        onClosing({ focus: false });
        if (!handle.isOpen()) notifyClosed();
      }
    },
    ready,
  };
}
