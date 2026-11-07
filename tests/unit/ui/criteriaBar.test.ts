// @vitest-environment jsdom
// Ligne des critères enregistrés (copie de celle de la recherche native de SiYuan 3.8.9) : DOM, puces, enregistrement avec les cinq
// cas de confirmation, suppression, réinitialisation. Les dialogues sont les VRAIS (src/siyuan/nativeUi) sur le faux Dialog de SiYuan.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Menu } from "siyuan";
import { NO_FILTERS } from "../../../src/search/resultOptions";
import { MAX_CRITERIA, upsertCriteria, type CriteriaState, type SaveCriteriaResult, type SavedCriteria } from "../../../src/search/savedCriteria";
import { createSettings } from "../../../src/settings";
import { openConfirmDialog, openInputDialog } from "../../../src/siyuan/nativeUi";
import { createCriteriaBar, type CriteriaBar, type CriteriaBarDeps } from "../../../src/ui/criteriaBar";

const fr = JSON.parse(readFileSync("i18n/fr_FR.json", "utf8")) as Record<string, string>;
const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (fr[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
const HOSTILE = "<img src=x onerror=alert(1)>";
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const crit = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS },
  sort: { key: "relevance", direction: "desc" },
  groupByDocument: true,
  ...extra,
});
const stateOf = (c: SavedCriteria): CriteriaState => ({ query: c.query, filters: c.filters, sort: c.sort, groupByDocument: c.groupByDocument });

interface Setup {
  bar: CriteriaBar;
  header: HTMLElement;
  deps: CriteriaBarDeps & { toast: ReturnType<typeof vi.fn>; recall: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; onWarn: ReturnType<typeof vi.fn> };
  getList: () => SavedCriteria[];
  setList: (next: SavedCriteria[]) => void;
  setState: (next: CriteriaState) => void;
  saveFn: ReturnType<typeof vi.fn>;
  failSave: (error: Error | undefined) => void;
}

let current: Setup | undefined;
function setup(initial: SavedCriteria[] = [], state: CriteriaState = stateOf(crit("x", { query: "courant" }))): Setup {
  let list = initial;
  let st = state;
  let saveError: Error | undefined;
  const saveFn = vi.fn(async (c: SavedCriteria, remove: readonly string[]): Promise<SaveCriteriaResult> => {
    if (saveError) throw saveError;
    const out = upsertCriteria(list, c, remove);
    if ("error" in out) return out;
    list = out.list;
    return { replaced: out.replaced };
  });
  const deps = {
    t,
    list: () => list,
    save: saveFn,
    remove: vi.fn(async (name: string) => {
      const next = list.filter((c) => c.name !== name);
      const existed = next.length !== list.length;
      list = next;
      return existed;
    }),
    recall: vi.fn(),
    reset: vi.fn(),
    getState: () => st,
    notify: vi.fn(),
    toast: vi.fn(),
    onWarn: vi.fn(),
    openInputDialog,
    openConfirmDialog,
  } satisfies CriteriaBarDeps;
  const bar = createCriteriaBar(document, deps);
  document.body.appendChild(bar.element);
  current = {
    bar,
    header: bar.element,
    deps,
    getList: () => list,
    setList: (next) => {
      list = next;
    },
    setState: (next) => {
      st = next;
    },
    saveFn,
    failSave: (error) => {
      saveError = error;
    },
  };
  return current;
}

const chips = (h: HTMLElement): HTMLElement[] => [...h.querySelectorAll<HTMLElement>('[data-type="set-criteria"]')];
const saveBtn = (h: HTMLElement): HTMLButtonElement => h.querySelector<HTMLButtonElement>('button[data-type="saveCriterion"]')!;
const resetBtn = (h: HTMLElement): HTMLButtonElement => h.querySelector<HTMLButtonElement>('button[data-type="removeCriterion"]')!;
const inputDialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-key="dialog-savecriterion"]');
const confirmDialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-key="dialog-confirm"]');
const field = (): HTMLInputElement => inputDialog()!.querySelector<HTMLInputElement>("[data-dialog-input]")!;
const typeName = (name: string): void => {
  field().value = name;
};
const clickConfirmInput = (): void => inputDialog()!.querySelector<HTMLButtonElement>("[data-input-confirm]")!.click();
const confirmText = (): string => confirmDialog()!.querySelector(".ft__breakword")!.textContent ?? "";
const names = (s: Setup): string[] => s.getList().map((c) => c.name);

beforeEach(() => {
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  (Dialog as unknown as { reset(): void }).reset();
  current = undefined;
});
afterEach(() => {
  current?.bar.dispose();
  vi.restoreAllMocks();
});

