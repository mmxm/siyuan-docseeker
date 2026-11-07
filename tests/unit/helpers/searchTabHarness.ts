// Banc commun des tests d'assemblage (onglet et fenêtre flottante) : index partagé réel sur un faux magasin, faux openPdfAtPage,
// menus et dialogues injectables (faux par défaut, ou les VRAIS de src/siyuan/nativeUi.ts).
import { vi } from "vitest";
import type { SearchIndexData } from "../../../src/core/codec/format";
import type { IndexerEvent } from "../../../src/indexer/indexer";
import type { SearchTabDeps } from "../../../src/searchTab";
import { createSharedIndex, type SharedIndex } from "../../../src/search/sharedIndex";
import { openConfirmDialog, openInputDialog } from "../../../src/siyuan/nativeUi";
import { createNativeFakes } from "../ui/nativeFakes";

export const PDF_A = "assets/Alpha-20240101120000-abc1234.pdf";
export const ATTACHED = { status: "attached", pageNumber: 2, keptRects: 1, droppedRects: 0, scrolled: true };
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const dataA = (): SearchIndexData => ({
  normalizerVersion: 1,
  extractorVersion: "t",
  sourcePath: PDF_A,
  pdfSize: 123,
  pdfModifiedMs: 456,
  pageTermCounts: new Uint32Array([1, 2, 3]),
  postings: {
    terms: ["chat", "chien"],
    offsets: new Uint32Array([0, 2, 4]),
    pages: new Uint32Array([2, 3, 2, 3]),
    termFrequencies: new Uint32Array([1, 1, 1, 1]),
  },
});

export const sharedInstances: SharedIndex[] = [];

export function harness(over: Partial<SearchTabDeps> = {}, natives: Pick<SearchTabDeps, "openMenu" | "openDialog" | "openCustomDialog"> = createNativeFakes()) {
  const files = new Map<string, Uint8Array>([["a.dsx", bytes("a")], ["manifest.json", bytes("{}")]]);
  const read = vi.fn(async (name: string) => files.get(name) ?? null);
  const onWarn = vi.fn();
  const shared = createSharedIndex({
    store: { list: async () => [...files.keys()], read } as unknown as SearchTabDeps["store"] & { list: () => Promise<string[]> },
    decode: async () => dataA(),
    indexer: { onEvent: (_l: (e: IndexerEvent) => void) => () => undefined },
    onWarn,
  });
  sharedInstances.push(shared);
  void shared.start();
  const handle = { dispose: vi.fn(), ready: Promise.resolve(ATTACHED as never) };
  const openPdfAtPage = vi.fn(async (..._args: unknown[]) => handle);
  const host = document.createElement("div");
  document.body.append(host);
  const deps: SearchTabDeps = {
    store: { read } as unknown as SearchTabDeps["store"],
    sharedIndex: shared,
    decodePageMatches: vi.fn(async () => ({
      boxes: [{ x: 0.5, y: 0.6, width: 0.2, height: 0.05 }],
      ordinals: [0],
      pageSize: { widthPt: 595, heightPt: 842 },
      termIndexes: [0],
    })) as unknown as NonNullable<SearchTabDeps["decodePageMatches"]>,
    openTab: vi.fn(),
    app: { id: "app" },
    openPdfAtPage: openPdfAtPage as unknown as NonNullable<SearchTabDeps["openPdfAtPage"]>,
    loadDocument: async () => {
      throw new Error("pas de rendu dans ce test");
    },
    createCanvas: () => {
      throw new Error("pas de canvas dans ce test");
    },
    observerFactory: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
    cache: { get: async () => undefined, put: async () => undefined, clear: async () => undefined },
    onWarn,
    openMenu: natives.openMenu,
    openDialog: natives.openDialog,
    ...(natives.openCustomDialog ? { openCustomDialog: natives.openCustomDialog } : {}),
    openInputDialog,
    openConfirmDialog,
    ...over,
  };
  return { host, deps, onWarn, openPdfAtPage, handle, read };
}

export async function submitQuery(host: HTMLElement, text: string): Promise<void> {
  const field = host.querySelector<HTMLInputElement>("input")!;
  field.value = text;
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(500);
  await flush();
}
export const cards = (host: HTMLElement): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>("button.docseeker-card")];
export const input = (host: HTMLElement): HTMLInputElement => host.querySelector<HTMLInputElement>("input")!;
export const button = (host: HTMLElement, label: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`.docseeker-icons button[aria-label="${label}"]`);
