import { describe, expect, it } from "vitest";
import { encodeIndex, encodeVarint } from "../../src/core/codec/encode";
import {
  DecodeBudget,
  decodeIndex,
  decodeIndexForSearch,
  decodePageBoxes,
  decodePageMatches,
} from "../../src/core/codec/decode";
import {
  BudgetExceededError,
  CorruptDataError,
  CorruptOffsetError,
  DsxFormatError,
  MAX_BOXES_PER_PAGE,
  MAX_PAGES,
  MAX_TERMS,
  MAX_TOTAL_BOXES,
  type DocumentIndex,
  type WordBox,
} from "../../src/core/codec/format";

const TEST_TIMEOUT_MS = 120_000;
const MEGABYTE = 1024 * 1024;
const HEADER_FIXED_BYTES = 31 + 32; // en-tête sans extracteur ni chemin + table des sections
const BOMB_ZERO_BYTES = 24 * MEGABYTE;
const MEMORY_LIMIT_BYTES = 300 * MEGABYTE;
const SEARCH_PAGES = 3_000;
const SEARCH_WORDS_PER_PAGE = 400;
const SEARCH_TERMS = 100;
const SEARCH_TIME_LIMIT_MS = 60_000;
const XORSHIFT_SEED = 0x9e3779b9;

const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Octets pseudo-aléatoires (peu compressibles) pour des boîtes plausibles. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed | 0 || XORSHIFT_SEED;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

const blobOf = (boxCount: number, seed: number): Uint8Array =>
  cat(encodeVarint(boxCount), noise(boxCount * 8, seed));

interface RawDsx {
  readonly pageCount: number;
  readonly lengths?: Uint8Array;
  readonly dict?: Uint8Array;
  readonly postings?: Uint8Array;
  readonly blobs?: readonly Uint8Array[];
  /** Longueurs annoncées dans la table (par défaut : les vraies) : sert à fabriquer une table incohérente. */
  readonly tableLengths?: readonly number[];
}

/** Assemble un fichier à partir de sections brutes (non compressées) et de blobs déjà compressés. */
async function buildDsx(raw: RawDsx): Promise<Uint8Array> {
  const blobs = raw.blobs ?? [];
  const table = new Uint8Array(blobs.length * 4);
  const tableView = new DataView(table.buffer);
  blobs.forEach((b, i) => tableView.setUint32(i * 4, raw.tableLengths?.[i] ?? b.length, true));
  const sections = [
    await deflate(raw.lengths ?? new Uint8Array(0)),
    await deflate(raw.dict ?? encodeVarint(0)),
    await deflate(raw.postings ?? new Uint8Array(0)),
    cat(table, ...blobs),
  ];
  const header = new Uint8Array(HEADER_FIXED_BYTES);
  const view = new DataView(header.buffer);
  header.set([0x44, 0x53, 0x58, 0x31], 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, raw.pageCount, true);
  view.setFloat64(12, 10, true);
  view.setFloat64(20, 20, true);
  let offset = HEADER_FIXED_BYTES;
  sections.forEach((section, i) => {
    view.setUint32(31 + i * 8, offset, true);
    view.setUint32(31 + i * 8 + 4, section.length, true);
    offset += section.length;
  });
  return cat(header, ...sections);
}

const decoders: readonly (readonly [string, (bytes: Uint8Array) => Promise<unknown>])[] = [
  ["decodeIndex", decodeIndex],
  ["decodeIndexForSearch", decodeIndexForSearch],
  ["decodePageBoxes", (bytes) => decodePageBoxes(bytes, 1)],
];

describe("BudgetExceededError", () => {
  it("est une DsxFormatError typée", () => {
    const error = new BudgetExceededError("boxes");
    expect(error).toBeInstanceOf(DsxFormatError);
    expect(error).toBeInstanceOf(CorruptDataError);
    expect(error.name).toBe("BudgetExceededError");
  });
});

