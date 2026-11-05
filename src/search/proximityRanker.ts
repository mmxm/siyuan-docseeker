/**
 * Reclassement par proximité des mots (bonus multi-mots de DocSeeker) : orchestre, pour une requête à au moins
 * deux mots, la mesure de la proximité sur les premières pages de chaque document, par fenêtres de
 * RERANK_WINDOW documents. La fenêtre 1 est rendue en premier ; les suivantes (jusqu'à RERANK_MAX_DOCS
 * documents) sont calculées en tâche de fond et notifiées via `onWindow`. Aucune dépendance au DOM.
 */
import type { PageMatch } from "../core/codec/decode";
import { PROXIMITY_PAGES, RERANK_WINDOW } from "../core/constants";
import { tokenize } from "../core/normalize";
import { groupOccurrences, multiTermBonus, orderTopPages, rerankWindows } from "./proximity";

/** Nombre maximal de documents reclassés (fenêtres successives de RERANK_WINDOW). */
export const RERANK_MAX_DOCS = 60;
/** Documents mesurés en parallèle (le service garde peu de fichiers .dsx en mémoire). */
const DOC_CONCURRENCY = 2;

export interface RankableDoc {
  readonly docId: string;
  readonly title: string;
  /** Score de base (BM25 + bonus de titre) ; le bonus de proximité s'y ajoute. */
  readonly relevance: number;
  /** Meilleures pages (score élevé = meilleur). */
  readonly pages: readonly { readonly page: number; readonly score: number }[];
}

export interface ProximityResult<T extends RankableDoc = RankableDoc> {
  /** Tous les documents d'entrée : ceux déjà mesurés reclassés, les autres dans leur ordre d'origine. */
  readonly docs: readonly T[];
  /** Ordre des pages (toutes celles mesurées du document) par docId. Absent : ordre BM25 d'origine. */
  readonly pagesOrderByDoc: ReadonlyMap<string, readonly number[]>;
  /** Bonus multi-mots par docId (0 si la mesure a échoué). Absent : document non mesuré. */
  readonly bonusByDoc: ReadonlyMap<string, number>;
  /** Documents dont la mesure a échoué (bonus 0, ordre BM25 conservé) : à ne pas compter comme mesurés. */
  readonly failedDocIds: ReadonlySet<string>;
}

export interface ProximityRankOptions<T extends RankableDoc = RankableDoc> {
  readonly signal?: AbortSignal;
  /** Appelé (état cumulé) après chaque fenêtre suivant la première ; jamais après une annulation. */
  readonly onWindow?: (result: ProximityResult<T>) => void;
}

export interface ProximityRanker {
  /**
   * Résout après la fenêtre 1 (rejette avec une AbortError si `signal` est annulé). `done` se résout quand
   * les fenêtres suivantes sont terminées ou interrompues ; il ne rejette jamais.
   */
  rank<T extends RankableDoc>(
    query: string,
    docs: readonly T[],
    options: ProximityRankOptions<T>,
  ): Promise<ProximityResult<T> & { readonly done: Promise<void> }>;
  /** Oublie les mesures d'un document réindexé (y compris celle qui serait en cours de calcul). */
  invalidate(docId: string): void;
}

