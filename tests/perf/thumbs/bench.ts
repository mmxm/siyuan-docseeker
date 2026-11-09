/**
 * Banc de vignettes dans le navigateur. Page VISIBLE obligatoire (PDF.js n'achève pas un rendu dans un onglet masqué).
 * iPhone : seulement en HTTPS (Safari ralentit fortement en HTTP non sécurisé).
 *
 * Console : `await bench.breakdown(file, pages, opts)`, `await bench.endToEnd(items, "desktop" | "mobile", overrides)`,
 * `await bench.runDefault("pilly" | "text" | "mix", "desktop" | "mobile")`. Résultats dans `bench.out` (JSON).
 *
 * `overrides` d'endToEnd (tous optionnels, passés tels quels, sans dépendre de noms précis) :
 *   profile (fusionné dans le profil), renderer (dans les options de createPdfRenderer), loadPdf (options de createLoadPdf),
 *   getDocument (paramètres ajoutés à chaque getDocument), thumbnailLoader (options de createThumbnailLoader).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLoadPdf } from "../../../src/indexer/loadPdf";
import { desktopProfile, mobileProfile } from "../../../src/platform/profile";
import { MemoryThumbnailCache } from "../../../src/search/thumbnailCache";
import { PDFJS_GETDOCUMENT_RESOURCES } from "../../../src/siyuan/pdfjsLoader";
import { createPdfRenderer } from "../../../src/siyuan/pdfRenderer";
import { createThumbnailLoader } from "../../../src/ui/thumbnailLoader";
import { DEFAULT_SCENARIOS, expandScenario, matchCorpusName, summarizeReady, type ThumbItem } from "./benchTools";

type Any = any;
type ProfileName = "desktop" | "mobile";
export interface EndToEndOverrides {
  profile?: Record<string, unknown>;
  renderer?: Record<string, unknown>;
  loadPdf?: Record<string, unknown>;
  getDocument?: Record<string, unknown>;
  thumbnailLoader?: Record<string, unknown>;
  label?: string;
}

const logEl = document.getElementById("log") as HTMLElement;
const out: unknown[] = [];
const log = (o: unknown): void => {
  out.push(o);
  logEl.textContent = out.map((x) => JSON.stringify(x)).join("\n");
};

async function pdfjs(): Promise<Any> {
  const w = window as Any;
  const src = ["/stage/protyle/js/pdf/pdf.min.mjs", "v=6.4.299-siyuan.1"].join("?");
  if (!w.pdfjsLib) await import(/* @vite-ignore */ src);
  w.pdfjsLib.GlobalWorkerOptions.workerSrc ||= "/stage/protyle/js/pdf/pdf.worker.compat.mjs?v=6.4.299-siyuan.2";
  return w.pdfjsLib;
}
const stats = async (): Promise<Any> => (await fetch("/__stats")).json();
const reset = (): Promise<Response> => fetch("/__reset");
const now = (): number => performance.now();
const r = (x: number): number => Math.round(x);
const heap = (): number => ((performance as Any).memory?.usedJSHeapSize ?? 0) / 1048576;

/** Nom réel dans le corpus (NFC/NFD). */
async function corpusName(wanted: string): Promise<string> {
  const names: string[] = await (await fetch("/__list")).json();
  const found = matchCorpusName(names, wanted);
  if (found === undefined) throw new Error(`absent du corpus : ${wanted}`);
  return found;
}

function midCrop(w: number, h: number): { x0: number; y0: number; width: number; height: number } {
  const cw = Math.min(300, w);
  const ch = Math.min(120, h);
  return { x0: (w - cw) / 2, y0: h / 2 - ch / 2, width: cw, height: ch };
}
function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function toBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob null"))), type, q));
}

