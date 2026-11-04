/**
 * BM25 au niveau de la page (1 document BM25 = 1 page), equivalent a `bm25(pages_fts)` de SQLite FTS5
 * tel qu'utilise par DocSeeker (backend-rust/crates/search-core/src/sql.rs:183, 213-218, 230).
 *
 * Convention de signe : FTS5 renvoie des valeurs NEGATIVES (ordre croissant = meilleur d'abord).
 * Ici les scores sont POSITIFS (ordre decroissant) ; `toFtsBm25(score) === -score`.
 */
import { tokenize } from "./normalize";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Plancher FTS5 applique quand l'idf est <= 0. */
export const MIN_IDF = 1e-6;
/** idf FTS5 : ln((N - df + 0.5) / (df + 0.5)). */
const IDF_SMOOTHING = 0.5;

/** sql.rs:213-218 et constants.rs:17-21. */
export const MAX_PAGES_PER_DOCUMENT = 5;
export const BEST_PAGE_WEIGHT = 100;
export const PAGE_COUNT_WEIGHT = 5;
export const PAGE_COUNT_BONUS_CAP = 300;

const KEY_SEPARATOR = "\u0000";

export interface Posting {
  readonly docId: string;
  readonly page: number;
  readonly tf: number;
}

export interface PageInput {
  readonly docId: string;
  readonly page: number;
  readonly text: string;
}

export interface Bm25Index {
  /** terme normalise -> une entree par page contenant le terme (df = longueur). */
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
  /** Termes du vocabulaire tries (unites de code) : recherche dichotomique des prefixes. */
  readonly sortedTerms: readonly string[];
  /** pageKey(docId, page) -> nombre de tokens de la page. */
  readonly pageLengths: ReadonlyMap<string, number>;
  /** N : nombre total de pages indexees. */
  readonly pageCount: number;
  /** Longueur moyenne des pages en tokens. */
  readonly averagePageLength: number;
}

export interface PageHit {
  readonly docId: string;
  readonly page: number;
  /** Score BM25 positif (plus grand = meilleur). */
  readonly score: number;
}

export interface DocumentHit {
  readonly docId: string;
  readonly bestScore: number;
  readonly matchingPages: number;
  readonly relevance: number;
  /** Meilleures pages (max 5), score decroissant. */
  readonly pages: readonly PageHit[];
}

export interface GroupOptions {
  /** Bonus de titre par docId (1500 titre complet, 500 partiel dans DocSeeker). */
  readonly titleBonuses?: ReadonlyMap<string, number>;
}

export interface TermScoreInput {
  readonly tf: number;
  readonly pageLength: number;
  readonly avgPageLength: number;
  readonly idf: number;
}

export function pageKey(docId: string, page: number): string {
  return `${docId}${KEY_SEPARATOR}${page}`;
}

export function toFtsBm25(score: number): number {
  return -score;
}

export function idf(pageCount: number, docFrequency: number): number {
  const raw = Math.log((pageCount - docFrequency + IDF_SMOOTHING) / (docFrequency + IDF_SMOOTHING));
  return raw <= 0 ? MIN_IDF : raw;
}

