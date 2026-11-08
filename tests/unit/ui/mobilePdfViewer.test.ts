// @vitest-environment jsdom
// Visionneur de page (E5 du chantier mobile) : second dialogue plein écran, page ENTIÈRE rendue par renderCrop, surlignages en <div>.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMobilePdfViewer, VIEWER_STRINGS, type MobilePdfViewerOptions } from "../../../src/ui/mobilePdfViewer";
import type { FloatingDialogOptions } from "../../../src/ui/nativeUiTypes";
import { PdfLoadError } from "../../../src/siyuan/pdfRenderer";

const PDF = "assets/Alpha-20240101120000-abc1234.pdf";
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeFloating() {
  const dialogs: Array<{ options: FloatingDialogOptions; container: HTMLElement; destroy(info?: { focus: boolean }): void }> = [];
  const openDialog = vi.fn((options: FloatingDialogOptions) => {
    const container = document.createElement("div");
    document.body.append(container);
    options.build(container);
    let open = true;
    const destroy = (info = { focus: true }): void => {
      if (!open) return;
      open = false;
      options.onClosing?.(info);
      container.remove();
      options.onDestroyed?.(info);
    };
    dialogs.push({ options, container, destroy });
    return { close: (o?: { focus?: boolean }) => destroy({ focus: o?.focus !== false }), isOpen: () => open };
  });
  return { dialogs, openDialog };
}

function setup(over: Partial<MobilePdfViewerOptions> = {}, renderer: Partial<MobilePdfViewerOptions["renderer"]> = {}) {
  const floating = fakeFloating();
  const renders: Array<{ page: number; scale: number; crop: unknown; signal?: AbortSignal | undefined; gate: Deferred<Blob> }> = [];
  const r: MobilePdfViewerOptions["renderer"] = {
    getPageCount: vi.fn(async () => 5),
    getPageSize: vi.fn(async () => ({ width: 600, height: 800 })),
    renderCrop: vi.fn((request) => {
      const gate = deferred<Blob>();
      renders.push({ page: request.page, scale: request.scale, crop: request.crop, signal: request.signal, gate });
      return gate.promise;
    }),
    ...renderer,
  };
  const urls: string[] = [];
  const revoked: string[] = [];
  const onWarn = vi.fn();
  const onClosed = vi.fn();
  const options: MobilePdfViewerOptions = {
    openDialog: floating.openDialog,
    renderer: r,
    path: PDF,
    page: 2,
    getHighlights: vi.fn(async () => [{ left: 10, top: 20, width: 30, height: 4 }]),
    onWarn,
    onClosed,
    getViewportWidth: () => 390,
    devicePixelRatio: 3,
    createObjectUrl: () => {
      const url = `blob:test/${urls.length}`;
      urls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => revoked.push(url),
    ...over,
  };
  const dialog = () => floating.dialogs[0]!;
  const root = () => dialog().container;
  const label = () => root().querySelector(".docseeker-viewer-label")!.textContent;
  const img = () => root().querySelector<HTMLImageElement>(".docseeker-viewer-page img");
  const highlights = () => [...root().querySelectorAll<HTMLElement>(".docseeker-highlight")];
  const button = (name: string) => root().querySelector<HTMLButtonElement>(`button[data-action="${name}"]`)!;
  const message = () => root().querySelector(".docseeker-viewer-message")?.textContent ?? "";
  const blob = () => new Blob(["x"], { type: "image/png" });
  return { options, floating, renders, urls, revoked, onWarn, onClosed, dialog, root, label, img, highlights, button, message, blob, renderer: r };
}

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => vi.restoreAllMocks());