/** (A) décomposition par page : ouverture, getPage, getOperatorList, dessin, encodage, second recadrage, page entière. */
export async function breakdown(
  file: string,
  pages: number[],
  opts: { autoFetch: boolean; scale: number; extra?: object },
): Promise<void> {
  const lib = await pdfjs();
  const real = await corpusName(file);
  await reset();
  const t0 = now();
  const task = lib.getDocument({
    url: `/assets/${encodeURIComponent(real)}`,
    ...PDFJS_GETDOCUMENT_RESOURCES,
    ...(opts.autoFetch ? {} : { disableAutoFetch: true, disableStream: false }),
    ...(opts.extra ?? {}),
  });
  const doc = await task.promise;
  const open = r(now() - t0);
  const afterOpen = await stats();
  log({ file, ...opts, open, openBytesKB: r(afterOpen.bytes / 1024), numPages: doc.numPages });
  for (const p of pages) {
    const s0 = await stats();
    const a = now();
    const page = await doc.getPage(p);
    const b = now();
    await page.getOperatorList();
    const c = now();
    const vp1 = page.getViewport({ scale: 1 });
    const crop = midCrop(vp1.width, vp1.height);
    const s = opts.scale;
    const canvas = canvasOf(Math.ceil(crop.width * s), Math.ceil(crop.height * s));
    const vp = page.getViewport({ scale: s });
    await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport: vp, transform: [1, 0, 0, 1, -crop.x0 * s, -crop.y0 * s] }).promise;
    const d = now();
    const webp = await toBlob(canvas, "image/webp", 0.8);
    const e = now();
    const png = await toBlob(canvas, "image/png");
    const jpg = await toBlob(canvas, "image/jpeg", 0.8);
    const f = now();
    const c2 = canvasOf(canvas.width, canvas.height);
    await page.render({ canvasContext: c2.getContext("2d"), canvas: c2, viewport: vp, transform: [1, 0, 0, 1, -crop.x0 * s, -(crop.y0 + 150) * s] }).promise;
    const g = now();
    const vpH = page.getViewport({ scale: 0.5 });
    const c3 = canvasOf(Math.ceil(vpH.width), Math.ceil(vpH.height));
    await page.render({ canvasContext: c3.getContext("2d"), canvas: c3, viewport: vpH }).promise;
    const h = now();
    const s1 = await stats();
    log({
      page: p, getPage: r(b - a), opList: r(c - b), draw: r(d - c), webp: r(e - d), webpKB: +(webp.size / 1024).toFixed(1),
      pngKB: +(png.size / 1024).toFixed(1), jpgKB: +(jpg.size / 1024).toFixed(1), redrawSamePage: r(g - f), fullPage05: r(h - g),
      bytesKB: r((s1.bytes - s0.bytes) / 1024), px: `${canvas.width}x${canvas.height}`, heapMB: r(heap()),
    });
    page.cleanup();
  }
  await task.destroy();
}