describe("DOM de la ligne (identique au natif)", () => {
  it("div.search__header : b3-chips, fn__flex-1, bouton d'enregistrement, espace, bouton de réinitialisation, espace", () => {
    const s = setup();
    expect(s.header.className).toBe("search__header");
    expect([...s.header.children].map((c) => `${c.tagName}.${c.className}`)).toEqual([
      "DIV.b3-chips fn__none",
      "SPAN.fn__flex-1",
      "BUTTON.b3-button b3-button--small b3-button--outline fn__flex-center",
      "SPAN.fn__space",
      "BUTTON.ariaLabel b3-button b3-button--small b3-button--outline fn__flex-center fn__flex-shrink",
      "SPAN.fn__space",
    ]);
  });

  it("boutons : data-type, libellés natifs, infobulle native sur la réinitialisation", () => {
    const s = setup();
    expect(saveBtn(s.header).textContent).toBe("Enregistrer les critères de requête");
    expect(resetBtn(s.header).textContent).toBe("Réinitialiser les critères de recherche");
    expect(resetBtn(s.header).getAttribute("aria-label")).toBe("Les conditions de requête actuelles ne seront plus utilisées pour la prochaine requête");
    expect(resetBtn(s.header).getAttribute("data-position")).toBe("9south");
    expect(saveBtn(s.header).hasAttribute("aria-label")).toBe(false);
  });

  it("chaque critère : div[data-type=set-criteria] de classes natives, nom en texte, croix svg.b3-chip__close[data-type=remove-criteria] > use#iconClose", () => {
    const s = setup([crit("un", { query: "a" }), crit("deux", { query: "b" })]);
    expect(s.header.querySelector(".b3-chips")!.classList.contains("fn__none")).toBe(false);
    const [first, second] = chips(s.header);
    expect(first!.className).toBe("b3-chip b3-chip--middle b3-chip--pointer");
    expect(first!.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(first!.textContent).toBe("un");
    expect(second!.textContent).toBe("deux");
    const close = first!.querySelector("svg")!;
    expect(close.getAttribute("class")).toBe("b3-chip__close");
    expect(close.getAttribute("data-type")).toBe("remove-criteria");
    expect(close.querySelector("use")!.getAttribute("xlink:href")).toBe("#iconClose");
    expect(first!.children).toHaveLength(1);
  });

  it("aucun critère : les puces sont cachées (fn__none), pas de puce", () => {
    const s = setup();
    expect(chips(s.header)).toHaveLength(0);
    expect(s.header.querySelector(".b3-chips")!.classList.contains("fn__none")).toBe(true);
  });

  it("noms hostiles : texte seulement, aucun nœud créé", () => {
    const s = setup([crit(HOSTILE)]);
    expect(s.header.querySelector("img")).toBeNull();
    expect(chips(s.header)[0]!.textContent).toBe(HOSTILE);
  });
});

describe("puce courante", () => {
  it("b3-chip--current en tête de classe quand requête, filtres, tri et regroupement sont identiques", () => {
    const a = crit("a");
    const s = setup([a, crit("b", { query: "autre" })], stateOf(a));
    expect(chips(s.header).map((c) => c.className)).toEqual([
      "b3-chip--current b3-chip b3-chip--middle b3-chip--pointer",
      "b3-chip b3-chip--middle b3-chip--pointer",
    ]);
  });

  it("refresh suit l'état : la saisie d'une autre requête retire la puce courante", () => {
    const a = crit("a");
    const s = setup([a], stateOf(a));
    s.setState({ ...stateOf(a), query: "chat et chien" });
    s.bar.refresh();
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(false);
  });

  it.each([
    ["tri", { sort: { key: "name", direction: "asc" } }],
    ["regroupement", { groupByDocument: false }],
    ["filtre de nom", { filters: { ...NO_FILTERS, nameContains: "x" } }],
  ] as const)("%s différent : pas courante", (_n, patch) => {
    const a = crit("a");
    const s = setup([a], { ...stateOf(a), ...patch });
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(false);
  });

  it("le chemin compte, comme idPath dans configIsSame du natif", () => {
    const scope = { kind: "notebook", box: "20240101120000-abcdefg", label: "Cahier" } as const;
    const a = crit("a", { filters: { ...NO_FILTERS, scopes: [scope] } });
    const s = setup([a], { ...stateOf(a), filters: { ...NO_FILTERS } });
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(false);
    s.setState(stateOf(a));
    s.bar.refresh();
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(true);
  });

  it("refresh relit la liste : un critère ajouté par une autre fenêtre apparaît, un supprimé disparaît", () => {
    const s = setup([crit("a")]);
    s.setList([crit("a"), crit("b", { query: "z" })]);
    s.bar.refresh();
    expect(chips(s.header).map((c) => c.textContent)).toEqual(["a", "b"]);
    s.setList([]);
    s.bar.refresh();
    expect(chips(s.header)).toHaveLength(0);
    expect(s.header.querySelector(".b3-chips")!.classList.contains("fn__none")).toBe(true);
  });
});

describe("clic sur une puce et sur sa croix", () => {
  it("clic sur la puce (ou sur son texte, sur le svg) : le critère enregistré est appliqué", () => {
    const a = crit("a", { query: "loup" });
    const s = setup([a]);
    chips(s.header)[0]!.click();
    expect(s.deps.recall).toHaveBeenCalledTimes(1);
    expect(s.deps.recall).toHaveBeenCalledWith(a);
  });

  it("la puce devient courante quand l'application a changé l'état (refresh après le rappel)", () => {
    const a = crit("a", { query: "loup" });
    const s = setup([a]);
    s.deps.recall.mockImplementation((c: SavedCriteria) => s.setState(stateOf(c)));
    chips(s.header)[0]!.click();
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(true);
  });

  it("le clic ne se propage pas (stopPropagation, preventDefault)", () => {
    const s = setup([crit("a")]);
    const outer = vi.fn();
    document.body.addEventListener("click", outer);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    chips(s.header)[0]!.dispatchEvent(event);
    document.body.removeEventListener("click", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("croix : suppression immédiate, sans confirmation, sans appliquer le critère, sans propagation", async () => {
    const s = setup([crit("a"), crit("b", { query: "z" })]);
    const outer = vi.fn();
    document.body.addEventListener("click", outer);
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.body.removeEventListener("click", outer);
    await flush();
    expect(confirmDialog()).toBeNull();
    expect(s.deps.recall).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(names(s)).toEqual(["b"]);
    expect(chips(s.header).map((c) => c.textContent)).toEqual(["b"]);
  });

  it("clic sur le <use> de la croix : supprime aussi", async () => {
    const s = setup([crit("a")]);
    chips(s.header)[0]!.querySelector("use")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(names(s)).toEqual([]);
    expect(s.header.querySelector(".b3-chips")!.classList.contains("fn__none")).toBe(true);
  });

  it("supprimer la puce COURANTE réinitialise (comme le natif) ; supprimer une autre puce ne réinitialise pas", async () => {
    const a = crit("a");
    const b = crit("b", { query: "z" });
    const s = setup([a, b], stateOf(a));
    chips(s.header)[1]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(s.deps.reset).not.toHaveBeenCalled();
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(s.deps.reset).toHaveBeenCalledTimes(1);
  });

  it("clavier : Entrée et Espace sur la puce appliquent, Suppr la supprime", async () => {
    const s = setup([crit("a")]);
    const chip = chips(s.header)[0]!;
    expect(chip.getAttribute("tabindex")).toBe("0");
    expect(chip.getAttribute("role")).toBe("button");
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(s.deps.recall).toHaveBeenCalledTimes(2);
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await flush();
    expect(names(s)).toEqual([]);
  });

  it("critère supprimé ailleurs entre-temps : message « déjà supprimé », rien d'appliqué, la puce disparaît", () => {
    const s = setup([crit("a")]);
    s.setList([]);
    chips(s.header)[0]!.click();
    expect(s.deps.recall).not.toHaveBeenCalled();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaAlreadyDeleted);
    expect(chips(s.header)).toHaveLength(0);
  });

  it("rappel qui lève : trace et message, jamais propagé", () => {
    const s = setup([crit("a")]);
    s.deps.recall.mockImplementation(() => {
      throw new Error("boum");
    });
    chips(s.header)[0]!.click();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaRecallFailed);
  });

  it("suppression en échec : message et trace, la puce reste", async () => {
    const s = setup([crit("a")]);
    s.deps.remove = vi.fn(async () => {
      throw new Error("disque plein");
    });
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaDeleteFailed);
    expect(chips(s.header)).toHaveLength(1);
  });
});

describe("dialogue « Enregistrer les critères de requête »", () => {
  it("s'ouvre comme openInputDialog : 520px, data-key, titre, champ vide, placeholder « Remarques », boutons natifs", () => {
    const s = setup([crit("a", { query: "z" })]);
    saveBtn(s.header).click();
    const dialog = inputDialog()!;
    expect(dialog.querySelector(".b3-dialog__header")!.textContent).toBe("Enregistrer les critères de requête");
    expect(dialog.querySelector<HTMLElement>(".b3-dialog__container")!.style.width).toBe("520px");
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Remarques");
    expect(dialog.querySelector(".b3-button--cancel")!.textContent).toBe("Annuler");
    expect(dialog.querySelector(".b3-button--text")!.textContent).toBe("Confirmer");
    expect(document.activeElement).toBe(field());
  });

  it("valeur initiale : le nom de la puce courante, sélectionné", () => {
    const a = crit("Ma requête");
    const s = setup([crit("autre", { query: "z" }), a], stateOf(a));
    saveBtn(s.header).click();
    expect(field().value).toBe("Ma requête");
    expect(field().selectionEnd).toBe("Ma requête".length);
  });

  it("un deuxième clic pendant que le dialogue est ouvert n'en ouvre pas un autre", () => {
    const s = setup();
    saveBtn(s.header).click();
    saveBtn(s.header).click();
    expect(document.querySelectorAll('[data-key="dialog-savecriterion"]')).toHaveLength(1);
  });

  it("Annuler : rien n'est enregistré, le focus revient au bouton d'enregistrement", async () => {
    const s = setup();
    saveBtn(s.header).click(); // pas de focus préalable : le focus rendu vient du plugin, pas de la mémoire du Dialog

    inputDialog()!.querySelector<HTMLButtonElement>("[data-input-cancel]")!.click();
    await flush();
    expect(s.saveFn).not.toHaveBeenCalled();
    expect(inputDialog()).toBeNull();
    expect(document.activeElement).toBe(saveBtn(s.header));
  });

  it("nom vide : « L'entrée ne peut pas être vide », le dialogue reste ouvert, rien d'enregistré", async () => {
    const s = setup();
    saveBtn(s.header).click();
    typeName("   ");
    clickConfirmInput();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith("L'entrée ne peut pas être vide");
    expect(inputDialog()).not.toBeNull();
    expect(s.saveFn).not.toHaveBeenCalled();
  });

  it("nouveau nom, rien de pareil : enregistré sans confirmation, dialogue fermé, puce ajoutée et courante, focus rendu", async () => {
    const s = setup([crit("a", { query: "z" })], stateOf(crit("x", { query: "courant" })));
    saveBtn(s.header).click(); // pas de focus préalable : le focus rendu vient du plugin, pas de la mémoire du Dialog

    typeName("  Nouveau ");
    clickConfirmInput();
    await flush();
    expect(confirmDialog()).toBeNull();
    expect(inputDialog()).toBeNull();
    expect(names(s)).toEqual(["a", "Nouveau"]);
    expect(s.getList()[1]).toMatchObject({ query: "courant", groupByDocument: true });
    const list = chips(s.header);
    expect(list.map((c) => c.textContent)).toEqual(["a", "Nouveau"]);
    expect(list[1]!.classList.contains("b3-chip--current")).toBe(true);
    expect(document.activeElement).toBe(saveBtn(s.header));
  });

  it("Entrée dans le champ confirme comme le bouton", async () => {
    const s = setup();
    saveBtn(s.header).click();
    typeName("par entrée");
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(names(s)).toEqual(["par entrée"]);
  });

  it("même nom, configuration différente : confirmation « écraser » ; Annuler laisse tout en l'état et le dialogue d'entrée ouvert", async () => {
    const s = setup([crit("a", { query: "ancienne" }), crit("b", { query: "z" })]);
    saveBtn(s.header).click();
    typeName("a");
    clickConfirmInput();
    expect(confirmText()).toBe("Le nom de la requête est dupliqué, voulez-vous l'écraser ?");
    expect(confirmDialog()!.querySelector(".b3-dialog__header")!.textContent).toBe("Confirmer");
    confirmDialog()!.querySelector<HTMLButtonElement>("#cancelDialogConfirmBtn")!.click();
    await flush();
    expect(s.saveFn).not.toHaveBeenCalled();
    expect(inputDialog()).not.toBeNull();
    expect(s.getList()[0]!.query).toBe("ancienne");
  });

  it("écraser confirmé : le critère de ce nom est remplacé (déplacé en fin), les deux dialogues se ferment", async () => {
    const s = setup([crit("a", { query: "ancienne" }), crit("b", { query: "z" })]);
    saveBtn(s.header).click();
    typeName("a");
    clickConfirmInput();
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(names(s)).toEqual(["b", "a"]);
    expect(s.getList()[1]!.query).toBe("courant");
    expect(confirmDialog()).toBeNull();
    expect(inputDialog()).toBeNull();
    expect(chips(s.header).map((c) => c.textContent)).toEqual(["b", "a"]);
  });

  it("même configuration, nom différent : « Mettre à jour le nom x en y ? » ; confirmé : renommé, l'ancien nom disparaît", async () => {
    const cur = stateOf(crit("x", { query: "courant" }));
    const s = setup([crit("vieux", { query: "courant" }), crit("b", { query: "z" })], cur);
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    expect(confirmText()).toBe("Mettre à jour le nom vieux en neuf ?");
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(names(s)).toEqual(["b", "neuf"]);
    expect(inputDialog()).toBeNull();
  });

  it("deux critères distincts : « Voulez-vous supprimer x et affecter sa condition de requête à y ? » ; confirmé : fusion", async () => {
    const cur = stateOf(crit("x", { query: "courant" }));
    const s = setup([crit("cible", { query: "autre" }), crit("copie", { query: "courant" }), crit("c", { query: "z" })], cur);
    saveBtn(s.header).click();
    typeName("cible");
    clickConfirmInput();
    expect(confirmText()).toBe("Voulez-vous supprimer copie et affecter sa condition de requête à cible ?");
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(names(s)).toEqual(["c", "cible"]);
    expect(s.getList()[1]!.query).toBe("courant");
  });

  it("nom ET configuration identiques : on ferme sans rien faire, ni confirmation ni écriture", async () => {
    const a = crit("a");
    const s = setup([a], stateOf(a));
    saveBtn(s.header).click();
    expect(field().value).toBe("a");
    clickConfirmInput();
    await flush();
    expect(confirmDialog()).toBeNull();
    expect(inputDialog()).toBeNull();
    expect(s.saveFn).not.toHaveBeenCalled();
  });

  it("noms hostiles : les dialogues de confirmation les montrent comme du texte", async () => {
    const cur = stateOf(crit("x", { query: "courant" }));
    const s = setup([crit(HOSTILE, { query: "courant" })], cur);
    saveBtn(s.header).click();
    typeName(`${HOSTILE}2`);
    clickConfirmInput();
    expect(confirmDialog()!.querySelector("img")).toBeNull();
    expect(confirmText()).toBe(`Mettre à jour le nom ${HOSTILE} en ${HOSTILE}2 ?`);
    confirmDialog()!.querySelector<HTMLButtonElement>("#cancelDialogConfirmBtn")!.click();
    await flush();
    expect(document.querySelector("img")).toBeNull();
  });

  it("un nom contenant « $& » ou « {y} » n'est pas réinterprété dans le texte de confirmation", async () => {
    const cur = stateOf(crit("x", { query: "courant" }));
    const s = setup([crit("$& {y}", { query: "courant" })], cur);
    saveBtn(s.header).click();
    typeName("{x} $1");
    clickConfirmInput();
    expect(confirmText()).toBe("Mettre à jour le nom $& {y} en {x} $1 ?");
  });

  it("30 critères et un nouveau nom : message de limite, rien d'enregistré, dialogue ouvert", async () => {
    const full = Array.from({ length: MAX_CRITERIA }, (_, i) => crit(`c${i}`, { query: `q${i}` }));
    const s = setup(full);
    saveBtn(s.header).click();
    typeName("trente et un");
    clickConfirmInput();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaErrLimit);
    expect(s.saveFn).not.toHaveBeenCalled();
    expect(inputDialog()).not.toBeNull();
    expect(s.getList()).toHaveLength(30);
  });

  it("30 critères : écraser reste possible", async () => {
    const full = Array.from({ length: MAX_CRITERIA }, (_, i) => crit(`c${i}`, { query: `q${i}` }));
    const s = setup(full);
    saveBtn(s.header).click();
    typeName("c7");
    clickConfirmInput();
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(s.getList()).toHaveLength(30);
    expect(s.getList().at(-1)).toMatchObject({ name: "c7", query: "courant" });
  });

  it("nom de plus de 80 caractères ou requête de plus de 200 : message, rien d'enregistré", async () => {
    const s = setup();
    saveBtn(s.header).click();
    typeName("x".repeat(81));
    clickConfirmInput();
    expect(s.deps.notify).toHaveBeenLastCalledWith(fr.criteriaErrTooLong);
    s.setState({ ...stateOf(crit("x")), query: "q".repeat(201) });
    typeName("ok");
    clickConfirmInput();
    expect(s.deps.notify).toHaveBeenLastCalledWith(fr.criteriaErrQuery);
    await flush();
    expect(s.saveFn).not.toHaveBeenCalled();
  });

  it("échec d'écriture : message et trace, liste inchangée, le dialogue d'entrée reste ouvert (on peut réessayer)", async () => {
    const s = setup([crit("a", { query: "z" })]);
    s.failSave(new Error("disque plein"));
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(names(s)).toEqual(["a"]);
    expect(chips(s.header).map((c) => c.textContent)).toEqual(["a"]);
    expect(inputDialog()).not.toBeNull();
    s.failSave(undefined);
    clickConfirmInput();
    await flush();
    expect(names(s)).toEqual(["a", "neuf"]);
    expect(inputDialog()).toBeNull();
  });

  it("refus « limit » du magasin (une autre fenêtre a rempli la liste) : message de limite, dialogue ouvert", async () => {
    const s = setup([crit("a", { query: "z" })]);
    s.saveFn.mockResolvedValueOnce({ error: "limit" });
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaErrLimit);
    expect(inputDialog()).not.toBeNull();
  });

  it("refus inattendu du magasin (tri) : traité comme un échec, tracé", async () => {
    const s = setup();
    s.saveFn.mockResolvedValueOnce({ error: "sort" });
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
  });

  it("double clic sur Confirmer pendant l'écriture : une seule écriture", async () => {
    const s = setup();
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    clickConfirmInput();
    await flush();
    expect(s.saveFn).toHaveBeenCalledTimes(1);
  });
});

