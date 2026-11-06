/**
 * Texte PDF.js -> `DocumentIndex`, sans dépendance à pdfjs (types structurels).
 *
 * Choix documentés :
 * - Mots = séquences de caractères pouvant produire un jeton : lettres, chiffres, marques Unicode (\p{M},
 *   pour ne pas couper un mot NFD), et symboles que NFKD rend alphanumériques (« ⓐ », « ㎏ », « ℀ »). Le critère
 *   est celui de `tokenize` (parité requête/document) ; le reste sépare. Un tel symbole collé à un mot en
 *   fait partie (« aⓐb » -> « aab », comme `tokenize("aⓐb")`).
 * - Boîtes : la largeur d'un item est répartie proportionnellement à la position des caractères
 *   (indices UTF-16) dans `item.str`. C'est une approximation (police non monospace, crénage ignorés).
 * - Tous les jetons issus d'un même mot (ex. « ½ » -> « 1 », « 2 ») partagent la boîte du mot ; il y a donc
 *   exactement une boîte par jeton, et l'ordinal d'un jeton est son indice dans `pageBoxes[page]`.
 * - Mots coupés en fin de ligne (« informa- » / « tion ») : NON rejoints en v1 (deux mots distincts).
 *   Aucun mot ne chevauche deux items. L'ordre des items est conservé (pas de reconstruction de lecture).
 * - Clamp : chaque boîte est ramenée dans [0,1] (x, y, puis largeur/hauteur limitées au bord de la page).
 * - Taille de page : `viewWidth` x `viewHeight` (viewport PDF.js d'échelle 1, rotation appliquée), arrondie au
 *   dixième de point ; une page absente de l'extraction prend le repli A4 (595 x 842).
 * - Page aberrante (une dimension hors 0,1..20 000 pt après arrondi) : sa taille STOCKÉE prend le repli A4 et
 *   `options.onWarn` reçoit un message qui nomme la page ; le PDF reste indexé (les boîtes sont des fractions de
 *   la vraie vue, donc valides). Une exception de `onWarn` remonte à l'appelant. Une taille nulle, négative ou non finie reste une ExtractionInputError : aucune
 *   boîte ne peut être calculée.
 * - Rectangle en espace vue = boîte englobante alignée sur les axes (texte tourné/incliné compris).
 */
import {
  FALLBACK_PAGE_SIZE,
  MAX_PAGE_DIMENSION_UNITS,
  compareUtf8,
  pageDimensionToUnits,
  unitsToPageDimension,
  type DocumentIndex,
  type PageSize,
  type Posting,
  type TermEntry,
  type WordBox,
} from "./codec/format";
import { tokenize } from "./normalize";

export interface TextItemLike {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL?: boolean;
}

export interface ExtractedPage {
  readonly pageNumber: number;
  readonly viewportTransform: readonly number[];
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly items: readonly TextItemLike[];
}

export interface DocumentMeta {
  readonly normalizerVersion: number;
  readonly extractorVersion: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
  readonly sourcePath: string;
  readonly pageCount: number;
}

export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Une page avec au plus ce nombre de jetons n'est pas considérée comme textuelle (PDF scanné). */
export const SCANNED_MAX_TOKENS_PER_PAGE = 5;

const MATRIX_LENGTH = 6;
/** Caractère déjà alphanumérique (ou marque) avant normalisation : cas rapide, sans appeler `tokenize`. */
const PLAIN_WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
/** Mémo : caractère -> « peut produire un jeton ». Borné par le nombre de caractères distincts rencontrés. */
const WORD_CHAR_CACHE = new Map<string, boolean>();
const TEXT_ENCODER = new TextEncoder();

export class ExtractionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionInputError";
  }
}

type Matrix = readonly [number, number, number, number, number, number];

/** Repère d'un item en espace vue : origine, vecteur largeur, vecteur hauteur (vers le haut du texte). */
interface Frame {
  readonly ox: number;
  readonly oy: number;
  readonly wx: number;
  readonly wy: number;
  readonly hx: number;
  readonly hy: number;
}

function assertMatrix(m: readonly number[], label: string): Matrix {
  if (m.length !== MATRIX_LENGTH || !m.every(Number.isFinite)) {
    throw new ExtractionInputError(`${label} must be 6 finite numbers`);
  }
  return m as unknown as Matrix;
}

/** Équivalent de pdfjs `Util.transform(m1, m2)`. */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function buildFrame(item: TextItemLike, viewportTransform: readonly number[]): Frame {
  const vp = assertMatrix(viewportTransform, "viewportTransform");
  const tr = assertMatrix(item.transform, "item.transform");
  if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) {
    throw new ExtractionInputError("item width/height must be finite");
  }
  const m = multiply(vp, tr);
  const userNorm = Math.hypot(tr[0], tr[1]);
  // Largeur : item.width (espace utilisateur) le long de la direction du texte, passée en espace vue.
  const [ux, uy] = userNorm === 0 ? [1, 0] : [tr[0] / userNorm, tr[1] / userNorm];
  return {
    ox: m[4],
    oy: m[5],
    wx: (vp[0] * ux + vp[2] * uy) * item.width,
    wy: (vp[1] * ux + vp[3] * uy) * item.width,
    hx: m[2],
    hy: m[3],
  };
}