/** (B) bout en bout : vrai thumbnailLoader + pdfRenderer + loadPdf, un cadre par item, temps jusqu'à « ready ». */
export async function endToEnd(items: ThumbItem[], profileName: ProfileName, overrides: EndToEndOverrides = {}): Promise<unknown> {
  const lib = await pdfjs();
  const profile: Any = { ...(profileName === "desktop" ? desktopProfile() : mobileProfile()), ...(overrides.profile ?? {}) };
  const getPdfjs = overrides.getDocument
    ? () => ({ ...lib, GlobalWorkerOptions: lib.GlobalWorkerOptions, getDocument: (src: Any) => lib.getDocument({ ...src, ...overrides.getDocument }) })
    : () => lib;
  const loadPdf = createLoadPdf(getPdfjs as Any, (m: string) => console.warn(m), {
    rangeOnly: true, // comme le rendu en production (src/index.ts)
    ...(profile.canvasMaxAreaInBytes ? { canvasMaxAreaInBytes: profile.canvasMaxAreaInBytes } : {}),
    ...(overrides.loadPdf ?? {}),
  } as Any);
  const renderer = createPdfRenderer({
    loadDocument: (path: string, signal?: AbortSignal) => loadPdf(path, signal ?? new AbortController().signal) as Any,
    createCanvas: canvasOf as Any,
    concurrency: profile.renderConcurrency,
    maxOpenDocuments: profile.maxOpenDocuments,
    workersPerDocument: profile.workersPerDocument,
    onWarn: (m: string, e?: unknown) => console.warn(m, e),
    ...(overrides.renderer ?? {}),
  } as Any);
  const loader = createThumbnailLoader({
    observerFactory: (cb: Any) => new IntersectionObserver((entries) => cb(entries as Any), { rootMargin: "200px 0px" }),
    getPageMatches: async () => ({ boxes: [{ x: 0.45, y: 0.5, width: 0.1, height: 0.015 }], ordinals: [0], pageSize: { widthPt: 595, heightPt: 842 } }) as Any,
    renderer: renderer as Any,
    cache: new MemoryThumbnailCache({ maxEntries: 2000, maxBytes: 64 << 20 }),
    docVersion: 1,
    cropScale: profile.cropScale,
    onWarn: (m: string, e?: unknown) => console.warn(m, e),
    ...(overrides.thumbnailLoader ?? {}),
  } as Any);
  const names: string[] = await (await fetch("/__list")).json();
  // Taille réelle (octets) : le renderer n'ouvre plusieurs workers que pour les PDF lourds (HEAVY_PDF_BYTES).
  const sizes = new Map<string, number>();
  for (const it of items) {
    const real = matchCorpusName(names, it.file) ?? it.file;
    if (sizes.has(real)) continue;
    const head = await fetch(`/assets/${encodeURIComponent(real)}`, { method: "HEAD" });
    sizes.set(real, Number(head.headers.get("Content-Length") ?? 0));
  }
  const grid = document.getElementById("grid") as HTMLElement;
  grid.replaceChildren();
  await reset();
  const t0 = now();
  const ready: number[] = [];
  const observers: MutationObserver[] = [];
  await new Promise<void>((resolve) => {
    items.forEach((it, i) => {
      const real = matchCorpusName(names, it.file) ?? it.file;
      const el = document.createElement("div");
      grid.appendChild(el);
      const mo = new MutationObserver(() => {
        if (el.dataset["state"] !== "ready" && el.dataset["state"] !== "error") return;
        if (ready[i] === undefined) ready[i] = el.dataset["state"] === "error" ? -r(now() - t0) : r(now() - t0);
        if (ready.filter((x) => x !== undefined).length === items.length) resolve();
      });
      mo.observe(el, { attributes: true, attributeFilter: ["data-state"] });
      observers.push(mo);
      loader.attach(el, { docId: real, path: `assets/${real}`, page: it.page, query: "x", pdfSize: sizes.get(real) ?? 0, pdfModifiedMs: 1 } as Any);
    });
  });
  const st = await stats();
  const result = {
    e2e: profileName, label: overrides.label, overrides: { ...overrides, label: undefined }, n: items.length,
    ...summarizeReady(ready), readyMs: ready, MB: +(st.bytes / 1048576).toFixed(1), requests: st.requests, heapMB: r(heap()),
  };
  log(result);
  observers.forEach((o) => o.disconnect());
  loader.dispose();
  renderer.dispose();
  return result;
}

/** Scénario par défaut : « pilly » (12 pages), « text » (027, pages 1-10), « mix » (5 PDF). */
export function runDefault(name: keyof typeof DEFAULT_SCENARIOS, profileName: ProfileName, overrides: EndToEndOverrides = {}): Promise<unknown> {
  return endToEnd(expandScenario(DEFAULT_SCENARIOS[name]), profileName, { label: `${name}/${profileName}`, ...overrides });
}

const bench = { breakdown, endToEnd, runDefault, out, scenarios: DEFAULT_SCENARIOS };
(window as Any).bench = bench;

const buttons = document.getElementById("buttons") as HTMLElement;
for (const name of Object.keys(DEFAULT_SCENARIOS) as (keyof typeof DEFAULT_SCENARIOS)[]) {
  for (const profileName of ["desktop", "mobile"] as const) {
    const b = document.createElement("button");
    b.textContent = `${name} / ${profileName}`;
    b.onclick = () => void runDefault(name, profileName).catch((e) => log({ error: String(e) }));
    buttons.appendChild(b);
  }
}
const bd = document.createElement("button");
bd.textContent = "breakdown pilly (3 pages)";
bd.onclick = () =>
  void breakdown(DEFAULT_SCENARIOS.pilly[0]?.file ?? "", [12, 120, 300], { autoFetch: true, scale: 2 }).catch((e) => log({ error: String(e) }));
buttons.appendChild(bd);
log("bench chargé");
