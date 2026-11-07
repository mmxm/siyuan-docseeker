// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Menu } from "siyuan";
import { openCustomDialog } from "../../../src/siyuan/nativeUi";
import type { DocFile, DocSearchHit, NotebookInfo } from "../../../src/siyuan/kernelApi";
import type { CustomDialogHandle } from "../../../src/ui/nativeUiTypes";
import { openPathDialog, type PathKernel } from "../../../src/ui/pathDialog";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";

const NB1 = "20261107102214-1y6la12";
const NB2 = "20261107111111-abcdefg";
const PARENT = "/20261107102226-6b6v11l.sy";
const COMPTA = "/20261107111734-5rit9cm.sy";
const CUISINE = "/20261107111734-nbaqmpx.sy";
const ARCHIVES = "/20261107111734-5rit9cm/20261107111734-5wv31ml.sy";
const NOTEBOOKS: NotebookInfo[] = [
  { id: NB1, name: "Test", closed: false, icon: "" },
  { id: NB2, name: "Archive", closed: false, icon: "1f4d4" },
  { id: "20261107999999-zzzzzzz", name: "Fermé", closed: true, icon: "" },
];
const file = (path: string, name: string, subFileCount = 0, icon = ""): DocFile => ({ path, name, icon, subFileCount });
const CHILDREN: Record<string, DocFile[]> = {
  [`${NB1}|/`]: [file(PARENT, "Parent", 1), file(COMPTA, "Compta", 1, "1f4c4"), file(CUISINE, "Cuisine", 0)],
  [`${NB1}|${COMPTA}`]: [file(ARCHIVES, "Archives", 0)],
  [`${NB1}|${PARENT}`]: [],
  [`${NB2}|/`]: [file("/20261107111111-1111111.sy", "<img src=x onerror=alert(1)>", 0)],
};
const HPATHS: Record<string, string> = {
  [PARENT]: "Test/Parent",
  [COMPTA]: "Test/Compta",
  [CUISINE]: "Test/Cuisine",
  [ARCHIVES]: "Test/Compta/Archives",
};

type Mocked<K> = { [P in keyof K]: ReturnType<typeof vi.fn> & K[P] };
function makeKernel(): Mocked<PathKernel> {
  return {
    lsNotebooks: vi.fn(async () => NOTEBOOKS),
    listDocsByPath: vi.fn(async (box: string, path: string) => CHILDREN[`${box}|${path}`] ?? []),
    searchDocs: vi.fn(async () => [] as DocSearchHit[]),
    getHPathsByPaths: vi.fn(async (paths: readonly string[]) => paths.map((p) => HPATHS[p] ?? "?")),
  } as unknown as Mocked<PathKernel>;
}

interface StubDialog {
  options: { width?: string; height?: string; title?: string };
  element: HTMLElement;
  destroyCount: number;
}
const stub = Dialog as unknown as { instances: StubDialog[]; reset(): void };
/** Faux timers (délai avant chaque requête de recherche) : on laisse passer les microtâches sans avancer l'horloge. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};
const DEBOUNCE_MS = 200;

interface Harness {
  kernel: Mocked<PathKernel>;
  onConfirm: ReturnType<typeof vi.fn>;
  onWarn: ReturnType<typeof vi.fn>;
  onDestroyed: ReturnType<typeof vi.fn>;
  handle: CustomDialogHandle;
  root: HTMLElement;
  input: HTMLInputElement;
  tree: HTMLElement;
  list: HTMLElement;
}
let kernel: Mocked<PathKernel>;
async function open(opts: { isMac?: boolean; kernel?: Mocked<PathKernel>; openDialog?: typeof openCustomDialog } = {}): Promise<Harness> {
  const k = opts.kernel ?? kernel;
  const onConfirm = vi.fn();
  const onWarn = vi.fn();
  const onDestroyed = vi.fn();
  const handle = openPathDialog({
    doc: document,
    t: (key, vars) => (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? "")),
    kernel: k,
    openCustomDialog: opts.openDialog ?? openCustomDialog,
    onWarn,
    onConfirm,
    onDestroyed,
    isMac: () => opts.isMac === true,
  });
  await flush();
  const root = stub.instances.at(-1)!.element.querySelector<HTMLElement>(".b3-dialog__body")!;
  return {
    kernel: k,
    onConfirm,
    onWarn,
    onDestroyed,
    handle,
    root,
    input: root.querySelector("input")!,
    tree: root.querySelector<HTMLElement>('[data-docseeker="tree"]')!,
    list: root.querySelector<HTMLElement>('[data-docseeker="list"]')!,
  };
}

const li = (h: Harness, path: string, box = NB1): HTMLElement =>
  h.root.querySelector<HTMLElement>(`li.b3-list-item[data-box="${box}"][data-path="${path}"]`)!;
const toggleOf = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>(".b3-list-item__toggle")!;
const focused = (h: Harness): string[] =>
  [...h.root.querySelectorAll<HTMLElement>("li.b3-list-item--focus")].map((r) => r.getAttribute("data-path")!);
const click = (target: Element, init: MouseEventInit = {}): void => {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
};
const press = (h: Harness, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  h.input.dispatchEvent(event);
  return event;
};
const type = (h: Harness, value: string): void => {
  h.input.value = value;
  h.input.dispatchEvent(new Event("input", { bubbles: true }));
};
/** Saisie puis fin du délai : la requête est partie (et sa réponse, si elle est prête, traitée). */
const typeSettled = async (h: Harness, value: string): Promise<void> => {
  type(h, value);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  await flush();
};
const expand = async (h: Harness, path: string, box = NB1): Promise<void> => {
  click(toggleOf(li(h, path, box)));
  await flush();
};
const hit = (path: string, hPath: string, title: string, box = NB1, boxIcon = ""): DocSearchHit => ({ path, hPath, title, box, boxIcon });
const deferred = <T,>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  stub.reset();
  kernel = makeKernel();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pathDialog : structure du dialogue", () => {
  it("dialogue 50vw x 70vh, data-key natif, titre « Spécifier le chemin »", async () => {
    await open();
    const dialog = stub.instances.at(-1)!;
    expect(dialog.options.width).toBe("50vw");
    expect(dialog.options.height).toBe("70vh");
    expect(dialog.element.getAttribute("data-key")).toBe("dialog-movepathto");
    expect(dialog.element.querySelector(".b3-dialog__header")!.textContent).toBe("Spécifier le chemin");
  });

  it("fenêtre étroite (< 768 px) : 92vw x 80vh", async () => {
    const before = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 767, configurable: true });
    try {
      await open();
      const dialog = stub.instances.at(-1)!;
      expect([dialog.options.width, dialog.options.height]).toEqual(["92vw", "80vh"]);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: before, configurable: true });
    }
  });

  it("corps : champ de recherche, liste de résultats masquée, arbre, séparateur, actions", async () => {
    const h = await open();
    expect([...h.root.children].map((c) => c.tagName + "." + c.className)).toEqual([
      "DIV.b3-form__icon",
      "UL.fn__flex-1 fn__none b3-list b3-list--background",
      "DIV.fn__flex-1",
      "DIV.fn__hr",
      "DIV.b3-dialog__action",
    ]);
    const form = h.root.children[0] as HTMLElement;
    expect(form.getAttribute("style")).toBe("margin:8px");
    const icon = form.querySelector(".b3-form__icon-list")!;
    expect(icon.querySelector("svg")!.getAttribute("class")).toBe("svg--mid");
    expect(icon.querySelector("use")!.getAttribute("xlink:href")).toBe("#iconSearch");
    expect(form.children).toHaveLength(2); // loupe seule : pas de chevron d'historique
    expect(h.input.className).toBe("b3-text-field fn__block");
    expect(h.input.getAttribute("style")).toBe("padding-left:42px");
    expect(h.input.getAttribute("spellcheck")).toBe("false");
    expect(h.input.getAttribute("placeholder")).toBe("Recherche...");
    for (const zone of [h.list, h.tree]) expect(zone.getAttribute("style")).toBe("overflow:auto;position:relative");
  });

  it("n'utilise aucun identifiant global du natif (foldList, foldTree)", async () => {
    const h = await open();
    expect(h.root.querySelector("#foldList, #foldTree")).toBeNull();
    expect(h.root.querySelector("[id]")).toBeNull();
  });

  it("boutons Annuler / Confirmer dans b3-dialog__action", async () => {
    const h = await open();
    const action = h.root.querySelector(".b3-dialog__action")!;
    expect([...action.children].map((c) => c.className)).toEqual(["b3-button b3-button--cancel", "fn__space", "b3-button b3-button--text"]);
    expect(action.querySelector(".b3-button--cancel")!.textContent).toBe("Annuler");
    expect(action.querySelector(".b3-button--text")!.textContent).toBe("Confirmer");
  });

  it("le focus est dans le champ de recherche", async () => {
    const h = await open();
    expect(document.activeElement).toBe(h.input);
  });
});

