// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS, NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { createSearchSessionStore, type SearchSessionState } from "../../../src/search/searchSession";
import {
  createFloatingSearch,
  type FloatingMountOptions,
  type FloatingSearch,
  type FloatingSearchView,
} from "../../../src/siyuan/floatingSearch";
import type { FloatingDialogOptions, OpenFloatingDialog } from "../../../src/ui/nativeUiTypes";

interface FakeDialog {
  readonly options: FloatingDialogOptions;
  readonly container: HTMLElement;
  readonly closeCalls: ({ readonly focus?: boolean } | undefined)[];
  destroyed: boolean;
  vanished: boolean;
  /** SiYuan LANCE la destruction (Échap global, voile, croix : `dialog.destroy()`) : `onClosing` tout de suite, destruction réelle ensuite (immédiate sauf `deferred`). */
  beginDestroy(info?: { focus: boolean }): void;
  /** SiYuan détruit réellement (délai écoulé, ou Échap global / voile) : `destroyCallback` une fois. */
  destroy(info?: { focus: boolean }): void;
  /** SiYuan retire l'élément du document SANS jamais appeler `destroyCallback`. */
  vanish(): void;
}

/** Faux `openFloatingDialog` : `deferred` imite la destruction différée de SiYuan (le `destroyCallback` vient plus tard). */
function fakeDialogs(opts: { deferred?: boolean; closeThrows?: Error } = {}) {
  const dialogs: FakeDialog[] = [];
  const openDialog: OpenFloatingDialog = vi.fn((options: FloatingDialogOptions) => {
    const container = document.createElement("div");
    document.body.append(container);
    let pendingFocus = true;
    let begun = false;
    const dialog: FakeDialog = {
      options,
      container,
      closeCalls: [],
      destroyed: false,
      vanished: false,
      beginDestroy(info) {
        if (begun) return;
        begun = true;
        options.onClosing?.(info ?? { focus: pendingFocus });
        if (!opts.deferred) dialog.destroy(info);
      },
      destroy(info) {
        if (dialog.destroyed) return;
        dialog.destroyed = true;
        container.remove();
        options.onDestroyed?.(info ?? { focus: pendingFocus });
      },
      vanish() {
        dialog.vanished = true;
        container.remove();
      },
    };
    dialogs.push(dialog);
    try {
      options.build(container);
    } catch (error) {
      dialog.destroy({ focus: true });
      throw error;
    }
    return {
      close: (o?: { readonly focus?: boolean }) => {
        dialog.closeCalls.push(o);
        if (dialog.closeCalls.length === 1) pendingFocus = o?.focus !== false;
        if (opts.closeThrows) throw opts.closeThrows;
        dialog.beginDestroy();
      },
      isOpen: () => !dialog.destroyed && !dialog.vanished,
    };
  });
  return { openDialog, dialogs, last: (): FakeDialog => dialogs.at(-1)! };
}

interface FakeView extends FloatingSearchView {
  readonly host: HTMLElement;
  readonly mountOptions: FloatingMountOptions;
  readonly input: HTMLInputElement;
  dispose: ReturnType<typeof vi.fn> & (() => void);
}

function setup(
  opts: { deferred?: boolean; closeThrows?: Error; session?: ReturnType<typeof createSearchSessionStore>; notify?: boolean; mountClosesAtOnce?: boolean } = {},
) {
  const dialogs = fakeDialogs(opts);
  const session = opts.session ?? createSearchSessionStore();
  const views: FakeView[] = [];
  const onWarn = vi.fn();
  const notify = vi.fn();
  const mount = vi.fn((host: HTMLElement, mountOptions: FloatingMountOptions): FloatingSearchView => {
    if (opts.mountClosesAtOnce) mountOptions.close({ restoreFocus: false }); // fermeture demandée PENDANT le montage
    const input = document.createElement("input");
    host.append(input);
    const view: FakeView = {
      host,
      mountOptions,
      input,
      dispose: vi.fn(() => input.remove()) as FakeView["dispose"],
      focusInput: vi.fn(() => {
        input.focus();
        return document.activeElement === input;
      }),
    };
    views.push(view);
    return view;
  });
  const floating: FloatingSearch = createFloatingSearch({
    openDialog: dialogs.openDialog,
    title: "Recherche dans les PDF",
    session,
    mount,
    onWarn,
    ...(opts.notify ? { notify, openFailedText: "Impossible d'ouvrir la recherche flottante." } : {}),
  });
  return { floating, dialogs, session, views, mount, onWarn, notify };
}

