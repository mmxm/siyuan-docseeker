import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  DEFAULT_TIMEOUT_MS,
  KernelApiError,
  KernelTimeoutError,
  MalformedResponseError,
  NotFoundError,
  createKernelApi,
  type FetchLike,
} from "../../../src/siyuan/kernelApi";

/**
 * Faux noyau en mémoire. Reproduit les conventions VÉRIFIÉES dans le code Go
 * (kernel/api/file.go, kernel/apicontract/contracts.go) :
 *  - endpoints JSON : HTTP 200 + enveloppe {code,msg,data}, code != 0 en cas d'échec ;
 *  - getFile : succès = HTTP 200 + octets bruts ; échec = HTTP 202 + enveloppe JSON ;
 *  - renameFile : 409 si la destination existe ;
 *  - putFile : formulaire multipart (path, isDir, modTime, file).
 */
interface FakeKernel {
  readonly fetch: FetchLike;
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Map<string, { name: string; isDir: boolean; isSymlink: boolean; updated: number }[]>;
  readonly calls: { url: string; init: RequestInit }[];
  readonly assetSizes: Map<string, string | null>;
}

const envelope = (code: number, msg: string, data: unknown = null): Response =>
  new Response(JSON.stringify({ code, msg, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function createFakeKernel(): FakeKernel {
  const files = new Map<string, Uint8Array>();
  const dirs: FakeKernel["dirs"] = new Map();
  const calls: FakeKernel["calls"] = [];
  const assetSizes = new Map<string, string | null>();

  const handleJson = (url: string, body: Record<string, string>): Response => {
    if (url.endsWith("/api/file/readDir")) {
      const entries = dirs.get(body.path ?? "");
      if (entries === undefined) return envelope(404, "path does not exist");
      return envelope(0, "", entries);
    }
    if (url.endsWith("/api/file/removeFile")) {
      if (!files.delete(body.path ?? "")) return envelope(404, "path does not exist");
      return envelope(0, "", null);
    }
    if (url.endsWith("/api/file/renameFile")) {
      const source = files.get(body.path ?? "");
      if (source === undefined) return envelope(404, "no such file");
      if (files.has(body.newPath ?? "")) return envelope(409, "Field [newPath]: path already exists");
      files.delete(body.path ?? "");
      files.set(body.newPath ?? "", source);
      return envelope(0, "", null);
    }
    if (url.endsWith("/api/file/getFile")) {
      const content = files.get(body.path ?? "");
      if (content === undefined) {
        return new Response(JSON.stringify({ code: 404, msg: "no such file", data: null }), { status: 202 });
      }
      return new Response(content as Uint8Array<ArrayBuffer>, { status: 200, headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  };

  const handlePut = async (form: FormData): Promise<Response> => {
    const path = String(form.get("path"));
    const file = form.get("file");
    if (!(file instanceof Blob)) return envelope(400, "Field [file] must not be empty");
    files.set(path, new Uint8Array(await file.arrayBuffer()));
    return envelope(0, "", null);
  };

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (init.method === "HEAD") {
      const path = decodeURIComponent(new URL(url, "http://k").pathname);
      const length = assetSizes.get(path);
      if (length === undefined) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: length === null ? {} : { "Content-Length": length } });
    }
    if (init.method === "GET") {
      const path = decodeURIComponent(new URL(url, "http://k").pathname);
      const length = assetSizes.get(path);
      if (length === undefined) return new Response(null, { status: 404 });
      return new Response("%", { status: 206, headers: { "Content-Range": `bytes 0-0/${length ?? ""}` } });
    }
    if (init.body instanceof FormData) return handlePut(init.body);
    return handleJson(url, JSON.parse(String(init.body)) as Record<string, string>);
  };
  return { fetch: fetchImpl, files, dirs, calls, assetSizes };
}

describe("createKernelApi", () => {
  it("readDir : POST JSON {path}, cookie de session, aucun jeton stocké", async () => {
    const kernel = createFakeKernel();
    kernel.dirs.set("/data/assets", [{ name: "a.pdf", isDir: false, isSymlink: false, updated: 1700000000 }]);
    const api = createKernelApi({ fetch: kernel.fetch });

    const entries = await api.readDir("/data/assets");

    expect(entries).toEqual([{ name: "a.pdf", isDir: false, isSymlink: false, updated: 1700000000 }]);
    const call = kernel.calls[0];
    expect(call?.url).toBe("/api/file/readDir");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(call?.init.body))).toEqual({ path: "/data/assets" });
    const headers = new Headers(call?.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it("préfixe les URL avec baseUrl", async () => {
    const kernel = createFakeKernel();
    kernel.dirs.set("/data", []);
    const api = createKernelApi({ fetch: kernel.fetch, baseUrl: "http://127.0.0.1:6806" });
    await api.readDir("/data");
    expect(kernel.calls[0]?.url).toBe("http://127.0.0.1:6806/api/file/readDir");
  });

  it("readDir : dossier absent -> NotFoundError ; fichier -> ConflictError", async () => {
    const kernel = createFakeKernel();
    const api = createKernelApi({ fetch: kernel.fetch });
    await expect(api.readDir("/data/nope")).rejects.toBeInstanceOf(NotFoundError);
    const conflict = createKernelApi({
      fetch: async () => envelope(409, "path is not a directory"),
    });
    await expect(conflict.readDir("/data/x.pdf")).rejects.toBeInstanceOf(ConflictError);
  });

  it("getFile : renvoie les octets bruts (y compris 0x00 et 0xff)", async () => {
    const kernel = createFakeKernel();
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    kernel.files.set("/data/storage/x.bin", bytes);
    const api = createKernelApi({ fetch: kernel.fetch });
    expect(await api.getFile("/data/storage/x.bin")).toEqual(bytes);
  });

  it("getFile : fichier absent (HTTP 202 + enveloppe 404) -> NotFoundError", async () => {
    const api = createKernelApi({ fetch: createFakeKernel().fetch });
    const error = await api.getFile("/data/missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).status).toBe(202);
    expect((error as NotFoundError).code).toBe(404);
  });

  it("getFile : un fichier JSON légitime (HTTP 200) n'est pas pris pour une erreur", async () => {
    const kernel = createFakeKernel();
    const json = new TextEncoder().encode('{"code":404,"msg":"leurre"}');
    kernel.files.set("/data/storage/leurre.json", json);
    const api = createKernelApi({ fetch: kernel.fetch });
    expect(await api.getFile("/data/storage/leurre.json")).toEqual(json);
  });

  it("getFile : autre échec du noyau -> KernelApiError avec status, code, message", async () => {
    const api = createKernelApi({
      fetch: async () => new Response(JSON.stringify({ code: -3, msg: "encrypted", data: null }), { status: 202 }),
    });
    const error = await api.getFile("/data/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KernelApiError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 202, code: -3, message: expect.stringContaining("encrypted") });
  });

  it("getFile : corps d'erreur illisible -> KernelApiError (pas de crash JSON)", async () => {
    const api = createKernelApi({ fetch: async () => new Response("<html>", { status: 502 }) });
    await expect(api.getFile("/data/x")).rejects.toMatchObject({ status: 502 });
  });

  it("getFile : HTTP 404 brut sans enveloppe (proxy, mauvaise baseUrl) -> KernelApiError, PAS NotFoundError", async () => {
    // Adapté : un 404 sans enveloppe du noyau n'est pas « fichier absent » (risque d'écrasement d'index).
    const api = createKernelApi({ fetch: async () => new Response("nope", { status: 404 }) });
    const error = await api.getFile("/data/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KernelApiError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404 });
  });

  it("endpoint JSON : HTTP 404 brut -> KernelApiError, enveloppe code 404 -> NotFoundError", async () => {
    const raw = createKernelApi({ fetch: async () => new Response("<html>", { status: 404 }) });
    const error = await raw.readDir("/data").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toBeInstanceOf(KernelApiError);
    const wrapped = createKernelApi({
      fetch: async () => new Response(JSON.stringify({ code: 404, msg: "x", data: null }), { status: 404 }),
    });
    await expect(wrapped.readDir("/data")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("message d'erreur tronqué à 200 caractères", async () => {
    const api = createKernelApi({ fetch: async () => new Response("x".repeat(5000), { status: 502 }) });
    const error = (await api.getFile("/data/x").catch((e: unknown) => e)) as KernelApiError;
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message.startsWith("xxx")).toBe(true);
    const long = createKernelApi({
      fetch: async () => envelope(500, "m".repeat(5000)),
    });
    const envelopeError = (await long.removeFile("/data/x").catch((e: unknown) => e)) as KernelApiError;
    expect(envelopeError.message.length).toBeLessThanOrEqual(200);
  });

  it("putFile : multipart path/isDir/modTime/file, aller-retour des octets", async () => {
    const kernel = createFakeKernel();
    const api = createKernelApi({ fetch: kernel.fetch });
    const bytes = new Uint8Array([9, 0, 255, 7]);

    await api.putFile("/data/storage/petal/a.tmp", bytes, 1700000000123);

    const form = kernel.calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("path")).toBe("/data/storage/petal/a.tmp");
    expect(form.get("isDir")).toBe("false");
    expect(form.get("modTime")).toBe("1700000000123");
    expect(kernel.calls[0]?.init.credentials).toBe("same-origin");
    expect(new Headers(kernel.calls[0]?.init.headers).has("content-type")).toBe(false);
    expect(await api.getFile("/data/storage/petal/a.tmp")).toEqual(bytes);
  });

  it("putFile : modTime par défaut = maintenant (millisecondes)", async () => {
    const kernel = createFakeKernel();
    const api = createKernelApi({ fetch: kernel.fetch });
    const before = Date.now();
    await api.putFile("/data/storage/x", new Uint8Array(0));
    const modTime = Number((kernel.calls[0]?.init.body as FormData).get("modTime"));
    expect(modTime).toBeGreaterThanOrEqual(before);
    expect(modTime).toBeLessThanOrEqual(Date.now());
    expect(kernel.files.get("/data/storage/x")).toEqual(new Uint8Array(0));
  });

  it("putFile : échec du noyau -> KernelApiError", async () => {
    const api = createKernelApi({ fetch: async () => envelope(400, "invalid file path") });
    await expect(api.putFile("/data/x", new Uint8Array(1))).rejects.toMatchObject({ code: 400 });
  });

  it("removeFile : supprime ; absent -> NotFoundError", async () => {
    const kernel = createFakeKernel();
    kernel.files.set("/data/a", new Uint8Array(1));
    const api = createKernelApi({ fetch: kernel.fetch });
    await api.removeFile("/data/a");
    expect(kernel.files.has("/data/a")).toBe(false);
    expect(JSON.parse(String(kernel.calls[0]?.init.body))).toEqual({ path: "/data/a" });
    await expect(api.removeFile("/data/a")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("renameFile : corps {path,newPath} ; destination existante -> ConflictError ; source absente -> NotFoundError", async () => {
    const kernel = createFakeKernel();
    kernel.files.set("/data/a", new Uint8Array([1]));
    kernel.files.set("/data/b", new Uint8Array([2]));
    const api = createKernelApi({ fetch: kernel.fetch });

    await expect(api.renameFile("/data/a", "/data/b")).rejects.toBeInstanceOf(ConflictError);
    expect(kernel.files.get("/data/b")).toEqual(new Uint8Array([2]));
    await api.renameFile("/data/a", "/data/c");
    expect(JSON.parse(String(kernel.calls[1]?.init.body))).toEqual({ path: "/data/a", newPath: "/data/c" });
    expect(kernel.files.get("/data/c")).toEqual(new Uint8Array([1]));
    await expect(api.renameFile("/data/zzz", "/data/d")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("endpoint JSON : HTTP non-2xx (ex. 401) -> KernelApiError avec le status", async () => {
    const api = createKernelApi({ fetch: async () => new Response("Unauthorized", { status: 401 }) });
    await expect(api.removeFile("/data/a")).rejects.toMatchObject({ status: 401 });
  });

  it("endpoint JSON : corps 200 non JSON -> KernelApiError", async () => {
    const api = createKernelApi({ fetch: async () => new Response("<html>", { status: 200 }) });
    await expect(api.readDir("/data")).rejects.toBeInstanceOf(KernelApiError);
  });

  it("endpoint JSON : données absentes pour readDir -> liste vide", async () => {
    const api = createKernelApi({ fetch: async () => envelope(0, "", null) });
    expect(await api.readDir("/data")).toEqual([]);
  });

  it("une panne réseau traverse telle quelle", async () => {
    const boom = new TypeError("Failed to fetch");
    const api = createKernelApi({ fetch: vi.fn().mockRejectedValue(boom) });
    await expect(api.readDir("/data")).rejects.toBe(boom);
  });

  it("headAsset : HEAD, taille = Content-Length, segments encodés", async () => {
    const kernel = createFakeKernel();
    kernel.assetSizes.set("/assets/sous dossier/é.pdf", "173015040");
    const api = createKernelApi({ fetch: kernel.fetch });

    expect(await api.headAsset("/assets/sous dossier/é.pdf")).toEqual({ size: 173015040 });
    expect(kernel.calls[0]?.init.method).toBe("HEAD");
    expect(kernel.calls[0]?.init.credentials).toBe("same-origin");
    expect(kernel.calls[0]?.url).toBe("/assets/sous%20dossier/%C3%A9.pdf");
  });

  it("headAsset : 404 -> NotFoundError ; Content-Length absent ou invalide -> KernelApiError", async () => {
    const kernel = createFakeKernel();
    kernel.assetSizes.set("/assets/nolen.pdf", null);
    kernel.assetSizes.set("/assets/bad.pdf", "abc");
    kernel.assetSizes.set("/assets/neg.pdf", "-5");
    const api = createKernelApi({ fetch: kernel.fetch });
    await expect(api.headAsset("/assets/zzz.pdf")).rejects.toBeInstanceOf(NotFoundError);
    for (const name of ["nolen", "bad", "neg"]) {
      await expect(api.headAsset(`/assets/${name}.pdf`)).rejects.toBeInstanceOf(KernelApiError);
    }
  });

  // Constaté dans un vrai SiYuan 3.8.9 (diagnostic M0) : HEAD renvoie 404 pour un asset au nom accentué
  // alors que GET avec Range répond 206. Repli : GET Range bytes=0-0, taille lue dans Content-Range.
  it("headAsset : HEAD 404 puis GET Range 206 -> taille depuis Content-Range", async () => {
    const calls: { method: string | undefined; range: string | null }[] = [];
    const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method, range: new Headers(init?.headers).get("Range") });
      if (init?.method === "HEAD") return new Response("404 page not found", { status: 404 });
      return new Response("%", { status: 206, headers: { "Content-Range": "bytes 0-0/164843520" } });
    };
    const api = createKernelApi({ fetch: fetchMock });
    expect(await api.headAsset("/assets/Méd.pdf")).toEqual({ size: 164843520 });
    expect(calls).toEqual([
      { method: "HEAD", range: null },
      { method: "GET", range: "bytes=0-0" },
    ]);
  });

  // Constaté : un PDF vide (0 octet) est servi en 200 sans Content-Range ; sa taille (0) est connue.
  it("headAsset : repli répondu en 200 -> taille depuis Content-Length (fichier vide)", async () => {
    const api = createKernelApi({
      fetch: async (_url, init) =>
        init?.method === "HEAD"
          ? new Response("x", { status: 404 })
          : new Response(null, { status: 200, headers: { "Content-Length": "0" } }),
    });
    expect(await api.headAsset("/assets/vide.pdf")).toEqual({ size: 0 });
  });

  it("headAsset : HEAD 404 et GET Range 404 -> NotFoundError", async () => {
    const api = createKernelApi({ fetch: async () => new Response("nope", { status: 404 }) });
    await expect(api.headAsset("/assets/zzz.pdf")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("headAsset : repli avec Content-Range absent ou invalide -> KernelApiError", async () => {
    for (const contentRange of [null, "bytes 0-0/*", "bytes 0-0/abc"]) {
      const api = createKernelApi({
        fetch: async (_url, init) =>
          init?.method === "HEAD"
            ? new Response("x", { status: 404 })
            : new Response("%", {
                status: 206,
                headers: contentRange === null ? {} : { "Content-Range": contentRange },
              }),
      });
      await expect(api.headAsset("/assets/a.pdf")).rejects.toBeInstanceOf(KernelApiError);
    }
  });

  it("headAsset : accepte un chemin sans slash initial", async () => {
    const kernel = createFakeKernel();
    kernel.assetSizes.set("/assets/a.pdf", "10");
    const api = createKernelApi({ fetch: kernel.fetch });
    expect(await api.headAsset("assets/a.pdf")).toEqual({ size: 10 });
    expect(kernel.calls[0]?.url).toBe("/assets/a.pdf");
  });

  it("readDir : isSymlink absent -> MalformedResponseError (garde anti-boucle non désactivée en silence)", async () => {
    const api = createKernelApi({
      fetch: async () => envelope(0, "", [{ name: "a", isDir: true, updated: 1 }]),
    });
    const error = await api.readDir("/data").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toBeInstanceOf(KernelApiError);
    const nonBoolean = createKernelApi({
      fetch: async () => envelope(0, "", [{ name: "a", isDir: true, isSymlink: "yes", updated: 1 }]),
    });
    await expect(nonBoolean.readDir("/data")).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("readDir : isSymlink true est conservé", async () => {
    const api = createKernelApi({
      fetch: async () => envelope(0, "", [{ name: "l", isDir: true, isSymlink: true, updated: 5 }]),
    });
    expect(await api.readDir("/data")).toEqual([{ name: "l", isDir: true, isSymlink: true, updated: 5 }]);
  });

  describe("délai et annulation", () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const deaf: FetchLike = () => new Promise(() => undefined);

    it("délai par défaut nommé de 30 s et signal transmis à fetch", async () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
      const kernel = createFakeKernel();
      kernel.dirs.set("/d", []);
      await createKernelApi({ fetch: kernel.fetch }).readDir("/d");
      expect(kernel.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each(["readDir", "getFile", "putFile", "removeFile", "renameFile", "headAsset"] as const)(
      "%s : noyau bloqué -> KernelTimeoutError",
      async (op) => {
        const api = createKernelApi({ fetch: hanging, timeoutMs: 15 });
        const call = {
          readDir: () => api.readDir("/d"),
          getFile: () => api.getFile("/d"),
          putFile: () => api.putFile("/d", new Uint8Array(1)),
          removeFile: () => api.removeFile("/d"),
          renameFile: () => api.renameFile("/d", "/e"),
          headAsset: () => api.headAsset("/assets/a.pdf"),
        }[op];
        await expect(call()).rejects.toBeInstanceOf(KernelTimeoutError);
      },
    );

    it("expire même si fetch ignore le signal", async () => {
      const api = createKernelApi({ fetch: deaf, timeoutMs: 15 });
      await expect(api.readDir("/d")).rejects.toBeInstanceOf(KernelTimeoutError);
    });

    it("signal de l'appelant : annulation propagée telle quelle (pas un timeout)", async () => {
      const api = createKernelApi({ fetch: hanging, timeoutMs: 10_000 });
      const controller = new AbortController();
      const pending = api.getFile("/d", controller.signal).catch((e: unknown) => e);
      const reason = new Error("annulé");
      controller.abort(reason);
      const error = await pending;
      expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(KernelTimeoutError);
    });

    it("signal déjà annulé : aucun appel réseau", async () => {
      const kernel = createFakeKernel();
      const api = createKernelApi({ fetch: kernel.fetch });
      const controller = new AbortController();
      controller.abort(new Error("stop"));
      await expect(api.readDir("/d", controller.signal)).rejects.toThrow("stop");
      expect(kernel.calls).toHaveLength(0);
    });
  });
});
