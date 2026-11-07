import { describe, expect, it, vi } from "vitest";
import { ScopeTooLargeError, SCOPE_SQL_LIMIT, createScopeResolver, type DocumentScope } from "../../../src/search/docScope";
import { IndexUnavailableError, type SqlResult } from "../../../src/siyuan/kernelApi";

const BOX = "20210808180117-6v0mkxr";
const nb = (n: number): DocumentScope => ({ kind: "notebook", box: `20210808180117-${String(n).padStart(7, "0")}`, label: `n${n}` });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Pending {
  readonly sql: string;
  readonly signal: AbortSignal | undefined;
  resolve(r: SqlResult): void;
  reject(e: unknown): void;
}

function setup(ttlMs = 30_000) {
  const pending: Pending[] = [];
  let clock = 1000;
  const query = vi.fn(
    (sql: string, signal?: AbortSignal) =>
      new Promise<SqlResult>((resolve, reject) => {
        pending.push({ sql, signal, resolve, reject });
      }),
  );
  const resolver = createScopeResolver({ query, now: () => clock, ttlMs });
  return { resolver, query, pending, tick: (ms: number) => (clock += ms) };
}
const ok = (...paths: string[]): SqlResult => ({ rows: paths.map((path) => ({ path })), truncated: false });

describe("createScopeResolver", () => {
  it("résout, met en cache : peek ne renvoie rien avant, l'ensemble après", async () => {
    const { resolver, pending } = setup();
    const s = nb(1);
    expect(resolver.peek(s, true)).toBeUndefined();
    const p = resolver.resolve(s, true);
    pending[0]?.resolve(ok("assets/é.pdf"));
    const set = await p;
    expect([...set]).toEqual(["assets/é.pdf"]);
    expect(resolver.peek(s, true)).toBe(set);
    expect(resolver.peek(s, false)).toBeUndefined();
  });

  it("une seule requête simultanée par clé, résultat partagé", async () => {
    const { resolver, query, pending } = setup();
    const a = resolver.resolve(nb(1), true);
    const b = resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(1);
    pending[0]?.resolve(ok("assets/a.pdf"));
    expect(await a).toBe(await b);
    // en cache : pas de nouvelle requête
    await resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("le cache expire après le TTL", async () => {
    const { resolver, query, pending, tick } = setup(30_000);
    const p = resolver.resolve(nb(1), true);
    pending[0]?.resolve(ok("assets/a.pdf"));
    await p;
    tick(29_999);
    expect(resolver.peek(nb(1), true)).toBeDefined();
    tick(1);
    expect(resolver.peek(nb(1), true)).toBeUndefined();
    const again = resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(2);
    pending[1]?.resolve(ok("assets/b.pdf"));
    expect([...(await again)]).toEqual(["assets/b.pdf"]);
  });

  it("garde 8 entrées au plus (LRU : la plus récemment utilisée survit)", async () => {
    const { resolver, pending } = setup();
    for (let i = 1; i <= 8; i++) {
      const p = resolver.resolve(nb(i), true);
      pending[pending.length - 1]?.resolve(ok(`assets/${i}.pdf`));
      await p;
    }
    expect(resolver.peek(nb(1), true)).toBeDefined(); // 1 devient la plus récente
    const p9 = resolver.resolve(nb(9), true);
    pending[pending.length - 1]?.resolve(ok("assets/9.pdf"));
    await p9;
    expect(resolver.peek(nb(2), true)).toBeUndefined(); // évincée
    expect(resolver.peek(nb(1), true)).toBeDefined();
    expect(resolver.peek(nb(9), true)).toBeDefined();
  });

  it("un échec n'est pas mis en cache et est propagé", async () => {
    const { resolver, query, pending } = setup();
    const err = new IndexUnavailableError(200, -1, "document metadata is not ready");
    const p = resolver.resolve(nb(1), true);
    pending[0]?.reject(err);
    await expect(p).rejects.toBe(err);
    const again = resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(2);
    pending[1]?.resolve(ok());
    expect((await again).size).toBe(0);
  });

  it("ScopeTooLargeError si tronqué ou limite atteinte", async () => {
    const { resolver, pending } = setup();
    const a = resolver.resolve(nb(1), true);
    pending[0]?.resolve({ rows: [], truncated: true });
    await expect(a).rejects.toBeInstanceOf(ScopeTooLargeError);
    const b = resolver.resolve(nb(2), true);
    pending[1]?.resolve({ rows: Array.from({ length: SCOPE_SQL_LIMIT }, (_, i) => ({ path: `assets/${i}.pdf` })), truncated: false });
    await expect(b).rejects.toBeInstanceOf(ScopeTooLargeError);
  });

  it("signal déjà annulé : rejet immédiat sans requête", async () => {
    const { resolver, query } = setup();
    const c = new AbortController();
    c.abort(new Error("stop"));
    await expect(resolver.resolve(nb(1), true, c.signal)).rejects.toThrow("stop");
    expect(query).not.toHaveBeenCalled();
  });

  it("annulation du seul appelant : la requête est annulée et rien n'est mis en cache", async () => {
    const { resolver, pending } = setup();
    const c = new AbortController();
    const p = resolver.resolve(nb(1), true, c.signal);
    c.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.reject(new Error("aborted by kernel"));
    await flush();
    expect(resolver.peek(nb(1), true)).toBeUndefined();
  });

  it("annulation d'un appelant parmi deux : la requête partagée continue pour l'autre", async () => {
    const { resolver, query, pending } = setup();
    const c1 = new AbortController();
    const first = resolver.resolve(nb(1), true, c1.signal);
    const second = resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(1);
    c1.abort(new Error("stop"));
    await expect(first).rejects.toThrow("stop");
    expect(pending[0]?.signal?.aborted).toBe(false);
    pending[0]?.resolve(ok("assets/a.pdf"));
    expect([...(await second)]).toEqual(["assets/a.pdf"]);
  });

  it("après annulation totale, une nouvelle demande relance une requête", async () => {
    const { resolver, query, pending } = setup();
    const c = new AbortController();
    const p = resolver.resolve(nb(1), true, c.signal);
    c.abort(new Error("stop"));
    await p.catch(() => undefined);
    const again = resolver.resolve(nb(1), true);
    expect(query).toHaveBeenCalledTimes(2);
    pending[1]?.resolve(ok("assets/z.pdf"));
    expect([...(await again)]).toEqual(["assets/z.pdf"]);
  });

  it("construit la requête SQL de la portée (document + enfants)", async () => {
    const { resolver, pending } = setup();
    const ID = "20210808180117-czj9bvb";
    const p = resolver.resolve({ kind: "document", box: BOX, docPath: `/${ID}.sy`, label: "d" }, true);
    expect(pending[0]?.sql).toContain(`docpath like '/${ID}/%'`);
    pending[0]?.resolve(ok());
    await p;
  });
});
