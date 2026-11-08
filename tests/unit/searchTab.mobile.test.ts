// @vitest-environment jsdom
// Recherche sur mobile (E4) : `openTab` est un stub qui ne fait rien. Le profil mobile ne passe donc JAMAIS par openTab / openPdfAtPage :
// un clic sur un résultat ouvre le PDF dans le navigateur (repli en attendant le visionneur de page), la recherche reste ouverte,
// le bouton « Ouvrir dans un nouvel onglet » n'existe pas, et un échec est affiché (message traduit) et tracé.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSearchTab } from "../../src/searchTab";
import { desktopProfile, mobileProfile } from "../../src/platform/profile";
import { cards, flush, harness as baseHarness, sharedInstances, submitQuery, PDF_A } from "./helpers/searchTabHarness";
import { nativeDown } from "./helpers/nativeDown";
import { createNativeFakes } from "./ui/nativeFakes";

const fakes = createNativeFakes();
const mobileFloating = () => ({ onPdfOpened: vi.fn(), onCloseRequest: vi.fn() });
const mobile = (over: Parameters<typeof baseHarness>[0] = {}) => {
  const openPdfFallback = vi.fn((_path: string, _page: number) => true);
  const floating = mobileFloating();
  const h = baseHarness({ profile: mobileProfile(), ...nativeDown(), floating, openPdfFallback, ...over }, fakes);
  return { ...h, floating, openPdfFallback };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mobile : clic sur un résultat", () => {
  it("ouvre le PDF par le repli (chemin et page du résultat), sans openTab ni openPdfAtPage", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.openPdfFallback).toHaveBeenCalledTimes(1);
    expect(h.openPdfFallback).toHaveBeenCalledWith(PDF_A, 2);
    expect(h.deps.openTab).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("la recherche RESTE ouverte : onPdfOpened n'est jamais appelé", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.floating.onPdfOpened).not.toHaveBeenCalled();
    expect(h.floating.onCloseRequest).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("Alt+clic et Ctrl+Entrée : même repli, aucune ouverture « à droite »", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    cards(h.host)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(h.openPdfFallback).toHaveBeenCalledTimes(2);
    expect(h.deps.openTab).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("sans openTab injecté (le plugin ne le passe pas sur mobile) : même comportement", async () => {
    const h = mobile({ openTab: undefined });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.openPdfFallback).toHaveBeenCalledTimes(1);
    expect(h.deps.openTab).toBeUndefined();
    tab.dispose();
  });

  it("repli qui renvoie faux (fenêtre bloquée) : message traduit visible, incident tracé, recherche ouverte", async () => {
    const h = mobile({ t: (key) => (key === "pdfBrowserOpenFailed" ? "TEXTE TRADUIT" : key) });
    h.openPdfFallback.mockReturnValue(false);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toBe("TEXTE TRADUIT");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("fenêtre"));
    expect(h.floating.onPdfOpened).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("repli qui lève : message DISTINCT de « fenêtre bloquée » (clé pdfBrowserOpenError), sans détail technique, cause tracée", async () => {
    const h = mobile({ t: (key) => (key === "pdfBrowserOpenError" ? "ERREUR TRADUITE" : key) });
    const boom = new Error("chemin invalide");
    h.openPdfFallback.mockImplementation(() => {
      throw boom;
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    const text = h.host.querySelector(".docseeker-message")!.textContent!;
    expect(text).toBe("ERREUR TRADUITE");
    expect(text).not.toContain("chemin invalide");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    tab.dispose();
  });

  it("repli qui lève : message distinct de « bloquée » même sans t", async () => {
    const h = mobile();
    h.openPdfFallback.mockImplementation(() => {
      throw new Error("x");
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    const text = h.host.querySelector(".docseeker-message")!.textContent!;
    expect(text).toMatch(/Impossible d'ouvrir ce PDF/);
    expect(text).not.toMatch(/bloqué/);
    tab.dispose();
  });

  it("repli qui lève : message visible (texte i18n par défaut sans t) et erreur tracée avec sa cause", async () => {
    const h = mobile();
    const boom = new Error("window.open KO");
    h.openPdfFallback.mockImplementation(() => {
      throw boom;
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toMatch(/Impossible d'ouvrir ce PDF/);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    tab.dispose();
  });

  it("succès : un message d'échec précédent est effacé", async () => {
    const h = mobile();
    h.openPdfFallback.mockReturnValueOnce(false).mockReturnValue(true);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).not.toBe("");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toBe("");
    tab.dispose();
  });
});

describe("mobile : bouton « Ouvrir dans un nouvel onglet »", () => {
  it("absent quand le plugin ne fournit pas onOpenInTab", async () => {
    const h = mobile();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(h.host.querySelector('button[aria-label="Ouvrir dans un nouvel onglet"]')).toBeNull();
    tab.dispose();
  });

  it("présent au bureau (onOpenInTab fourni) : comportement inchangé", async () => {
    const h = baseHarness({ profile: desktopProfile(), floating: { ...mobileFloating(), onOpenInTab: vi.fn() } }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(h.host.querySelector('button[aria-label="Ouvrir dans un nouvel onglet"]')).not.toBeNull();
    tab.dispose();
  });
});

describe("bureau : inchangé", () => {
  it("le profil bureau passe par openPdfAtPage et ferme la fenêtre, le repli n'est jamais utilisé", async () => {
    const openPdfFallback = vi.fn(() => true);
    const floating = { ...mobileFloating(), onOpenInTab: vi.fn() };
    const h = baseHarness({ profile: desktopProfile(), floating, openPdfFallback }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    expect(floating.onPdfOpened).toHaveBeenCalledTimes(1);
    expect(openPdfFallback).not.toHaveBeenCalled();
    tab.dispose();
  });
});
