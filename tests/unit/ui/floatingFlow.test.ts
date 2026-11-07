// @vitest-environment jsdom
// Intégration de la fenêtre flottante : floatingSearch + openFloatingDialog RÉELS + vue RÉELLE (mountSearchTab) + adaptateurs
// RÉELS de menus et dialogues (src/siyuan/nativeUi.ts), contre le faux Dialog/Menu de SiYuan (tests/stubs/siyuan.ts) qui reproduit le
// bundle 3.8.9 : destruction DIFFÉRÉE, pile `window.siyuan.dialogs`, z-index croissant, focus précédent rendu, Tab piégé dans le
// dernier dialogue, et gestionnaire Échap GLOBAL de `window` (ferme le menu au-dessus, sinon le dernier dialogue).
// Les faux Menu/Dialog des autres tests ne se ferment jamais seuls : c'est ce qui masque ces bugs d'interface réelle.
import { Dialog, Menu } from "siyuan";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createSearchSessionStore } from "../../../src/search/searchSession";
import { mountSearchTab, type SearchTab, type SearchTabDeps } from "../../../src/searchTab";
import { createFloatingSearch, type FloatingSearch } from "../../../src/siyuan/floatingSearch";
import { openCustomDialog, openDialog, openFloatingDialog, openMenu } from "../../../src/siyuan/nativeUi";
import { cards, flush, harness, input, sharedInstances, submitQuery } from "../helpers/searchTabHarness";

interface StubDialog {
  element: HTMLElement;
  destroyCount: number;
  destroyCalls: number;
  lastDestroyOptions: Record<string, unknown> | undefined;
  destroy(options?: Record<string, unknown>): void;
}
const stubs = {
  Menu: Menu as unknown as { current: { opened: boolean } | undefined; reset(): void },
  Dialog: Dialog as unknown as { instances: StubDialog[]; stack: StubDialog[]; reset(): void; destroyDelayMs: number | undefined },
};
const DELAY = 200;

let opener: HTMLButtonElement;
let floating: FloatingSearch;
let h: ReturnType<typeof harness>;
let onOpenInTab: Mock<() => void>;
let mounted: SearchTab[];

const NB = "20240101000000-aaaaaaa";
/** Noyau simulé : un cahier, aucun document ; les PDF cités sont tous ceux de l'index. */
function pathKernel(): NonNullable<SearchTabDeps["kernel"]> {
  return {
    lsNotebooks: async () => [{ id: NB, name: "Cahier A", closed: false, icon: "" }],
    listDocsByPath: async () => [],
    searchDocs: async () => [],
    getHPathsByPaths: async () => [],
    sql: async () => ({ rows: [{ path: "assets/Alpha-20240101120000-abc1234.pdf" }], truncated: false }),
  };
}
const openPathDialog = async (): Promise<HTMLElement> => {
  const button = iconButton("Spécifier le chemin")!;
  button.focus();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await flush();
  return stubs.Dialog.stack.at(-1)!.element.querySelector<HTMLElement>(".b3-dialog__body")!;
};

function build(over: Partial<SearchTabDeps> = {}): void {
  h = harness({ kernel: pathKernel(), ...over }, { openMenu, openDialog, openCustomDialog });
  floating = createFloatingSearch({
    openDialog: openFloatingDialog,
    title: "Recherche dans les PDF",
    session: createSearchSessionStore(),
    mount: (host, options) => {
      const tab = mountSearchTab(host, {
        ...h.deps,
        session: { initial: options.initial, save: options.save },
        floating: {
          onPdfOpened: () => options.close({ restoreFocus: false }),
          onOpenInTab: () => onOpenInTab(),
          onCloseRequest: () => options.close(),
        },
      });
      mounted.push(tab);
      return tab;
    },
    onWarn: h.onWarn,
  });
}
const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".docseeker-search input[type=search]")!;
const key = (target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const settle = async (ms = DELAY): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};
const iconButton = (label: string): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(`.docseeker-icons button[aria-label^="${label}"]`);
const zOf = (d: StubDialog): number => Number((d.element.querySelector(".b3-dialog") as HTMLElement).style.zIndex);

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  stubs.Menu.reset();
  stubs.Dialog.reset();
  stubs.Dialog.destroyDelayMs = DELAY;
  vi.useFakeTimers();
  mounted = [];
  onOpenInTab = vi.fn();
  opener = document.createElement("button");
  opener.textContent = "Ouvrir la recherche";
  document.body.append(opener);
  opener.focus();
  build();
});
afterEach(() => {
  floating.dispose();
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  stubs.Menu.reset();
  stubs.Dialog.reset();
  vi.useRealTimers();
});