describe("ouverture", () => {
  it("ouvre un dialogue plein écran titré, sans jamais prendre le focus", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const s = setup({ t: (key) => (key === "viewerTitle" ? "TITRE" : key) });
    await openMobilePdfViewer(s.options);
    const passed = s.floating.openDialog.mock.calls[0]![0];
    expect(passed.layout).toBe("fullscreen");
    expect(passed.title).toBe("TITRE");
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(focus).not.toHaveBeenCalled();
  });

  it("refuse un chemin invalide et une page non entière sans ouvrir de dialogue", async () => {
    const s = setup();
    await expect(openMobilePdfViewer({ ...s.options, path: "assets/../x.pdf" })).rejects.toThrow(/Invalid PDF path/);
    await expect(openMobilePdfViewer({ ...s.options, page: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(openMobilePdfViewer({ ...s.options, page: 1.5 })).rejects.toBeInstanceOf(RangeError);
    expect(s.floating.openDialog).not.toHaveBeenCalled();
  });

  it("propage l'échec d'ouverture du dialogue (l'appelant retombe sur le navigateur)", async () => {
    const s = setup();
    const boom = new Error("pas de dialogue");
    s.floating.openDialog.mockImplementation(() => {
      throw boom;
    });
    await expect(openMobilePdfViewer(s.options)).rejects.toBe(boom);
  });
});

describe("chargement puis page rendue", () => {
  it("affiche « Page N / M » et un message de chargement dès l'ouverture, sans rien d'autre", async () => {
    const gate = deferred<number>();
    const s = setup({}, { getPageCount: vi.fn(() => gate.promise) });
    await openMobilePdfViewer(s.options);
    expect(s.label()).toBe("Page 2");
    expect(s.message()).toBe(VIEWER_STRINGS["viewerLoading"]);
    expect(s.root().querySelector("[aria-busy='true']")).not.toBeNull();
    gate.resolve(5);
    await flush();
    expect(s.label()).toBe("Page 2 / 5");
  });

  it("rend la page ENTIÈRE, à la largeur de l'écran, devicePixelRatio plafonné à 2", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.renders).toHaveLength(1);
    const call = s.renders[0]!;
    expect(call.page).toBe(2);
    expect(call.crop).toEqual({ x0: 0, y0: 0, width: 600, height: 800 });
    expect(call.scale).toBeCloseTo((390 * 2) / 600, 6);
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [1, 1],
    [1.5, 1.5],
    [2, 2],
    [3, 2],
    [0, 1],
    [Number.NaN, 1],
  ])("devicePixelRatio %s donne un facteur %s", async (dpr, factor) => {
    const s = setup({ devicePixelRatio: dpr });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.renders[0]!.scale).toBeCloseTo((390 * factor) / 600, 6);
  });

  it("plafonne le nombre de pixels d'une page démesurée", async () => {
    const s = setup({}, { getPageSize: vi.fn(async () => ({ width: 600, height: 60000 })) });
    await openMobilePdfViewer(s.options);
    await flush();
    const { scale } = s.renders[0]!;
    expect(Math.ceil(600 * scale) * Math.ceil(60000 * scale)).toBeLessThanOrEqual(8_000_000);
  });

  it("affiche l'image rendue au ratio de la page et superpose un <div> de surlignage par mot", async () => {
    const s = setup();
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.img()!.getAttribute("src")).toBe("blob:test/0");
    expect(s.root().querySelector<HTMLElement>(".docseeker-viewer-page")!.dataset["aspectRatio"]).toBe("600 / 800");
    const [mark] = s.highlights();
    expect(s.highlights()).toHaveLength(1);
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    expect(mark!.style.cssText).toContain("left: 10%");
    expect(mark!.style.cssText).toContain("top: 20%");
    expect(mark!.style.cssText).toContain("width: 30%");
    expect(mark!.style.cssText).toContain("height: 4%");
    expect(mark!.style.pointerEvents).toBe("none");
    expect(s.root().querySelector(".docseeker-viewer-message")).toBeNull();
    expect(s.root().querySelector("[aria-busy='true']")).toBeNull();
    await expect(handle.ready).resolves.toEqual({ status: "attached", pageNumber: 2, keptRects: 1, droppedRects: 0, scrolled: true });
  });

  it("écarte les rectangles inexploitables et les compte dans le rapport", async () => {
    const s = setup({
      getHighlights: vi.fn(async () => [
        { left: 10, top: 20, width: 30, height: 4 },
        { left: Number.NaN, top: 0, width: 1, height: 1 },
        { left: 5, top: 5, width: 0, height: 2 },
      ]),
    });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.highlights()).toHaveLength(1);
    await expect(handle.ready).resolves.toMatchObject({ status: "attached", keptRects: 1, droppedRects: 2 });
  });

  it("n'écrit aucune donnée en HTML : un chemin ou un libellé piégé reste du texte", async () => {
    const s = setup({ t: (key) => (key === "viewerLoading" ? "<img src=x onerror=alert(1)>" : key) });
    await openMobilePdfViewer(s.options);
    expect(s.root().querySelector(".docseeker-viewer-message img")).toBeNull();
    expect(s.message()).toBe("<img src=x onerror=alert(1)>");
  });

  it("échec du calcul des surlignages : la page s'affiche quand même, avec une note visible et une trace", async () => {
    const boom = new Error("index illisible");
    const s = setup({ getHighlights: vi.fn(async () => Promise.reject(boom)) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.img()).not.toBeNull();
    expect(s.highlights()).toHaveLength(0);
    expect(s.root().querySelector(".docseeker-viewer-note")!.textContent).toBe(VIEWER_STRINGS["viewerNoHighlights"]);
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    await expect(handle.ready).resolves.toMatchObject({ status: "attached", keptRects: 0 });
  });
});

