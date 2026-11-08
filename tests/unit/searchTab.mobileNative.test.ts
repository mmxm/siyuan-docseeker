// @vitest-environment jsdom
// Mobile : le visionneur natif de SiYuan est tenté d'abord (openPdfAtPage avec openNativePdf comme openTab, surlignages calculés
// comme sur le bureau) ; s'il lève : repli sur le visionneur maison, puis sur le navigateur, avec trace de la cause.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeEditorMissingError, NativeModelNotOpenError } from "../../src/siyuan/nativeMobilePdf";
import { openPdfAtPage as realOpenPdfAtPage } from "../../src/siyuan/openPdf";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { desktopProfile, mobileProfile } from "../../src/platform/profile";
import { cards, flush, harness as baseHarness, sharedInstances, submitQuery, PDF_A } from "./helpers/searchTabHarness";
import { createNativeFakes } from "./ui/nativeFakes";

const fakes = createNativeFakes();

function setup(over: Partial<SearchTabDeps> = {}, profile = mobileProfile()) {
  const openNativePdf = vi.fn(async (_target: unknown) => undefined);
  const openPdfFallback = vi.fn((_path: string, _page: number) => true);
  const openFloatingDialog = vi.fn();
  const viewerHandle = { dispose: vi.fn(), ready: Promise.resolve({ status: "attached" } as never) };
  const openPdfViewer = vi.fn(async (_options: Record<string, unknown>) => viewerHandle);
  const floating = { onPdfOpened: vi.fn(), onCloseRequest: vi.fn() };
  const h = baseHarness(
    { profile, floating, openPdfFallback, openFloatingDialog, openPdfViewer: openPdfViewer as never, openNativePdf: openNativePdf as never, ...over },
    fakes,
  );
  return { ...h, floating, openNativePdf, openPdfFallback, openPdfViewer, openFloatingDialog };
}

const clickFirst = async (h: ReturnType<typeof setup>) => {
  const tab = mountSearchTab(h.host, h.deps);
  await flush();
  await submitQuery(h.host, "chat");
  cards(h.host)[0]!.click();
  await flush();
  return tab;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mobile : visionneur natif d'abord", () => {
  it("openPdfAtPage reçoit openNativePdf comme openTab, avec chemin, page et rectangles du surlignage", async () => {
    const h = setup();
    const tab = await clickFirst(h);
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    const options = h.openPdfAtPage.mock.calls[0]![0] as Record<string, unknown>;
    expect(options["openTab"]).toBe(h.openNativePdf);
    expect(options["path"]).toBe(PDF_A);
    expect(options["page"]).toBe(2);
    expect(options["position"]).toBeUndefined();
    const rects = options["rects"] as Array<Record<string, number>>;
    expect(rects).toHaveLength(1);
    expect(rects[0]!["left"]).toBeCloseTo(50, 6);
    expect(rects[0]!["top"]).toBeCloseTo(60, 6);
    expect(rects[0]!["width"]).toBeCloseTo(20, 6);
    expect(rects[0]!["height"]).toBeCloseTo(5, 6);
    expect(options["focusIndex"]).toBe(0);
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    expect(h.deps.openTab).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("la recherche reste ouverte dessous : la fenêtre n'est pas fermée et rien n'est inerte", async () => {
    const h = setup();
    const tab = await clickFirst(h);
    expect(h.floating.onPdfOpened).not.toHaveBeenCalled();
    expect(h.host.hasAttribute("inert")).toBe(false);
    expect(h.host.closest(".b3-dialog")?.hasAttribute("inert") ?? false).toBe(false);
    tab.dispose();
  });

  it("natif en échec : cause tracée, repli sur le visionneur maison, pas de navigateur", async () => {
    const boom = new Error("éditeur absent");
    const h = setup();
    h.openPdfAtPage.mockRejectedValueOnce(boom);
    const tab = await clickFirst(h);
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("natif"), boom);
    expect(h.openPdfViewer).toHaveBeenCalledTimes(1);
    expect(h.openPdfViewer.mock.calls[0]![0]!["path"]).toBe(PDF_A);
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("natif ET visionneur maison en échec : repli navigateur, deux causes tracées", async () => {
    const nativeBoom = new Error("modèle fermé");
    const viewerBoom = new Error("dialogue refusé");
    const h = setup();
    h.openPdfAtPage.mockRejectedValueOnce(nativeBoom);
    h.openPdfViewer.mockRejectedValue(viewerBoom);
    const tab = await clickFirst(h);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), nativeBoom);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), viewerBoom);
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    tab.dispose();
  });

  it("natif en échec sans dialogue plein écran : navigateur", async () => {
    const h = setup();
    delete (h.deps as { openFloatingDialog?: unknown }).openFloatingDialog;
    h.openPdfAtPage.mockRejectedValueOnce(new Error("x"));
    const tab = await clickFirst(h);
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    tab.dispose();
  });

  it("surlignage indisponible (décodage en échec) : le natif s'ouvre quand même, sans rectangles", async () => {
    const h = setup();
    (h.deps.decodePageMatches as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("décodage"));
    const tab = await clickFirst(h);
    const options = h.openPdfAtPage.mock.calls[0]![0] as Record<string, unknown>;
    expect(options["openTab"]).toBe(h.openNativePdf);
    expect(options["rects"]).toEqual([]);
    tab.dispose();
  });

  it("une erreur du natif n'affiche pas « Impossible d'ouvrir ce PDF » (le repli prend le relais)", async () => {
    const h = setup();
    h.openPdfAtPage.mockRejectedValueOnce(new Error("x"));
    const tab = await clickFirst(h);
    const message = h.host.querySelector(".docseeker-message");
    expect(message).not.toBeNull();
    expect(message?.textContent ?? "").not.toContain("Impossible d'ouvrir ce PDF");
    tab.dispose();
  });
});