describe("réinitialiser", () => {
  it("le bouton appelle reset puis recalcule la ligne", () => {
    const a = crit("a");
    const s = setup([a], stateOf(a));
    s.deps.reset.mockImplementation(() => s.setState({ ...stateOf(a), query: "" }));
    resetBtn(s.header).click();
    expect(s.deps.reset).toHaveBeenCalledTimes(1);
    expect(chips(s.header)[0]!.classList.contains("b3-chip--current")).toBe(false);
  });

  it("reset qui lève : trace et message", () => {
    const s = setup();
    s.deps.reset.mockImplementation(() => {
      throw new Error("boum");
    });
    resetBtn(s.header).click();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalled();
  });

  it("les actions publiques de la barre (menu « Plus ») font la même chose que les boutons", () => {
    const s = setup();
    s.bar.reset();
    expect(s.deps.reset).toHaveBeenCalledTimes(1);
    s.bar.openSave();
    expect(inputDialog()).not.toBeNull();
  });
});

describe("dispose", () => {
  it("retire la ligne, ferme les dialogues, ne rend le focus à aucun bouton détaché", async () => {
    const s = setup();
    saveBtn(s.header).click();
    typeName("a");
    s.bar.dispose();
    await flush();
    expect(s.header.isConnected).toBe(false);
    expect(inputDialog()).toBeNull();
    saveBtn(s.header).click();
    expect(inputDialog()).toBeNull();
    s.bar.refresh();
  });

  it("un enregistrement en vol qui se termine après dispose n'écrit rien dans le DOM ni dans les messages", async () => {
    const s = setup();
    let release!: () => void;
    s.saveFn.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ replaced: false }))));
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    s.bar.dispose();
    release();
    await flush();
    expect(s.deps.notify).not.toHaveBeenCalled();
  });
});

