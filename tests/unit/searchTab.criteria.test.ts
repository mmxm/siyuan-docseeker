// @vitest-environment jsdom
// Critères enregistrés dans l'assemblage de l'onglet : enregistrement, rappel (portée résolue comme un choix manuel), chemin disparu,
// suppression, messages. Les réglages sont les VRAIS (createSettings) sur un faux fichier ; le noyau est simulé.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "../../src/search/resultOptions";
import type { SavedCriteria } from "../../src/search/savedCriteria";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { createSettings, type SettingsStore } from "../../src/settings";
import type { SqlResult } from "../../src/siyuan/kernelApi";
import { createNativeFakes, pick } from "./ui/nativeFakes";
import { PDF_A, button, cards, flush, harness as baseHarness, input, sharedInstances, submitQuery } from "./helpers/searchTabHarness";

const NB = "20240101000000-aaaaaaa";
const DOC1 = "20240102000000-0000001";
const DOC_SCOPE = { kind: "document", box: NB, docPath: `/${DOC1}.sy`, label: "Cahier A / Parent" } as const;
const NB_SCOPE = { kind: "notebook", box: NB, label: "Cahier A" } as const;

let fakes = createNativeFakes();
let file: unknown;
let saveFails: Error | undefined;
let store: SettingsStore;
let settingsWarn: ReturnType<typeof vi.fn<(message: string, error?: unknown) => void>>;
let assets: { mode: "auto"; paths: string[] } | { mode: "manual" } | { mode: "fail"; error: unknown };
let pending: Array<(paths: string[]) => void>;

const ok = (rows: Record<string, unknown>[]): SqlResult => ({ rows, truncated: false });
const kernel = () => ({
  lsNotebooks: vi.fn(async () => [{ id: NB, name: "Cahier A", closed: false }]),
  sql: vi.fn((stmt: string): Promise<SqlResult> => {
    if (stmt.includes("from blocks")) return Promise.resolve(ok([{ id: DOC1, box: NB, path: `/${DOC1}.sy`, hpath: "/Parent" }]));
    if (assets.mode === "fail") return Promise.reject(assets.error);
    if (assets.mode === "auto") return Promise.resolve(ok(assets.paths.map((path) => ({ path }))));
    return new Promise<SqlResult>((resolve) => pending.push((paths) => resolve(ok(paths.map((path) => ({ path }))))));
  }),
});

const crit = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS },
  sort: { key: "name", direction: "asc" },
  groupByDocument: false,
  ...extra,
});

function harness(over: Partial<SearchTabDeps> = {}) {
  const h = baseHarness({ kernel: kernel(), settings: store, ...over }, fakes);
  return h;
}
const message = (host: HTMLElement): string => host.querySelector(".docseeker-message")!.textContent ?? "";
const critBtn = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label^="Critères"]');
const pathLabel = (host: HTMLElement) => host.querySelector<HTMLElement>("span.search__path")!;
const names = (): string[] => store.get().savedCriteria.map((c) => c.name);

async function mountReady(over: Partial<SearchTabDeps> = {}) {
  const h = harness(over);
  const tab = mountSearchTab(h.host, h.deps);
  await store.ready;
  await flush();
  return { h, tab };
}
async function recall(host: HTMLElement, name: string): Promise<void> {
  critBtn(host)!.click();
  pick(fakes.lastMenu(), name);
  await flush();
}
async function saveAs(host: HTMLElement, name: string, confirms = 1): Promise<void> {
  critBtn(host)!.click();
  pick(fakes.lastMenu(), "Enregistrer les critères actuels…");
  const field = fakes.lastDialog().container.querySelector<HTMLInputElement>("input")!;
  field.value = name;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  for (let i = 0; i < confirms; i++) fakes.lastDialog().confirm();
  await flush();
}

