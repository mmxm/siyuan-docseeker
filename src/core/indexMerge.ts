/**
 * Pont entre les index par PDF (`DocumentIndex`, decodes depuis les `.dsx`) et l'index BM25 global.
 *
 * Complexite (D documents, T = somme des termes distincts par document, V = vocabulaire global,
 * Pg = pages totales, Q = postings totaux, t/q/p = termes/postings/pages du document touche) :
 *  - toBm25Index          : O(Q + T log D + Pg). Les termes de chaque document sont deja tries : la
 *                           liste triee globale vient d'une fusion equilibree (log D niveaux), jamais d'un tri global.
 *  - withDocument/Without : O(V + Pg + D) pour la copie des Map (immutabilite : le nouvel index ne partage
 *                           aucune Map mutable), plus O(t + postings des termes touches) et une fusion
 *                           O(V + t) de sortedTerms (aucun tri global). Si l'index vient de buildIndex (sans
 *                           metadonnees), la premiere suppression/remplacement coute en plus O(Q + Pg) (scan).
 *
 * Limite : l'ordre des termes de sortedTerms est celui de buildIndex (unites de code UTF-16), alors que le
 * dictionnaire .dsx est en ordre UTF-8 ; un document dont les termes ne sont pas deja en ordre UTF-16 est retrie
 * (O(t log t), cas rare : caracteres astraux).
 */
import { pageKey, type Bm25Index, type Posting } from "./bm25";
import type { DocumentIndex, TermEntry } from "./codec/format";

const FIRST_PAGE = 1;
const KEY_SEPARATOR_CODE = "\u0000";

/** Meme docId fourni deux fois a `toBm25Index`. */
export class DuplicateDocumentError extends Error {
  readonly docId: string;

  constructor(docId: string) {
    super(`Document en double dans l'index BM25 : docId=${docId}`);
    this.name = "DuplicateDocumentError";
    this.docId = docId;
  }
}

/** Partie d'un `DocumentIndex` utilisee ici : les boites ne servent jamais (index "pour la recherche"). */
export type SearchableDocumentIndex = Pick<DocumentIndex, "terms" | "pageTermCounts">;

export interface NamedDocumentIndex {
  readonly docId: string;
  readonly index: SearchableDocumentIndex;
}

/** Ce qu'il faut savoir d'un document pour le retirer sans rescanner tout l'index. */
interface DocMeta {
  readonly terms: readonly string[];
  readonly pages: number;
  readonly tokens: number;
}

/**
 * Cle des metadonnees sur l'index. Propriete ENUMERABLE a cle Symbol : `{ ...index }` la copie (une propriete
 * non enumerable serait perdue par le spread). Ni JSON.stringify ni Object.keys ne la voient.
 */
const META_KEY: unique symbol = Symbol("docseeker.indexMerge.meta");

type WithMeta = Bm25Index & { readonly [META_KEY]?: ReadonlyMap<string, DocMeta> };

/** Metadonnees derivees par scan pour des index externes (non mutes), memoisees par identite. */
const DERIVED_META = new WeakMap<Bm25Index, ReadonlyMap<string, DocMeta>>();

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Entrees triees en unites de code UTF-16 (ordre de buildIndex) ; verification lineaire, tri seulement si besoin. */
function inCodeUnitOrder(entries: readonly TermEntry[]): readonly TermEntry[] {
  for (let i = 1; i < entries.length; i++) {
    if ((entries[i - 1]?.term ?? "") >= (entries[i]?.term ?? "")) {
      return [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    }
  }
  return entries;
}

function toPostings(docId: string, entry: TermEntry): Posting[] {
  return entry.postings.map((p) => ({ docId, page: p.page, tf: p.termFrequency }));
}

/** Union triee dedupliquee de deux listes triees : O(a + b). */
function mergeSorted(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x < y)) {
      out.push(x as string);
      i++;
    } else if (x === undefined || y < x) {
      out.push(y);
      j++;
    } else {
      out.push(x);
      i++;
      j++;
    }
  }
  return out;
}

/** Fusion equilibree de listes triees : O(T log k). */
function mergeAll(lists: readonly (readonly string[])[]): readonly string[] {
  let level = lists;
  while (level.length > 1) {
    const next: string[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(mergeSorted(level[i] ?? [], level[i + 1] ?? []));
    }
    level = next;
  }
  return level[0] ?? [];
}

function assemble(
  postings: ReadonlyMap<string, readonly Posting[]>,
  sortedTerms: readonly string[],
  pageLengths: ReadonlyMap<string, number>,
  docs: ReadonlyMap<string, DocMeta>,
): Bm25Index {
  let totalTokens = 0;
  let pageCount = 0;
  for (const meta of docs.values()) {
    totalTokens += meta.tokens;
    pageCount += meta.pages;
  }
  const index: WithMeta = {
    postings,
    sortedTerms,
    pageLengths,
    pageCount,
    averagePageLength: pageCount === 0 ? 0 : totalTokens / pageCount,
    [META_KEY]: docs,
  };
  return index;
}

function addPageLengths(target: Map<string, number>, docId: string, counts: readonly number[]): void {
  counts.forEach((count, i) => target.set(pageKey(docId, i + FIRST_PAGE), count));
}

