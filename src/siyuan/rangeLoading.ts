/**
 * Chargement par plages du prochain PDF ouvert par le visionneur de SiYuan.
 *
 * Le visionneur appelle `window.pdfjsLib.getDocument(src)` sans options de plage : PDF.js lit alors le fichier
 * en flux continu. On enveloppe `getDocument` pour UN appel (celui du PDF demandé) et on y ajoute des plages
 * seules, ce qui accélère nettement le rendu de la page cible des gros PDF. Si `getDocument` est absent,
 * rien n'est fait et SiYuan garde son comportement.
 */

// shortcut: mesurée sur une connexion rapide, à réduire si des connexions lentes s'en plaignent.
export const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Délai après lequel l'enveloppe se retire seule si le visionneur n'a pas appelé `getDocument`. */
export const ARM_TIMEOUT_MS = 15_000;

export interface RangeLoadingOptions {
  readonly timeoutMs?: number;
  /** Trace seulement : échec d'armement, ou expiration sans appel correspondant. */
  readonly onWarn?: (message: string) => void;
}

type GetDocument = (this: unknown, src: unknown) => unknown;

let disarmCurrent: (() => void) | null = null;

const normalize = (text: string): string => text.normalize("NFC");

/** Chemin décodé et normalisé d'une URL (relative ou absolue), ou null si l'URL est illisible. */
function decodedPathname(url: unknown): string | null {
  if (typeof url !== "string" && !(url instanceof URL)) return null;
  try {
    const { pathname } = new URL(String(url), "http://localhost/");
    return normalize(decodeURIComponent(pathname));
  } catch {
    return null;
  }
}

function matches(src: unknown, path: string): src is Record<string, unknown> {
  if (typeof src !== "object" || src === null) return false;
  // Déjà en plages seules : ce sont les vignettes du plugin, pas le visionneur ; on garde l'enveloppe pour lui.
  if ((src as { disableStream?: unknown }).disableStream === true) return false;
  const pathname = decodedPathname((src as { url?: unknown }).url);
  return pathname !== null && pathname.endsWith(`/${normalize(path)}`);
}

/** Retire l'enveloppe posée par `armRangeLoading` ; sans effet si elle a déjà disparu. */
export function disarmRangeLoading(): void {
  disarmCurrent?.();
}

/**
 * Arme l'enveloppe de `lib.getDocument` pour le prochain appel dont l'URL se termine par `path` (`assets/x.pdf`).
 * Renvoie la fonction de désarmement (idempotente ; elle ne remet l'original que si l'enveloppe est encore en place).
 */
export function armRangeLoading(lib: unknown, path: string, options: RangeLoadingOptions = {}): () => void {
  disarmRangeLoading();
  const target = lib as { getDocument?: unknown } | null | undefined;
  if (typeof target?.getDocument !== "function") return () => undefined;
  const original = target.getDocument as GetDocument;
  const warn = options.onWarn ?? (() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const disarm = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      if (target.getDocument === wrapper) target.getDocument = original; // ne jamais écraser le patch d'un tiers
    } catch {
      // Propriété devenue non modifiable : on ne lève jamais depuis le temporisateur ni onunload.
    }
    if (disarmCurrent === disarm) disarmCurrent = null;
  };
  const wrapper: GetDocument = function (this: unknown, src: unknown) {
    if (!done && matches(src, path)) {
      disarm();
      const ranged = { ...src, disableStream: true, disableAutoFetch: true, rangeChunkSize: RANGE_CHUNK_BYTES };
      return original.call(this, ranged);
    }
    return original.call(this, src);
  };
  const delay = options.timeoutMs ?? ARM_TIMEOUT_MS;
  try {
    target.getDocument = wrapper;
  } catch (error) {
    warn(`Chargement par plages non armé pour ${path} : ${error instanceof Error ? error.message : String(error)}`);
    return () => undefined;
  }
  disarmCurrent = disarm;
  timer = setTimeout(() => {
    if (done) return;
    warn(`getDocument non appelé pour ${path} en ${delay / 1000} s : chargement par plages non appliqué`);
    disarm();
  }, delay);
  return disarm;
}
