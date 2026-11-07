// @vitest-environment jsdom
// Portée de documents SiYuan dans l'assemblage de l'onglet : résolution asynchrone (génération, cache), messages d'erreur,
// rafraîchissement à la soumission, restauration de session. Le noyau est simulé ; rien n'est ignoré en silence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeTooLargeError, SCOPE_SQL_LIMIT } from "../../src/search/docScope";
import { NO_FILTERS, type SearchOptions } from "../../src/search/resultOptions";
import { mountSearchTab, type SearchTabDeps } from "../../src/searchTab";
import { IndexUnavailableError, type SqlResult } from "../../src/siyuan/kernelApi";
import { createNativeFakes } from "./ui/nativeFakes";
import { PDF_A, button, cards, flush, harness as baseHarness, sharedInstances, submitQuery } from "./helpers/searchTabHarness";

const NB = "20240101000000-aaaaaaa";
const DOC1 = "20240102000000-0000001";
const DOC2 = "20240102000000-0000002";
const PDF_OTHER = "assets/Autre-20240101120000-zzz9999.pdf";
const NBSP2 = "  ";

let fakes = createNativeFakes();
interface Pending {
  readonly stmt: string;
  readonly signal: AbortSignal | undefined;
  resolve(paths: string[]): void;
  reject(error: unknown): void;
}
let sqlCalls: string[];
let pending: Pending[];
/** Réponse du noyau aux requêtes d'assets : `auto` répond tout de suite, sinon les requêtes restent en attente. */
let assets: { mode: "auto"; paths: string[] } | { mode: "manual" } | { mode: "fail"; error: unknown };

const ok = (rows: Record<string, unknown>[]): SqlResult => ({ rows, truncated: false });
const kernel = () => ({
  lsNotebooks: vi.fn(async () => [{ id: NB, name: "Cahier A", closed: false, icon: "" }]),
  listDocsByPath: vi.fn(async (_box: string, path: string) =>
    path === "/"
      ? [{ path: `/${DOC1}.sy`, name: "Parent", icon: "", subFileCount: 1 }]
      : path === `/${DOC1}.sy`
        ? [{ path: `/${DOC1}/${DOC2}.sy`, name: "Enfant", icon: "", subFileCount: 0 }]
        : [],
  ),
  searchDocs: vi.fn(async () => []),
  getHPathsByPaths: vi.fn(async (paths: readonly string[]) =>
    paths.map((p) => (p === `/${DOC1}.sy` ? "Cahier A/Parent" : "Cahier A/Parent/Enfant")),
  ),
  sql: vi.fn((stmt: string, signal?: AbortSignal): Promise<SqlResult> => {
    sqlCalls.push(stmt);
    if (stmt.includes("from blocks")) {
      return Promise.resolve(
        ok([
          { id: DOC1, box: NB, path: `/${DOC1}.sy`, hpath: "/Parent" },
          { id: DOC2, box: NB, path: `/${DOC1}/${DOC2}.sy`, hpath: "/Parent/Enfant" },
        ]),
      );
    }
    if (assets.mode === "fail") return Promise.reject(assets.error);
    if (assets.mode === "auto") return Promise.resolve(ok(assets.paths.map((path) => ({ path }))));
    return new Promise<SqlResult>((resolve, reject) => {
      pending.push({ stmt, signal, resolve: (paths) => resolve(ok(paths.map((path) => ({ path })))), reject });
    });
  }),
});

const harness = (over: Partial<SearchTabDeps> = {}) => baseHarness({ kernel: kernel(), ...over }, fakes);
const opts = (over: Partial<SearchOptions["filters"]> = {}): SearchOptions => ({ sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, ...over } });
const DOC_SCOPE = { kind: "document", box: NB, docPath: `/${DOC1}.sy`, label: "Cahier A/Parent" } as const;
const message = (host: HTMLElement): string => host.querySelector(".docseeker-message")!.textContent ?? "";
const pathLabel = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>("span.search__path")!;

