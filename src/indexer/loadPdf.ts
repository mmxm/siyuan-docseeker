import type { PdfDocumentLike } from "./indexer";

/** Sous-ensemble du `window.pdfjsLib` de SiYuan utilisé pour l'indexation. */
export interface PdfjsLoader {
  getDocument(src: { url: string; disableAutoFetch?: boolean; disableStream?: boolean }): {
    readonly promise: Promise<PdfDocumentLike>;
    destroy(): Promise<void> | void;
  };
  GlobalWorkerOptions?: { workerSrc?: string };
}

/**
 * URL du worker PDF.js, identique à celle que SiYuan 3.8.9 pose à l'ouverture de son visualiseur PDF
 * (`${Constants.PROTYLE_CDN}/js/pdf/pdf.worker.compat.mjs?v=6.4.299-siyuan.2`, PROTYLE_CDN = "/stage/protyle").
 * SiYuan ne renseigne `workerSrc` qu'à ce moment-là : sans PDF déjà ouvert dans la session,
 * `getDocument` échoue avec « No "GlobalWorkerOptions.workerSrc" specified. ».
 */
export const SIYUAN_PDF_WORKER_SRC = "/stage/protyle/js/pdf/pdf.worker.compat.mjs?v=6.4.299-siyuan.2";

/**
 * Renseigne `workerSrc` s'il est vide/absent (jamais d'écrasement). Renvoie false si
 * `GlobalWorkerOptions` est absent : l'appelant trace, et PDF.js produira sa propre erreur.
 */
export function ensureWorkerSrc(pdfjs: { GlobalWorkerOptions?: { workerSrc?: string } }): boolean {
  const options = pdfjs.GlobalWorkerOptions;
  if (!options) return false;
  if (!options.workerSrc) options.workerSrc = SIYUAN_PDF_WORKER_SRC;
  return true;
}

const ABORT_MESSAGE = "Chargement du PDF annulé";

function abortError(): Error {
  return new DOMException(ABORT_MESSAGE, "AbortError");
}

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * Attend `promise`, mais rend la main avec l'erreur d'annulation dès que le signal tombe. Un catch est attaché
 * à la promesse d'origine : son éventuel rejet tardif ne devient pas un rejet non géré.
 */
function awaitUnlessAborted<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const source = Promise.resolve(promise);
  source.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([source, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** `assets/dossier a/é.pdf` devient `/assets/dossier%20a/%C3%A9.pdf` (encodage par segment). */
function toAssetUrl(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface LoadPdfOptions {
  /**
   * Évite le téléchargement complet du PDF (mobile) : PDF.js ne demande que les plages utiles. Le flux reste actif
   * (`disableStream: false`), car les requêtes par plages en dépendent. Absent ou faux : `getDocument({ url })`, comme avant.
   */
  readonly disableAutoFetch?: boolean;
}

/**
 * Fabrique le `loadPdf` de l'indexeur. `getPdfjs` est évalué (et attendu) à chaque appel : le PDF.js de SiYuan
 * peut ne pas être prêt au chargement du plugin.
 */
export function createLoadPdf(
  getPdfjs: () => PdfjsLoader | undefined | PromiseLike<PdfjsLoader | undefined>,
  onWarn: (message: string) => void = (message) => console.warn(`[docseeker] ${message}`),
  options: LoadPdfOptions = {},
): (path: string, signal: AbortSignal) => Promise<PdfDocumentLike> {
  return async (path, signal) => {
    if (signal.aborted) throw abortError();
    // Getter synchrone (bureau) : aucune attente, le déroulé reste identique. Asynchrone (chargeur paresseux,
    // mobile) : on attend, puis on revérifie l'annulation survenue pendant l'attente.
    const got = getPdfjs();
    let pdfjs: PdfjsLoader | undefined;
    if (isThenable(got)) {
      pdfjs = await awaitUnlessAborted(got, signal);
      if (signal.aborted) throw abortError();
    } else {
      pdfjs = got;
    }
    if (!pdfjs) throw new Error("PDF.js de SiYuan indisponible (window.pdfjsLib absent)");

    if (!ensureWorkerSrc(pdfjs)) {
      onWarn("pdfjsLib.GlobalWorkerOptions absent : impossible de définir workerSrc, PDF.js risque d'échouer");
    }
    const task = pdfjs.getDocument(
      options.disableAutoFetch
        ? { url: toAssetUrl(path), disableAutoFetch: true, disableStream: false }
        : { url: toAssetUrl(path) },
    );
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
