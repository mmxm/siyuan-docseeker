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
}

interface Meta {
  size: number;
  lastAccess: number;
}
interface StoredRecord extends Meta {
  key: string;
  blob: Blob;
}

const STORE = "thumbnails";
const DEFAULT_DB = "docseeker-thumbnails";

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

export class IndexedDbThumbnailCache implements ThumbnailCache {
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;
  private readonly onWarn: ((message: string, error?: unknown) => void) | undefined;
  private readonly limits: CacheLimits;
  private meta = new Map<string, Meta>();
  private bytes = 0;
  private clock = 0;
  private dbPromise: Promise<IDBDatabase | undefined> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: IndexedDbThumbnailCacheOptions) {
    validateLimits(options);
    this.limits = { maxEntries: options.maxEntries, maxBytes: options.maxBytes };
    this.factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    this.dbName = options.dbName ?? DEFAULT_DB;
    this.onWarn = options.onWarn;
  }

  get(key: string): Promise<Blob | undefined> {
    return this.enqueue(async () => {
      const db = await this.db();
      if (!db) return undefined;
      try {
        const tx = db.transaction(STORE, "readwrite");
        const done = txDone(tx);
        const store = tx.objectStore(STORE);
        const rec = (await reqPromise(store.get(key))) as StoredRecord | undefined;
        if (rec === undefined) {
          await done;
          return undefined;
        }
        const lastAccess = this.tick();
        store.put({ ...rec, lastAccess });
        await done;
        this.setMeta(key, { size: rec.size, lastAccess });
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
        const next = new Map(this.meta);
        next.delete(key);
        next.set(key, { size: blob.size, lastAccess });
        const evicted: string[] = [];
        let total = 0;
        for (const m of next.values()) total += m.size;
        const byAge = [...next.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        let count = next.size;
        for (const [k, m] of byAge) {
          if (count <= this.limits.maxEntries && total <= this.limits.maxBytes) break;
          if (k === key) continue;
          evicted.push(k);
          next.delete(k);
          total -= m.size;
          count--;
        }
        const tx = db.transaction(STORE, "readwrite");
        const done = txDone(tx);
        const store = tx.objectStore(STORE);
        const rec: StoredRecord = { key, blob, size: blob.size, lastAccess };
        store.put(rec);
        for (const k of evicted) store.delete(k);
        await done;
        this.meta = next;
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
        this.bytes = 0;
      } catch (e) {
        this.warn("Vidage du cache de vignettes impossible", e);
      }
    }, undefined);
  }

  // ---- interne ----

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

  private setMeta(key: string, m: Meta): void {
    this.bytes += m.size - (this.meta.get(key)?.size ?? 0);
    this.meta.set(key, m);
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.onWarn?.(message, error);
    } catch {
      // Un onWarn défaillant ne doit jamais casser le cache.
    }
  }

  private db(): Promise<IDBDatabase | undefined> {
    this.dbPromise ??= this.openAndLoad();
    return this.dbPromise;
  }

  private async openAndLoad(): Promise<IDBDatabase | undefined> {
    if (!this.factory) {
      this.warn("IndexedDB indisponible : cache de vignettes persistant désactivé");
      return undefined;
    }
    try {
      const open = this.factory.open(this.dbName, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      const db = await reqPromise(open);
      await this.loadMeta(db);
      return db;
    } catch (e) {
      this.warn("Ouverture du cache de vignettes IndexedDB impossible", e);
      return undefined;
    }
  }

  private async loadMeta(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(STORE, "readonly");
    const done = txDone(tx);
    const cursorReq = tx.objectStore(STORE).openCursor();
    const meta = new Map<string, Meta>();
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        const v = cursor.value as StoredRecord;
        meta.set(v.key, { size: v.size, lastAccess: v.lastAccess });
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error("Curseur en erreur"));
    });
    await done;
    this.meta = meta;
    this.bytes = 0;
    for (const m of meta.values()) {
      this.bytes += m.size;
      this.clock = Math.max(this.clock, m.lastAccess);
    }
  }
}
