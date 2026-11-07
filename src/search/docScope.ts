/**
 * Portée de documents SiYuan : ne garder que les PDF cités par un cahier ou par un document (et ses sous-documents).
 * Module pur : la requête SQL est construite ici à partir de valeurs STRICTEMENT validées (jamais d'autre entrée).
 */
import { MalformedResponseError, type SqlResult } from "../siyuan/kernelApi";

export type DocumentScope =
  | { readonly kind: "notebook"; readonly box: string; readonly label: string }
  | { readonly kind: "document"; readonly box: string; readonly docPath: string; readonly label: string };

/** Identifiant SiYuan (cahier ou bloc). */
export const SQL_ID = /^\d{14}-[a-z0-9]{7}$/;
/** `blocks.path` complet d'un document : chaîne des ancêtres, « /ID1/ID2.sy ». */
export const DOC_PATH = /^(\/\d{14}-[a-z0-9]{7})+\.sy$/;
export const MAX_LABEL_LENGTH = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reconstruit une portée sûre (ordre de clés fixe, libellé NFC borné) ; undefined pour toute entrée invalide. */
export function normalizedScope(raw: unknown): DocumentScope | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, box, docPath, label } = raw;
  if (typeof box !== "string" || !SQL_ID.test(box) || typeof label !== "string") return undefined;
  // Marques de format (bidi, largeur nulle) et caractères de contrôle retirés AVANT le plafond : ils ne mangent pas la place.
  const cleaned = label.normalize("NFC").replace(/[\p{Cf}\p{Cc}]/gu, "");
  // Par points de code : `slice` en unités UTF-16 couperait une paire de substitution (émoji) en deux.
  const cleanLabel = Array.from(cleaned).slice(0, MAX_LABEL_LENGTH).join("");
  if (kind === "notebook") return { kind, box, label: cleanLabel };
  if (kind === "document" && typeof docPath === "string" && DOC_PATH.test(docPath)) {
    return { kind, box, docPath, label: cleanLabel };
  }
  return undefined;
}

/** Clé de cache : le libellé n'y entre pas (il ne change pas le résultat). */
export function scopeKey(scope: DocumentScope, includeChildren: boolean): string {
  const target = scope.kind === "notebook" ? "" : scope.docPath;
  return `${scope.kind}|${scope.box}|${target}|${includeChildren ? "1" : "0"}`;
}

/** Requête des PDF cités par la portée. `limit` explicite : sans lui le noyau tronque à 64 lignes. */
export function buildScopeSql(scope: DocumentScope, includeChildren: boolean, limit: number): string {
  if (!SQL_ID.test(scope.box)) throw new Error("invalid notebook id in document scope");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid SQL limit");
  let where = `box = '${scope.box}'`;
  // Cahier sans enfants : seulement les documents de premier niveau (« /ID.sy », aucun autre « / »). Motif constant.
  if (scope.kind === "notebook" && !includeChildren) where += " and docpath not like '/%/%'";
  if (scope.kind === "document") {
    if (!DOC_PATH.test(scope.docPath)) throw new Error("invalid document path in document scope");
    const self = `docpath = '${scope.docPath}'`;
    const descendants = `docpath like '${scope.docPath.slice(0, -".sy".length)}/%'`;
    where += includeChildren ? ` and (${self} or ${descendants})` : ` and ${self}`;
  }
  return `select distinct path from assets where ${where} and lower(path) like '%.pdf' limit ${limit}`;
}

/** Limite explicite des requêtes de portée (le noyau en impose 64 sinon). */
export const SCOPE_SQL_LIMIT = 50_000;

/** La portée cite plus de PDF que la limite : le résultat serait partiel, donc refusé. */
export class ScopeTooLargeError extends Error {
  constructor(public readonly limit: number = SCOPE_SQL_LIMIT) {
    super(`Document scope cites too many PDFs (limit ${limit})`);
    this.name = "ScopeTooLargeError";
  }
}