const options = (over: Partial<SearchOptions["filters"]> = {}): SearchOptions => ({ sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, ...over } });
const state = (query: string, over: Partial<SearchOptions["filters"]> = {}): SearchSessionState => ({ query, options: options(over) });

let opener: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = "";
  opener = document.createElement("button");
  opener.textContent = "ouvrir";
  document.body.append(opener);
  opener.focus();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("createFloatingSearch : ouverture", () => {
  it("open() ouvre UN dialogue titré « Recherche dans les PDF » et monte la vue dans son conteneur", () => {
    const s = setup();
    expect(s.floating.isOpen()).toBe(false);
    s.floating.open();
    expect(s.dialogs.openDialog).toHaveBeenCalledTimes(1);
    expect(s.dialogs.last().options.title).toBe("Recherche dans les PDF");
    expect(s.mount).toHaveBeenCalledTimes(1);
    expect(s.views[0]!.host).toBe(s.dialogs.last().container);
    expect(s.floating.isOpen()).toBe(true);
  });

  it("le focus initial va au champ de recherche (focusInput de la vue)", () => {
    const s = setup();
    s.floating.open();
    expect(s.views[0]!.focusInput).toHaveBeenCalled();
    expect(document.activeElement).toBe(s.views[0]!.input);
  });

  it("un deuxième open() ne crée pas de second dialogue : il refocalise le champ", () => {
    const s = setup();
    s.floating.open();
    (document.activeElement as HTMLElement).blur();
    const calls = vi.mocked(s.views[0]!.focusInput).mock.calls.length;
    s.floating.open();
    s.floating.open();
    expect(s.dialogs.openDialog).toHaveBeenCalledTimes(1);
    expect(s.mount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.views[0]!.focusInput).mock.calls.length).toBe(calls + 2);
    expect(document.activeElement).toBe(s.views[0]!.input);
  });

  it("focusInput() : faux si la fenêtre est fermée, sinon le résultat de la vue", () => {
    const s = setup();
    expect(s.floating.focusInput()).toBe(false);
    s.floating.open();
    (document.activeElement as HTMLElement).blur();
    expect(s.floating.focusInput()).toBe(true);
    vi.mocked(s.views[0]!.focusInput).mockReturnValue(false);
    expect(s.floating.focusInput()).toBe(false);
  });

  it("un montage qui échoue : open() ne lève pas, l'erreur est tracée, la fenêtre n'est pas ouverte et on peut réessayer", () => {
    const s = setup();
    s.mount.mockImplementationOnce(() => {
      throw new Error("montage KO");
    });
    expect(() => s.floating.open()).not.toThrow();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "montage KO" }));
    expect(s.onWarn).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
    expect(s.dialogs.dialogs).toHaveLength(1);
    expect(s.dialogs.last().destroyed).toBe(true); // le dialogue à moitié monté n'est pas laissé à l'écran
    s.floating.open();
    expect(s.floating.isOpen()).toBe(true);
    expect(s.dialogs.dialogs).toHaveLength(2);
  });
});

describe("createFloatingSearch : session", () => {
  it("sans session mémorisée, la vue est montée sans état à restaurer", () => {
    const s = setup();
    s.floating.open();
    expect(s.views[0]!.mountOptions.initial).toBeUndefined();
  });

  it("restaure la session mémorisée au montage (requête et options)", () => {
    const store = createSearchSessionStore();
    store.set(state("chat", { folder: "assets/a/" }));
    const s = setup({ session: store });
    s.floating.open();
    expect(s.views[0]!.mountOptions.initial).toEqual(state("chat", { folder: "assets/a/" }));
  });

  it("mémorise la session à chaque appel de save, et la restitue à la réouverture suivante", () => {
    const s = setup();
    s.floating.open();
    s.views[0]!.mountOptions.save(state("chat"));
    s.views[0]!.mountOptions.save({ query: "chien", options: DEFAULT_OPTIONS });
    expect(s.session.get()).toEqual({ query: "chien", options: DEFAULT_OPTIONS });
    s.floating.close();
    s.floating.open();
    expect(s.views[1]!.mountOptions.initial).toEqual({ query: "chien", options: DEFAULT_OPTIONS });
  });
});

