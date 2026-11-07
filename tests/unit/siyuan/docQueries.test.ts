import { describe, expect, it, vi } from "vitest";
import { SCOPE_SQL_LIMIT, ScopeTooLargeError, type DocumentScope } from "../../../src/search/docScope";
import { KernelApiError, MalformedResponseError, createKernelApi, type SqlResult } from "../../../src/siyuan/kernelApi";
import { DocTreeTooLargeError } from "../../../src/search/docTree";
import { listDocTree, queryDocAssets } from "../../../src/siyuan/docQueries";

const BOX = "20210808180117-6v0mkxr";
const scope: DocumentScope = { kind: "notebook", box: BOX, label: "Cahier" };
const fakeSql = (result: SqlResult) => ({ sql: vi.fn(async (_stmt: string, _signal?: AbortSignal) => result) });

describe("queryDocAssets", () => {
  it("envoie la requête construite, avec un LIMIT explicite, et le signal", async () => {
    const k = fakeSql({ rows: [], truncated: false });
    const controller = new AbortController();
    await queryDocAssets(k, scope, true, controller.signal);
    expect(k.sql).toHaveBeenCalledTimes(1);
    expect(k.sql.mock.calls[0]?.[0]).toBe(
      `select distinct path from assets where box = '${BOX}' and lower(path) like '%.pdf' limit ${SCOPE_SQL_LIMIT}`,
    );
    expect(k.sql.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(SCOPE_SQL_LIMIT).toBe(50000);
  });

  it("renvoie un ensemble de chemins NFC, doublons fusionnés (NFD et NFC)", async () => {
    const k = fakeSql({
      rows: [{ path: "assets/été.pdf" }, { path: "assets/été.pdf" }, { path: "assets/b.pdf" }],
      truncated: false,
    });
    const paths = await queryDocAssets(k, scope, true);
    expect([...paths].sort()).toEqual(["assets/b.pdf", "assets/été.pdf"]);
  });

  it("rejette en ScopeTooLargeError si le noyau a tronqué", async () => {
    await expect(queryDocAssets(fakeSql({ rows: [{ path: "assets/a.pdf" }], truncated: true }), scope, true)).rejects.toBeInstanceOf(
      ScopeTooLargeError,
    );
  });

  it("rejette en ScopeTooLargeError si 50000 lignes sont reçues (troncature silencieuse possible)", async () => {
    const rows = Array.from({ length: SCOPE_SQL_LIMIT }, (_, i) => ({ path: `assets/${i}.pdf` }));
    await expect(queryDocAssets(fakeSql({ rows, truncated: false }), scope, true)).rejects.toBeInstanceOf(ScopeTooLargeError);
    const justUnder = rows.slice(1);
    expect((await queryDocAssets(fakeSql({ rows: justUnder, truncated: false }), scope, true)).size).toBe(SCOPE_SQL_LIMIT - 1);
  });

  it("une ligne sans chemin texte est une réponse mal formée, jamais ignorée", async () => {
    await expect(queryDocAssets(fakeSql({ rows: [{ path: 3 }], truncated: false }), scope, true)).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
    await expect(queryDocAssets(fakeSql({ rows: [{}], truncated: false }), scope, true)).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("propage l'erreur du noyau telle quelle", async () => {
    const boom = new Error("kernel down");
    await expect(queryDocAssets({ sql: async () => Promise.reject(boom) }, scope, true)).rejects.toBe(boom);
  });
});

describe("listDocTree", () => {
  const ID = "20210808180118-abcdefg";
  const notebooks = [{ id: BOX, name: "Cahier", closed: false }];
  const make = (result: SqlResult, nb = notebooks) => ({
    sql: vi.fn(async (_stmt: string, _signal?: AbortSignal) => result),
    lsNotebooks: vi.fn(async (_signal?: AbortSignal) => nb),
  });

  it("lit cahiers et documents (LIMIT explicite, signal propagé) et construit l'arbre", async () => {
    const k = make({ rows: [{ box: BOX, path: `/${ID}.sy`, hpath: "/Doc" }], truncated: false });
    const controller = new AbortController();
    const tree = await listDocTree(k, controller.signal);
    expect(k.sql.mock.calls[0]?.[0]).toBe("select box, path, hpath from blocks where type='d' order by path limit 20000");
    expect(k.sql.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(k.lsNotebooks.mock.calls[0]?.[0]).toBe(controller.signal);
    expect(tree.map((n) => n.label)).toEqual(["Cahier", "Doc"]);
  });

  it("DocTreeTooLargeError si tronqué ou si 20000 lignes", async () => {
    await expect(listDocTree(make({ rows: [], truncated: true }))).rejects.toBeInstanceOf(DocTreeTooLargeError);
    const rows = Array.from({ length: 20000 }, () => ({ box: BOX, path: `/${ID}.sy`, hpath: "/D" }));
    await expect(listDocTree(make({ rows, truncated: false }))).rejects.toBeInstanceOf(DocTreeTooLargeError);
  });

  it("ligne mal formée (champ manquant, chemin invalide) -> MalformedResponseError", async () => {
    const bad = [
      { box: BOX, path: `/${ID}.sy` },
      { box: BOX, path: "/x' OR 1=1", hpath: "/D" },
      { box: "nope", path: `/${ID}.sy`, hpath: "/D" },
    ];
    for (const row of bad) {
      await expect(listDocTree(make({ rows: [row], truncated: false }))).rejects.toBeInstanceOf(MalformedResponseError);
    }
  });

  it("propage l'échec de lsNotebooks", async () => {
    const k = make({ rows: [], truncated: false });
    const boom = new Error("ls down");
    k.lsNotebooks.mockRejectedValueOnce(boom);
    await expect(listDocTree(k)).rejects.toBe(boom);
  });
});

describe("réponses HTTP invalides du noyau : une erreur, jamais une liste vide", () => {
  const apiWith = (body: string) => createKernelApi({ fetch: async () => new Response(body, { status: 200 }) });
  const bad = ["{pas du json", "", JSON.stringify({ code: -1, msg: "", data: null }), JSON.stringify({ code: 0, msg: "", data: { a: 1 } })];

  it.each(bad)("listDocTree rejette (corps %j)", async (body) => {
    const outcome = await listDocTree(apiWith(body)).then(
      (tree) => tree,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(KernelApiError);
  });

  it.each(bad)("queryDocAssets rejette (corps %j)", async (body) => {
    const outcome = await queryDocAssets(apiWith(body), scope, true).then(
      (paths) => paths,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(KernelApiError);
  });
});
