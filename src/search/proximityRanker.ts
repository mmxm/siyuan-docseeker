/**
 * Reclassement de DocSeeker (proximité des mots et taille de police) : orchestre, pour toute requête (un mot
 * compris : le bonus de police s'applique aussi), la mesure sur les premières pages de chaque document, par fenêtres de
 * RERANK_WINDOW documents. La fenêtre 1 est rendue en premier ; les suivantes (jusqu'à RERANK_MAX_DOCS
 * documents) sont calculées en tâche de fond et notifiées via `onWindow`. Aucune dépendance au DOM.
 */
import type { PageMatch } from "../core/codec/decode";
import { PROXIMITY_PAGES, RERANK_WINDOW } from "../core/constants";
import { tokenize } from "../core/normalize";
import {
  fontBonus,
  groupOccurrences,
  multiTermBonus,
  orderTopPages,
  pageStats,
  rerankWindows,
  type PageStats,
} from "./proximity";

/** Nombre maximal de documents reclassés (fenêtres successives de RERANK_WINDOW). */
export const RERANK_MAX_DOCS = 60;
/** Documents mesurés en parallèle : 1, le décodage est du CPU sur un seul fil (le parallélisme n'apporte rien). */
const DOC_CONCURRENCY = 1;

/** Cède la main au fil principal (scheduler.yield si disponible, sinon une macro-tâche). */
function defaultYieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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
  /** Bonus (multi-mots + police) par docId (0 si la mesure a échoué). Absent : document non mesuré. */
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
  /** Cède la main au fil principal entre deux documents mesurés (injectable : tests déterministes). */
  readonly yieldToMain?: () => Promise<void>;
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

/**
 * Mesure la proximité d'un document : bonus multi-mots et ordre de ses pages.
 * Périmètre : les PROXIMITY_PAGES (5) premières pages BM25 du document seulement. Divergence documentée avec le
 * moteur Rust, qui mesure toutes les occurrences du document (le bonus de police ou de proximité d'une page
 * au-delà de la 5e meilleure n'est pas vu ici).
 */
async function measureDoc(
  doc: RankableDoc,
  query: string,
  termCount: number,
  deps: ProximityRankerDeps,
  signal: AbortSignal | undefined,
): Promise<DocProximity> {
  const pages = doc.pages.slice(0, PROXIMITY_PAGES);
  const statsByPage = new Map<number, PageStats>();
  let bestFontPt = 0;
  let maxDistinct = 0;
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
    const occurrences = groupOccurrences(match.boxes, match.ordinals, termIndexes, match.pageSize);
    const stats = pageStats(occurrences);
    statsByPage.set(page, stats);
    maxDistinct = Math.max(maxDistinct, stats.distinct);
    for (const o of occurrences) bestFontPt = Math.max(bestFontPt, o.fontSizePt);
  }
  return {
    bonus: multiTermBonus(maxDistinct, termCount) + fontBonus(bestFontPt),
    pagesOrder: orderTopPages(pages, statsByPage).map((p) => p.page),
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
    if (words.length < 1 || docs.length === 0) return { ...empty, done: Promise.resolve() };
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
    const yieldToMain = deps.yieldToMain ?? defaultYieldToMain;
    let measuredCount = 0;

    async function measureOne(doc: T): Promise<void> {
      const key = JSON.stringify([doc.docId, doc.pages.slice(0, PROXIMITY_PAGES).map((p) => p.page)]);
      let measured = activeCache.get(key);
      if (!measured) {
        try {
          // Entre deux décodages : laisse l'interface respirer (pas avant le premier, pas pour un résultat en cache).
          // Dans le try : un rejet de yieldToMain est un échec de mesure de CE document, sans perdre les suivants.
          // `measuredCount` (partagé) n'est correct que pour DOC_CONCURRENCY === 1 : avec plusieurs workers, le
          // « premier » document ne serait plus forcément le premier à décoder.
          if (measuredCount++ > 0) {
            await yieldToMain();
            if (signal?.aborted) throw abortError();
          }
          const generation = generationOf(doc.docId);
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