describe("pathDialog : arbre des cahiers", () => {
  it("un ul par cahier ouvert ; seul le premier est sélectionné ; structure d'une ligne de cahier", async () => {
    const h = await open();
    const lists = [...h.tree.children];
    expect(lists.map((u) => u.tagName + "." + u.className)).toEqual(Array(2).fill("UL.b3-list b3-list--background"));
    expect(h.kernel.lsNotebooks).toHaveBeenCalledTimes(1);
    const first = li(h, "/", NB1);
    expect(first.className).toBe("b3-list-item b3-list-item--focus");
    expect(li(h, "/", NB2).className).toBe("b3-list-item");
    expect(first.getAttribute("data-path")).toBe("/");
    expect(first.getAttribute("data-box")).toBe(NB1);
    expect([...first.children].map((c) => c.tagName + "." + c.getAttribute("class"))).toEqual([
      "SPAN.b3-list-item__toggle b3-list-item__toggle--hl",
      "svg.b3-list-item__graphic",
      "SPAN.b3-list-item__text",
    ]);
    const toggle = toggleOf(first);
    expect(toggle.querySelector("svg")!.getAttribute("class")).toBe("b3-list-item__arrow");
    expect(toggle.querySelector("use")!.getAttribute("xlink:href")).toBe("#iconRight");
    expect(first.querySelector(".b3-list-item__graphic use")!.getAttribute("xlink:href")).toBe("#iconFilesRoot");
    expect(first.querySelector(".b3-list-item__text")!.textContent).toBe("Test");
    expect(focused(h)).toEqual(["/"]);
  });

  it("icône emoji du cahier posée par textContent ; cahier fermé absent", async () => {
    const h = await open();
    const graphic = li(h, "/", NB2).querySelector(".b3-list-item__graphic")!;
    expect(graphic.tagName).toBe("SPAN");
    expect(graphic.textContent).toBe("📔");
    expect(h.root.querySelectorAll('li[data-path="/"]')).toHaveLength(2);
  });

  it("icône invalide : retombe sur l'icône par défaut, sans lever", async () => {
    kernel.lsNotebooks.mockResolvedValue([{ id: NB1, name: "T", closed: false, icon: "<b>x</b>" }, { id: NB2, name: "U", closed: false, icon: "110000" }]);
    const h = await open();
    for (const box of [NB1, NB2]) {
      expect(li(h, "/", box).querySelector("svg.b3-list-item__graphic use")!.getAttribute("xlink:href")).toBe("#iconFilesRoot");
    }
  });

  it("nom de cahier affiché comme texte", async () => {
    kernel.lsNotebooks.mockResolvedValue([{ id: NB1, name: "<img src=x onerror=alert(1)>", closed: false, icon: "" }]);
    const h = await open();
    expect(h.root.querySelector("img")).toBeNull();
    expect(li(h, "/").querySelector(".b3-list-item__text")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("aucun cahier ouvert : message « Aucun contenu connexe trouvé »", async () => {
    kernel.lsNotebooks.mockResolvedValue([]);
    const h = await open();
    expect(h.tree.textContent).toBe("Aucun contenu connexe trouvé");
  });

  it("lsNotebooks en échec : message d'erreur dans l'arbre et trace onWarn", async () => {
    const boom = new Error("noyau");
    kernel.lsNotebooks.mockRejectedValue(boom);
    const h = await open();
    expect(h.tree.textContent).toBe("Impossible de lire les documents (voir le journal dans les paramètres).");
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.onWarn.mock.calls[0]![1]).toBe(boom);
  });
});

describe("pathDialog : dépliage paresseux", () => {
  it("aucun appel listDocsByPath avant le premier clic sur le toggle", async () => {
    const h = await open();
    expect(h.kernel.listDocsByPath).not.toHaveBeenCalled();
    expect(li(h, "/").nextElementSibling).toBeNull();
  });

  it("clic sur le toggle d'un cahier : appel unique, data-loading pendant l'appel, ul juste après le li", async () => {
    const d = deferred<DocFile[]>();
    kernel.listDocsByPath.mockReturnValueOnce(d.promise);
    const h = await open();
    const row = li(h, "/");
    click(toggleOf(row));
    expect(row.getAttribute("data-loading")).toBe("true");
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
    expect(h.kernel.listDocsByPath.mock.calls[0]!.slice(0, 2)).toEqual([NB1, "/"]);
    click(toggleOf(row)); // pendant le chargement : ignoré
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
    d.resolve(CHILDREN[`${NB1}|/`]!);
    await flush();
    expect(row.hasAttribute("data-loading")).toBe(false);
    const ul = row.nextElementSibling!;
    expect(ul.tagName).toBe("UL");
    expect(ul.parentElement).toBe(row.parentElement);
    expect([...ul.children].map((c) => c.getAttribute("data-path"))).toEqual([PARENT, COMPTA, CUISINE]);
    expect(toggleOf(row).querySelector("svg")!.classList.contains("b3-list-item__arrow--open")).toBe(true);
  });

  it("ligne de document : data-box, data-path, toggle décalé, icône, texte", async () => {
    const h = await open();
    await expand(h, "/");
    const row = li(h, COMPTA);
    expect(row.className).toBe("b3-list-item");
    expect(row.getAttribute("data-box")).toBe(NB1);
    const toggle = toggleOf(row);
    expect(toggle.className).toBe("b3-list-item__toggle b3-list-item__toggle--hl");
    expect(toggle.getAttribute("style")).toBe(`padding-left:${COMPTA.split("/").length * 8}px`);
    expect(row.querySelector(".b3-list-item__text")!.textContent).toBe("Compta");
    expect(row.querySelector(".b3-list-item__graphic")!.textContent).toBe("📄"); // icône 1f4c4 (emoji)
    expect(li(h, PARENT).querySelector("svg.b3-list-item__graphic use")!.getAttribute("xlink:href")).toBe("#iconFile");
  });

  it("document sans enfant : toggle masqué (fn__hidden) et clic sans effet", async () => {
    const h = await open();
    await expand(h, "/");
    const leaf = li(h, CUISINE);
    expect(toggleOf(leaf).classList.contains("fn__hidden")).toBe(true);
    expect(toggleOf(li(h, COMPTA)).classList.contains("fn__hidden")).toBe(false);
    click(toggleOf(leaf));
    await flush();
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
  });

  it("déplié puis replié puis déplié : un seul appel au noyau, bascule de fn__none et de la flèche", async () => {
    const h = await open();
    await expand(h, "/");
    const row = li(h, "/");
    const ul = row.nextElementSibling as HTMLElement;
    const arrow = toggleOf(row).querySelector("svg")!;
    click(toggleOf(row));
    expect(ul.classList.contains("fn__none")).toBe(true);
    expect(arrow.classList.contains("b3-list-item__arrow--open")).toBe(false);
    click(toggleOf(row));
    expect(ul.classList.contains("fn__none")).toBe(false);
    expect(arrow.classList.contains("b3-list-item__arrow--open")).toBe(true);
    await flush();
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
  });

  it("document déplié : sous-ul juste après son li, avec le notebook et le chemin du parent", async () => {
    const h = await open();
    await expand(h, "/");
    await expand(h, COMPTA);
    expect(h.kernel.listDocsByPath.mock.calls[1]!.slice(0, 2)).toEqual([NB1, COMPTA]);
    const sub = li(h, COMPTA).nextElementSibling!;
    expect(sub.tagName).toBe("UL");
    expect([...sub.children].map((c) => c.getAttribute("data-path"))).toEqual([ARCHIVES]);
  });

  it("aucun fichier : « Aucun contenu connexe trouvé » sous la ligne", async () => {
    const h = await open();
    await expand(h, "/");
    await expand(h, PARENT);
    expect(li(h, PARENT).nextElementSibling!.textContent).toBe("Aucun contenu connexe trouvé");
  });

  it("nom de document hostile affiché comme texte, jamais comme HTML", async () => {
    const h = await open();
    await expand(h, "/", NB2);
    expect(h.root.querySelector("img")).toBeNull();
    const row = li(h, "/20261107111111-1111111.sy", NB2);
    expect(row.querySelector(".b3-list-item__text")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("échec : message d'erreur sous la ligne, trace onWarn, et nouvel essai au clic suivant", async () => {
    const boom = new Error("boom");
    kernel.listDocsByPath.mockRejectedValueOnce(boom);
    const h = await open();
    const row = li(h, "/");
    click(toggleOf(row));
    await flush();
    expect(row.hasAttribute("data-loading")).toBe(false);
    expect(row.nextElementSibling!.textContent).toBe("Impossible de lire les documents (voir le journal dans les paramètres).");
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.onWarn.mock.calls[0]![1]).toBe(boom);
    click(toggleOf(row)); // nouvel essai
    await flush();
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(2);
    expect(row.nextElementSibling!.querySelector('[data-path="' + PARENT + '"]')).not.toBeNull();
    expect(row.parentElement!.querySelectorAll(":scope > ul")).toHaveLength(1);
  });

  it("clic sur la ligne d'un cahier : le déplie ; un second clic ne le replie pas", async () => {
    const h = await open();
    click(li(h, "/").querySelector(".b3-list-item__text")!);
    await flush();
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
    expect((li(h, "/").nextElementSibling as HTMLElement).classList.contains("fn__none")).toBe(false);
    click(li(h, "/").querySelector(".b3-list-item__text")!);
    await flush();
    expect((li(h, "/").nextElementSibling as HTMLElement).classList.contains("fn__none")).toBe(false);
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
  });

  it("dialogue fermé pendant le chargement : rien n'est inséré, aucune trace", async () => {
    const d = deferred<DocFile[]>();
    kernel.listDocsByPath.mockReturnValueOnce(d.promise);
    const h = await open();
    click(toggleOf(li(h, "/")));
    h.handle.close();
    d.reject(new DOMException("annulé", "AbortError"));
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
  });

  it("le signal d'annulation est transmis au noyau et annulé à la fermeture", async () => {
    const h = await open();
    await expand(h, "/");
    const signal = h.kernel.listDocsByPath.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    h.handle.close();
    expect(signal.aborted).toBe(true);
  });
});

describe("pathDialog : sélection à la souris", () => {
  it("clic sur une ligne : le focus passe à cette ligne seule et revient dans le champ", async () => {
    const h = await open();
    await expand(h, "/");
    input_blur(h);
    click(li(h, COMPTA).querySelector(".b3-list-item__text")!);
    expect(focused(h)).toEqual([COMPTA]);
    expect(document.activeElement).toBe(h.input);
  });

  it("clic sur un toggle : ne change pas la sélection, le focus revient dans le champ", async () => {
    const h = await open();
    await expand(h, "/");
    input_blur(h);
    click(toggleOf(li(h, COMPTA)));
    await flush();
    expect(focused(h)).toEqual(["/"]);
    expect(document.activeElement).toBe(h.input);
  });

  it("Ctrl+clic (hors Mac) ajoute puis retire une ligne sans toucher aux autres", async () => {
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA), { ctrlKey: true });
    expect(focused(h)).toEqual(["/", COMPTA]);
    click(li(h, CUISINE), { ctrlKey: true });
    expect(focused(h)).toEqual(["/", COMPTA, CUISINE]);
    click(li(h, COMPTA), { ctrlKey: true });
    expect(focused(h)).toEqual(["/", CUISINE]);
    expect(document.activeElement).toBe(h.input);
  });

  it("sur Mac : Cmd+clic bascule ; Ctrl+clic seul est un clic ordinaire", async () => {
    const h = await open({ isMac: true });
    await expand(h, "/");
    click(li(h, COMPTA), { metaKey: true });
    expect(focused(h)).toEqual(["/", COMPTA]);
    click(li(h, CUISINE), { ctrlKey: true });
    expect(focused(h)).toEqual([CUISINE]);
  });

  it("hors Mac : Cmd+clic seul est un clic ordinaire", async () => {
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA), { metaKey: true });
    expect(focused(h)).toEqual([COMPTA]);
  });

  it("au moins une ligne reste sélectionnée", async () => {
    const h = await open();
    click(li(h, "/"), { ctrlKey: true });
    expect(focused(h)).toEqual(["/"]);
  });

  it("Ctrl+clic sur un cahier ne le déplie pas", async () => {
    const h = await open();
    click(li(h, "/", NB2), { ctrlKey: true });
    await flush();
    expect(h.kernel.listDocsByPath).not.toHaveBeenCalled();
    expect(focused(h)).toEqual(["/", "/"]);
  });

  it("21e ligne refusée avec un message, trace non requise : la sélection reste à 20", async () => {
    const many: DocFile[] = Array.from({ length: 22 }, (_v, i) => file(`/20261107000000-${String(i).padStart(7, "0")}.sy`, `D${i}`));
    kernel.listDocsByPath.mockResolvedValueOnce(many);
    const h = await open();
    await expand(h, "/");
    for (const f of many.slice(0, 19)) click(li(h, f.path), { ctrlKey: true });
    expect(focused(h)).toHaveLength(20);
    click(li(h, many[19]!.path), { ctrlKey: true });
    expect(focused(h)).toHaveLength(20);
    expect(h.root.textContent).toContain("20 chemins au plus");
  });
});

