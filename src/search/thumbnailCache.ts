/** Cache de vignettes : LRU en mémoire, ou IndexedDB avec dégradation silencieuse (mais signalée). */

export interface ThumbnailCache {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, blob: Blob): Promise<void>;
  clear(): Promise<void>;
}

export interface ThumbnailKeyParts {
  docId: string;
  pdfSize: number;
  pdfModifiedMs: number;
  page: number;
  version: number;
}

/** Clé non ambiguë : docId encodé, donc `:` ne peut venir que des séparateurs. */
export function thumbnailKey(p: ThumbnailKeyParts): string {
  return `${encodeURIComponent(p.docId)}:${p.pdfSize}:${p.pdfModifiedMs}:${p.page}:v${p.version}`;
}

export interface CacheLimits {
  maxEntries: number;
  maxBytes: number;
}

function validateLimits(l: CacheLimits): void {
  if (!Number.isInteger(l.maxEntries) || l.maxEntries < 1) {
    throw new RangeError("maxEntries doit être un entier >= 1");
  }
  if (!Number.isFinite(l.maxBytes) || l.maxBytes < 0) {
    throw new RangeError("maxBytes doit être un nombre fini >= 0");
  }
}

export class MemoryThumbnailCache implements ThumbnailCache {
  private readonly map = new Map<string, Blob>(); // ordre d'insertion = ancienneté d'accès
  private bytes = 0;

  constructor(private readonly limits: CacheLimits) {
    validateLimits(limits);
  }

  get(key: string): Promise<Blob | undefined> {
    const blob = this.map.get(key);
    if (blob !== undefined) {
      this.map.delete(key);
      this.map.set(key, blob);
    }
    return Promise.resolve(blob);
  }

  put(key: string, blob: Blob): Promise<void> {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.size;
      this.map.delete(key);
    }
    if (blob.size > this.limits.maxBytes) return Promise.resolve();
    this.map.set(key, blob);
    this.bytes += blob.size;
    while (this.map.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const oldest = this.map.entries().next();
      if (oldest.done) break;
      this.map.delete(oldest.value[0]);
      this.bytes -= oldest.value[1].size;
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.map.clear();
    this.bytes = 0;
    return Promise.resolve();
  }
}

export interface IndexedDbThumbnailCacheOptions extends CacheLimits {
  /** Par défaut `globalThis.indexedDB`. */
  factory?: IDBFactory | undefined;
  dbName?: string;
  onWarn?: ((message: string, error?: unknown) => void) | undefined;
  /** Délai avant une nouvelle tentative d'ouverture après un échec (défaut 30 s). */
  retryDelayMs?: number | undefined;
  /** Durée maximale d'une ouverture (open + lecture des métadonnées) avant abandon (défaut 5 s). */
  openTimeoutMs?: number | undefined;
  /** Horloge des nouvelles tentatives (défaut `Date.now`). */
  now?: (() => number) | undefined;
}

interface Meta {
  size: number;
  lastAccess: number;
}
interface StoredRecord extends Meta {
  key: string;
  blob: Blob;
}

/**
 * Schéma : base v2 = magasin `thumbnails` (keyPath `key`, valeurs `{key, blob, size, lastAccess}`) + index
 * `meta` sur `[lastAccess, size]`. L'index permet de lire les métadonnées (clé primaire + lastAccess + size)
 * avec `openKeyCursor`, sans charger un seul blob, et dans l'ordre d'ancienneté.
 * Migration v1 -> v2 : `onupgradeneeded` ajoute l'index au magasin existant ; les enregistrements v1 ont déjà
 * `size` et `lastAccess`, ils sont indexés automatiquement par IndexedDB. Aucune donnée n'est réécrite.
 */
const STORE = "thumbnails";
const META_INDEX = "meta";
const DB_VERSION = 2;
const DEFAULT_DB = "docseeker-thumbnails";
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
/** Nombre maximal de dates d'accès persistées par put (le reste attend le put suivant). */
const MAX_TOUCH_FLUSH = 32;

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Requête IndexedDB en erreur"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  const p = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Transaction IndexedDB annulée"));
    tx.onerror = () => reject(tx.error ?? new Error("Transaction IndexedDB en erreur"));
  });
  p.catch(() => {}); // évite un rejet non géré si l'appelant échoue avant d'attendre `done`
  return p;
}