describe("deux fenêtres sur les mêmes réglages", () => {
  function twoWindows() {
    let file: unknown = { savedCriteria: [] };
    const make = () => {
      const store = createSettings({
        load: async () => structuredClone(file),
        save: async (v) => {
          file = structuredClone(v);
        },
        onWarn: vi.fn(),
      });
      let state: CriteriaState = stateOf(crit("x", { query: "courant" }));
      const deps: CriteriaBarDeps = {
        t,
        list: () => store.get().savedCriteria,
        save: (c, r) => store.saveCriteria(c, r),
        remove: (n) => store.deleteCriteria(n),
        recall: vi.fn(),
        reset: vi.fn(),
        getState: () => state,
        notify: vi.fn(),
        onWarn: vi.fn(),
        openInputDialog,
        openConfirmDialog,
      };
      const bar = createCriteriaBar(document, deps);
      document.body.appendChild(bar.element);
      return { store, bar, deps, setState: (s: CriteriaState) => (state = s) };
    };
    return { a: make(), b: make() };
  }

  it("un critère enregistré dans la fenêtre A apparaît dans B au refresh ; supprimé dans B, il disparaît de A au refresh, sans résurrection", async () => {
    const { a, b } = twoWindows();
    await a.store.load();
    await b.store.load();
    saveBtn(a.bar.element).click();
    typeName("partagé");
    clickConfirmInput();
    await flush();
    b.bar.refresh();
    expect(b.store.get().savedCriteria).toHaveLength(0); // B n'a pas relu le fichier : sa copie est périmée
    chips(a.bar.element)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(a.store.get().savedCriteria).toHaveLength(0);
    // B enregistre à son tour : la relecture avant écriture garde le fichier cohérent (rien de ressuscité).
    saveBtn(b.bar.element).click();
    typeName("de B");
    clickConfirmInput();
    await flush();
    expect(b.store.get().savedCriteria.map((c) => c.name)).toEqual(["de B"]);
    a.bar.dispose();
    b.bar.dispose();
  });

  it("renommage depuis B d'un critère que A a déjà supprimé : le magasin relit et enregistre simplement le nouveau nom", async () => {
    const { a, b } = twoWindows();
    await a.store.saveCriteria(crit("vieux", { query: "courant" }));
    await b.store.load();
    await a.store.deleteCriteria("vieux");
    saveBtn(b.bar.element).click();
    typeName("neuf");
    clickConfirmInput();
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(b.store.get().savedCriteria.map((c) => c.name)).toEqual(["neuf"]);
    a.bar.dispose();
    b.bar.dispose();
  });
});