describe("DecodeBudget", () => {
  const limits = { maxInflatedBytes: 10, maxBoxes: 5, maxPostingItems: 3 };

  it("cumule les octets inflatés et refuse le dépassement", () => {
    const budget = new DecodeBudget(limits);
    budget.addInflatedBytes(6);
    budget.addInflatedBytes(4);
    expect(() => budget.addInflatedBytes(1)).toThrow(BudgetExceededError);
  });

  it("cumule les boîtes", () => {
    const budget = new DecodeBudget(limits);
    budget.addBoxes(5);
    expect(() => budget.addBoxes(1)).toThrow(BudgetExceededError);
  });

  it("cumule les éléments de postings", () => {
    const budget = new DecodeBudget(limits);
    budget.addPostingItems(3);
    expect(() => budget.addPostingItems(1)).toThrow(BudgetExceededError);
  });
});

describe.each(decoders)("%s : bornes structurelles", (_name, decode) => {
  it("refuse un nombre de pages > MAX_PAGES", async () => {
    const bytes = await buildDsx({ pageCount: MAX_PAGES + 1 });
    await expect(decode(bytes)).rejects.toThrow(BudgetExceededError);
  });

  it("accepte une page de MAX_BOXES_PER_PAGE boîtes plausibles", async () => {
    const blob = await deflate(blobOf(MAX_BOXES_PER_PAGE, 7));
    const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(0), blobs: [blob] });
    await expect(decode(bytes)).resolves.toBeDefined();
  });
});

const boxReaders: readonly (readonly [string, (bytes: Uint8Array) => Promise<unknown>])[] = [
  ["decodeIndex", decodeIndex],
  ["decodePageBoxes", (bytes) => decodePageBoxes(bytes, 1)],
  ["decodePageMatches", (bytes) => decodePageMatches(bytes, 1, () => true)],
];

// decodeIndexForSearch n'inflate pas les blobs de boîtes : ces bornes s'appliquent à la lecture d'une page.
describe.each(boxReaders)("%s : bornes des blobs de boîtes", (_name, decode) => {
  it("refuse une page annonçant plus de MAX_BOXES_PER_PAGE boîtes", async () => {
    const blob = await deflate(encodeVarint(MAX_BOXES_PER_PAGE + 1));
    const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(0), blobs: [blob] });
    await expect(decode(bytes)).rejects.toThrow(BudgetExceededError);
  });

  it(
    "refuse une bombe de zéros dans un blob de boîtes (ratio d'inflation)",
    async () => {
      const zeros = cat(encodeVarint(MAX_BOXES_PER_PAGE), new Uint8Array(MAX_BOXES_PER_PAGE * 8));
      const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(0), blobs: [await deflate(zeros)] });
      await expect(decode(bytes)).rejects.toThrow(BudgetExceededError);
    },
    TEST_TIMEOUT_MS,
  );
});

