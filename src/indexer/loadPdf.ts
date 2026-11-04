import type { PdfDocumentLike } from "./indexer";

/** Sous-ensemble du `window.pdfjsLib` de SiYuan utilisé pour l'indexation. */
export interface PdfjsLoader {
  getDocument(src: { url: string }): {
    readonly promise: Promise<PdfDocumentLike>;
    destroy(): Promise<void> | void;
  };
}

const ABORT_MESSAGE = "Chargement du PDF annulé";

function abortError(): Error {
  return new DOMException(ABORT_MESSAGE, "AbortError");
}

/** `assets/dossier a/é.pdf` devient `/assets/dossier%20a/%C3%A9.pdf` (encodage par segment). */
function toAssetUrl(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Fabrique le `loadPdf` de l'indexeur. `getPdfjs` est évalué à chaque appel : le PDF.js de SiYuan
 * peut ne pas être prêt au chargement du plugin.
 */
export function createLoadPdf(
  getPdfjs: () => PdfjsLoader | undefined,
): (path: string, signal: AbortSignal) => Promise<PdfDocumentLike> {
  return async (path, signal) => {
    if (signal.aborted) throw abortError();
    const pdfjs = getPdfjs();
    if (!pdfjs) throw new Error("PDF.js de SiYuan indisponible (window.pdfjsLib absent)");

    const task = pdfjs.getDocument({ url: toAssetUrl(path) });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        Promise.resolve(task.destroy()).catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([task.promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}
