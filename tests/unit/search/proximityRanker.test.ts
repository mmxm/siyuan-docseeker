import { describe, expect, it, vi } from "vitest";
import type { WordBox } from "../../../src/core/codec/format";
import type { PageMatch } from "../../../src/core/codec/decode";
import { PROXIMITY_PAGES, RERANK_WINDOW } from "../../../src/core/constants";
import {
  RERANK_MAX_DOCS,
  createProximityRanker,
  type ProximityResult,
  type RankableDoc,
} from "../../../src/search/proximityRanker";

const box = (x: number): WordBox => ({ x, y: 0.1, width: 0.05, height: 0.02 });
/** Deux mots côte à côte (une occurrence à 2 mots distincts). */
const ADJACENT: PageMatch = { boxes: [box(0.1), box(0.16)], ordinals: [0, 1], termIndexes: [0, 1] };
/** Deux mots éloignés de 300 pt. */
const FAR: PageMatch = { boxes: [box(0.1), box(0.7)], ordinals: [0, 1], termIndexes: [0, 1] };

const doc = (n: number, relevance = 1000 - n, pages = [1, 2]): RankableDoc => ({
  docId: `d${n}`,
  title: `Doc ${String(n).padStart(3, "0")}`,
  relevance,
  pages: pages.map((page, i) => ({ page, score: 10 - i })),
});

interface FakeOptions {
  adjacent?: ReadonlySet<string>;
  fail?: ReadonlySet<string>;
  noIndexes?: ReadonlySet<string>;
  delayMs?: number;
}

function fakeService(options: FakeOptions = {}) {
  const calls: { docId: string; page: number }[] = [];
  const openDocs = new Set<string>();
  let maxOpen = 0;
  const getPageMatches = vi.fn(async (docId: string, page: number, _query: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    calls.push({ docId, page });
    openDocs.add(docId);
    maxOpen = Math.max(maxOpen, openDocs.size);
    await new Promise((r) => setTimeout(r, options.delayMs ?? 1));
    openDocs.delete(docId);
    if (options.fail?.has(docId)) throw new Error(`boom ${docId}`);
    if (options.noIndexes?.has(docId)) return { boxes: ADJACENT.boxes, ordinals: ADJACENT.ordinals };
    return options.adjacent?.has(docId) ? ADJACENT : FAR;
  });
  return { getPageMatches, calls, maxOpen: () => maxOpen };
}

const ids = (docs: readonly RankableDoc[]): string[] => docs.map((d) => d.docId);


