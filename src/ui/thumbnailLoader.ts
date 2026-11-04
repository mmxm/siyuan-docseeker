/**
 * Chargeur paresseux de vignettes : un cadre à ratio réservé est rempli quand il entre dans le viewport.
 *
 * Clé de cache : `thumbnailKey(...)` + `:q<hash>` où le hash porte sur la requête normalisée. Le recadrage
 * dépend des mots trouvés, donc de la requête ; le Blob ne contient aucun surlignage (dessiné en `<div>`
 * par-dessus), mais deux requêtes différentes peuvent produire deux recadrages différents.
 * Les surlignages sont toujours recalculés (matches + taille de page, peu coûteux) ; seul le rendu
 * du recadrage (coûteux) est mis en cache.
 */
import { tokenize } from "../core/normalize";
import { thumbnailKey, type ThumbnailCache } from "../search/thumbnailCache";
import { planThumbnail, type PageSize, type ThumbnailPlan } from "../search/thumbnailPlan";
import type { PageMatch } from "../core/codec/decode";
import type { CropBounds } from "../core/crop";

export interface ThumbnailRenderer {
  getPageSize(path: string, page: number, signal?: AbortSignal): Promise<PageSize>;
  renderCrop(args: {
    path: string;
    page: number;
    crop: CropBounds;
    scale: number;
    signal?: AbortSignal;
  }): Promise<Blob>;
}

export interface ThumbnailObserver {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export interface ThumbnailRequest {
  docId: string;
  path: string;
  page: number;
  query: string;
  pdfSize: number;
  pdfModifiedMs: number;
}

export interface ThumbnailLoaderOptions {
  observerFactory: (cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) => ThumbnailObserver;
  getPageMatches: (docId: string, page: number, query: string, signal?: AbortSignal) => Promise<PageMatch>;
  renderer: ThumbnailRenderer;
  cache: ThumbnailCache;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  docVersion: number;
  onWarn?: (message: string, error?: unknown) => void;
}

export interface ThumbnailLoader {
  attach(el: HTMLElement, req: ThumbnailRequest): () => void;
  dispose(): void;
}

export const HIGHLIGHT_ATTRIBUTE = "data-docseeker-highlight";

interface Slot {
  el: HTMLElement;
  req: ThumbnailRequest;
  controller?: AbortController | undefined;
  url?: string | undefined;
  img?: HTMLImageElement | undefined;
  highlights: HTMLElement[];
}

function queryHash(query: string): string {
  const text = tokenize(query).join(" ");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createThumbnailLoader(options: ThumbnailLoaderOptions): ThumbnailLoader {
  const { renderer, cache, docVersion } = options;
  const createUrl = options.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = options.revokeObjectUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const slots = new Map<Element, Slot>();

  const warn = (message: string, error?: unknown): void => {
    try {
      options.onWarn?.(message, error);
    } catch {
      // un onWarn défaillant ne doit rien casser
    }
  };

  const observer = options.observerFactory((entries) => {
    for (const entry of entries) {
      const slot = slots.get(entry.target);
      if (!slot) continue;
      if (entry.isIntersecting) {
        if (!slot.controller && slot.el.dataset.state !== "ready") void load(slot);
      } else {
        reset(slot);
      }
    }
  });

  function clearContent(slot: Slot): void {
    for (const h of slot.highlights) h.remove();
    slot.highlights = [];
    slot.img?.remove();
    slot.img = undefined;
    if (slot.url !== undefined) {
      revokeUrl(slot.url);
      slot.url = undefined;
    }
  }

  /** Annule le travail en cours, libère l'image et revient à idle. */
  function reset(slot: Slot): void {
    slot.controller?.abort();
    slot.controller = undefined;
    clearContent(slot);
    slot.el.dataset.state = "idle";
    slot.el.removeAttribute("aria-busy");
    slot.el.removeAttribute("aria-label");
  }

  function show(slot: Slot, blob: Blob, plan: ThumbnailPlan): void {
    const url = createUrl(blob);
    slot.url = url;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.style.cssText = "display:block;width:100%;height:100%;object-fit:cover";
    slot.el.appendChild(img);
    slot.img = img;
    const w = plan.crop.width * plan.scale;
    const h = plan.crop.height * plan.scale;
    for (const r of plan.highlights) {
      const d = document.createElement("div");
      d.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
      d.style.cssText =
        `position:absolute;left:${(r.x / w) * 100}%;top:${(r.y / h) * 100}%;` +
        `width:${(r.width / w) * 100}%;height:${(r.height / h) * 100}%;pointer-events:none`;
      slot.el.appendChild(d);
      slot.highlights.push(d);
    }
  }

  async function load(slot: Slot): Promise<void> {
    const controller = new AbortController();
    slot.controller = controller;
    const { signal } = controller;
    const { el, req } = slot;
    el.dataset.state = "loading";
    el.setAttribute("aria-busy", "true");
    try {
      const match = await options.getPageMatches(req.docId, req.page, req.query, signal);
      const size = await renderer.getPageSize(req.path, req.page, signal);
      const plan = planThumbnail(match.boxes, match.ordinals, size);
      const key = `${thumbnailKey({
        docId: req.docId,
        pdfSize: req.pdfSize,
        pdfModifiedMs: req.pdfModifiedMs,
        page: req.page,
        version: docVersion,
      })}:q${queryHash(req.query)}`;
      let blob = await cache.get(key);
      if (!blob) {
        blob = await renderer.renderCrop({ path: req.path, page: req.page, crop: plan.crop, scale: plan.scale, signal });
        if (signal.aborted) return;
        await cache.put(key, blob);
      }
      if (signal.aborted) return;
      show(slot, blob, plan);
      slot.controller = undefined;
      el.dataset.state = "ready";
      el.removeAttribute("aria-busy");
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;
      slot.controller = undefined;
      warn("Vignette indisponible", error);
      clearContent(slot);
      el.dataset.state = "error";
      el.removeAttribute("aria-busy");
      el.setAttribute("aria-label", "Aperçu indisponible");
    }
  }

  return {
    attach(el, req) {
      const slot: Slot = { el, req, highlights: [] };
      slots.set(el, slot);
      el.dataset.state = "idle";
      observer.observe(el);
      return () => {
        if (slots.get(el) !== slot) return;
        slots.delete(el);
        observer.unobserve(el);
        reset(slot);
      };
    },
    dispose() {
      for (const slot of [...slots.values()]) reset(slot);
      slots.clear();
      observer.disconnect();
    },
  };
}
