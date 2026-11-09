import { describe, expect, it, vi } from "vitest";
import { createLoadPdf, type PdfjsLoader } from "../../../src/indexer/loadPdf";
import { PDFJS_BASE_URL, PDFJS_GETDOCUMENT_RESOURCES } from "../../../src/siyuan/pdfjsLoader";

/** Options de ressources attendues partout (images JBIG2/JPX, ICC, polices, CMap). */
const RES = PDFJS_GETDOCUMENT_RESOURCES;

function fakePdfjs(options: { fail?: boolean } = {}) {
  const destroyTask = vi.fn(async () => undefined);
  const doc = { numPages: 3, getPage: vi.fn(), destroy: vi.fn() };
  const promise = options.fail ? Promise.reject(new Error("boom")) : Promise.resolve(doc);
  const getDocument = vi.fn((_src: { url: string }) => ({
    promise,
    destroy: destroyTask,
  }));
  const pdfjs = { getDocument } as unknown as PdfjsLoader;
  return { pdfjs, getDocument, destroyTask, doc };
}

describe("createLoadPdf", () => {
  it("encode chaque segment du chemin et renvoie le document", async () => {
    const f = fakePdfjs();
    const load = createLoadPdf(() => f.pdfjs);
    const doc = await load("assets/dossier a/é #1.pdf", new AbortController().signal);
    expect(doc).toBe(f.doc);
    expect(f.getDocument).toHaveBeenCalledWith({
      url: "/assets/dossier%20a/%C3%A9%20%231.pdf",
      ...RES,
    });
  });

  it("bureau : getDocument reçoit l'URL et les ressources PDF.js, sans option de téléchargement", async () => {
    const f = fakePdfjs();
    await createLoadPdf(() => f.pdfjs)("assets/a.pdf", new AbortController().signal);
    expect(f.getDocument.mock.calls[0]![0]).toStrictEqual({ url: "/assets/a.pdf", ...RES });
    expect(f.getDocument.mock.calls[0]![0]).toHaveProperty("wasmUrl", "/stage/protyle/js/pdf/wasm/");
    const g = fakePdfjs();
    await createLoadPdf(() => g.pdfjs, undefined, { rangeOnly: false })("assets/a.pdf", new AbortController().signal);
    expect(g.getDocument.mock.calls[0]![0]).toStrictEqual({ url: "/assets/a.pdf", ...RES });
  });

  it("ressources PDF.js : URL de dossiers sous la base SiYuan, terminées par « / », cMapPacked actif", () => {
    expect(RES.cMapPacked).toBe(true);
    for (const key of ["wasmUrl", "iccUrl", "standardFontDataUrl", "cMapUrl"] as const) {
      expect(RES[key].startsWith(PDFJS_BASE_URL)).toBe(true);
      expect(RES[key].endsWith("/")).toBe(true);
    }
    expect(RES.wasmUrl).toBe("/stage/protyle/js/pdf/wasm/");
    expect(RES.iccUrl).toBe("/stage/protyle/js/pdf/iccs/");
    expect(RES.standardFontDataUrl).toBe("/stage/protyle/js/pdf/standard_fonts/");
    expect(RES.cMapUrl).toBe("/stage/protyle/js/pdf/cmaps/");
  });

  it("rangeOnly : plages seules (disableAutoFetch et disableStream), sinon PDF.js télécharge tout le fichier", async () => {
    const f = fakePdfjs();
    await createLoadPdf(() => f.pdfjs, undefined, { rangeOnly: true })("assets/a.pdf", new AbortController().signal);
    expect(f.getDocument.mock.calls[0]![0]).toStrictEqual({ url: "/assets/a.pdf", ...RES, disableAutoFetch: true, disableStream: true });
  });

  it("canvasMaxAreaInBytes : passé à getDocument seulement s'il est fourni (mobile), jamais par défaut (bureau)", async () => {
    const m = fakePdfjs();
    await createLoadPdf(() => m.pdfjs, undefined, { rangeOnly: true, canvasMaxAreaInBytes: 32_000_000 })("assets/a.pdf", new AbortController().signal);
    expect(m.getDocument.mock.calls[0]![0]).toStrictEqual({ url: "/assets/a.pdf", ...RES, disableAutoFetch: true, disableStream: true, canvasMaxAreaInBytes: 32_000_000 });
    const d = fakePdfjs();
    await createLoadPdf(() => d.pdfjs, undefined, { rangeOnly: false })("assets/a.pdf", new AbortController().signal);
    expect(d.getDocument.mock.calls[0]![0]).not.toHaveProperty("canvasMaxAreaInBytes");
    const u = fakePdfjs();
    await createLoadPdf(() => u.pdfjs, undefined, {})("assets/a.pdf", new AbortController().signal);
    expect(u.getDocument.mock.calls[0]![0]).toStrictEqual({ url: "/assets/a.pdf", ...RES });
  });

  it("échoue clairement si PDF.js n'est pas disponible", async () => {
    const load = createLoadPdf(() => undefined);
    await expect(load("assets/a.pdf", new AbortController().signal)).rejects.toThrow(/PDF\.js/);
  });

  it("refuse un signal déjà annulé sans appeler PDF.js", async () => {
    const f = fakePdfjs();
    const controller = new AbortController();
    controller.abort();
    await expect(createLoadPdf(() => f.pdfjs)("assets/a.pdf", controller.signal)).rejects.toThrow();
    expect(f.getDocument).not.toHaveBeenCalled();
  });

  it("détruit la tâche de chargement si le signal est annulé pendant le chargement", async () => {
    const destroyTask = vi.fn(async () => undefined);
    const pdfjs = {
      getDocument: () => ({
        promise: new Promise(() => undefined),
        destroy: destroyTask,
      }),
    } as unknown as PdfjsLoader;
    const controller = new AbortController();
    const pending = createLoadPdf(() => pdfjs)("assets/a.pdf", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(destroyTask).toHaveBeenCalledTimes(1);
  });

  it("signale à onWarn l'échec de destruction de la tâche sur le chemin d'annulation", async () => {
    const pdfjs = {
      getDocument: () => ({
        promise: new Promise(() => undefined),
        destroy: async () => {
          throw new Error("task boom");
        },
      }),
    } as unknown as PdfjsLoader;
    const onWarn = vi.fn();
    const controller = new AbortController();
    const pending = createLoadPdf(() => pdfjs, onWarn)("assets/a.pdf", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("task boom"));
  });

  it("signale à onWarn l'échec de destroy() du document annulé juste après sa résolution", async () => {
    const pdfjs = {
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 1, getPage: vi.fn() }),
        destroy: async () => {
          throw new Error("late boom");
        },
      }),
    } as unknown as PdfjsLoader;
    const onWarn = vi.fn();
    const controller = new AbortController();
    const pending = createLoadPdf(() => pdfjs, onWarn)("assets/a.pdf", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("late boom"));
  });

  it("propage l'échec de PDF.js", async () => {
    const f = fakePdfjs({ fail: true });
    await expect(createLoadPdf(() => f.pdfjs)("assets/a.pdf", new AbortController().signal)).rejects.toThrow("boom");
  });

  describe("libération du document", () => {
    function pdfjsWith(doc: Record<string, unknown>) {
      const destroyTask = vi.fn(async () => undefined);
      const pdfjs = {
        getDocument: () => ({
          promise: Promise.resolve(doc),
          destroy: destroyTask,
        }),
      } as unknown as PdfjsLoader;
      return { pdfjs, destroyTask };
    }

    it("expose un destroy() qui détruit la tâche quand le proxy n'en a pas (PDF.js 6.4.299)", async () => {
      const getPage = vi.fn();
      const doc = { numPages: 3, getPage };
      const { pdfjs, destroyTask } = pdfjsWith(doc);
      const loaded = await createLoadPdf(() => pdfjs)("assets/a.pdf", new AbortController().signal);
      expect(loaded.numPages).toBe(3);
      await loaded.getPage(1);
      expect(getPage).toHaveBeenCalledWith(1);
      await loaded.destroy();
      expect(destroyTask).toHaveBeenCalledTimes(1);
    });

    it("est idempotent : la tâche n'est détruite qu'une fois", async () => {
      const { pdfjs, destroyTask } = pdfjsWith({
        numPages: 1,
        getPage: vi.fn(),
      });
      const loaded = await createLoadPdf(() => pdfjs)("assets/a.pdf", new AbortController().signal);
      await Promise.all([loaded.destroy(), loaded.destroy()]);
      await loaded.destroy();
      expect(destroyTask).toHaveBeenCalledTimes(1);
    });

    it("appelle aussi le destroy natif du proxy, une seule fois, puis détruit la tâche", async () => {
      const native = vi.fn(async () => undefined);
      const { pdfjs, destroyTask } = pdfjsWith({
        numPages: 1,
        getPage: vi.fn(),
        destroy: native,
      });
      const loaded = await createLoadPdf(() => pdfjs)("assets/a.pdf", new AbortController().signal);
      await loaded.destroy();
      await loaded.destroy();
      expect(native).toHaveBeenCalledTimes(1);
      expect(destroyTask).toHaveBeenCalledTimes(1);
    });

    it("détruit la tâche même si le destroy natif échoue, et propage l'erreur", async () => {
      const native = vi.fn(async () => {
        throw new Error("native boom");
      });
      const { pdfjs, destroyTask } = pdfjsWith({
        numPages: 1,
        getPage: vi.fn(),
        destroy: native,
      });
      const loaded = await createLoadPdf(() => pdfjs)("assets/a.pdf", new AbortController().signal);
      await expect(loaded.destroy()).rejects.toThrow("native boom");
      expect(destroyTask).toHaveBeenCalledTimes(1);
    });

    it("propage l'échec de destroy de la tâche", async () => {
      const doc = { numPages: 1, getPage: vi.fn() };
      const pdfjs = {
        getDocument: () => ({
          promise: Promise.resolve(doc),
          destroy: async () => {
            throw new Error("task boom");
          },
        }),
      } as unknown as PdfjsLoader;
      const loaded = await createLoadPdf(() => pdfjs)("assets/a.pdf", new AbortController().signal);
      await expect(loaded.destroy()).rejects.toThrow("task boom");
    });

    it("ne fuit rien si l'annulation survient juste après la résolution de la tâche", async () => {
      const native = vi.fn(async () => undefined);
      const { pdfjs, destroyTask } = pdfjsWith({
        numPages: 1,
        getPage: vi.fn(),
        destroy: native,
      });
      const controller = new AbortController();
      const pending = createLoadPdf(() => pdfjs)("assets/a.pdf", controller.signal);
      controller.abort(); // la tâche est déjà résolue (microtâche) : le document ne doit pas rester vivant
      await expect(pending).rejects.toThrow();
      expect(destroyTask).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createLoadPdf : workerSrc de PDF.js", () => {
  const EXPECTED = "/stage/protyle/js/pdf/pdf.worker.compat.mjs?v=6.4.299-siyuan.2";
  const signal = () => new AbortController().signal;

  function withOptions(workerSrc: string | undefined) {
    const f = fakePdfjs();
    const options: { workerSrc?: string } = workerSrc === undefined ? {} : { workerSrc };
    const seen: Array<string | undefined> = [];
    f.getDocument.mockImplementation((_src: { url: string }) => {
      seen.push(options.workerSrc);
      return { promise: Promise.resolve(f.doc), destroy: f.destroyTask };
    });
    const pdfjs = { getDocument: f.getDocument, GlobalWorkerOptions: options } as unknown as PdfjsLoader;
    return { pdfjs, options, seen };
  }

  it("renseigne workerSrc vide avant getDocument, avec la valeur exacte", async () => {
    const f = withOptions("");
    await createLoadPdf(() => f.pdfjs)("assets/a.pdf", signal());
    expect(f.options.workerSrc).toBe(EXPECTED);
    expect(f.seen).toEqual([EXPECTED]);
  });

  it("renseigne workerSrc absent", async () => {
    const f = withOptions(undefined);
    await createLoadPdf(() => f.pdfjs)("assets/a.pdf", signal());
    expect(f.seen).toEqual([EXPECTED]);
  });

  it("n'écrase jamais un workerSrc déjà défini", async () => {
    const f = withOptions("/custom/worker.mjs");
    await createLoadPdf(() => f.pdfjs)("assets/a.pdf", signal());
    expect(f.options.workerSrc).toBe("/custom/worker.mjs");
    expect(f.seen).toEqual(["/custom/worker.mjs"]);
  });

  it("est idempotent sur plusieurs appels", async () => {
    const f = withOptions("");
    const load = createLoadPdf(() => f.pdfjs);
    await load("assets/a.pdf", signal());
    await load("assets/b.pdf", signal());
    expect(f.seen).toEqual([EXPECTED, EXPECTED]);
  });

  it("sans GlobalWorkerOptions : pas d'exception de notre part, mais une trace lisible", async () => {
    const f = fakePdfjs();
    const onWarn = vi.fn();
    const doc = await createLoadPdf(() => f.pdfjs, onWarn)("assets/a.pdf", signal());
    expect(doc).toBe(f.doc);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toMatch(/GlobalWorkerOptions/);
  });
});

describe("createLoadPdf avec un getter asynchrone", () => {
  it("attend le getter asynchrone puis charge le document", async () => {
    const f = fakePdfjs();
    const load = createLoadPdf(async () => f.pdfjs);
    await expect(load("assets/a.pdf", new AbortController().signal)).resolves.toBe(f.doc);
    expect(f.getDocument).toHaveBeenCalledWith({ url: "/assets/a.pdf", ...RES });
  });

  it("propage l'échec du getter asynchrone", async () => {
    const load = createLoadPdf(async () => {
      throw new Error("injection KO");
    });
    await expect(load("assets/a.pdf", new AbortController().signal)).rejects.toThrow("injection KO");
  });

  it("échoue clairement si le getter asynchrone renvoie undefined", async () => {
    const load = createLoadPdf(async () => undefined);
    await expect(load("assets/a.pdf", new AbortController().signal)).rejects.toThrow(/PDF\.js/);
  });

  it("ne démarre rien si le signal est déjà annulé", async () => {
    const getter = vi.fn(async () => fakePdfjs().pdfjs);
    const controller = new AbortController();
    controller.abort();
    await expect(createLoadPdf(getter)("assets/a.pdf", controller.signal)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("abandonne si l'annulation survient pendant l'attente du getter", async () => {
    const f = fakePdfjs();
    const controller = new AbortController();
    const load = createLoadPdf(async () => {
      controller.abort();
      return f.pdfjs;
    });
    await expect(load("assets/a.pdf", controller.signal)).rejects.toThrow();
    expect(f.getDocument).not.toHaveBeenCalled();
  });

  it("rend la main tout de suite si l'annulation tombe pendant l'attente d'un getter resté en attente", async () => {
    const f = fakePdfjs();
    const controller = new AbortController();
    const never = new Promise<PdfjsLoader>(() => undefined);
    const load = createLoadPdf(() => never);
    const outcome = load("assets/a.pdf", controller.signal).then(
      () => "résolu",
      (error: unknown) => (error as Error).name,
    );
    controller.abort();
    const winner = await Promise.race([outcome, new Promise((r) => setTimeout(() => r("bloqué"), 50))]);
    expect(winner).toBe("AbortError");
    expect(f.getDocument).not.toHaveBeenCalled();
  });

  it("le rejet tardif du getter après annulation n'est pas un rejet non géré", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      let fail: (e: Error) => void = () => undefined;
      const slow = new Promise<PdfjsLoader>((_, reject) => {
        fail = reject;
      });
      const outcome = createLoadPdf(() => slow)("assets/a.pdf", controller.signal).catch(() => undefined);
      controller.abort();
      await outcome;
      fail(new Error("échec tardif"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("accepte un thenable qui n'est pas une Promise", async () => {
    const f = fakePdfjs();
    const thenable = { then: (resolve: (v: PdfjsLoader) => void) => resolve(f.pdfjs) };
    const load = createLoadPdf(() => thenable as unknown as Promise<PdfjsLoader>);
    await expect(load("assets/a.pdf", new AbortController().signal)).resolves.toBe(f.doc);
  });

  it("getter synchrone : getDocument est appelé sans aucune attente de microtâche", () => {
    const f = fakePdfjs();
    const load = createLoadPdf(() => f.pdfjs);
    void load("assets/a.pdf", new AbortController().signal);
    expect(f.getDocument).toHaveBeenCalledTimes(1);
  });
});