describe("createFloatingSearch : fermeture", () => {
  it("close() ferme le dialogue ; la vue est libérée une fois ; isOpen devient faux", () => {
    const s = setup();
    s.floating.open();
    s.floating.close();
    expect(s.dialogs.last().closeCalls).toHaveLength(1);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
  });

  it("close() est idempotent : fermée, ou déjà en cours de fermeture, il ne fait rien de plus", () => {
    const s = setup({ deferred: true });
    s.floating.close(); // jamais ouverte
    expect(s.dialogs.dialogs).toHaveLength(0);
    s.floating.open();
    s.floating.close();
    s.floating.close();
    s.floating.close({ restoreFocus: false });
    expect(s.dialogs.last().closeCalls).toHaveLength(1);
    s.dialogs.last().destroy();
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    s.floating.close();
    expect(s.dialogs.last().closeCalls).toHaveLength(1);
  });

  it("destruction différée : pendant la fermeture isOpen et focusInput sont faux, la vue vit encore jusqu'au destroyCallback", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.floating.close();
    expect(s.floating.isOpen()).toBe(false);
    expect(s.floating.focusInput()).toBe(false);
    expect(s.views[0]!.dispose).not.toHaveBeenCalled();
    s.dialogs.last().destroy();
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("close({ restoreFocus: false }) transmet focus: false au dialogue", () => {
    const s = setup();
    s.floating.open();
    s.floating.close({ restoreFocus: false });
    expect(s.dialogs.last().closeCalls).toEqual([{ focus: false }]);
  });

  it("la vue peut demander la fermeture (options.close), avec ou sans rendre le focus", () => {
    const s = setup();
    s.floating.open();
    s.views[0]!.mountOptions.close({ restoreFocus: false });
    expect(s.dialogs.last().closeCalls).toEqual([{ focus: false }]);
    expect(s.floating.isOpen()).toBe(false);
  });

  it("fermée par SiYuan (Échap global, voile, croix) sans passer par close() : la vue est libérée, on peut rouvrir", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().destroy({ focus: true });
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
    s.floating.open();
    expect(s.dialogs.dialogs).toHaveLength(2);
    expect(s.floating.isOpen()).toBe(true);
  });

  it("open() PENDANT la fermeture différée : une seule nouvelle fenêtre, ouverte une fois l'ancienne détruite", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.floating.close();
    s.floating.open();
    s.floating.open();
    expect(s.dialogs.dialogs).toHaveLength(1); // pas de réouverture tant que SiYuan n'a pas détruit l'ancienne
    s.dialogs.last().destroy();
    expect(s.dialogs.dialogs).toHaveLength(2);
    expect(s.floating.isOpen()).toBe(true);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.views[1]!.dispose).not.toHaveBeenCalled();
  });

  it("une libération de la vue qui lève est tracée, sans exception, et la fenêtre est bien fermée", () => {
    const s = setup();
    s.floating.open();
    s.views[0]!.dispose.mockImplementation(() => {
      throw new Error("dispose KO");
    });
    expect(() => s.floating.close()).not.toThrow();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "dispose KO" }));
    expect(s.onWarn).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
    expect(s.dialogs.last().destroyed).toBe(true);
    s.floating.open(); // la fenêtre suivante s'ouvre normalement
    expect(s.floating.isOpen()).toBe(true);
  });
});