const HTTP_OK = 200;

/** Ensemble NFC des chemins d'un résultat de portée ; refuse un résultat partiel ou mal formé (jamais de silence). */
export function pathsFromScopeResult(result: SqlResult): ReadonlySet<string> {
  // Troncature annoncée par le noyau, ou limite atteinte pile : le résultat est peut-être incomplet.
  if (result.truncated || result.rows.length >= SCOPE_SQL_LIMIT) throw new ScopeTooLargeError();
  const paths = new Set<string>();
  for (const row of result.rows) {
    if (typeof row.path !== "string") throw new MalformedResponseError(HTTP_OK, "assets row without a text path");
    paths.add(row.path.normalize("NFC"));
  }
  return paths;
}

export interface ScopeResolverDeps {
  readonly query: (sql: string, signal?: AbortSignal) => Promise<SqlResult>;
  readonly now: () => number;
  /** Durée de validité d'un résultat en cache (30 000 ms en production). */
  readonly ttlMs: number;
}

export interface ScopeResolver {
  /** Résultat en cache encore valide, ou undefined (ne lance aucune requête). */
  peek(scope: DocumentScope, includeChildren: boolean): ReadonlySet<string> | undefined;
  /** Rejette avec IndexUnavailableError, ScopeTooLargeError, une erreur du noyau, ou la raison de l'annulation. */
  resolve(scope: DocumentScope, includeChildren: boolean, signal?: AbortSignal): Promise<ReadonlySet<string>>;
}

export const SCOPE_CACHE_ENTRIES = 8;

interface Inflight {
  readonly promise: Promise<ReadonlySet<string>>;
  readonly controller: AbortController;
  waiters: number;
}

/** Cache TTL + LRU de 8 entrées, une seule requête simultanée par clé, annulation par signal de chaque appelant. */
export function createScopeResolver(deps: ScopeResolverDeps): ScopeResolver {
  const cache = new Map<string, { readonly paths: ReadonlySet<string>; readonly at: number }>();
  const inflight = new Map<string, Inflight>();

  const fresh = (key: string): ReadonlySet<string> | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (deps.now() - entry.at >= deps.ttlMs) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key); // ré-insertion : devient la plus récemment utilisée
    cache.set(key, entry);
    return entry.paths;
  };

  const start = (key: string, scope: DocumentScope, includeChildren: boolean): Inflight => {
    const controller = new AbortController();
    const promise = (async (): Promise<ReadonlySet<string>> => {
      const paths = pathsFromScopeResult(await deps.query(buildScopeSql(scope, includeChildren, SCOPE_SQL_LIMIT), controller.signal));
      // Annulé entre-temps (plus aucun demandeur) : rien n'est mis en cache.
      if (!controller.signal.aborted) {
        cache.set(key, { paths, at: deps.now() });
        while (cache.size > SCOPE_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      }
      return paths;
    })().finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });
    // Les demandeurs reçoivent l'erreur par leur propre attente ; ceci évite seulement un rejet non géré lorsque tous
    // se sont désistés (annulation volontaire).
    promise.catch(() => undefined);
    const entry: Inflight = { promise, controller, waiters: 0 };
    inflight.set(key, entry);
    return entry;
  };

  return {
    peek: (scope, includeChildren) => fresh(scopeKey(scope, includeChildren)),
    async resolve(scope, includeChildren, signal) {
      if (signal?.aborted) throw signal.reason;
      const key = scopeKey(scope, includeChildren);
      const cached = fresh(key);
      if (cached) return cached;
      const entry = inflight.get(key) ?? start(key, scope, includeChildren);
      entry.waiters++;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([entry.promise, aborted]);
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        entry.waiters--;
        if (entry.waiters === 0 && signal?.aborted) {
          entry.controller.abort(signal.reason);
          if (inflight.get(key) === entry) inflight.delete(key);
        }
      }
    },
  };
}