/** @throws DuplicateDocumentError si un docId apparait deux fois. */
export function toBm25Index(documents: readonly NamedDocumentIndex[]): Bm25Index {
  const postings = new Map<string, Posting[]>();
  const pageLengths = new Map<string, number>();
  const docs = new Map<string, DocMeta>();
  const termLists: (readonly string[])[] = [];
  for (const { docId, index } of documents) {
    if (docs.has(docId)) throw new DuplicateDocumentError(docId);
    const entries = inCodeUnitOrder(index.terms);
    for (const entry of entries) {
      const list = postings.get(entry.term);
      if (list) list.push(...toPostings(docId, entry));
      else postings.set(entry.term, toPostings(docId, entry));
    }
    const terms = entries.map((e) => e.term);
    termLists.push(terms);
    addPageLengths(pageLengths, docId, index.pageTermCounts);
    docs.set(docId, { terms, pages: index.pageTermCounts.length, tokens: sum(index.pageTermCounts) });
  }
  return assemble(postings, mergeAll(termLists), pageLengths, docs);
}

/** Reconstitue les metadonnees d'un index non produit par ce module (scan, O(Q + Pg)). */
function deriveMeta(index: Bm25Index): ReadonlyMap<string, DocMeta> {
  const termsByDoc = new Map<string, string[]>();
  for (const term of index.sortedTerms) {
    const seen = new Set<string>();
    for (const { docId } of index.postings.get(term) ?? []) {
      if (seen.has(docId)) continue;
      seen.add(docId);
      const list = termsByDoc.get(docId);
      if (list) list.push(term);
      else termsByDoc.set(docId, [term]);
    }
  }
  const stats = new Map<string, { pages: number; tokens: number }>();
  for (const [key, length] of index.pageLengths) {
    const docId = key.slice(0, key.lastIndexOf(KEY_SEPARATOR_CODE));
    const current = stats.get(docId) ?? { pages: 0, tokens: 0 };
    stats.set(docId, { pages: current.pages + 1, tokens: current.tokens + length });
  }
  const docs = new Map<string, DocMeta>();
  for (const [docId, { pages, tokens }] of stats) docs.set(docId, { terms: termsByDoc.get(docId) ?? [], pages, tokens });
  return docs;
}

function metaOf(index: Bm25Index): ReadonlyMap<string, DocMeta> {
  const known = (index as WithMeta)[META_KEY] ?? DERIVED_META.get(index);
  if (known) return known;
  const derived = deriveMeta(index);
  DERIVED_META.set(index, derived);
  return derived;
}

function removeFromPostings(postings: Map<string, readonly Posting[]>, pageLengths: Map<string, number>, docId: string, meta: DocMeta): void {
  for (const term of meta.terms) {
    const kept = (postings.get(term) ?? []).filter((p) => p.docId !== docId);
    if (kept.length === 0) postings.delete(term);
    else postings.set(term, kept);
  }
  for (let page = FIRST_PAGE; page < FIRST_PAGE + meta.pages; page++) pageLengths.delete(pageKey(docId, page));
}

function sortedTermsAfter(
  previous: Bm25Index,
  postings: ReadonlyMap<string, readonly Posting[]>,
  added: readonly string[],
): readonly string[] {
  const newTerms = added.filter((term) => !previous.postings.has(term));
  const dropped = previous.sortedTerms.some((term) => !postings.has(term));
  if (!dropped && newTerms.length === 0) return previous.sortedTerms;
  const kept = dropped ? previous.sortedTerms.filter((term) => postings.has(term)) : previous.sortedTerms;
  return mergeSorted(kept, newTerms);
}

function update(index: Bm25Index, docId: string, added?: SearchableDocumentIndex): Bm25Index {
  const metas = metaOf(index);
  const postings = new Map(index.postings);
  const pageLengths = new Map(index.pageLengths);
  const docs = new Map(metas);
  const old = metas.get(docId);
  if (old) removeFromPostings(postings, pageLengths, docId, old);
  docs.delete(docId);
  let addedTerms: readonly string[] = [];
  if (added) {
    const entries = inCodeUnitOrder(added.terms);
    for (const entry of entries) postings.set(entry.term, [...(postings.get(entry.term) ?? []), ...toPostings(docId, entry)]);
    addedTerms = entries.map((e) => e.term);
    addPageLengths(pageLengths, docId, added.pageTermCounts);
    docs.set(docId, { terms: addedTerms, pages: added.pageTermCounts.length, tokens: sum(added.pageTermCounts) });
  }
  return assemble(postings, sortedTermsAfter(index, postings, addedTerms), pageLengths, docs);
}

/** Ajoute `docId`, ou le remplace s'il existe deja. Retourne un nouvel index ; `index` est inchange. */
export function withDocument(index: Bm25Index, docId: string, documentIndex: SearchableDocumentIndex): Bm25Index {
  return update(index, docId, documentIndex);
}

/** Retire `docId` (sans effet s'il est absent, mais retourne quand meme un nouvel objet). */
export function withoutDocument(index: Bm25Index, docId: string): Bm25Index {
  return update(index, docId);
}