/** Parcourt le vrai dialogue « Spécifier le chemin » (faux Dialog, vrai contenu) et confirme ; `which` : ligne à choisir. */
async function choosePath(host: HTMLElement, which: "notebook" | "parent" | "child"): Promise<void> {
  button(host, "Spécifier le chemin")!.click();
  await flush();
  const body = fakes.lastCustomDialog().container;
  const row = (path: string): HTMLElement => body.querySelector<HTMLElement>(`li.b3-list-item[data-path="${path}"]`)!;
  if (which !== "notebook") {
    row("/").querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
  }
  if (which === "child") {
    row(`/${DOC1}.sy`).querySelector<HTMLElement>(".b3-list-item__toggle")!.click();
    await flush();
  }
  const target = which === "notebook" ? "/" : which === "parent" ? `/${DOC1}.sy` : `/${DOC1}/${DOC2}.sy`;
  row(target).querySelector<HTMLElement>(".b3-list-item__text")!.click();
  body.querySelector<HTMLElement>(".b3-button--text")!.click();
  await flush();
}
/** La croix de l'étiquette retire le chemin. */
async function clearPath(host: HTMLElement): Promise<void> {
  pathLabel(host).querySelector<SVGElement>("svg.search__rmpath")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
}
beforeEach(() => {
  fakes = createNativeFakes();
  sqlCalls = [];
  pending = [];
  assets = { mode: "auto", paths: [PDF_A] };
  vi.useFakeTimers();
});
afterEach(() => {
  for (const shared of sharedInstances.splice(0)) shared.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("bouton du chemin : dialogue natif", () => {
  it("avec le noyau : le bouton « Spécifier le chemin » ouvre le dialogue et lit les cahiers ; aucun menu", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    button(h.host, "Spécifier le chemin")!.click();
    await flush();
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(fakes.lastCustomDialog().options.title).toBe("Spécifier le chemin");
    expect(fakes.lastCustomDialog().container.querySelector('li[data-path="/"] .b3-list-item__text')!.textContent).toBe("Cahier A");
    tab.dispose();
  });

  it("sans noyau : ni « Spécifier le chemin » ni « Inclure les documents enfants »", async () => {
    const h = baseHarness({}, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(button(h.host, "Spécifier le chemin")).toBeNull();
    expect(button(h.host, "Inclure les documents enfants")).toBeNull();
    tab.dispose();
  });
});

describe("choix d'une portée", () => {
  it("pendant la résolution : « Chargement du chemin… » et l'étiquette est visible ; ensuite le message disparaît", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(message(h.host)).toBe("Chargement du chemin…");
    expect(pathLabel(h.host).hidden).toBe(false);
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent");
    pending[0]!.resolve([PDF_A]);
    await flush();
    expect(message(h.host)).toBe("");
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent");
    tab.dispose();
  });

  it("les résultats sont filtrés par les PDF cités (document cité : visible)", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    await choosePath(h.host, "parent");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("les résultats sont filtrés par les PDF cités (aucun PDF cité : plus de carte, filtre visible)", async () => {
    assets = { mode: "auto", paths: [PDF_OTHER] };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    await choosePath(h.host, "parent");
    expect(cards(h.host)).toHaveLength(0);
    expect(pathLabel(h.host).hidden).toBe(false);
    tab.dispose();
  });

  it("une portée déjà en cache (30 s) s'applique sans nouvelle requête", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(sqlCalls.filter((s) => s.includes("from assets"))).toHaveLength(1);
    await choosePath(h.host, "notebook"); // autre portée
    await choosePath(h.host, "parent"); // retour : cache
    expect(sqlCalls.filter((s) => s.includes("from assets"))).toHaveLength(2);
    tab.dispose();
  });

  it("sous-documents inclus par défaut ; le bouton « Inclure » les exclut (nouvelle résolution)", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    const first = sqlCalls.filter((s) => s.includes("from assets")).at(-1)!;
    expect(first).toContain("docpath like");
    button(h.host, "Inclure les documents enfants")!.click();
    await flush();
    const second = sqlCalls.filter((s) => s.includes("from assets")).at(-1)!;
    expect(second).not.toContain("docpath like");
    tab.dispose();
  });

  it("un choix périmé est ignoré : la résolution tardive n'applique rien (jeton de génération)", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await submitQuery(h.host, "chat");
    await choosePath(h.host, "parent"); // en attente
    const stale = pending[0]!;
    // Le choix est remplacé avant la fin : « Tous les chemins ».
    await clearPath(h.host);
    await flush();
    expect(stale.signal?.aborted).toBe(true);
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(message(h.host)).toBe("");
    stale.resolve([PDF_OTHER]);
    await flush();
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(cards(h.host).length).toBeGreaterThan(0); // aucun filtre fantôme
    tab.dispose();
  });

  it("deux choix successifs : seul le dernier s'applique, même si le premier répond en dernier", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await choosePath(h.host, "child");
    expect(pending).toHaveLength(2);
    pending[1]!.resolve([PDF_A]);
    await flush();
    pending[0]!.resolve([PDF_OTHER]);
    await flush();
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent/Enfant");
    expect(message(h.host)).toBe("");
    tab.dispose();
  });

  it("dispose pendant la résolution : requête annulée, aucun rejet non géré", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    tab.dispose();
    await flush();
    expect(pending[0]!.signal?.aborted).toBe(true);
    pending[0]!.reject(pending[0]!.signal?.reason);
    await flush();
  });
});

