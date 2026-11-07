// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type SearchOptions } from "../../../src/search/resultOptions";
import type { PathKernel } from "../../../src/ui/pathDialog";
import { mountSearchView } from "../../../src/ui/searchView";
import { createNativeFakes } from "./nativeFakes";

const NB = "20240101000000-aaaaaaa";
const PATH = '.docseeker-icons button[aria-label="Spécifier le chemin"]';
const INCLUDE = '.docseeker-icons button[aria-label="Inclure les documents enfants"]';

let fakes: ReturnType<typeof createNativeFakes>;
let host: HTMLElement;
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  fakes = createNativeFakes();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const kernel = (over: Partial<PathKernel> = {}): PathKernel => ({
  lsNotebooks: async () => [{ id: NB, name: "Cahier A", closed: false, icon: "" }],
  listDocsByPath: async () => [],
  searchDocs: async () => [],
  getHPathsByPaths: async () => [],
  ...over,
});

function mount(
  extra: { pathKernel?: PathKernel },
  { onWarn, withDialog = true, notify }: { onWarn?: (m: string, e?: unknown) => void; withDialog?: boolean; notify?: (t: string) => void } = {},
) {
  const opts: SearchOptions = { sort: { key: "name", direction: "asc" }, filters: NO_FILTERS };
  return mountSearchView(host, {
    controller: { submit: () => undefined, getViewModel: () => ({ kind: "idle" }) as never },
    subscribe: () => () => undefined,
    thumbnails: { attach: () => undefined } as never,
    onOpen: () => undefined,
    getDocMeta: () => undefined,
    options: { getOptions: () => opts, setOptions: () => undefined, ...extra },
    openMenu: fakes.openMenu,
    openDialog: fakes.openDialog,
    ...(withDialog ? { openCustomDialog: fakes.openCustomDialog } : {}),
    ...(onWarn ? { onWarn } : {}),
    ...(notify ? { notify } : {}),
  });
}

describe("searchView : dialogue « Spécifier le chemin »", () => {
  it("options.pathKernel et openCustomDialog sont transmis à la barre : le bouton ouvre le dialogue natif", async () => {
    const lsNotebooks = vi.fn(async () => [{ id: NB, name: "Cahier A", closed: false, icon: "" }]);
    mount({ pathKernel: kernel({ lsNotebooks }) });
    host.querySelector<HTMLButtonElement>(PATH)!.click();
    await flush();
    expect(lsNotebooks).toHaveBeenCalledTimes(1);
    expect(fakes.openMenu).not.toHaveBeenCalled();
    expect(fakes.lastCustomDialog().container.querySelector(".b3-list-item__text")!.textContent).toBe("Cahier A");
  });

  it("deps.onWarn de la vue est transmis à la barre (incident de lecture tracé)", async () => {
    const boom = new Error("noyau");
    const onWarn = vi.fn();
    const view = mount({ pathKernel: kernel({ lsNotebooks: () => Promise.reject(boom) }) }, { onWarn });
    host.querySelector<HTMLButtonElement>(PATH)!.click();
    await flush();
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
    view.dispose();
  });

  it("deps.notify de la vue est transmis à la barre : l'échec d'ouverture du dialogue est dit à l'utilisateur", () => {
    const notify = vi.fn();
    fakes.openCustomDialog.mockImplementationOnce(() => {
      throw new Error("Dialog indisponible");
    });
    mount({ pathKernel: kernel() }, { onWarn: vi.fn(), notify });
    host.querySelector<HTMLButtonElement>(PATH)!.click();
    expect(notify).toHaveBeenCalledWith("Impossible d'ouvrir le choix du chemin (voir le journal dans les paramètres).");
  });

  it("sans noyau, ou sans dialogue libre : ni « Spécifier le chemin » ni « Inclure les documents enfants »", () => {
    mount({});
    expect(host.querySelector(PATH)).toBeNull();
    expect(host.querySelector(INCLUDE)).toBeNull();
    host.innerHTML = "";
    mount({ pathKernel: kernel() }, { withDialog: false });
    expect(host.querySelector(PATH)).toBeNull();
  });
});