describe("navigation", () => {
  it("suivant et précédent : changent de page, mettent à jour le libellé et libèrent l'image précédente", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.button("next").click();
    await flush();
    expect(s.label()).toBe("Page 3 / 5");
    expect(s.renders[1]!.page).toBe(3);
    expect(s.revoked).toEqual(["blob:test/0"]);
    expect(s.img()).toBeNull(); // plus d'ancienne page pendant le chargement
    expect(s.highlights()).toHaveLength(0);
    s.renders[1]!.gate.resolve(s.blob());
    await flush();
    s.button("prev").click();
    await flush();
    expect(s.renders[2]!.page).toBe(2);
    expect(s.label()).toBe("Page 2 / 5");
  });

  it("les surlignages sont demandés pour la page affichée", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.button("next").click();
    await flush();
    expect(s.options.getHighlights).toHaveBeenLastCalledWith(3, expect.any(AbortSignal));
  });

  it("désactive précédent à la page 1 et suivant à la dernière page", async () => {
    const s = setup({ page: 1 });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.button("prev").disabled).toBe(true);
    expect(s.button("next").disabled).toBe(false);
    const last = setup({ page: 5 });
    await openMobilePdfViewer(last.options);
    await flush();
    const lastRoot = last.floating.dialogs[0]!.container;
    expect(lastRoot.querySelector<HTMLButtonElement>('button[data-action="next"]')!.disabled).toBe(true);
    expect(lastRoot.querySelector<HTMLButtonElement>('button[data-action="prev"]')!.disabled).toBe(false);
  });

  it("un seul rendu en vol : naviguer annule le précédent et ignore son résultat tardif", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    const first = s.renders[0]!;
    s.button("next").click();
    await flush();
    expect(first.signal!.aborted).toBe(true);
    first.gate.resolve(s.blob()); // arrive après l'abandon
    await flush();
    expect(s.img()).toBeNull();
    s.renders[1]!.gate.resolve(s.blob());
    await flush();
    expect(s.root().querySelectorAll("img")).toHaveLength(1);
    expect(s.label()).toBe("Page 3 / 5");
  });

  it("un rendu annulé (AbortError) n'est pas présenté comme une erreur", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.button("next").click();
    await flush();
    s.renders[0]!.gate.reject(new DOMException("annulé", "AbortError"));
    await flush();
    expect(s.message()).not.toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.onWarn).not.toHaveBeenCalled();
  });
});

