import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbThumbnailCache,
  MemoryThumbnailCache,
  thumbnailKey,
} from "../../../src/search/thumbnailCache";

const blobOf = (n: number, fill = "x"): Blob => new Blob([fill.repeat(n)]);
const text = async (b: Blob | undefined): Promise<string | undefined> =>
  b === undefined ? undefined : b.text();

describe("thumbnailKey", () => {
  const base = { docId: "a.pdf", pdfSize: 10, pdfModifiedMs: 20, page: 3, version: 1 };
  it("est stable et dépend de chaque champ", () => {
    expect(thumbnailKey(base)).toBe(thumbnailKey({ ...base }));
    const keys = new Set([
      thumbnailKey(base),
      thumbnailKey({ ...base, docId: "b.pdf" }),
      thumbnailKey({ ...base, pdfSize: 11 }),
      thumbnailKey({ ...base, pdfModifiedMs: 21 }),
      thumbnailKey({ ...base, page: 4 }),
      thumbnailKey({ ...base, version: 2 }),
    ]);
    expect(keys.size).toBe(6);
  });
  it("n'est pas ambigu avec des séparateurs dans docId", () => {
    const a = thumbnailKey({ ...base, docId: "x:1", pdfSize: 2 });
    const b = thumbnailKey({ ...base, docId: "x", pdfSize: 1 });
    expect(a).not.toBe(b);
    expect(thumbnailKey({ ...base, docId: "é 😀|/%" })).toContain("");
  });
});

describe("MemoryThumbnailCache", () => {
  it("renvoie undefined pour une clé absente, puis la valeur stockée", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 3, maxBytes: 100 });
    expect(await c.get("k")).toBeUndefined();
    await c.put("k", blobOf(4, "a"));
    expect(await text(await c.get("k"))).toBe("aaaa");
  });
  it("évince le moins récemment utilisé au-delà du plafond d'entrées", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 2, maxBytes: 1000 });
    await c.put("a", blobOf(1));
    await c.put("b", blobOf(1));
    await c.get("a"); // b devient le plus ancien
    await c.put("c", blobOf(1));
    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("a")).toBeDefined();
    expect(await c.get("c")).toBeDefined();
  });
  it("évince selon le plafond d'octets", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 100, maxBytes: 10 });
    await c.put("a", blobOf(6));
    await c.put("b", blobOf(6));
    expect(await c.get("a")).toBeUndefined();
    expect(await c.get("b")).toBeDefined();
  });
  it("ignore un blob plus gros que le plafond sans vider le cache", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 100, maxBytes: 10 });
    await c.put("a", blobOf(5));
    await c.put("big", blobOf(11));
    expect(await c.get("big")).toBeUndefined();
    expect(await c.get("a")).toBeDefined();
  });
  it("remplacer une clé met à jour le total d'octets", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 100, maxBytes: 10 });
    await c.put("a", blobOf(8));
    await c.put("a", blobOf(8));
    await c.put("b", blobOf(2));
    expect(await c.get("a")).toBeDefined();
    expect(await c.get("b")).toBeDefined();
  });
  it("clear vide tout", async () => {
    const c = new MemoryThumbnailCache({ maxEntries: 5, maxBytes: 100 });
    await c.put("a", blobOf(1));
    await c.clear();
    expect(await c.get("a")).toBeUndefined();
    await c.put("b", blobOf(100));
    expect(await c.get("b")).toBeDefined();
  });
  it("rejette des plafonds invalides", () => {
    expect(() => new MemoryThumbnailCache({ maxEntries: 0, maxBytes: 10 })).toThrow();
    expect(() => new MemoryThumbnailCache({ maxEntries: 1, maxBytes: -1 })).toThrow();
    expect(() => new MemoryThumbnailCache({ maxEntries: 1.5, maxBytes: 1 })).toThrow();
  });
});

// ---- Faux IDBFactory minimal (pas de fake-indexeddb en devDependency) ----

