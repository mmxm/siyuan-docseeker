// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "../../../src/search/resultOptions";
import type { SaveCriteriaResult, SavedCriteria } from "../../../src/search/savedCriteria";
import { canSaveCriteria, criteriaMenuItems, criteriaSummary, openCriteriaDialog } from "../../../src/ui/criteriaMenu";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { createNativeFakes } from "./nativeFakes";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? `?${key}`).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

const crit = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS },
  sort: { key: "relevance", direction: "desc" },
  groupByDocument: true,
  ...extra,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("canSaveCriteria", () => {
  const base = { filters: { ...NO_FILTERS }, sort: { key: "relevance", direction: "desc" } as const, groupByDocument: true };
  it("requête vide ET aucun filtre : non", () => {
    expect(canSaveCriteria({ ...base, query: "" })).toBe(false);
    expect(canSaveCriteria({ ...base, query: "   " })).toBe(false);
  });
  it("requête seule : oui ; filtres seuls (requête vide) : oui", () => {
    expect(canSaveCriteria({ ...base, query: "a" })).toBe(true);
    expect(canSaveCriteria({ ...base, query: "", filters: { ...NO_FILTERS, nameContains: "x" } })).toBe(true);
    expect(canSaveCriteria({ ...base, query: "", filters: { ...NO_FILTERS, folder: "assets/" } })).toBe(true);
  });
  it("« sous-dossiers » seul n'est pas un filtre", () => {
    expect(canSaveCriteria({ ...base, query: "", filters: { ...NO_FILTERS, includeSubfolders: false } })).toBe(false);
  });
});

describe("criteriaSummary", () => {
  const sort = { key: "relevance", direction: "desc" } as const;
  it("requête, nombre de filtres, tri, regroupement", () => {
    const text = criteriaSummary({ query: "chat", filters: { ...NO_FILTERS, nameContains: "x", minPages: 2 }, sort, groupByDocument: true }, t);
    expect(text).toBe("Requête : chat · Filtres (2 actifs) · Tri : Pertinence · Regrouper par document");
  });
  it("sans requête ni filtre : ces segments sont omis ; liste plate", () => {
    expect(criteriaSummary({ query: "", filters: { ...NO_FILTERS }, sort: { key: "name", direction: "asc" }, groupByDocument: false }, t)).toBe(
      "Tri : Nom croissant · Aucun regroupement",
    );
  });
  it("un seul filtre : forme singulière ; requête très longue tronquée", () => {
    const text = criteriaSummary({ query: "x".repeat(300), filters: { ...NO_FILTERS, nameContains: "x" }, sort, groupByDocument: true }, t);
    expect(text).toContain("Filtres (1 actif)");
    expect(text.length).toBeLessThan(200);
  });
});

describe("criteriaMenuItems", () => {
  const args = (over: Partial<Parameters<typeof criteriaMenuItems>[0]> = {}) => ({
    list: [] as readonly SavedCriteria[],
    t,
    appliedName: undefined as string | undefined,
    canSave: true,
    onSave: vi.fn(),
    onRecall: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  });

  it("liste vide : Enregistrer, séparateur, UNE entrée désactivée « Aucun critère enregistré », rien d'autre", () => {
    const items = criteriaMenuItems(args());
    expect(items.map((i) => (i.separator ? "—" : i.label))).toEqual(["Enregistrer les critères actuels…", "—", "Aucun critère enregistré"]);
    expect(items[2]?.disabled).toBe(true);
    expect(items[2]?.click).toBeUndefined();
  });

  it("Enregistrer désactivé avec une infobulle explicative quand il n'y a rien à enregistrer", () => {
    const [save] = criteriaMenuItems(args({ canSave: false }));
    expect(save?.disabled).toBe(true);
    expect(save?.title).toBe("Rien à enregistrer : saisissez une requête ou choisissez un filtre.");
  });

  it("Enregistrer actif : sans infobulle, son clic ouvre le dialogue", () => {
    const a = args();
    const [save] = criteriaMenuItems(a);
    expect(save?.disabled).not.toBe(true);
    expect(save?.title).toBeUndefined();
    save?.click?.();
    expect(a.onSave).toHaveBeenCalledTimes(1);
  });

  it("un item par critère, trié alphabétiquement en français (casse et accents ignorés)", () => {
    const items = criteriaMenuItems(args({ list: [crit("Zèbre"), crit("été"), crit("alpha"), crit("Beta 10"), crit("Beta 2")] }));
    expect(items.slice(2, 7).map((i) => i.label)).toEqual(["alpha", "Beta 2", "Beta 10", "été", "Zèbre"]);
  });

  it("current seulement pour le critère rappelé et inchangé ; clic = rappel", () => {
    const a = args({ list: [crit("a"), crit("b")], appliedName: "b" });
    const items = criteriaMenuItems(a);
    const [ia, ib] = [items[2], items[3]];
    expect(ia?.current).not.toBe(true);
    expect(ib?.current).toBe(true);
    ia?.click?.();
    expect(a.onRecall).toHaveBeenCalledWith(a.list[0]);
  });

  it("sous-menu « Supprimer un critère » : séparateur puis les noms, clic = suppression directe", () => {
    const a = args({ list: [crit("b"), crit("a")] });
    const items = criteriaMenuItems(a);
    expect(items.at(-2)?.separator).toBe(true);
    const del = items.at(-1);
    expect(del?.label).toBe("Supprimer un critère");
    expect(del?.click).toBeUndefined();
    expect(del?.submenu?.map((i) => i.label)).toEqual(["a", "b"]);
    del?.submenu?.[1]?.click?.();
    expect(a.onDelete).toHaveBeenCalledWith(a.list[0]);
  });

  it("un nom hostile reste du texte brut dans le libellé (l'adaptateur l'échappe)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const items = criteriaMenuItems(args({ list: [crit(evil)] }));
    expect(items[2]?.label).toBe(evil);
    expect(items.at(-1)?.submenu?.[0]?.label).toBe(evil);
  });

  it("nom très long : libellé tronqué", () => {
    const items = criteriaMenuItems(args({ list: [crit("x".repeat(80))] }));
    expect(Array.from(items[2]?.label ?? "").length).toBeLessThanOrEqual(80);
  });
});

