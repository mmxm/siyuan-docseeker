import { describe, expect, it, vi } from "vitest";
import { diffManifest, fingerprint } from "../../../src/core/manifest";
import {
  DEFAULT_ASSETS_ROOT,
  MAX_CONCURRENT_SIZE_REQUESTS,
  MAX_DIRECTORY_DEPTH,
  DiscoveryRootError,
  discoverPdfs,
  type DiscoveryApi,
} from "../../../src/siyuan/discovery";
import { KernelApiError, NotFoundError, type DirEntry } from "../../../src/siyuan/kernelApi";

const file = (name: string, updated = 1700000000): DirEntry => ({ name, isDir: false, isSymlink: false, updated });
const dir = (name: string, isSymlink = false): DirEntry => ({ name, isDir: true, isSymlink, updated: 1 });

type Tree = Record<string, readonly DirEntry[] | Error>;

function fakeApi(tree: Tree, sizes: Record<string, number> = {}): DiscoveryApi & { readDirCalls: string[] } {
  const readDirCalls: string[] = [];
  return {
    readDirCalls,
    async readDir(path) {
      readDirCalls.push(path);
      const node = tree[path];
      if (node === undefined) throw new NotFoundError(200, "path does not exist");
      if (node instanceof Error) throw node;
      return node;
    },
    async headAsset(url) {
      const size = sizes[url];
      if (size === undefined) throw new NotFoundError(404, "no head");
      return { size };
    },
  };
}

const constantSize = async (): Promise<number> => 100;