interface FakeOptions {
  failOpen?: boolean;
  /** open() ne répond jamais. */
  hangOpen?: boolean;
  /** open() déclenche onblocked puis ne répond pas. */
  blockOpen?: boolean;
  /** Nombre de db.close() reçus (compteur écrit par le faux). */
  closed?: number;
  opens?: number;
  failPut?: boolean;
  failGet?: boolean;
}
type Rec = Record<string, unknown> & { key: string };

class FakeDb {
  readonly stores = new Map<string, Map<string, Rec>>();
  readonly indexes = new Set<string>();
  readonly modes: string[] = [];
  version = 0;
  blobCursorOpens = 0;
  constructor(readonly opts: FakeOptions) {}
}

const storeSchema = (d: FakeDb) => ({
  indexNames: { contains: (n: string) => d.indexes.has(n) },
  createIndex: (n: string) => {
    d.indexes.add(n);
  },
});

function fakeFactory(opts: FakeOptions = {}): { factory: IDBFactory; dbs: Map<string, FakeDb> } {
  const dbs = new Map<string, FakeDb>();
  const factory = {
    open(name: string, version = 1) {
      const req: Record<string, unknown> = { error: null };
      opts.opens = (opts.opens ?? 0) + 1;
      if (opts.hangOpen) return req;
      if (opts.blockOpen) {
        setTimeout(() => (req["onblocked"] as (() => void) | undefined)?.(), 0);
        return req;
      }
      setTimeout(() => {
        if (opts.failOpen) {
          req["error"] = new Error("indisponible");
          (req["onerror"] as (() => void) | undefined)?.();
          return;
        }
        let db = dbs.get(name);
        if (!db) {
          db = new FakeDb(opts);
          dbs.set(name, db);
        }
        const d = db;
        const upgrade = d.version < version;
        const handle = {
          objectStoreNames: { contains: (n: string) => d.stores.has(n) },
          createObjectStore: (n: string) => {
            d.stores.set(n, new Map());
            return storeSchema(d);
          },
          close: () => {
            opts.closed = (opts.closed ?? 0) + 1;
          },
          transaction: (storeName: string, mode = "readonly") => {
            d.modes.push(mode);
            return makeTx(d, storeName);
          },
        };
        req["result"] = handle;
        req["transaction"] = { objectStore: () => storeSchema(d) };
        if (upgrade) {
          d.version = version;
          (req["onupgradeneeded"] as (() => void) | undefined)?.();
        }
        (req["onsuccess"] as (() => void) | undefined)?.();
      }, 0);
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, dbs };
}

function makeTx(db: FakeDb, storeName: string) {
  const data = db.stores.get(storeName)!;
  const snapshot = new Map(data);
  let pending = 0;
  let finished = false;
  const tx: Record<string, unknown> = { error: null };
  const maybeDone = () => {
    setTimeout(() => {
      if (pending === 0 && !finished) {
        finished = true;
        (tx["oncomplete"] as (() => void) | undefined)?.();
      }
    }, 0);
  };
  const abort = (err: Error) => {
    if (finished) return;
    finished = true;
    data.clear();
    for (const [k, v] of snapshot) data.set(k, v);
    tx["error"] = err;
    (tx["onabort"] as (() => void) | undefined)?.();
  };
  const request = (run: () => unknown, fail?: Error) => {
    const req: Record<string, unknown> = {};
    pending++;
    queueMicrotask(() => {
      pending--;
      if (fail) {
        req["error"] = fail;
        (req["onerror"] as (() => void) | undefined)?.();
        abort(fail);
        return;
      }
      req["result"] = run();
      (req["onsuccess"] as (() => void) | undefined)?.();
      maybeDone();
    });
    return req;
  };
  const store = {
    get: (k: string) =>
      request(() => data.get(k), db.opts.failGet ? new Error("get") : undefined),
    put: (v: Rec) =>
      request(
        () => {
          data.set(v.key, v);
          return v.key;
        },
        db.opts.failPut ? Object.assign(new Error("quota"), { name: "QuotaExceededError" }) : undefined,
      ),
    delete: (k: string) => request(() => void data.delete(k)),
    clear: () => request(() => void data.clear()),
    ...storeSchema(db),
    index: () => ({
      openKeyCursor: () => {
        const entries = [...data.values()].sort(
          (a, b) => (a["lastAccess"] as number) - (b["lastAccess"] as number),
        );
        let i = 0;
        const req: Record<string, unknown> = {};
        const step = () => {
          pending++;
          queueMicrotask(() => {
            pending--;
            const e = entries[i];
            req["result"] =
              e === undefined
                ? null
                : {
                    key: [e["lastAccess"], e["size"]],
                    primaryKey: e.key,
                    continue: () => {
                      i++;
                      step();
                    },
                  };
            (req["onsuccess"] as (() => void) | undefined)?.();
            maybeDone();
          });
        };
        step();
        return req;
      },
    }),
    openCursor: () => {
      db.blobCursorOpens++;
      const keys = [...data.keys()];
      let i = 0;
      const req: Record<string, unknown> = {};
      const step = () => {
        pending++;
        queueMicrotask(() => {
          pending--;
          const k = keys[i];
          req["result"] =
            k === undefined
              ? null
              : {
                  value: data.get(k),
                  continue: () => {
                    i++;
                    step();
                  },
                };
          (req["onsuccess"] as (() => void) | undefined)?.();
          maybeDone();
        });
      };
      step();
      return req;
    },
  };
  tx["objectStore"] = () => store;
  tx["abort"] = () => abort(new Error("abort"));
  maybeDone();
  return tx;
}

const mkIdb = (
  over: Partial<ConstructorParameters<typeof IndexedDbThumbnailCache>[0]> = {},
  fo: FakeOptions = {},
) => {
  const fake = fakeFactory(fo);
  const opts = fo;
  const onWarn = vi.fn();
  const cache = new IndexedDbThumbnailCache({
    factory: fake.factory,
    maxEntries: 3,
    maxBytes: 100,
    onWarn,
    ...over,
  });
  return { cache, onWarn, opts, ...fake };
};

describe("IndexedDbThumbnailCache", () => {
  it("put puis get renvoie le blob; absent donne undefined", async () => {
    const { cache, onWarn } = mkIdb();
    expect(await cache.get("k")).toBeUndefined();
    await cache.put("k", blobOf(3, "z"));
    expect(await text(await cache.get("k"))).toBe("zzz");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("utilise une base DocSeeker dédiée avec un seul magasin", async () => {
    const { cache, dbs } = mkIdb();
    await cache.put("k", blobOf(1));
    expect(dbs.size).toBe(1);
    const [name, db] = [...dbs.entries()][0]!;
    expect(name.toLowerCase()).toContain("docseeker");
    expect(db.stores.size).toBe(1);
  });

  it("évince la plus ancienne entrée accédée (plafond d'entrées)", async () => {
    const { cache } = mkIdb({ maxEntries: 2 });
    await cache.put("a", blobOf(1));
    await cache.put("b", blobOf(1));
    await cache.get("a");
    await cache.put("c", blobOf(1));
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
  });

  it("évince selon le plafond d'octets", async () => {
    const { cache, dbs } = mkIdb({ maxBytes: 10 });
    await cache.put("a", blobOf(6));
    await cache.put("b", blobOf(6));
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeDefined();
    expect([...dbs.values()][0]!.stores.values().next().value!.size).toBe(1);
  });

  it("recharge les métadonnées d'une base existante pour évincer", async () => {
    const fake = fakeFactory();
    const mk = () =>
      new IndexedDbThumbnailCache({ factory: fake.factory, maxEntries: 2, maxBytes: 100, onWarn: () => {} });
    const c1 = mk();
    await c1.put("a", blobOf(1));
    await c1.put("b", blobOf(1));
    const c2 = mk();
    await c2.put("c", blobOf(1));
    expect(await c2.get("a")).toBeUndefined();
    expect(await c2.get("b")).toBeDefined();
  });

  it("ignore un blob plus gros que le plafond", async () => {
    const { cache, onWarn } = mkIdb({ maxBytes: 10 });
    await cache.put("big", blobOf(11));
    expect(await cache.get("big")).toBeUndefined();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("clear vide la base", async () => {
    const { cache } = mkIdb();
    await cache.put("a", blobOf(1));
    await cache.clear();
    expect(await cache.get("a")).toBeUndefined();
    await cache.put("b", blobOf(100));
    expect(await cache.get("b")).toBeDefined();
  });

  it("des put concurrents respectent les plafonds", async () => {
    const { cache } = mkIdb({ maxEntries: 3 });
    await Promise.all(["a", "b", "c", "d", "e"].map((k) => cache.put(k, blobOf(1))));
    const present = (await Promise.all(["a", "b", "c", "d", "e"].map((k) => cache.get(k)))).filter(
      Boolean,
    );
    expect(present.length).toBe(3);
  });

  it("IndexedDB indisponible (absent) : dégrade sans lever, avec onWarn", async () => {
    const onWarn = vi.fn();
    const cache = new IndexedDbThumbnailCache({
      factory: undefined,
      maxEntries: 3,
      maxBytes: 100,
      onWarn,
    });
    await expect(cache.put("a", blobOf(1))).resolves.toBeUndefined();
    expect(await cache.get("a")).toBeUndefined();
    await expect(cache.clear()).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
  });

  it("open qui échoue : dégrade sans lever, avec onWarn", async () => {
    const { cache, onWarn } = mkIdb({}, { failOpen: true });
    await expect(cache.put("a", blobOf(1))).resolves.toBeUndefined();
    expect(await cache.get("a")).toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
  });

  it("factory.open qui lève de façon synchrone est dégradé", async () => {
    const onWarn = vi.fn();
    const cache = new IndexedDbThumbnailCache({
      factory: {
        open() {
          throw new Error("SecurityError");
        },
      } as unknown as IDBFactory,
      maxEntries: 3,
      maxBytes: 100,
      onWarn,
    });
    expect(await cache.get("a")).toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
  });

  it("quota dépassé à l'écriture : put no-op, onWarn appelé, cache reste utilisable", async () => {
    const fake = fakeFactory({ failPut: true });
    const onWarn = vi.fn();
    const cache = new IndexedDbThumbnailCache({
      factory: fake.factory,
      maxEntries: 3,
      maxBytes: 100,
      onWarn,
    });
    await expect(cache.put("a", blobOf(1))).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
    expect(await cache.get("a")).toBeUndefined();
  });

  it("échec de lecture : get renvoie undefined avec onWarn", async () => {
    const { cache, onWarn } = mkIdb({}, { failGet: true });
    expect(await cache.get("a")).toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
  });

  it("onWarn est optionnel", async () => {
    const cache = new IndexedDbThumbnailCache({ factory: undefined, maxEntries: 1, maxBytes: 1 });
    expect(await cache.get("a")).toBeUndefined();
  });

  it("onWarn qui lève ne casse pas le cache", async () => {
    const cache = new IndexedDbThumbnailCache({
      factory: undefined,
      maxEntries: 1,
      maxBytes: 1,
      onWarn: () => {
        throw new Error("boom");
      },
    });
    expect(await cache.get("a")).toBeUndefined();
  });

  it("rejette des plafonds invalides", () => {
    expect(() => new IndexedDbThumbnailCache({ maxEntries: 0, maxBytes: 1 })).toThrow();
    expect(() => new IndexedDbThumbnailCache({ maxEntries: 1, maxBytes: Number.NaN })).toThrow();
  });

  describe("robustesse de l'ouverture", () => {
    it("ne mémorise pas un échec d'ouverture : nouvelle tentative après le délai", async () => {
      let t = 0;
      const { cache, opts, onWarn } = mkIdb({ now: () => t, retryDelayMs: 1000 }, { failOpen: true });
      await cache.put("a", blobOf(1));
      expect(opts.opens).toBe(1);
      expect(onWarn).toHaveBeenCalledTimes(1);
      t = 999;
      await cache.put("a", blobOf(1));
      await cache.get("a");
      expect(opts.opens).toBe(1); // pas de tempête de tentatives avant le délai
      opts.failOpen = false;
      t = 1000;
      await cache.put("a", blobOf(2, "q"));
      expect(opts.opens).toBe(2);
      expect(await text(await cache.get("a"))).toBe("qq");
    });

    it("un open qui ne répond jamais ne bloque pas la chaîne (timeout), puis réessaie", async () => {
      let t = 0;
      const { cache, opts } = mkIdb({ now: () => t, retryDelayMs: 50, openTimeoutMs: 20 }, { hangOpen: true });
      await expect(cache.put("a", blobOf(1))).resolves.toBeUndefined();
      expect(await cache.get("a")).toBeUndefined();
      opts.hangOpen = false;
      t = 100;
      await cache.put("a", blobOf(1, "w"));
      expect(await text(await cache.get("a"))).toBe("w");
    });

    it("onblocked dégrade tout de suite (sans attendre le timeout)", async () => {
      const { cache, onWarn } = mkIdb({ openTimeoutMs: 60_000 }, { blockOpen: true });
      await expect(cache.get("a")).resolves.toBeUndefined();
      expect(onWarn).toHaveBeenCalled();
    });

    it("IndexedDB absent reste définitivement désactivé (pas de nouvelle tentative)", async () => {
      const onWarn = vi.fn();
      const cache = new IndexedDbThumbnailCache({ factory: undefined, maxEntries: 1, maxBytes: 1, onWarn });
      await cache.get("a");
      await cache.get("a");
      expect(onWarn).toHaveBeenCalledTimes(1);
    });
  });

  describe("accès et métadonnées", () => {
    it("get ouvre une transaction en lecture seule", async () => {
      const { cache, dbs } = mkIdb();
      await cache.put("a", blobOf(1));
      const db = [...dbs.values()][0]!;
      db.modes.length = 0;
      expect(await cache.get("a")).toBeDefined();
      expect(await cache.get("zzz")).toBeUndefined();
      expect(db.modes).toEqual(["readonly", "readonly"]);
    });

    it("la date d'accès d'un get est persistée au put suivant", async () => {
      const { cache, dbs } = mkIdb();
      await cache.put("a", blobOf(1));
      await cache.put("b", blobOf(1));
      await cache.get("a");
      await cache.put("c", blobOf(1));
      const store = [...dbs.values()][0]!.stores.get("thumbnails")!;
      expect(store.get("a")!["lastAccess"] as number).toBeGreaterThan(store.get("b")!["lastAccess"] as number);
    });

    it("charge les métadonnées par un curseur d'index, sans lire les blobs", async () => {
      const fake = fakeFactory();
      const mk = () => new IndexedDbThumbnailCache({ factory: fake.factory, maxEntries: 2, maxBytes: 100 });
      await mk().put("a", blobOf(1));
      const c2 = mk();
      await c2.put("b", blobOf(1));
      expect([...fake.dbs.values()][0]!.blobCursorOpens).toBe(0);
    });

    it("migre une base v1 (sans index de métadonnées) en créant l'index", async () => {
      const fake = fakeFactory();
      const old = new FakeDb({});
      old.version = 1;
      old.stores.set("thumbnails", new Map([["a", { key: "a", blob: blobOf(1), size: 1, lastAccess: 5 }]]));
      fake.dbs.set("docseeker-thumbnails", old);
      const cache = new IndexedDbThumbnailCache({ factory: fake.factory, maxEntries: 1, maxBytes: 100 });
      await cache.put("b", blobOf(1));
      expect(old.version).toBe(2);
      expect(old.indexes.size).toBe(1);
      expect(await cache.get("a")).toBeUndefined(); // évincée grâce aux métadonnées lues par l'index
    });

    it("put n'a pas besoin de trier les entrées", async () => {
      const { cache } = mkIdb({ maxEntries: 10, maxBytes: 1000 });
      for (let k = 0; k < 10; k++) await cache.put(`k${k}`, blobOf(1));
      const spy = vi.spyOn(Array.prototype, "sort");
      try {
        await cache.put("new", blobOf(1));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await cache.get("k0")).toBeUndefined();
      expect(await cache.get("new")).toBeDefined();
    });
  });
});