describe("ouverture", () => {
  it("un seul vrai dialogue 80vw x 90vh, titre échappé, focus dans le champ de recherche, bouton « nouvel onglet » présent", () => {
    floating.open();
    expect(stubs.Dialog.stack).toHaveLength(1);
    const root = stubs.Dialog.stack[0]!.element;
    expect(root.querySelector<HTMLElement>(".b3-dialog__container")!.style.width).toBe("80vw");
    expect(root.querySelector<HTMLElement>(".b3-dialog__container")!.style.height).toBe("90vh");
    expect(root.querySelector(".b3-dialog__header")!.textContent).toBe("Recherche dans les PDF");
    expect(root.querySelector(".b3-dialog__action")).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(iconButton("Ouvrir dans un nouvel onglet")).not.toBeNull();
    expect(root.contains(field())).toBe(true);
  });

  it("une seconde ouverture ne crée pas de second dialogue et ramène le focus au champ", () => {
    floating.open();
    opener.focus();
    floating.open();
    expect(stubs.Dialog.stack).toHaveLength(1);
    expect(stubs.Dialog.instances).toHaveLength(1);
    expect(document.activeElement).toBe(field());
  });

  it("Tab depuis le dernier élément reste dans la fenêtre (piège de focus de SiYuan)", () => {
    floating.open();
    const root = stubs.Dialog.stack[0]!.element;
    const items = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].filter(
      (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && !el.closest("[hidden]"),
    );
    expect(items.length).toBeGreaterThan(2);
    items.at(-1)!.focus();
    key(document.activeElement!, "Tab");
    expect(root.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("Échap par couches (gestionnaire global de SiYuan actif)", () => {
  it("champ plein : vidé, la fenêtre reste ouverte (aucune fermeture par le gestionnaire global)", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    expect(cards(document.body).length).toBeGreaterThan(0);
    expect(field().value).toBe("chat");
    key(field(), "Escape");
    expect(field().value).toBe("");
    expect(cards(document.body)).toHaveLength(0);
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    await settle();
    expect(floating.isOpen()).toBe(true);
  });

  it("champ vide : ferme la fenêtre UNE seule fois ; la vue est libérée après le délai de SiYuan ; le focus revient à l'élément ouvrant", async () => {
    floating.open();
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    expect(floating.isOpen()).toBe(false);
    expect(document.querySelector(".docseeker-search")).not.toBeNull(); // la destruction est différée
    await settle();
    expect(document.querySelector(".docseeker-search")).toBeNull();
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("deux Échap de suite sur un champ plein : le premier vide, le second ferme", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
  });

  it("focus sur une carte : Échap ramène au champ sans le vider ni fermer", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.focus();
    key(cards(document.body)[0]!, "Escape");
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("chat");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
  });

  it("menu d'historique ouvert au-dessus (focus dans le champ, historique vide) : le premier Échap ne ferme que le menu", async () => {
    floating.open();
    field().focus();
    key(field(), "ArrowDown", { altKey: true });
    expect(stubs.Menu.current?.opened).toBe(true);
    key(field(), "Escape");
    expect(stubs.Menu.current).toBeUndefined();
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await settle();
  });

  it("dialogue du chemin ouvert au-dessus de la fenêtre : Échap global ferme ce dialogue, pas la fenêtre ; le focus revient au bouton", async () => {
    floating.open();
    const pathButton = iconButton("Spécifier le chemin")!;
    const body = await openPathDialog();
    expect(stubs.Dialog.stack).toHaveLength(2);
    expect(document.activeElement).toBe(body.querySelector("input"));
    key(document.activeElement!, "Escape");
    await settle(DELAY);
    expect(stubs.Dialog.stack).toHaveLength(1); // la fenêtre de recherche reste
    expect(document.querySelector('[data-key="dialog-movepathto"]')).toBeNull();
    expect(document.activeElement).toBe(pathButton);
    key(document.activeElement!, "Escape");
    await settle(DELAY);
    expect(stubs.Dialog.stack).toHaveLength(0);
  });

  it("focus sur un bouton de la barre : Échap n'est pas consommé par la vue, SiYuan ferme la fenêtre (une seule fois)", async () => {
    floating.open();
    const filters = iconButton("Filtres")!;
    filters.focus();
    key(filters, "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
  });
});

describe("menu d'historique (vrai Menu) puis Échap : jamais piégé", () => {
  /** Soumet « chat » (donc une entrée d'historique) puis vide le champ par un premier Échap. */
  const withHistoryAndEmptyField = async (): Promise<void> => {
    floating.open();
    await submitQuery(document.body, "chat");
    key(field(), "Escape");
    expect(field().value).toBe("");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
  };
  const historyItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".b3-menu__item")];

  it("Alt+Bas DEUX fois (la seconde referme le menu : bascule du même identifiant), puis Échap champ vide : la fenêtre se ferme, une seule fois", async () => {
    await withHistoryAndEmptyField();
    key(field(), "ArrowDown", { altKey: true });
    expect(stubs.Menu.current?.opened).toBe(true);
    key(field(), "ArrowDown", { altKey: true });
    expect(stubs.Menu.current).toBeUndefined();
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
  });

  it("choix d'une requête dans le menu, puis Échap : le champ est vidé, puis un second Échap ferme la fenêtre", async () => {
    await withHistoryAndEmptyField();
    key(field(), "ArrowDown", { altKey: true });
    const chat = historyItems().find((i) => i.textContent?.trim() === "chat")!;
    chat.click();
    await flush();
    expect(stubs.Menu.current).toBeUndefined();
    expect(field().value).toBe("chat");
    key(field(), "Escape");
    expect(field().value).toBe("");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
  });

  it("menu ouvert : le premier Échap ne ferme que le menu, le second (champ vide) la fenêtre", async () => {
    await withHistoryAndEmptyField();
    key(field(), "ArrowDown", { altKey: true });
    key(field(), "Escape");
    expect(stubs.Menu.current).toBeUndefined();
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    key(field(), "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
  });
});

describe("dialogue « Filtres » ouvert PAR-DESSUS la fenêtre", () => {
  it("il s'empile au-dessus (z-index), Échap ne ferme que lui, le focus revient au bouton Filtres, la fenêtre de recherche reste", async () => {
    floating.open();
    const filters = iconButton("Filtres")!;
    filters.focus();
    filters.click();
    expect(stubs.Dialog.stack).toHaveLength(2);
    expect(zOf(stubs.Dialog.stack[1]!)).toBeGreaterThan(zOf(stubs.Dialog.stack[0]!));
    key(document.activeElement!, "Escape");
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(1);
    expect(floating.isOpen()).toBe(true);
    expect(document.activeElement).toBe(filters);
  });

  it("Tab : seul le dernier dialogue piège le focus (le focus ne retourne pas dans la fenêtre de recherche)", () => {
    floating.open();
    iconButton("Filtres")!.click();
    const top = stubs.Dialog.stack[1]!.element;
    const items = [...top.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((el) => el.tabIndex >= 0);
    items.at(-1)!.focus();
    key(document.activeElement!, "Tab");
    expect(top.contains(document.activeElement)).toBe(true);
  });

  it("fermer la fenêtre de recherche pendant que Filtres est ouvert ferme aussi Filtres (rien d'orphelin)", async () => {
    floating.open();
    iconButton("Filtres")!.click();
    expect(stubs.Dialog.stack).toHaveLength(2);
    floating.close();
    await settle(DELAY);
    await settle(DELAY);
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(document.querySelector(".b3-dialog")).toBeNull();
  });

  it("dialogue du chemin ouvert quand la fenêtre se ferme : il est détruit aussi (la vue est libérée à la destruction de la fenêtre), aucun élément orphelin", async () => {
    floating.open();
    const pathButton = iconButton("Spécifier le chemin")!;
    await openPathDialog();
    expect(stubs.Dialog.stack).toHaveLength(2);
    floating.close();
    await settle();
    await settle(); // le dialogue du chemin est détruit à son tour (sa propre destruction différée)
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(document.querySelector(".b3-dialog")).toBeNull();
    expect(document.contains(pathButton)).toBe(false);
    expect(h.onWarn).not.toHaveBeenCalled(); // aucune trace d'erreur : fermeture propre
  });
});

describe("ouverture d'un PDF depuis la fenêtre", () => {
  /** Visualiseur PDF factice : `openTab` de SiYuan y place le focus, comme l'ouverture d'un onglet. */
  const viewer = (): HTMLElement => {
    const el = document.createElement("div");
    el.tabIndex = 0;
    el.className = "pdf-viewer";
    document.body.append(el);
    return el;
  };

  it("openPdfAtPage est terminé AVANT la fermeture ; le focus pris par le visualiseur n'est pas repris ; le calque n'est pas libéré", async () => {
    const order: string[] = [];
    const pdf = viewer();
    let release: () => void = () => undefined;
    h.openPdfAtPage.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      pdf.focus();
      order.push("ouverture terminée");
      return h.handle;
    });
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.click();
    await flush();
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    release();
    await flush();
    expect(order).toEqual(["ouverture terminée"]);
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(h.handle.dispose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pdf);
  });

  // Source (bundle SiYuan 3.8.9, main.c73ef160...js, `destroy(C)` de la classe Dialog) : `destroy` ne lit JAMAIS l'option C ; il la passe
  // seulement à `destroyCallback`. Ensuite, si le focus était dans le dialogue (ou sur BODY) et est sur BODY, il rend `previousFocus`
  // (focus({preventScroll:true})). `{ focus: "false" }` n'empêche donc PAS SiYuan de rendre le focus : seul NOTRE code (appelé par
  // `destroyCallback`) s'en abstient. Le stub (tests/stubs/siyuan.ts) reproduit ceci ; floatingSearch.test.ts, avec un faux dialogue qui
  // ne rend jamais le focus, ne vérifie que la part de CE module.
  it("limite connue de SiYuan : si RIEN ne prend le focus, SiYuan rend lui-même previousFocus, MÊME avec destroy({ focus: \"false\" }) ; notre module ne le rend pas", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.click();
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(stubs.Dialog.instances[0]!.lastDestroyOptions).toEqual({ focus: "false" }); // l'option a bien été demandée...
    expect(document.activeElement).toBe(opener); // ...et SiYuan a rendu previousFocus quand même (pas notre adaptateur)
  });

  it.each([
    ["Entrée", {}],
    ["Alt+Entrée (à droite)", { altKey: true }],
    ["Ctrl+Entrée (à droite)", { ctrlKey: true }],
  ])("%s sur une carte avec les vrais adaptateurs : le PDF s'ouvre puis la fenêtre est détruite UNE seule fois", async (_label, init) => {
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.focus();
    key(document.activeElement!, "Enter", init);
    await flush();
    expect(h.openPdfAtPage).toHaveBeenCalledTimes(1);
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    expect(stubs.Dialog.instances[0]!.lastDestroyOptions).toEqual({ focus: "false" });
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(h.handle.dispose).not.toHaveBeenCalled();
  });

  it("Alt+clic sur une carte : même chose (ouverture à droite, fenêtre détruite une seule fois)", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    expect(h.openPdfAtPage.mock.calls[0]![0]).toMatchObject({ position: "right" });
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
  });

  it("échec d'ouverture : la fenêtre reste ouverte, message visible dans la fenêtre, erreur tracée", async () => {
    h.openPdfAtPage.mockRejectedValue(new Error("openTab KO"));
    floating.open();
    await submitQuery(document.body, "chat");
    cards(document.body)[0]!.click();
    await settle();
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(0);
    expect(floating.isOpen()).toBe(true);
    expect(document.querySelector(".docseeker-message")!.textContent).toMatch(/openTab KO/);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "openTab KO" }));
  });
});