describe.each(decoders.slice(0, 2))("%s : sections 0 à 2", (_name, decode) => {
  it("refuse un nombre de termes > MAX_TERMS", async () => {
    const dict = encodeVarint(MAX_TERMS + 1);
    const bytes = await buildDsx({ pageCount: 0, dict });
    await expect(decode(bytes)).rejects.toThrow(BudgetExceededError);
  });

  it(
    "refuse trois sections-bombes de zéros sans consommer de mémoire excessive",
    async () => {
      const bomb = await deflate(new Uint8Array(BOMB_ZERO_BYTES));
      const sections = [bomb, bomb, bomb];
      const header = new Uint8Array(HEADER_FIXED_BYTES);
      const view = new DataView(header.buffer);
      header.set([0x44, 0x53, 0x58, 0x31], 0);
      view.setUint16(4, 1, true);
      view.setFloat64(12, 10, true);
      view.setFloat64(20, 20, true);
      let offset = HEADER_FIXED_BYTES;
      [...sections, new Uint8Array(0)].forEach((section, i) => {
        view.setUint32(31 + i * 8, offset, true);
        view.setUint32(31 + i * 8 + 4, section.length, true);
        offset += section.length;
      });
      const bytes = cat(header, ...sections);
      const before = process.memoryUsage();
      await expect(decode(bytes)).rejects.toThrow(BudgetExceededError);
      const after = process.memoryUsage();
      expect(after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers).toBeLessThan(
        MEMORY_LIMIT_BYTES,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("budget global de boîtes", () => {
  it(
    "refuse un fichier dont la somme des boîtes dépasse MAX_TOTAL_BOXES (decodeIndex ; decodeIndexForSearch ne lit plus les boîtes)",
    async () => {
      const pages = Math.floor(MAX_TOTAL_BOXES / MAX_BOXES_PER_PAGE) + 1;
      const blobs = await Promise.all(
        Array.from({ length: pages }, (_, i) => deflate(blobOf(MAX_BOXES_PER_PAGE, i + 1))),
      );
      const bytes = await buildDsx({ pageCount: pages, lengths: new Uint8Array(pages), blobs });
      await expect(decodeIndex(bytes)).rejects.toThrow(BudgetExceededError);
    },
    TEST_TIMEOUT_MS,
  );
});

function syntheticIndex(pages: number, wordsPerPage: number): DocumentIndex {
  const box: WordBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const pageBoxes = Array.from({ length: pages }, (_, p) =>
    Array.from({ length: wordsPerPage }, (_, w): WordBox => ({ ...box, x: ((p + w) % 100) / 200 })),
  );
  const terms = Array.from({ length: SEARCH_TERMS }, (_, t) => ({
    term: `t${String(t).padStart(3, "0")}`,
    postings: Array.from({ length: pages }, (_, p) => ({ page: p + 1, termFrequency: 1, wordOrdinals: [t] })),
  }));
  return {
    normalizerVersion: 1,
    extractorVersion: "x",
    sourcePath: "big.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: Array.from({ length: pages }, () => wordsPerPage),
    terms,
    pageBoxes,
    pageSizes: pageBoxes.map(() => ({ widthPt: 595, heightPt: 842 })),
  };
}

describe("decodeIndexForSearch", () => {
  it("renvoie un index compact (tableaux typés), équivalent à decodeIndex sans ordinaux ni boîtes", async () => {
    const index = syntheticIndex(5, 7);
    const bytes = await encodeIndex(index);
    const full = await decodeIndex(bytes);
    const search = await decodeIndexForSearch(bytes);
    expect("pageBoxes" in search).toBe(false);
    expect("terms" in search).toBe(false);
    expect(search.pageTermCounts).toBeInstanceOf(Uint32Array);
    expect(Array.from(search.pageTermCounts)).toEqual(full.pageTermCounts);
    const { postings } = search;
    expect(postings.pages).toBeInstanceOf(Uint32Array);
    expect(postings.termFrequencies).toBeInstanceOf(Uint32Array);
    expect(postings.offsets).toBeInstanceOf(Uint32Array);
    expect(postings.terms).toEqual(full.terms.map((t) => t.term));
    expect(postings.offsets).toHaveLength(full.terms.length + 1);
    expect(postings.pages.buffer.byteLength).toBe(postings.pages.byteLength); // pas de tampon surdimensionné
    full.terms.forEach((entry, i) => {
      const from = postings.offsets[i] ?? -1;
      const to = postings.offsets[i + 1] ?? -1;
      expect(Array.from(postings.pages.subarray(from, to))).toEqual(entry.postings.map((p) => p.page));
      expect(Array.from(postings.termFrequencies.subarray(from, to))).toEqual(entry.postings.map((p) => p.termFrequency));
    });
    expect({ ...search, pageTermCounts: undefined, postings: undefined }).toEqual({
      normalizerVersion: full.normalizerVersion,
      extractorVersion: full.extractorVersion,
      sourcePath: full.sourcePath,
      pdfSize: full.pdfSize,
      pdfModifiedMs: full.pdfModifiedMs,
      pageTermCounts: undefined,
      postings: undefined,
    });
  });

  it("rejette une longueur de page supérieure à 2^32-1", async () => {
    const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(2 ** 32), blobs: [await deflate(encodeVarint(0))] });
    await expect(decodeIndexForSearch(bytes)).rejects.toThrow(CorruptDataError);
  });

  it("decodeIndex fournit toujours les wordOrdinals", async () => {
    const decoded = await decodeIndex(await encodeIndex(syntheticIndex(2, 3)));
    expect(decoded.terms[1]?.postings[0]?.wordOrdinals).toEqual([1]);
  });

  describe("ordinaux de mots non matérialisés mais toujours validés", () => {
    const dictionary = cat(encodeVarint(1), encodeVarint(0), encodeVarint(1), new Uint8Array([0x61]), encodeVarint(1), encodeVarint(0));
    const buildOneTerm = async (postings: Uint8Array): Promise<Uint8Array> =>
      buildDsx({ pageCount: 1, lengths: encodeVarint(2), dict: dictionary, postings, blobs: [await deflate(encodeVarint(0))] });

    it("rejette un dépassement de 2^53 dans la somme des ordinaux", async () => {
      const huge = encodeVarint(Number.MAX_SAFE_INTEGER);
      const bytes = await buildOneTerm(cat(encodeVarint(1), encodeVarint(2), huge, huge));
      await expect(decodeIndexForSearch(bytes)).rejects.toThrow(CorruptDataError);
      await expect(decodeIndex(bytes)).rejects.toThrow(CorruptDataError);
    });

    it("rejette des ordinaux tronqués", async () => {
      const bytes = await buildOneTerm(cat(encodeVarint(1), encodeVarint(3), encodeVarint(0)));
      await expect(decodeIndexForSearch(bytes)).rejects.toThrow(CorruptDataError);
    });

    it("accepte un fichier valide", async () => {
      const bytes = await buildOneTerm(cat(encodeVarint(1), encodeVarint(2), encodeVarint(0), encodeVarint(3)));
      const search = await decodeIndexForSearch(bytes);
      expect(search.postings.terms).toEqual(["a"]);
      expect(Array.from(search.postings.pages)).toEqual([1]);
      expect(Array.from(search.postings.termFrequencies)).toEqual([2]);
    });
  });

  it(
    "reste borné en temps sur 3 000 pages x 400 mots et ne matérialise aucune boîte",
    async () => {
      // La mémoire n'est volontairement PAS assertée ici : heapUsed sans ramasse-miettes
      // forcé varie de 60 à 100 Mo d'une exécution à l'autre (test instable). Le coût
      // mémoire réel d'un index de recherche est un risque suivi dans AVANCEMENT.md.
      const bytes = await encodeIndex(syntheticIndex(SEARCH_PAGES, SEARCH_WORDS_PER_PAGE));
      const started = performance.now();
      const search = await decodeIndexForSearch(bytes);
      const elapsed = performance.now() - started;
      expect(search.pageTermCounts).toHaveLength(SEARCH_PAGES);
      expect(search.postings.terms).toHaveLength(SEARCH_TERMS);
      expect("pageBoxes" in search).toBe(false);
      expect(elapsed).toBeLessThan(SEARCH_TIME_LIMIT_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it("n'inflate aucun blob de boîtes : un contenu corrompu n'est détecté qu'à la lecture de la page", async () => {
    // Choix de performance : 40 000 DecompressionStream au chargement sont trop coûteux. Seule la table
    // d'offsets/longueurs des blobs est validée (voir le test suivant) ; le contenu d'un blob est validé
    // par decodePageMatches / decodeIndex au moment où la page est réellement lue.
    const bad = await deflate(cat(encodeVarint(2), new Uint8Array(8))); // 2 boîtes annoncées, 1 fournie
    const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(0), blobs: [bad] });
    await expect(decodeIndexForSearch(bytes)).resolves.toBeDefined();
    await expect(decodePageMatches(bytes, 1, () => true)).rejects.toThrow(CorruptDataError);
    await expect(decodeIndex(bytes)).rejects.toThrow(CorruptDataError);
  });

  it("ne crée aucun DecompressionStream pour les blobs de boîtes", async () => {
    const bytes = await encodeIndex(syntheticIndex(20, 5));
    const Original = globalThis.DecompressionStream;
    let created = 0;
    globalThis.DecompressionStream = class extends Original {
      constructor(format: CompressionFormat) {
        super(format);
        created++;
      }
    } as typeof DecompressionStream;
    try {
      await decodeIndexForSearch(bytes);
    } finally {
      globalThis.DecompressionStream = Original;
    }
    expect(created).toBeLessThanOrEqual(3); // pageLengths, dictionnaire, postings
  });

  it("rejette une table de blobs incohérente (somme != taille de section)", async () => {
    const blob = await deflate(encodeVarint(0));
    const bytes = await buildDsx({ pageCount: 1, lengths: encodeVarint(0), blobs: [blob], tableLengths: [blob.length - 1] });
    await expect(decodeIndexForSearch(bytes)).rejects.toThrow(CorruptOffsetError);
  });
});
