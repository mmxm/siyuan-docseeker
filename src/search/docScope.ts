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
function normalizedScope(raw: unknown): DocumentScope | undefined {
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

export const MAX_SCOPES = 20;

/** Identité d'une portée (le libellé n'y entre pas : il ne change pas le résultat). */
const targetKey = (scope: DocumentScope): string => `${scope.kind}|${scope.box}|${scope.kind === "notebook" ? "" : scope.docPath}`;

/**
 * Liste de portées sûre : 1 à 20 portées toutes valides, sans doublon de cible ; sinon undefined pour la liste ENTIÈRE
 * (retirer une portée en silence élargirait ou changerait la recherche).
 */
export function normalizedScopes(raw: unknown): readonly DocumentScope[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SCOPES) return undefined;
  const out: DocumentScope[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    const scope = normalizedScope(item);
    if (scope === undefined) return undefined;
    const key = targetKey(scope);
    if (seen.has(key)) return undefined;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

/**
 * Lit les portées d'un objet de filtres inconnu : `scopes` (liste) ou, pour les anciens fichiers, `scope` (singulier, lu comme
 * une liste d'un élément). `invalid` porte la valeur brute refusée (à signaler par l'appelant, jamais retirée en silence).
 */
export function readScopes(filters: Record<string, unknown>): { readonly scopes?: readonly DocumentScope[]; readonly invalid?: unknown } {
  const raw = filters["scopes"] !== undefined ? filters["scopes"] : filters["scope"] !== undefined ? [filters["scope"]] : undefined;
  if (raw === undefined) return {};
  const scopes = normalizedScopes(raw);
  return scopes === undefined ? { invalid: filters["scopes"] !== undefined ? filters["scopes"] : filters["scope"] } : { scopes };
}

/**
 * Clé de cache : indicateur d'enfants puis clés de cible triées, séparés par « \n » (absent des identifiants et chemins
 * validés, donc deux listes distinctes ne produisent jamais la même clé).
 */
export function scopeKey(scopes: readonly DocumentScope[], includeChildren: boolean): string {
  // Un cahier contient toujours tous ses documents : l'indicateur ne concerne que les documents choisis (cache partagé sinon).
  const flag = includeChildren || !scopes.some((s) => s.kind === "document") ? "1" : "0";
  return [flag, ...scopes.map(targetKey).sort()].join("\n");
}

/** Un cahier inclut TOUJOURS tous ses documents (comme SiYuan) ; `includeChildren` ne concerne que les documents choisis. */
function scopeCondition(scope: DocumentScope, includeChildren: boolean): string {
  if (!SQL_ID.test(scope.box)) throw new Error("invalid notebook id in document scope");
  let where = `box = '${scope.box}'`;
  if (scope.kind === "document") {
    if (!DOC_PATH.test(scope.docPath)) throw new Error("invalid document path in document scope");
    const self = `docpath = '${scope.docPath}'`;
    const descendants = `docpath like '${scope.docPath.slice(0, -".sy".length)}/%'`;
    where += includeChildren ? ` and (${self} or ${descendants})` : ` and ${self}`;
  }
  return where;
}

/** Requête des PDF cités par les portées (OU). `limit` explicite : sans lui le noyau tronque à 64 lignes. */
export function buildScopeSql(scopes: readonly DocumentScope[], includeChildren: boolean, limit: number): string {
  if (scopes.length < 1 || scopes.length > MAX_SCOPES) throw new Error("invalid number of document scopes");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid SQL limit");
  const conditions = scopes.map((s) => scopeCondition(s, includeChildren));
  const where = conditions.length === 1 ? (conditions[0] as string) : `(${conditions.map((c) => `(${c})`).join(" or ")})`;
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
  peek(scopes: readonly DocumentScope[], includeChildren: boolean): ReadonlySet<string> | undefined;
  /** Rejette avec IndexUnavailableError, ScopeTooLargeError, une erreur du noyau, ou la raison de l'annulation. */
  resolve(scopes: readonly DocumentScope[], includeChildren: boolean, signal?: AbortSignal): Promise<ReadonlySet<string>>;
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

  const start = (key: string, scopes: readonly DocumentScope[], includeChildren: boolean): Inflight => {
    const controller = new AbortController();
    const promise = (async (): Promise<ReadonlySet<string>> => {
      const paths = pathsFromScopeResult(await deps.query(buildScopeSql(scopes, includeChildren, SCOPE_SQL_LIMIT), controller.signal));
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
    peek: (scopes, includeChildren) => fresh(scopeKey(scopes, includeChildren)),
    async resolve(scopes, includeChildren, signal) {
      if (signal?.aborted) throw signal.reason;
      const key = scopeKey(scopes, includeChildren);
      const cached = fresh(key);
      if (cached) return cached;
      const entry = inflight.get(key) ?? start(key, scopes, includeChildren);
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