describe("incidents : jamais d'erreur avalée ni propagée", () => {
  it("un message (notify) qui lève est tracé", () => {
    const s = setup();
    s.deps.notify.mockImplementation(() => {
      throw new Error("toast KO");
    });
    saveBtn(s.header).click();
    typeName("");
    clickConfirmInput();
    expect(s.deps.onWarn).toHaveBeenCalledWith("Message sur les critères impossible", expect.objectContaining({ message: "toast KO" }));
  });

  it("une trace (onWarn) qui lève retombe sur la console", () => {
    const s = setup([crit("a")]);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    s.deps.onWarn.mockImplementation(() => {
      throw new Error("journal KO");
    });
    s.deps.recall.mockImplementation(() => {
      throw new Error("boum");
    });
    chips(s.header)[0]!.click();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });

  it("ouverture du dialogue d'entrée impossible : trace et message", () => {
    const s = setup();
    s.deps.openInputDialog = () => {
      throw new Error("pas de dialogue");
    };
    saveBtn(s.header).click();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
  });

  it("deux Entrée de suite avec une confirmation ouverte : un seul dialogue de confirmation", () => {
    const s = setup([crit("a", { query: "ancienne" })]);
    saveBtn(s.header).click();
    typeName("a");
    clickConfirmInput();
    clickConfirmInput();
    expect(document.querySelectorAll('[data-key="dialog-confirm"]')).toHaveLength(1);
  });

  it("la confirmation de l'écrasement ne réécrit rien si la fenêtre est fermée entre-temps (dispose)", async () => {
    const s = setup([crit("a", { query: "ancienne" })]);
    saveBtn(s.header).click();
    typeName("a");
    clickConfirmInput();
    const confirm = confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!;
    s.bar.dispose();
    await flush();
    expect(s.saveFn).not.toHaveBeenCalled();
    expect(confirm.isConnected).toBe(false);
  });

  it("suppression par une autre fenêtre pendant la suppression : rien d'appliqué, pas de réinitialisation", async () => {
    const a = crit("a");
    const s = setup([a], stateOf(a));
    s.deps.remove = vi.fn(async () => false);
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(s.deps.reset).not.toHaveBeenCalled();
  });

  it("suppression qui se termine après dispose : aucune réinitialisation ni message", async () => {
    const a = crit("a");
    const s = setup([a], stateOf(a));
    let release!: () => void;
    s.deps.remove = vi.fn(() => new Promise<boolean>((resolve) => (release = () => resolve(true))));
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    s.bar.dispose();
    release();
    await flush();
    expect(s.deps.reset).not.toHaveBeenCalled();
  });
});

