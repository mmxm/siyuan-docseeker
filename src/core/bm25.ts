/**
 * BM25 au niveau de la page (1 document BM25 = 1 page), equivalent a `bm25(pages_fts)` de SQLite FTS5
 * tel qu'utilise par DocSeeker (backend-rust/crates/search-core/src/sql.rs:183, 213-218, 230).
 *
 * Convention de signe : FTS5 renvoie des valeurs NEGATIVES (ordre croissant = meilleur d'abord).
 * Ici les scores sont POSITIFS (ordre decroissant) ; `toFtsBm25(score) === -score`.
 */
import { MAX_PAGES } from "./codec/format";
import { tokenize } from "./normalize";
import { MATCH_WEIGHT, MatchClass, classifyTerm, queryWordRules, type QueryWordRule } from "./termMatch";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Plancher FTS5 applique quand l'idf est <= 0. */
export const MIN_IDF = 1e-6;
/** idf FTS5 : ln((N - df + 0.5) / (df + 0.5)). */
const IDF_SMOOTHING = 0.5;

/** Plafond de pages conservées par document (la vue en affiche 5, puis déplie par lots) : borne mémoire et DOM. */
export const MAX_EXPANDED_PAGES = 200;
/** sql.rs:213-218 et constants.rs:17-21. */
export const BEST_PAGE_WEIGHT = 100;
export const PAGE_COUNT_WEIGHT = 5;
export const PAGE_COUNT_BONUS_CAP = 300;

/** Pages d'un document : bornes de buildIndex (les longueurs de page sont stockées densément, page - 1). */
const FIRST_PAGE = 1;
const MAX_INDEXED_PAGE = MAX_PAGES;

/** Posting développé (docId, page, tf) : vue de lecture pour les tests et outils, jamais stocké. */
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

/**
 * Index BM25 d'un seul document, en tableaux typés (pas d'objet par posting ni de clé chaîne par page).
 * Les postings du terme `i` occupent [offsets[i], offsets[i+1]) dans `pages` (base 1) et `termFrequencies`.
 */
export interface DocumentSegment {
  readonly docId: string;
  /** Pages comptées dans N (peut être inférieur à pageLengths.length si les numéros de page sont creux). */
  readonly pageCount: number;
  /** Somme des longueurs de page, en tokens. */
  readonly totalTokens: number;
  /** Longueur de la page p en tokens : pageLengths[p - 1] (0 pour une page absente). */
  readonly pageLengths: Uint32Array;
  /** Termes triés en unités de code UTF-16 (recherche dichotomique des préfixes). */
  readonly terms: readonly string[];
  readonly offsets: Uint32Array;
  readonly pages: Uint32Array;
  readonly termFrequencies: Uint32Array;
}

export interface Bm25Index {
  /** Un segment par document (docId distincts). */
  readonly segments: readonly DocumentSegment[];
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

/** Segment compact incohérent (tableaux typés ou numéros de page invalides). */
export class InvalidSegmentError extends RangeError {
  readonly docId: string;

  constructor(docId: string, detail: string) {
    super(`Segment BM25 invalide : docId=${docId} : ${detail}`);
    this.name = "InvalidSegmentError";
    this.docId = docId;
  }
}

/** Même docId fourni deux fois (segments ou documents). */
export class DuplicateDocumentError extends Error {
  readonly docId: string;

