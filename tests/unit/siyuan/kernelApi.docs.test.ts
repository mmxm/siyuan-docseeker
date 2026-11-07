import { describe, expect, it } from "vitest";
import { KernelApiError, MalformedResponseError, createKernelApi, type FetchLike } from "../../../src/siyuan/kernelApi";

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
const bodyOf = (call: { init: RequestInit } | undefined): unknown => JSON.parse(String(call?.init.body));

const BOX = "20261107102214-1y6la12";

describe("KernelApi.lsNotebooks : icône", () => {
  it("renvoie l'icône du cahier (chaîne vide si absente)", async () => {
    const k = recording({
      code: 0,
      msg: "",
      data: { notebooks: [{ id: "a", name: "A", closed: false, icon: "1f4d4" }, { id: "b", name: "B", closed: false }] },
    });
    expect(await createKernelApi({ fetch: k.fetch }).lsNotebooks()).toEqual([
      { id: "a", name: "A", closed: false, icon: "1f4d4" },
      { id: "b", name: "B", closed: false, icon: "" },
    ]);
  });
});

describe("KernelApi.listDocsByPath", () => {
  const file = { path: "/20261107102226-6b6v11l.sy", name: "Parent", icon: "1f4c4", subFileCount: 1, id: "20261107102226-6b6v11l", size: 422 };

  it("POST /api/filetree/listDocsByPath {notebook, path, flashcard:false} et renvoie path, name, icon, subFileCount", async () => {
    const k = recording({ code: 0, msg: "", data: { box: BOX, path: "/", files: [file, { path: "/x.sy", name: "Feuille" }] } });
    const files = await createKernelApi({ fetch: k.fetch }).listDocsByPath(BOX, "/");
    expect(k.calls[0]?.url).toBe("/api/filetree/listDocsByPath");
    expect(bodyOf(k.calls[0])).toEqual({ notebook: BOX, path: "/", flashcard: false });
    expect(files).toEqual([
      { path: "/20261107102226-6b6v11l.sy", name: "Parent", icon: "1f4c4", subFileCount: 1 },
      { path: "/x.sy", name: "Feuille", icon: "", subFileCount: 0 },
    ]);
  });

  it("files vide ou null : aucune entrée, sans erreur", async () => {
    for (const files of [[], null]) {
      const k = recording({ code: 0, msg: "", data: { box: BOX, path: "/", files } });
      expect(await createKernelApi({ fetch: k.fetch }).listDocsByPath(BOX, "/")).toEqual([]);
    }
  });

  it.each([
    ["data null", null],
    ["files non tableau", { files: {} }],
    ["entrée sans path", { files: [{ name: "a" }] }],
    ["entrée sans name", { files: [{ path: "/a.sy" }] }],
    ["icon non texte", { files: [{ path: "/a.sy", name: "a", icon: 3 }] }],
    ["subFileCount non nombre", { files: [{ path: "/a.sy", name: "a", subFileCount: "1" }] }],
  ])("mal formé (%s) -> MalformedResponseError", async (_n, data) => {
    const api = createKernelApi({ fetch: recording({ code: 0, msg: "", data }).fetch });
    await expect(api.listDocsByPath(BOX, "/")).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("échec du noyau -> KernelApiError ; signal transmis", async () => {
    const api = createKernelApi({ fetch: recording({ code: -1, msg: "boom", data: null }).fetch });
    await expect(api.listDocsByPath(BOX, "/")).rejects.toBeInstanceOf(KernelApiError);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(api.listDocsByPath(BOX, "/", controller.signal)).rejects.toThrow("stop");
  });
});

describe("KernelApi.searchDocs", () => {
  const hit = { path: "/20261107111734-5rit9cm.sy", hPath: "Test/Compta", title: "Compta", box: BOX, boxIcon: "1f4d4", name: "", alias: "" };

  it("POST /api/filetree/searchDocs {k, flashcard:false} et renvoie path, hPath, title, box, boxIcon", async () => {
    const k = recording({ code: 0, msg: "", data: [hit, { path: "/", hPath: "Test/", title: "Test", box: BOX }] });
    const hits = await createKernelApi({ fetch: k.fetch }).searchDocs("Co");
    expect(k.calls[0]?.url).toBe("/api/filetree/searchDocs");
    expect(bodyOf(k.calls[0])).toEqual({ k: "Co", flashcard: false });
    expect(hits).toEqual([
      { path: "/20261107111734-5rit9cm.sy", hPath: "Test/Compta", title: "Compta", box: BOX, boxIcon: "1f4d4" },
      { path: "/", hPath: "Test/", title: "Test", box: BOX, boxIcon: "" },
    ]);
  });

  it("data null ou tableau vide : aucun résultat", async () => {
    for (const data of [null, []]) {
      expect(await createKernelApi({ fetch: recording({ code: 0, msg: "", data }).fetch }).searchDocs("zz")).toEqual([]);
    }
  });

  it.each([
    ["data non tableau", {}],
    ["entrée sans hPath", [{ path: "/a.sy", title: "a", box: BOX }]],
    ["entrée sans box", [{ path: "/a.sy", hPath: "a", title: "a" }]],
    ["boxIcon non texte", [{ path: "/a.sy", hPath: "a", title: "a", box: BOX, boxIcon: 1 }]],
  ])("mal formé (%s) -> MalformedResponseError", async (_n, data) => {
    const api = createKernelApi({ fetch: recording({ code: 0, msg: "", data }).fetch });
    await expect(api.searchDocs("a")).rejects.toBeInstanceOf(MalformedResponseError);
  });
});

describe("KernelApi.getHPathsByPaths", () => {
  it("POST /api/filetree/getHPathsByPaths {paths} et renvoie les libellés", async () => {
    const k = recording({ code: 0, msg: "", data: ["Test/Compta", "Test/Compta/Archives"] });
    const hpaths = await createKernelApi({ fetch: k.fetch }).getHPathsByPaths(["/a.sy", "/a/b.sy"]);
    expect(k.calls[0]?.url).toBe("/api/filetree/getHPathsByPaths");
    expect(bodyOf(k.calls[0])).toEqual({ paths: ["/a.sy", "/a/b.sy"] });
    expect(hpaths).toEqual(["Test/Compta", "Test/Compta/Archives"]);
  });

  it.each([
    ["data null (chemin inconnu)", null],
    ["data objet", {}],
    ["élément non texte", ["a", 2]],
  ])("mal formé (%s) -> MalformedResponseError", async (_n, data) => {
    const api = createKernelApi({ fetch: recording({ code: 0, msg: "", data }).fetch });
    await expect(api.getHPathsByPaths(["/a.sy"])).rejects.toBeInstanceOf(MalformedResponseError);
  });
});
