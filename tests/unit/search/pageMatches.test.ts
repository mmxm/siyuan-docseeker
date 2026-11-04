import { describe, expect, it, vi } from "vitest";
import type { PageMatch } from "../../../src/core/codec/decode";
import { createPageMatchService } from "../../../src/search/pageMatches";

function setup(opts: { bytes?: (id: string) => Uint8Array; maxBytesFiles?: number; maxPages?: number } = {}) {
  const readDsx = vi.fn(async (id: string) => (opts.bytes ? opts.bytes(id) : new Uint8Array(10)));
  const decode = vi.fn(
    async (_b: Uint8Array, page: number, wanted: (t: string) => boolean): Promise<PageMatch> => ({
      boxes: [],
      ordinals: [page, wanted("plan") ? 1 : 0],
    }) as unknown as PageMatch,
  );
  const service = createPageMatchService({
    readDsx,
    decode: decode as never,
    ...(opts.maxBytesFiles !== undefined ? { maxBytesFiles: opts.maxBytesFiles } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
  return { readDsx, decode, service };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPageMatchService", () => {
  it("lit le fichier une fois pour plusieurs pages", async () => {
    const { service, readDsx, decode } = setup();
    await service.getPageMatches("d", 1, "plan");
    await service.getPageMatches("d", 2, "plan");
    expect(readDsx).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("passe un matcher issu de la requete", async () => {
    const { service } = setup();
    expect((await service.getPageMatches("d", 3, "plan")).ordinals).toEqual([3, 1]);
    expect((await service.getPageMatches("d", 3, "zzz")).ordinals).toEqual([3, 0]);
  });

  it("met en cache par requete normalisee", async () => {
    const { service, decode } = setup();
    const a = await service.getPageMatches("d", 1, "Plan  RECH");
    const b = await service.getPageMatches("d", 1, "plan rech");
    expect(b).toBe(a);
    expect(decode).toHaveBeenCalledTimes(1);
    await service.getPageMatches("d", 1, "autre");
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("deduplique les appels en vol identiques", async () => {
    const gate = deferred<Uint8Array>();
    const { service, readDsx, decode } = setup();
    readDsx.mockImplementation(() => gate.promise);
    const p1 = service.getPageMatches("d", 1, "plan");
    const p2 = service.getPageMatches("d", 1, "plan");
    const p3 = service.getPageMatches("d", 2, "plan");
    gate.resolve(new Uint8Array(4));
    const [r1, r2] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r2);
    expect(readDsx).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("rejette tout de suite si le signal est deja annule, sans lire", async () => {
    const { service, readDsx } = setup();
    const ctl = new AbortController();
    ctl.abort();
    await expect(service.getPageMatches("d", 1, "plan", ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(readDsx).not.toHaveBeenCalled();
  });

  it("l'annulation d'un demandeur n'annule pas l'appel partage ni le cache", async () => {
    const gate = deferred<Uint8Array>();
    const { service, readDsx, decode } = setup();
    readDsx.mockImplementation(() => gate.promise);
    const ctl = new AbortController();
    const aborted = service.getPageMatches("d", 1, "plan", ctl.signal);
    const other = service.getPageMatches("d", 1, "plan");
    ctl.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve(new Uint8Array(4));
    const result = await other;
    expect(result.ordinals).toEqual([1, 1]);
    expect(await service.getPageMatches("d", 1, "plan")).toBe(result);
    expect(readDsx).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("un appel annule seul remplit quand meme le cache", async () => {
    const gate = deferred<Uint8Array>();
    const { service, readDsx, decode } = setup();
    readDsx.mockImplementation(() => gate.promise);
    const ctl = new AbortController();
    const p = service.getPageMatches("d", 1, "plan", ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve(new Uint8Array(4));
    await service.getPageMatches("d", 1, "plan");
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("propage une erreur de lecture sans la mettre en cache", async () => {
    const { service, readDsx } = setup();
    readDsx.mockRejectedValueOnce(new Error("io"));
    await expect(service.getPageMatches("d", 1, "plan")).rejects.toThrow("io");
    await expect(service.getPageMatches("d", 1, "plan")).resolves.toBeDefined();
    expect(readDsx).toHaveBeenCalledTimes(2);
  });

  it("propage une erreur de decodage sans la mettre en cache", async () => {
    const { service, decode } = setup();
    decode.mockRejectedValueOnce(new Error("corrupt"));
    await expect(service.getPageMatches("d", 1, "plan")).rejects.toThrow("corrupt");
    await expect(service.getPageMatches("d", 1, "plan")).resolves.toBeDefined();
  });

  it("invalidate purge octets et resultats", async () => {
    const { service, readDsx, decode } = setup();
    await service.getPageMatches("d", 1, "plan");
    service.invalidate("d");
    await service.getPageMatches("d", 1, "plan");
    expect(readDsx).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("invalidate ne purge pas les autres documents", async () => {
    const { service, readDsx } = setup();
    await service.getPageMatches("a", 1, "plan");
    await service.getPageMatches("b", 1, "plan");
    service.invalidate("a");
    await service.getPageMatches("b", 1, "plan");
    expect(readDsx).toHaveBeenCalledTimes(2);
  });

  it("invalidate pendant un appel en vol n'insere pas un resultat perime", async () => {
    const gate = deferred<Uint8Array>();
    const { service, readDsx, decode } = setup();
    readDsx.mockImplementationOnce(() => gate.promise);
    const stale = service.getPageMatches("d", 1, "plan");
    service.invalidate("d");
    gate.resolve(new Uint8Array(4));
    await stale;
    await service.getPageMatches("d", 1, "plan");
    expect(readDsx).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("evince les fichiers les plus anciens au-dela du plafond d'octets", async () => {
    const { service, readDsx } = setup({ bytes: () => new Uint8Array(60), maxBytesFiles: 100 });
    await service.getPageMatches("a", 1, "x");
    await service.getPageMatches("b", 1, "x");
    await service.getPageMatches("a", 2, "x");
    expect(readDsx).toHaveBeenCalledTimes(3);
  });

  it("garde un fichier plus gros que le plafond sans casser", async () => {
    const { service } = setup({ bytes: () => new Uint8Array(500), maxBytesFiles: 100 });
    await expect(service.getPageMatches("a", 1, "x")).resolves.toBeDefined();
  });

  it("limite le LRU de resultats", async () => {
    const { service, decode } = setup({ maxPages: 2 });
    await service.getPageMatches("d", 1, "x");
    await service.getPageMatches("d", 2, "x");
    await service.getPageMatches("d", 1, "x"); // 1 devient recent
    await service.getPageMatches("d", 3, "x"); // evince 2
    expect(decode).toHaveBeenCalledTimes(3);
    await service.getPageMatches("d", 1, "x");
    expect(decode).toHaveBeenCalledTimes(3);
    await service.getPageMatches("d", 2, "x");
    expect(decode).toHaveBeenCalledTimes(4);
  });

  it("requete non cherchable : resultat vide sans planter", async () => {
    const { service } = setup();
    await expect(service.getPageMatches("d", 1, "  ")).resolves.toBeDefined();
  });
});
