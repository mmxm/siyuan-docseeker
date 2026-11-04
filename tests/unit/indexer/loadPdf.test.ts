import { describe, expect, it, vi } from "vitest";
import { createLoadPdf, type PdfjsLoader } from "../../../src/indexer/loadPdf";

function fakePdfjs(options: { fail?: boolean } = {}) {
  const destroyTask = vi.fn(async () => undefined);
  const doc = { numPages: 3, getPage: vi.fn(), destroy: vi.fn() };
  const promise = options.fail ? Promise.reject(new Error("boom")) : Promise.resolve(doc);
  const getDocument = vi.fn((_src: { url: string }) => ({ promise, destroy: destroyTask }));
  const pdfjs = { getDocument } as unknown as PdfjsLoader;
  return { pdfjs, getDocument, destroyTask, doc };
}

describe("createLoadPdf", () => {
  it("encode chaque segment du chemin et renvoie le document", async () => {
    const f = fakePdfjs();
    const load = createLoadPdf(() => f.pdfjs);
    const doc = await load("assets/dossier a/é #1.pdf", new AbortController().signal);
    expect(doc).toBe(f.doc);
    expect(f.getDocument).toHaveBeenCalledWith({ url: "/assets/dossier%20a/%C3%A9%20%231.pdf" });
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
      getDocument: () => ({ promise: new Promise(() => undefined), destroy: destroyTask }),
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
});