describe("échecs de résolution : message clair, trace, jamais de filtre ignoré en silence", () => {
  it("index SiYuan pas prêt : message « réessayez », le filtre n'est pas gardé, trace", async () => {
    const error = new IndexUnavailableError(200, -1, "document metadata is not ready");
    assets = { mode: "fail", error };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(message(h.host)).toBe(
      "L'index de SiYuan n'est pas prêt : le filtre par document n'a pas pu être appliqué. Réessayez dans un instant.",
    );
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), error);
    // Réessayer : nouveau choix, qui réussit.
    assets = { mode: "auto", paths: [PDF_A] };
    await choosePath(h.host, "parent");
    expect(message(h.host)).toBe("");
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent");
    tab.dispose();
  });

  it("portée trop grande : message explicite", async () => {
    assets = { mode: "fail", error: new ScopeTooLargeError(SCOPE_SQL_LIMIT) };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "notebook");
    expect(message(h.host)).toBe(
      "Ce chemin cite trop de PDF pour être filtré (plus de 50 000 références). Choisissez un chemin plus précis.",
    );
    expect(pathLabel(h.host).hidden).toBe(true);
    tab.dispose();
  });

  it("autre erreur : message générique avec le détail, et trace", async () => {
    const error = new Error("réseau coupé");
    assets = { mode: "fail", error };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(message(h.host)).toBe("Le filtre par document n'a pas pu être appliqué (détails dans le journal). (réseau coupé)");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), error);
    tab.dispose();
  });

  it("l'échec retire la portée demandée (jamais appliquée) et garde le tri et les autres filtres demandés", async () => {
    assets = { mode: "fail", error: new Error("x") };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "x" }));
    expect(message(h.host)).toContain("Le filtre par document n'a pas pu être appliqué");
    tab.dispose();
  });
});

