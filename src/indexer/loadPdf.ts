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
    // La tâche n'est libérée qu'une fois, que ce soit par l'annulation ou par destroy() du document.
    let released: Promise<void> | undefined;
    const releaseTask = (): Promise<void> => (released ??= Promise.resolve().then(() => task.destroy()));
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        releaseTask().catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let doc: PdfDocumentLike;
    try {
      doc = await Promise.race([task.promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    const document = withTaskDestroy(doc, releaseTask);
    if (signal.aborted) {
      // annulation survenue pendant la résolution : l'appelant ne recevra jamais le document
      await Promise.resolve(document.destroy()).catch(() => undefined);
      throw abortError();
    }
    return document;
  };
}

/**
 * PDF.js 6.4.299 : le PDFDocumentProxy n'a pas de destroy(), c'est la tâche de chargement qui libère
 * le document. On ajoute un destroy() idempotent sur le proxy lui-même (Object.assign) plutôt que
 * d'envelopper : les méthodes natives gardent leur `this` et leurs champs privés.
 * Si une version de PDF.js fournit un destroy() natif, il est appelé d'abord ; la tâche est
 * libérée dans tous les cas, puis la première erreur est propagée.
 */
function withTaskDestroy(doc: PdfDocumentLike, releaseTask: () => Promise<void>): PdfDocumentLike {
  const native = typeof doc.destroy === "function" ? doc.destroy.bind(doc) : undefined;
  let done: Promise<void> | undefined;
  const destroy = (): Promise<void> =>
    (done ??= (async () => {
      let failure: { error: unknown } | undefined;
      if (native) {
        try {
          await native();
        } catch (error) {
          failure = { error };
        }
      }
      try {
        await releaseTask();
      } catch (error) {
        failure ??= { error };
      }
      if (failure) throw failure.error;
    })());
  return Object.assign(doc, { destroy });
}