beforeEach(() => {
  fakes = createNativeFakes();
  file = { savedCriteria: [] };
  saveFails = undefined;
  settingsWarn = vi.fn();
  store = createSettings({
    load: async () => structuredClone(file),
    save: async (v) => {
      if (saveFails) throw saveFails;
      file = structuredClone(v);
    },
    onWarn: settingsWarn,
  });
  assets = { mode: "auto", paths: [PDF_A] };
  pending = [];
  vi.useFakeTimers();
});
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("bouton « Critères enregistrés »", () => {
  it("présent avec les réglages réels ; absent si les réglages ne gèrent pas les critères (ancien contrat)", async () => {
    const { tab, h } = await mountReady();
    expect(critBtn(h.host)).not.toBeNull();
    tab.dispose();
    const h2 = baseHarness({ settings: { get: store.get, update: store.update } }, fakes);
    const tab2 = mountSearchTab(h2.host, h2.deps);
    expect(critBtn(h2.host)).toBeNull();
    tab2.dispose();
  });

  it("absent sans réglages du tout", () => {
    const h = baseHarness({}, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    expect(critBtn(h.host)).toBeNull();
    tab.dispose();
  });
});

describe("enregistrer", () => {
  it("enregistre requête, tri, regroupement et filtres courants, écrit le fichier, affiche « Critères enregistrés : nom »", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await saveAs(h.host, "Mes chats");
    expect(message(h.host)).toBe("Critères enregistrés : Mes chats");
    expect(names()).toEqual(["Mes chats"]);
    const written = (file as { savedCriteria: SavedCriteria[] }).savedCriteria;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ name: "Mes chats", query: "chat", groupByDocument: true });
    expect(critBtn(h.host)!.getAttribute("aria-label")).toBe("Critères : Mes chats");
    tab.dispose();
  });

  it("remplacer : « Critères remplacés : nom »", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await saveAs(h.host, "A");
    await submitQuery(h.host, "chien");
    await saveAs(h.host, "a", 2);
    expect(message(h.host)).toBe("Critères remplacés : a");
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.query)).toEqual(["chien"]);
    tab.dispose();
  });

  it("échec d'écriture : erreur sous le champ du dialogue, trace dans le journal, dialogue ouvert", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    saveFails = new Error("disque plein");
    await saveAs(h.host, "A");
    const error = fakes.lastDialog().container.querySelector(".docseeker-filter-error")!;
    expect(error.textContent).toBe("Erreur : Impossible d'enregistrer les critères (voir le journal dans les paramètres)");
    expect(fakes.lastDialog().handle.isOpen()).toBe(true);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), saveFails);
    tab.dispose();
  });

  it("rien à enregistrer (requête vide, aucun filtre) : l'entrée du menu est désactivée", async () => {
    const { tab, h } = await mountReady();
    critBtn(h.host)!.click();
    const item = fakes.lastMenu().items.find((i) => i.label === "Enregistrer les critères actuels…")!;
    expect(item.disabled).toBe(true);
    tab.dispose();
  });
});