describe("createFloatingSearch : focus rendu à la fermeture", () => {
  it("rend le focus à l'élément qui l'avait avant l'ouverture (si encore connecté)", () => {
    const s = setup();
    s.floating.open();
    expect(document.activeElement).not.toBe(opener);
    s.floating.close();
    expect(document.activeElement).toBe(opener);
  });

  it("idem quand SiYuan ferme la fenêtre (Échap global)", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().destroy({ focus: true });
    expect(document.activeElement).toBe(opener);
  });

  // Portée de ces tests : le FAUX dialogue ci-dessus ne rend JAMAIS le focus lui-même ; ils vérifient seulement que CE module ne le
  // rend pas. Le vrai `Dialog.destroy` de SiYuan 3.8.9 (main.c73ef160...js, classe du module 34200) ne lit pas l'option `focus` : il
  // rend `previousFocus` si le focus était dans le dialogue ou sur BODY et qu'il est sur BODY après `destroyCallback` ; `focus: "false"`
  // n'est transmis QU'au `destroyCallback`. Ce comportement de bout en bout est couvert par `tests/unit/ui/floatingFlow.test.ts`.
  it("pas de focus rendu PAR CE MODULE si on ferme parce qu'un PDF s'ouvre (restoreFocus: false) ; SiYuan, lui, peut rendre previousFocus (voir floatingFlow)", () => {
    const s = setup();
    s.floating.open();
    s.floating.close({ restoreFocus: false });
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).toBe(document.body);
  });

  it("pas de focus rendu PAR CE MODULE si SiYuan a demandé focus: false", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().destroy({ focus: false });
    expect(document.activeElement).toBe(document.body);
  });

  it("l'élément ouvrant a disparu du document : aucun focus, aucune erreur", () => {
    const s = setup();
    s.floating.open();
    opener.remove();
    expect(() => s.floating.close()).not.toThrow();
    expect(s.dialogs.last().destroyed).toBe(true);
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("le focus est déjà ailleurs (ni BODY ni dans la fenêtre) : il est respecté", () => {
    const other = document.createElement("button");
    document.body.append(other);
    const s = setup({ deferred: true });
    s.floating.open();
    s.floating.close();
    other.focus();
    s.dialogs.last().destroy();
    expect(document.activeElement).toBe(other);
  });

  it("rien n'avait le focus avant l'ouverture (BODY) : rien à rendre", () => {
    (document.activeElement as HTMLElement).blur();
    const s = setup();
    s.floating.open();
    expect(() => s.floating.close()).not.toThrow();
    expect(s.dialogs.last().destroyed).toBe(true);
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("un deuxième open() ne change pas l'élément à qui rendre le focus", () => {
    const s = setup();
    s.floating.open();
    s.floating.open(); // le focus est dans le champ
    s.floating.close();
    expect(document.activeElement).toBe(opener);
  });
});

describe("createFloatingSearch : dispose (déchargement du plugin)", () => {
  it("détruit la fenêtre et libère la vue tout de suite, même si SiYuan détruit plus tard ; pas de double libération", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.floating.dispose();
    expect(s.dialogs.last().closeCalls).toHaveLength(1);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    s.dialogs.last().destroy();
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
  });

  it("après dispose, open() ne fait rien (pas de fenêtre orpheline)", () => {
    const s = setup();
    s.floating.dispose();
    s.floating.open();
    expect(s.dialogs.openDialog).not.toHaveBeenCalled();
    expect(() => s.floating.dispose()).not.toThrow(); // idempotent
    expect(s.floating.isOpen()).toBe(false);
  });

  it("dispose sans fenêtre ouverte ne lève pas", () => {
    const s = setup();
    expect(() => s.floating.dispose()).not.toThrow();
    expect(s.dialogs.openDialog).not.toHaveBeenCalled();
    expect(s.onWarn).not.toHaveBeenCalled();
    expect(s.floating.isOpen()).toBe(false);
  });

  it("dispose pendant une réouverture en attente : la réouverture est annulée", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.floating.close();
    s.floating.open(); // réouverture en attente
    s.floating.dispose();
    s.dialogs.last().destroy();
    expect(s.dialogs.dialogs).toHaveLength(1);
  });
});

describe("createFloatingSearch : destruction lancée par SiYuan (Échap global, voile, croix)", () => {
  it("dès le DÉBUT de la destruction : isOpen() faux, focusInput() faux, et open() est mis en attente (jamais une action sur le dialogue condamné)", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    const dialog = s.dialogs.last();
    const focusCalls = vi.mocked(s.views[0]!.focusInput).mock.calls.length;
    dialog.beginDestroy({ focus: true }); // SiYuan : dialog.destroy(), le callback viendra après le délai
    expect(s.floating.isOpen()).toBe(false);
    expect(s.floating.focusInput()).toBe(false);
    s.floating.open();
    expect(vi.mocked(s.views[0]!.focusInput).mock.calls.length).toBe(focusCalls); // aucun focus sur le dialogue condamné
    expect(s.dialogs.dialogs).toHaveLength(1);
    dialog.destroy({ focus: true }); // le délai de SiYuan est écoulé
    expect(s.dialogs.dialogs).toHaveLength(2);
    expect(s.floating.isOpen()).toBe(true);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.views[1]!.dispose).not.toHaveBeenCalled();
  });

  it("plusieurs open() pendant la destruction : une seule nouvelle fenêtre", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().beginDestroy({ focus: true });
    s.floating.open();
    s.floating.open();
    s.dialogs.dialogs[0]!.destroy({ focus: true });
    expect(s.dialogs.dialogs).toHaveLength(2);
  });

  it("close() pendant une destruction lancée par SiYuan : sans effet (aucun second close sur le handle)", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().beginDestroy({ focus: true });
    s.floating.close();
    s.views[0]!.mountOptions.close();
    expect(s.dialogs.last().closeCalls).toHaveLength(0);
  });

  it("destroy({ focus: false }) de SiYuan annoncé par onClosing : le focus n'est pas rendu à la fin", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().beginDestroy({ focus: false });
    s.dialogs.last().destroy({ focus: false });
    expect(document.activeElement).toBe(document.body);
  });

  it("dispose pendant une destruction lancée par SiYuan : la vue est libérée une seule fois et la réouverture en attente est annulée", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().beginDestroy({ focus: true });
    s.floating.open();
    s.floating.dispose();
    s.dialogs.last().destroy({ focus: true });
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.dialogs.dialogs).toHaveLength(1);
  });
});