describe("discoverPdfs", () => {
  it("parcourt une arborescence imbriquée et renvoie des chemins relatifs assets/...", async () => {
    const api = fakeApi({
      "/data/assets": [file("a.pdf"), file("notes.txt"), dir("sub"), file("img.png")],
      "/data/assets/sub": [file("b.pdf"), dir("deep")],
      "/data/assets/sub/deep": [file("c.pdf")],
    });
    const { manifest, issues } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(manifest.map((entry) => entry.path)).toEqual(["assets/a.pdf", "assets/sub/b.pdf", "assets/sub/deep/c.pdf"]);
    expect(issues).toEqual([]);
    expect(DEFAULT_ASSETS_ROOT).toBe("/data/assets");
  });

  it("accepte la casse .PDF et ignore un dossier nommé *.pdf", async () => {
    const api = fakeApi({ "/data/assets": [file("UPPER.PDF"), file("Mixed.Pdf"), dir("folder.pdf"), file("x.pdfx")], "/data/assets/folder.pdf": [] });
    const { manifest } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(manifest.map((entry) => entry.path)).toEqual(["assets/Mixed.Pdf", "assets/UPPER.PDF"]);
  });

  it("convertit updated (secondes) en modifiedAt (millisecondes)", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf", 1700000123)] });
    const { manifest } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(manifest[0]).toEqual({ path: "assets/a.pdf", size: 100, modifiedAt: 1700000123000 });
  });

  it("racine personnalisée (avec slash final) : le chemin reste relatif à /data", async () => {
    const api = fakeApi({ "/data/assets/sub": [file("é x.pdf")] });
    const sizeOf = vi.fn(constantSize);
    const { manifest } = await discoverPdfs({ api, root: "/data/assets/sub/", sizeOf });
    expect(manifest.map((entry) => entry.path)).toEqual(["assets/sub/é x.pdf"]);
    expect(sizeOf).toHaveBeenCalledWith("assets/sub/é x.pdf");
  });

  it("taille par défaut = headAsset sur /assets/...", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf")] }, { "/assets/a.pdf": 4242 });
    const { manifest, issues } = await discoverPdfs({ api });
    expect(manifest[0]?.size).toBe(4242);
    expect(issues).toEqual([]);
  });

  it("un dossier illisible n'interrompt pas le parcours : il est rapporté", async () => {
    const api = fakeApi({
      "/data/assets": [file("a.pdf"), dir("locked"), dir("ok")],
      "/data/assets/locked": new KernelApiError(200, 403, "Forbidden"),
      "/data/assets/ok": [file("b.pdf")],
    });
    const { manifest, issues } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(manifest.map((entry) => entry.path)).toEqual(["assets/a.pdf", "assets/ok/b.pdf"]);
    expect(issues).toEqual([{ kind: "directory", path: "/data/assets/locked", message: expect.stringContaining("Forbidden") }]);
  });

  it("racine illisible : lève DiscoveryRootError au lieu d'un résultat vide", async () => {
    const api = fakeApi({ "/data/assets": new KernelApiError(401, 401, "session expired") });
    const attempt = discoverPdfs({ api, sizeOf: constantSize });
    await expect(attempt).rejects.toBeInstanceOf(DiscoveryRootError);
    await expect(attempt).rejects.toMatchObject({ path: "/data/assets", message: expect.stringContaining("session expired") });
  });

  it("racine absente : DiscoveryRootError aussi", async () => {
    await expect(discoverPdfs({ api: fakeApi({}), sizeOf: constantSize })).rejects.toBeInstanceOf(DiscoveryRootError);
  });

  it("dossier en erreur : résultat incomplet", async () => {
    const api = fakeApi({ "/data/assets": [dir("locked")], "/data/assets/locked": new Error("denied") });
    const result = await discoverPdfs({ api, sizeOf: constantSize });
    expect(result.complete).toBe(false);
  });

  it("résultat complet : complete vrai, unsized vide", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf"), dir("s")], "/data/assets/s": [file("b.pdf")] });
    const result = await discoverPdfs({ api, sizeOf: constantSize });
    expect(result.complete).toBe(true);
    expect(result.unsized).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("sizeOf qui échoue sur un seul PDF : exclu du manifeste, listé dans unsized, incomplet", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf"), file("b.pdf")] });
    const sizeOf = async (path: string): Promise<number> => {
      if (path === "assets/b.pdf") throw new Error("no Content-Length");
      return 5;
    };
    const result = await discoverPdfs({ api, sizeOf });
    expect(result.manifest.map((e) => e.path)).toEqual(["assets/a.pdf"]);
    expect(result.unsized).toEqual(["assets/b.pdf"]);
    expect(result.complete).toBe(false);
  });

  it("profondeur dépassée ou lien symbolique imbriqué ignoré : incomplet", async () => {
    const deep: Tree = {};
    let path = "/data/assets";
    for (let level = 0; level < MAX_DIRECTORY_DEPTH + 2; level += 1) {
      deep[path] = [dir("d")];
      path = `${path}/d`;
    }
    expect((await discoverPdfs({ api: fakeApi(deep), sizeOf: constantSize })).complete).toBe(false);
    const links = fakeApi({
      "/data/assets": [dir("l1", true)],
      "/data/assets/l1": [dir("l2", true)],
    });
    const result = await discoverPdfs({ api: links, sizeOf: constantSize });
    expect(result.issues.map((i) => i.kind)).toEqual(["symlink"]);
    expect(result.complete).toBe(false);
  });

  it("session expirée au milieu du parcours : incomplet, PDF déjà vus conservés", async () => {
    let calls = 0;
    const api: DiscoveryApi = {
      async readDir(path) {
        calls += 1;
        if (calls > 1) throw new KernelApiError(401, 401, "session expired");
        return path === "/data/assets" ? [file("a.pdf"), dir("s")] : [];
      },
      async headAsset() {
        throw new KernelApiError(401, 401, "session expired");
      },
    };
    const result = await discoverPdfs({ api });
    expect(result.complete).toBe(false);
    expect(result.manifest).toEqual([]);
    expect(result.unsized).toEqual(["assets/a.pdf"]);
  });

  it("un PDF dont la taille est illisible ou invalide est rapporté, les autres restent", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf"), file("bad.pdf"), file("neg.pdf"), file("nan.pdf"), file("frac.pdf")] });
    const sizeOf = async (path: string): Promise<number> => {
      if (path.endsWith("bad.pdf")) throw new NotFoundError(404, "gone");
      if (path.endsWith("neg.pdf")) return -1;
      if (path.endsWith("nan.pdf")) return Number.NaN;
      if (path.endsWith("frac.pdf")) return 1.5;
      return 10;
    };
    const { manifest, issues } = await discoverPdfs({ api, sizeOf });
    expect(manifest.map((entry) => entry.path)).toEqual(["assets/a.pdf"]);
    expect(issues.map((issue) => [issue.kind, issue.path]).sort()).toEqual([
      ["pdf", "assets/bad.pdf"],
      ["pdf", "assets/frac.pdf"],
      ["pdf", "assets/nan.pdf"],
      ["pdf", "assets/neg.pdf"],
    ]);
  });

  it("borne la concurrence des requêtes de taille", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${i}.pdf`);
    const api = fakeApi({ "/data/assets": names.map((n) => file(n)) });
    let inFlight = 0;
    let peak = 0;
    const sizeOf = async (): Promise<number> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return 1;
    };
    const { manifest } = await discoverPdfs({ api, sizeOf });
    expect(manifest).toHaveLength(25);
    expect(MAX_CONCURRENT_SIZE_REQUESTS).toBe(6);
    expect(peak).toBe(MAX_CONCURRENT_SIZE_REQUESTS);
  });

  it("lien symbolique en boucle : le parcours se termine et signale le problème", async () => {
    const api = fakeApi({
      "/data/assets": [file("a.pdf"), dir("loop", true)],
      "/data/assets/loop": [file("a.pdf"), dir("loop", true)],
      "/data/assets/loop/loop": [file("a.pdf"), dir("loop", true)],
    });
    const { manifest, issues } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(api.readDirCalls.length).toBeLessThanOrEqual(MAX_DIRECTORY_DEPTH + 1);
    expect(manifest.length).toBeLessThanOrEqual(MAX_DIRECTORY_DEPTH + 1);
    expect(issues.some((issue) => issue.kind === "depth" || issue.kind === "symlink")).toBe(true);
  });

  it("profondeur maximale : un arbre trop profond est tronqué avec un problème 'depth'", async () => {
    const tree: Tree = {};
    let path = "/data/assets";
    for (let level = 0; level < MAX_DIRECTORY_DEPTH + 10; level += 1) {
      tree[path] = [file(`p${level}.pdf`), dir("d")];
      path = `${path}/d`;
    }
    const { manifest, issues } = await discoverPdfs({ api: fakeApi(tree), sizeOf: constantSize });
    expect(manifest).toHaveLength(MAX_DIRECTORY_DEPTH + 1);
    expect(issues.filter((issue) => issue.kind === "depth")).toHaveLength(1);
  });

  it("le manifeste produit est accepté par diffManifest et fingerprint", async () => {
    const api = fakeApi({ "/data/assets": [file("a.pdf"), dir("s")], "/data/assets/s": [file("a.pdf")] });
    const { manifest } = await discoverPdfs({ api, sizeOf: constantSize });
    expect(diffManifest([], manifest).added).toHaveLength(2);
    expect(new Set(manifest.map(fingerprint)).size).toBe(2);
  });

  it("dossier vide : manifeste vide, aucun problème", async () => {
    const { manifest, issues } = await discoverPdfs({ api: fakeApi({ "/data/assets": [] }), sizeOf: constantSize });
    expect(manifest).toEqual([]);
    expect(issues).toEqual([]);
  });
});