export function termScore({ tf, pageLength, avgPageLength, idf: termIdf }: TermScoreInput): number {
  if (avgPageLength <= 0) return 0;
  const lengthNorm = 1 - BM25_B + (BM25_B * pageLength) / avgPageLength;
  return (termIdf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
}

/** Page inseree deux fois : indexer deux fois doublerait les postings et fausserait N (decision : erreur explicite). */
export class DuplicatePageError extends Error {
  readonly docId: string;
  readonly page: number;

  constructor(docId: string, page: number) {
    super(`Page en double dans l'index BM25 : docId=${docId} page=${page}`);
    this.name = "DuplicatePageError";
    this.docId = docId;
    this.page = page;
  }
}

function countTokens(tokens: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** @throws DuplicatePageError si un meme (docId, page) apparait deux fois. */
export function buildIndex(pages: readonly PageInput[]): Bm25Index {
  const postings = new Map<string, Posting[]>();
  const pageLengths = new Map<string, number>();
  let totalTokens = 0;
  for (const { docId, page, text } of pages) {
    const key = pageKey(docId, page);
    if (pageLengths.has(key)) throw new DuplicatePageError(docId, page);
    const tokens = tokenize(text);
    pageLengths.set(key, tokens.length);
    totalTokens += tokens.length;
    for (const [term, tf] of countTokens(tokens)) {
      const list = postings.get(term);
      if (list) list.push({ docId, page, tf });
      else postings.set(term, [{ docId, page, tf }]);
    }
  }
  const pageCount = pages.length;
  return {
    postings,
    sortedTerms: [...postings.keys()].sort(),
    pageLengths,
    pageCount,
    averagePageLength: pageCount === 0 ? 0 : totalTokens / pageCount,
  };
}

/** tf cumule par page (docId -> page -> tf) et nombre de pages distinctes (= df FTS5 du terme ou du prefixe). */
interface TermMatches {
  readonly size: number;
  readonly tfByPage: ReadonlyMap<string, ReadonlyMap<number, number>>;
}

/** Premier indice de `sorted` dont le terme est >= `prefix` (ordre des unites de code, coherent avec startsWith). */
function lowerBound(sorted: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? "") < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function matchingTermLists(index: Bm25Index, term: string, asPrefix: boolean): readonly (readonly Posting[])[] {
  if (!asPrefix) {
    const list = index.postings.get(term);
    return list ? [list] : [];
  }
  const lists: (readonly Posting[])[] = [];
  for (let i = lowerBound(index.sortedTerms, term); i < index.sortedTerms.length; i++) {
    const candidate = index.sortedTerms[i] ?? "";
    if (!candidate.startsWith(term)) break;
    const list = index.postings.get(candidate);
    if (list) lists.push(list);
  }
  return lists;
}

/** Postings d'un terme (ou de tous les termes ayant ce prefixe), tf sommes par page. */
function collectPostings(index: Bm25Index, term: string, asPrefix: boolean): TermMatches {
  const tfByPage = new Map<string, Map<number, number>>();
  let size = 0;
  for (const list of matchingTermLists(index, term, asPrefix)) {
    for (const { docId, page, tf } of list) {
      let pages = tfByPage.get(docId);
      if (!pages) tfByPage.set(docId, (pages = new Map()));
      const previous = pages.get(page);
      if (previous === undefined) size++;
      pages.set(page, (previous ?? 0) + tf);
    }
  }
  return { size, tfByPage };
}

/** Comparaison par points de code Unicode : deterministe, independante de la locale. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

function compareHits(a: PageHit, b: PageHit): number {
  return b.score - a.score || compareCodePoints(a.docId, b.docId) || a.page - b.page;
}

function scorePage(index: Bm25Index, perTerm: readonly TermMatches[], docId: string, page: number): number {
  const pageLength = index.pageLengths.get(pageKey(docId, page)) ?? 0;
  let score = 0;
  for (const matches of perTerm) {
    const tf = matches.tfByPage.get(docId)?.get(page) ?? 0;
    const termIdf = idf(index.pageCount, matches.size);
    score += termScore({ tf, pageLength, avgPageLength: index.averagePageLength, idf: termIdf });
  }
  return score;
}

/** Recherche ET multi-mots ; le prefixe ne s'applique qu'au dernier mot. */
export function searchPages(index: Bm25Index, query: string): readonly PageHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || index.pageCount === 0) return [];
  const perTerm = terms.map((term, i) => collectPostings(index, term, i === terms.length - 1));
  const [first, ...rest] = perTerm;
  if (!first) return [];
  const hits: PageHit[] = [];
  for (const [docId, pages] of first.tfByPage) {
    for (const page of pages.keys()) {
      if (!rest.every((m) => m.tfByPage.get(docId)?.has(page))) continue;
      hits.push({ docId, page, score: scorePage(index, perTerm, docId, page) });
    }
  }
  return hits.sort(compareHits);
}

function toDocumentHit(docId: string, pageHits: readonly PageHit[], titleBonus: number): DocumentHit {
  const sorted = [...pageHits].sort(compareHits);
  const bestScore = sorted[0]?.score ?? 0;
  const pageBonus = Math.min(sorted.length * PAGE_COUNT_WEIGHT, PAGE_COUNT_BONUS_CAP);
  return {
    docId,
    bestScore,
    matchingPages: sorted.length,
    relevance: titleBonus + Math.abs(bestScore) * BEST_PAGE_WEIGHT + pageBonus,
    pages: sorted.slice(0, MAX_PAGES_PER_DOCUMENT),
  };
}

/** Regroupe par document et classe par pertinence decroissante (formule de sql.rs:213-218). */
export function groupByDocument(hits: readonly PageHit[], options: GroupOptions = {}): readonly DocumentHit[] {
  const byDoc = new Map<string, PageHit[]>();
  for (const hit of hits) {
    const list = byDoc.get(hit.docId);
    if (list) list.push(hit);
    else byDoc.set(hit.docId, [hit]);
  }
  return [...byDoc]
    .map(([docId, list]) => toDocumentHit(docId, list, options.titleBonuses?.get(docId) ?? 0))
    .sort((a, b) => b.relevance - a.relevance || compareCodePoints(a.docId, b.docId));
}