describe("createProximityRanker", () => {
  it("constants", () => {
    expect(RERANK_MAX_DOCS).toBe(60);
    expect(PROXIMITY_PAGES).toBe(5);
  });

  it("does nothing for a single-word query", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const docs = [doc(1), doc(2)];
    const out = await ranker.rank("contrat", docs, {});
    await out.done;
    expect(svc.calls).toEqual([]);
    expect(out.docs).toEqual(docs);
    expect(out.bonusByDoc.size).toBe(0);
    expect(out.pagesOrderByDoc.size).toBe(0);
  });

  it("does nothing for an empty list or an unsearchable query", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    expect((await ranker.rank("contrat travail", [], {})).docs).toEqual([]);
    expect((await ranker.rank("  ", [doc(1)], {})).docs).toHaveLength(1);
    expect(svc.calls).toEqual([]);
  });

  it("moves an adjacent-words document ahead of a better BM25 one and reports its bonus", async () => {
    const svc = fakeService({ adjacent: new Set(["d2"]) });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const out = await ranker.rank("contrat travail", [doc(1, 1000), doc(2, 900)], {});
    expect(ids(out.docs)).toEqual(["d2", "d1"]);
    expect(out.bonusByDoc.get("d2")).toBe(5000);
    expect(out.bonusByDoc.get("d1")).toBe(0);
    expect(svc.getPageMatches).toHaveBeenCalledWith("d2", 1, "contrat travail", undefined);
  });

  it("orders pages by distinct words, then score, then page", async () => {
    const getPageMatches = vi.fn(async (_d: string, page: number) => (page === 3 ? ADJACENT : FAR));
    const ranker = createProximityRanker({ getPageMatches });
    const d: RankableDoc = { docId: "x", title: "X", relevance: 1, pages: [{ page: 1, score: 9 }, { page: 2, score: 8 }, { page: 3, score: 1 }] };
    const out = await ranker.rank("contrat travail", [d], {});
    expect(out.pagesOrderByDoc.get("x")).toEqual([3, 1, 2]);
  });

  it("only measures the first PROXIMITY_PAGES pages of each document", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    await ranker.rank("contrat travail", [doc(1, 10, [1, 2, 3, 4, 5, 6, 7])], {});
    expect(svc.calls.map((c) => c.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never decodes more than 2 documents at once", async () => {
    const svc = fakeService({ delayMs: 3 });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    await ranker.rank("contrat travail", Array.from({ length: 10 }, (_, i) => doc(i)), {});
    expect(svc.maxOpen()).toBe(2);
  });

  it("returns after window 1 and processes the following windows in the background, up to RERANK_MAX_DOCS", async () => {
    const svc = fakeService({ adjacent: new Set(["d20", "d70"]) });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const seen: ProximityResult<RankableDoc>[] = [];
    const all = Array.from({ length: 100 }, (_, i) => doc(i, 1000 - i));
    const first = await ranker.rank("contrat travail", all, { onWindow: (r) => void seen.push(r) });
    // Le résultat rendu ne couvre que la fenêtre 1 (la suite arrive par onWindow).
    expect(first.docs).toHaveLength(100);
    expect(first.bonusByDoc.size).toBe(RERANK_WINDOW);
    await first.done;
    expect(seen).toHaveLength(RERANK_MAX_DOCS / RERANK_WINDOW - 1);
    expect(new Set(svc.calls.map((c) => c.docId)).size).toBe(RERANK_MAX_DOCS);
    const last = seen[seen.length - 1] as ProximityResult<RankableDoc>;
    expect(last.bonusByDoc.size).toBe(RERANK_MAX_DOCS);
    // d20 (fenêtre 2) est remonté à la tête de sa fenêtre, d70 (hors plafond) n'a pas bougé.
    expect(ids(last.docs).indexOf("d20")).toBe(RERANK_WINDOW);
    expect(ids(last.docs).slice(60)).toEqual(ids(all).slice(60));
    expect(last.bonusByDoc.has("d70")).toBe(false);
  });

  it("rejects at once when already aborted, without any work", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const controller = new AbortController();
    controller.abort();
    await expect(ranker.rank("contrat travail", [doc(1)], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(svc.calls).toEqual([]);
  });

  it("rejects when aborted during window 1 and starts no further document", async () => {
    const svc = fakeService({ delayMs: 5 });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const controller = new AbortController();
    const promise = ranker.rank("contrat travail", Array.from({ length: 10 }, (_, i) => doc(i)), { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 2));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    const after = svc.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.calls.length).toBe(after);
  });

  it("stops the background windows on abort: no further call, no onWindow", async () => {
    const svc = fakeService({ delayMs: 2 });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const controller = new AbortController();
    const onWindow = vi.fn();
    const out = await ranker.rank("contrat travail", Array.from({ length: 60 }, (_, i) => doc(i)), { signal: controller.signal, onWindow });
    controller.abort();
    await out.done;
    const after = svc.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.calls.length).toBe(after);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("gives bonus 0, keeps BM25 order and warns when a document fails to decode", async () => {
    const svc = fakeService({ fail: new Set(["d1"]), adjacent: new Set(["d1", "d2"]) });
    const onWarn = vi.fn();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches, onWarn });
    const out = await ranker.rank("contrat travail", [doc(1, 1000), doc(2, 900), doc(3, 800)], {});
    expect(out.bonusByDoc.get("d1")).toBe(0);
    expect(out.bonusByDoc.get("d2")).toBe(5000);
    expect(ids(out.docs)).toEqual(["d2", "d1", "d3"]);
    expect(out.pagesOrderByDoc.get("d1")).toEqual([1, 2]);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toContain("d1");
    expect(onWarn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("warns instead of guessing when the match carries no term indexes", async () => {
    const svc = fakeService({ noIndexes: new Set(["d1"]) });
    const onWarn = vi.fn();
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches, onWarn });
    const out = await ranker.rank("contrat travail", [doc(1)], {});
    expect(out.bonusByDoc.get("d1")).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    let failing = true;
    const getPageMatches = vi.fn(async () => {
      if (failing) throw new Error("x");
      return ADJACENT;
    });
    const ranker = createProximityRanker({ getPageMatches, onWarn: () => undefined });
    expect((await ranker.rank("contrat travail", [doc(1)], {})).bonusByDoc.get("d1")).toBe(0);
    failing = false;
    expect((await ranker.rank("contrat travail", [doc(1)], {})).bonusByDoc.get("d1")).toBe(5000);
  });

  it("caches per query on docId + top pages", async () => {
    const svc = fakeService({ adjacent: new Set(["d1"]) });
    const ranker = createProximityRanker({ getPageMatches: svc.getPageMatches });
    const docs = [doc(1), doc(2)];
    await ranker.rank("contrat travail", docs, {});
    const n = svc.calls.length;
    expect(n).toBe(4);
    const again = await ranker.rank("contrat  TRAVAIL", docs, {}); // même requête normalisée
    expect(svc.calls.length).toBe(n);
    expect(again.bonusByDoc.get("d1")).toBe(5000);
    // Pages différentes => recalcul de ce seul document.
    await ranker.rank("contrat travail", [doc(1, 1000, [1, 4]), doc(2)], {});
    expect(svc.calls.length).toBe(n + 2);
    // Autre requête => cache vidé.
    await ranker.rank("travail contrat", docs, {});
    expect(svc.calls.length).toBe(n + 2 + 4);
  });
});