describe("soumission : rafraîchissement du cache périmé", () => {
  it("après 30 s, la soumission relit les documents cités et applique le nouvel ensemble", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await submitQuery(h.host, "chat");
    expect(cards(h.host).length).toBeGreaterThan(0);
    const before = sqlCalls.filter((s) => s.includes("from assets")).length;
    assets = { mode: "auto", paths: [PDF_OTHER] };
    await vi.advanceTimersByTimeAsync(31_000);
    await submitQuery(h.host, "chat");
    expect(sqlCalls.filter((s) => s.includes("from assets")).length).toBe(before + 1);
    expect(cards(h.host)).toHaveLength(0); // le PDF n'est plus cité
    tab.dispose();
  });

  it("cache valide : la soumission ne relit rien", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    const before = sqlCalls.filter((s) => s.includes("from assets")).length;
    await submitQuery(h.host, "chat");
    expect(sqlCalls.filter((s) => s.includes("from assets")).length).toBe(before);
    tab.dispose();
  });

  it("si le rafraîchissement échoue : l'ancien ensemble reste utilisé, message explicite et trace", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await vi.advanceTimersByTimeAsync(31_000);
    const error = new Error("noyau indisponible");
    assets = { mode: "fail", error };
    await submitQuery(h.host, "chat");
    expect(message(h.host)).toBe("Les documents n'ont pas pu être relus : les résultats utilisent la liste précédente.");
    expect(cards(h.host).length).toBeGreaterThan(0); // ancien ensemble (PDF_A)
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), error);
    expect(pathLabel(h.host).hidden).toBe(false);
    tab.dispose();
  });

  it("un rafraîchissement terminé après un changement de portée est ignoré", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await vi.advanceTimersByTimeAsync(31_000);
    assets = { mode: "manual" };
    await submitQuery(h.host, "chat"); // rafraîchissement en attente
    const refresh = pending.at(-1)!;
    assets = { mode: "auto", paths: [PDF_A] };
    await clearPath(h.host);
    await flush();
    refresh.reject(new Error("tardif"));
    await flush();
    expect(message(h.host)).toBe("");
    tab.dispose();
  });
});

