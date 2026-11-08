// @vitest-environment jsdom
// E5 : sur mobile, un clic sur une vignette ouvre le visionneur de page (second dialogue plein écran) au lieu du navigateur.
// Le repli `window.open` ne sert que si le visionneur ne s'ouvre pas ; le bureau reste inchangé.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { desktopProfile, mobileProfile } from "../../src/platform/profile";
import { cards, flush, harness as baseHarness, input, sharedInstances, submitQuery, PDF_A } from "./helpers/searchTabHarness";
import { createNativeFakes } from "./ui/nativeFakes";
import type { FloatingDialogOptions } from "../../src/ui/nativeUiTypes";

const fakes = createNativeFakes();

function viewerHandle(report: unknown = { status: "attached", pageNumber: 2, keptRects: 1, droppedRects: 0, scrolled: true }) {
  return { dispose: vi.fn(), ready: Promise.resolve(report as never) };
}

function mobile(over: Partial<SearchTabDeps> = {}) {
  const openPdfFallback = vi.fn((_path: string, _page: number) => true);
  const openFloatingDialog = vi.fn();
  const handle = viewerHandle();
  const openPdfViewer = vi.fn(async (_options: Record<string, unknown>) => handle);
  const floating = { onPdfOpened: vi.fn(), onCloseRequest: vi.fn() };
  const h = baseHarness(
    { profile: mobileProfile(), floating, openPdfFallback, openFloatingDialog, openPdfViewer: openPdfViewer as never, ...over },
    fakes,
  );
  return { ...h, floating, openPdfFallback, openFloatingDialog, openPdfViewer, handle };
}