describe("session et cycle de vie", () => {
  it("la requête soumise et le chemin choisi reviennent à la réouverture, la recherche est relancée", async () => {
    floating.open();
    await submitQuery(document.body, "chat");
    const body = await openPathDialog();
    body.querySelector<HTMLElement>(".b3-button--text")!.click(); // cahier présélectionné
    await flush();
    await settle(DELAY); // destruction différée du dialogue du chemin
    expect(document.querySelector(".search__path")!.firstChild!.textContent).toBe("Cahier A");
    floating.close();
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
    floating.open();
    await settle(500);
    expect(field().value).toBe("chat");
    expect(document.querySelector(".search__path")!.firstChild!.textContent).toBe("Cahier A");
    expect(cards(document.body).length).toBeGreaterThan(0);
  });

  it("ouvrir pendant la fermeture différée : une seule nouvelle fenêtre, ouverte quand l'ancienne est détruite", async () => {
    floating.open();
    floating.close();
    floating.open();
    floating.open();
    expect(stubs.Dialog.instances).toHaveLength(1);
    await settle();
    expect(stubs.Dialog.instances).toHaveLength(2);
    expect(stubs.Dialog.stack).toHaveLength(1);
    expect(floating.isOpen()).toBe(true);
    expect(document.querySelectorAll(".docseeker-search")).toHaveLength(1);
    expect(document.activeElement).toBe(field());
  });

  it("déchargement du plugin : la vue est libérée tout de suite, la fenêtre détruite, le callback différé est sans effet", async () => {
    floating.open();
    const view = mounted[0]!;
    const dispose = vi.spyOn(view, "dispose");
    floating.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".docseeker-search")).toBeNull();
    await settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stubs.Dialog.stack).toHaveLength(0);
  });

  it("le bouton « Ouvrir dans un nouvel onglet » appelle le transfert", () => {
    floating.open();
    iconButton("Ouvrir dans un nouvel onglet")!.click();
    expect(onOpenInTab).toHaveBeenCalledTimes(1);
  });

  it("un clic sur le voile ferme la fenêtre : vue libérée, focus rendu, réouverture possible", async () => {
    floating.open();
    document.querySelector<HTMLElement>(".b3-dialog__scrim")!.click();
    await settle();
    expect(stubs.Dialog.stack).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    floating.open();
    expect(stubs.Dialog.stack).toHaveLength(1);
    expect(input(document.body)).toBeInstanceOf(HTMLInputElement);
    expect(stubs.Dialog.stack[0]!.element.contains(input(document.body))).toBe(true);
    expect(document.activeElement).toBe(field());
  });
});