export interface ProximityRankerDeps {
  /** Correspondances de plusieurs pages d'un document en un seul décodage. */
  readonly getPagesMatches: (
    docId: string,
    pages: readonly number[],
    query: string,
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<number, PageMatch>>;
  /** Appelé une fois par re-classement pour ses échecs de mesure, et pour toute autre anomalie (jamais silencieux). */
  readonly onWarn?: (message: string, error?: unknown) => void;
}

interface DocProximity {
  readonly bonus: number;
  readonly pagesOrder: readonly number[];
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Mesure la proximité d'un document : bonus multi-mots et ordre de ses pages. */
async function measureDoc(
  doc: RankableDoc,
  query: string,
  termCount: number,
  deps: ProximityRankerDeps,
  signal: AbortSignal | undefined,
): Promise<DocProximity> {
  const pages = doc.pages.slice(0, PROXIMITY_PAGES);
  const distinctByPage = new Map<number, number>();
  if (signal?.aborted) throw abortError();
  const matches = await deps.getPagesMatches(
    doc.docId,
    pages.map((p) => p.page),
    query,
    signal,
  );
  for (const { page } of pages) {
    const match = matches.get(page);
    if (!match) throw new Error(`Page ${page} of ${doc.docId} missing from the decoded pages`);
    const termIndexes = match.termIndexes;
    if (!termIndexes) throw new Error(`Page ${page} of ${doc.docId} carries no term indexes`);
    const occurrences = groupOccurrences(match.boxes, match.ordinals, termIndexes);
    distinctByPage.set(page, Math.max(0, ...occurrences.map((o) => o.distinct)));
  }
  const maxDistinct = Math.max(0, ...distinctByPage.values());
  return {
    bonus: multiTermBonus(maxDistinct, termCount),
    pagesOrder: orderTopPages(pages, distinctByPage).map((p) => p.page),
  };
}

export function createProximityRanker(deps: ProximityRankerDeps): ProximityRanker {
  // Cache de la dernière requête seulement : clé = docId + pages mesurées.
  let cacheQuery = "";
  let cache = new Map<string, DocProximity>();
  // Génération par document : une mesure démarrée avant `invalidate` n'est jamais mise en cache.
  const generations = new Map<string, number>();
  const generationOf = (docId: string): number => generations.get(docId) ?? 0;

  async function rank<T extends RankableDoc>(
    query: string,
    docs: readonly T[],
    options: ProximityRankOptions<T>,
  ): Promise<ProximityResult<T> & { readonly done: Promise<void> }> {
    const { signal, onWindow } = options;
    const words = [...new Set(tokenize(query))];
    const empty = {
      docs,
      pagesOrderByDoc: new Map<string, readonly number[]>(),
      bonusByDoc: new Map<string, number>(),
      failedDocIds: new Set<string>(),
    };
    if (words.length < 2 || docs.length === 0) return { ...empty, done: Promise.resolve() };
    if (signal?.aborted) throw abortError();

    const queryKey = words.join(" ");
    if (queryKey !== cacheQuery) {
      cacheQuery = queryKey;
      cache = new Map();
      generations.clear(); // les mesures de l'ancienne requête sont orphelines : plus rien à protéger
    }
    const activeCache = cache;
    const bonusByDoc = new Map<string, number>();
    const pagesOrderByDoc = new Map<string, readonly number[]>();
    const failures: { docId: string; error: unknown }[] = [];
    const failedDocIds = new Set<string>();
    const limit = Math.min(docs.length, RERANK_MAX_DOCS);

    async function measureOne(doc: T): Promise<void> {
      const key = JSON.stringify([doc.docId, doc.pages.slice(0, PROXIMITY_PAGES).map((p) => p.page)]);
      let measured = activeCache.get(key);
      if (!measured) {
        const generation = generationOf(doc.docId);
        try {
          measured = await measureDoc(doc, query, words.length, deps, signal);
          if (generationOf(doc.docId) === generation) activeCache.set(key, measured);
        } catch (error) {
          if (signal?.aborted) throw abortError();
          failures.push({ docId: doc.docId, error });
          failedDocIds.add(doc.docId);
          measured = { bonus: 0, pagesOrder: doc.pages.map((p) => p.page) };
        }
      }
      bonusByDoc.set(doc.docId, measured.bonus);
      pagesOrderByDoc.set(doc.docId, measured.pagesOrder);
    }

    async function processWindow(start: number, end: number): Promise<void> {
      let next = start;
      const worker = async (): Promise<void> => {
        while (next < end) {
          if (signal?.aborted) throw abortError();
          const doc = docs[next++] as T;
          await measureOne(doc);
        }
      };
      await Promise.all(Array.from({ length: Math.min(DOC_CONCURRENCY, end - start) }, worker));
      if (signal?.aborted) throw abortError();
    }

    const snapshot = (processed: number): ProximityResult<T> => ({
      docs: [...rerankWindows(docs.slice(0, processed), bonusByDoc, RERANK_WINDOW), ...docs.slice(processed)],
      pagesOrderByDoc: new Map(pagesOrderByDoc),
      bonusByDoc: new Map(bonusByDoc),
      failedDocIds: new Set(failedDocIds),
    });
    /** Un seul avertissement par re-classement : nombre de documents en échec et détail du premier. */
    const reportFailures = (): void => {
      const first = failures[0];
      if (!first || signal?.aborted) return;
      deps.onWarn?.(
        `Proximity measure failed for ${failures.length} document(s) (first: ${first.docId}); BM25 order kept`,
        first.error,
      );
    };

    const firstEnd = Math.min(RERANK_WINDOW, limit);
    await processWindow(0, firstEnd);
    const first = snapshot(firstEnd);

    const background = async (): Promise<void> => {
      for (let start = firstEnd; start < limit; start += RERANK_WINDOW) {
        const end = Math.min(start + RERANK_WINDOW, limit);
        await processWindow(start, end);
        try {
          onWindow?.(snapshot(end));
        } catch (error) {
          // Une erreur du consommateur n'est pas une erreur de mesure et n'interrompt pas les fenêtres suivantes.
          deps.onWarn?.("Proximity onWindow callback failed", error);
        }
      }
    };
    const done = background()
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        deps.onWarn?.("Proximity background reranking failed", error);
      })
      .finally(reportFailures);
    if (limit <= firstEnd) await done;
    return { ...first, done };
  }

  function invalidate(docId: string): void {
    generations.set(docId, generationOf(docId) + 1);
    for (const key of [...cache.keys()]) if ((JSON.parse(key) as [string])[0] === docId) cache.delete(key);
  }

  return { rank, invalidate };
}