describe("échecs qui survivent à l'onglet (D)", () => {
  it("écriture en échec après dispose : notification globale (toast) + trace, rien dans la zone de messages de l'onglet", async () => {
    const s = setup();
    let fail!: (e: Error) => void;
    s.saveFn.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    s.bar.dispose();
    fail(new Error("disque plein"));
    await flush();
    expect(s.deps.toast).toHaveBeenCalledWith(fr.criteriaSaveFailed);
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).not.toHaveBeenCalled();
  });

  it("suppression en échec après dispose : notification globale + trace", async () => {
    const s = setup([crit("a")]);
    let fail!: (e: Error) => void;
    s.deps.remove = vi.fn(() => new Promise<boolean>((_resolve, reject) => (fail = reject)));
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    s.bar.dispose();
    fail(new Error("disque plein"));
    await flush();
    expect(s.deps.toast).toHaveBeenCalledWith(fr.criteriaDeleteFailed);
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).not.toHaveBeenCalled();
  });

  it("écriture réussie après dispose : aucun toast (pas de bruit)", async () => {
    const s = setup();
    let release!: () => void;
    s.saveFn.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ replaced: false }))));
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    s.bar.dispose();
    release();
    await flush();
    expect(s.deps.toast).not.toHaveBeenCalled();
  });

  it("toast qui lève : tracé, jamais propagé", async () => {
    const s = setup();
    s.deps.toast.mockImplementation(() => {
      throw new Error("toast en échec");
    });
    let fail!: (e: Error) => void;
    s.saveFn.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    s.bar.dispose();
    fail(new Error("disque plein"));
    await flush();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(2);
  });
});