describe("fermeture lancée par SiYuan (pas par notre code) puis open() AVANT la fin du délai de destruction", () => {
  /** Le dialogue est condamné pendant DELAY ms : un open() à ce moment ne doit être ni perdu ni adressé à lui. */
  const expectReopenedOnce = async (): Promise<void> => {
    expect(floating.isOpen()).toBe(false); // condamnée dès le début de la destruction
    expect(floating.focusInput()).toBe(false);
    const focused = document.activeElement;
    floating.open();
    expect(stubs.Dialog.instances).toHaveLength(1); // la nouvelle fenêtre attend la destruction de l'ancienne
    expect(document.activeElement).toBe(focused); // aucune action sur le dialogue condamné
    await settle();
    expect(stubs.Dialog.instances).toHaveLength(2);
    expect(stubs.Dialog.stack).toHaveLength(1);
    expect(stubs.Dialog.stack[0]).toBe(stubs.Dialog.instances[1]);
    expect(floating.isOpen()).toBe(true);
    expect(document.querySelectorAll(".docseeker-search")).toHaveLength(1);
    expect(document.activeElement).toBe(field());
  };

  it("Échap global (focus sur le bouton Filtres) puis open()", async () => {
    floating.open();
    const filters = iconButton("Filtres")!;
    filters.focus();
    key(filters, "Escape");
    expect(stubs.Dialog.instances[0]!.destroyCalls).toBe(1);
    await expectReopenedOnce();
  });

  it("clic sur le voile (.b3-dialog__scrim) puis open()", async () => {
    floating.open();
    document.querySelector<HTMLElement>(".b3-dialog__scrim")!.click();
    await expectReopenedOnce();
  });

  it("Dialog.stack[0].destroy() direct (croix) puis open()", async () => {
    floating.open();
    stubs.Dialog.stack[0]!.destroy();
    await expectReopenedOnce();
  });

  it("destroy({ focus: \"false\" }) direct de SiYuan puis open() : la nouvelle fenêtre s'ouvre, le focus du champ est pris", async () => {
    floating.open();
    stubs.Dialog.stack[0]!.destroy({ focus: "false" });
    await expectReopenedOnce();
  });

  it("SiYuan retire l'élément du document SANS jamais appeler destroyCallback : open() ouvre une vraie nouvelle fenêtre", () => {
    floating.open();
    stubs.Dialog.stack[0]!.element.remove();
    expect(floating.isOpen()).toBe(false);
    floating.open();
    expect(stubs.Dialog.instances).toHaveLength(2);
    expect(floating.isOpen()).toBe(true);
    expect(stubs.Dialog.instances[1]!.element.isConnected).toBe(true);
    expect(document.querySelectorAll(".docseeker-search")).toHaveLength(1);
    expect(document.activeElement).toBe(field());
  });
});