describe("rappeler", () => {
  it("applique filtres, tri et regroupement, restaure la requête dans le champ et la relance", async () => {
    file = { savedCriteria: [crit("c", { filters: { ...NO_FILTERS, nameContains: "alpha" }, sort: { key: "modified", direction: "desc" } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "c");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(input(h.host).value).toBe("chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    expect(button(h.host, "Filtres (1 actif)")).not.toBeNull();
    expect(h.host.querySelector(".docseeker-list--flat")).not.toBeNull(); // regroupement : liste plate
    expect(critBtn(h.host)!.getAttribute("aria-label")).toBe("Critères : c");
    tab.dispose();
  });

  it("un rappel n'ajoute pas la requête à l'historique", async () => {
    file = { savedCriteria: [crit("c")] };
    const { tab, h } = await mountReady();
    await recall(h.host, "c");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(store.get().history).toEqual([]);
    tab.dispose();
  });

  it("critère à filtres seuls (requête vide) : champ vidé, filtres appliqués", async () => {
    file = { savedCriteria: [crit("f", { query: "", filters: { ...NO_FILTERS, nameContains: "zzz" } })] };
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await recall(h.host, "f");
    expect(input(h.host).value).toBe("");
    expect(button(h.host, "Filtres (1 actif)")).not.toBeNull();
    tab.dispose();
  });

  it("portée de documents : repasse par la résolution asynchrone (message de chargement, requête restaurée une fois résolue)", async () => {
    assets = { mode: "manual" };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scope: DOC_SCOPE } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    expect(message(h.host)).toBe("Chargement du chemin…");
    expect(pathLabel(h.host).textContent).toBe("Cahier A / Parent");
    expect(input(h.host).value).toBe(""); // pas de résultat non filtré entre-temps
    pending[0]!([PDF_A]);
    await flush();
    expect(message(h.host)).toBe("");
    expect(input(h.host).value).toBe("chat");
    tab.dispose();
  });

  it("portée résolue à zéro PDF (document ou cahier disparu) : appliqué SANS le chemin, autres filtres gardés, message dédié, recherche lancée", async () => {
    assets = { mode: "auto", paths: [] };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, nameContains: "alpha", scope: DOC_SCOPE } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("Le chemin de ce critère n'existe plus. La recherche s'est lancée sans lui.");
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(button(h.host, "Filtres (1 actif)")).not.toBeNull();
    expect(input(h.host).value).toBe("chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("même cas avec un cahier disparu (portée en cache à zéro PDF au second rappel)", async () => {
    assets = { mode: "auto", paths: [] };
    file = { savedCriteria: [crit("n", { filters: { ...NO_FILTERS, scope: NB_SCOPE } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "n");
    await recall(h.host, "n"); // cache chaud : chemin synchrone
    expect(message(h.host)).toBe("Le chemin de ce critère n'existe plus. La recherche s'est lancée sans lui.");
    expect(pathLabel(h.host).hidden).toBe(true);
    tab.dispose();
  });

  it("noyau en échec : rien n'est appliqué (jamais un filtre de portée ignoré en silence), message et trace", async () => {
    assets = { mode: "fail", error: new Error("noyau KO") };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scope: DOC_SCOPE } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    expect(message(h.host)).toContain("Le filtre par document n'a pas pu être appliqué");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "noyau KO" }));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(input(h.host).value).toBe("");
    expect(critBtn(h.host)!.getAttribute("aria-label")).toBe("Critères enregistrés");
    tab.dispose();
  });

  it("deux rappels successifs : seul le dernier s'applique", async () => {
    assets = { mode: "manual" };
    file = { savedCriteria: [crit("un", { query: "un", filters: { ...NO_FILTERS, scope: DOC_SCOPE } }), crit("deux", { query: "deux" })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "un");
    await recall(h.host, "deux");
    pending[0]?.([PDF_A]);
    await flush();
    expect(input(h.host).value).toBe("deux");
    expect(pathLabel(h.host).hidden).toBe(true);
    tab.dispose();
  });

  it("fermeture de l'onglet pendant la résolution : aucune erreur, rien d'appliqué", async () => {
    assets = { mode: "manual" };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scope: DOC_SCOPE } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    tab.dispose();
    expect(() => pending[0]?.([PDF_A])).not.toThrow();
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
  });

  it("le tri et le regroupement rappelés sont mémorisés comme un choix manuel", async () => {
    file = { savedCriteria: [crit("c", { sort: { key: "modified", direction: "desc" }, groupByDocument: false })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "c");
    expect(store.get().sort).toEqual({ key: "modified", direction: "desc" });
    expect(store.get().groupByDocument).toBe(false);
    tab.dispose();
  });
});

describe("supprimer", () => {
  it("suppression directe, fichier mis à jour, « Critère supprimé : nom »", async () => {
    file = { savedCriteria: [crit("a"), crit("b")] };
    const { tab, h } = await mountReady();
    critBtn(h.host)!.click();
    pick(fakes.lastMenu(), "Supprimer un critère", "a");
    await flush();
    expect(message(h.host)).toBe("Critère supprimé : a");
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.name)).toEqual(["b"]);
    tab.dispose();
  });

  it("échec d'écriture : message d'échec visible et trace", async () => {
    file = { savedCriteria: [crit("a")] };
    const { tab, h } = await mountReady();
    saveFails = new Error("lecture seule");
    critBtn(h.host)!.click();
    pick(fakes.lastMenu(), "Supprimer un critère", "a");
    await flush();
    expect(message(h.host)).toBe("Impossible de supprimer le critère (voir le journal dans les paramètres)");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), saveFails);
    tab.dispose();
  });
});

describe("critères d'un autre onglet ou fenêtre", () => {
  it("la liste du menu est relue à chaque ouverture (réglages partagés)", async () => {
    const { tab, h } = await mountReady();
    await store.saveCriteria(crit("venu-d-ailleurs"));
    critBtn(h.host)!.click();
    expect(fakes.lastMenu().items.some((i) => i.label === "venu-d-ailleurs")).toBe(true);
    tab.dispose();
  });
});
