import { describe, expect, it, vi } from "vitest";
import { createLoadPdf, type PdfjsLoader } from "../../../src/indexer/loadPdf";

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
    });
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
