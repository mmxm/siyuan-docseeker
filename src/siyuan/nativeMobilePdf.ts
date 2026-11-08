/**
 * Mobile : ouvre le PDF dans le visionneur natif de SiYuan (PDF.js complet, défilement continu, zoom).
 *
 * Aucune API de plugin ne le permet (vérifié sur SiYuan 3.8.9 mobile). Contournement : cliquer un lien
 * `<span data-type="a" data-href="assets/x.pdf?page=N">` placé dans l'éditeur mobile ouvre `#model` à la page N.
 * Le paragraphe est temporaire et toujours retiré. Tout échec (éditeur absent, modèle non ouvert) est une erreur
 * explicite : l'appelant se replie sur un autre visionneur.
 */
import { assertValidPdfPath, type OpenTabFn, type PdfTarget } from "./openPdf";

/** L'éditeur mobile est absent : rien n'a été cliqué, l'appelant peut se replier sur n'importe quel autre moyen d'ouvrir le PDF. */
export class NativeEditorMissingError extends Error {
  constructor() {
    super("Éditeur mobile de SiYuan introuvable : visionneur natif indisponible");
    this.name = "NativeEditorMissingError";
  }
}

/** Le lien a été cliqué mais le visionneur n'est pas apparu : il peut encore s'ouvrir, l'appelant ne doit pas ouvrir le navigateur. */
export class NativeModelNotOpenError extends Error {
  constructor(timeoutMs: number) {
    super(`Le visionneur PDF natif ne s'est pas ouvert en ${timeoutMs} ms (modèle fermé ou sans contenu)`);
    this.name = "NativeModelNotOpenError";
  }
}

export interface NativeMobilePdfDeps {
  /** Élément wysiwyg de l'éditeur mobile (défaut : `window.siyuan.mobile.editor.protyle.wysiwyg.element`). */
  readonly getWysiwyg?: () => Element | null | undefined;
  /** Vrai quand le visionneur natif est ouvert avec un contenu PDF (défaut : `#model` à `translateX(0)` et `#modelMain` avec des pages). */
  readonly isModelOpen?: (doc: Document) => boolean;
  /** Horloge en ms (défaut `Date.now`) : le délai d'attente est du temps écoulé, pas un nombre de sondages. */
  readonly now?: () => number;
  /** Attente entre deux sondages (injectable pour les tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Durée maximale d'attente de l'ouverture (défaut 3000 ms). */
  readonly timeoutMs?: number;
  /** Intervalle de sondage (défaut 50 ms). */
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_MS = 50;
const NODE_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const NODE_ID_SUFFIX_LENGTH = 7;

function defaultWysiwyg(): Element | null | undefined {
  const siyuan: unknown = (window as unknown as { siyuan?: unknown }).siyuan;
  const walk = (value: unknown, keys: readonly string[]): unknown =>
    keys.reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), value);
  const element = walk(siyuan, ["mobile", "editor", "protyle", "wysiwyg", "element"]);
  return typeof element === "object" && element !== null && (element as Node).nodeType === 1 ? (element as Element) : undefined;
}

const OPEN_TRANSFORMS = new Set(["translatex(0px)", "translatex(0)", "translatex(0%)", "matrix(1, 0, 0, 1, 0, 0)"]);
const FULLSCREEN_RATIO = 0.9;

/** `#model` est à l'écran : transform nul (écrit de plusieurs façons) ou, sans transform, un rectangle qui couvre l'écran. */
function isOnScreen(model: HTMLElement, doc: Document): boolean {
  const view = doc.defaultView;
  const inline = model.style.transform.trim().toLowerCase();
  const computed = (view?.getComputedStyle(model).transform ?? "").trim().toLowerCase();
  if (OPEN_TRANSFORMS.has(inline) || OPEN_TRANSFORMS.has(computed)) return true;
  const none = (v: string): boolean => v === "" || v === "none";
  if (!none(inline) || !none(computed) || !view) return false;
  const rect = model.getBoundingClientRect();
  return rect.width >= view.innerWidth * FULLSCREEN_RATIO && rect.height >= view.innerHeight * FULLSCREEN_RATIO && rect.left < 1 && rect.left > -1 && view.innerWidth > 0;
}

function defaultIsModelOpen(doc: Document): boolean {
  const model = doc.getElementById("model");
  if (!model || !isOnScreen(model, doc)) return false;
  const main = doc.getElementById("modelMain");
  return main !== null && main.querySelector(".page, .pdfViewer") !== null;
}

/** Identifiant de nœud SiYuan valide : 14 chiffres (horodatage), tiret, 7 caractères [0-9a-z]. */
function newNodeId(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp = `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let suffix = "";
  for (let i = 0; i < NODE_ID_SUFFIX_LENGTH; i += 1) suffix += NODE_ID_CHARS[Math.floor(Math.random() * NODE_ID_CHARS.length)];
  return `${stamp}-${suffix}`;
}

export function createNativeMobilePdfOpener(deps: NativeMobilePdfDeps = {}): OpenTabFn {
  const getWysiwyg = deps.getWysiwyg ?? defaultWysiwyg;
  const isModelOpen = deps.isModelOpen ?? defaultIsModelOpen;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  const now = deps.now ?? Date.now;
  // Un seul paragraphe temporaire et un seul sondage à la fois : un second appel attend la fin du premier.
  let tail: Promise<unknown> = Promise.resolve();

  const run = async (target: PdfTarget): Promise<void> => {
    const { path, page } = target.pdf;
    const signal = target.signal;
    if (signal?.aborted) return;
    const wysiwyg = getWysiwyg();
    if (!wysiwyg) throw new NativeEditorMissingError();
    const doc = wysiwyg.ownerDocument;

    const paragraph = doc.createElement("div");
    paragraph.className = "p";
    paragraph.setAttribute("data-type", "NodeParagraph");
    paragraph.setAttribute("data-node-id", newNodeId(new Date()));
    const editable = doc.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const link = doc.createElement("span");
    link.setAttribute("data-type", "a");
    link.setAttribute("data-href", `${path}?page=${page}`);
    link.textContent = "PDF";
    editable.append(link);
    paragraph.append(editable);
    wysiwyg.append(paragraph);
    try {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } finally {
      paragraph.remove();
    }

    const start = now();
    // Le test d'ouverture précède toujours celui du délai : le dernier sondage a donc lieu après la dernière attente.
    while (!isModelOpen(doc)) {
      if (signal?.aborted) return;
      if (now() - start >= timeoutMs) throw new NativeModelNotOpenError(timeoutMs);
      await sleep(pollMs);
    }
  };

  return async (target: PdfTarget): Promise<void> => {
    const { path, page } = target.pdf;
    assertValidPdfPath(path);
    if (!Number.isInteger(page) || page < 1) throw new RangeError(`page must be an integer >= 1, got ${page}`);
    const result = tail.then(() => run(target));
    tail = result.catch(() => undefined);
    return result;
  };
}

export const openNativeMobilePdf: OpenTabFn = createNativeMobilePdfOpener();