describe("états d'erreur", () => {
  it("erreur de rendu : message traduit, bouton Réessayer, cause tracée ; Réessayer relance le rendu", async () => {
    const boom = new Error("toBlob null");
    const s = setup({ t: (key) => (key === "viewerRenderError" ? "ERREUR RENDU" : key === "viewerRetry" ? "RÉESSAYER" : key) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.reject(boom);
    await flush();
    expect(s.message()).toBe("ERREUR RENDU");
    expect(s.onWarn).toHaveBeenCalledWith(expect.stringContaining("2"), boom);
    expect(s.label()).toBe("Page 2 / 5");
    expect(s.button("retry").textContent).toBe("RÉESSAYER");
    expect(s.root().querySelector("[aria-busy='true']")).toBeNull();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty", pageNumber: 2, keptRects: 0, scrolled: false });
    s.button("retry").click();
    await flush();
    expect(s.renders).toHaveLength(2);
    expect(s.root().querySelector('button[data-action="retry"]')).toBeNull();
    s.renders[1]!.gate.resolve(s.blob());
    await flush();
    expect(s.img()).not.toBeNull();
    expect(s.message()).toBe("");
  });

  it("PDF protégé par mot de passe : message dédié, pas de Réessayer, aucun rendu", async () => {
    const password = Object.assign(new Error("No password given"), { name: "PasswordException" });
    const s = setup({}, { getPageCount: vi.fn(async () => Promise.reject(new PdfLoadError("Chargement impossible", password))) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerUnreadable"]);
    expect(s.root().querySelector('button[data-action="retry"]')).toBeNull();
    expect(s.renders).toHaveLength(0);
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.any(PdfLoadError));
    await expect(handle.ready).resolves.toMatchObject({ status: "empty", scrolled: false });
    expect(s.button("close")).not.toBeNull();
  });

  it("PDF invalide (InvalidPDFException) : même état « illisible »", async () => {
    const invalid = Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" });
    const s = setup({}, { getPageCount: vi.fn(async () => Promise.reject(new PdfLoadError("Chargement impossible", invalid))) });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerUnreadable"]);
  });

  it("échec de chargement ordinaire (réseau) : erreur de rendu avec Réessayer", async () => {
    const s = setup({}, { getPageCount: vi.fn(async () => Promise.reject(new PdfLoadError("Chargement impossible", new Error("network")))) });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.button("retry")).not.toBeNull();
  });

  it("page hors bornes : message dédié, aucun rendu, précédent ramène à la dernière page", async () => {
    const s = setup({ page: 9 });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerOutOfRange"]);
    expect(s.renders).toHaveLength(0);
    expect(s.label()).toBe("Page 9 / 5");
    expect(s.button("next").disabled).toBe(true);
    await expect(handle.ready).resolves.toMatchObject({ status: "empty", pageNumber: 9, scrolled: false });
    s.button("prev").click();
    await flush();
    expect(s.renders[0]!.page).toBe(5);
    expect(s.label()).toBe("Page 5 / 5");
  });
});

describe("fermeture", () => {
  it("Fermer ferme le dialogue, annule le rendu en vol, libère l'image et signale la fermeture UNE fois", async () => {
    const s = setup();
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.button("next").click();
    await flush();
    s.button("close").click();
    expect(s.renders[1]!.signal!.aborted).toBe(true);
    expect(s.revoked).toContain("blob:test/0");
    expect(s.onClosed).toHaveBeenCalledTimes(1);
    expect(s.dialog().container.isConnected).toBe(false);
    handle.dispose();
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it("libère l'URL de l'image affichée à la fermeture", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.button("close").click();
    expect(s.revoked).toEqual(["blob:test/0"]);
  });

  it("fermeture par SiYuan (Échap, croix) : même libération", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.dialog().destroy();
    expect(s.renders[0]!.signal!.aborted).toBe(true);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it("dispose() ferme le dialogue sans rendre le focus et résout ready en « disposed » si rien n'était rendu", async () => {
    const s = setup();
    const handle = await openMobilePdfViewer(s.options);
    handle.dispose();
    expect(s.onClosed).toHaveBeenCalledWith({ focus: false });
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed", pageNumber: 2, scrolled: false });
    handle.dispose();
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it("un rendu qui se termine après la fermeture ne crée ni image ni URL", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.button("close").click();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.urls).toHaveLength(0);
  });

  it("Fermer rend le focus à l'appelant (focus: true) quand l'utilisateur ferme", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.button("close").click();
    expect(s.onClosed).toHaveBeenCalledWith({ focus: true });
  });
});

describe("textes et accessibilité clavier", () => {
  it("toutes les clés du visionneur existent en français, en texte brut, identiques aux textes par défaut", () => {
    const fr = JSON.parse(readFileSync("i18n/fr_FR.json", "utf8")) as Record<string, string>;
    for (const [key, text] of Object.entries(VIEWER_STRINGS)) {
      expect(fr[key], key).toBe(text);
      expect(text, key).not.toMatch(/[<>]/);
    }
  });

  it("les boutons sont de vrais <button type=button> avec un libellé texte (clavier)", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    for (const name of ["prev", "next", "close"]) {
      const b = s.button(name);
      expect(b.tagName).toBe("BUTTON");
      expect(b.type).toBe("button");
      expect((b.getAttribute("aria-label") ?? b.textContent ?? "").length).toBeGreaterThan(0);
      expect(b.classList.contains("docseeker-viewer-button")).toBe(true);
    }
  });
});

const abortError = (): Error => Object.assign(new Error("annulé"), { name: "AbortError" });

describe("libération de l'image (iOS)", () => {
  it("retire l'attribut src de l'<img> avant de la détruire et de révoquer l'URL", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    const old = s.img()!;
    expect(old.getAttribute("src")).toBe("blob:test/0");
    s.button("next").click();
    await flush();
    expect(old.hasAttribute("src")).toBe(false);
    expect(s.revoked).toEqual(["blob:test/0"]);
  });
});

describe("navigation rapide et courses", () => {
  const ready = async (s: ReturnType<typeof setup>) => {
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    return handle;
  };

  it("trois clics rapides sur Suivant : seul le dernier rendu s'affiche, les autres sont annulés, au plus une URL vivante", async () => {
    const s = setup();
    await ready(s);
    s.button("next").click();
    s.button("next").click();
    s.button("next").click();
    await flush();
    expect(s.label()).toBe("Page 5 / 5");
    expect(s.renders.map((r) => r.page)).toEqual([2, 5]);
    expect(s.renders[0]!.signal!.aborted).toBe(true);
    for (const r of s.renders) r.gate.resolve(s.blob());
    await flush();
    expect(s.root().querySelectorAll("img")).toHaveLength(1);
    expect(s.urls.length - s.revoked.length).toBeLessThanOrEqual(1);
  });

  it("Suivant puis Précédent vers la même page : le résultat tardif de l'ancien rendu est ignoré", async () => {
    const s = setup();
    await ready(s);
    const old = s.renders[0]!;
    s.button("next").click();
    await flush();
    s.button("prev").click();
    await flush();
    expect(s.renders.map((r) => r.page)).toEqual([2, 3, 2]);
    old.gate.resolve(s.blob());
    s.renders[1]!.gate.resolve(s.blob());
    await flush();
    expect(s.img()).toBeNull();
    expect(s.urls).toHaveLength(0);
    s.renders[2]!.gate.resolve(s.blob());
    await flush();
    expect(s.urls).toHaveLength(1);
    expect(s.root().querySelectorAll("img")).toHaveLength(1);
  });

  it("Précédent pendant que getPageCount est en vol : la première réponse tardive est ignorée", async () => {
    const gates: Array<Deferred<number>> = [];
    const s = setup({}, { getPageCount: vi.fn(() => { const g = deferred<number>(); gates.push(g); return g.promise; }) });
    await openMobilePdfViewer(s.options);
    s.button("prev").click();
    await flush();
    expect(gates).toHaveLength(2);
    gates[0]!.resolve(5);
    await flush();
    expect(s.renders).toHaveLength(0);
    gates[1]!.resolve(5);
    await flush();
    expect(s.renders.map((r) => r.page)).toEqual([1]);
    expect(s.label()).toBe("Page 1 / 5");
  });

  it("autant de createObjectUrl que de revokeObjectUrl, une seule révocation par URL, Réessayer compris", async () => {
    const s = setup();
    const handle = await ready(s);
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.button("next").click();
    await flush();
    s.renders[1]!.gate.reject(new Error("KO"));
    await flush();
    s.button("retry").click();
    await flush();
    s.renders[2]!.gate.resolve(s.blob());
    await flush();
    s.button("next").click();
    await flush();
    s.renders[3]!.gate.resolve(s.blob());
    await flush();
    handle.dispose();
    expect(s.urls.length).toBe(3);
    expect(s.revoked.length).toBe(s.urls.length);
    expect(new Set(s.revoked).size).toBe(s.revoked.length);
  });

  it("clic sur un bouton désactivé (page 1, page M) : aucun rendu ; départ à la page M puis Suivant : rien", async () => {
    const first = setup({ page: 1 });
    await ready(first);
    first.button("prev").click();
    await flush();
    expect(first.renders).toHaveLength(1);
    const last = setup({ page: 5 });
    await ready(last);
    const next = last.floating.dialogs[0]!.container.querySelector<HTMLButtonElement>('button[data-action="next"]')!;
    next.click();
    await flush();
    expect(last.renders).toHaveLength(1);
    expect(last.renders[0]!.page).toBe(5);
  });
});

describe("fermeture à chaque étape : ready se résout, aucune trace", () => {
  it("pendant getPageCount", async () => {
    const gate = deferred<number>();
    const s = setup({}, { getPageCount: vi.fn(() => gate.promise) });
    const handle = await openMobilePdfViewer(s.options);
    s.button("close").click();
    gate.reject(abortError());
    await flush();
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
    expect(s.onWarn).not.toHaveBeenCalled();
  });

  it("pendant getPageSize", async () => {
    const gate = deferred<{ width: number; height: number }>();
    const s = setup({}, { getPageSize: vi.fn(() => gate.promise) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.button("close").click();
    gate.reject(abortError());
    await flush();
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
    expect(s.onWarn).not.toHaveBeenCalled();
  });

  it("pendant l'attente des surlignages (garde stale après await highlights)", async () => {
    const gate = deferred<readonly { left: number; top: number; width: number; height: number }[]>();
    const s = setup({ getHighlights: vi.fn(() => gate.promise) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.button("close").click();
    gate.resolve([{ left: 1, top: 1, width: 1, height: 1 }]);
    await flush();
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
    expect(s.urls).toHaveLength(0);
    expect(s.onWarn).not.toHaveBeenCalled();
  });

  it("pendant le chargement initial (avant tout await résolu)", async () => {
    const s = setup();
    const handle = await openMobilePdfViewer(s.options);
    handle.dispose();
    await flush();
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
    expect(s.onWarn).not.toHaveBeenCalled();
  });
});

describe("pixels", () => {
  it("grande largeur d'écran, page A4, devicePixelRatio 3 (plafonné à 2) : pixels plafonnés à 8 M", async () => {
    const s = setup({ getViewportWidth: () => 1600, devicePixelRatio: 3 }, { getPageSize: vi.fn(async () => ({ width: 595, height: 842 })) });
    await openMobilePdfViewer(s.options);
    await flush();
    const { scale } = s.renders[0]!;
    expect(scale).toBeLessThan((1600 * 2) / 595);
    expect(Math.ceil(595 * scale) * Math.ceil(842 * scale)).toBeLessThanOrEqual(8_000_000);
  });

  it.each([Number.NaN, 0])("devicePixelRatio invalide (%s) sur grand écran : facteur 1", async (dpr) => {
    const s = setup({ getViewportWidth: () => 1000, devicePixelRatio: dpr }, { getPageSize: vi.fn(async () => ({ width: 595, height: 842 })) });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.renders[0]!.scale).toBeCloseTo(1000 / 595, 6);
  });
});

describe("annulations et erreurs d'annulation", () => {
  it("getHighlights qui rejette en AbortError après une navigation : aucune trace", async () => {
    const gates: Array<Deferred<readonly never[]>> = [];
    const s = setup({ getHighlights: vi.fn(() => { const g = deferred<readonly never[]>(); gates.push(g); return g.promise; }) });
    await openMobilePdfViewer(s.options);
    await flush();
    s.button("next").click();
    await flush();
    gates[0]!.reject(abortError());
    await flush();
    expect(s.onWarn).not.toHaveBeenCalled();
  });

  it("un AbortError NON obsolète de getHighlights est tracé (la page reste affichée)", async () => {
    const boom = abortError();
    const s = setup({ getHighlights: vi.fn(async () => Promise.reject(boom)) });
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(s.img()).not.toBeNull();
  });

  it("un AbortError NON obsolète du rendu passe en état erreur avec Réessayer", async () => {
    const s = setup();
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.reject(abortError());
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.button("retry")).not.toBeNull();
    expect(s.onWarn).toHaveBeenCalled();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty" });
  });

  it("un AbortError non obsolète de getPageCount passe aussi en erreur", async () => {
    const s = setup({}, { getPageCount: vi.fn(async () => Promise.reject(abortError())) });
    await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.button("retry")).not.toBeNull();
  });

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])("nombre de pages invalide (%s) : état illisible, tracé, aucun rendu", async (count) => {
    const s = setup({}, { getPageCount: vi.fn(async () => count) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerUnreadable"]);
    expect(s.renders).toHaveLength(0);
    expect(s.onWarn).toHaveBeenCalled();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty" });
  });
});

describe("robustesse de load()", () => {
  it("un libellé qui lève pendant l'affichage de l'état : tracé, état erreur, ready résolu", async () => {
    const s = setup({ t: (key) => { if (key === "viewerLoading") throw new Error("t KO"); return key; } });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    expect(s.onWarn).toHaveBeenCalled();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty" });
  });

  it("même l'état erreur qui lève : tracé et ready résolu (pas de rejet non géré)", async () => {
    const s = setup({
      t: (key) => {
        if (key === "viewerLoading" || key === "viewerRenderError") throw new Error("t KO");
        return key;
      },
    });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    expect(s.onWarn).toHaveBeenCalled();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty" });
  });
});

describe("délai maximum", () => {
  afterEach(() => vi.useRealTimers());

  it("getPageCount qui ne répond jamais : état erreur avec Réessayer après le délai", async () => {
    vi.useFakeTimers();
    const s = setup({ requestTimeoutMs: 50 }, { getPageCount: vi.fn(() => new Promise<number>(() => undefined)) });
    const handle = await openMobilePdfViewer(s.options);
    await vi.advanceTimersByTimeAsync(60);
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.button("retry")).not.toBeNull();
    expect(s.onWarn).toHaveBeenCalled();
    await expect(handle.ready).resolves.toMatchObject({ status: "empty" });
  });

  it("renderCrop qui ne répond jamais : erreur, rendu annulé, Réessayer relance", async () => {
    vi.useFakeTimers();
    const s = setup({ requestTimeoutMs: 50 }, { renderCrop: vi.fn(() => new Promise<Blob>(() => undefined)) });
    await openMobilePdfViewer(s.options);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.message()).toBe(VIEWER_STRINGS["viewerLoading"]);
    await vi.advanceTimersByTimeAsync(60);
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    const crop = s.renderer.renderCrop as ReturnType<typeof vi.fn>;
    expect(crop.mock.calls[0]![0].signal.aborted).toBe(true);
    s.button("retry").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(crop).toHaveBeenCalledTimes(2);
  });

  it("une réponse dans les temps n'est pas affectée par le délai", async () => {
    vi.useFakeTimers();
    const s = setup({ requestTimeoutMs: 50 });
    await openMobilePdfViewer(s.options);
    await vi.advanceTimersByTimeAsync(10);
    s.renders[0]!.gate.resolve(s.blob());
    await vi.advanceTimersByTimeAsync(100);
    expect(s.img()).not.toBeNull();
    expect(s.onWarn).not.toHaveBeenCalled();
  });
});

