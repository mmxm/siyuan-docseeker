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

// Hauteur 0,01 de page = 8,42 pt (< 10 pt) : aucun bonus de police, les tests de proximité restent isolés.
// Le bonus de police est couvert plus bas.
const box = (x: number, height = 0.01): WordBox => ({ x, y: 0.1, width: 0.05, height });
/** Deux mots côte à côte (une occurrence à 2 mots distincts). */
const PAGE_SIZE = { widthPt: 595, heightPt: 842 };
const ADJACENT: PageMatch = { boxes: [box(0.1), box(0.16)], ordinals: [0, 1], pageSize: PAGE_SIZE, termIndexes: [0, 1] };
/** Deux mots éloignés de 300 pt. */
const FAR: PageMatch = { boxes: [box(0.1), box(0.7)], ordinals: [0, 1], pageSize: PAGE_SIZE, termIndexes: [0, 1] };

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
    if (options.noIndexes?.has(docId)) return { boxes: ADJACENT.boxes, ordinals: ADJACENT.ordinals, pageSize: PAGE_SIZE };
    return options.adjacent?.has(docId) ? ADJACENT : FAR;
  });
  const getPagesMatches = vi.fn(async (docId: string, pages: readonly number[], query: string, signal?: AbortSignal) => {
    const out = new Map<number, PageMatch>();
    for (const page of pages) out.set(page, await getPageMatches(docId, page, query, signal));
    return out;
  });
  return { getPageMatches, getPagesMatches, calls, maxOpen: () => maxOpen };
}

/** Adapte un décodeur page par page à la dépendance `getPagesMatches`. */
const perPage =
  (fn: (docId: string, page: number) => Promise<PageMatch>) =>
  async (docId: string, pages: readonly number[]): Promise<Map<number, PageMatch>> => {
    const out = new Map<number, PageMatch>();
    for (const page of pages) out.set(page, await fn(docId, page));
    return out;
  };

const ids = (docs: readonly RankableDoc[]): string[] => docs.map((d) => d.docId);


