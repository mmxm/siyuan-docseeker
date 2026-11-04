/**
 * Pont entre les index par PDF (`DocumentIndex` ou `SearchIndexData`, décodés depuis les `.dsx`) et l'index
 * BM25 global.
 *
 * L'index global est une liste de segments, un par document, en tableaux typés (voir `DocumentSegment`) :
 * on ne fusionne ni vocabulaire global ni listes de postings, ce qui évite des millions d'objets et de
 * clés chaînes. La recherche interroge chaque segment (recherche dichotomique, O(D log T)).
 *
 * Complexité (D documents, Q postings, t/q/p = termes/postings/pages du document touché) :
 *  - toBm25Index          : O(Q) copie des postings d'entrée en tableaux typés (O(1) si l'entrée est déjà compacte).
 *  - withDocument/Without : O(D) pour la copie de la liste de segments, plus O(q + t) pour le nouveau segment ;
 *                           les autres segments sont partagés (immuables).
 *
 * Limite : l'ordre des termes d'un segment est celui des unités de code UTF-16 (comme buildIndex), alors que
 * le dictionnaire .dsx est en ordre UTF-8 ; un document dont les termes ne sont pas déjà dans cet ordre est
 * réordonné (O(t log t), cas rare : caractères astraux).
 */
import {
  DuplicateDocumentError,
  indexOfSegments,
  makeOwnedSegment,
  makeSegment,
  type Bm25Index,
  type DocumentSegment,
} from "./bm25";
import { toUint32Lengths, type DocumentIndex, type SearchIndexData } from "./codec/format";

export { DuplicateDocumentError };

/**
 * Partie d'un index par PDF utilisée ici (les boîtes ne servent jamais) : soit la forme complète à objets
 * (`DocumentIndex`, tests/outils), soit la forme compacte de `decodeIndexForSearch`.
 */
export type SearchableDocumentIndex =
  | Pick<DocumentIndex, "terms" | "pageTermCounts">
  | Pick<SearchIndexData, "postings" | "pageTermCounts">;

export interface NamedDocumentIndex {
  readonly docId: string;
  readonly index: SearchableDocumentIndex;
}

function compactPostings(docId: string, index: Pick<DocumentIndex, "terms">): Pick<SearchIndexData, "postings">["postings"] {
  const terms = index.terms.map((entry) => entry.term);
  const offsets = new Uint32Array(terms.length + 1);
  let total = 0;
  index.terms.forEach((entry, i) => {
    total += entry.postings.length;
    offsets[i + 1] = total;
  });
  const pages = new Array<number>(total);
  const frequencies = new Array<number>(total);
  let at = 0;
  for (const entry of index.terms) {
    for (const posting of entry.postings) {
      pages[at] = posting.page;
      frequencies[at] = posting.termFrequency;
      at++;
    }
  }
  return {
    terms,
    offsets,
    pages: toUint32Lengths(pages, `${docId} : page`),
    termFrequencies: toUint32Lengths(frequencies, `${docId} : termFrequency`),
  };
}

function toSegment(docId: string, index: SearchableDocumentIndex, owned = false): DocumentSegment {
  const postings = "postings" in index ? index.postings : compactPostings(docId, index);
  const counts = index.pageTermCounts;
  const pageLengths = counts instanceof Uint32Array ? counts : toUint32Lengths(counts, `${docId} : pageTermCounts`);
  return (owned ? makeOwnedSegment : makeSegment)(docId, pageLengths, postings);
}

/** @throws DuplicateDocumentError si un docId apparait deux fois. */
export function toBm25Index(documents: readonly NamedDocumentIndex[]): Bm25Index {
  return indexOfSegments(documents.map(({ docId, index }) => toSegment(docId, index)));
}

/**
 * Ajoute `docId`, ou le remplace s'il existe deja. Retourne un nouvel index ; `index` est inchange.
 * `owned: true` : l'appelant cède les tableaux typés de `documentIndex` (forme compacte), conservés sans copie.
 */
export function withDocument(
  index: Bm25Index,
  docId: string,
  documentIndex: SearchableDocumentIndex,
  options?: { readonly owned?: boolean },
): Bm25Index {
  const segments = index.segments.filter((segment) => segment.docId !== docId);
  segments.push(toSegment(docId, documentIndex, options?.owned === true));
  return indexOfSegments(segments);
}

/** Retire `docId` (sans effet s'il est absent, mais retourne quand meme un nouvel objet). */
export function withoutDocument(index: Bm25Index, docId: string): Bm25Index {
  return indexOfSegments(index.segments.filter((segment) => segment.docId !== docId));
}