describe("surlignages et image", () => {
  it("plafonne les <div> de surlignage à 500 et compte l'excédent dans droppedRects", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ left: 1, top: (i % 90) + 1, width: 5, height: 1 }));
    const s = setup({ getHighlights: vi.fn(async () => many) });
    const handle = await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    expect(s.highlights()).toHaveLength(500);
    await expect(handle.ready).resolves.toMatchObject({ status: "attached", keptRects: 500, droppedRects: 100 });
  });

  it("l'<img> qui échoue à charger : trace, état erreur avec Réessayer", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    s.img()!.dispatchEvent(new Event("error"));
    expect(s.onWarn).toHaveBeenCalled();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerRenderError"]);
    expect(s.button("retry")).not.toBeNull();
    expect(s.urls.length).toBe(s.revoked.length);
  });

  it("l'erreur d'une image obsolète (page changée) est ignorée", async () => {
    const s = setup();
    await openMobilePdfViewer(s.options);
    await flush();
    s.renders[0]!.gate.resolve(s.blob());
    await flush();
    const old = s.img()!;
    s.button("next").click();
    await flush();
    old.dispatchEvent(new Event("error"));
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(s.message()).toBe(VIEWER_STRINGS["viewerLoading"]);
  });
});

describe("rappels de fermeture", () => {
  it("onClosing est appelé UNE fois dès le début de la destruction, avant onClosed", async () => {
    const order: string[] = [];
    const s = setup({ onClosing: () => order.push("closing"), onClosed: () => order.push("closed") });
    const handle = await openMobilePdfViewer(s.options);
    s.button("close").click();
    handle.dispose();
    expect(order).toEqual(["closing", "closed"]);
  });

  it("un onClosing qui lève est tracé sans empêcher la fermeture", async () => {
    const boom = new Error("onClosing KO");
    const s = setup({ onClosing: () => { throw boom; } });
    await openMobilePdfViewer(s.options);
    s.button("close").click();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it("garde-fou : un dialogue déjà fermé à l'ouverture déclenche onClosing et onClosed", async () => {
    const s = setup();
    s.floating.openDialog.mockImplementation((options) => {
      const container = document.createElement("div");
      options.build(container);
      return { close: () => undefined, isOpen: () => false };
    });
    const onClosing = vi.fn();
    const handle = await openMobilePdfViewer({ ...s.options, onClosing });
    expect(onClosing).toHaveBeenCalledTimes(1);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
    await expect(handle.ready).resolves.toMatchObject({ status: "disposed" });
  });
});
