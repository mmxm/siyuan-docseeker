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

export function buildIndex(pages: readonly PageInput[]): Bm25Index {
  const postings = new Map<string, Posting[]>();
  const pageLengths = new Map<string, number>();
  let totalTokens = 0;
  for (const { docId, page, text } of pages) {
    const tokens = tokenize(text);
    pageLengths.set(pageKey(docId, page), tokens.length);
    totalTokens += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, tf] of counts) {
      postings.set(term, [...(postings.get(term) ?? []), { docId, page, tf }]);
    }
  }
  const pageCount = pages.length;
  return {
    postings,
    pageLengths,
    pageCount,
    averagePageLength: pageCount === 0 ? 0 : totalTokens / pageCount,
  };
}

/** Postings d'un terme (ou de tous les termes ayant ce prefixe), tf sommes par page. */
function collectPostings(index: Bm25Index, term: string, asPrefix: boolean): ReadonlyMap<string, Posting> {
  const merged = new Map<string, Posting>();
  for (const [candidate, list] of index.postings) {
    const matches = asPrefix ? candidate.startsWith(term) : candidate === term;
    if (!matches) continue;
    for (const posting of list) {
      const key = pageKey(posting.docId, posting.page);
      const previous = merged.get(key);
      merged.set(key, previous ? { ...previous, tf: previous.tf + posting.tf } : posting);
    }
  }
  return merged;
}

function compareHits(a: PageHit, b: PageHit): number {
  return b.score - a.score || a.docId.localeCompare(b.docId) || a.page - b.page;
}

/** Recherche ET multi-mots ; le prefixe ne s'applique qu'au dernier mot. */
export function searchPages(index: Bm25Index, query: string): readonly PageHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || index.pageCount === 0) return [];
  const perTerm = terms.map((term, i) => collectPostings(index, term, i === terms.length - 1));
  const [first, ...rest] = perTerm;
  if (!first) return [];
  const hits: PageHit[] = [];
  for (const [key, posting] of first) {
    if (!rest.every((m) => m.has(key))) continue;
    const pageLength = index.pageLengths.get(key) ?? 0;
    const score = perTerm.reduce((sum, matches) => {
      const tf = matches.get(key)?.tf ?? 0;
      const termIdf = idf(index.pageCount, matches.size);
      return sum + termScore({ tf, pageLength, avgPageLength: index.averagePageLength, idf: termIdf });
    }, 0);
    hits.push({ docId: posting.docId, page: posting.page, score });
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
  for (const hit of hits) byDoc.set(hit.docId, [...(byDoc.get(hit.docId) ?? []), hit]);
  return [...byDoc]
    .map(([docId, list]) => toDocumentHit(docId, list, options.titleBonuses?.get(docId) ?? 0))
    .sort((a, b) => b.relevance - a.relevance || a.docId.localeCompare(b.docId));
}