function input_blur(h: Harness): void {
  h.input.blur();
  expect(document.activeElement).not.toBe(h.input);
}

describe("pathDialog : clavier dans le champ", () => {
  it("↓ / ↑ parcourent les lignes visibles et réduisent la sélection à une seule", async () => {
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA), { ctrlKey: true });
    expect(focused(h)).toEqual(["/", COMPTA]);
    const down = press(h, "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(focused(h)).toEqual([CUISINE]);
    press(h, "ArrowUp");
    expect(focused(h)).toEqual([COMPTA]);
    press(h, "ArrowUp");
    press(h, "ArrowUp");
    expect(focused(h)).toEqual(["/"]);
    press(h, "ArrowUp"); // début de liste : on reste
    expect(focused(h)).toEqual(["/"]);
  });

  it("↓ saute les lignes d'un sous-arbre replié et passe d'un cahier au suivant", async () => {
    const h = await open();
    await expand(h, "/");
    click(toggleOf(li(h, "/"))); // replié
    press(h, "ArrowDown");
    expect(focused(h)).toEqual(["/"]); // le curseur est sur le cahier 2 (même chemin « / »)
    expect(li(h, "/", NB2).classList.contains("b3-list-item--focus")).toBe(true);
    press(h, "ArrowDown"); // fin de liste
    expect(li(h, "/", NB2).classList.contains("b3-list-item--focus")).toBe(true);
  });

  it("→ déplie une ligne fermée, descend si elle est ouverte, sans effet sur une feuille", async () => {
    const h = await open();
    press(h, "ArrowRight");
    await flush();
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
    press(h, "ArrowRight"); // ouvert : descend au premier enfant
    expect(focused(h)).toEqual([PARENT]);
    press(h, "ArrowDown");
    press(h, "ArrowDown");
    expect(focused(h)).toEqual([CUISINE]);
    press(h, "ArrowRight");
    await flush();
    expect(focused(h)).toEqual([CUISINE]);
    expect(h.kernel.listDocsByPath).toHaveBeenCalledTimes(1);
  });

  it("← replie une ligne ouverte, sinon remonte au parent", async () => {
    const h = await open();
    await expand(h, "/");
    await expand(h, COMPTA);
    click(li(h, ARCHIVES));
    expect(focused(h)).toEqual([ARCHIVES]);
    press(h, "ArrowLeft"); // feuille : remonte à Compta
    expect(focused(h)).toEqual([COMPTA]);
    press(h, "ArrowLeft"); // ouverte : replie
    expect((li(h, COMPTA).nextElementSibling as HTMLElement).classList.contains("fn__none")).toBe(true);
    press(h, "ArrowLeft"); // fermée : remonte au cahier
    expect(focused(h)).toEqual(["/"]);
    press(h, "ArrowLeft"); // cahier ouvert : replie
    expect((li(h, "/").nextElementSibling as HTMLElement).classList.contains("fn__none")).toBe(true);
    press(h, "ArrowLeft"); // cahier fermé : rien
    expect(focused(h)).toEqual(["/"]);
  });

  it("Échap n'est pas consommé : le dialogue se ferme sans rien appliquer", async () => {
    const h = await open();
    const event = press(h, "Escape");
    expect(event.defaultPrevented).toBe(false);
    expect(h.handle.isOpen()).toBe(false);
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("Entrée pendant une composition (IME) ne confirme pas", async () => {
    const h = await open();
    press(h, "Enter", { isComposing: true });
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
  });
});

describe("pathDialog : recherche", () => {
  it("saisie non vide : arbre masqué, liste affichée ; saisie vidée : arbre de retour", async () => {
    const h = await open();
    expect(h.list.classList.contains("fn__none")).toBe(true);
    type(h, "Co");
    expect(h.tree.classList.contains("fn__none")).toBe(true);
    expect(h.list.classList.contains("fn__none")).toBe(false);
    type(h, "");
    expect(h.tree.classList.contains("fn__none")).toBe(false);
    expect(h.list.classList.contains("fn__none")).toBe(true);
    type(h, "   ");
    expect(h.tree.classList.contains("fn__none")).toBe(false);
  });

  it("délai de 200 ms avant chaque requête : une seule requête, avec le dernier texte saisi", async () => {
    const h = await open();
    type(h, "C");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    type(h, "Co");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    type(h, "Com");
    expect(h.kernel.searchDocs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(h.kernel.searchDocs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kernel.searchDocs.mock.calls.map((c) => c[0])).toEqual(["Com"]);
    expect(h.kernel.searchDocs.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it("vider le champ ou fermer le dialogue avant la fin du délai : aucune requête ne part", async () => {
    const h = await open();
    type(h, "C");
    type(h, "");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    type(h, "Co");
    h.handle.close();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.kernel.searchDocs).not.toHaveBeenCalled();
  });

  it("réponse périmée ignorée, même si elle arrive après la plus récente", async () => {
    const first = deferred<DocSearchHit[]>();
    const second = deferred<DocSearchHit[]>();
    kernel.searchDocs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = await open();
    await typeSettled(h, "C");
    await typeSettled(h, "Co");
    second.resolve([hit(COMPTA, "Test/Compta", "Compta")]);
    await flush();
    first.resolve([hit(CUISINE, "Test/Cuisine", "Cuisine")]);
    await flush();
    expect([...h.list.querySelectorAll("li")].map((r) => r.getAttribute("data-path"))).toEqual([COMPTA]);
  });

  it("l'ancienne requête est annulée dès la frappe suivante (avant même que la plus récente parte)", async () => {
    const h = await open();
    await typeSettled(h, "C");
    const first = h.kernel.searchDocs.mock.calls[0]![1] as AbortSignal;
    expect(first.aborted).toBe(false);
    type(h, "Co");
    expect(first.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect((h.kernel.searchDocs.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    expect((h.kernel.searchDocs.mock.calls[1]![1] as AbortSignal).aborted).toBe(false);
  });

  it("vider le champ pendant une recherche : sa réponse tardive n'affiche rien", async () => {
    const d = deferred<DocSearchHit[]>();
    kernel.searchDocs.mockReturnValueOnce(d.promise);
    const h = await open();
    await typeSettled(h, "C");
    type(h, "");
    d.resolve([hit(COMPTA, "Test/Compta", "Compta")]);
    await flush();
    expect(h.list.querySelectorAll("li")).toHaveLength(0);
    expect(h.list.classList.contains("fn__none")).toBe(true);
  });

  it("structure d'un résultat : li data-path/data-box, icône, texte avec <mark> autour des occurrences", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/Compta/Compta bis", "Compta"), hit("/", "Test/", "Test")]);
    const h = await open();
    await typeSettled(h, "compta");
    const rows = [...h.list.children] as HTMLElement[];
    expect(rows.map((r) => r.className)).toEqual(["b3-list-item", "b3-list-item"]);
    expect(rows[0]!.getAttribute("data-path")).toBe(COMPTA);
    expect(rows[0]!.getAttribute("data-box")).toBe(NB1);
    expect(rows[0]!.querySelector("svg.b3-list-item__graphic use")!.getAttribute("xlink:href")).toBe("#iconFile");
    const text = rows[0]!.querySelector<HTMLElement>(".b3-list-item__showall")!;
    expect(text.className).toBe("b3-list-item__showall fn__flex-1");
    expect(text.getAttribute("style")).toBe("padding:4px 0;min-width:0");
    expect(text.textContent).toBe("Test/Compta/Compta bis");
    expect([...text.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Compta", "Compta"]);
    expect(rows[1]!.querySelector("svg.b3-list-item__graphic use")!.getAttribute("xlink:href")).toBe("#iconFilesRoot");
  });

  it("l'emoji d'icône de cahier est posé par textContent", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit("/", "Archive/", "Archive", NB2, "1f4d4")]);
    const h = await open();
    await typeSettled(h, "a");
    expect(h.list.querySelector(".b3-list-item__graphic")!.textContent).toBe("📔");
  });

  it("chemin hostile et besoin avec caractères spéciaux : texte seul, aucune balise créée", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/<img src=x onerror=alert(1)>/(a+b)", "x")]);
    const h = await open();
    await typeSettled(h, "(a+b)");
    expect(h.list.querySelector("img")).toBeNull();
    const text = h.list.querySelector(".b3-list-item__showall")!;
    expect(text.textContent).toBe("Test/<img src=x onerror=alert(1)>/(a+b)");
    expect([...text.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["(a+b)"]);
  });

  it("aucun résultat : « Aucun contenu connexe trouvé »", async () => {
    const h = await open();
    await typeSettled(h, "zzz");
    expect(h.list.textContent).toBe("Aucun contenu connexe trouvé");
    expect(h.list.querySelectorAll("li.b3-list-item")).toHaveLength(0);
  });

  it("échec : message d'erreur dans la liste et trace onWarn", async () => {
    const boom = new Error("réseau");
    kernel.searchDocs.mockRejectedValueOnce(boom);
    const h = await open();
    await typeSettled(h, "zzz");
    expect(h.list.textContent).toBe("Impossible de lire les documents (voir le journal dans les paramètres).");
    expect(h.onWarn.mock.calls[0]![1]).toBe(boom);
  });

  it("l'échec d'une recherche périmée n'affiche ni message ni trace", async () => {
    const d = deferred<DocSearchHit[]>();
    kernel.searchDocs.mockReturnValueOnce(d.promise);
    const h = await open();
    await typeSettled(h, "C");
    await typeSettled(h, "Co");
    d.reject(new DOMException("annulé", "AbortError"));
    await flush();
    expect(h.onWarn).not.toHaveBeenCalled();
    expect(h.list.textContent).not.toContain("Impossible");
  });

  it("clic, Ctrl+clic et flèches s'appliquent aux résultats ; l'arbre garde sa sélection", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/Compta", "Compta"), hit(CUISINE, "Test/Cuisine", "Cuisine"), hit(PARENT, "Test/Parent", "Parent")]);
    const h = await open();
    await typeSettled(h, "t");
    expect(focused(h)).toEqual(["/"]); // sélection de l'arbre, masqué ; aucune ligne de résultat
    click(h.list.querySelector(`[data-path="${COMPTA}"]`)!);
    click(h.list.querySelector(`[data-path="${CUISINE}"]`)!, { ctrlKey: true });
    expect([...h.list.querySelectorAll(".b3-list-item--focus")].map((r) => r.getAttribute("data-path"))).toEqual([COMPTA, CUISINE]);
    press(h, "ArrowDown");
    expect([...h.list.querySelectorAll(".b3-list-item--focus")].map((r) => r.getAttribute("data-path"))).toEqual([PARENT]);
    press(h, "ArrowDown");
    press(h, "ArrowUp");
    expect([...h.list.querySelectorAll(".b3-list-item--focus")].map((r) => r.getAttribute("data-path"))).toEqual([CUISINE]);
    expect(document.activeElement).toBe(h.input);
    type(h, "");
    expect(h.tree.querySelector(".b3-list-item--focus")!.getAttribute("data-path")).toBe("/");
  });

  it("→ et ← ne sont pas détournés dans la liste des résultats (le curseur du champ garde sa fonction)", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/Compta", "Compta")]);
    const h = await open();
    await typeSettled(h, "t");
    expect(press(h, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(h, "ArrowLeft").defaultPrevented).toBe(false);
  });
});

describe("pathDialog : confirmation", () => {
  const confirmButton = (h: Harness): HTMLElement => h.root.querySelector<HTMLElement>(".b3-button--text")!;

  it("un cahier : {kind:notebook, box, label: nom du cahier}, sans appel getHPathsByPaths ; le dialogue se ferme", async () => {
    const h = await open();
    click(confirmButton(h));
    await flush();
    expect(h.kernel.getHPathsByPaths).not.toHaveBeenCalled();
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith([{ kind: "notebook", box: NB1, label: "Test" }]);
    expect(h.handle.isOpen()).toBe(false);
    expect(h.onDestroyed).toHaveBeenCalledTimes(1);
  });

  it("un document : label = chemin complet donné par getHPathsByPaths, docPath = data-path", async () => {
    const h = await open();
    await expand(h, "/");
    await expand(h, COMPTA);
    click(li(h, ARCHIVES));
    click(confirmButton(h));
    await flush();
    expect(h.kernel.getHPathsByPaths).toHaveBeenCalledTimes(1);
    expect(h.kernel.getHPathsByPaths.mock.calls[0]![0]).toEqual([ARCHIVES]);
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith([{ kind: "document", box: NB1, docPath: ARCHIVES, label: "Test/Compta/Archives" }]);
  });

  it("deux documents : chaque libellé est associé à son chemin même si le noyau répond dans un autre ordre", async () => {
    kernel.getHPathsByPaths.mockImplementation(async (paths: readonly string[]) => {
      // Réponse volontairement dans l'ordre inverse quand on lui demande plusieurs chemins à la fois.
      const out = paths.map((p) => HPATHS[p]!);
      return paths.length > 1 ? out.reverse() : out;
    });
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    click(li(h, CUISINE), { ctrlKey: true });
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith([
      { kind: "document", box: NB1, docPath: COMPTA, label: "Test/Compta" },
      { kind: "document", box: NB1, docPath: CUISINE, label: "Test/Cuisine" },
    ]);
  });

  it("mélange cahier + document : ordre de l'arbre", async () => {
    const h = await open();
    await expand(h, "/");
    click(li(h, CUISINE), { ctrlKey: true });
    click(confirmButton(h));
    await flush();
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith([
      { kind: "notebook", box: NB1, label: "Test" },
      { kind: "document", box: NB1, docPath: CUISINE, label: "Test/Cuisine" },
    ]);
  });

  it("Entrée dans le champ confirme", async () => {
    const h = await open();
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("depuis les résultats de recherche : seules les lignes sélectionnées de la liste sont prises", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit("/", "Test/", "Test"), hit(COMPTA, "Test/Compta", "Compta")]);
    const h = await open();
    await typeSettled(h, "t");
    click(h.list.querySelector('[data-path="/"]')!);
    click(h.list.querySelector(`[data-path="${COMPTA}"]`)!, { ctrlKey: true });
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).toHaveBeenCalledExactlyOnceWith([
      { kind: "notebook", box: NB1, label: "Test" },
      { kind: "document", box: NB1, docPath: COMPTA, label: "Test/Compta" },
    ]);
  });

  it("recherche sans ligne sélectionnée : Entrée ne fait rien et le dialogue reste ouvert", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/Compta", "Compta")]);
    const h = await open();
    await typeSettled(h, "t");
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.handle.isOpen()).toBe(true);
  });

  it("Entrée répétée pendant la résolution : une seule application", async () => {
    const d = deferred<string[]>();
    kernel.getHPathsByPaths.mockReturnValueOnce(d.promise);
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    press(h, "Enter");
    press(h, "Enter");
    d.resolve(["Test/Compta"]);
    await flush();
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
    expect(h.kernel.getHPathsByPaths).toHaveBeenCalledTimes(1);
  });

  it("échec de getHPathsByPaths : message dans le dialogue, trace onWarn, dialogue ouvert, rien d'appliqué ; le message s'efface au clic suivant", async () => {
    const boom = new Error("hpath");
    kernel.getHPathsByPaths.mockRejectedValueOnce(boom);
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    click(confirmButton(h));
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.handle.isOpen()).toBe(true);
    expect(h.tree.textContent).toContain("Impossible de lire les documents (voir le journal dans les paramètres).");
    expect(h.onWarn.mock.calls[0]![1]).toBe(boom);
    click(li(h, CUISINE));
    expect(h.tree.textContent).not.toContain("Impossible");
    click(confirmButton(h)); // et l'on peut réessayer
    await flush();
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("réponse de getHPathsByPaths au mauvais format (pas une chaîne par chemin) : erreur, rien d'appliqué", async () => {
    kernel.getHPathsByPaths.mockResolvedValueOnce([]);
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.tree.textContent).toContain("Impossible de lire les documents");
  });

  it("sélection invalide (identifiant illisible) : refusée avec le même message, trace onWarn", async () => {
    kernel.lsNotebooks.mockResolvedValue([{ id: "pas-un-id", name: "X", closed: false, icon: "" }]);
    const h = await open();
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.tree.textContent).toContain("Impossible de lire les documents");
  });

  it("dialogue fermé pendant la résolution des libellés : rien n'est appliqué, aucune trace", async () => {
    const d = deferred<string[]>();
    kernel.getHPathsByPaths.mockReturnValueOnce(d.promise);
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    press(h, "Enter");
    h.handle.close();
    d.resolve(["Test/Compta"]);
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.onWarn).not.toHaveBeenCalled();
  });

  it("onConfirm qui lève : message, trace, dialogue ouvert", async () => {
    const h = await open();
    h.onConfirm.mockImplementation(() => {
      throw new Error("refus");
    });
    press(h, "Enter");
    await flush();
    expect(h.handle.isOpen()).toBe(true);
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.tree.textContent).toContain("Impossible de lire les documents");
  });

  it("Annuler : ferme sans rien appliquer", async () => {
    const h = await open();
    click(h.root.querySelector(".b3-button--cancel")!);
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.handle.isOpen()).toBe(false);
    expect(h.onDestroyed).toHaveBeenCalledTimes(1);
  });
});