describe("mobile : natif cliqué mais modèle non ouvert (M1)", () => {
  it("le visionneur maison prend le relais ; le navigateur n'est PAS ouvert si lui aussi échoue", async () => {
    const timeout = new NativeModelNotOpenError(3000);
    const viewerBoom = new Error("dialogue refusé");
    const h = setup();
    h.openPdfAtPage.mockRejectedValueOnce(timeout);
    h.openPdfViewer.mockRejectedValue(viewerBoom);
    const tab = await clickFirst(h);
    expect(h.openPdfViewer).toHaveBeenCalledTimes(1);
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), timeout);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), viewerBoom);
    expect(h.host.querySelector(".docseeker-message")?.textContent ?? "").not.toBe("");
    tab.dispose();
  });

  it("sans visionneur maison disponible : message, toujours pas de navigateur", async () => {
    const h = setup();
    delete (h.deps as { openFloatingDialog?: unknown }).openFloatingDialog;
    h.openPdfAtPage.mockRejectedValueOnce(new NativeModelNotOpenError(3000));
    const tab = await clickFirst(h);
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    expect(h.host.querySelector(".docseeker-message")?.textContent ?? "").not.toBe("");
    tab.dispose();
  });

  it("éditeur absent : repli complet, navigateur compris", async () => {
    const h = setup();
    h.openPdfAtPage.mockRejectedValueOnce(new NativeEditorMissingError());
    h.openPdfViewer.mockRejectedValue(new Error("x"));
    const tab = await clickFirst(h);
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    tab.dispose();
  });
});

describe("mobile : annulation et portée du calque (M2, M3)", () => {
  it("transmet un AbortSignal à l'ouvreur natif et limite la recherche de la page à #modelMain", async () => {
    const h = setup();
    const tab = await clickFirst(h);
    const options = h.openPdfAtPage.mock.calls[0]![0] as { signal?: AbortSignal; resolvePageRoot?: () => Element | null };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const main = document.createElement("div");
    main.id = "modelMain";
    document.body.append(main);
    expect(options.resolvePageRoot?.()).toBe(main);
    main.remove();
    expect(options.resolvePageRoot?.()).toBeNull();
    tab.dispose();
  });

  it("le signal est annulé par une ouverture plus récente", async () => {
    const h = setup();
    const tab = await clickFirst(h);
    const first = h.openPdfAtPage.mock.calls[0]![0] as { signal: AbortSignal };
    cards(h.host)[0]!.click();
    await flush();
    expect(first.signal.aborted).toBe(true);
    tab.dispose();
  });

  it("natif en échec alors que l'ouverture est périmée : tracé (jamais silencieux), pas de repli", async () => {
    const boom = new Error("tardif");
    const h = setup();
    let rejectFirst!: (e: unknown) => void;
    h.openPdfAtPage.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    cards(h.host)[0]!.click(); // seconde ouverture : la première devient périmée
    await flush();
    rejectFirst(boom);
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("périmée"), boom);
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("Alt+clic : aucun split (pas de position), openTab de SiYuan jamais appelé", async () => {
    const h = setup();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    const options = h.openPdfAtPage.mock.calls[0]![0] as Record<string, unknown>;
    expect(options["openTab"]).toBe(h.openNativePdf);
    expect(options["position"]).toBeUndefined();
    expect(h.deps.openTab).not.toHaveBeenCalled();
    tab.dispose();
  });
});

describe("intégration : vrai openPdfAtPage et #model factice", () => {
  it("un natif qui renvoie undefined est accepté et le calque s'attache dans #modelMain, pas ailleurs", async () => {
    const outside = document.createElement("div");
    outside.innerHTML = '<div class="page" data-page-number="2" style="position:relative"></div>';
    document.body.append(outside); // une autre page 2 hors du modèle : ne doit pas recevoir le calque
    const openNativePdf = vi.fn(() => {
      const model = document.createElement("div");
      model.id = "model";
      model.innerHTML = '<div id="modelMain"><div class="page" data-page-number="2" style="position:relative"></div></div>';
      document.body.append(model);
      return undefined;
    });
    const h = setup({ openPdfAtPage: realOpenPdfAtPage, openNativePdf: openNativePdf as never });
    const tab = await clickFirst(h);
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(openNativePdf).toHaveBeenCalledTimes(1);
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    expect(h.floating.onPdfOpened).not.toHaveBeenCalled();
    const inModel = document.querySelector("#modelMain .page")!;
    expect(inModel.childElementCount).toBeGreaterThan(0);
    expect(outside.querySelector(".page")!.childElementCount).toBe(0);
    tab.dispose();
  });
});

describe("bureau inchangé", () => {
  it("le profil bureau utilise deps.openTab, ferme la fenêtre et n'appelle jamais le natif", async () => {
    const h = setup({}, desktopProfile());
    const tab = await clickFirst(h);
    const options = h.openPdfAtPage.mock.calls[0]![0] as Record<string, unknown>;
    expect(options["openTab"]).toBe(h.deps.openTab);
    expect(h.openNativePdf).not.toHaveBeenCalled();
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    expect(h.floating.onPdfOpened).toHaveBeenCalledTimes(1);
    tab.dispose();
  });
});
