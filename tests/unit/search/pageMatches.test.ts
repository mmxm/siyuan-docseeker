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

  it("passe aussi un indexeur de termes a decode", async () => {
    const seen: number[] = [];
    const readDsx = vi.fn(async () => new Uint8Array(1));
    const decode = vi.fn(async (_b: Uint8Array, _p: number, _w: unknown, _l: unknown, indexesOf?: (t: string) => readonly number[]) => {
      seen.push(...(indexesOf?.("classification") ?? [-2]), ...(indexesOf?.("bpco") ?? [-2]));
      return { boxes: [], ordinals: [], pageSize: { widthPt: 595, heightPt: 842 } } as PageMatch;
    });
    const service = createPageMatchService({ readDsx, decode: decode as never });
    await service.getPageMatches("d", 1, "classification bpco");
    expect(seen).toEqual([0, 1]);
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
  describe("getPagesMatches", () => {
    function setupPages() {
      const readDsx = vi.fn(async () => new Uint8Array(10));
      const decode = vi.fn(async (_b: Uint8Array, page: number): Promise<PageMatch> => ({ boxes: [], ordinals: [page] }) as unknown as PageMatch);
      const decodePages = vi.fn(async (_b: Uint8Array, pages: readonly number[]) =>
        new Map(pages.map((p) => [p, { boxes: [], ordinals: [p] } as unknown as PageMatch])),
      );
      const service = createPageMatchService({ readDsx, decode: decode as never, decodePages: decodePages as never });
      return { readDsx, decode, decodePages, service };
    }

    it("lit le fichier et decode une seule fois pour plusieurs pages, resultats identiques a l'appel page par page", async () => {
      const { service, readDsx, decodePages, decode } = setupPages();
      const many = await service.getPagesMatches("d", [1, 2, 3], "plan");
      expect(readDsx).toHaveBeenCalledTimes(1);
      expect(decodePages).toHaveBeenCalledTimes(1);
      expect(decodePages.mock.calls[0]?.[1]).toEqual([1, 2, 3]);
      for (const page of [1, 2, 3]) expect(many.get(page)).toEqual(await service.getPageMatches("d", page, "plan"));
      expect(decode).toHaveBeenCalledTimes(3); // le lot ne remplit pas le cache : chaque page est redecodee
    });

    it("ne met pas ses resultats en cache : le lot du re-classement n'evince pas les pages affichees", async () => {
      const readDsx = vi.fn(async () => new Uint8Array(10));
      const decode = vi.fn(async (_b: Uint8Array, page: number) => ({ boxes: [], ordinals: [page] }) as unknown as PageMatch);
      const decodePages = vi.fn(async (_b: Uint8Array, pages: readonly number[]) =>
        new Map(pages.map((p) => [p, { boxes: [], ordinals: [p] } as unknown as PageMatch])),
      );
      const service = createPageMatchService({ readDsx, decode: decode as never, decodePages: decodePages as never, maxPages: 2 });
      await service.getPageMatches("shown", 1, "plan"); // page affichee, en cache
      for (let i = 0; i < 6; i++) await service.getPagesMatches(`doc${i}`, [1, 2, 3, 4, 5], "plan"); // 30 pages mesurees
      expect(decode).toHaveBeenCalledTimes(1);
      await service.getPageMatches("shown", 1, "plan");
      expect(decode).toHaveBeenCalledTimes(1); // toujours en cache
    });

    it("reutilise une page deja en cache (affichee) sans la redecoder", async () => {
      const { service, decodePages } = setupPages();
      await service.getPageMatches("d", 2, "plan");
      await service.getPagesMatches("d", [1, 2], "plan");
      expect(decodePages).toHaveBeenCalledTimes(1);
      expect(decodePages.mock.calls[0]?.[1]).toEqual([1]);
    });

    it("mutualise un appel en vol et fusionne les doublons", async () => {
      const { service, decodePages } = setupPages();
      const [a, b] = await Promise.all([
        service.getPagesMatches("d", [1, 1, 2], "plan"),
        service.getPagesMatches("d", [1, 2], "plan"),
      ]);
      expect(decodePages).toHaveBeenCalledTimes(1);
      expect([...a.keys()]).toEqual([1, 2]);
      expect([...b.keys()]).toEqual([1, 2]);
    });

    it("liste vide : table vide sans lecture", async () => {
      const { service, readDsx } = setupPages();
      expect((await service.getPagesMatches("d", [], "plan")).size).toBe(0);
      expect(readDsx).not.toHaveBeenCalled();
    });

    it("signal deja annule : rejette sans travail ; annule en cours : rejette sans interrompre le partage", async () => {
      const { service, readDsx } = setupPages();
      const ac = new AbortController();
      ac.abort();
      await expect(service.getPagesMatches("d", [1], "plan", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(readDsx).not.toHaveBeenCalled();
      const gate = deferred<Uint8Array<ArrayBuffer>>();
      readDsx.mockImplementationOnce(() => gate.promise);
      const live = new AbortController();
      const pending = service.getPagesMatches("d", [1], "plan", live.signal);
      live.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      gate.resolve(new Uint8Array(2));
      await service.getPagesMatches("d", [1], "plan"); // le fichier lu par le travail partagé est réutilisé
      expect(readDsx).toHaveBeenCalledTimes(1);
    });

    it("invalidate pendant l'appel : aucun resultat perime en cache", async () => {
      const { service, readDsx, decodePages } = setupPages();
      const gate = deferred<Uint8Array<ArrayBuffer>>();
      readDsx.mockImplementationOnce(() => gate.promise);
      const stale = service.getPagesMatches("d", [1, 2], "plan");
      service.invalidate("d");
      gate.resolve(new Uint8Array(2));
      await stale;
      await service.getPagesMatches("d", [1, 2], "plan");
      expect(decodePages).toHaveBeenCalledTimes(2);
    });

    it("propage une erreur de decodage sans mettre en cache", async () => {
      const { service, decodePages } = setupPages();
      decodePages.mockRejectedValueOnce(new Error("corrupt"));
      await expect(service.getPagesMatches("d", [1, 2], "plan")).rejects.toThrow("corrupt");
      await expect(service.getPagesMatches("d", [1, 2], "plan")).resolves.toBeDefined();
    });

    it("sans decodeur multi-pages injecte avec un decode personnalise : repli page par page", async () => {
      const { service, decode } = setup();
      const out = await service.getPagesMatches("d", [1, 2], "plan");
      expect(decode).toHaveBeenCalledTimes(2);
      expect([...out.keys()]).toEqual([1, 2]);
    });
  });
});