describe("pathDialog : cas limites", () => {
  it("getHPathsByPaths renvoyant plusieurs chaînes pour un seul chemin : erreur, rien d'appliqué", async () => {
    kernel.getHPathsByPaths.mockResolvedValueOnce(["Test/Compta", "Test/Autre"]);
    const h = await open();
    await expand(h, "/");
    click(li(h, COMPTA));
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.tree.textContent).toContain("Impossible de lire les documents");
  });

  it("icône composée de plusieurs points de code (« 1f468-200d-1f4bb ») : un seul caractère composé, par textContent", async () => {
    kernel.lsNotebooks.mockResolvedValue([{ id: NB1, name: "T", closed: false, icon: "1f468-200d-1f4bb" }]);
    const h = await open();
    expect(li(h, "/").querySelector(".b3-list-item__graphic")!.textContent).toBe("\u{1f468}‍\u{1f4bb}");
  });

  it("icône hors plage ou à caractère de contrôle : icône par défaut", async () => {
    kernel.lsNotebooks.mockResolvedValue([
      { id: NB1, name: "T", closed: false, icon: "d800" },
      { id: NB2, name: "U", closed: false, icon: "0007" },
    ]);
    const h = await open();
    for (const box of [NB1, NB2]) expect(li(h, "/", box).querySelector("svg.b3-list-item__graphic")).not.toBeNull();
  });

  it("Mac détecté par navigator.platform quand isMac n'est pas fourni : Cmd+clic bascule", async () => {
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const onConfirm = vi.fn();
      const handle = openPathDialog({
        doc: document,
        t: (key) => DEFAULT_STRINGS[key] ?? key,
        kernel,
        openCustomDialog,
        onWarn: vi.fn(),
        onConfirm,
      });
      await flush();
      const root = stub.instances.at(-1)!.element.querySelector<HTMLElement>(".b3-dialog__body")!;
      const second = root.querySelector<HTMLElement>(`li[data-box="${NB2}"]`)!;
      click(second, { metaKey: true });
      expect(root.querySelectorAll("li.b3-list-item--focus")).toHaveLength(2);
      handle.close();
    } finally {
      Object.defineProperty(window.navigator, "platform", { value: "", configurable: true });
    }
  });

  it("la recherche envoie le texte rogné et surligne sans tenir compte de la casse", async () => {
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/COMPTA", "Compta")]);
    const h = await open();
    await typeSettled(h, "  compta ");
    expect(h.kernel.searchDocs.mock.calls[0]![0]).toBe("compta");
    expect(h.list.querySelector("mark")!.textContent).toBe("COMPTA");
  });
});

