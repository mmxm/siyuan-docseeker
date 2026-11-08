import type { PdfjsLoader } from "../indexer/loadPdf";

/**
 * ATTENTION : cette URL doit rester identique à celle du noyau SiYuan 3.8.9, sinon le navigateur évalue un
 * second exemplaire de PDF.js (deux `pdfjsLib`, visionneur cassé). Un test la fige.
 *
 * Module PDF.js embarqué par SiYuan 3.8.9 (`loadPdf.ts` du noyau : `${PROTYLE_CDN}/js/pdf/pdf.min.mjs?v=6.4.299-siyuan.1`,
 * PROTYLE_CDN = "/stage/protyle"). Le worker associé est `pdf.worker.compat.mjs?v=6.4.299-siyuan.2`
 * (voir SIYUAN_PDF_WORKER_SRC). Le module pose `window.pdfjsLib` en s'évaluant.
 */
export const PDFJS_MODULE_SRC = "/stage/protyle/js/pdf/pdf.min.mjs?v=6.4.299-siyuan.1";

/** Délai maximal d'attente de `window.pdfjsLib` après injection. */
export const DEFAULT_PDFJS_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/** Balise `<script>` manipulée par le chargeur (sous-ensemble utilisé). */
type ScriptLike = Pick<HTMLScriptElement, "type" | "src" | "remove"> & {
  addEventListener(name: "error" | "load", listener: (event?: unknown) => void): void;
};

export interface LazyPdfjsDeps {
  readonly window: { pdfjsLib?: unknown };
  readonly document: {
    createElement(tag: "script"): ScriptLike;
    readonly head: { appendChild<T extends Node>(node: T): T };
  };
  /** Délai maximal avant d'abandonner (ms). */
  readonly timeoutMs?: number;
  /** Intervalle de sondage de `window.pdfjsLib` (ms). */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Fabrique un accès paresseux à PDF.js. Si `window.pdfjsLib` existe déjà (bureau, ou déjà injecté), il est
 * renvoyé tel quel : injecter un second exemplaire casserait le visionneur de SiYuan. Sinon une seule balise
 * module est injectée, partagée entre les appels concurrents et retirée ensuite. Un échec n'est pas mis en
 * cache : l'appel suivant réessaie.
 */
export function createLazyPdfjs(deps: LazyPdfjsDeps): () => Promise<PdfjsLoader> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PDFJS_TIMEOUT_MS;
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending: Promise<PdfjsLoader> | undefined;

  const inject = async (): Promise<PdfjsLoader> => {
    const script = deps.document.createElement("script");
    script.type = "module";
    script.src = PDFJS_MODULE_SRC;
    let failure: { readonly event: unknown } | undefined;
    let loaded = false;
    script.addEventListener("error", (event) => {
      failure = { event };
    });
    script.addEventListener("load", () => {
      loaded = true;
    });
    try {
      deps.document.head.appendChild(script as unknown as Node);
      const deadline = now() + timeoutMs;
      for (;;) {
        // le succès prime : pdfjsLib posé, même si `error` est arrivé ensuite
        if (deps.window.pdfjsLib) return deps.window.pdfjsLib as PdfjsLoader;
        if (failure) {
          throw new Error(`Erreur de chargement de PDF.js (${PDFJS_MODULE_SRC})`, { cause: failure.event });
        }
        if (loaded) {
          throw new Error(`Module PDF.js évalué sans poser window.pdfjsLib (${PDFJS_MODULE_SRC})`);
        }
        if (now() >= deadline) {
          throw new Error(`PDF.js n'est pas apparu après ${timeoutMs} ms (${PDFJS_MODULE_SRC})`);
        }
        await sleep(pollMs);
      }
    } finally {
      // sans effet si la balise n'a jamais été attachée (appendChild en échec)
      script.remove();
    }
  };

  return () => {
    const existing = deps.window.pdfjsLib;
    if (existing) return Promise.resolve(existing as PdfjsLoader);
    if (!pending) {
      const attempt = inject();
      pending = attempt;
      // échec non mis en cache : le prochain appel réessaie (l'erreur reste rapportée aux appelants)
      attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  };
}
