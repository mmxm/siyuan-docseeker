import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IndexUnavailableError,
  KernelApiError,
  MalformedResponseError,
  NotFoundError,
  createKernelApi,
  type FetchLike,
} from "../../../src/siyuan/kernelApi";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

function recording(body: unknown): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      return json(body);
    },
  };
}

describe("KernelApi.sql", () => {
  it("POST /api/query/sql {stmt} et renvoie rows + truncated", async () => {
    const k = recording({ code: 0, msg: "", data: [{ path: "assets/a.pdf" }], limit: 50000, truncated: false });
    const api = createKernelApi({ fetch: k.fetch });
    const result = await api.sql("select 1");
    expect(result).toEqual({ rows: [{ path: "assets/a.pdf" }], truncated: false });
    expect(k.calls[0]?.url).toBe("/api/query/sql");
    expect(k.calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(k.calls[0]?.init.body))).toEqual({ stmt: "select 1" });
  });

  it("truncated vrai est transmis ; absent vaut faux ; data null donne zéro ligne", async () => {
    const t = createKernelApi({ fetch: recording({ code: 0, msg: "", data: [], truncated: true }).fetch });
    expect((await t.sql("s")).truncated).toBe(true);
    const n = createKernelApi({ fetch: recording({ code: 0, msg: "", data: null }).fetch });
    expect(await n.sql("s")).toEqual({ rows: [], truncated: false });
  });

  it.each([
    ["data non tableau", { code: 0, msg: "", data: { a: 1 } }],
    ["ligne non objet", { code: 0, msg: "", data: [1] }],
    ["ligne tableau", { code: 0, msg: "", data: [[]] }],
    ["truncated non booléen", { code: 0, msg: "", data: [], truncated: "yes" }],
  ])("réponse mal formée (%s) -> MalformedResponseError", async (_n, body) => {
    const api = createKernelApi({ fetch: recording(body).fetch });
    await expect(api.sql("s")).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("index pas prêt (data.reason) -> IndexUnavailableError", async () => {
    const api = createKernelApi({
      fetch: recording({ code: -1, msg: "document metadata is not ready", data: { reason: "indexUnavailable" } }).fetch,
    });
    const error = await api.sql("s").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexUnavailableError);
    expect(error).toBeInstanceOf(KernelApiError);
  });

  it("index pas prêt reconnu aussi par le message seul", async () => {
    const api = createKernelApi({ fetch: recording({ code: -1, msg: "document metadata is not ready", data: null }).fetch });
    await expect(api.sql("s")).rejects.toBeInstanceOf(IndexUnavailableError);
  });

  it("autres erreurs : KernelApiError simple ; 404 et 409 inchangés", async () => {
    const generic = createKernelApi({ fetch: recording({ code: -1, msg: "boom", data: { reason: "other" } }).fetch });
    const e = await generic.sql("s").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KernelApiError);
    expect(e).not.toBeInstanceOf(IndexUnavailableError);
    const nf = createKernelApi({ fetch: recording({ code: 404, msg: "x", data: null }).fetch });
    await expect(nf.sql("s")).rejects.toBeInstanceOf(NotFoundError);
    const cf = createKernelApi({ fetch: recording({ code: 409, msg: "x", data: null }).fetch });
    await expect(cf.sql("s")).rejects.toBeInstanceOf(ConflictError);
  });

  it("propage le signal d'annulation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const k = recording({ code: 0, msg: "", data: [] });
    const api = createKernelApi({ fetch: k.fetch });
    await expect(api.sql("s", controller.signal)).rejects.toThrow("stop");
    expect(k.calls).toHaveLength(0);
  });
});

describe("KernelApi.lsNotebooks", () => {
  it("POST /api/notebook/lsNotebooks et renvoie id, name, closed, icon", async () => {
    const k = recording({
      code: 0,
      msg: "",
      data: { notebooks: [{ id: "20210808180117-6v0mkxr", name: "Cahier", closed: false, icon: "1f4d4", sort: 0 }] },
    });
    const api = createKernelApi({ fetch: k.fetch });
    expect(await api.lsNotebooks()).toEqual([{ id: "20210808180117-6v0mkxr", name: "Cahier", closed: false, icon: "1f4d4" }]);
    expect(k.calls[0]?.url).toBe("/api/notebook/lsNotebooks");
    expect(JSON.parse(String(k.calls[0]?.init.body))).toEqual({});
  });

  it.each([
    ["data null", null],
    ["notebooks absent", {}],
    ["entrée sans id", { notebooks: [{ name: "a", closed: false }] }],
    ["closed non booléen", { notebooks: [{ id: "a", name: "a", closed: 0 }] }],
  ])("mal formé (%s) -> MalformedResponseError", async (_n, data) => {
    const api = createKernelApi({ fetch: recording({ code: 0, msg: "", data }).fetch });
    await expect(api.lsNotebooks()).rejects.toBeInstanceOf(MalformedResponseError);
  });
});

describe("corps HTTP invalides : toujours une erreur typée, jamais une liste vide", () => {
  const raw = (body: string, status = 200): { fetch: FetchLike } => ({ fetch: async () => new Response(body, { status }) });
  const bodies: [string, string][] = [
    ["JSON invalide", "{pas du json"],
    ["corps vide", ""],
    ["HTML d'un proxy", "<html>502</html>"],
    ["tableau JSON", "[]"],
    ["code absent", JSON.stringify({ data: [] })],
    ["code non zéro, msg vide", JSON.stringify({ code: -1, msg: "", data: null })],
    ["code non zéro, data tableau vide", JSON.stringify({ code: 1, msg: "", data: [] })],
    ["data objet au lieu de tableau", JSON.stringify({ code: 0, msg: "", data: { rows: [] } })],
  ];
  it.each(bodies)("sql : %s", async (_n, body) => {
    const result = await createKernelApi(raw(body)).sql("s").then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(result).toBeInstanceOf(KernelApiError);
  });
  it.each(bodies.filter(([n]) => n !== "data objet au lieu de tableau"))("lsNotebooks : %s", async (_n, body) => {
    const result = await createKernelApi(raw(body)).lsNotebooks().then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(result).toBeInstanceOf(KernelApiError);
  });
  it("statut HTTP 500 avec corps vide", async () => {
    await expect(createKernelApi(raw("", 500)).sql("s")).rejects.toBeInstanceOf(KernelApiError);
  });
});
