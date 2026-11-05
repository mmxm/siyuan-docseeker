/**
 * Service de correspondances par page : lit le .dsx d'un document (LRU d'octets),
 * décode une page pour une requête (LRU de résultats) et mutualise les appels en vol.
 * L'annulation d'un demandeur n'interrompt jamais le travail partagé.
 */
import { decodePageMatches, decodePagesMatches, type PageMatch } from "../core/codec/decode";
import { tokenize } from "../core/normalize";
import { makeTermIndexer, makeTermMatcher } from "./queryMatch";

export interface PageMatchServiceOptions {
  readonly readDsx: (docId: string) => Promise<Uint8Array>;
  readonly decode?: typeof decodePageMatches;
  /**
   * Décodeur multi-pages (une seule passe sur le fichier). Défaut : le vrai décodeur quand `decode` est celui
   * par défaut, sinon repli page par page sur `decode` (injection de test ou de substitution).
   */
  readonly decodePages?: typeof decodePagesMatches;
  /** Plafond cumulé d'octets des fichiers conservés (au moins le dernier est gardé). */
  readonly maxBytesFiles?: number;
  readonly maxPages?: number;
}

export interface PageMatchService {
  getPageMatches(docId: string, page: number, query: string, signal?: AbortSignal): Promise<PageMatch>;
  /** Plusieurs pages en une lecture du .dsx et un seul décodage ; remplit le cache page par page. */
  getPagesMatches(
    docId: string,
    pages: readonly number[],
    query: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, PageMatch>>;
  invalidate(docId: string): void;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_PAGES = 200;

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Attend `promise` mais rejette dès que `signal` est annulé (sans toucher à `promise`). */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createPageMatchService(options: PageMatchServiceOptions): PageMatchService {
  const { readDsx } = options;
  const decode = options.decode ?? decodePageMatches;
  const decodePages: typeof decodePagesMatches =
    options.decodePages ??
    (options.decode === undefined
      ? decodePagesMatches
      : async (bytes, pages, wanted, limits, termIndexOf) => {
          const out = new Map<number, PageMatch>();
          for (const page of new Set(pages)) out.set(page, await decode(bytes, page, wanted, limits, termIndexOf));
          return out;
        });
  const maxBytes = options.maxBytesFiles ?? DEFAULT_MAX_BYTES;
  const maxFiles = DEFAULT_MAX_FILES;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

  const files = new Map<string, Uint8Array>(); // ordre d'insertion = ancienneté
  const results = new Map<string, PageMatch>();
  const filesInFlight = new Map<string, Promise<Uint8Array>>();
  const resultsInFlight = new Map<string, Promise<PageMatch>>();
  const generations = new Map<string, number>();

  const generationOf = (docId: string): number => generations.get(docId) ?? 0;
  // docId peut contenir n'importe quoi : JSON évite toute collision de séparateur.
  const resultKey = (docId: string, page: number, query: string): string => JSON.stringify([docId, page, query]);
  const docOfKey = (key: string): string => (JSON.parse(key) as [string])[0];

  function storeFile(docId: string, bytes: Uint8Array): void {
    files.delete(docId);
    files.set(docId, bytes);
    let total = 0;
    for (const b of files.values()) total += b.byteLength;
    for (const id of files.keys()) {
      if ((files.size <= maxFiles && total <= maxBytes) || files.size <= 1) break;
      total -= files.get(id)?.byteLength ?? 0;
      files.delete(id);
    }
  }

  function loadFile(docId: string): Promise<Uint8Array> {
    const cached = files.get(docId);
    if (cached) {
      storeFile(docId, cached); // rafraîchit la récence
      return Promise.resolve(cached);
    }
    const pending = filesInFlight.get(docId);
    if (pending) return pending;
    const generation = generationOf(docId);
    const promise = readDsx(docId)
      .then((bytes) => {
        if (generationOf(docId) === generation) storeFile(docId, bytes);
        return bytes;
      })
      .finally(() => {
        if (filesInFlight.get(docId) === promise) filesInFlight.delete(docId);
      });
    filesInFlight.set(docId, promise);
    return promise;
  }

  function storeResult(key: string, value: PageMatch): void {
    results.delete(key);
    results.set(key, value);
    while (results.size > maxPages) {
      const oldest = results.keys().next();
      if (oldest.done) break;
      results.delete(oldest.value);
    }
  }

  function compute(docId: string, page: number, query: string, key: string): Promise<PageMatch> {
    const generation = generationOf(docId);
    const promise = loadFile(docId)
      .then((bytes) => decode(bytes, page, makeTermMatcher(query), undefined, makeTermIndexer(query)))
      .then((match) => {
        if (generationOf(docId) === generation) storeResult(key, match);
        return match;
      })
      .finally(() => {
        if (resultsInFlight.get(key) === promise) resultsInFlight.delete(key);
      });
    resultsInFlight.set(key, promise);
    return promise;
  }

  /** Un décodage pour toutes les pages demandées ; chaque page est enregistrée comme appel en vol. */
  function computeMany(docId: string, pages: readonly number[], query: string, normalized: string): Map<number, Promise<PageMatch>> {
    const generation = generationOf(docId);
    const batch = loadFile(docId)
      .then((bytes) => decodePages(bytes, pages, makeTermMatcher(query), undefined, makeTermIndexer(query)))
      .then((matches) => {
        if (generationOf(docId) === generation) {
          for (const page of pages) {
            const match = matches.get(page);
            if (match) storeResult(resultKey(docId, page, normalized), match);
          }
        }
        return matches;
      });
    const out = new Map<number, Promise<PageMatch>>();
    for (const page of pages) {
      const key = resultKey(docId, page, normalized);
      const promise: Promise<PageMatch> = batch
        .then((matches) => {
          const match = matches.get(page);
          if (!match) throw new Error(`Page ${page} of ${docId} missing from the decoded batch`);
          return match;
        })
        .finally(() => {
          if (resultsInFlight.get(key) === promise) resultsInFlight.delete(key);
        });
      resultsInFlight.set(key, promise);
      out.set(page, promise);
    }
    return out;
  }

  return {
    getPagesMatches(docId, pages, query, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      const normalized = tokenize(query).join(" ");
      const wanted = [...new Set(pages)];
      const found = new Map<number, Promise<PageMatch>>();
      const missing: number[] = [];
      for (const page of wanted) {
        const key = resultKey(docId, page, normalized);
        const cached = results.get(key);
        if (cached) {
          storeResult(key, cached);
          found.set(page, Promise.resolve(cached));
          continue;
        }
        const shared = resultsInFlight.get(key);
        if (shared) found.set(page, shared);
        else missing.push(page);
      }
      if (missing.length > 0) for (const [page, promise] of computeMany(docId, missing, query, normalized)) found.set(page, promise);
      const all = Promise.all(wanted.map(async (page) => [page, await (found.get(page) as Promise<PageMatch>)] as const)).then(
        (entries) => new Map(entries) as ReadonlyMap<number, PageMatch>,
      );
      return withSignal(all, signal);
    },

    getPageMatches(docId, page, query, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      const key = resultKey(docId, page, tokenize(query).join(" "));
      const cached = results.get(key);
      if (cached) {
        storeResult(key, cached);
        return Promise.resolve(cached);
      }
      const shared = resultsInFlight.get(key) ?? compute(docId, page, query, key);
      return withSignal(shared, signal);
    },

    invalidate(docId) {
      generations.set(docId, generationOf(docId) + 1);
      files.delete(docId);
      filesInFlight.delete(docId);
      for (const key of [...results.keys()]) if (docOfKey(key) === docId) results.delete(key);
      for (const key of [...resultsInFlight.keys()]) if (docOfKey(key) === docId) resultsInFlight.delete(key);
    },
  };
}
