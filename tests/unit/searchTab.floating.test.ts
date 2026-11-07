// @vitest-environment jsdom
// Assemblage pour la fenêtre flottante : session (restauration, mémorisation), ouverture d'un PDF depuis le dialogue (le plugin
// ferme APRÈS l'ouverture, le calque de surlignage survit), câblage d'Échap et du bouton « nouvel onglet », coexistence avec un onglet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import type { SearchSessionState } from "../../src/search/searchSession";
import { NO_FILTERS, type SearchOptions } from "../../src/search/resultOptions";
import { openPdfAtPage as realOpenPdfAtPage, type OpenTabFn } from "../../src/siyuan/openPdf";
import { OVERLAY_ATTRIBUTE } from "../../src/ui/highlightOverlay";
import { createNativeFakes } from "./ui/nativeFakes";

import { ATTACHED, cards, flush, harness as baseHarness, input, button, sharedInstances, submitQuery } from "./helpers/searchTabHarness";

let fakes = createNativeFakes();
const harness = (over: Partial<SearchTabDeps> = {}) => baseHarness(over, fakes);
const opts = (over: Partial<SearchOptions["filters"]> = {}): SearchOptions => ({ sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, ...over } });
const floatingDeps = () => ({ onPdfOpened: vi.fn(), onOpenInTab: vi.fn(), onCloseRequest: vi.fn() });

