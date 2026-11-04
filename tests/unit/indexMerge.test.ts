import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildIndex, postingsOf, searchPages, vocabulary, type Bm25Index, type PageInput } from "../../src/core/bm25";
import { decodeIndex, decodeIndexForSearch } from "../../src/core/codec/decode";
import { encodeIndex } from "../../src/core/codec/encode";
import { compareUtf8, type DocumentIndex, type Posting, type SearchIndexData, type TermEntry } from "../../src/core/codec/format";
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

interface NamedSearchData {
  readonly docId: string;
  readonly index: SearchIndexData;
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
  expect(vocabulary(actual)).toEqual(vocabulary(expected));
  for (const query of queries) expect(searchPages(actual, query)).toEqual(searchPages(expected, query));
}

describe("toBm25Index", () => {
  it("retourne un index vide pour aucun document", () => {
    const index = toBm25Index([]);
    expect(index.pageCount).toBe(0);
    expect(index.averagePageLength).toBe(0);
    expect(vocabulary(index)).toEqual([]);
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
    expect(vocabulary(actual)).toEqual(vocabulary(expected));
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
    expect(vocabulary(removed)).toEqual(["chat"]);
    expect(postingsOf(removed, "zebre")).toEqual([]);
    expect(removed.pageCount).toBe(1);
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

describe("retrait et clonage", () => {
  const MANY_TERMS = 60_000;
  const LOOSE_BOUND_MS = 1_000;

  /** Un document, MANY_TERMS termes distincts sur une page. */
  function bigDocument(): DocumentIndex {
    const terms = Array.from({ length: MANY_TERMS }, (_, i) => ({
      term: `t${String(i).padStart(6, "0")}`,
      postings: [{ page: FIRST_PAGE, termFrequency: 1, wordOrdinals: [i] }],
    }));
    return { ...makeDocumentIndex([""]), pageTermCounts: [MANY_TERMS], terms };
  }

  it("retire vite un gros document", () => {
    const base = withDocument(toBm25Index([]), "d", bigDocument());
    const start = performance.now();
    const removed = withoutDocument(base, "d");
    expect(performance.now() - start).toBeLessThan(LOOSE_BOUND_MS);
    expect(vocabulary(removed)).toEqual([]);
    expect(removed.pageCount).toBe(0);
  });

  it("survit a un clone par spread", () => {
    const base = toBm25Index(namedDocs(new Map([["d0", ["chat"]], ["d1", ["zèbre"]]])));
    const clone: Bm25Index = { ...base };
    const removed = withoutDocument(clone, "d1");
    expect(vocabulary(removed)).toEqual(["chat"]);
    expect(vocabulary(base)).toEqual(["chat", "zebre"]);
  });

  it("accepte un type structurel minimal (sans boites)", () => {
    const full = makeDocumentIndex(["chat"]);
    const minimal: Pick<DocumentIndex, "terms" | "pageTermCounts"> = { terms: full.terms, pageTermCounts: full.pageTermCounts };
    expect(toBm25Index([{ docId: "x", index: minimal }]).pageCount).toBe(1);
    expect(vocabulary(withDocument(toBm25Index([]), "x", minimal))).toEqual(["chat"]);
  });
});

describe("entree compacte (decodeIndexForSearch)", () => {
  it("donne les memes resultats que l'entree objet, avant et apres encodage", async () => {
    await fc.assert(
      fc.asyncProperty(corpusArb, queriesArb, async (corpus, queries) => {
        const compact: NamedSearchData[] = [];
        for (const { docId, index } of namedDocs(corpus)) {
          compact.push({ docId, index: await decodeIndexForSearch(await encodeIndex(index)) });
        }
        const fromCompact = toBm25Index(compact);
        expectSameSearch(fromCompact, referenceIndex(corpus), queries);
        expectSameSearch(fromCompact, toBm25Index(namedDocs(corpus)), queries);
      }),
      { numRuns: CODEC_RUNS },
    );
  });

  it("withDocument accepte une entree compacte", async () => {
    const compact = await decodeIndexForSearch(await encodeIndex(makeDocumentIndex(["chat chat", "été"])));
    const index = withDocument(toBm25Index([]), "d", compact);
    expect(searchPages(index, "chat").map((h) => [h.docId, h.page])).toEqual([["d", 1]]);
  });

  it("withDocument { owned: true } ne copie pas les tableaux decodes ; sans l'option, il les copie", async () => {
    const compact = await decodeIndexForSearch(await encodeIndex(makeDocumentIndex(["chat chat", "été"])));
    const owned = withDocument(toBm25Index([]), "d", compact, { owned: true });
    expect(owned.segments[0]?.pages).toBe(compact.postings.pages);
    expect(owned.segments[0]?.pageLengths).toBe(compact.pageTermCounts);
    const copied = withDocument(toBm25Index([]), "d", compact);
    expect(copied.segments[0]?.pages).not.toBe(compact.postings.pages);
    expect(searchPages(owned, "chat").map((h) => h.page)).toEqual([1]);
  });

  it("remet en ordre d'unites de code UTF-16 un dictionnaire en ordre UTF-8 (caracteres astraux)", async () => {
    // UTF-8 : U+FF21 (EF BC A1) < U+10400 (F0 90 90 80) ; UTF-16 : U+10400 (D801 DC00) < U+FF21.
    const wide = "\uFF21";
    const astral = "\u{10400}";
    const posting = (page: number, tf: number) => ({ page, termFrequency: tf, wordOrdinals: Array.from({ length: tf }, (_, k) => k) });
    const document: DocumentIndex = {
      ...makeDocumentIndex(["", ""]),
      pageTermCounts: [3, 1],
      terms: [
        { term: wide, postings: [posting(1, 2), posting(2, 1)] },
        { term: astral, postings: [posting(1, 1)] },
      ],
    };
    const compact = await decodeIndexForSearch(await encodeIndex(document));
    expect(compact.postings.terms).toEqual([wide, astral]);
    for (const input of [document, compact]) {
      const index = toBm25Index([{ docId: "d", index: input }]);
      expect(vocabulary(index)).toEqual([astral, wide]);
      expect(index.segments[0]?.terms).toEqual([astral, wide]);
      expect(postingsOf(index, wide)).toEqual([{ docId: "d", page: 1, tf: 2 }, { docId: "d", page: 2, tf: 1 }]);
      expect(postingsOf(index, astral)).toEqual([{ docId: "d", page: 1, tf: 1 }]);
    }
  });
});
