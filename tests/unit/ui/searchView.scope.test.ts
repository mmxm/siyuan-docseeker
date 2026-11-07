// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocTree } from "../../../src/search/docTree";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import { mountSearchView } from "../../../src/ui/searchView";
import { createNativeFakes } from "./nativeFakes";

const NB = "20240101000000-aaaaaaa";
const TREE: DocTree = [{ kind: "notebook", box: NB, hpath: "", label: "Cahier A", depth: 0 }];

let fakes: ReturnType<typeof createNativeFakes>;
let host: HTMLElement;
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  fakes = createNativeFakes();
});

function mount(extra: { getDocTree?: (s?: AbortSignal) => Promise<DocTree> }, onWarn?: (m: string, e?: unknown) => void) {
  const opts: SearchOptions = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  return mountSearchView(host, {
    controller: { submit: () => undefined, getViewModel: () => ({ kind: "idle" }) as never },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => undefined } as never,
    onOpen: () => undefined,
    getDocMeta: () => undefined,
    options: { getOptions: () => opts, setOptions: () => undefined, getFolders: () => [], ...extra },
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...(onWarn ? { onWarn } : {}),
  });
}

describe("searchView : arbre des documents", () => {
  it("options.getDocTree est transmis à la barre : le menu du chemin propose « Documents SiYuan »", async () => {
    const getDocTree = vi.fn(async () => TREE);
    mount({ getDocTree });
    host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Spécifier le chemin"]')!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(getDocTree).toHaveBeenCalledTimes(1);
    expect(fakes.lastMenu().items.map((i) => i.label)).toEqual(["Tous les chemins", undefined, "Documents SiYuan", "Cahier A"]);
  });

  it("deps.onWarn de la vue est transmis à la barre (incident de lecture tracé)", async () => {
    const boom = new Error("noyau");
    const onWarn = vi.fn();
    const view = mount({ getDocTree: () => Promise.reject(boom) }, onWarn);
    host.querySelector<HTMLButtonElement>('.docseeker-icons button[aria-label="Spécifier le chemin"]')!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    view.dispose();
  });
});