const clickFirst = async (h: ReturnType<typeof mobile>) => {
  const tab = mountSearchTab(h.host, h.deps);
  await flush();
  await submitQuery(h.host, "chat");
  const card = cards(h.host)[0]!;
  card.focus();
  card.click();
  await flush();
  return { tab, card };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mobile : visionneur de page", () => {
  it("un clic ouvre le visionneur (chemin, page, dialogue plein écran injecté), ni le navigateur, ni openTab, ni openPdfAtPage", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    expect(h.openPdfViewer).toHaveBeenCalledTimes(1);
    const options = h.openPdfViewer.mock.calls[0]![0]!;
    expect(options["path"]).toBe(PDF_A);
    expect(options["page"]).toBe(2);
    expect(options["openDialog"]).toBe(h.openFloatingDialog);
    expect(h.openPdfFallback).not.toHaveBeenCalled();
    expect(h.openPdfAtPage).not.toHaveBeenCalled();
    expect(h.deps.openTab).not.toHaveBeenCalled();
    expect(h.floating.onPdfOpened).not.toHaveBeenCalled(); // la recherche reste ouverte dessous
    tab.dispose();
  });

  it("Alt+clic : même visionneur", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    expect(h.openPdfViewer).toHaveBeenCalledTimes(1);
    expect(h.openPdfAtPage).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("getHighlights(page) donne les rectangles en pourcentages de la page demandée, pour la requête cliquée", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    const options = h.openPdfViewer.mock.calls[0]![0]! as { getHighlights(page: number, signal: AbortSignal): Promise<Array<Record<string, number>>> };
    const rects = await options.getHighlights(3, new AbortController().signal);
    expect(rects).toHaveLength(1);
    expect(rects[0]!["left"]).toBeCloseTo(50, 6);
    expect(rects[0]!["top"]).toBeCloseTo(60, 6);
    expect(rects[0]!["width"]).toBeCloseTo(20, 6);
    expect(rects[0]!["height"]).toBeCloseTo(5, 6);
    const decode = h.deps.decodePageMatches as unknown as ReturnType<typeof vi.fn>;
    expect(decode.mock.calls.at(-1)![1]).toBe(3);
    tab.dispose();
  });

  it("le renderer fourni sait compter les pages et rendre (partagé avec les vignettes)", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    const renderer = h.openPdfViewer.mock.calls[0]![0]!["renderer"] as Record<string, unknown>;
    expect(typeof renderer["getPageCount"]).toBe("function");
    expect(typeof renderer["renderCrop"]).toBe("function");
    expect(typeof renderer["getPageSize"]).toBe("function");
    tab.dispose();
  });

  it("la recherche (premier dialogue) est inerte pour le focus tant que le visionneur est ouvert", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    expect(h.host.hasAttribute("inert")).toBe(true);
    const onClosed = h.openPdfViewer.mock.calls[0]![0]!["onClosed"] as (info: { focus: boolean }) => void;
    onClosed({ focus: true });
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("à la fermeture, le focus revient à la carte cliquée", async () => {
    const h = mobile();
    const { tab, card } = await clickFirst(h);
    (document.activeElement as HTMLElement).blur();
    const onClosed = h.openPdfViewer.mock.calls[0]![0]!["onClosed"] as (info: { focus: boolean }) => void;
    onClosed({ focus: true });
    expect(document.activeElement).toBe(card);
    tab.dispose();
  });

  it("à la fermeture sans focus demandé (focus: false), le focus n'est pas forcé", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    (document.activeElement as HTMLElement).blur();
    const onClosed = h.openPdfViewer.mock.calls[0]![0]!["onClosed"] as (info: { focus: boolean }) => void;
    onClosed({ focus: false });
    expect(document.activeElement).toBe(document.body);
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("le focus revient à la carte même si le toucher ne l'a pas focalisée (iOS)", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    const card = cards(h.host)[0]!;
    (document.activeElement as HTMLElement).blur();
    card.click();
    await flush();
    (document.activeElement as HTMLElement).blur();
    (h.openPdfViewer.mock.calls[0]![0]!["onClosed"] as (info: { focus: boolean }) => void)({ focus: true });
    expect(document.activeElement).toBe(card);
    tab.dispose();
  });

  it("le visionneur qui ne s'ouvre pas (erreur) : trace avec la cause, puis repli navigateur", async () => {
    const boom = new Error("dialogue refusé");
    const h = mobile();
    h.openPdfViewer.mockRejectedValue(boom);
    const { tab } = await clickFirst(h);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("visionneur en échec ET repli bloqué : le message existant s'affiche", async () => {
    const h = mobile({ t: (key) => (key === "pdfBrowserOpenFailed" ? "BLOQUÉ" : key) });
    h.openPdfViewer.mockRejectedValue(new Error("x"));
    h.openPdfFallback.mockReturnValue(false);
    const { tab } = await clickFirst(h);
    expect(h.host.querySelector(".docseeker-message")!.textContent).toBe("BLOQUÉ");
    tab.dispose();
  });

  it("sans dialogue plein écran injecté : repli navigateur comme avant (E4)", async () => {
    const h = mobile();
    delete (h.deps as { openFloatingDialog?: unknown }).openFloatingDialog;
    const { tab } = await clickFirst(h);
    expect(h.openPdfViewer).not.toHaveBeenCalled();
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    tab.dispose();
  });

  it("statut inconnu du visionneur : « état inconnu » tracé ; rejet de ready : tracé aussi", async () => {
    const weird = mobile();
    weird.openPdfViewer.mockResolvedValue(viewerHandle({ status: "bizarre" }) as never);
    const a = await clickFirst(weird);
    expect(weird.onWarn).toHaveBeenCalledWith(expect.stringContaining("état inconnu"));
    a.tab.dispose();

    const rejecting = mobile();
    const boom = new Error("ready KO");
    const failing = Promise.reject(boom);
    failing.catch(() => undefined); // le test seul crée le rejet : on évite le rejet « non géré » avant que l'onglet n'y branche son traitement
    rejecting.openPdfViewer.mockResolvedValue({ dispose: vi.fn(), ready: failing } as never);
    const b = await clickFirst(rejecting);
    expect(rejecting.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    b.tab.dispose();
  });

  it("une seconde ouverture libère le visionneur précédent ; dispose() de l'onglet libère le dernier", async () => {
    const h = mobile();
    const first = viewerHandle();
    const second = viewerHandle();
    h.openPdfViewer.mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never);
    const { tab, card } = await clickFirst(h);
    card.click();
    await flush();
    expect(first.dispose).toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    tab.dispose();
    expect(second.dispose).toHaveBeenCalled();
  });

  it("onglet disposé pendant l'ouverture : le visionneur obtenu est libéré", async () => {
    const h = mobile();
    let resolveOpen!: (value: unknown) => void;
    h.openPdfViewer.mockImplementation(() => new Promise((resolve) => (resolveOpen = resolve)) as never);
    const { tab } = await clickFirst(h);
    tab.dispose();
    resolveOpen(h.handle);
    await flush();
    expect(h.handle.dispose).toHaveBeenCalled();
  });
});

type ViewerCallbacks = { onClosed(info: { focus: boolean }): void; onClosing(info: { focus: boolean }): void };
const callbacks = (h: ReturnType<typeof mobile>, index = 0): ViewerCallbacks => h.openPdfViewer.mock.calls[index]![0]! as unknown as ViewerCallbacks;
const blurActive = (): void => (document.activeElement as HTMLElement).blur();

describe("mobile : fuites et erreurs à la fermeture", () => {
  it("dispose() de l'onglet : un dispose() du visionneur qui lève n'empêche pas la libération du reste", async () => {
    const h = mobile();
    const boom = new Error("dispose KO");
    h.handle.dispose.mockImplementation(() => {
      throw boom;
    });
    const { tab } = await clickFirst(h);
    expect(h.host.querySelector(".docseeker-message")).not.toBeNull();
    expect(() => tab.dispose()).not.toThrow();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(h.host.querySelector(".docseeker-message")).toBeNull(); // fin de dispose() atteinte
    expect(h.host.hasAttribute("inert")).toBe(false);
  });

  it("seconde ouverture : le dispose() qui lève du précédent est tracé, la seconde ouverture a bien lieu", async () => {
    const h = mobile();
    const boom = new Error("précédent KO");
    const first = viewerHandle();
    first.dispose.mockImplementation(() => {
      throw boom;
    });
    h.openPdfViewer.mockResolvedValueOnce(first as never).mockResolvedValueOnce(viewerHandle() as never);
    const { tab, card } = await clickFirst(h);
    card.click();
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(h.openPdfViewer).toHaveBeenCalledTimes(2);
    tab.dispose();
  });

  it("onglet disposé pendant l'ouverture : un dispose() qui lève est tracé (pas de rejet non géré)", async () => {
    const h = mobile();
    const boom = new Error("tardif KO");
    h.handle.dispose.mockImplementation(() => {
      throw boom;
    });
    let resolveOpen!: (value: unknown) => void;
    h.openPdfViewer.mockImplementation(() => new Promise((resolve) => (resolveOpen = resolve)) as never);
    const { tab } = await clickFirst(h);
    tab.dispose();
    resolveOpen(h.handle);
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

describe("mobile : inert", () => {
  it("est levé dès onClosing, avant la destruction différée (onClosed)", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    expect(h.host.hasAttribute("inert")).toBe(true);
    callbacks(h).onClosing({ focus: true });
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("est levé sur la cible posée au départ, même si l'hôte a changé de dialogue entre-temps", async () => {
    const h = mobile();
    const a = document.createElement("div");
    a.className = "b3-dialog";
    const b = document.createElement("div");
    b.className = "b3-dialog";
    document.body.append(a, b);
    a.append(h.host);
    const { tab } = await clickFirst(h);
    expect(a.hasAttribute("inert")).toBe(true);
    b.append(h.host);
    callbacks(h).onClosing({ focus: true });
    expect(a.hasAttribute("inert")).toBe(false);
    expect(b.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("remplacement par une seconde ouverture : le rappel tardif du premier ne lève pas l'inert du second ; celui du second le lève", async () => {
    const h = mobile();
    h.openPdfViewer.mockResolvedValueOnce(viewerHandle() as never).mockResolvedValueOnce(viewerHandle() as never);
    const { tab, card } = await clickFirst(h);
    card.click();
    await flush();
    expect(h.host.hasAttribute("inert")).toBe(true);
    callbacks(h, 0).onClosing({ focus: false });
    callbacks(h, 0).onClosed({ focus: false });
    expect(h.host.hasAttribute("inert")).toBe(true);
    callbacks(h, 1).onClosing({ focus: true });
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("fermeture par le visionneur (onClosed seul) : inert levé aussi", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    callbacks(h).onClosed({ focus: true });
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });
});

describe("mobile : focus à la fermeture du visionneur", () => {
  it("carte re-rendue (nouvel élément, mêmes données) : le focus va à la nouvelle carte", async () => {
    const h = mobile();
    const { tab, card } = await clickFirst(h);
    card.replaceWith(card.cloneNode(true));
    const fresh = cards(h.host)[0]!;
    expect(fresh).not.toBe(card);
    blurActive();
    callbacks(h).onClosed({ focus: true });
    expect(document.activeElement).toBe(fresh);
    tab.dispose();
  });

  it("carte disparue : repli sur le champ de recherche", async () => {
    const h = mobile();
    const { tab, card } = await clickFirst(h);
    card.remove();
    blurActive();
    callbacks(h).onClosed({ focus: true });
    expect(document.activeElement).toBe(input(h.host));
    tab.dispose();
  });

  it("carte disparue et champ non focalisable : repli sur l'hôte", async () => {
    const h = mobile();
    const { tab, card } = await clickFirst(h);
    card.remove();
    input(h.host).disabled = true;
    blurActive();
    callbacks(h).onClosed({ focus: true });
    expect(document.activeElement).toBe(h.host);
    tab.dispose();
  });

  it("un focus déjà posé ailleurs (par SiYuan) n'est pas écrasé", async () => {
    const h = mobile();
    const { tab } = await clickFirst(h);
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    callbacks(h).onClosed({ focus: true });
    expect(document.activeElement).toBe(other);
    tab.dispose();
  });
});

describe("bureau inchangé", () => {
  it("profil bureau avec dialogue injecté : openPdfAtPage comme avant, jamais le visionneur", async () => {
    const openPdfViewer = vi.fn();
    const h = baseHarness({ profile: desktopProfile(), openFloatingDialog: vi.fn(), openPdfViewer: openPdfViewer as never }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(openPdfViewer).not.toHaveBeenCalled();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    expect(h.host.hasAttribute("inert")).toBe(false);
    tab.dispose();
  });

  it("profil bureau sans openTab : repli navigateur comme avant, jamais le visionneur", async () => {
    const openPdfViewer = vi.fn();
    const openPdfFallback = vi.fn(() => true);
    const h = baseHarness({ profile: desktopProfile(), openTab: undefined, openFloatingDialog: vi.fn(), openPdfViewer: openPdfViewer as never, openPdfFallback }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(openPdfViewer).not.toHaveBeenCalled();
    expect(openPdfFallback).toHaveBeenCalledTimes(1);
    tab.dispose();
  });
});

describe("intégration avec le vrai visionneur", () => {
  it("ouvre un dialogue plein écran empilé qui affiche « Page 2 / 3 » et la page rendue", async () => {
    const dialogs: Array<{ options: FloatingDialogOptions; container: HTMLElement }> = [];
    const openFloatingDialog = vi.fn((options: FloatingDialogOptions) => {
      const container = document.createElement("div");
      document.body.append(container);
      options.build(container);
      dialogs.push({ options, container });
      return { close: vi.fn(), isOpen: () => true };
    });
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
    const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob: (cb: (b: Blob) => void) => cb(new Blob(["x"])) };
    const doc = {
      numPages: 3,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() }),
      }),
      destroy: vi.fn(),
    };
    const floating = { onPdfOpened: vi.fn(), onCloseRequest: vi.fn() };
    const h = baseHarness(
      {
        profile: mobileProfile(),
        floating,
        openFloatingDialog: openFloatingDialog as never,
        loadDocument: async () => doc as never,
        createCanvas: () => canvas as never,
      },
      fakes,
    );
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(openFloatingDialog).toHaveBeenCalledTimes(1);
    expect(openFloatingDialog.mock.calls[0]![0].layout).toBe("fullscreen");
    const root = dialogs[0]!.container;
    expect(root.querySelector(".docseeker-viewer-label")!.textContent).toBe("Page 2 / 3");
    expect(root.querySelector("img")).not.toBeNull();
    expect(root.querySelectorAll(".docseeker-highlight")).toHaveLength(1);
    expect(h.host.hasAttribute("inert")).toBe(true);
    tab.dispose();
  });
});