beforeEach(() => {
  fakes = createNativeFakes();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("session : restauration au montage", () => {
  it("avec une requête soumise : le champ est rempli et la recherche est RELANCÉE (résultats sans Entrée)", async () => {
    const h = harness({ session: { initial: { query: "chat", options: opts() }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(input(h.host).value).toBe("chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("la restauration n'ajoute rien à l'historique des requêtes", async () => {
    const update = vi.fn(async () => undefined);
    const settings = { get: () => ({ sort: { key: "relevance", direction: "desc" }, groupByDocument: true, history: [] }) as never, update };
    const h = harness({ settings, session: { initial: { query: "chat", options: opts() }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(update).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("sans requête soumise : seules les options sont restaurées, aucune recherche n'est lancée", async () => {
    const h = harness({ session: { initial: { query: "", options: opts({ folder: "assets/a/" }) }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(input(h.host).value).toBe("");
    expect(cards(h.host)).toHaveLength(0);
    expect(h.host.querySelector(".docseeker-path-text")!.textContent).toBe("assets/a/");
    tab.dispose();
  });

  it("restaure les filtres et le tri (affichés par la barre)", async () => {
    const h = harness({ session: { initial: { query: "", options: opts({ folder: "assets/a/", nameContains: "rap", minPages: 2 }) }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(h.host.querySelector(".docseeker-path-text")!.textContent).toBe("assets/a/");
    expect(h.host.querySelector('.docseeker-icons button[aria-label^="Filtres"]')!.getAttribute("aria-label")).toBe("Filtres (3 actifs)");
    tab.dispose();
  });

  it("le tri de la session l'emporte sur le tri des réglages, même lu APRÈS le montage", async () => {
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((r) => (resolveReady = r));
    let stored = { sort: { key: "relevance", direction: "desc" }, groupByDocument: true, history: [] } as { sort: { key: string; direction: string }; groupByDocument: boolean; history: string[] };
    const h = harness({
      settings: { get: () => stored as never, update: vi.fn(async () => undefined), ready },
      session: { initial: { query: "", options: opts() }, save: vi.fn() },
    });
    const tab = mountSearchTab(h.host, h.deps);
    stored = { ...stored, sort: { key: "modified", direction: "desc" } };
    resolveReady();
    await flush();
    h.host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!.click();
    const sortMenu = fakes.lastMenu().items.find((i) => i.label === "Tri")!.submenu!;
    expect(sortMenu.find((i) => i.current)!.label).toBe("Nom croissant"); // name:asc de la session, pas modified:desc des réglages
    tab.dispose();
  });
});

describe("session invalide à la restauration", () => {
  const sortLabelChecked = (h: ReturnType<typeof harness>): string => {
    h.host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!.click();
    return fakes.lastMenu().items.find((i) => i.label === "Tri")!.submenu!.find((i) => i.current)!.label!;
  };

  it("clé de tri inconnue : tri par défaut (pertinence), aucune erreur, et la recherche suivante est saine", async () => {
    const bad = { query: "chat", options: { sort: { key: "zzz", direction: "up" }, filters: { ...NO_FILTERS } } } as unknown as SearchSessionState;
    const h = harness({ session: { initial: bad, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
    expect(cards(h.host).length).toBeGreaterThan(0);
    expect(sortLabelChecked(h)).toBe("Pertinence");
    await submitQuery(h.host, "chien");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("filtres incomplets (objet vide, champs de mauvais type) : filtres neutres, aucune erreur, résultats affichés", async () => {
    const bad = { query: "chat", options: { sort: { key: "name", direction: "asc" }, filters: { folder: 3, minPages: "x" } } } as unknown as SearchSessionState;
    const h = harness({ session: { initial: bad, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
    expect(cards(h.host).length).toBeGreaterThan(0);
    expect(h.host.querySelector('.docseeker-icons button[aria-label^="Filtres"]')!.getAttribute("aria-label")).toBe("Filtres");
    tab.dispose();
  });

  it("options absentes (session corrompue) : tracé (restauration en échec), le champ reste utilisable et la recherche suivante est saine", async () => {
    const bad = { query: "chat" } as unknown as SearchSessionState;
    const h = harness({ session: { initial: bad, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("setOptions du contrôleur qui lève à la restauration : onWarn, puis une recherche saine ; le tri des réglages (lu plus tard) s'applique ENSUITE (la session n'a rien appliqué)", async () => {
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((r) => (resolveReady = r));
    let stored = { sort: { key: "relevance", direction: "desc" }, groupByDocument: true, history: [] };
    const throwing = new Proxy({}, {
      get() {
        throw new Error("options KO");
      },
    }) as unknown as SearchOptions;
    const h = harness({
      settings: { get: () => stored as never, update: vi.fn(async () => undefined), ready },
      session: { initial: { query: "", options: throwing }, save: vi.fn() },
    });
    const tab = mountSearchTab(h.host, h.deps);
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringMatching(/restauration/i), expect.objectContaining({ message: "options KO" }));
    stored = { ...stored, sort: { key: "modified", direction: "desc" } }; // lu APRÈS le montage
    resolveReady();
    await flush();
    expect(sortLabelChecked(h)).toBe("Modifier le temps décroissant");
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });
});

describe("montage qui échoue : aucun abonnement ni calque orphelin", () => {
  it("onStatus qui lève après onInvalidate : le désabonnement a lieu, la vue est retirée, l'erreur remonte au créateur", async () => {
    const h = harness({ floating: floatingDeps() });
    const unsubscribeInvalidate = vi.fn();
    const sharedIndex = {
      ...h.deps.sharedIndex,
      store: h.deps.sharedIndex.store,
      onInvalidate: vi.fn(() => unsubscribeInvalidate),
      onStatus: () => {
        throw new Error("status KO");
      },
    } as unknown as SearchTabDeps["sharedIndex"];
    expect(() => mountSearchTab(h.host, { ...h.deps, sharedIndex })).toThrow("status KO");
    expect(unsubscribeInvalidate).toHaveBeenCalledTimes(1);
    expect(h.host.querySelector(".docseeker-search")).toBeNull();
    expect(h.host.querySelector(".docseeker-message")).toBeNull();
  });

  it("l'abonnement à l'activité d'indexation posé par la vue est libéré si le montage échoue ensuite", async () => {
    const unsubscribeActivity = vi.fn();
    const snapshot = { running: false, label: "", progress: null } as never;
    const h = harness({
      indexActivity: { getSnapshot: () => snapshot, subscribe: vi.fn(() => unsubscribeActivity) },
    });
    const sharedIndex = {
      ...h.deps.sharedIndex,
      store: h.deps.sharedIndex.store,
      onInvalidate: () => () => undefined,
      onStatus: () => {
        throw new Error("status KO");
      },
    } as unknown as SearchTabDeps["sharedIndex"];
    expect(() => mountSearchTab(h.host, { ...h.deps, sharedIndex })).toThrow("status KO");
    expect(unsubscribeActivity).toHaveBeenCalledTimes(1);
  });
});

describe("session : mémorisation", () => {
  it("Entrée mémorise la requête soumise avec les options courantes", async () => {
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    expect(save).toHaveBeenLastCalledWith({ query: "chat", options: expect.objectContaining({ filters: NO_FILTERS }) });
    tab.dispose();
  });

  it("un changement d'options (dossier choisi dans le menu) est mémorisé avec la requête déjà soumise", async () => {
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    button(h.host, "Spécifier le chemin")!.click();
    const folder = fakes.lastMenu().items.find((i) => i.click && i.label?.trim() === "assets")!;
    folder.click!();
    expect(save).toHaveBeenLastCalledWith({ query: "chat", options: expect.objectContaining({ filters: expect.objectContaining({ folder: "assets/" }) }) });
    tab.dispose();
  });

  it("vider le champ (Échap) mémorise la requête vide : à la restauration, seules les options reviennent", async () => {
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    input(h.host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ query: "" }));
    tab.dispose();
  });

  it("taper sans valider ne mémorise rien", async () => {
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    input(h.host).value = "cha";
    input(h.host).dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
    tab.dispose();
  });

  it("sans deps.session : aucun changement de comportement (pas d'erreur)", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("une sauvegarde de session qui lève est tracée, sans casser la recherche", async () => {
    const h = harness({
      session: {
        initial: undefined,
        save: () => {
          throw new Error("session KO");
        },
      },
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringMatching(/session/i), expect.objectContaining({ message: "session KO" }));
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });
});

describe("ouverture d'un PDF depuis la fenêtre flottante", () => {
  it("le plugin est prévenu APRÈS la fin d'openPdfAtPage (ordre : ouverture terminée, puis fermeture)", async () => {
    const f = floatingDeps();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ floating: f });
    h.openPdfAtPage.mockImplementation(async () => {
      order.push("ouverture démarrée");
      await gate;
      order.push("ouverture terminée");
      return h.handle;
    });
    f.onPdfOpened.mockImplementation(() => order.push("fermeture"));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(order).toEqual(["ouverture démarrée"]);
    expect(f.onPdfOpened).not.toHaveBeenCalled();
    release();
    await flush();
    expect(order).toEqual(["ouverture démarrée", "ouverture terminée", "fermeture"]);
    expect(f.onPdfOpened).toHaveBeenCalledTimes(1);
    expect(f.onPdfOpened).toHaveBeenCalledWith(h.handle); // le plugin garde le calque pour le libérer au déchargement
    tab.dispose();
  });

  it("le calque de surlignage SURVIT à la fermeture : dispose de la vue ne libère pas le handle remis au visualiseur", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose(); // ce que fait la fermeture du dialogue
    expect(h.handle.dispose).not.toHaveBeenCalled();
  });

  it("à l'inverse, dans un onglet (sans mode flottant) dispose libère le calque, comme avant", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    expect(h.handle.dispose).toHaveBeenCalledTimes(1);
  });

  it("un problème de surlignage connu APRÈS la fermeture est tracé (journal), pas perdu", async () => {
    const f = floatingDeps();
    let finish: (r: unknown) => void = () => undefined;
    const h = harness({ floating: f });
    h.openPdfAtPage.mockResolvedValue({ dispose: vi.fn(), ready: new Promise<never>((r) => (finish = r as (r: unknown) => void)) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    finish({ status: "timeout", pageNumber: 2, keptRects: 0, droppedRects: 0, scrolled: false });
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Surlignage indisponible"));
  });

  it("un problème de surlignage connu APRÈS onPdfOpened mais AVANT la destruction du dialogue (fenêtre encore montée, condamnée) : notification + journal, pas un message invisible", async () => {
    const f = floatingDeps();
    const notify = vi.fn();
    const h = harness({ floating: f, notify });
    h.openPdfAtPage.mockResolvedValue({ dispose: vi.fn(), ready: Promise.resolve({ status: "timeout", pageNumber: 2, keptRects: 0, droppedRects: 0, scrolled: false } as never) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    // la vue n'est PAS encore libérée (destruction différée de SiYuan) : le message n'irait nulle part
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/Surlignage indisponible/);
    expect(notify.mock.calls[0]![0]).not.toMatch(/[<>&]/);
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Surlignage indisponible"));
    tab.dispose();
  });

  it("un problème de surlignage après la fermeture : notification d'erreur (texte i18n sans < > &) en plus du journal", async () => {
    const f = floatingDeps();
    const notify = vi.fn();
    let finish: (r: unknown) => void = () => undefined;
    const h = harness({ floating: f, notify, t: (key) => (key === "highlightUnavailable" ? "Surlignage indisponible" : key) });
    h.openPdfAtPage.mockResolvedValue({ dispose: vi.fn(), ready: new Promise<never>((r) => (finish = r as (r: unknown) => void)) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    finish({ status: "timeout", pageNumber: 2, keptRects: 0, droppedRects: 0, scrolled: false });
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Surlignage indisponible");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Surlignage indisponible"));
  });

  it("calque en échec détecté (état « ready » qui rejette) après la fermeture : tracé et notifié, sans exception non gérée", async () => {
    const f = floatingDeps();
    const notify = vi.fn();
    const h = harness({ floating: f, notify });
    h.openPdfAtPage.mockResolvedValue({ dispose: vi.fn(), ready: Promise.reject(new Error("ready KO")) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "ready KO" }));
    expect(notify).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("surlignage réussi : aucune notification", async () => {
    const f = floatingDeps();
    const notify = vi.fn();
    const h = harness({ floating: f, notify });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    expect(notify).not.toHaveBeenCalled();
  });

  it("dans un onglet (sans mode flottant), un problème de surlignage reste un message dans l'onglet : pas de notification", async () => {
    const notify = vi.fn();
    const h = harness({ notify });
    h.openPdfAtPage.mockResolvedValue({ dispose: vi.fn(), ready: Promise.resolve({ status: "timeout", pageNumber: 2, keptRects: 0, droppedRects: 0, scrolled: false } as never) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(h.host.querySelector(".docseeker-message")!.textContent).toMatch(/Surlignage indisponible/);
    tab.dispose();
  });

  it("fenêtre fermée PENDANT l'ouverture du PDF : le calque n'est pas libéré (le PDF s'ouvre quand même), le plugin en reçoit le handle", async () => {
    const f = floatingDeps();
    let release: () => void = () => undefined;
    const h = harness({ floating: f });
    h.openPdfAtPage.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return h.handle;
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose(); // Échap : la fenêtre se ferme pendant que openTab est en attente
    release();
    await flush();
    expect(h.handle.dispose).not.toHaveBeenCalled();
    expect(f.onPdfOpened).toHaveBeenCalledWith(h.handle);
  });

  it("fenêtre fermée PENDANT l'ouverture du PDF : un échec de surlignage qui suit est tracé et notifié", async () => {
    const f = floatingDeps();
    const notify = vi.fn();
    let release: () => void = () => undefined;
    const h = harness({ floating: f, notify });
    h.openPdfAtPage.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return { dispose: vi.fn(), ready: Promise.resolve({ status: "timeout", pageNumber: 2, keptRects: 0, droppedRects: 0, scrolled: false } as never) };
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    release();
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Surlignage indisponible"));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fenêtre fermée PENDANT le calcul des rectangles (openPdf pas encore appelé) : la non-ouverture est tracée, jamais silencieuse", async () => {
    const f = floatingDeps();
    let release: () => void = () => undefined;
    const h = harness({ floating: f });
    (h.deps.decodePageMatches as unknown as { mockImplementation(fn: unknown): void }).mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return { boxes: [{ x: 0.5, y: 0.6, width: 0.2, height: 0.05 }], ordinals: [0], pageSize: { widthPt: 595, heightPt: 842 }, termIndexes: [0] };
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    release();
    await flush();
    expect(h.openPdfAtPage).not.toHaveBeenCalled();
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringMatching(/fenêtre.*fermée|abandon/i));
  });

  it("dans un onglet fermé pendant l'ouverture : comportement d'avant (calque libéré, aucune trace ajoutée)", async () => {
    let release: () => void = () => undefined;
    const h = harness();
    h.openPdfAtPage.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return h.handle;
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    tab.dispose();
    release();
    await flush();
    expect(h.handle.dispose).toHaveBeenCalledTimes(1);
  });

  it("échec de l'ouverture : le dialogue n'est PAS fermé, l'erreur est tracée et affichée", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    h.openPdfAtPage.mockRejectedValue(new Error("openTab KO"));
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(f.onPdfOpened).not.toHaveBeenCalled();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "openTab KO" }));
    expect(h.host.querySelector(".docseeker-message")!.textContent).toMatch(/openTab KO/);
    tab.dispose();
  });

  it("document absent de l'index : pas de fermeture, message visible", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    const card = cards(h.host)[0]!;
    card.dataset["docId"] = "inconnu";
    card.click();
    await flush();
    expect(f.onPdfOpened).not.toHaveBeenCalled();
    expect(h.host.querySelector(".docseeker-message")!.textContent).not.toBe("");
    tab.dispose();
  });

  it("Alt+clic et Ctrl+Entrée (à droite) : même règle, la fenêtre est fermée après l'ouverture", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    expect(h.openPdfAtPage.mock.calls.at(-1)![0]).toMatchObject({ position: "right" });
    expect(f.onPdfOpened).toHaveBeenCalledTimes(1);
    cards(h.host)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(h.openPdfAtPage.mock.calls.at(-1)![0]).toMatchObject({ position: "right" });
    expect(f.onPdfOpened).toHaveBeenCalledTimes(2);
    tab.dispose();
  });

  it("deux ouvertures rapprochées : seule la dernière ferme (la première, remplacée, est abandonnée)", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    let releaseFirst: () => void = () => undefined;
    const firstHandle = { dispose: vi.fn(), ready: Promise.resolve(ATTACHED as never) };
    h.openPdfAtPage
      .mockImplementationOnce(async () => {
        await new Promise<void>((r) => (releaseFirst = r));
        return firstHandle;
      })
      .mockResolvedValueOnce(h.handle);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    cards(h.host)[1]!.click();
    await flush();
    expect(f.onPdfOpened).toHaveBeenCalledTimes(1);
    releaseFirst();
    await flush();
    expect(f.onPdfOpened).toHaveBeenCalledTimes(1);
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1); // l'ouverture périmée libère son calque
    tab.dispose();
  });

  it("un onPdfOpened qui lève est tracé, sans exception non gérée", async () => {
    const f = floatingDeps();
    f.onPdfOpened.mockImplementation(() => {
      throw new Error("fermeture KO");
    });
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "fermeture KO" }));
    tab.dispose();
  });

  it("dans un onglet (sans mode flottant) rien n'est fermé : l'ouverture ne déclenche aucun rappel", async () => {
    const f = floatingDeps();
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    cards(h.host)[0]!.click();
    await flush();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    expect(f.onPdfOpened).not.toHaveBeenCalled();
    tab.dispose();
  });
});

describe("câblage du mode flottant dans la vue", () => {
  it("un openMenu qui lève (menu d'historique) est tracé par le journal de l'onglet, et Échap ferme quand même la fenêtre", async () => {
    const f = floatingDeps();
    const h = harness({
      floating: f,
      openMenu: () => {
        throw new Error("menu KO");
      },
    });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    input(h.host).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "menu KO" }));
    input(h.host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(f.onCloseRequest).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("Échap sur un champ vide appelle onCloseRequest ; sur un champ plein il vide d'abord", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    input(h.host).value = "chat";
    input(h.host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(f.onCloseRequest).not.toHaveBeenCalled();
    input(h.host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(f.onCloseRequest).toHaveBeenCalledTimes(1);
    tab.dispose();
  });

  it("le bouton « Ouvrir dans un nouvel onglet » appelle onOpenInTab ; il n'existe pas sans mode flottant", async () => {
    const f = floatingDeps();
    const h = harness({ floating: f });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    button(h.host, "Ouvrir dans un nouvel onglet")!.click();
    expect(f.onOpenInTab).toHaveBeenCalledTimes(1);
    tab.dispose();
    const plain = harness();
    const tab2 = mountSearchTab(plain.host, plain.deps);
    await flush();
    expect(button(plain.host, "Ouvrir dans un nouvel onglet")).toBeNull();
    tab2.dispose();
  });
});

describe("un onglet ET une fenêtre flottante coexistent", () => {
  it("deux vues dans le même document : identifiants uniques, et UN seul calque de surlignage (le dernier gagne)", async () => {
    document.body.innerHTML = "";
    const pageHost = document.createElement("div");
    document.body.append(pageHost);
    const page = document.createElement("div");
    page.className = "page";
    page.dataset["pageNumber"] = "2";
    pageHost.append(page);
    const openTab: OpenTabFn = vi.fn(async () => undefined);
    const f = floatingDeps();
    const a = harness({ openPdfAtPage: realOpenPdfAtPage, openTab });
    const b = harness({ openPdfAtPage: realOpenPdfAtPage, openTab, floating: f });
    const tabA = mountSearchTab(a.host, a.deps);
    const tabB = mountSearchTab(b.host, b.deps);
    await flush();
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    await submitQuery(a.host, "chat");
    await submitQuery(b.host, "chat");
    cards(a.host)[0]!.click();
    await flush();
    cards(b.host)[0]!.click();
    await flush();
    expect(page.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
    expect(f.onPdfOpened).toHaveBeenCalledTimes(1);
    tabB.dispose(); // la fenêtre se ferme : le calque (propriété du visualiseur) reste
    expect(page.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
    tabA.dispose(); // l'onglet n'est plus propriétaire du calque remplacé
    expect(page.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("montages et libérations successifs : aucun écouteur de window ni de document n'est laissé (ajouts et retraits s'équilibrent)", async () => {
    const f = floatingDeps();
    const balance = new Map<string, number>();
    const track = (target: "window" | "document", add: boolean) => (type: string) => {
      const key = `${target}:${type}`;
      balance.set(key, (balance.get(key) ?? 0) + (add ? 1 : -1));
    };
    const spies = [
      vi.spyOn(window, "addEventListener").mockImplementation(((t: string) => void track("window", true)(t)) as never),
      vi.spyOn(window, "removeEventListener").mockImplementation(((t: string) => void track("window", false)(t)) as never),
      vi.spyOn(document, "addEventListener").mockImplementation(((t: string) => void track("document", true)(t)) as never),
      vi.spyOn(document, "removeEventListener").mockImplementation(((t: string) => void track("document", false)(t)) as never),
    ];
    try {
      for (let i = 0; i < 3; i++) {
        const h = harness({ floating: f });
        const tab = mountSearchTab(h.host, h.deps);
        await flush();
        await submitQuery(h.host, "chat");
        tab.dispose();
        h.host.remove();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const leaked = [...balance].filter(([, n]) => n !== 0);
    expect(leaked).toEqual([]);
  });
});
