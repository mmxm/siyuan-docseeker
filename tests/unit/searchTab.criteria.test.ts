// @vitest-environment jsdom
// Critères enregistrés dans l'assemblage de l'onglet : enregistrement, rappel (portée résolue comme un choix manuel), chemin disparu,
// suppression, messages. Les réglages sont les VRAIS (createSettings) sur un faux fichier ; le noyau est simulé.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "../../src/search/resultOptions";
import type { SavedCriteria } from "../../src/search/savedCriteria";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { createSettings, type SettingsStore } from "../../src/settings";
import { NotFoundError, type SqlResult } from "../../src/siyuan/kernelApi";
import { Dialog, Menu } from "siyuan";
import { createNativeFakes } from "./ui/nativeFakes";
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
  lsNotebooks: vi.fn(async () => [{ id: NB, name: "Cahier A", closed: false, icon: "" }]),
  listDocsByPath: vi.fn(async () => []),
  searchDocs: vi.fn(async () => []),
  // Le document existe (son chemin lisible est rendu) ; un test le rend inexistant en renvoyant [] ou en rejetant.
  getHPathsByPaths: vi.fn(async (paths: readonly string[]) => paths.map(() => "Cahier A/Parent")),
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
const header = (host: HTMLElement) => host.querySelector<HTMLElement>(".search__header");
const chips = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-type="set-criteria"]')];
const chipNamed = (host: HTMLElement, name: string): HTMLElement => chips(host).find((c) => c.textContent === name)!;
const isCurrent = (host: HTMLElement, name: string): boolean => chipNamed(host, name).classList.contains("b3-chip--current");
const saveButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[data-type="saveCriterion"]')!;
const resetButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[data-type="removeCriterion"]')!;
const pathLabel = (host: HTMLElement) => host.querySelector<HTMLElement>("span.search__path")!;
const names = (): string[] => store.get().savedCriteria.map((c) => c.name);
const confirmButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>("#confirmDialogConfirmBtn");

async function mountReady(over: Partial<SearchTabDeps> = {}) {
  const h = harness(over);
  const tab = mountSearchTab(h.host, h.deps);
  await store.ready;
  await flush();
  return { h, tab };
}
async function recall(host: HTMLElement, name: string): Promise<void> {
  chipNamed(host, name).click();
  await flush();
}
async function saveAs(host: HTMLElement, name: string, confirms = 1): Promise<void> {
  saveButton(host).click();
  const field = document.querySelector<HTMLInputElement>("[data-dialog-input]")!;
  field.value = name;
  document.querySelector<HTMLButtonElement>("[data-input-confirm]")!.click();
  if (confirms > 1) confirmButton()!.click();
  await flush();
}