describe("pathDialog : recherche robuste (G)", () => {
  it("50 frappes : aucun écouteur « abort » n'est ajouté par frappe (pas d'accumulation sur le signal du dialogue)", async () => {
    const h = await open();
    // Le EventTarget dont hérite AbortSignal (celui de Node, distinct de celui de jsdom).
    const spy = vi.spyOn(Object.getPrototypeOf(AbortSignal.prototype) as EventTarget, "addEventListener");
    for (let i = 0; i < 50; i++) await typeSettled(h, `a${i}`);
    const aborts = spy.mock.calls.filter((c, i) => c[0] === "abort" && "aborted" in (spy.mock.contexts[i] as object));
    expect(aborts.length).toBeLessThanOrEqual(1);
    // Et l'annulation reste effective : fermer le dialogue annule la requête en cours.
    const signal = h.kernel.searchDocs.mock.calls.at(-1)![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    h.handle.close();
    await flush();
    expect(signal.aborted).toBe(true);
  });

  it("résultat périmé non confirmable : la saisie suivante vide la liste et la sélection avant la réponse", async () => {
    const second = deferred<DocSearchHit[]>();
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, "Test/Compta", "Compta")]).mockReturnValueOnce(second.promise);
    const h = await open();
    await typeSettled(h, "a");
    click(h.list.querySelector(`li[data-path="${COMPTA}"]`)!);
    expect(h.list.querySelectorAll("li.b3-list-item--focus")).toHaveLength(1);
    type(h, "ab"); // la réponse de « ab » n'est pas arrivée
    expect(h.list.querySelectorAll("li.b3-list-item")).toHaveLength(0);
    expect(h.list.querySelectorAll("li.b3-list-item--focus")).toHaveLength(0);
    press(h, "Enter");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.kernel.getHPathsByPaths).not.toHaveBeenCalled();
    second.resolve([]);
    await flush();
  });

  it("ligne sélectionnée sans métadonnée : erreur affichée et tracée, rien n'est appliqué (jamais écartée en silence)", async () => {
    const h = await open();
    await expand(h, "/");
    const ghost = document.createElement("li");
    ghost.className = "b3-list-item b3-list-item--focus";
    h.tree.querySelector("ul")!.appendChild(ghost);
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(h.tree.textContent).toContain("Impossible de lire les documents");
    expect(h.onWarn).toHaveBeenCalled();
    expect(String(h.onWarn.mock.calls.at(-1)![0])).toContain("Chemins choisis non appliqués");
  });

  it("close() qui lève après l'application : le filtre est appliqué, pas de message d'erreur de lecture, une trace", async () => {
    const boom = new Error("close en échec");
    const h = await open({
      openDialog: (options) => {
        const real = openCustomDialog(options);
        return { isOpen: () => real.isOpen(), close: () => { throw boom; } };
      },
    });
    press(h, "Enter");
    await flush();
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
    expect(h.tree.textContent).not.toContain("Impossible de lire les documents");
    expect(h.onWarn.mock.calls.some((c) => c[1] === boom)).toBe(true);
  });

  it("résultats de recherche plafonnés à 200 avec une note", async () => {
    const hits = Array.from({ length: 250 }, (_v, i) => hit(`/20261107111111-${String(i).padStart(7, "0")}.sy`, `Test/doc ${i}`, `doc ${i}`));
    kernel.searchDocs.mockResolvedValueOnce(hits);
    const h = await open();
    await typeSettled(h, "doc");
    expect(h.list.querySelectorAll("li.b3-list-item")).toHaveLength(200);
    const note = h.list.querySelector("li.b3-list--empty")!;
    expect(note.textContent).toBe("Seuls les 200 premiers résultats sont affichés.");
  });

  it("exactement 200 résultats : pas de note", async () => {
    kernel.searchDocs.mockResolvedValueOnce(Array.from({ length: 200 }, (_v, i) => hit(`/20261107111111-${String(i).padStart(7, "0")}.sy`, `Test/doc ${i}`, `doc ${i}`)));
    const h = await open();
    await typeSettled(h, "doc");
    expect(h.list.querySelectorAll("li.b3-list-item")).toHaveLength(200);
    expect(h.list.querySelector("li.b3-list--empty")).toBeNull();
  });

  it("enfants d'un dépliage plafonnés à 500 avec une note", async () => {
    const many = Array.from({ length: 600 }, (_v, i) => file(`/20261107111111-${String(i).padStart(7, "0")}.sy`, `d${i}`));
    kernel.listDocsByPath.mockResolvedValueOnce(many);
    const h = await open();
    await expand(h, "/");
    const ul = li(h, "/").nextElementSibling!;
    expect(ul.querySelectorAll("li.b3-list-item")).toHaveLength(500);
    expect(ul.querySelector("li.b3-list--empty")!.textContent).toBe("Seuls les 500 premiers résultats sont affichés.");
  });
});

