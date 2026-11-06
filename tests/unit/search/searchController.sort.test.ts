import { beforeEach, describe, expect, it, vi } from "vitest";
import * as bm25 from "../../../src/core/bm25";
import { buildIndex, type Bm25Index } from "../../../src/core/bm25";
import { NO_FILTERS, type SearchOptions, type SortSpec } from "../../../src/search/resultOptions";
import {
  RERANK_GRACE_MS,
  createSearchController,
  type DocInfo,
  type LoadProgress,
  type RerankPort,
  type SearchSource,
  type SearchViewModel,
} from "../../../src/search/searchController";

vi.mock("../../../src/core/bm25", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/bm25")>();
  return { ...actual, searchPages: vi.fn(actual.searchPages) };
});

class FakeClock {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  schedule = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.tasks]) {
      if (t.at <= this.now) {
        this.tasks.delete(id);
        t.fn();
      }
    }
  }
}

const info = (docId: string, title: string, pdfModifiedMs: number, path: string): DocInfo => ({
  docId, title, path, pageCount: 9, pdfSize: 1, pdfModifiedMs,
});
// Pertinence BM25 attendue (alpha beta) : a (3 pages), puis b, c (ordre vérifié par le test « ordre de référence »).
const DOCS = [
  info("a", "Zulu", 100, "assets/z/a.pdf"),
  info("b", "Echo", 300, "assets/m/b.pdf"),
  info("c", "Mu", 200, "assets/a/c.pdf"),
];
const PAGES = [
  { docId: "a", page: 1, text: "alpha beta gamma" },
  { docId: "a", page: 2, text: "alpha beta" },
  { docId: "a", page: 3, text: "alpha beta" },
  { docId: "b", page: 1, text: "alpha beta" },
  { docId: "b", page: 2, text: "alpha beta" },
  { docId: "c", page: 1, text: "alpha beta" },
];

class FakeSource implements SearchSource {
  index: Bm25Index = buildIndex(PAGES);
  getIndex = () => this.index;
  getDoc = (id: string) => DOCS.find((d) => d.docId === id);
  listDocs = () => DOCS;
  getProgress = (): LoadProgress => ({ loaded: 0, total: 0, failed: [] });
  getPhase = () => "ready" as const;
  getLastError = () => undefined;
  subscribe = () => () => undefined;
}