  constructor(docId: string) {
    super(`Document en double dans l'index BM25 : docId=${docId}`);
    this.name = "DuplicateDocumentError";
    this.docId = docId;
  }
}

function countTokens(tokens: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Indices de `terms` triés en unités de code UTF-16 (ordre de la recherche), ou undefined s'ils le sont déjà. */
function codeUnitPermutation(terms: readonly string[]): number[] | undefined {
  let sorted = true;
  for (let i = 1; i < terms.length && sorted; i++) sorted = (terms[i - 1] as string) < (terms[i] as string);
  if (sorted) return undefined;
  return terms.map((_, i) => i).sort((a, b) => compareCodeUnits(terms[a] as string, terms[b] as string));
}

/** Postings d'un document en disposition compacte (voir DocumentSegment). */
export interface SegmentPostings {
  readonly terms: readonly string[];
  readonly offsets: Uint32Array;
  readonly pages: Uint32Array;
  readonly termFrequencies: Uint32Array;
}

function validateSegment(
  docId: string,
  pageLengths: Uint32Array,
  { terms, offsets, pages, termFrequencies }: SegmentPostings,
  pageCount: number,
): void {
  const fail = (detail: string): never => {
    throw new InvalidSegmentError(docId, detail);
  };
  if (!Number.isInteger(pageCount) || pageCount < 0 || pageCount > pageLengths.length) {
    fail(`pageCount=${pageCount} hors de [0, ${pageLengths.length}]`);
  }
  if (offsets.length !== terms.length + 1) fail(`offsets.length=${offsets.length}, attendu ${terms.length + 1}`);
  if (pages.length !== termFrequencies.length) {
    fail(`pages.length=${pages.length} différent de termFrequencies.length=${termFrequencies.length}`);
  }
  if (offsets[0] !== 0) fail(`offsets[0]=${offsets[0]}, attendu 0`);
  for (let i = 1; i < offsets.length; i++) {
    if ((offsets[i] as number) < (offsets[i - 1] as number)) fail(`offsets non croissants en ${i}`);
  }
  if (offsets[terms.length] !== pages.length) {
    fail(`dernier offset=${offsets[terms.length]}, attendu pages.length=${pages.length}`);
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as number;
    if (page < FIRST_PAGE || page > pageLengths.length) fail(`page ${page} hors de [${FIRST_PAGE}, ${pageLengths.length}]`);
  }
}

/** Remet les termes (et leurs postings) en ordre d'unités de code UTF-16 si besoin ; sinon renvoie l'entrée. */
function sortedPostings(postings: SegmentPostings): SegmentPostings | undefined {
  const order = codeUnitPermutation(postings.terms);
  if (!order) return undefined;
  const offsets = new Uint32Array(order.length + 1);
  const pages = new Uint32Array(postings.pages.length);
  const termFrequencies = new Uint32Array(postings.termFrequencies.length);
  let size = 0;
  order.forEach((source, target) => {
    const from = postings.offsets[source] as number;
    const to = postings.offsets[source + 1] as number;
    pages.set(postings.pages.subarray(from, to), size);
    termFrequencies.set(postings.termFrequencies.subarray(from, to), size);
    size += to - from;
    offsets[target + 1] = size;
  });
  return { terms: order.map((i) => postings.terms[i] as string), offsets, pages, termFrequencies };
}

function assembleSegment(
  docId: string,
  pageLengths: Uint32Array,
  postings: SegmentPostings,
  pageCount: number,
  owned: boolean,
): DocumentSegment {
  validateSegment(docId, pageLengths, postings, pageCount);
  let totalTokens = 0;
  for (const length of pageLengths) totalTokens += length;
  const reordered = sortedPostings(postings);
  // Un réordonnancement a déjà produit des tampons neufs ; sinon, copie sauf si l'appelant nous les cède.
  const kept = reordered ?? postings;
  const mustCopy = !owned && !reordered;
  return {
    docId,
    pageCount,
    totalTokens,
    pageLengths: mustCopy ? pageLengths.slice() : pageLengths,
    terms: kept.terms,
    offsets: mustCopy ? kept.offsets.slice() : kept.offsets,
    pages: mustCopy ? kept.pages.slice() : kept.pages,
    termFrequencies: mustCopy ? kept.termFrequencies.slice() : kept.termFrequencies,
  };
}

/**
 * Construit le segment d'un document. Les termes peuvent être dans n'importe quel ordre (le dictionnaire
 * `.dsx` est en ordre UTF-8, qui diffère de l'ordre UTF-16 pour les caractères astraux) : ils sont remis en
 * ordre d'unités de code si besoin. `pageLengths[p - 1]` = longueur de la page p.
 *
 * Les Uint32Array fournis sont copiés (le segment est immuable même si l'appelant réutilise ses tampons) ;
 * `terms` est conservé tel quel et ne doit pas être modifié. Les tampons d'entrée sont libérables ensuite.
 * @throws InvalidSegmentError si la disposition est incohérente (offsets, pages hors bornes, pageCount).
 */
export function makeSegment(
  docId: string,
  pageLengths: Uint32Array,
  postings: SegmentPostings,
  pageCount: number = pageLengths.length,
): DocumentSegment {
  return assembleSegment(docId, pageLengths, postings, pageCount, false);
}

/**
 * Comme `makeSegment`, mais l'appelant CÈDE ses Uint32Array (pageLengths, offsets, pages, termFrequencies) :
 * ils sont conservés sans copie et ne doivent plus être modifiés ni réutilisés (ex. sortie fraîche d'un décodage).
 * @throws InvalidSegmentError comme `makeSegment`.
 */
export function makeOwnedSegment(
  docId: string,
  pageLengths: Uint32Array,
  postings: SegmentPostings,
  pageCount: number = pageLengths.length,
): DocumentSegment {
  return assembleSegment(docId, pageLengths, postings, pageCount, true);
}

/**
 * Index regroupant des segments : N et avgdl en dérivent.
 * @throws DuplicateDocumentError si deux segments ont le même docId.
 */
export function indexOfSegments(segments: readonly DocumentSegment[]): Bm25Index {
  const seen = new Set<string>();
  let pageCount = 0;
  let totalTokens = 0;
  for (const segment of segments) {
    if (seen.has(segment.docId)) throw new DuplicateDocumentError(segment.docId);
    seen.add(segment.docId);
    pageCount += segment.pageCount;
    totalTokens += segment.totalTokens;
  }
  return { segments, pageCount, averagePageLength: pageCount === 0 ? 0 : totalTokens / pageCount };
}

interface DocumentDraft {
  readonly lengths: Map<number, number>;
  readonly terms: Map<string, { pages: number[]; tfs: number[] }>;
}

function addPage(draft: DocumentDraft, { docId, page, text }: PageInput): void {
  if (!Number.isInteger(page) || page < FIRST_PAGE || page > MAX_INDEXED_PAGE) {
    throw new RangeError(`Numéro de page invalide : docId=${docId} page=${page}`);
  }
  if (draft.lengths.has(page)) throw new DuplicatePageError(docId, page);
  const tokens = tokenize(text);
  draft.lengths.set(page, tokens.length);
  for (const [term, tf] of countTokens(tokens)) {
    const list = draft.terms.get(term);
    if (list) {
      list.pages.push(page);
      list.tfs.push(tf);
    } else draft.terms.set(term, { pages: [page], tfs: [tf] });
  }
}

function segmentOfDraft(docId: string, { lengths, terms }: DocumentDraft): DocumentSegment {
  let lastPage = 0;
  for (const page of lengths.keys()) lastPage = Math.max(lastPage, page);
  const pageLengths = new Uint32Array(lastPage);
  for (const [page, length] of lengths) pageLengths[page - FIRST_PAGE] = length;
  const names = [...terms.keys()].sort(compareCodeUnits);
  const offsets = new Uint32Array(names.length + 1);
  const total = [...terms.values()].reduce((sum, list) => sum + list.pages.length, 0);
  const pages = new Uint32Array(total);
  const termFrequencies = new Uint32Array(total);
  let size = 0;
  names.forEach((name, i) => {
    const list = terms.get(name) as { pages: number[]; tfs: number[] };
    pages.set(list.pages, size);
    termFrequencies.set(list.tfs, size);
    size += list.pages.length;
    offsets[i + 1] = size;
  });
  return assembleSegment(docId, pageLengths, { terms: names, offsets, pages, termFrequencies }, lengths.size, true);
}

/** @throws DuplicatePageError si un meme (docId, page) apparait deux fois. */
export function buildIndex(pages: readonly PageInput[]): Bm25Index {
  const drafts = new Map<string, DocumentDraft>();
  for (const input of pages) {
    let draft = drafts.get(input.docId);
    if (!draft) drafts.set(input.docId, (draft = { lengths: new Map(), terms: new Map() }));
    addPage(draft, input);
  }
  return indexOfSegments([...drafts].map(([docId, draft]) => segmentOfDraft(docId, draft)));
}

/** Vocabulaire global trié (unités de code), dédupliqué : pour les tests et outils, jamais stocké. */
export function vocabulary(index: Bm25Index): readonly string[] {
  const all = new Set<string>();
  for (const segment of index.segments) for (const term of segment.terms) all.add(term);
  return [...all].sort(compareCodeUnits);
}

/** Postings développés d'un terme exact, par segment puis par ordre de stockage : pour les tests et outils. */
export function postingsOf(index: Bm25Index, term: string): readonly Posting[] {
  const out: Posting[] = [];
  for (const segment of index.segments) {
    const at = lowerBound(segment.terms, term);
    if (segment.terms[at] !== term) continue;
    for (let i = segment.offsets[at] as number; i < (segment.offsets[at + 1] as number); i++) {
      out.push({ docId: segment.docId, page: segment.pages[i] as number, tf: segment.termFrequencies[i] as number });
    }
  }
  return out;
}

/** tf (pondéré par classe) cumulé par page, par segment, et nombre de pages distinctes (= df du mot). */
interface TermMatches {
  readonly size: number;
  /** idf du mot de la requête (df = pages appariées, toutes classes), calculé une fois : ne dépend que de N et de `size`. */
  readonly idf: number;
  /** Même longueur que index.segments ; undefined si le segment ne contient aucune page correspondante. */
  readonly tfBySegment: readonly (ReadonlyMap<number, number> | undefined)[];
}

/** Premier indice de `sorted` dont le terme est >= `prefix` (ordre des unites de code, coherent avec startsWith). */
function lowerBound(sorted: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Cumule dans `tfByPage` les postings du segment pour les termes qui correspondent à la règle, tf pondéré par la
 * classe de correspondance. Sans sous-chaîne, les correspondances forment un intervalle contigu des termes triés
 * (exact, puis préfixe) : dichotomie puis arrêt au premier terme hors règle. Avec sous-chaîne, parcours linéaire.
 */
function accumulateSegment(segment: DocumentSegment, rule: QueryWordRule, tfByPage: Map<number, number>): void {
  const scanAll = rule.allowSubstring;
  const first = scanAll ? 0 : lowerBound(segment.terms, rule.word);
  for (let t = first; t < segment.terms.length; t++) {
    const matchClass = classifyTerm(segment.terms[t] as string, rule);
    if (matchClass === MatchClass.None) {
      if (scanAll) continue;
      break;
    }
    const weight = MATCH_WEIGHT[matchClass];
    for (let i = segment.offsets[t] as number; i < (segment.offsets[t + 1] as number); i++) {
      const page = segment.pages[i] as number;
      tfByPage.set(page, (tfByPage.get(page) ?? 0) + weight * (segment.termFrequencies[i] as number));
    }
  }
}

/** Postings pondérés d'un mot de la requête (tf sommé par page) ; df = pages ayant au moins un terme apparié. */
function collectPostings(index: Bm25Index, rule: QueryWordRule): TermMatches {
  let size = 0;
  const tfBySegment = index.segments.map((segment) => {
    const tfByPage = new Map<number, number>();
    accumulateSegment(segment, rule, tfByPage);
    size += tfByPage.size;
    return tfByPage.size === 0 ? undefined : tfByPage;
  });
  return { size, idf: idf(index.pageCount, size), tfBySegment };
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

function scorePage(index: Bm25Index, perTerm: readonly TermMatches[], segmentIndex: number, page: number): number {
  const pageLength = index.segments[segmentIndex]?.pageLengths[page - FIRST_PAGE] ?? 0;
  let score = 0;
  for (const matches of perTerm) {
    const tf = matches.tfBySegment[segmentIndex]?.get(page) ?? 0;
    score += termScore({ tf, pageLength, avgPageLength: index.averagePageLength, idf: matches.idf });
  }
  return score;
}

/**
 * Recherche ET multi-mots. Chaque mot accepte l'exact, la sous-chaîne (3 caractères minimum) et, pour le dernier
 * seulement, le préfixe (voir termMatch.ts). Le classement exact > préfixe > sous-chaîne vient de la pondération du tf.
 */
export function searchPages(index: Bm25Index, query: string): readonly PageHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || index.pageCount === 0) return [];
  const perTerm = queryWordRules(terms).map((rule) => collectPostings(index, rule));
  const [first, ...rest] = perTerm;
  if (!first) return [];
  const hits: PageHit[] = [];
  first.tfBySegment.forEach((pages, segmentIndex) => {
    if (!pages) return;
    const docId = index.segments[segmentIndex]?.docId ?? "";
    for (const page of pages.keys()) {
      if (!rest.every((m) => m.tfBySegment[segmentIndex]?.has(page))) continue;
      hits.push({ docId, page, score: scorePage(index, perTerm, segmentIndex, page) });
    }
  });
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
    pages: sorted.slice(0, MAX_EXPANDED_PAGES),
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