/** Boîte englobante de la portion [t0,t1] (fractions de la largeur) de l'item. */
function spanRect(f: Frame, t0: number, t1: number): ViewRect {
  const xs = [f.ox + f.wx * t0, f.ox + f.wx * t1];
  const ys = [f.oy + f.wy * t0, f.oy + f.wy * t1];
  const allX = [...xs, xs[0]! + f.hx, xs[1]! + f.hx];
  const allY = [...ys, ys[0]! + f.hy, ys[1]! + f.hy];
  const x = Math.min(...allX);
  const y = Math.min(...allY);
  return { x, y, width: Math.max(...allX) - x, height: Math.max(...allY) - y };
}

/** Rectangle de l'item en coordonnées de vue (origine en haut à gauche). */
export function itemToViewRect(item: TextItemLike, viewportTransform: readonly number[]): ViewRect {
  return spanRect(buildFrame(item, viewportTransform), 0, 1);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function toFractionBox(r: ViewRect, viewWidth: number, viewHeight: number): WordBox {
  const x = clamp01(r.x / viewWidth);
  const y = clamp01(r.y / viewHeight);
  return {
    x,
    y,
    width: clamp01((r.x + r.width) / viewWidth) - x,
    height: clamp01((r.y + r.height) / viewHeight) - y,
  };
}

interface PageTokens {
  readonly tokens: string[];
  readonly boxes: WordBox[];
  readonly size: PageSize;
}

function validatePage(page: ExtractedPage): void {
  assertMatrix(page.viewportTransform, "viewportTransform");
  if (!(page.viewWidth > 0) || !(page.viewHeight > 0) || !Number.isFinite(page.viewWidth + page.viewHeight)) {
    throw new ExtractionInputError(`page ${page.pageNumber}: viewWidth/viewHeight must be positive and finite`);
  }
}

const isStorableDimension = (value: number): boolean => {
  const units = pageDimensionToUnits(value);
  return units >= 1 && units <= MAX_PAGE_DIMENSION_UNITS;
};

/** Options d'extraction. */
export interface BuildOptions {
  /** Reçoit un message par anomalie non bloquante (page aberrante). Une exception du rappel est ignorée. */
  readonly onWarn?: (message: string) => void;
}

const roundToUnit = (v: number): number => unitsToPageDimension(pageDimensionToUnits(v));

/** Taille de page stockée : arrondie au dixième de point, ou repli A4 (avec avertissement) si aberrante. */
function storedPageSize(page: ExtractedPage, onWarn: BuildOptions["onWarn"]): PageSize {
  if (isStorableDimension(page.viewWidth) && isStorableDimension(page.viewHeight)) {
    return { widthPt: roundToUnit(page.viewWidth), heightPt: roundToUnit(page.viewHeight) };
  }
  // Une exception du rappel remonte à l'appelant (l'indexeur protège le sien) : pas d'erreur avalée ici.
  onWarn?.(
    `page ${page.pageNumber}: taille ${page.viewWidth} x ${page.viewHeight} pt hors de 0,1..${unitsToPageDimension(MAX_PAGE_DIMENSION_UNITS)} pt, ` +
      `repli sur A4 (${FALLBACK_PAGE_SIZE.widthPt} x ${FALLBACK_PAGE_SIZE.heightPt} pt)`,
  );
  return FALLBACK_PAGE_SIZE;
}

/**
 * Vrai si `char` appartient à un mot : lettre/chiffre/marque, OU symbole que NFKD rend alphanumérique
 * (« ⓐ » -> a, « ㎏ » -> kg, « ℀ » -> a/c). Même critère que `tokenize` : requête et document ne divergent plus.
 */
function isWordChar(char: string): boolean {
  if (PLAIN_WORD_CHAR.test(char)) return true;
  const cached = WORD_CHAR_CACHE.get(char);
  if (cached !== undefined) return cached;
  const result = tokenize(char).length > 0;
  WORD_CHAR_CACHE.set(char, result);
  return result;
}

interface WordRun {
  readonly text: string;
  /** Indice UTF-16 de début dans l'item. */
  readonly start: number;
}

/** Séquences maximales de caractères de mot (points de code entiers), avec leur position UTF-16. */
function wordRuns(str: string): readonly WordRun[] {
  const runs: WordRun[] = [];
  let start = -1;
  let offset = 0;
  for (const char of str) {
    if (isWordChar(char)) {
      if (start < 0) start = offset;
    } else if (start >= 0) {
      runs.push({ text: str.slice(start, offset), start });
      start = -1;
    }
    offset += char.length;
  }
  if (start >= 0) runs.push({ text: str.slice(start), start });
  return runs;
}

/** Jetons (un par entrée) et boîtes (une par jeton) d'une page, dans l'ordre des items. */
function extractPage(page: ExtractedPage, onWarn: BuildOptions["onWarn"]): PageTokens {
  validatePage(page);
  const out: PageTokens = { tokens: [], boxes: [], size: storedPageSize(page, onWarn) };
  for (const item of page.items) {
    const frame = buildFrame(item, page.viewportTransform);
    const length = item.str.length;
    for (const { text, start } of wordRuns(item.str)) {
      const wordTokens = tokenize(text);
      if (wordTokens.length === 0) continue;
      const rect = spanRect(frame, start / length, (start + text.length) / length);
      const box = toFractionBox(rect, page.viewWidth, page.viewHeight);
      for (const token of wordTokens) {
        out.tokens.push(token);
        out.boxes.push(box);
      }
    }
  }
  return out;
}

function validateMeta(meta: DocumentMeta): void {
  if (!Number.isInteger(meta.pageCount) || meta.pageCount < 0) {
    throw new ExtractionInputError("pageCount must be a non-negative integer");
  }
}

function indexPages(
  meta: DocumentMeta,
  pages: readonly ExtractedPage[],
  onWarn: BuildOptions["onWarn"],
): Omit<DocumentIndex, "terms"> & {
  terms: Map<string, { page: number; ordinals: number[] }[]>;
} {
  const perPage: (PageTokens | undefined)[] = new Array<PageTokens | undefined>(meta.pageCount);
  for (const page of pages) {
    const n = page.pageNumber;
    if (!Number.isInteger(n) || n < 1 || n > meta.pageCount) {
      throw new ExtractionInputError(`pageNumber ${n} out of range 1..${meta.pageCount}`);
    }
    if (perPage[n - 1] !== undefined) throw new ExtractionInputError(`duplicate pageNumber ${n}`);
    perPage[n - 1] = extractPage(page, onWarn);
  }
  const terms = new Map<string, { page: number; ordinals: number[] }[]>();
  const pageTermCounts: number[] = [];
  const pageBoxes: (readonly WordBox[])[] = [];
  const pageSizes: PageSize[] = [];
  for (let i = 0; i < meta.pageCount; i++) {
    const data = perPage[i] ?? { tokens: [], boxes: [], size: FALLBACK_PAGE_SIZE };
    pageTermCounts.push(data.tokens.length);
    pageBoxes.push(data.boxes);
    pageSizes.push(data.size);
    data.tokens.forEach((token, ordinal) => {
      const list = terms.get(token) ?? [];
      terms.set(token, list);
      const last = list[list.length - 1];
      if (last?.page === i + 1) last.ordinals.push(ordinal);
      else list.push({ page: i + 1, ordinals: [ordinal] });
    });
  }
  return { ...meta, pageTermCounts, pageBoxes, pageSizes, terms };
}

/** Construit l'index d'un document. Les pages absentes de `pages` sont vides. */
export function buildDocumentIndex(
  meta: DocumentMeta,
  pages: readonly ExtractedPage[],
  options: BuildOptions = {},
): DocumentIndex {
  validateMeta(meta);
  const built = indexPages(meta, pages, options.onWarn);
  const sorted = [...built.terms]
    .map(([term, list]) => ({ term, bytes: TEXT_ENCODER.encode(term), list }))
    .sort((a, b) => compareUtf8(a.bytes, b.bytes));
  const terms: TermEntry[] = sorted.map(({ term, list }) => ({
    term,
    postings: list.map(
      (p): Posting => ({ page: p.page, termFrequency: p.ordinals.length, wordOrdinals: p.ordinals }),
    ),
  }));
  return {
    normalizerVersion: meta.normalizerVersion,
    extractorVersion: meta.extractorVersion,
    sourcePath: meta.sourcePath,
    pdfSize: meta.pdfSize,
    pdfModifiedMs: meta.pdfModifiedMs,
    pageTermCounts: built.pageTermCounts,
    terms,
    pageBoxes: built.pageBoxes,
    pageSizes: built.pageSizes,
  };
}

/** Vrai si aucune page n'a plus de `SCANNED_MAX_TOKENS_PER_PAGE` jetons (PDF scanné : ignoré et signalé). */
export function isLikelyScanned(pages: readonly ExtractedPage[]): boolean {
  return !pages.some(
    (page) =>
      page.items.reduce((sum, item) => sum + tokenize(item.str).length, 0) > SCANNED_MAX_TOKENS_PER_PAGE,
  );
}