beforeEach(() => {
  (Menu as unknown as { reset(): void }).reset();
  (Dialog as unknown as { reset(): void }).reset();
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

describe("ligne des critères enregistrés", () => {
  it("présente avec les réglages réels ; absente si les réglages ne gèrent pas les critères (ancien contrat) ou sans dialogues natifs", async () => {
    const { tab, h } = await mountReady();
    expect(header(h.host)).not.toBeNull();
    tab.dispose();
    const h2 = baseHarness({ settings: { get: store.get, update: store.update } }, fakes);
    const tab2 = mountSearchTab(h2.host, h2.deps);
    expect(header(h2.host)).toBeNull();
    tab2.dispose();
    const h3 = harness();
    const { openInputDialog: _input, openConfirmDialog: _confirm, ...bare } = h3.deps;
    const tab3 = mountSearchTab(h3.host, bare);
    expect(header(h3.host)).toBeNull();
    tab3.dispose();
  });

  it("absente sans réglages du tout ; aucun bouton signet dans la barre d'icônes", async () => {
    const h = baseHarness({}, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    expect(header(h.host)).toBeNull();
    tab.dispose();
    const ready = await mountReady();
    expect(ready.h.host.querySelector('.docseeker-icons button[aria-label^="Critères"]')).toBeNull();
    ready.tab.dispose();
  });
});

describe("enregistrer", () => {
  it("enregistre requête, tri, regroupement et filtres courants, écrit le fichier, ajoute la puce courante", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await saveAs(h.host, "Mes chats");
    expect(names()).toEqual(["Mes chats"]);
    const written = (file as { savedCriteria: SavedCriteria[] }).savedCriteria;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ name: "Mes chats", query: "chat", groupByDocument: true });
    expect(chips(h.host).map((c) => c.textContent)).toEqual(["Mes chats"]);
    expect(isCurrent(h.host, "Mes chats")).toBe(true);
    expect(document.querySelector('[data-key="dialog-savecriterion"]')).toBeNull();
    tab.dispose();
  });

  it("écraser (même nom, requête différente) : confirmation, puis fichier mis à jour", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await saveAs(h.host, "A");
    await submitQuery(h.host, "chien");
    await saveAs(h.host, "A", 2);
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.query)).toEqual(["chien"]);
    tab.dispose();
  });

  it("renommer (même configuration, autre nom) : le fichier ne contient que le nouveau nom", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    await saveAs(h.host, "Vieux");
    await saveAs(h.host, "Neuf", 2);
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.name)).toEqual(["Neuf"]);
    expect(chips(h.host).map((c) => c.textContent)).toEqual(["Neuf"]);
    tab.dispose();
  });

  it("échec d'écriture : message sous le champ, trace dans le journal, liste inchangée, dialogue d'entrée ouvert", async () => {
    const { tab, h } = await mountReady();
    await submitQuery(h.host, "chat");
    saveFails = new Error("disque plein");
    await saveAs(h.host, "A");
    expect(message(h.host)).toBe("Impossible d'enregistrer les critères (voir le journal dans les paramètres)");
    expect(document.querySelector('[data-key="dialog-savecriterion"]')).not.toBeNull();
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), saveFails);
    expect(names()).toEqual([]);
    expect(chips(h.host)).toHaveLength(0);
    tab.dispose();
  });

  it("nom vide : « L'entrée ne peut pas être vide » dans la zone de messages", async () => {
    const { tab, h } = await mountReady();
    await saveAs(h.host, "  ");
    expect(message(h.host)).toBe("L'entrée ne peut pas être vide");
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
    expect(isCurrent(h.host, "c")).toBe(true);
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
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
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

  it("critère à deux portées : rappelé et résolu ensemble (une seule requête), étiquette jointe par un espace", async () => {
    assets = { mode: "manual" };
    file = { savedCriteria: [crit("deux", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE, DOC_SCOPE] } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "deux");
    expect(message(h.host)).toBe("Chargement du chemin…");
    expect(pending).toHaveLength(1);
    expect(pathLabel(h.host).textContent).toBe("Cahier A Cahier A / Parent");
    pending[0]!([PDF_A]);
    await flush();
    expect(message(h.host)).toBe("");
    expect(input(h.host).value).toBe("chat");
    tab.dispose();
  });

  const MISSING = (label: string): string => `Le chemin « ${label} » de ce critère n'existe plus. Il a été retiré de la recherche.`;
  const withKernel = async (patch: (k: ReturnType<typeof kernel>) => void, over: Partial<SearchTabDeps> = {}) => {
    const k = kernel();
    patch(k);
    return { k, ...(await mountReady({ kernel: k, ...over })) };
  };

  it("document inexistant (le noyau ne renvoie aucun chemin) : retiré du critère avec un message qui le nomme, autres filtres gardés, recherche lancée", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, nameContains: "alpha", scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.getHPathsByPaths.mockResolvedValue([]));
    await recall(h.host, "d");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe(MISSING("Cahier A / Parent"));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(button(h.host, "Filtres (1 actif)")).not.toBeNull();
    expect(input(h.host).value).toBe("chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("document inexistant signalé par une erreur « introuvable » du noyau : même traitement", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.getHPathsByPaths.mockRejectedValue(new NotFoundError(404, "tree not found")));
    await recall(h.host, "d");
    expect(message(h.host)).toBe(MISSING("Cahier A / Parent"));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(input(h.host).value).toBe("chat");
    tab.dispose();
  });

  it("document qui EXISTE mais ne cite aucun PDF : la portée reste appliquée (résultat vide légitime), aucun message d'absence", async () => {
    assets = { mode: "auto", paths: [] };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(pathLabel(h.host).hidden).toBe(false);
    expect(pathLabel(h.host).textContent).toBe("Cahier A / Parent");
    expect(message(h.host)).not.toContain("n'existe plus");
    expect(input(h.host).value).toBe("chat");
    expect(cards(h.host)).toHaveLength(0); // rien de cité : pas de PDF, jamais « partout »
    tab.dispose();
  });

  it("cahier disparu (absent de lsNotebooks) : retiré avec un message qui le nomme", async () => {
    file = { savedCriteria: [crit("n", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.lsNotebooks.mockResolvedValue([]));
    await recall(h.host, "n");
    expect(message(h.host)).toBe(MISSING("Cahier A"));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(input(h.host).value).toBe("chat");
    tab.dispose();
  });

  it("cahier qui existe sans aucun PDF : la portée reste appliquée (au second rappel, cache chaud, aussi)", async () => {
    assets = { mode: "auto", paths: [] };
    file = { savedCriteria: [crit("n", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE] } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "n");
    await recall(h.host, "n");
    expect(pathLabel(h.host).hidden).toBe(false);
    expect(message(h.host)).not.toContain("n'existe plus");
    tab.dispose();
  });

  it("deux portées dont une inexistante : seule celle-là est retirée (et nommée), l'autre reste appliquée", async () => {
    file = { savedCriteria: [crit("deux", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE, DOC_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.getHPathsByPaths.mockResolvedValue([]));
    await recall(h.host, "deux");
    expect(message(h.host)).toBe(MISSING("Cahier A / Parent"));
    expect(pathLabel(h.host).textContent).toBe("Cahier A");
    tab.dispose();
  });

  it("toutes les portées inexistantes : appliqué sans chemin, avec le message qui les nomme toutes", async () => {
    file = { savedCriteria: [crit("deux", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE, DOC_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.lsNotebooks.mockResolvedValue([]));
    await recall(h.host, "deux");
    expect(message(h.host)).toBe(MISSING("Cahier A, Cahier A / Parent"));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(input(h.host).value).toBe("chat");
    tab.dispose();
  });

  it("vérification d'existence en échec (noyau) : rien n'est appliqué, message d'erreur et trace, jamais un filtre ignoré en silence", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE] } })] };
    const boom = new Error("noyau KO");
    const { tab, h } = await withKernel((k) => k.lsNotebooks.mockRejectedValue(boom));
    await recall(h.host, "d");
    expect(message(h.host)).toContain("Le filtre par document n'a pas pu être appliqué");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    expect(input(h.host).value).toBe("");
    expect(isCurrent(h.host, "d")).toBe(false);
    tab.dispose();
  });

  it("erreur du noyau autre qu'« introuvable » sur le document : échec, pas « inexistant »", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await withKernel((k) => k.getHPathsByPaths.mockRejectedValue(new Error("500")));
    await recall(h.host, "d");
    expect(message(h.host)).not.toContain("n'existe plus");
    expect(message(h.host)).toContain("Le filtre par document n'a pas pu être appliqué");
    expect(input(h.host).value).toBe("");
    tab.dispose();
  });

  it("deux rappels pendant la vérification : seul le dernier s'applique", async () => {
    file = { savedCriteria: [crit("un", { query: "un", filters: { ...NO_FILTERS, scopes: [NB_SCOPE] } }), crit("deux", { query: "deux" })] };
    let release!: () => void;
    const { tab, h } = await withKernel((k) =>
      k.lsNotebooks.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([{ id: NB, name: "Cahier A", closed: false, icon: "" }])))),
    );
    chipNamed(h.host, "un").click();
    chipNamed(h.host, "deux").click();
    release();
    await flush();
    expect(input(h.host).value).toBe("deux");
    expect(pathLabel(h.host).hidden).toBe(true);
    tab.dispose();
  });

  it("onglet fermé pendant la vérification : rien n'est appliqué, aucune trace", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [NB_SCOPE] } })] };
    let release!: () => void;
    const { tab, h } = await withKernel((k) =>
      k.lsNotebooks.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([])))),
    );
    chipNamed(h.host, "d").click();
    tab.dispose();
    release();
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
  });

  it("noyau en échec : rien n'est appliqué (jamais un filtre de portée ignoré en silence), message et trace", async () => {
    assets = { mode: "fail", error: new Error("noyau KO") };
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    expect(message(h.host)).toContain("Le filtre par document n'a pas pu être appliqué");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "noyau KO" }));
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(input(h.host).value).toBe("");
    expect(isCurrent(h.host, "d")).toBe(false);
    tab.dispose();
  });

  it("deux rappels successifs : seul le dernier s'applique", async () => {
    assets = { mode: "manual" };
    file = { savedCriteria: [crit("un", { query: "un", filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } }), crit("deux", { query: "deux" })] };
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
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, scopes: [DOC_SCOPE] } })] };
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
  const closeOf = (host: HTMLElement, name: string): Element => chipNamed(host, name).querySelector("svg")!;
  const clickClose = async (host: HTMLElement, name: string): Promise<void> => {
    closeOf(host, name).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  };

  it("suppression directe sans confirmation, fichier mis à jour, puce retirée", async () => {
    file = { savedCriteria: [crit("a"), crit("b")] };
    const { tab, h } = await mountReady();
    await clickClose(h.host, "a");
    expect(document.querySelector('[data-key="dialog-confirm"]')).toBeNull();
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.name)).toEqual(["b"]);
    expect(chips(h.host).map((c) => c.textContent)).toEqual(["b"]);
    expect(input(h.host).value).toBe(""); // supprimer ne rappelle pas le critère
    tab.dispose();
  });

  it("échec d'écriture : message d'échec visible et trace, la puce reste", async () => {
    file = { savedCriteria: [crit("a")] };
    const { tab, h } = await mountReady();
    saveFails = new Error("lecture seule");
    await clickClose(h.host, "a");
    expect(message(h.host)).toBe("Impossible de supprimer le critère (voir le journal dans les paramètres)");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), saveFails);
    expect(chips(h.host).map((c) => c.textContent)).toEqual(["a"]);
    tab.dispose();
  });

  it("échec d'écriture terminé APRÈS la fermeture de l'onglet : notification globale (toast) et trace, rien dans l'onglet", async () => {
    file = { savedCriteria: [crit("a")] };
    const toast = vi.fn();
    const { tab, h } = await mountReady({ toast });
    saveFails = new Error("lecture seule");
    closeOf(h.host, "a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    tab.dispose();
    await flush();
    expect(toast).toHaveBeenCalledWith("Impossible de supprimer le critère (voir le journal dans les paramètres)");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), saveFails);
  });

  it("supprimer la puce courante réinitialise la recherche (champ vidé)", async () => {
    file = { savedCriteria: [crit("c")] };
    const { tab, h } = await mountReady();
    await recall(h.host, "c");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(isCurrent(h.host, "c")).toBe(true);
    await clickClose(h.host, "c");
    expect(input(h.host).value).toBe("");
    expect(chips(h.host)).toHaveLength(0);
    tab.dispose();
  });
});