describe("createFloatingSearch : dialogue retiré par SiYuan sans destroyCallback", () => {
  it("open() détecte la fenêtre disparue (isOpen faux), libère l'ancienne vue et ouvre une VRAIE nouvelle fenêtre", () => {
    const s = setup();
    s.floating.open();
    s.dialogs.last().vanish();
    expect(s.floating.isOpen()).toBe(false);
    s.floating.open();
    expect(s.dialogs.dialogs).toHaveLength(2);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(true);
    expect(s.views[1]!.focusInput).toHaveBeenCalled();
  });

  it("disparue PENDANT sa destruction (onClosing reçu, destroyCallback jamais) : open() rouvre aussi, sans rester en attente éternelle", () => {
    const s = setup({ deferred: true });
    s.floating.open();
    s.dialogs.last().beginDestroy({ focus: true });
    s.dialogs.last().vanish();
    s.floating.open();
    expect(s.dialogs.dialogs).toHaveLength(2);
    expect(s.floating.isOpen()).toBe(true);
  });

  it("une seule réouverture, même si open() est rappelé", () => {
    const s = setup();
    s.floating.open();
    s.dialogs.last().vanish();
    s.floating.open();
    s.floating.open();
    expect(s.dialogs.dialogs).toHaveLength(2);
  });
});

describe("createFloatingSearch : robustesse des fermetures", () => {
  it("close() du handle qui lève : tracé, jamais propagé (la fenêtre reste ouverte, la vue vit)", () => {
    const s = setup({ closeThrows: new Error("close KO") });
    s.floating.open();
    expect(() => s.floating.close()).not.toThrow();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "close KO" }));
    expect(s.views[0]!.dispose).not.toHaveBeenCalled();
  });

  it("fermeture demandée PENDANT le montage (avant que le handle n'existe) : la fenêtre est fermée dès son ouverture, une seule fois", () => {
    const s = setup({ mountClosesAtOnce: true });
    s.floating.open();
    expect(s.dialogs.last().closeCalls).toEqual([{ focus: false }]);
    expect(s.dialogs.last().destroyed).toBe(true);
    expect(s.views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(s.floating.isOpen()).toBe(false);
    expect(s.views[0]!.focusInput).not.toHaveBeenCalled(); // pas de focus dans une fenêtre qui se ferme
    s.floating.open(); // ... et on peut réessayer (le montage ferme encore, mais une nouvelle fenêtre a bien été créée)
    expect(s.dialogs.dialogs).toHaveLength(2);
  });

  it("fermeture demandée pendant le montage avec un close() de handle qui lève : tracé, pas d'exception", () => {
    const s = setup({ mountClosesAtOnce: true, closeThrows: new Error("close KO") });
    expect(() => s.floating.open()).not.toThrow();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "close KO" }));
  });
});

describe("createFloatingSearch : échec visible de l'ouverture", () => {
  it("un montage qui échoue : une notification d'erreur (texte fourni, sans détail technique) en plus du journal", () => {
    const s = setup({ notify: true });
    s.mount.mockImplementationOnce(() => {
      throw new Error("montage <KO> & co");
    });
    s.floating.open();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledWith("Impossible d'ouvrir la recherche flottante.");
    expect(s.onWarn).toHaveBeenCalledTimes(1);
  });

  it("une notification qui lève est tracée, sans exception", () => {
    const s = setup({ notify: true });
    s.notify.mockImplementation(() => {
      throw new Error("notify KO");
    });
    s.mount.mockImplementationOnce(() => {
      throw new Error("montage KO");
    });
    expect(() => s.floating.open()).not.toThrow();
    expect(s.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "notify KO" }));
  });

  it("une ouverture réussie ne notifie rien", () => {
    const s = setup({ notify: true });
    s.floating.open();
    expect(s.notify).not.toHaveBeenCalled();
  });
});