describe("openCriteriaDialog", () => {
  let fakes: ReturnType<typeof createNativeFakes>;
  let save: ReturnType<typeof vi.fn<(c: SavedCriteria) => Promise<SaveCriteriaResult>>>;
  let onSaved: ReturnType<typeof vi.fn<(info: { readonly name: string; readonly replaced: boolean }) => void>>;
  let onSaveFailed: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  let onDestroyed: ReturnType<typeof vi.fn<() => void>>;
  let onWarn: ReturnType<typeof vi.fn<(message: string, error?: unknown) => void>>;
  let existing: SavedCriteria[];
  const state = { query: "chat", filters: { ...NO_FILTERS, nameContains: "x" }, sort: { key: "name", direction: "asc" } as const, groupByDocument: false };

  const open = (over: { initialName?: string; state?: typeof state } = {}) => {
    const handle = openCriteriaDialog({
      doc: document,
      t,
      openDialog: fakes.openDialog,
      state: over.state ?? state,
      initialName: over.initialName ?? "",
      list: () => existing,
      save,
      onSaved,
      onSaveFailed,
      onDestroyed,
      onWarn,
    });
    const d = fakes.lastDialog();
    const input = d.container.querySelector<HTMLInputElement>("input")!;
    const error = d.container.querySelector<HTMLElement>(".docseeker-filter-error")!;
    return { handle, d, input, error };
  };
  const type = (input: HTMLInputElement, value: string): void => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    fakes = createNativeFakes();
    existing = [];
    save = vi.fn(async (c: SavedCriteria) => ({ replaced: existing.some((e) => e.name.toLowerCase() === c.name.toLowerCase()) }));
    onSaved = vi.fn();
    onSaveFailed = vi.fn();
    onDestroyed = vi.fn();
    onWarn = vi.fn();
  });

  it("dialogue natif : titre, boutons Annuler / Enregistrer, largeur", () => {
    const { d } = open();
    expect(d.options.title).toBe("Enregistrer les critères");
    expect(d.options.labels).toEqual({ cancel: "Annuler", confirm: "Enregistrer" });
    expect(d.options.width).toMatch(/^\d{1,4}px$/);
  });

  it("champ b3-text-field « Nom du critère » relié à son libellé, maxlength 80, texte pré-rempli et sélectionné", () => {
    const { d, input } = open({ initialName: "Mon critère" });
    expect(input.className).toContain("b3-text-field");
    expect(input.maxLength).toBe(80);
    expect(input.value).toBe("Mon critère");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Mon critère".length);
    const label = d.container.querySelector<HTMLLabelElement>("label")!;
    expect(label.textContent).toBe("Nom du critère");
    expect(label.htmlFor).toBe(input.id);
    expect(input.id).not.toBe("");
  });

  it("résumé en lecture seule sous le champ", () => {
    const { d, input } = open();
    const summary = d.container.querySelector<HTMLElement>(".docseeker-criteria-summary")!;
    expect(summary.textContent).toBe("Requête : chat · Filtres (1 actif) · Tri : Nom croissant · Aucun regroupement");
    expect(summary.tagName).not.toBe("INPUT");
    expect(input.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("nom vide : erreur sous le champ au format « Erreur : … », focus sur le champ, rien d'écrit, dialogue ouvert", () => {
    const { d, input, error } = open();
    document.body.focus();
    expect(d.confirm()).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Erreur : Saisissez un nom pour ces critères.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(document.activeElement).toBe(input);
    expect(save).not.toHaveBeenCalled();
  });

  it("nom d'espaces (ou de caractères invisibles) seuls = vide", () => {
    const { d, input, error } = open();
    type(input, "  ​ \t");
    expect(d.confirm()).toBe(false);
    expect(error.textContent).toContain("Saisissez un nom");
  });

  it("nom trop long : erreur dédiée", () => {
    const { d, input, error } = open();
    type(input, "x".repeat(81));
    expect(d.confirm()).toBe(false);
    expect(error.textContent).toBe("Erreur : Le nom ne peut pas dépasser 80 caractères.");
    expect(save).not.toHaveBeenCalled();
  });

  it("requête de plus de 200 caractères : erreur dédiée, rien d'écrit", () => {
    const { d, input, error } = open({ state: { ...state, query: "q".repeat(201) } });
    type(input, "nom");
    expect(d.confirm()).toBe(false);
    expect(error.textContent).toBe("Erreur : La requête ne peut pas dépasser 200 caractères.");
    expect(save).not.toHaveBeenCalled();
  });

  it("aucune validation à la frappe : taper (même un nom invalide) n'affiche rien", () => {
    const { input, error } = open();
    type(input, "x".repeat(90));
    type(input, "");
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  });

  it("une erreur affichée disparaît dès que le nom est modifié", () => {
    const { d, input, error } = open();
    d.confirm();
    expect(error.hidden).toBe(false);
    type(input, "a");
    expect(error.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("30 critères et nom nouveau : message de limite, rien d'écrit", () => {
    existing = Array.from({ length: 30 }, (_, i) => crit(`c${i}`));
    const { d, input, error } = open();
    type(input, "nouveau");
    expect(d.confirm()).toBe(false);
    expect(error.textContent).toBe("Erreur : Vous avez déjà 30 critères. Supprimez-en un pour enregistrer celui-ci.");
    expect(save).not.toHaveBeenCalled();
  });

  it("30 critères : remplacer un nom existant reste possible", async () => {
    existing = Array.from({ length: 30 }, (_, i) => crit(`c${i}`));
    const { d, input } = open();
    type(input, "C3");
    d.confirm(); // demande de remplacement
    expect(d.confirmLabel).toBe("Remplacer");
    d.confirm();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({ name: "C3", replaced: true });
  });

  it("enregistrement : critère canonique transmis, dialogue fermé une fois l'écriture terminée, onSaved puis focus rendu", async () => {
    const { d, input } = open();
    type(input, "  Mon   critère ");
    expect(d.confirm()).toBe(false); // reste ouvert pendant l'écriture
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ name: "Mon critère", query: "chat", filters: state.filters, sort: state.sort, groupByDocument: false });
    expect(d.handle.isOpen()).toBe(true);
    await flush();
    expect(d.handle.isOpen()).toBe(false);
    expect(onSaved).toHaveBeenCalledWith({ name: "Mon critère", replaced: false });
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("deux confirmations pendant l'écriture : une seule écriture", async () => {
    let release!: () => void;
    save.mockImplementationOnce(() => new Promise((r) => (release = () => r({ replaced: false }))));
    const { d, input } = open();
    type(input, "a");
    d.confirm();
    d.confirm();
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("nom existant (casse, accents, NFC) : onConfirm renvoie false, message de remplacement sous le champ, bouton « Remplacer »", () => {
    existing = [crit("Été")];
    const { d, input, error } = open();
    type(input, "ete");
    expect(d.confirm()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Un critère nommé « ete » existe déjà. Remplacez-le ou changez le nom.");
    expect(d.confirmLabel).toBe("Remplacer");
    expect(document.activeElement).toBe(input);
  });

  it("Entrée / Enregistrer une seconde fois en mode remplacement : écrit et signale replaced", async () => {
    existing = [crit("Été")];
    const { d, input } = open();
    type(input, "été");
    d.confirm();
    d.confirm();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({ name: "été", replaced: true });
  });

  it("toute modification du nom annule le mode remplacement (libellé rétabli, message effacé)", async () => {
    existing = [crit("Été")];
    const { d, input, error } = open();
    type(input, "ete");
    d.confirm();
    type(input, "ete2");
    expect(d.confirmLabel).toBe("Enregistrer");
    expect(error.hidden).toBe(true);
    d.confirm();
    await flush();
    expect(onSaved).toHaveBeenCalledWith({ name: "ete2", replaced: false });
  });

  it("modifier le nom puis revenir au nom existant redemande la confirmation", () => {
    existing = [crit("Été")];
    const { d, input } = open();
    type(input, "ete");
    d.confirm();
    type(input, "et");
    type(input, "ete");
    d.confirm();
    expect(save).not.toHaveBeenCalled();
    expect(d.confirmLabel).toBe("Remplacer");
  });

  it("échec d'écriture : erreur sous le champ, focus sur le champ, trace, dialogue ouvert, nouvel essai possible", async () => {
    const boom = new Error("disque plein");
    save.mockRejectedValueOnce(boom);
    const { d, input, error } = open();
    type(input, "a");
    d.confirm();
    await flush();
    expect(error.textContent).toBe("Erreur : Impossible d'enregistrer les critères (voir le journal dans les paramètres)");
    expect(document.activeElement).toBe(input);
    expect(onSaveFailed).toHaveBeenCalledWith(boom);
    expect(d.handle.isOpen()).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    d.confirm();
    await flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("refus de la limite par le magasin (autre fenêtre) : message de limite, dialogue ouvert", async () => {
    save.mockResolvedValueOnce({ error: "limit" });
    const { d, input, error } = open();
    type(input, "a");
    d.confirm();
    await flush();
    expect(error.textContent).toContain("Vous avez déjà 30 critères");
    expect(d.handle.isOpen()).toBe(true);
  });

  it("autres refus du magasin (tri, etc.) : message d'échec et trace, jamais silencieux", async () => {
    save.mockResolvedValueOnce({ error: "sort" });
    const { d, input, error } = open();
    type(input, "a");
    d.confirm();
    await flush();
    expect(error.textContent).toContain("Impossible d'enregistrer les critères");
    expect(onSaveFailed).toHaveBeenCalled();
  });

  it("Annuler / Échap : rien n'est écrit, onDestroyed une fois", () => {
    const { d, input } = open();
    type(input, "a");
    d.cancel();
    expect(save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("dialogue détruit pendant l'écriture : l'écriture aboutit, onSaved est signalé, aucune erreur", async () => {
    let release!: () => void;
    save.mockImplementationOnce(() => new Promise((r) => (release = () => r({ replaced: false }))));
    const { d, input } = open();
    type(input, "a");
    d.confirm();
    d.cancel();
    release();
    await flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("dialogue détruit pendant une écriture qui échoue : la trace est faite, rien n'est affiché dans un DOM détaché", async () => {
    let fail!: (e: unknown) => void;
    save.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    const { d, input } = open();
    type(input, "a");
    d.confirm();
    d.cancel();
    fail(new Error("KO"));
    await flush();
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it("onSaved qui lève : l'écriture a eu lieu, donc pas de « non enregistrés » ; trace, et le dialogue se ferme quand même", async () => {
    const boom = new Error("sync KO");
    onSaved.mockImplementationOnce(() => {
      throw boom;
    });
    const { d, input } = open();
    type(input, "a");
    d.confirm();
    await flush();
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(d.handle.isOpen()).toBe(false);
  });

  it("onSaveFailed qui lève : tracé, l'erreur reste affichée sous le champ, aucun rejet non géré, nouvel essai possible", async () => {
    const boom = new Error("say KO");
    save.mockRejectedValueOnce(new Error("disque"));
    onSaveFailed.mockImplementationOnce(() => {
      throw boom;
    });
    const { d, input, error } = open();
    type(input, "a");
    d.confirm();
    await flush();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(error.hidden).toBe(false);
    expect(d.handle.isOpen()).toBe(true);
    d.confirm();
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("nom hostile : message de remplacement posé en texte, aucune balise créée", () => {
    const evil = "<img src=x onerror=alert(1)>";
    existing = [crit(evil)];
    const { d, input, error } = open();
    type(input, evil);
    d.confirm();
    expect(error.textContent).toContain(evil);
    expect(d.container.querySelector("img")).toBeNull();
  });
});