describe("createProximityRanker", () => {
  it("constants", () => {
    expect(RERANK_MAX_DOCS).toBe(60);
    expect(PROXIMITY_PAGES).toBe(5);
  });

  it("measures a single-word query too: no multi-word bonus, font bonus only", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const docs = [doc(1), doc(2)];
    const out = await ranker.rank("contrat", docs, {});
    await out.done;
    expect(svc.calls.map((c) => c.docId).sort()).toEqual(["d1", "d1", "d2", "d2"]);
    expect(out.bonusByDoc.get("d1")).toBe(0);
    expect(out.bonusByDoc.get("d2")).toBe(0);
  });

  it("does nothing for an empty list or an unsearchable query", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    expect((await ranker.rank("contrat travail", [], {})).docs).toEqual([]);
    expect((await ranker.rank("  ", [doc(1)], {})).docs).toHaveLength(1);
    expect(svc.calls).toEqual([]);
  });

  it("moves an adjacent-words document ahead of a better BM25 one and reports its bonus", async () => {
    const svc = fakeService({ adjacent: new Set(["d2"]) });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const out = await ranker.rank("contrat travail", [doc(1, 1000), doc(2, 900)], {});
    expect(ids(out.docs)).toEqual(["d2", "d1"]);
    expect(out.bonusByDoc.get("d2")).toBe(5000);
    expect(out.bonusByDoc.get("d1")).toBe(0);
    expect(svc.getPagesMatches).toHaveBeenCalledWith("d2", [1, 2], "contrat travail", undefined);
  });

  it("orders pages by distinct words, then score, then page", async () => {
    const getPageMatches = vi.fn(async (_d: string, page: number) => (page === 3 ? ADJACENT : FAR));
    const ranker = createProximityRanker({ getPagesMatches: perPage(getPageMatches) });
    const d: RankableDoc = { docId: "x", title: "X", relevance: 1, pages: [{ page: 1, score: 9 }, { page: 2, score: 8 }, { page: 3, score: 1 }] };
    const out = await ranker.rank("contrat travail", [d], {});
    expect(out.pagesOrderByDoc.get("x")).toEqual([3, 1, 2]);
  });

  it("only measures the first PROXIMITY_PAGES pages of each document", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    await ranker.rank("contrat travail", [doc(1, 10, [1, 2, 3, 4, 5, 6, 7])], {});
    expect(svc.calls.map((c) => c.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it("decodes one document at a time (the CPU is single-threaded)", async () => {
    const svc = fakeService({ delayMs: 3 });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    await ranker.rank("contrat travail", Array.from({ length: 10 }, (_, i) => doc(i)), {});
    expect(svc.maxOpen()).toBe(1);
  });

  it("yields to the main thread between two measured documents, never before the first", async () => {
    const events: string[] = [];
    const getPagesMatches = vi.fn(async (docId: string, pages: readonly number[]) => {
      events.push(`measure ${docId}`);
      return new Map(pages.map((p) => [p, FAR] as const));
    });
    const yieldToMain = vi.fn(async () => void events.push("yield"));
    const ranker = createProximityRanker({ getPagesMatches, yieldToMain });
    await ranker.rank("contrat travail", [doc(1), doc(2), doc(3)], {});
    expect(events).toEqual(["measure d1", "yield", "measure d2", "yield", "measure d3"]);
  });

  it("does not yield for documents served from the cache", async () => {
    const getPagesMatches = vi.fn(async (_d: string, pages: readonly number[]) => new Map(pages.map((p) => [p, FAR] as const)));
    const yieldToMain = vi.fn(async () => undefined);
    const ranker = createProximityRanker({ getPagesMatches, yieldToMain });
    await ranker.rank("contrat travail", [doc(1), doc(2)], {});
    yieldToMain.mockClear();
    await ranker.rank("contrat travail", [doc(1), doc(2)], {});
    expect(yieldToMain).not.toHaveBeenCalled();
  });

  it("yields across window boundaries too (background windows included)", async () => {
    const getPagesMatches = vi.fn(async (_d: string, pages: readonly number[]) => new Map(pages.map((p) => [p, FAR] as const)));
    const yieldToMain = vi.fn(async () => undefined);
    const ranker = createProximityRanker({ getPagesMatches, yieldToMain });
    const out = await ranker.rank("contrat travail", Array.from({ length: RERANK_WINDOW * 2 }, (_, i) => doc(i + 1)), {});
    await out.done;
    expect(yieldToMain).toHaveBeenCalledTimes(RERANK_WINDOW * 2 - 1);
  });

  it("stops at an abort raised while yielding", async () => {
    const controller = new AbortController();
    const getPagesMatches = vi.fn(async (_d: string, pages: readonly number[]) => new Map(pages.map((p) => [p, FAR] as const)));
    const yieldToMain = vi.fn(async () => controller.abort());
    const ranker = createProximityRanker({ getPagesMatches, yieldToMain });
    await expect(
      ranker.rank("contrat travail", [doc(1), doc(2), doc(3)], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getPagesMatches).toHaveBeenCalledTimes(1);
  });

  it("returns after window 1 and processes the following windows in the background, up to RERANK_MAX_DOCS", async () => {
    const svc = fakeService({ adjacent: new Set(["d20", "d70"]) });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
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
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const controller = new AbortController();
    controller.abort();
    await expect(ranker.rank("contrat travail", [doc(1)], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(svc.calls).toEqual([]);
  });

  it("rejects when aborted during window 1 and starts no further document", async () => {
    const svc = fakeService({ delayMs: 5 });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
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
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
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
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn });
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
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn });
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
    const ranker = createProximityRanker({ getPagesMatches: perPage(getPageMatches), onWarn: () => undefined });
    expect((await ranker.rank("contrat travail", [doc(1)], {})).bonusByDoc.get("d1")).toBe(0);
    failing = false;
    expect((await ranker.rank("contrat travail", [doc(1)], {})).bonusByDoc.get("d1")).toBe(5000);
  });

  it("caches per query on docId + top pages", async () => {
    const svc = fakeService({ adjacent: new Set(["d1"]) });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
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
  it("invalidate(docId) drops that document from the cache so it is measured again", async () => {
    const svc = fakeService({ adjacent: new Set(["d1"]) });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const docs = [doc(1), doc(2)];
    await ranker.rank("contrat travail", docs, {});
    const n = svc.calls.length;
    ranker.invalidate("d1");
    await ranker.rank("contrat travail", docs, {});
    expect(svc.calls.slice(n).map((c) => c.docId)).toEqual(["d1", "d1"]);
  });

  it("invalidate during a measurement does not cache the stale result", async () => {
    const svc = fakeService({ adjacent: new Set(["d1"]), delayMs: 5 });
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const docs = [doc(1)];
    const first = ranker.rank("contrat travail", docs, {});
    ranker.invalidate("d1");
    await first;
    const n = svc.calls.length;
    await ranker.rank("contrat travail", docs, {});
    expect(svc.calls.length).toBeGreaterThan(n);
  });
  it("decodes each document once: one getPagesMatches call carrying its top pages", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    await ranker.rank("contrat travail", [doc(1, 10, [1, 2, 3, 4, 5, 6, 7]), doc(2)], {});
    expect(svc.getPagesMatches).toHaveBeenCalledTimes(2);
    expect(svc.getPagesMatches.mock.calls[0]?.[1]).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports failedDocIds and aggregates failures into a single warning (count + first detail)", async () => {
    const svc = fakeService({ fail: new Set(["d1", "d2"]) });
    const onWarn = vi.fn();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn });
    const out = await ranker.rank("contrat travail", [doc(1), doc(2), doc(3)], {});
    expect([...out.failedDocIds].sort()).toEqual(["d1", "d2"]);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toContain("2 document");
    expect(onWarn.mock.calls[0]?.[0]).toContain("d1");
    expect(onWarn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("a rejecting yieldToMain fails only the document being measured (failedDocIds + warning) and keeps the next ones", async () => {
    const svc = fakeService({ adjacent: new Set(["d1", "d3"]) });
    const onWarn = vi.fn();
    const yieldToMain = vi.fn().mockRejectedValueOnce(new Error("yield boom")).mockResolvedValue(undefined);
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn, yieldToMain });
    const out = await ranker.rank("contrat travail", [doc(1), doc(2), doc(3)], {});
    expect([...out.failedDocIds]).toEqual(["d2"]);
    expect(out.bonusByDoc.get("d2")).toBe(0);
    expect(out.bonusByDoc.get("d1")).toBeGreaterThan(0);
    expect(out.bonusByDoc.get("d3")).toBeGreaterThan(0); // le document suivant est bien mesuré
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("reports no failure when everything is measured", async () => {
    const svc = fakeService();
    const onWarn = vi.fn();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn });
    const out = await ranker.rank("contrat travail", [doc(1)], {});
    expect(out.failedDocIds.size).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("a throwing onWindow callback is reported separately and does not stop the next windows", async () => {
    const svc = fakeService();
    const onWarn = vi.fn();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches, onWarn });
    const docs = Array.from({ length: RERANK_WINDOW * 3 }, (_, i) => doc(i + 1));
    const onWindow = vi.fn(() => {
      throw new Error("render exploded");
    });
    const out = await ranker.rank("contrat travail", docs, { onWindow });
    await out.done;
    expect(onWindow).toHaveBeenCalledTimes(2);
    const messages = onWarn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes("onWindow"))).toHaveLength(2);
    expect(messages.some((m) => m.includes("background reranking failed"))).toBe(false);
  });

  it("keeps caching normally for a new query after invalidations on the previous one", async () => {
    const svc = fakeService();
    const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
    const docs = [doc(1)];
    await ranker.rank("contrat travail", docs, {});
    ranker.invalidate("d1");
    await ranker.rank("travail contrat", docs, {});
    const n = svc.getPagesMatches.mock.calls.length;
    await ranker.rank("travail contrat", docs, {});
    expect(svc.getPagesMatches.mock.calls.length).toBe(n);
  });

  describe("font size (phase 2)", () => {
    const big = (heightPt: number, extra: Partial<PageMatch> = {}): PageMatch => ({
      boxes: [box(0.1, heightPt / 842), box(0.7, 0.01)],
      ordinals: [0],
      pageSize: PAGE_SIZE,
      termIndexes: [0],
      ...extra,
    });
    const rankOne = async (query: string, byPage: Record<number, PageMatch>, pages = [1, 2]) => {
      const getPagesMatches = vi.fn(async (_d: string, wanted: readonly number[]) =>
        new Map(wanted.map((p) => [p, byPage[p] as PageMatch] as const)),
      );
      const ranker = createProximityRanker({ getPagesMatches });
      const d: RankableDoc = { docId: "x", title: "X", relevance: 1, pages: pages.map((page, i) => ({ page, score: 9 - i })) };
      return ranker.rank(query, [d], {});
    };

    it("adds the font bonus for a one-word query: (best size - 10) x 25, from the largest occurrence of the document", async () => {
      const out = await rankOne("contrat", { 1: big(12), 2: big(14) });
      expect(out.bonusByDoc.get("x")).toBeCloseTo(100, 6);
    });

    it("gives no bonus at 10 pt and caps at 400", async () => {
      expect((await rankOne("contrat", { 1: big(10), 2: big(9) })).bonusByDoc.get("x")).toBe(0);
      expect((await rankOne("contrat", { 1: big(60), 2: big(9) })).bonusByDoc.get("x")).toBe(400);
    });

    it("adds the font bonus to the multi-word bonus, also for an isolated large word", async () => {
      const adjacent: PageMatch = { boxes: [box(0.1), box(0.16)], ordinals: [0, 1], pageSize: PAGE_SIZE, termIndexes: [0, 1] };
      const isolated = big(14);
      const out = await rankOne("contrat travail", { 1: adjacent, 2: isolated });
      expect(out.bonusByDoc.get("x")).toBeCloseTo(5000 + 100, 6);
    });

    it("uses the real page height of each page", async () => {
      const letter = big(12, { pageSize: { widthPt: 612, heightPt: 792 } }); // 12/842 x 792 = 11,29 pt
      expect((await rankOne("contrat", { 1: letter, 2: big(9) })).bonusByDoc.get("x")).toBeCloseTo(32.5, 6);
    });

    it("orders pages by distinct words, then font size, then score", async () => {
      const out = await rankOne("contrat", { 1: big(12), 2: big(20), 3: big(12) }, [1, 2, 3]);
      expect(out.pagesOrderByDoc.get("x")).toEqual([2, 1, 3]);
    });

    it("ranks a page by its best occurrence (distinct, then font), not by its largest word", async () => {
      // page 1 : occurrence a 2 mots (police 12) + occurrence isolee en 30 pt ; page 2 : un mot en 20 pt.
      const two: PageMatch = {
        boxes: [box(0.1, 12 / 842), box(0.16, 12 / 842), box(0.8, 30 / 842)],
        ordinals: [0, 1, 2],
        pageSize: PAGE_SIZE,
        termIndexes: [0, 1, 0],
      };
      const out = await rankOne("contrat travail", { 1: two, 2: big(20) });
      expect(out.pagesOrderByDoc.get("x")).toEqual([1, 2]);
      expect(out.bonusByDoc.get("x")).toBe(5000 + 400); // 30 pt : (30 - 10) x 25 = 500, plafonne a 400
    });

    it("keeps a measured page without any occurrence: bonus 0, finite, page kept in the order", async () => {
      const empty: PageMatch = { boxes: [], ordinals: [], pageSize: PAGE_SIZE, termIndexes: [] };
      const out = await rankOne("contrat travail", { 1: empty, 2: ADJACENT });
      expect(out.bonusByDoc.get("x")).toBe(5000);
      expect(out.pagesOrderByDoc.get("x")).toEqual([2, 1]);
      expect(out.failedDocIds.size).toBe(0);
    });

    it("a one-word query with no match anywhere gives bonus 0 (no NaN, no -Infinity) and keeps the BM25 page order", async () => {
      const empty: PageMatch = { boxes: [], ordinals: [], pageSize: PAGE_SIZE, termIndexes: [] };
      const out = await rankOne("contrat", { 1: empty, 2: empty, 3: empty }, [1, 2, 3]);
      const bonus = out.bonusByDoc.get("x") as number;
      expect(Object.is(bonus, 0)).toBe(true);
      expect(out.pagesOrderByDoc.get("x")).toEqual([1, 2, 3]);
    });

    it("ignores a 40 pt word on page 6: not requested, no bonus", async () => {
      const requested: number[][] = [];
      const getPagesMatches = vi.fn(async (_d: string, wanted: readonly number[]) => {
        requested.push([...wanted]);
        return new Map(wanted.map((p) => [p, p === 6 ? big(40) : big(9)] as const));
      });
      const ranker = createProximityRanker({ getPagesMatches });
      const d: RankableDoc = { docId: "x", title: "X", relevance: 1, pages: [1, 2, 3, 4, 5, 6].map((page, i) => ({ page, score: 9 - i })) };
      const out = await ranker.rank("contrat", [d], {});
      expect(requested).toEqual([[1, 2, 3, 4, 5]]);
      expect(out.bonusByDoc.get("x")).toBe(0);
    });

    it("falls back to A4 when pageSize is absent and agrees with an explicit A4 (font above 10 pt)", async () => {
      const noSize = big(12);
      delete (noSize as { pageSize?: unknown }).pageSize;
      const implicit = await rankOne("contrat", { 1: noSize, 2: big(9) });
      const explicit = await rankOne("contrat", { 1: big(12, { pageSize: { widthPt: 595, heightPt: 842 } }), 2: big(9) });
      expect(implicit.bonusByDoc.get("x")).toBeCloseTo(50, 6);
      expect(implicit.bonusByDoc.get("x")).toBe(explicit.bonusByDoc.get("x"));
    });

    it.each([0, -792, Number.NaN, Number.POSITIVE_INFINITY])("an aberrant page height (%s) never produces NaN or an unbounded bonus", async (heightPt) => {
      const odd = big(12, { pageSize: { widthPt: 595, heightPt } });
      const out = await rankOne("contrat", { 1: odd, 2: odd });
      const bonus = out.bonusByDoc.get("x") as number;
      expect(Number.isFinite(bonus)).toBe(true);
      expect(bonus).toBeGreaterThanOrEqual(0);
      expect(bonus).toBeLessThanOrEqual(400);
      expect(out.pagesOrderByDoc.get("x")).toEqual([1, 2]);
    });

    it("ignores pages beyond the PROXIMITY_PAGES measured ones", async () => {
      const svc = fakeService();
      const ranker = createProximityRanker({ getPagesMatches: svc.getPagesMatches });
      await ranker.rank("contrat", [doc(1, 10, [1, 2, 3, 4, 5, 6])], {});
      expect(svc.calls.map((c) => c.page)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
