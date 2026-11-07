import { describe, expect, it, vi } from "vitest";
import { ConflictError, KernelApiError, NotFoundError, type KernelApi } from "../../../src/siyuan/kernelApi";
import {
  InvalidNameError,
  STALE_TMP_AGE_MS,
  createPetalStore,
  type PetalStoreOptions,
} from "../../../src/siyuan/petalStore";

const IDX = "/data/storage/petal/docseeker/idx";
type Op = "putFile" | "renameFile" | "removeFile" | "getFile" | "readDir";

interface FakeKernel {
  readonly api: KernelApi;
  readonly files: Map<string, Uint8Array>;
  /** Dates de modification (secondes) ; 1 par défaut (très ancien). */
  readonly mtimes: Map<string, number>;
  readonly log: string[];
  /** Injecte une panne : renvoie une erreur à lever pour (opération, chemin). */
  failWhen: (op: Op, path: string, extra?: string) => Error | undefined;
}

/** Faux noyau : renameFile refuse d'écraser (409) comme le vrai noyau. */
function createFake(extraEntries: readonly string[] = []): FakeKernel {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, number>();
  const log: string[] = [];
  const kernel: FakeKernel = {
    files,
    mtimes,
    log,
    failWhen: () => undefined,
    api: {
      async sql() {
        throw new Error("sql is not used by the petal store");
      },
      async lsNotebooks() {
        throw new Error("lsNotebooks is not used by the petal store");
      },
      async listDocsByPath() {
        throw new Error("listDocsByPath is not used by the petal store");
      },
      async searchDocs() {
        throw new Error("searchDocs is not used by the petal store");
      },
      async getHPathsByPaths() {
        throw new Error("getHPathsByPaths is not used by the petal store");
      },
      async readDir(path) {
        log.push(`readDir ${path}`);
        const failure = kernel.failWhen("readDir", path);
        if (failure) throw failure;
        const prefix = `${path}/`;
        const names = [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
        if (names.length === 0 && path !== IDX) throw new NotFoundError(200, "path does not exist");
        const entries = [...names, ...extraEntries].map((name) => ({
          name,
          isDir: false,
          isSymlink: false,
          updated: mtimes.get(`${prefix}${name}`) ?? 1,
        }));
        return [...entries, { name: "sub", isDir: true, isSymlink: false, updated: 1 }];
      },
      async getFile(path) {
        log.push(`getFile ${path}`);
        const failure = kernel.failWhen("getFile", path);
        if (failure) throw failure;
        const bytes = files.get(path);
        if (!bytes) throw new NotFoundError(202, "no such file");
        return bytes;
      },
      async putFile(path, bytes) {
        log.push(`putFile ${path}`);
        const failure = kernel.failWhen("putFile", path);
        if (failure) throw failure;
        files.set(path, bytes);
      },
      async removeFile(path) {
        log.push(`removeFile ${path}`);
        const failure = kernel.failWhen("removeFile", path);
        if (failure) throw failure;
        if (!files.delete(path)) throw new NotFoundError(200, "path does not exist");
      },
      async renameFile(path, newPath) {
        log.push(`renameFile ${path} ${newPath}`);
        const failure = kernel.failWhen("renameFile", path, newPath);
        if (failure) throw failure;
        const bytes = files.get(path);
        if (!bytes) throw new NotFoundError(200, "no such file");
        if (files.has(newPath)) throw new ConflictError(200, "path already exists");
        files.delete(path);
        files.set(newPath, bytes);
      },
      async headAsset() {
        throw new Error("unused");
      },
    },
  };
  return kernel;
}

const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const counterIds = (): (() => string) => {
  let n = 0;
  return () => `id${(n += 1)}`;
};
const storeOf = (kernel: FakeKernel, options: Partial<PetalStoreOptions> = {}) =>
  createPetalStore({ api: kernel.api, randomId: counterIds(), onWarning: () => undefined, ...options });

/** Retient chaque putFile jusqu'à ce que le test le libère (latence contrôlée). */
function holdPuts(kernel: FakeKernel): { started: string[]; releases: (() => void)[] } {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const original = kernel.api.putFile.bind(kernel.api);
  kernel.api.putFile = async (path, bytes, modTime, signal) => {
    started.push(path);
    await new Promise<void>((resolve) => releases.push(resolve));
    return original(path, bytes, modTime, signal);
  };
  return { started, releases };
}

describe("petalStore : écriture atomique", () => {
  it("écrit via .tmp unique puis renomme ; aucun .tmp ne subsiste", async () => {
    const kernel = createFake();
    const store = storeOf(kernel);
    await store.write("abc-1.dsx", bytesOf(1, 2, 3));

    expect(kernel.files.get(`${IDX}/abc-1.dsx`)).toEqual(bytesOf(1, 2, 3));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/abc-1.dsx`]);
    expect(kernel.log.slice(0, 2)).toEqual([
      `putFile ${IDX}/abc-1.dsx.id1.tmp`,
      `renameFile ${IDX}/abc-1.dsx.id1.tmp ${IDX}/abc-1.dsx`,
    ]);
  });

  it("remplace un fichier existant (le noyau refuse d'écraser : 409) sans laisser de .bak", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    await storeOf(kernel).write("a.dsx", bytesOf(1, 1));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(1, 1));
  });

  it("panne pendant putFile : ancien fichier intact, .tmp nettoyé, erreur d'origine propagée", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const original = new KernelApiError(200, 500, "disk full");
    kernel.failWhen = (op) => (op === "putFile" ? original : undefined);

    await expect(storeOf(kernel).write("a.dsx", bytesOf(1))).rejects.toBe(original);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("panne entre put et rename : ancien fichier intact, .tmp supprimé", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const original = new KernelApiError(200, 500, "rename boom");
    kernel.failWhen = (op) => (op === "renameFile" ? original : undefined);

    await expect(storeOf(kernel).write("a.dsx", bytesOf(1))).rejects.toBe(original);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("l'échec du nettoyage ne masque pas l'erreur d'origine : AggregateError [origine, nettoyage]", async () => {
    // Adapté : avant, l'erreur de nettoyage était avalée (rejects.toBe(original)) ; elle doit être visible.
    const kernel = createFake();
    const original = new KernelApiError(200, 500, "rename boom");
    const cleanup = new Error("cleanup boom");
    kernel.failWhen = (op) => (op === "renameFile" ? original : op === "removeFile" ? cleanup : undefined);

    const error = await storeOf(kernel).write("a.dsx", bytesOf(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, cleanup]);
  });

  it("remplacement : si le second rename échoue, l'ancien contenu est restauré", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const original = new KernelApiError(200, 500, "second rename boom");
    kernel.failWhen = (op, path) =>
      op === "renameFile" && path.endsWith(".tmp") && kernel.files.has(`${IDX}/a.dsx.bak`) ? original : undefined;

    await expect(storeOf(kernel).write("a.dsx", bytesOf(1))).rejects.toBe(original);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("remplacement : l'échec de la restauration est remonté avec l'erreur d'origine, .bak conservé", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const original = new KernelApiError(200, 500, "second rename boom");
    const restore = new KernelApiError(200, 500, "restore boom");
    kernel.failWhen = (op, path) => {
      if (op !== "renameFile") return undefined;
      if (path.endsWith(".tmp") && kernel.files.has(`${IDX}/a.dsx.bak`)) return original;
      return path.endsWith(".bak") ? restore : undefined;
    };

    const error = await storeOf(kernel).write("a.dsx", bytesOf(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, restore]);
    expect(kernel.files.get(`${IDX}/a.dsx.bak`)).toEqual(bytesOf(9));
  });

  it("remplacement : si la mise de côté de l'ancien fichier échoue, rien n'est perdu", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const original = new KernelApiError(200, 500, "aside boom");
    kernel.failWhen = (op, path) => (op === "renameFile" && path === `${IDX}/a.dsx` ? original : undefined);
    await expect(storeOf(kernel).write("a.dsx", bytesOf(1))).rejects.toBe(original);
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
  });

  it("ancien .bak : seul NotFound est ignoré ; autre échec -> abandon sans toucher au final", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(8));
    const original = new KernelApiError(200, 500, "cannot remove bak");
    kernel.failWhen = (op, path) => (op === "removeFile" && path.endsWith(".bak") ? original : undefined);

    await expect(storeOf(kernel).write("a.dsx", bytesOf(1))).rejects.toBe(original);
    expect(kernel.log.some((l) => l === `renameFile ${IDX}/a.dsx ${IDX}/a.dsx.bak`)).toBe(false);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
    expect([...kernel.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
  });

  it("échec de suppression du .bak après publication : écriture réussie, avertissement émis", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const failure = new KernelApiError(200, 500, "bak stuck");
    kernel.failWhen = (op, path) =>
      op === "removeFile" && path.endsWith(".bak") && kernel.files.has(path) ? failure : undefined;
    const onWarning = vi.fn();

    await storeOf(kernel, { onWarning }).write("a.dsx", bytesOf(1));
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(1));
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("a.dsx"), failure);
  });

  it("identifiant aléatoire par défaut : deux écritures utilisent des .tmp différents", async () => {
    const kernel = createFake();
    const store = createPetalStore({ api: kernel.api });
    await store.write("a.dsx", bytesOf(1));
    await store.write("a.dsx", bytesOf(2));
    const puts = kernel.log.filter((l) => l.startsWith("putFile "));
    expect(puts[0]).toMatch(/^putFile .*\/a\.dsx\.[A-Za-z0-9]{8,}\.tmp$/);
    expect(puts[1]).toMatch(/^putFile .*\/a\.dsx\.[A-Za-z0-9]{8,}\.tmp$/);
    expect(puts[0]).not.toBe(puts[1]);
  });

  it("générateur d'identifiant produisant un segment dangereux : rejeté sans appel réseau", async () => {
    const kernel = createFake();
    const store = storeOf(kernel, { randomId: () => "../evil" });
    await expect(store.write("a.dsx", bytesOf(1))).rejects.toBeInstanceOf(InvalidNameError);
    expect(kernel.log).toEqual([]);
  });
});

describe("petalStore : écritures concurrentes", () => {
  it("deux write() du même nom : .tmp distincts, exécutées l'une après l'autre, la seconde gagne", async () => {
    const kernel = createFake();
    const { started, releases } = holdPuts(kernel);
    const store = storeOf(kernel);

    const first = store.write("a.dsx", bytesOf(1));
    const second = store.write("a.dsx", bytesOf(2));
    await flush();
    expect(started).toEqual([`${IDX}/a.dsx.id1.tmp`]); // la seconde attend la première

    releases.shift()?.();
    await flush();
    expect(started).toEqual([`${IDX}/a.dsx.id1.tmp`, `${IDX}/a.dsx.id2.tmp`]);
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(2));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("trois écritures concurrentes : final = la dernière, ni .tmp ni .bak orphelin", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const store = storeOf(kernel);
    await Promise.all([1, 2, 3].map((n) => store.write("a.dsx", bytesOf(n))));
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(3));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("l'échec de la première n'empoisonne pas la file et ne supprime pas le .tmp de la suivante", async () => {
    const kernel = createFake();
    const boom = new KernelApiError(200, 500, "put boom");
    kernel.failWhen = (op, path) => (op === "putFile" && path.includes(".id1.") ? boom : undefined);
    const { releases } = holdPuts(kernel);
    const store = storeOf(kernel);

    const first = store.write("a.dsx", bytesOf(1)).catch((e: unknown) => e);
    const second = store.write("a.dsx", bytesOf(2));
    await flush();
    releases.shift()?.();
    expect(await first).toBe(boom);
    await flush();
    releases.shift()?.();
    await second;

    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(2));
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("noms différents : écritures en parallèle (pas de sérialisation globale)", async () => {
    const kernel = createFake();
    const { started, releases } = holdPuts(kernel);
    const store = storeOf(kernel);
    const writes = [store.write("a.dsx", bytesOf(1)), store.write("b.dsx", bytesOf(2))];
    await flush();
    expect(started).toHaveLength(2);
    releases.forEach((release) => release());
    await Promise.all(writes);
    expect(kernel.files.get(`${IDX}/b.dsx`)).toEqual(bytesOf(2));
  });

  it("remove() attend l'écriture en cours du même nom", async () => {
    const kernel = createFake();
    const { releases } = holdPuts(kernel);
    const store = storeOf(kernel);
    const write = store.write("a.dsx", bytesOf(1));
    const removal = store.remove("a.dsx");
    await flush();
    releases.shift()?.();
    await write;
    expect(await removal).toBe(true);
    expect([...kernel.files.keys()]).toEqual([]);
  });
});

describe("petalStore : lecture, liste, suppression", () => {
  it("read : octets ou null si absent ; autres erreurs propagées", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(4, 5));
    const store = storeOf(kernel);
    expect(await store.read("a.dsx")).toEqual(bytesOf(4, 5));
    expect(await store.read("zzz.dsx")).toBeNull();
    kernel.failWhen = (op) => (op === "getFile" ? new KernelApiError(500, 500, "boom") : undefined);
    await expect(store.read("a.dsx")).rejects.toMatchObject({ code: 500 });
  });

  it("read : final absent mais .bak présent (fenêtre du remplacement) -> contenu du .bak", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(7));
    expect(await storeOf(kernel).read("a.dsx")).toEqual(bytesOf(7));
  });

  it("read : final et .bak absents -> null ; erreur sur le .bak propagée", async () => {
    const kernel = createFake();
    const store = storeOf(kernel);
    expect(await store.read("a.dsx")).toBeNull();
    const boom = new KernelApiError(500, 500, "bak boom");
    kernel.failWhen = (op, path) => (op === "getFile" && path.endsWith(".bak") ? boom : undefined);
    await expect(store.read("a.dsx")).rejects.toBe(boom);
  });

  it("read/list pendant le remplacement (entre les deux renames) : l'ancien contenu reste visible", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = kernel.api.renameFile.bind(kernel.api);
    kernel.api.renameFile = async (path, newPath, signal) => {
      if (path.endsWith(".tmp") && kernel.files.has(`${IDX}/a.dsx.bak`)) {
        enter();
        await gate;
      }
      return original(path, newPath, signal);
    };
    const store = storeOf(kernel);

    const write = store.write("a.dsx", bytesOf(1));
    await entered;
    expect(kernel.files.has(`${IDX}/a.dsx`)).toBe(false); // la fenêtre existe bien
    expect(await store.read("a.dsx")).toEqual(bytesOf(9));
    expect(await store.list()).toEqual(["a.dsx"]);
    release();
    await write;
    expect(await store.read("a.dsx")).toEqual(bytesOf(1));
  });

  it("list : fichiers seulement, sans .tmp ni .bak, triés ; dossier absent -> []", async () => {
    const kernel = createFake();
    for (const n of ["b.dsx", "a.dsx", "c.dsx.tmp", "d.dsx.id1.tmp"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const store = storeOf(kernel);
    expect(await store.list()).toEqual(["a.dsx", "b.dsx"]);

    const empty = storeOf(kernel, { pluginName: "autre" });
    expect(await empty.list()).toEqual([]);
  });

  it("list : inclut les noms n'ayant qu'un .bak, sans doublon quand le final existe", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "a.dsx.bak", "b.dsx.bak", "c.dsx"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    expect(await storeOf(kernel).list()).toEqual(["a.dsx", "b.dsx", "c.dsx"]);
  });

  it("remove : true si supprimé, false si absent", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(1));
    const store = storeOf(kernel);
    expect(await store.remove("a.dsx")).toBe(true);
    expect(await store.remove("a.dsx")).toBe(false);
    kernel.failWhen = (op) => (op === "removeFile" ? new KernelApiError(200, 500, "boom") : undefined);
    await expect(store.remove("a.dsx")).rejects.toMatchObject({ code: 500 });
  });

  it("remove : supprime aussi le .bak (sinon le nom resterait visible par list/read)", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(1));
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(2));
    kernel.files.set(`${IDX}/b.dsx.bak`, bytesOf(3));
    const store = storeOf(kernel);
    expect(await store.remove("a.dsx")).toBe(true);
    expect(await store.remove("b.dsx")).toBe(true);
    expect([...kernel.files.keys()]).toEqual([]);
  });
});

describe("petalStore : nettoyage au démarrage", () => {
  const NOW_MS = 1_800_000_000_000;
  const nowSeconds = NOW_MS / 1000;
  const oldSeconds = nowSeconds - (STALE_TMP_AGE_MS / 1000 + 60);

  it("supprime les .tmp orphelins anciens et rapporte les noms traités", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "b.dsx.id1.tmp", "c.dsx.tmp"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect([...report.handled].sort()).toEqual(["b.dsx.id1.tmp", "c.dsx.tmp"]);
    expect(report.failed).toEqual([]);
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("ne supprime pas un .tmp plus récent que le seuil (écriture éventuellement en cours)", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/fresh.dsx.id1.tmp`, bytesOf(1));
    kernel.files.set(`${IDX}/edge.dsx.id2.tmp`, bytesOf(1));
    kernel.files.set(`${IDX}/old.dsx.id3.tmp`, bytesOf(1));
    kernel.mtimes.set(`${IDX}/fresh.dsx.id1.tmp`, nowSeconds - 5);
    kernel.mtimes.set(`${IDX}/edge.dsx.id2.tmp`, nowSeconds - STALE_TMP_AGE_MS / 1000); // pas strictement plus ancien
    kernel.mtimes.set(`${IDX}/old.dsx.id3.tmp`, oldSeconds);
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(report.handled).toEqual(["old.dsx.id3.tmp"]);
    expect(kernel.files.has(`${IDX}/fresh.dsx.id1.tmp`)).toBe(true);
    expect(kernel.files.has(`${IDX}/edge.dsx.id2.tmp`)).toBe(true);
  });

  it("ignore, sans aucune action, les noms qui ne passent pas la validation de segment", async () => {
    const kernel = createFake(["with space.tmp", ".hidden.tmp", "a..b.tmp", "é.bak", "x;y.tmp", `${"a".repeat(300)}.tmp`]);
    kernel.files.set(`${IDX}/ok.dsx.tmp`, bytesOf(1));
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(report.handled).toEqual(["ok.dsx.tmp"]);
    expect(report.failed).toEqual([]);
    const actions = kernel.log.filter((l) => !l.startsWith("readDir"));
    expect(actions).toEqual([`removeFile ${IDX}/ok.dsx.tmp`]);
  });

  it(".bak orphelin ancien sans fichier final (crash entre les deux renames) : restauré", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(9));
    kernel.files.set(`${IDX}/a.dsx.id1.tmp`, bytesOf(1));
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(9));
    expect([...report.handled].sort()).toEqual(["a.dsx.bak", "a.dsx.id1.tmp"]);
  });

  it(".bak récent (remplacement en cours) : intact", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(9));
    kernel.mtimes.set(`${IDX}/a.dsx.bak`, nowSeconds - 1);
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(report.handled).toEqual([]);
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx.bak`]);
  });

  it(".bak avec fichier final présent : supprimé", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(1));
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(9));
    await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect([...kernel.files.keys()]).toEqual([`${IDX}/a.dsx`]);
  });

  it("revérifie l'existence du final juste avant de restaurer un .bak", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(9));
    const original = kernel.api.readDir.bind(kernel.api);
    let calls = 0;
    kernel.api.readDir = async (path, signal) => {
      const result = await original(path, signal);
      calls += 1;
      if (calls === 1) kernel.files.set(`${IDX}/a.dsx`, bytesOf(1)); // le final apparaît après le listage
      return result;
    };
    await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(kernel.log.some((l) => l.startsWith("renameFile"))).toBe(false);
    expect(kernel.files.get(`${IDX}/a.dsx`)).toEqual(bytesOf(1));
  });

  it("dossier absent : rapport vide ; les échecs sont rapportés sans interrompre les autres", async () => {
    const absent = storeOf(createFake(), { pluginName: "autre", now: () => NOW_MS });
    expect(await absent.removeStaleTmp()).toEqual({ handled: [], failed: [] });

    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.tmp`, bytesOf(1));
    kernel.files.set(`${IDX}/b.dsx.tmp`, bytesOf(1));
    const boom = new Error("boom");
    kernel.failWhen = (op, path) => (op === "removeFile" && path.endsWith("a.dsx.tmp") ? boom : undefined);
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(report.handled).toEqual(["b.dsx.tmp"]);
    expect(report.failed).toEqual([{ name: "a.dsx.tmp", error: boom }]);
    expect(kernel.files.has(`${IDX}/b.dsx.tmp`)).toBe(false);
  });

  it("échec de restauration d'un .bak rapporté dans failed", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx.bak`, bytesOf(9));
    const boom = new KernelApiError(200, 500, "restore boom");
    kernel.failWhen = (op) => (op === "renameFile" ? boom : undefined);
    const report = await storeOf(kernel, { now: () => NOW_MS }).removeStaleTmp();
    expect(report).toEqual({ handled: [], failed: [{ name: "a.dsx.bak", error: boom }] });
  });
});

describe("petalStore : validation des noms", () => {
  const dangerous = [
    "",
    ".",
    "..",
    "../x.dsx",
    "a/b.dsx",
    "a\\b.dsx",
    "a..b.dsx",
    ".hidden",
    "é.dsx",
    "a b.dsx",
    "a%2Fb",
    "a\0b",
    "a:b",
    "x.tmp",
    "x.bak",
    "a".repeat(300),
    "C:evil",
  ];

  it.each(dangerous)("rejette %j sur toutes les opérations, sans appel réseau", async (name) => {
    const kernel = createFake();
    const store = storeOf(kernel);
    await expect(store.write(name, bytesOf(1))).rejects.toBeInstanceOf(InvalidNameError);
    await expect(store.read(name)).rejects.toBeInstanceOf(InvalidNameError);
    await expect(store.remove(name)).rejects.toBeInstanceOf(InvalidNameError);
    expect(kernel.log).toEqual([]);
  });

  it("accepte les empreintes réelles (a-z0-9, tiret, point)", async () => {
    const kernel = createFake();
    const store = storeOf(kernel);
    await expect(store.write("1x2y3z-173015040.dsx", bytesOf(1))).resolves.toBeUndefined();
  });

  it("rejette un pluginName dangereux", () => {
    const api = createFake().api;
    expect(() => createPetalStore({ api, pluginName: "../etc" })).toThrow(InvalidNameError);
    expect(() => createPetalStore({ api, pluginName: "" })).toThrow(InvalidNameError);
  });
});

describe("petalStore : clear (vider l'index)", () => {
  it("supprime les .dsx, le manifeste et leurs .tmp/.bak, et rapporte les noms", async () => {
    const kernel = createFake();
    for (const n of [
      "a.dsx",
      "b.dsx",
      "b.dsx.bak",
      "c.dsx.id1.tmp",
      "manifest.json",
      "manifest.json.id2.tmp",
      "manifest.json.bak",
    ]) {
      kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    }
    const report = await storeOf(kernel).clear();
    expect([...kernel.files.keys()]).toEqual([]);
    expect([...report.removed].sort()).toEqual([
      "a.dsx",
      "b.dsx",
      "b.dsx.bak",
      "c.dsx.id1.tmp",
      "manifest.json",
      "manifest.json.bak",
      "manifest.json.id2.tmp",
    ]);
    expect(report.failed).toEqual([]);
  });

  it("supprime les sauvegardes de manifeste rejeté (datées ou non) et leurs .tmp, rien d'autre", async () => {
    const kernel = createFake();
    const names = [
      "manifest.rejected.json",
      "manifest.rejected-1700000000000.json",
      "manifest.rejected-1700000000000.json.id3.tmp",
      "manifest.rejected.json.id4.tmp",
      "manifest.json",
    ];
    for (const n of names) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    kernel.files.set(`${IDX}/manifest.rejected-abc.json`, bytesOf(1));
    kernel.files.set(`${IDX}/manifest.rejected.txt`, bytesOf(1));
    const report = await storeOf(kernel).clear();
    expect([...report.removed].sort()).toEqual([...names].sort());
    expect(report.removed[0]).toBe("manifest.json");
    expect(report.removed.indexOf("manifest.json")).toBeLessThan(report.removed.indexOf("manifest.rejected.json"));
    expect([...kernel.files.keys()].sort()).toEqual([`${IDX}/manifest.rejected-abc.json`, `${IDX}/manifest.rejected.txt`]);
    expect(report.failed).toEqual([]);
  });

  it("ne touche à aucun autre fichier du dossier (nom inconnu, nom invalide, sous-dossier)", async () => {
    const kernel = createFake(["with space.dsx", "../evil.dsx"]);
    kernel.files.set(`${IDX}/notes.txt`, bytesOf(1));
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(1));
    kernel.files.set(`${IDX}/other.json`, bytesOf(1));
    const report = await storeOf(kernel).clear();
    expect([...kernel.files.keys()].sort()).toEqual([`${IDX}/notes.txt`, `${IDX}/other.json`]);
    expect(report.removed).toEqual(["a.dsx"]);
    const removals = kernel.log.filter((l) => l.startsWith("removeFile"));
    expect(removals).toEqual([`removeFile ${IDX}/a.dsx`]);
  });

  it("dossier absent ou vide : rien à supprimer, pas d'erreur", async () => {
    const kernel = createFake();
    kernel.failWhen = (op) => (op === "readDir" ? new NotFoundError(200, "absent") : undefined);
    expect(await storeOf(kernel).clear()).toEqual({ removed: [], failed: [], manifestFailed: false });
  });

  it("un échec partiel est rapporté sans interrompre les autres suppressions", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "b.dsx", "manifest.json"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const boom = new KernelApiError(500, 1, "disque plein");
    kernel.failWhen = (op, path) => (op === "removeFile" && path.endsWith("/b.dsx") ? boom : undefined);
    const report = await storeOf(kernel).clear();
    expect([...report.removed].sort()).toEqual(["a.dsx", "manifest.json"]);
    expect(report.failed).toEqual([{ name: "b.dsx", error: boom }]);
    expect([...kernel.files.keys()]).toEqual([`${IDX}/b.dsx`]);
  });

  it("propage l'échec de la lecture du dossier (autre que absence)", async () => {
    const kernel = createFake();
    kernel.failWhen = (op) => (op === "readDir" ? new KernelApiError(500, 1, "readDir KO") : undefined);
    await expect(storeOf(kernel).clear()).rejects.toThrow(/readDir KO/);
  });

  it("supprime le manifeste en premier ; s'il échoue, aucun .dsx n'est supprimé (manifeste présent + .dsx absents = trou permanent)", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "b.dsx", "manifest.json"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const boom = new KernelApiError(500, 1, "manifeste verrouillé");
    kernel.failWhen = (op, path) => (op === "removeFile" && path.endsWith("/manifest.json") ? boom : undefined);
    const report = await storeOf(kernel).clear();
    expect(report.manifestFailed).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([{ name: "manifest.json", error: boom }]);
    expect([...kernel.files.keys()].sort()).toEqual([`${IDX}/a.dsx`, `${IDX}/b.dsx`, `${IDX}/manifest.json`]);
    const firstRemoval = kernel.log.find((l) => l.startsWith("removeFile"));
    expect(firstRemoval).toBe(`removeFile ${IDX}/manifest.json`);
  });

  it("manifeste supprimé en premier dans le cas nominal", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "manifest.json", "manifest.json.bak"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const report = await storeOf(kernel).clear();
    expect(report.manifestFailed).toBe(false);
    const removals = kernel.log.filter((l) => l.startsWith("removeFile"));
    expect(removals.slice(0, 2).every((l) => l.includes("manifest.json"))).toBe(true);
    expect(removals[2]).toBe(`removeFile ${IDX}/a.dsx`);
  });

  it("supprime le .bak et le .tmp avant le fichier final", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "a.dsx.bak", "a.dsx.id1.tmp"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    await storeOf(kernel).clear();
    const removals = kernel.log.filter((l) => l.startsWith("removeFile"));
    expect(removals.at(-1)).toBe(`removeFile ${IDX}/a.dsx`);
    expect(removals).toHaveLength(3);
  });

  it("si un .bak ne part pas, le .dsx correspondant est conservé (sinon il ressusciterait depuis le .bak) et signalé", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "a.dsx.bak", "b.dsx"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    const boom = new KernelApiError(500, 1, "bak verrouillé");
    kernel.failWhen = (op, path) => (op === "removeFile" && path.endsWith("/a.dsx.bak") ? boom : undefined);
    const report = await storeOf(kernel).clear();
    expect(report.removed).toEqual(["b.dsx"]);
    expect(report.failed.map((f) => f.name)).toEqual(["a.dsx.bak", "a.dsx"]);
    expect(report.failed[0]!.error).toBe(boom);
    expect([...kernel.files.keys()].sort()).toEqual([`${IDX}/a.dsx`, `${IDX}/a.dsx.bak`]);
    expect(report.manifestFailed).toBe(false);
  });

  it("relit le dossier à la fin et signale un fichier apparu pendant le vidage", async () => {
    const kernel = createFake();
    for (const n of ["a.dsx", "b.dsx"]) kernel.files.set(`${IDX}/${n}`, bytesOf(1));
    let injected = false;
    kernel.failWhen = (op, path) => {
      if (op === "removeFile" && path.endsWith("/a.dsx") && !injected) {
        injected = true;
        kernel.files.set(`${IDX}/late.dsx`, bytesOf(1)); // écrit par une indexation concurrente
      }
      return undefined;
    };
    const report = await storeOf(kernel).clear();
    expect(report.failed.map((f) => f.name)).toEqual(["late.dsx"]);
    expect(String((report.failed[0]!.error as Error).message)).toMatch(/pendant le vidage/);
    expect([...report.removed].sort()).toEqual(["a.dsx", "b.dsx"]);
  });

  it("signale l'impossibilité de relire le dossier après la boucle", async () => {
    const kernel = createFake();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(1));
    let reads = 0;
    const boom = new KernelApiError(500, 1, "relecture KO");
    kernel.failWhen = (op) => (op === "readDir" && ++reads === 2 ? boom : undefined);
    const report = await storeOf(kernel).clear();
    expect(report.removed).toEqual(["a.dsx"]);
    expect(report.failed).toEqual([{ name: "(relecture du dossier)", error: boom }]);
  });

  it("est sérialisé avec une écriture en cours du même nom", async () => {
    const kernel = createFake();
    const held = holdPuts(kernel);
    const store = storeOf(kernel);
    const writing = store.write("a.dsx", bytesOf(1));
    await flush();
    kernel.files.set(`${IDX}/a.dsx`, bytesOf(9));
    const clearing = store.clear();
    await flush();
    expect(kernel.log.some((l) => l.startsWith("removeFile"))).toBe(false);
    held.releases.forEach((r) => r());
    await writing;
    await clearing;
    expect([...kernel.files.keys()]).toEqual([]);
  });
});