describe("restauration de session avec une portée", () => {
  const session = (query: string) => ({ initial: { query, options: opts({ scopes: [DOC_SCOPE] }) }, save: vi.fn() });

  it("repasse par la résolution : tant qu'elle dure, « Chargement du chemin… » et AUCUN résultat non filtré", async () => {
    assets = { mode: "manual" };
    const h = harness({ session: session("chat") });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("Chargement du chemin…");
    expect(cards(h.host)).toHaveLength(0);
    pending[0]!.resolve([PDF_A]);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("");
    expect(cards(h.host).length).toBeGreaterThan(0);
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent");
    tab.dispose();
  });

  it("portée résolue vide de PDF : requête restaurée, aucun résultat, filtre visible", async () => {
    assets = { mode: "auto", paths: [PDF_OTHER] };
    const h = harness({ session: session("chat") });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(cards(h.host)).toHaveLength(0);
    expect(pathLabel(h.host).hidden).toBe(false);
    tab.dispose();
  });

  it("échec de résolution : la portée est retirée avec un message et une trace, la requête est quand même restaurée", async () => {
    const error = new IndexUnavailableError(200, -1, "document metadata is not ready");
    assets = { mode: "fail", error };
    const h = harness({ session: session("chat") });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(message(h.host)).toContain("L'index de SiYuan n'est pas prêt");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), error);
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("sans kernel : la portée restaurée est retirée avec un message et une trace (jamais appliquée à vide)", async () => {
    const h = baseHarness({ session: session("") }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(message(h.host)).toContain("n'a pas pu être appliqué");
    expect(h.onWarn).toHaveBeenCalled();
    tab.dispose();
  });

  it("la session mémorise la portée une fois appliquée", async () => {
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    expect(save.mock.calls.at(-1)![0].options.filters.scopes?.[0]).toMatchObject({ kind: "document", label: "Cahier A/Parent" });
    tab.dispose();
  });
});

describe("plusieurs portées (liste)", () => {
  const NB_SCOPE = { kind: "notebook", box: NB, label: "Cahier A" } as const;

  it("session à deux portées : restaurées et résolues ENSEMBLE par une seule requête, étiquette jointe par un espace", async () => {
    assets = { mode: "manual" };
    const h = harness({ session: { initial: { query: "chat", options: opts({ scopes: [NB_SCOPE, DOC_SCOPE] }) }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.stmt).toContain(`(box = '${NB}') or (box = '${NB}' and (docpath = '/${DOC1}.sy'`);
    pending[0]!.resolve([PDF_A]);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(sqlCalls.filter((q) => q.includes("from assets"))).toHaveLength(1);
    expect(pathLabel(h.host).textContent).toBe("Cahier A Cahier A/Parent");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("ancien format de session (`scope` singulier) : lu comme une liste d'un élément et résolu", async () => {
    assets = { mode: "auto", paths: [PDF_A] };
    const legacy = { sort: { key: "name", direction: "asc" }, filters: { ...NO_FILTERS, scope: DOC_SCOPE } } as unknown as SearchOptions;
    const h = harness({ session: { initial: { query: "chat", options: legacy }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(pathLabel(h.host).textContent).toBe("Cahier A/Parent");
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("une portée invalide dans la liste : toute la liste est écartée avec message et trace, aucun SQL", async () => {
    const bad = { kind: "notebook", box: "x' or '1'='1", label: "L" };
    const forged = opts({ scopes: [DOC_SCOPE, bad] as never });
    const h = harness({ session: { initial: { query: "chat", options: forged }, save: vi.fn() } });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("Le chemin enregistré n'est pas valide : la recherche s'est lancée sans lui.");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Portée"), expect.anything());
    expect(sqlCalls.filter((q) => q.includes("from assets"))).toHaveLength(0);
    expect(pathLabel(h.host).hidden).toBe(true);
    tab.dispose();
  });
});

describe("correctifs de revue : portée invalide, soumission pendant la résolution, demande dépassée", () => {
  const SESSION_KEEP = (query: string, options: SearchOptions) => ({ initial: { query, options }, save: vi.fn() });
  const sortTo = (host: HTMLElement, label: string): void => {
    host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Plus"]')!.click();
    fakes.lastMenu().items.find((i) => i.label === "Tri")!.submenu!.find((i) => i.label === label)!.click!();
  };

  it("A : une portée invalide en session (kind inconnu) est retirée AVEC un message et une trace, sans requête au noyau", async () => {
    const forged = opts({ scopes: [{ kind: "x", box: NB, label: "L" }] as never });
    const h = harness({ session: SESSION_KEEP("chat", forged) });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("Le chemin enregistré n'est pas valide : la recherche s'est lancée sans lui.");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Portée"), forged.filters.scopes);
    expect(sqlCalls.filter((s) => s.includes("from assets"))).toHaveLength(0);
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(cards(h.host).length).toBeGreaterThan(0); // requête quand même restaurée
    tab.dispose();
  });

  it.each([
    ["box vide", { kind: "notebook", box: "", label: "L" }],
    ["box injectée", { kind: "notebook", box: "x' or '1'='1", label: "L" }],
    ["document sans docPath", { kind: "document", box: NB, label: "L" }],
    ["libellé absent", { kind: "notebook", box: NB }],
  ])("A bis : portée de session corrompue (%s) : écartée avec message et trace, la requête repart, aucun SQL", async (_n, bad) => {
    const forged = opts({ scopes: [bad] as never });
    const h = harness({ session: SESSION_KEEP("chat", forged) });
    const tab = mountSearchTab(h.host, h.deps);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(message(h.host)).toBe("Le chemin enregistré n'est pas valide : la recherche s'est lancée sans lui.");
    expect(h.onWarn).toHaveBeenCalledWith(expect.stringContaining("Portée"), [bad]);
    expect(sqlCalls.filter((s) => s.includes("from assets"))).toHaveLength(0);
    expect(pathLabel(h.host).hidden).toBe(true);
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("B : une soumission pendant la résolution est différée, puis relancée avec la portée appliquée", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await submitQuery(h.host, "chat");
    expect(cards(h.host)).toHaveLength(0); // pas de résultats hors portée
    expect(message(h.host)).toBe("Chargement du chemin…");
    pending[0]!.resolve([PDF_OTHER]); // le PDF trouvé n'est pas cité
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(cards(h.host)).toHaveLength(0);
    expect(message(h.host)).toBe("");
    tab.dispose();
  });

  it("B : la soumission différée affiche ses résultats si le PDF est cité", async () => {
    assets = { mode: "manual" };
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await submitQuery(h.host, "chat");
    pending[0]!.resolve([PDF_A]);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("B : la soumission pendant la résolution ne relance pas de relecture de l'ancienne portée et n'écrase pas « Chargement »", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await vi.advanceTimersByTimeAsync(31_000); // cache périmé
    assets = { mode: "manual" };
    await choosePath(h.host, "child"); // nouvelle portée en attente (pending[0])
    await submitQuery(h.host, "chat");
    expect(pending).toHaveLength(1);
    pending[0]!.reject(new Error("noyau")); // l'échec ne doit pas laisser « relues » à la place de l'erreur de la portée choisie
    await flush();
    expect(message(h.host)).not.toBe("Les documents n'ont pas pu être relus : les résultats utilisent la liste précédente.");
    tab.dispose();
  });

  it("D : tant que le rafraîchissement échoue, chaque soumission ré-affiche le message et trace", async () => {
    const h = harness();
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent");
    await vi.advanceTimersByTimeAsync(31_000);
    assets = { mode: "fail", error: new Error("noyau indisponible") };
    await submitQuery(h.host, "chat");
    expect(message(h.host)).toContain("n'ont pas pu être relus");
    h.host.querySelector<HTMLElement>(".docseeker-message")!.textContent = "";
    await submitQuery(h.host, "chat");
    expect(message(h.host)).toContain("n'ont pas pu être relus");
    expect(h.onWarn.mock.calls.filter((c) => String(c[0]).includes("non relus"))).toHaveLength(2);
    tab.dispose();
  });

  it("E : une restauration de session dépassée par un choix de l'utilisateur relance quand même la requête", async () => {
    assets = { mode: "manual" };
    const h = harness({ session: SESSION_KEEP("chat", opts({ scopes: [DOC_SCOPE] })) });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(cards(h.host)).toHaveLength(0);
    await clearPath(h.host);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(cards(h.host).length).toBeGreaterThan(0);
    tab.dispose();
  });

  it("F : un échec de résolution garde le tri demandé en même temps (seule la portée est retirée)", async () => {
    assets = { mode: "manual" };
    const save = vi.fn();
    const h = harness({ session: { initial: undefined, save } });
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    await choosePath(h.host, "parent"); // en attente
    sortTo(h.host, "Nom décroissant"); // nouvelle demande : tri + portée en attente
    expect(pending).toHaveLength(1); // même clé : la requête en vol est partagée
    pending[0]!.reject(new Error("noyau"));
    await flush();
    const last = save.mock.calls.at(-1)![0].options;
    expect(last.sort).toEqual({ key: "name", direction: "desc" });
    expect(last.filters.scopes).toBeUndefined();
    tab.dispose();
  });

  it("L : l'absence de noyau passe par le système de libellés", async () => {
    const t = (key: string): string => (key === "kernelUnavailable" ? "LIBELLE-NOYAU" : key);
    const h = baseHarness({ session: { initial: { query: "", options: opts({ scopes: [DOC_SCOPE] }) }, save: vi.fn() }, t }, fakes);
    const tab = mountSearchTab(h.host, h.deps);
    await flush();
    expect(message(h.host)).toContain("LIBELLE-NOYAU");
    expect(h.onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "LIBELLE-NOYAU" }));
    tab.dispose();
  });
});
