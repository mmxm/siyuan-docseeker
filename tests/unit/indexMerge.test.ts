import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildIndex, searchPages, type Bm25Index, type PageInput } from "../../src/core/bm25";
import { decodeIndex } from "../../src/core/codec/decode";
import { encodeIndex } from "../../src/core/codec/encode";
import { compareUtf8, type DocumentIndex, type Posting, type TermEntry } from "../../src/core/codec/format";
import {
  DuplicateDocumentError,
  toBm25Index,
  withDocument,
  withoutDocument,
} from "../../src/core/indexMerge";
import { tokenize } from "../../src/core/normalize";

interface NamedDocument {
  readonly docId: string;
  readonly index: DocumentIndex;
}

const WORDS = ["été", "école", "Éléphant", "naïve", "cœur", "résumé", "chat", "chats", "château", "chateau", "a", "zèbre"];
const QUERY_PARTS = [...WORDS, "ét", "ch", "c", "zz", "absent", "ÉCO"];
const DOC_IDS = ["d0", "d1", "d2", "d3"];
const PROPERTY_RUNS = 150;
const CODEC_RUNS = 25;
const FIRST_PAGE = 1;
const ENCODER = new TextEncoder();

/** Fabrique un DocumentIndex a partir des textes de pages (tokenize + comptes + ordinaux). */
function makeDocumentIndex(pages: readonly string[]): DocumentIndex {
  const byTerm = new Map<string, Posting[]>();
  const pageTermCounts: number[] = [];
  pages.forEach((text, i) => {
    const tokens = tokenize(text);
    pageTermCounts.push(tokens.length);
    const ordinals = new Map<string, number[]>();
    tokens.forEach((token, ordinal) => ordinals.set(token, [...(ordinals.get(token) ?? []), ordinal]));
    for (const [term, wordOrdinals] of ordinals) {
      const list = byTerm.get(term) ?? [];
      list.push({ page: i + FIRST_PAGE, termFrequency: wordOrdinals.length, wordOrdinals });
      byTerm.set(term, list);
    }
  });
  const terms: TermEntry[] = [...byTerm]
    .map(([term, postings]) => ({ term, postings }))
    .sort((a, b) => compareUtf8(ENCODER.encode(a.term), ENCODER.encode(b.term)));
  return {
    normalizerVersion: 1,
    extractorVersion: "test",
    sourcePath: "a.pdf",
    pdfSize: 1,
    pdfModifiedMs: 1,
    pageTermCounts,
    terms,
    pageBoxes: pages.map(() => []),
  };
}

const namedDocs = (corpus: ReadonlyMap<string, readonly string[]>): NamedDocument[] =>
  [...corpus].map(([docId, pages]) => ({ docId, index: makeDocumentIndex(pages) }));

const referenceIndex = (corpus: ReadonlyMap<string, readonly string[]>): Bm25Index => {
  const inputs: PageInput[] = [];
  for (const [docId, pages] of corpus) {
    pages.forEach((text, i) => inputs.push({ docId, page: i + FIRST_PAGE, text }));
  }
  return buildIndex(inputs);
};

const pageArb = fc.array(fc.constantFrom(...WORDS), { maxLength: 12 }).map((w) => w.join(" "));
const docArb = fc.array(pageArb, { maxLength: 5 });
const corpusArb = fc
  .array(docArb, { maxLength: 4 })
  .map((docs) => new Map(docs.map((pages, i) => [`doc${i}`, pages] as const)));
const queryArb = fc
  .array(fc.constantFrom(...QUERY_PARTS), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(" "));
const queriesArb = fc.array(queryArb, { minLength: 1, maxLength: 6 });

function expectSameSearch(actual: Bm25Index, expected: Bm25Index, queries: readonly string[]): void {
  expect(actual.pageCount).toBe(expected.pageCount);
  expect(actual.averagePageLength).toBe(expected.averagePageLength);
  expect(actual.sortedTerms).toEqual(expected.sortedTerms);
  for (const query of queries) expect(searchPages(actual, query)).toEqual(searchPages(expected, query));
}