type RankResult = Awaited<ReturnType<RerankPort["rank"]>>;
interface Call {
  docs: readonly { docId: string; pages: readonly { page: number }[] }[];
  signal: AbortSignal | undefined;
  onWindow: ((r: unknown) => void) | undefined;
  resolve: (r: RankResult) => void;
  reject: (e: unknown) => void;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const results = (vm: SearchViewModel) => {
  if (vm.kind !== "results") throw new Error(`expected results, got ${vm.kind}`);
  return vm;
};
const ids = (vm: SearchViewModel) => results(vm).docs.map((d) => d.docId);

/** Re-classement factice : documents inversés, pages du premier document inversées (5 premières). */
function reversedRanking(docs: Call["docs"]): RankResult {
  const first = docs[0]!;
  return {
    docs: [...docs].reverse(),
    pagesOrderByDoc: new Map([[first.docId, first.pages.map((p) => p.page).reverse()]]),
    bonusByDoc: new Map(docs.map((d) => [d.docId, 0])),
    failedDocIds: new Set<string>(),
    done: Promise.resolve(),
  } as unknown as RankResult;
}

function setup(sort?: SortSpec, withRerank = true) {
  const source = new FakeSource();
  const clock = new FakeClock();
  const calls: Call[] = [];
  const seen: SearchViewModel[] = [];
  const onWarn = vi.fn();
  const rank = vi.fn(
    (_q: string, docs: Call["docs"], o: { signal?: AbortSignal; onWindow?: (r: unknown) => void }) =>
      new Promise<RankResult>((resolve, reject) => {
        calls.push({ docs, signal: o.signal, onWindow: o.onWindow, resolve, reject });
      }),
  );
  const rerank = { rank } as unknown as RerankPort;
  const controller = createSearchController({
    source, schedule: clock.schedule, clear: clock.clear, onChange: (vm) => seen.push(vm), onWarn,
    ...(withRerank ? { rerank } : {}),
    ...(sort ? { initialOptions: { sort, filters: NO_FILTERS } } : {}),
  });
  return { controller, clock, calls, seen, onWarn, rank };
}
const withSort = (sort: SortSpec, filters: SearchOptions["filters"] = NO_FILTERS): SearchOptions => ({ sort, filters });
const NAME_ASC: SortSpec = { key: "name", direction: "asc" };

beforeEach(() => {
  vi.mocked(bm25.searchPages).mockClear();
});

describe("contrôleur : tri des documents", () => {
  it("ordre de référence sans re-classement (pertinence BM25) : a, b, c", () => {
    const { controller } = setup(undefined, false);
    controller.submit("alpha beta");
    expect(ids(controller.getViewModel())).toEqual(["a", "b", "c"]);
  });

  it.each([
    [{ key: "name", direction: "asc" }, ["b", "c", "a"]],
    [{ key: "name", direction: "desc" }, ["a", "c", "b"]],
    [{ key: "modified", direction: "asc" }, ["a", "c", "b"]],
    [{ key: "modified", direction: "desc" }, ["b", "c", "a"]],
    [{ key: "path", direction: "asc" }, ["c", "b", "a"]],
    [{ key: "matches", direction: "desc" }, ["a", "b", "c"]],
    [{ key: "relevance", direction: "asc" }, ["c", "b", "a"]],
  ] as [SortSpec, string[]][])("tri initial %j : documents ordonnés %j (repli BM25 sans re-classement)", (sort, expected) => {
    const { controller, seen } = setup(sort, false);
    controller.submit("alpha beta");
    expect(ids(seen.at(-1)!)).toEqual(expected);
  });

  it("changer SEULEMENT le tri : ni searchPages ni rerank.rank, la liste affichée est re-publiée triée", async () => {
    const { controller, calls, seen, rank } = setup();
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    expect(seen).toHaveLength(1);
    const before = results(seen[0]!);
    expect(before.ranking).toBe("proximity");
    expect(ids(before)).toEqual(["c", "b", "a"]);
    const searches = vi.mocked(bm25.searchPages).mock.calls.length;
    const ranks = rank.mock.calls.length;

    controller.setOptions(withSort(NAME_ASC));

    expect(vi.mocked(bm25.searchPages).mock.calls.length).toBe(searches);
    expect(rank.mock.calls.length).toBe(ranks);
    expect(calls[0]!.signal!.aborted).toBe(false);
    expect(seen).toHaveLength(2);
    const after = results(seen[1]!);
    expect(ids(after)).toEqual(["b", "c", "a"]);
    expect(after.ranking).toBe("proximity"); // ranking conservé
    expect(controller.getViewModel()).toBe(seen[1]);
    // l'ordre des PAGES de chaque document reste celui du classement
    for (const doc of after.docs) {
      expect(doc.pages.map((p) => p.page)).toEqual(before.docs.find((x) => x.docId === doc.docId)!.pages.map((p) => p.page));
    }
    expect(controller.getOptions().sort).toEqual(NAME_ASC);
  });

  it("revenir à la pertinence restaure l'ordre re-classé (pas l'ordre trié précédent)", async () => {
    const { controller, calls, seen } = setup();
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    controller.setOptions(withSort(NAME_ASC));
    controller.setOptions(withSort({ key: "relevance", direction: "desc" }));
    expect(ids(seen.at(-1)!)).toEqual(["c", "b", "a"]);
    controller.setOptions(withSort({ key: "relevance", direction: "asc" }));
    expect(ids(seen.at(-1)!)).toEqual(["a", "b", "c"]);
  });

  it("tri changé sans requête soumise : mémorisé, rien publié", () => {
    const { controller, seen, rank } = setup();
    controller.setOptions(withSort(NAME_ASC));
    expect(seen).toHaveLength(0);
    expect(rank).not.toHaveBeenCalled();
    controller.submit("alpha beta");
    expect(controller.getOptions().sort).toEqual(NAME_ASC);
  });

  it("tri changé alors que le re-classement est en vol : il n'est pas annulé et la fenêtre qui arrive est triée", async () => {
    const { controller, calls, seen } = setup();
    controller.submit("alpha beta");
    controller.setOptions(withSort(NAME_ASC));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal!.aborted).toBe(false);
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    expect(seen).toHaveLength(1);
    expect(ids(seen[0]!)).toEqual(["b", "c", "a"]);
    expect(results(seen[0]!).ranking).toBe("proximity");
  });

  it("grâce de 300 ms : le repli BM25 publié est trié, puis la fenêtre qui arrive après coup l'est aussi", async () => {
    const { controller, clock, calls, seen } = setup(NAME_ASC);
    controller.submit("alpha beta");
    clock.advance(RERANK_GRACE_MS);
    expect(seen).toHaveLength(1);
    expect(ids(seen[0]!)).toEqual(["b", "c", "a"]);
    expect(results(seen[0]!).ranking).toBe("bm25");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    expect(seen).toHaveLength(2);
    expect(results(seen[1]!).ranking).toBe("proximity");
    expect(ids(seen[1]!)).toEqual(["b", "c", "a"]);
  });

  it("fenêtres suivantes (onWindow) : triées avec le tri COURANT, même changé entre-temps", async () => {
    const { controller, calls, seen } = setup(NAME_ASC);
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    controller.setOptions(withSort({ key: "modified", direction: "desc" }));
    calls[0]!.onWindow!(reversedRanking(calls[0]!.docs));
    await flush();
    expect(ids(seen.at(-1)!)).toEqual(["b", "c", "a"]);
    controller.setOptions(withSort({ key: "modified", direction: "asc" }));
    calls[0]!.onWindow!(reversedRanking(calls[0]!.docs));
    await flush();
    expect(ids(seen.at(-1)!)).toEqual(["a", "c", "b"]);
  });

  it("re-classement en échec : le repli BM25 est trié et l'échec journalisé", async () => {
    const { controller, calls, seen, onWarn } = setup(NAME_ASC);
    controller.submit("alpha beta");
    calls[0]!.reject(new Error("boom"));
    await flush();
    expect(ids(seen.at(-1)!)).toEqual(["b", "c", "a"]);
    expect(onWarn).toHaveBeenCalled();
  });

  it("le tri persiste après un changement de filtre (qui relance la requête)", async () => {
    const NAME_DESC: SortSpec = { key: "name", direction: "desc" };
    const { controller, calls, seen } = setup(NAME_DESC);
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    const searches = vi.mocked(bm25.searchPages).mock.calls.length;
    controller.setOptions(withSort(NAME_DESC, { ...NO_FILTERS, nameContains: "u" }));
    expect(vi.mocked(bm25.searchPages).mock.calls.length).toBe(searches + 1);
    calls[1]!.resolve(reversedRanking(calls[1]!.docs)); // ce re-classement donnerait c, a
    await flush();
    expect(controller.getOptions().sort).toEqual(NAME_DESC);
    expect(ids(seen.at(-1)!)).toEqual(["a", "c"]); // « u » : Zulu et Mu, par nom décroissant ; Echo masqué
  });

  it("changer le tri ET un filtre dans le même appel relance bien la requête", async () => {
    const { controller, calls } = setup();
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    const searches = vi.mocked(bm25.searchPages).mock.calls.length;
    controller.setOptions(withSort(NAME_ASC, { ...NO_FILTERS, minPages: 1 }));
    expect(vi.mocked(bm25.searchPages).mock.calls.length).toBe(searches + 1);
  });

  it("tri identique : rien n'est republié", async () => {
    const { controller, calls, seen } = setup();
    controller.submit("alpha beta");
    calls[0]!.resolve(reversedRanking(calls[0]!.docs));
    await flush();
    controller.setOptions(withSort({ key: "relevance", direction: "desc" }));
    expect(seen).toHaveLength(1);
  });

  it("tri changé alors que l'état affiché n'est pas une liste de résultats : mémorisé sans republier", () => {
    const { controller, seen } = setup(undefined, false);
    controller.submit("zzzz");
    const count = seen.length;
    controller.setOptions(withSort(NAME_ASC));
    expect(seen).toHaveLength(count);
    expect(controller.getOptions().sort).toEqual(NAME_ASC);
  });
});
