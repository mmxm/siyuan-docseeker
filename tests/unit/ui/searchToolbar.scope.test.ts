// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import { DocTreeTooLargeError, type DocTree, type DocTreeNode } from "../../../src/search/docTree";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { IndexUnavailableError } from "../../../src/siyuan/kernelApi";
import { mountSearchToolbar, type SearchToolbar, type SearchToolbarDeps } from "../../../src/ui/searchToolbar";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";
import { createNativeFakes, findItem, pick } from "./nativeFakes";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

const NB = "20240101000000-aaaaaaa";
const NB2 = "20240101000000-bbbbbbb";
const id = (n: number): string => `20240102000000-${n.toString(36).padStart(7, "0")}`;
const NBSP2 = "  ";
const PATH = "Spécifier le chemin";
const INCLUDE = "Inclure les documents enfants";
const REMOVE = "Supprimer";
const nb = (box: string, label: string): DocTreeNode => ({ kind: "notebook", box, hpath: "", label, depth: 0 });
const doc = (box: string, ids: string[], hpath: string): DocTreeNode => {
  const segments = hpath.split("/").filter(Boolean);
  return { kind: "document", box, docPath: `/${ids.join("/")}.sy`, hpath, label: segments.at(-1) ?? "", depth: segments.length };
};
const TREE: DocTree = [nb(NB, "Cahier A"), doc(NB, [id(1)], "/Parent"), doc(NB, [id(1), id(2)], "/Parent/Enfant"), nb(NB2, "Cahier B")];
const DOC_SCOPE: DocumentScope = { kind: "document", box: NB, docPath: `/${id(1)}/${id(2)}.sy`, label: "Cahier A / Parent / Enfant" };
const NB_SCOPE: DocumentScope = { kind: "notebook", box: NB2, label: "Cahier B" };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let host: HTMLElement;
let state: SearchOptions;
let setOptions: ReturnType<typeof vi.fn>;
let fakes: ReturnType<typeof createNativeFakes>;
let toolbar: SearchToolbar;
let getDocTree: ReturnType<typeof vi.fn>;
let onWarn: ReturnType<typeof vi.fn>;
let folders: string[];