describe("rappels de dialogue qui lèvent (H) et écriture déjà en cours (I1)", () => {
  it("onConfirm du dialogue d'entrée qui lève : trace et message « enregistrement impossible »", () => {
    const s = setup([crit("a", { query: "z" })]);
    saveBtn(s.header).click();
    typeName("neuf");
    s.deps.list = () => {
      throw new Error("liste illisible");
    };
    expect(() => clickConfirmInput()).not.toThrow();
    expect(s.deps.onWarn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
  });

  it("Confirmer (écrasement) alors qu'une écriture est déjà en cours : message, jamais de silence", async () => {
    const s = setup([crit("a", { query: "z" })]);
    saveBtn(s.header).click();
    typeName("a"); // même nom, autre configuration : confirmation d'écrasement
    clickConfirmInput();
    expect(confirmDialog()).not.toBeNull();
    s.saveFn.mockImplementationOnce(() => new Promise(() => undefined)); // une écriture qui ne finit pas
    typeName("neuf");
    clickConfirmInput();
    expect(s.saveFn).toHaveBeenCalledTimes(1);
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    expect(s.saveFn).toHaveBeenCalledTimes(1);
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
    expect(s.deps.onWarn).toHaveBeenCalled();
  });

  it("écriture qui lève de façon synchrone depuis la confirmation : trace et message", async () => {
    const s = setup([crit("a", { query: "z" })]);
    saveBtn(s.header).click();
    typeName("a");
    clickConfirmInput();
    s.saveFn.mockImplementationOnce(() => {
      throw new Error("save synchrone en échec");
    });
    confirmDialog()!.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn")!.click();
    await flush();
    expect(s.deps.notify).toHaveBeenCalledWith(fr.criteriaSaveFailed);
  });
});

describe("focus après suppression ou enregistrement (I2)", () => {
  const del = (chip: HTMLElement): void => {
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  };
  it("Suppr sur une puce du milieu : la puce voisine (même rang) reçoit le focus", async () => {
    const s = setup([crit("a", { query: "1" }), crit("b", { query: "2" }), crit("c", { query: "3" })]);
    del(chips(s.header)[1]!);
    await flush();
    expect(chips(s.header).map((c) => c.textContent)).toEqual(["a", "c"]);
    expect(document.activeElement).toBe(chips(s.header)[1]);
  });

  it("Suppr sur la dernière puce : l'avant-dernière reçoit le focus", async () => {
    const s = setup([crit("a", { query: "1" }), crit("b", { query: "2" })]);
    del(chips(s.header)[1]!);
    await flush();
    expect(document.activeElement).toBe(chips(s.header)[0]);
  });

  it("Suppr sur l'unique puce : le focus va au bouton « Enregistrer »", async () => {
    const s = setup([crit("a")]);
    del(chips(s.header)[0]!);
    await flush();
    expect(document.activeElement).toBe(saveBtn(s.header));
  });

  it("suppression à la souris, focus hors de la ligne : le focus n'est pas volé", async () => {
    const s = setup([crit("a", { query: "1" }), crit("b", { query: "2" })]);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    chips(s.header)[0]!.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.activeElement).toBe(outside);
  });

  it("enregistrement qui change la liste : le focus revient au bouton « Enregistrer »", async () => {
    const s = setup([crit("a", { query: "1" })]);
    saveBtn(s.header).click();
    typeName("neuf");
    clickConfirmInput();
    await flush();
    expect(names(s)).toEqual(["a", "neuf"]);
    expect(document.activeElement).toBe(saveBtn(s.header));
  });
});
