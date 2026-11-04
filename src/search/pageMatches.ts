/**
 * Service de correspondances par page : lit le .dsx d'un document (LRU d'octets),
 * décode une page pour une requête (LRU de résultats) et mutualise les appels en vol.
 * L'annulation d'un demandeur n'interrompt jamais le travail partagé.
 */
import { decodePageMatches, type PageMatch } from "../core/codec/decode";
import { tokenize } from "../core/normalize";
import { makeTermMatcher } from "./queryMatch";

export interface PageMatchServiceOptions {
  readonly readDsx: (docId: string) => Promise<Uint8Array>;
  readonly decode?: typeof decodePageMatches;
  /** Plafond cumulé d'octets des fichiers conservés (au moins le dernier est gardé). */
  readonly maxBytesFiles?: number;
  readonly maxPages?: number;
}

export interface PageMatchService {
  getPageMatches(docId: string, page: number, query: string, signal?: AbortSignal): Promise<PageMatch>;
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
      .then((bytes) => decode(bytes, page, makeTermMatcher(query)))
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

  return {
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