function mount(over: Partial<SearchToolbarDeps> = {}, withTree = true): SearchToolbar {
  return mountSearchToolbar(host, {
    getOptions: () => state,
    setOptions: setOptions as (o: SearchOptions) => void,
    getFolders: () => folders,
    ...(withTree ? { getDocTree: getDocTree as unknown as NonNullable<SearchToolbarDeps["getDocTree"]> } : {}),
    onWarn: onWarn as unknown as NonNullable<SearchToolbarDeps["onWarn"]>,
    t,
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    getGroupByDocument: () => true,
    setGroupByDocument: () => undefined,
    expansion: { canExpand: () => false, canCollapse: () => false, expandAll: () => undefined, collapseAll: () => undefined },
    ...over,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  state = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  folders = ["assets/", "assets/a/"];
  setOptions = vi.fn((o: SearchOptions) => {
    state = o;
  });
  getDocTree = vi.fn(async () => TREE);
  onWarn = vi.fn();
  fakes = createNativeFakes();
  toolbar = mount();
});

const row = () => host.querySelector<HTMLElement>("div.block__icons.docseeker-icons")!;
const btn = (name: string): HTMLButtonElement => row().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const pathBtn = () => row().querySelector<HTMLButtonElement>("button[data-menu='true']")!;
const label = () => row().querySelector<HTMLElement>("span.search__path")!;
const lastFilters = () => (setOptions.mock.calls.at(-1)![0] as SearchOptions).filters;
const withScope = (scope: DocumentScope, extra: Partial<SearchOptions["filters"]> = {}): void => {
  state = { ...state, filters: { ...NO_FILTERS, scope, ...extra } };
  toolbar.refresh();
};
const openPath = async () => {
  pathBtn().click();
  await flush();
  return fakes.lastMenu();
};
const labels = (m: { items: readonly { label?: string; separator?: boolean }[] }) => m.items.map((i) => (i.separator ? "---" : i.label));

describe("menu « Spécifier le chemin » avec l'arbre des documents", () => {
  it("ordre : Tous les chemins, séparateur, Dossiers de fichiers, dossiers, séparateur, Documents SiYuan, cahiers et documents", async () => {
    const menu = await openPath();
    expect(labels(menu)).toEqual([
      "Tous les chemins",
      "---",
      "Dossiers de fichiers",
      "assets",
      `${NBSP2}a`,
      "---",
      "Documents SiYuan",
      "Cahier A",
      `${NBSP2}Parent`,
      `${NBSP2}${NBSP2}Enfant`,
      "Cahier B",
    ]);
    const byLabel = (l: string) => menu.items.find((i) => i.label === l)!;
    expect(byLabel("Dossiers de fichiers").disabled).toBe(true);
    expect(byLabel("Documents SiYuan").disabled).toBe(true);
    expect(byLabel("Dossiers de fichiers").click).toBeUndefined();
    expect(menu.items.filter((i) => i.separator)).toHaveLength(2);
  });

  it("sans aucun filtre de chemin : « Tous les chemins » est la seule entrée courante", async () => {
    const menu = await openPath();
    expect(menu.items.filter((i) => i.current).map((i) => i.label)).toEqual(["Tous les chemins"]);
  });

  it("un document choisi : seule son entrée est courante (ni « Tous les chemins », ni un dossier)", async () => {
    withScope(DOC_SCOPE);
    const menu = await openPath();
    expect(menu.items.filter((i) => i.current).map((i) => i.label)).toEqual([`${NBSP2}${NBSP2}Enfant`]);
  });

  it("un dossier choisi : seule son entrée est courante, aucune dans l'arbre", async () => {
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/" } };
    const menu = await openPath();
    expect(menu.items.filter((i) => i.current).map((i) => i.label)).toEqual([`${NBSP2}a`]);
  });

  it("sans dossier de fichiers, la section des dossiers est omise (pas d'en-tête orphelin)", async () => {
    folders = [];
    const menu = await openPath();
    expect(labels(menu)).toEqual(["Tous les chemins", "---", "Documents SiYuan", "Cahier A", `${NBSP2}Parent`, `${NBSP2}${NBSP2}Enfant`, "Cahier B"]);
  });

  it("sans getDocTree : le menu reste celui des dossiers, sans en-têtes, ouvert tout de suite", () => {
    host.innerHTML = "";
    toolbar = mount({}, false);
    pathBtn().click();
    expect(labels(fakes.lastMenu())).toEqual(["Tous les chemins", "assets", `${NBSP2}a`]);
  });

  it("choisir un document : dossier vidé, portée posée, tri et autres filtres conservés (une seule application)", async () => {
    state = { ...state, filters: { ...NO_FILTERS, folder: "assets/a/", nameContains: "abc", includeSubfolders: false } };
    const menu = await openPath();
    pick(menu, `${NBSP2}${NBSP2}Enfant`);
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions.mock.calls[0]![0]).toEqual({
      sort: { key: "name", direction: "asc" },
      filters: { folder: "", includeSubfolders: false, nameContains: "abc", scope: DOC_SCOPE },
    });
  });

  it("choisir un cahier : portée « notebook »", async () => {
    const menu = await openPath();
    pick(menu, "Cahier B");
    expect(lastFilters().scope).toEqual(NB_SCOPE);
  });

  it("choisir un dossier alors qu'une portée est active : la portée est retirée (clé absente)", async () => {
    withScope(DOC_SCOPE);
    const menu = await openPath();
    pick(menu, "assets");
    expect(lastFilters()).toEqual({ ...NO_FILTERS, folder: "assets/" });
    expect("scope" in lastFilters()).toBe(false);
  });

  it("« Tous les chemins » retire la portée comme le dossier", async () => {
    withScope(DOC_SCOPE);
    pick(await openPath(), "Tous les chemins");
    expect(lastFilters()).toEqual(NO_FILTERS);
    expect("scope" in lastFilters()).toBe(false);
  });

  it("choisir l'entrée déjà courante ne fait rien", async () => {
    withScope(DOC_SCOPE);
    pick(await openPath(), `${NBSP2}${NBSP2}Enfant`);
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("600 documents : au plus 500 entrées d'arbre et une ligne désactivée pour le reste", async () => {
    getDocTree.mockResolvedValue([nb(NB, "C"), ...Array.from({ length: 599 }, (_, i) => doc(NB, [id(i + 10)], `/D${i}`))]);
    const menu = await openPath();
    const after = menu.items.slice(menu.items.findIndex((i) => i.label === "Documents SiYuan") + 1);
    expect(after).toHaveLength(501);
    expect(after.at(-1)).toEqual({ label: "… 100 autres documents masqués", disabled: true });
  });

  it("un titre de document contenant du HTML reste du texte (libellé brut, jamais interprété)", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    getDocTree.mockResolvedValue([nb(NB, evil), doc(NB, [id(1)], `/${evil}`)]);
    const menu = await openPath();
    expect(menu.items.map((i) => i.label)).toContain(evil);
    pick(menu, `${NBSP2}${evil}`);
    expect(lastFilters().scope?.label).toBe(`${evil} / ${evil}`);
    expect(label().textContent).toBe(`${evil} / ${evil}`);
    expect(host.querySelector("img")).toBeNull();
  });
});

describe("chargement de l'arbre avant l'ouverture", () => {
  it("le menu s'ouvre à la fin du chargement ; pendant ce temps le bouton est occupé et le dit", async () => {
    const d = deferred<DocTree>();
    getDocTree.mockReturnValue(d.promise);
    pathBtn().focus();
    pathBtn().click();
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(pathBtn().getAttribute("aria-busy")).toBe("true");
    expect(pathBtn().getAttribute("aria-label")).toBe("Chargement des documents…");
    d.resolve(TREE);
    await flush();
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
    expect(pathBtn().hasAttribute("aria-busy")).toBe(false);
    expect(pathBtn().getAttribute("aria-label")).toBe(PATH);
    expect(document.activeElement).toBe(pathBtn());
  });

  it("le clic porte data-menu et n'atteint pas document, comme les autres boutons à menu", () => {
    const reached = vi.fn();
    document.addEventListener("click", reached);
    try {
      pathBtn().click();
    } finally {
      document.removeEventListener("click", reached);
    }
    expect(reached).not.toHaveBeenCalled();
    expect(pathBtn().getAttribute("data-menu")).toBe("true");
  });

  it("getDocTree reçoit un signal ; un second clic pendant le chargement l'annule sans ouvrir de menu", async () => {
    const d = deferred<DocTree>();
    getDocTree.mockReturnValue(d.promise);
    pathBtn().click();
    const signal = getDocTree.mock.calls[0]![0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    pathBtn().click();
    expect(signal.aborted).toBe(true);
    expect(pathBtn().hasAttribute("aria-busy")).toBe(false);
    d.resolve(TREE);
    await flush();
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(getDocTree).toHaveBeenCalledTimes(1);
  });

  it("ouvrir un autre menu pendant le chargement annule l'ouverture tardive du menu du chemin", async () => {
    const d = deferred<DocTree>();
    getDocTree.mockReturnValue(d.promise);
    pathBtn().click();
    btn("Plus").click();
    d.resolve(TREE);
    await flush();
    expect(fakes.menus.map((m) => m.id)).toEqual(["docseeker-more"]);
    expect(pathBtn().hasAttribute("aria-busy")).toBe(false);
  });

  it("dispose pendant le chargement : rien ne s'ouvre, le chargement est annulé", async () => {
    const d = deferred<DocTree>();
    getDocTree.mockReturnValue(d.promise);
    pathBtn().click();
    const signal = getDocTree.mock.calls[0]![0] as AbortSignal;
    toolbar.dispose();
    expect(signal.aborted).toBe(true);
    d.resolve(TREE);
    await flush();
    expect(fakes.openMenu).not.toHaveBeenCalled();
  });

  it("un clic quand le menu du chemin est déjà ouvert le ferme (bascule) sans recharger l'arbre", async () => {
    const menu = await openPath();
    pathBtn().click();
    await flush();
    expect(menu.closed).toBe(true);
    expect(getDocTree).toHaveBeenCalledTimes(1);
    expect(fakes.openMenu).toHaveBeenCalledTimes(1);
  });

  it("l'arbre est relu à chaque ouverture", async () => {
    pick(await openPath(), "Tous les chemins");
    getDocTree.mockResolvedValue([nb(NB, "Neuf")]);
    const menu = await openPath();
    expect(menu.items.at(-1)?.label).toBe("Neuf");
  });
});

describe("erreurs de chargement de l'arbre", () => {
  it("index SiYuan pas prêt : entrée désactivée explicative + « Réessayer » active, dossiers toujours là", async () => {
    getDocTree.mockRejectedValue(new IndexUnavailableError(200, -1, "document metadata is not ready"));
    const menu = await openPath();
    expect(labels(menu)).toEqual([
      "Tous les chemins",
      "---",
      "Dossiers de fichiers",
      "assets",
      `${NBSP2}a`,
      "---",
      "Documents SiYuan",
      "L'index de SiYuan n'est pas prêt.",
      "Réessayer",
    ]);
    expect(findItem(menu.items, "L'index de SiYuan n'est pas prêt.").disabled).toBe(true);
    expect(findItem(menu.items, "L'index de SiYuan n'est pas prêt.").click).toBeUndefined();
    expect(typeof findItem(menu.items, "Réessayer").click).toBe("function");
    expect(findItem(menu.items, "Réessayer").disabled).toBeUndefined();
    expect(pathBtn().hasAttribute("aria-busy")).toBe(false);
  });

  it("« Réessayer » ferme le menu, rend le focus au bouton et rouvre un menu avec l'arbre relu", async () => {
    getDocTree.mockRejectedValueOnce(new IndexUnavailableError(200, -1, "document metadata is not ready"));
    const menu = await openPath();
    expect(menu.onClose).toBeTypeOf("function");
    btn("Plus").focus(); // le focus est ailleurs : la reprise doit le ramener
    pick(menu, "Réessayer");
    expect(document.activeElement).toBe(pathBtn());
    await flush();
    expect(getDocTree).toHaveBeenCalledTimes(2);
    expect(fakes.menus).toHaveLength(2);
    expect(fakes.lastMenu().items.map((i) => i.label)).toContain("Cahier A");
    expect(fakes.menus[0]!.closed).toBe(true);
  });

  it("fermer ce menu autrement (Échap) ne relance rien", async () => {
    getDocTree.mockRejectedValue(new IndexUnavailableError(200, -1, "document metadata is not ready"));
    const menu = await openPath();
    menu.close();
    await flush();
    expect(getDocTree).toHaveBeenCalledTimes(1);
  });

  it("arbre trop grand : entrée désactivée explicite, sans « Réessayer »", async () => {
    getDocTree.mockRejectedValue(new DocTreeTooLargeError(20000));
    const menu = await openPath();
    const last = menu.items.at(-1)!;
    expect(last.label).toBe(DEFAULT_STRINGS["docsTooLarge"]);
    expect(last.disabled).toBe(true);
    expect(menu.items.some((i) => i.label === "Réessayer")).toBe(false);
  });

  it("arbre vide : « Aucun document ne cite de PDF. » désactivée", async () => {
    getDocTree.mockResolvedValue([]);
    const menu = await openPath();
    expect(menu.items.at(-1)).toEqual({ label: "Aucun document ne cite de PDF.", disabled: true });
  });

  it("autre erreur : message générique + « Réessayer », et l'erreur est tracée (jamais avalée)", async () => {
    const boom = new Error("réseau coupé");
    getDocTree.mockRejectedValue(boom);
    const menu = await openPath();
    expect(menu.items.slice(-2).map((i) => i.label)).toEqual([DEFAULT_STRINGS["docsFailed"], "Réessayer"]);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![1]).toBe(boom);
  });

  it("les erreurs attendues (index pas prêt, arbre trop grand) sont affichées, pas journalisées en avertissement", async () => {
    getDocTree.mockRejectedValue(new DocTreeTooLargeError(20000));
    await openPath();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("une erreur levée par openMenu après le chargement est tracée, jamais un rejet non géré", async () => {
    const boom = new Error("menu refusé");
    fakes.openMenu.mockImplementationOnce(() => {
      throw boom;
    });
    pathBtn().click();
    await flush();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![1]).toBe(boom);
    expect(pathBtn().hasAttribute("aria-busy")).toBe(false);
  });

  it("getDocTree qui lève de façon synchrone est traité comme un échec de chargement", async () => {
    const boom = new Error("sync");
    getDocTree.mockImplementation(() => {
      throw boom;
    });
    const menu = await openPath();
    expect(menu.items.at(-1)?.label).toBe("Réessayer");
    expect(onWarn.mock.calls[0]![1]).toBe(boom);
  });
});

describe("étiquette, croix et bouton « Inclure les documents enfants » avec une portée", () => {
  it("un document : étiquette « Cahier / Document », infobulle « PDF exclus », croix visible", () => {
    withScope(DOC_SCOPE);
    expect(label().hidden).toBe(false);
    expect(label().textContent).toBe("Cahier A / Parent / Enfant");
    expect(label().title).toBe("Les PDF qu'aucun document ne cite sont exclus.");
    expect(btn(REMOVE).hidden).toBe(false);
  });

  it("un cahier : étiquette = nom du cahier, infobulle = son nom", () => {
    withScope(NB_SCOPE);
    expect(label().textContent).toBe("Cahier B");
    expect(label().title).toBe("Cahier B");
  });

  it("une étiquette avec des balises reste du texte", () => {
    withScope({ ...NB_SCOPE, label: "<img src=x onerror=alert(1)>" });
    expect(label().querySelector("img")).toBeNull();
    expect(label().textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("la croix retire la portée (clé absente), et le focus revient à « Spécifier le chemin »", () => {
    withScope(DOC_SCOPE, { includeSubfolders: false });
    btn(REMOVE).focus();
    btn(REMOVE).click();
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(lastFilters()).toEqual({ ...NO_FILTERS, includeSubfolders: false });
    expect("scope" in lastFilters()).toBe(false);
    expect(label().hidden).toBe(true);
    expect(document.activeElement).toBe(pathBtn());
  });

  it("« Inclure » est actif pour une portée (document comme cahier) et se bascule en gardant la portée", () => {
    for (const scope of [DOC_SCOPE, NB_SCOPE]) {
      withScope(scope);
      expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("false");
      expect(btn(INCLUDE).getAttribute("aria-pressed")).toBe("true");
      expect(btn(INCLUDE).querySelector("svg")!.classList.contains("ft__primary")).toBe(true);
      btn(INCLUDE).click();
      expect(lastFilters()).toMatchObject({ scope, includeSubfolders: false, folder: "" });
    }
  });

  it("sans chemin ni portée : « Inclure » reste désactivé", () => {
    expect(btn(INCLUDE).getAttribute("aria-disabled")).toBe("true");
  });

  it("une portée compte comme un filtre actif", () => {
    withScope(DOC_SCOPE);
    expect(row().querySelector('button[aria-label^="Filtres"]')!.getAttribute("aria-label")).toBe("Filtres (1 actif)");
  });
});

describe("dialogue « Filtres » et réinitialisation avec une portée", () => {
  const confirmFilters = (): void => {
    row().querySelector<HTMLButtonElement>('button[aria-label^="Filtres"]')!.click();
    fakes.lastDialog().confirm();
  };

  it("Confirmer conserve la portée", () => {
    withScope(DOC_SCOPE);
    confirmFilters();
    expect(lastFilters().scope).toEqual(DOC_SCOPE);
  });

  it("« Réinitialiser les filtres » puis Confirmer retire la portée", () => {
    withScope(DOC_SCOPE);
    row().querySelector<HTMLButtonElement>('button[aria-label^="Filtres"]')!.click();
    const dialog = fakes.lastDialog();
    const reset = [...dialog.container.querySelectorAll("button")].find((b) => b.textContent === "Réinitialiser les filtres")!;
    expect(reset.getAttribute("aria-disabled")).toBe("false"); // la portée suffit à rendre le bouton utile
    reset.click();
    dialog.confirm();
    expect("scope" in lastFilters()).toBe(false);
    expect(lastFilters().folder).toBe("");
  });

  it("toolbar.reset() efface aussi la portée", () => {
    withScope(DOC_SCOPE);
    toolbar.reset();
    expect(setOptions.mock.calls.at(-1)![0]).toEqual({ sort: state.sort, filters: NO_FILTERS });
  });
});