describe("réinitialiser", () => {
  it("vide la requête, remet tri et regroupement par défaut (mémorisés), la puce n'est plus courante", async () => {
    file = { savedCriteria: [crit("c", { sort: { key: "modified", direction: "desc" }, groupByDocument: false })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "c");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(store.get().groupByDocument).toBe(false);
    resetButton(h.host).click();
    await flush();
    expect(input(h.host).value).toBe("");
    expect(store.get().groupByDocument).toBe(true);
    expect(store.get().sort).toEqual({ key: "relevance", direction: "desc" });
    expect(isCurrent(h.host, "c")).toBe(false);
    expect(button(h.host, "Filtres")).not.toBeNull(); // plus aucun filtre actif
    tab.dispose();
  });

  it("le chemin courant est conservé (résolu à nouveau), les autres filtres sont retirés", async () => {
    file = { savedCriteria: [crit("d", { filters: { ...NO_FILTERS, nameContains: "alpha", scopes: [DOC_SCOPE] } })] };
    const { tab, h } = await mountReady();
    await recall(h.host, "d");
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(button(h.host, "Filtres (2 actifs)")).not.toBeNull(); // nom + chemin
    resetButton(h.host).click();
    await flush();
    expect(button(h.host, "Filtres (1 actif)")).not.toBeNull(); // le chemin reste le seul filtre
    expect(pathLabel(h.host).hidden).toBe(false);
    expect(pathLabel(h.host).textContent).toBe("Cahier A / Parent");
    expect(input(h.host).value).toBe("");
    tab.dispose();
  });
});

describe("critères d'un autre onglet ou fenêtre", () => {
  it("la ligne relit la liste partagée à chaque resynchronisation (saisie dans le champ)", async () => {
    const { tab, h } = await mountReady();
    await store.saveCriteria(crit("venu-d-ailleurs"));
    input(h.host).value = "x";
    input(h.host).dispatchEvent(new Event("input", { bubbles: true }));
    expect(chips(h.host).map((c) => c.textContent)).toEqual(["venu-d-ailleurs"]);
    tab.dispose();
  });
});