describe("pathDialog : caractères de format (A)", () => {
  const BIDI = "\u202E\u200B\u200F";
  it("noms de cahier, de document et chemins de résultats affichés sans caractères de format ni de contrôle", async () => {
    kernel.lsNotebooks.mockResolvedValue([{ id: NB1, name: `Ca${BIDI}hier\u0007`, closed: false, icon: "" }]);
    kernel.listDocsByPath.mockResolvedValueOnce([file(PARENT, `Do${BIDI}c`)]);
    kernel.searchDocs.mockResolvedValueOnce([hit(COMPTA, `Te${BIDI}st/Comp\u202Eta`, "x")]);
    const h = await open();
    expect(li(h, "/").querySelector(".b3-list-item__text")!.textContent).toBe("Cahier");
    await expand(h, "/");
    expect(li(h, PARENT).querySelector(".b3-list-item__text")!.textContent).toBe("Doc");
    await typeSettled(h, "comp");
    expect(h.list.querySelector(".b3-list-item__showall")!.textContent).toBe("Test/Compta");
    expect(h.list.querySelector("mark")!.textContent).toBe("Comp");
  });

  it("icône : tout caractère de format (bidi, largeur nulle) est refusé ; la jonction ZWJ entre deux emojis reste admise", async () => {
    kernel.lsNotebooks.mockResolvedValue([
      { id: NB1, name: "A", closed: false, icon: "202e" },
      { id: NB2, name: "B", closed: false, icon: "1f4c4-200b" },
      { id: "20261107999999-aaaaaaa", name: "C", closed: false, icon: "200d" },
      { id: "20261107999999-bbbbbbb", name: "D", closed: false, icon: "1f4c4-200f-1f4c4" },
      { id: "20261107999999-ccccccc", name: "E", closed: false, icon: "1f468-200d-1f4bb" },
    ]);
    const h = await open();
    for (const box of [NB1, NB2, "20261107999999-aaaaaaa", "20261107999999-bbbbbbb"]) {
      expect(li(h, "/", box).querySelector("svg.b3-list-item__graphic")).not.toBeNull();
    }
    expect(li(h, "/", "20261107999999-ccccccc").querySelector("svg.b3-list-item__graphic")).toBeNull();
  });
});