describe("toBm25Index", () => {
  it("retourne un index vide pour aucun document", () => {
    const index = toBm25Index([]);
    expect(index.pageCount).toBe(0);
    expect(index.averagePageLength).toBe(0);
    expect(index.sortedTerms).toEqual([]);
    expect(searchPages(index, "chat")).toEqual([]);
  });

  it("compte les pages vides dans N et avgdl", () => {
    const index = toBm25Index(namedDocs(new Map([["d", ["chat chat", "", ""]]])));
    expect(index.pageCount).toBe(3);
    expect(index.averagePageLength).toBeCloseTo(2 / 3, 12);
  });

  it("leve DuplicateDocumentError sur docId en double", () => {
    const doc = { docId: "x", index: makeDocumentIndex(["chat"]) };
    expect(() => toBm25Index([doc, doc])).toThrow(DuplicateDocumentError);
  });

  it("trie sortedTerms en unites de code meme si le dictionnaire est en ordre UTF-8", () => {
    // U+FF21 (BMP) < U+1F600 (astral) en UTF-8, mais > en unites de code UTF-16.
    const pages = ["Ａ \u{20000}"];
    const expected = referenceIndex(new Map([["d", pages]]));
    const actual = toBm25Index(namedDocs(new Map([["d", pages]])));
    expect(actual.sortedTerms).toEqual(expected.sortedTerms);
  });

  it("equivaut a buildIndex (proprietes)", () => {
    fc.assert(
      fc.property(corpusArb, queriesArb, (corpus, queries) => {
        expectSameSearch(toBm25Index(namedDocs(corpus)), referenceIndex(corpus), queries);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("equivaut a buildIndex apres encodeIndex/decodeIndex", async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, queriesArb, async (corpus, queries) => {
        const decoded: NamedDocument[] = [];
        for (const { docId, index } of namedDocs(corpus)) {
          decoded.push({ docId, index: await decodeIndex(await encodeIndex(index)) });
        }
        expectSameSearch(toBm25Index(decoded), referenceIndex(corpus), queries);
      }),
      { numRuns: CODEC_RUNS },
    );
  });
});

describe("withDocument / withoutDocument", () => {
  it("ajoute puis remplace sans modifier l'index d'origine", () => {
    const base = toBm25Index(namedDocs(new Map([["d0", ["chat été"]]])));
    const before = searchPages(base, "chat");
    const added = withDocument(base, "d1", makeDocumentIndex(["chat", "chats chat"]));
    expect(added).not.toBe(base);
    expect(searchPages(base, "chat")).toEqual(before);
    expect(base.pageCount).toBe(1);
    const replaced = withDocument(added, "d1", makeDocumentIndex(["zèbre"]));
    expect(replaced.pageCount).toBe(2);
    expect(searchPages(replaced, "chat").map((h) => h.docId)).toEqual(["d0"]);
    expect(searchPages(added, "chat").length).toBe(3);
  });

  it("retire un document, ses termes exclusifs et ses longueurs de page", () => {
    const base = toBm25Index(namedDocs(new Map([["d0", ["chat"]], ["d1", ["zèbre"]]])));
    const removed = withoutDocument(base, "d1");
    expect(removed).not.toBe(base);
    expect(removed.sortedTerms).toEqual(["chat"]);
    expect(removed.postings.has("zebre")).toBe(false);
    expect(removed.pageLengths.size).toBe(1);
    expect(base.pageCount).toBe(2);
  });

  it("retirer un docId inconnu renvoie un index equivalent (nouvel objet)", () => {
    const base = toBm25Index(namedDocs(new Map([["d0", ["chat"]]])));
    const same = withoutDocument(base, "nope");
    expect(same).not.toBe(base);
    expect(searchPages(same, "chat")).toEqual(searchPages(base, "chat"));
  });

  it("fonctionne sur un index issu de buildIndex (sans metadonnees)", () => {
    const corpus = new Map([["d0", ["chat été"]], ["d1", ["chats", ""]]]);
    const built = referenceIndex(corpus);
    const next = withDocument(withoutDocument(built, "d1"), "d2", makeDocumentIndex(["chat"]));
    const expected = referenceIndex(new Map([["d0", ["chat été"]], ["d2", ["chat"]]]));
    expectSameSearch(next, expected, ["chat", "ch", "été chat"]);
  });

  it("equivaut a une reconstruction apres operations successives (proprietes)", () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant("add" as const), docId: fc.constantFrom(...DOC_IDS), pages: docArb }),
      fc.record({ kind: fc.constant("remove" as const), docId: fc.constantFrom(...DOC_IDS) }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 10 }), queriesArb, (ops, queries) => {
        let index = toBm25Index([]);
        const model = new Map<string, readonly string[]>();
        for (const op of ops) {
          if (op.kind === "add") {
            index = withDocument(index, op.docId, makeDocumentIndex(op.pages));
            model.set(op.docId, op.pages);
          } else {
            index = withoutDocument(index, op.docId);
            model.delete(op.docId);
          }
          expectSameSearch(index, referenceIndex(model), queries);
          expectSameSearch(index, toBm25Index(namedDocs(model)), queries);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("performance de la fusion", () => {
  const DOCUMENTS = 50;
  const PAGES = 500;
  const WORDS_PER_PAGE = 300;
  const VOCABULARY = 20_000;
  const TIME_BOUND_MS = 20_000;
  /** Generation des donnees synthetiques incluse. */
  const TEST_TIMEOUT_MS = 120_000;
  const LCG_MULTIPLIER = 1_664_525;
  const LCG_INCREMENT = 1_013_904_223;
  const LCG_MODULUS = 2 ** 32;

  /** Document synthetique deterministe (LCG), termes tries, distribution biaisee (type Zipf grossier). */
  function syntheticDocument(seed: number): DocumentIndex {
    let state = seed;
    const next = (): number => {
      state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
      return state / LCG_MODULUS;
    };
    const byTerm = new Map<string, Posting[]>();
    for (let page = FIRST_PAGE; page <= PAGES; page++) {
      const counts = new Map<string, number>();
      for (let w = 0; w < WORDS_PER_PAGE; w++) {
        const term = `t${String(Math.floor(next() * next() * VOCABULARY)).padStart(5, "0")}`;
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      for (const [term, tf] of counts) {
        const list = byTerm.get(term) ?? [];
        list.push({ page, termFrequency: tf, wordOrdinals: [] });
        byTerm.set(term, list);
      }
    }
    const terms = [...byTerm].map(([term, postings]) => ({ term, postings })).sort((a, b) => (a.term < b.term ? -1 : 1));
    return {
      normalizerVersion: 1,
      extractorVersion: "perf",
      sourcePath: "p.pdf",
      pdfSize: 1,
      pdfModifiedMs: 1,
      pageTermCounts: Array.from({ length: PAGES }, () => WORDS_PER_PAGE),
      terms,
      pageBoxes: [],
    };
  }

  it(`fusionne ${DOCUMENTS} x ${PAGES} pages x ${WORDS_PER_PAGE} mots sous ${TIME_BOUND_MS} ms`, () => {
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ docId: `doc${i}`, index: syntheticDocument(i + 1) }));
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const merged = toBm25Index(documents);
    const elapsed = performance.now() - start;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576;
    console.info(`[perf] fusion=${elapsed.toFixed(0)} ms, delta heap ~${heapDeltaMb.toFixed(0)} Mo (grossier, sans gc force)`);
    expect(merged.pageCount).toBe(DOCUMENTS * PAGES);
    expect(merged.averagePageLength).toBe(WORDS_PER_PAGE);
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
    const updateStart = performance.now();
    const updated = withDocument(merged, "doc0", documents[1]?.index ?? syntheticDocument(2));
    console.info(`[perf] withDocument=${(performance.now() - updateStart).toFixed(0)} ms`);
    expect(updated.pageCount).toBe(merged.pageCount);
  }, TEST_TIMEOUT_MS);
});

describe("metadonnees de retrait", () => {
  const MANY_TERMS = 60_000;
  const LOOSE_BOUND_MS = 1_000;

  /** Index sans metadonnees (comme buildIndex) : un document, MANY_TERMS termes distincts. */
  function bareIndex(): Bm25Index {
    const sortedTerms = Array.from({ length: MANY_TERMS }, (_, i) => `t${String(i).padStart(6, "0")}`);
    const postings = new Map(sortedTerms.map((term) => [term, [{ docId: "d", page: FIRST_PAGE, tf: 1 }]] as const));
    return {
      postings,
      sortedTerms,
      pageLengths: new Map([[`d\u0000${FIRST_PAGE}`, MANY_TERMS]]),
      pageCount: 1,
      averagePageLength: MANY_TERMS,
    };
  }

  it("retombe vite sur le scan O(Q+Pg) pour un index sans metadonnees", () => {
    const bare = bareIndex();
    const start = performance.now();
    const removed = withoutDocument(bare, "d");
    expect(performance.now() - start).toBeLessThan(LOOSE_BOUND_MS);
    expect(removed.sortedTerms).toEqual([]);
    expect(removed.pageCount).toBe(0);
  });

  it("n'attache aucune metadonnee a un index externe (non muté)", () => {
    const bare = bareIndex();
    withoutDocument(bare, "d");
    expect(Object.getOwnPropertySymbols(bare)).toEqual([]);
  });

  it("survit a un clone par spread", () => {
    const base = toBm25Index(namedDocs(new Map([["d0", ["chat"]], ["d1", ["zèbre"]]])));
    expect(Object.getOwnPropertySymbols(base)).toHaveLength(1);
    const clone: Bm25Index = { ...base };
    expect(Object.getOwnPropertySymbols(clone)).toEqual(Object.getOwnPropertySymbols(base));
    const removed = withoutDocument(clone, "d1");
    expect(removed.sortedTerms).toEqual(["chat"]);
    expect(Object.getOwnPropertySymbols(removed)).toHaveLength(1);
  });

  it("accepte un type structurel minimal (sans boites)", () => {
    const full = makeDocumentIndex(["chat"]);
    const minimal: Pick<DocumentIndex, "terms" | "pageTermCounts"> = { terms: full.terms, pageTermCounts: full.pageTermCounts };
    expect(toBm25Index([{ docId: "x", index: minimal }]).pageCount).toBe(1);
    expect(withDocument(toBm25Index([]), "x", minimal).sortedTerms).toEqual(["chat"]);
  });
});