/** Ouvre la base ; rejette sur erreur, blocage (`onblocked`) ou si le temps imparti est dépassé. */
function openDatabase(factory: IDBFactory, name: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const open = factory.open(name, DB_VERSION);
    timer = setTimeout(() => fail(new Error("Ouverture IndexedDB : délai dépassé")), timeoutMs);
    open.onupgradeneeded = () => {
      const db = open.result;
      const tx = open.transaction;
      const store =
        db.objectStoreNames.contains(STORE) && tx ? tx.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: "key" });
      if (!store.indexNames.contains(META_INDEX)) store.createIndex(META_INDEX, ["lastAccess", "size"]);
    };
    open.onblocked = () => fail(new Error("Ouverture IndexedDB bloquée par une autre connexion"));
    open.onerror = () => fail(open.error ?? new Error("Requête IndexedDB en erreur"));
    open.onsuccess = () => {
      if (settled) {
        open.result.close(); // réponse tardive après abandon : ne pas garder la connexion ouverte
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(open.result);
    };
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} : délai dépassé`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class IndexedDbThumbnailCache implements ThumbnailCache {
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;
  private readonly onWarn: ((message: string, error?: unknown) => void) | undefined;
  private readonly limits: CacheLimits;
  private readonly retryDelayMs: number;
  private readonly openTimeoutMs: number;
  private readonly now: () => number;
  /** Ordre d'insertion = ancienneté d'accès (le plus ancien en premier) : pas de tri nécessaire. */
  private meta = new Map<string, Meta>();
  /** Dates d'accès lues depuis le dernier put : persistées par lot au put suivant. */
  private readonly touched = new Map<string, number>();
  private bytes = 0;
  private clock = 0;
  private database: IDBDatabase | undefined;
  private disabled = false;
  private retryAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: IndexedDbThumbnailCacheOptions) {
    validateLimits(options);
    this.limits = { maxEntries: options.maxEntries, maxBytes: options.maxBytes };
    this.factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    this.dbName = options.dbName ?? DEFAULT_DB;
    this.onWarn = options.onWarn;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get(key: string): Promise<Blob | undefined> {
    return this.enqueue(async () => {
      const db = await this.db();
      if (!db) return undefined;
      try {
        // Lecture seule : la date d'accès est mise à jour en mémoire, persistée au prochain put.
        const tx = db.transaction(STORE, "readonly");
        const done = txDone(tx);
        const rec = (await reqPromise(tx.objectStore(STORE).get(key))) as StoredRecord | undefined;
        await done;
        if (rec === undefined) {
          this.forget(key);
          return undefined;
        }
        const lastAccess = this.tick();
        this.setMeta(key, { size: rec.size, lastAccess });
        this.touched.set(key, lastAccess);
        return rec.blob;
      } catch (e) {
        this.warn("Lecture du cache de vignettes impossible", e);
        return undefined;
      }
    }, undefined);
  }

  put(key: string, blob: Blob): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.db();
      if (!db) return;
      if (blob.size > this.limits.maxBytes) return;
      try {
        const lastAccess = this.tick();
        // Éviction par l'ordre de la Map (plus ancien d'abord), sans copie ni tri.
        let total = this.bytes - (this.meta.get(key)?.size ?? 0) + blob.size;
        let count = this.meta.size - (this.meta.has(key) ? 1 : 0) + 1;
        const evicted: string[] = [];
        for (const [k, m] of this.meta) {
          if (count <= this.limits.maxEntries && total <= this.limits.maxBytes) break;
          if (k === key) continue;
          evicted.push(k);
          total -= m.size;
          count--;
        }
        const evictedSet = new Set(evicted);
        const tx = db.transaction(STORE, "readwrite");
        const done = txDone(tx);
        const store = tx.objectStore(STORE);
        const flushed = await this.flushTouched(store, key, evictedSet);
        const rec: StoredRecord = { key, blob, size: blob.size, lastAccess };
        store.put(rec);
        for (const k of evicted) store.delete(k);
        await done;
        for (const k of evicted) this.meta.delete(k);
        for (const k of [...evicted, key, ...flushed]) this.touched.delete(k);
        this.meta.delete(key);
        this.meta.set(key, { size: blob.size, lastAccess });
        this.bytes = total;
      } catch (e) {
        this.warn("Écriture dans le cache de vignettes impossible (quota ?)", e);
      }
    }, undefined);
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.db();
      if (!db) return;
      try {
        const tx = db.transaction(STORE, "readwrite");
        const done = txDone(tx);
        tx.objectStore(STORE).clear();
        await done;
        this.meta = new Map();
        this.touched.clear();
        this.bytes = 0;
      } catch (e) {
        this.warn("Vidage du cache de vignettes impossible", e);
      }
    }, undefined);
  }

  // ---- interne ----

  /** Persiste (dans la transaction du put) les dates d'accès lues depuis le dernier put ; renvoie les clés écrites. */
  private async flushTouched(
    store: IDBObjectStore,
    replacing: string,
    evicted: ReadonlySet<string>,
  ): Promise<string[]> {
    const written: string[] = [];
    for (const [k, lastAccess] of this.touched) {
      if (written.length >= MAX_TOUCH_FLUSH) break;
      if (k === replacing || evicted.has(k) || !this.meta.has(k)) continue;
      const rec = (await reqPromise(store.get(k))) as StoredRecord | undefined;
      if (rec !== undefined) store.put({ ...rec, lastAccess });
      written.push(k);
    }
    return written;
  }

  /** Sérialise les opérations pour garder les métadonnées cohérentes. */
  private enqueue<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.chain.then(op, op).catch((e: unknown) => {
      this.warn("Erreur inattendue du cache de vignettes", e);
      return fallback;
    });
    this.chain = run;
    return run;
  }

  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  /** Enregistre `m` comme l'entrée la plus récente. */
  private setMeta(key: string, m: Meta): void {
    this.bytes += m.size - (this.meta.get(key)?.size ?? 0);
    this.meta.delete(key);
    this.meta.set(key, m);
  }

  private forget(key: string): void {
    const old = this.meta.get(key);
    if (old === undefined) return;
    this.bytes -= old.size;
    this.meta.delete(key);
    this.touched.delete(key);
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.onWarn?.(message, error);
    } catch {
      // Un onWarn défaillant ne doit jamais casser le cache.
    }
  }

  /**
   * Base ouverte, ou undefined (dégradé). Un échec d'ouverture n'est PAS mémorisé définitivement : une
   * nouvelle tentative a lieu après `retryDelayMs`. Seule l'absence d'IndexedDB est définitive.
   */
  private async db(): Promise<IDBDatabase | undefined> {
    if (this.database) return this.database;
    if (this.disabled || this.now() < this.retryAt) return undefined;
    if (!this.factory) {
      this.disabled = true;
      this.warn("IndexedDB indisponible : cache de vignettes persistant désactivé");
      return undefined;
    }
    let opened: IDBDatabase | undefined;
    try {
      opened = await openDatabase(this.factory, this.dbName, this.openTimeoutMs);
      const meta = await withTimeout(this.readMeta(opened), this.openTimeoutMs, "Lecture des métadonnées");
      this.meta = meta.map;
      this.bytes = meta.bytes;
      this.clock = Math.max(this.clock, meta.clock);
      this.touched.clear();
      this.database = opened;
      return opened;
    } catch (e) {
      opened?.close();
      this.retryAt = this.now() + this.retryDelayMs;
      this.warn("Ouverture du cache de vignettes IndexedDB impossible", e);
      return undefined;
    }
  }

  /** Métadonnées via l'index `meta` (clé = [lastAccess, size], clé primaire = key) : aucun blob n'est lu. */
  private async readMeta(db: IDBDatabase): Promise<{ map: Map<string, Meta>; bytes: number; clock: number }> {
    const tx = db.transaction(STORE, "readonly");
    const done = txDone(tx);
    const cursorReq = tx.objectStore(STORE).index(META_INDEX).openKeyCursor();
    const map = new Map<string, Meta>();
    let bytes = 0;
    let clock = 0;
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        const [lastAccess, size] = cursor.key as [number, number];
        map.set(cursor.primaryKey as string, { size, lastAccess }); // ordre croissant d'accès
        bytes += size;
        clock = Math.max(clock, lastAccess);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error("Curseur en erreur"));
    });
    await done;
    return { map, bytes, clock };
  }
}
