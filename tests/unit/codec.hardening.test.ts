import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteWriter, encodeIndex, encodeVarint } from "../../src/core/codec/encode";
import { decodeIndex, decodePageBoxes, pageBlobOffsets, readVarint } from "../../src/core/codec/decode";
import {
  BOX_EPSILON,
  CorruptDataError,
  CorruptOffsetError,
  DsxFormatError,
  MAX_INFLATED_BLOB_BYTES,
  MAX_INFLATED_BYTES,
  MAX_SOURCE_PATH_BYTES,
  STREAM_CONCURRENCY,
  mapInBatches,
  type DocumentIndex,
  type WordBox,
} from "../../src/core/codec/format";

const BOMB_TIMEOUT_MS = 60_000;
const ZERO_CHUNK_BYTES = 1 << 20;
const FAKE_PAGE_COUNT = 2 ** 32;

function makeIndex(overrides: Partial<DocumentIndex> = {}): DocumentIndex {
  return {
    normalizerVersion: 1,
    extractorVersion: "x",
    sourcePath: "a.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: [],
    terms: [],
    pageBoxes: [],
    ...overrides,
  };
}

const box = (x: number, y: number, width: number, height: number): WordBox => ({ x, y, width, height });

// ---------- construction manuelle de fichiers (sections brutes -> fichier) ----------

function cat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);
const vi_ = (n: number): Uint8Array => encodeVarint(n);

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZeros(total: number): Promise<Uint8Array> {
  const chunk = new Uint8Array(ZERO_CHUNK_BYTES);
  let sent = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  const stream = source.pipeThrough(new CompressionStream("deflate-raw") as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface RawFile {
  pageCount?: number;
  version?: number;
  pdfSize?: number;
  pdfModifiedMs?: number;
  extractor?: Uint8Array;
  path?: Uint8Array;
  lengths?: Uint8Array;
  dict?: Uint8Array;
  postings?: Uint8Array;
  blobs?: readonly Uint8Array[];
  /** Sections déjà compressées (prioritaires sur les versions brutes). */
  packed?: Partial<Record<"lengths" | "dict" | "postings", Uint8Array>>;
  /** Blobs de boîtes déjà compressés (prioritaires sur `blobs`). */
  packedBlobs?: readonly Uint8Array[];
  trailing?: Uint8Array;
}

async function buildDsx(raw: RawFile = {}): Promise<Uint8Array> {
  const pageCount = raw.pageCount ?? 1;
  const extractor = raw.extractor ?? new Uint8Array(0);
  const path = raw.path ?? new Uint8Array(0);
  const blobs = raw.packedBlobs ?? (await Promise.all((raw.blobs ?? [vi_(0)]).map(deflate)));
  const sections = [
    raw.packed?.lengths ?? (await deflate(raw.lengths ?? new Uint8Array(pageCount))),
    raw.packed?.dict ?? (await deflate(raw.dict ?? vi_(0))),
    raw.packed?.postings ?? (await deflate(raw.postings ?? new Uint8Array(0))),
    cat(...blobs.map((b) => bytesOf(b.length & 0xff, (b.length >> 8) & 0xff, (b.length >> 16) & 0xff, 0)), ...blobs),
  ];
  const headerLength = 29 + extractor.length + 2 + path.length + 32;
  const header = new Uint8Array(headerLength);
  const view = new DataView(header.buffer);
  header.set([0x44, 0x53, 0x58, 0x31], 0);
  view.setUint16(4, raw.version ?? 1, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, raw.pageCount ?? pageCount, true);
  view.setFloat64(12, raw.pdfSize ?? 10, true);
  view.setFloat64(20, raw.pdfModifiedMs ?? 20, true);
  header[28] = extractor.length;
  header.set(extractor, 29);
  view.setUint16(29 + extractor.length, path.length, true);
  header.set(path, 31 + extractor.length);
  let offset = headerLength;
  sections.forEach((section, i) => {
    const entry = 31 + extractor.length + path.length + i * 8;
    view.setUint32(entry, offset, true);
    view.setUint32(entry + 4, section.length, true);
    offset += section.length;
  });
  return cat(header, ...sections, raw.trailing ?? new Uint8Array(0));
}

/** Entrée de dictionnaire : préfixe partagé, suffixe, df, offset des postings. */
const dictEntry = (shared: number, suffix: Uint8Array, df: number, offset: number): Uint8Array =>
  cat(vi_(shared), vi_(suffix.length), suffix, vi_(df), vi_(offset));
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => vi.unstubAllGlobals());

describe("constructeur de fichiers de test", () => {
  it("produit un fichier valide décodable (garde-fou des tests de corruption)", async () => {
    const dict = cat(vi_(1), dictEntry(0, ascii("a"), 1, 0));
    const postings = cat(vi_(1), vi_(1), vi_(4));
    const decoded = await decodeIndex(await buildDsx({ dict, postings, lengths: vi_(1) }));
    expect(decoded.terms).toEqual([{ term: "a", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [4] }] }]);
  });
});

describe("décodeur : toute erreur de format est un DsxFormatError", () => {
  it("UTF-8 invalide dans un terme", async () => {
    const dict = cat(vi_(1), dictEntry(0, bytesOf(0xff), 0, 0));
    await expect(decodeIndex(await buildDsx({ dict }))).rejects.toBeInstanceOf(DsxFormatError);
  });

  it.each([
    ["extractorVersion", { extractor: bytesOf(0xc3) }],
    ["sourcePath", { path: bytesOf(0xff, 0xfe) }],
  ])("UTF-8 invalide dans %s", async (_name, raw) => {
    await expect(decodeIndex(await buildDsx(raw))).rejects.toBeInstanceOf(DsxFormatError);
  });

  it("termFrequency géant sans allocation", async () => {
    const dict = cat(vi_(1), dictEntry(0, ascii("a"), 1, 0));
    const postings = cat(vi_(1), vi_(2 ** 40));
    await expect(decodeIndex(await buildDsx({ dict, postings }))).rejects.toBeInstanceOf(DsxFormatError);
    const moderate = cat(vi_(1), vi_(10_000_000));
    await expect(decodeIndex(await buildDsx({ dict, postings: moderate }))).rejects.toBeInstanceOf(DsxFormatError);
  });

  it("pageCount géant dans l'en-tête", async () => {
    const bytes = (await buildDsx()).slice();
    new DataView(bytes.buffer).setUint32(8, 0xffff_ffff, true);
    await expect(decodeIndex(bytes)).rejects.toBeInstanceOf(DsxFormatError);
    await expect(decodePageBoxes(bytes, 1)).rejects.toBeInstanceOf(DsxFormatError);
  });

  it("nombre de termes, longueur de chaîne, df et nombre de boîtes géants", async () => {
    const cases: RawFile[] = [
      { dict: vi_(2 ** 40) },
      { dict: cat(vi_(1), vi_(0), vi_(2 ** 40)) },
      { dict: cat(vi_(1), dictEntry(0, ascii("a"), 2 ** 40, 0)) },
      { blobs: [vi_(2 ** 40)] },
    ];
    for (const raw of cases) {
      await expect(decodeIndex(await buildDsx(raw))).rejects.toBeInstanceOf(DsxFormatError);
    }
  });
});

describe("décodeur : erreurs d'environnement et cause", () => {
  it("laisse remonter l'absence de DecompressionStream", async () => {
    const bytes = await buildDsx();
    const failure = new ReferenceError("DecompressionStream is not defined");
    vi.stubGlobal(
      "DecompressionStream",
      class {
        constructor() {
          throw failure;
        }
      },
    );
    const error = await decodeIndex(bytes).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(DsxFormatError);
    await expect(decodePageBoxes(bytes, 1)).rejects.toBe(failure);
  });

  it("convertit une erreur de flux en CorruptDataError en conservant la cause", async () => {
    const garbage = bytesOf(0xff, 0xff, 0xff, 0xff, 0xff);
    const error = await decodeIndex(await buildDsx({ packed: { dict: garbage } })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CorruptDataError);
    expect((error as CorruptDataError).cause).toBeDefined();
  });
});

describe("décodeur : bombes de décompression", () => {
  it(
    "refuse une section qui dépasse MAX_INFLATED_BYTES",
    async () => {
      const packed = { dict: await deflateZeros(MAX_INFLATED_BYTES + 1) };
      await expect(decodeIndex(await buildDsx({ packed }))).rejects.toThrow(CorruptDataError);
    },
    BOMB_TIMEOUT_MS,
  );

  it(
    "refuse un blob de boîtes qui dépasse MAX_INFLATED_BLOB_BYTES",
    async () => {
      const packedBlobs = [await deflateZeros(MAX_INFLATED_BLOB_BYTES + 1)];
      const bytes = await buildDsx({ packedBlobs });
      await expect(decodeIndex(bytes)).rejects.toThrow(CorruptDataError);
      await expect(decodePageBoxes(bytes, 1)).rejects.toThrow(CorruptDataError);
    },
    BOMB_TIMEOUT_MS,
  );
});

describe("décodeur : invariants", () => {
  const onePosting = (pageDelta: number): RawFile => ({
    dict: cat(vi_(1), dictEntry(0, ascii("a"), 1, 0)),
    postings: cat(vi_(pageDelta), vi_(1), vi_(0)),
  });

  it("refuse la page 0 et les pages dupliquées", async () => {
    await expect(decodeIndex(await buildDsx(onePosting(0)))).rejects.toThrow(CorruptDataError);
    const twice: RawFile = {
      pageCount: 2,
      lengths: bytesOf(0, 0),
      blobs: [vi_(0), vi_(0)],
      dict: cat(vi_(1), dictEntry(0, ascii("a"), 2, 0)),
      postings: cat(vi_(1), vi_(1), vi_(0), vi_(0), vi_(1), vi_(0)),
    };
    await expect(decodeIndex(await buildDsx(twice))).rejects.toThrow(CorruptDataError);
  });

  it("refuse une page de posting au-delà du nombre de pages", async () => {
    await expect(decodeIndex(await buildDsx(onePosting(2)))).rejects.toThrow(CorruptDataError);
  });

  it("refuse des termes non strictement croissants", async () => {
    const decreasing = cat(vi_(2), dictEntry(0, ascii("b"), 0, 0), dictEntry(0, ascii("a"), 0, 0));
    const duplicate = cat(vi_(2), dictEntry(0, ascii("a"), 0, 0), dictEntry(1, ascii(""), 0, 0));
    await expect(decodeIndex(await buildDsx({ dict: decreasing }))).rejects.toThrow(CorruptDataError);
    await expect(decodeIndex(await buildDsx({ dict: duplicate }))).rejects.toThrow(CorruptDataError);
  });

  it.each([
    ["lengths", { lengths: bytesOf(0, 0) }],
    ["dict", { dict: cat(vi_(0), bytesOf(0)) }],
    ["postings", { postings: bytesOf(0) }],
    ["blob", { blobs: [cat(vi_(0), bytesOf(0))] }],
  ])("refuse des octets en trop dans la section %s", async (_name, raw) => {
    await expect(decodeIndex(await buildDsx(raw))).rejects.toThrow(CorruptDataError);
  });

  it("refuse un blob de boîtes avec octets en trop même via decodePageBoxes", async () => {
    const bytes = await buildDsx({ blobs: [cat(vi_(0), bytesOf(0))] });
    await expect(decodePageBoxes(bytes, 1)).rejects.toThrow(CorruptDataError);
  });

  it("compare l'offset des postings à l'offset réel", async () => {
    const raw = onePosting(1);
    const dict = cat(vi_(1), dictEntry(0, ascii("a"), 1, 5));
    await expect(decodeIndex(await buildDsx({ ...raw, dict }))).rejects.toThrow(CorruptOffsetError);
  });

  it("refuse des octets en trop après la dernière section", async () => {
    await expect(decodeIndex(await buildDsx({ trailing: bytesOf(0) }))).rejects.toThrow(DsxFormatError);
  });

  it("refuse une version de format 0", async () => {
    const error = await decodeIndex(await buildDsx({ version: 0 })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DsxFormatError);
  });

  it.each([
    ["pdfSize NaN", { pdfSize: Number.NaN }],
    ["pdfSize Infinity", { pdfSize: Number.POSITIVE_INFINITY }],
    ["pdfSize négatif", { pdfSize: -1 }],
    ["pdfModifiedMs NaN", { pdfModifiedMs: Number.NaN }],
    ["pdfModifiedMs Infinity", { pdfModifiedMs: Number.NEGATIVE_INFINITY }],
    ["pdfModifiedMs négatif", { pdfModifiedMs: -5 }],
  ])("refuse %s", async (_name, raw) => {
    await expect(decodeIndex(await buildDsx(raw))).rejects.toBeInstanceOf(DsxFormatError);
  });
});

describe("varint : lecture stricte", () => {
  it("refuse un encodage non canonique", () => {
    expect(() => readVarint(bytesOf(0x80, 0x00), 0)).toThrow(CorruptDataError);
    expect(() => readVarint(bytesOf(0xff, 0x80, 0x00), 0)).toThrow(CorruptDataError);
  });

  it("refuse les valeurs au-delà de 2^53-1 (imprécises)", () => {
    const sevenContinuations = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80];
    expect(() => readVarint(bytesOf(...sevenContinuations, 0x10), 0)).toThrow(CorruptDataError); // 2^53
    expect(() => readVarint(bytesOf(...sevenContinuations, 0x7f), 0)).toThrow(CorruptDataError);
    expect(() => readVarint(bytesOf(...sevenContinuations, 0x80, 0x01), 0)).toThrow(CorruptDataError);
  });

  it("accepte 2^53-1 et 2^32-1", () => {
    expect(readVarint(encodeVarint(Number.MAX_SAFE_INTEGER), 0).value).toBe(Number.MAX_SAFE_INTEGER);
    expect(readVarint(encodeVarint(2 ** 32 - 1), 0).value).toBe(2 ** 32 - 1);
  });
});

describe("encodeur : débordements et valeurs invalides", () => {
  it.each([
    ["normalizerVersion", { normalizerVersion: 65536 }],
    ["normalizerVersion", { normalizerVersion: -1 }],
    ["normalizerVersion", { normalizerVersion: 1.5 }],
    ["pdfSize", { pdfSize: Number.NaN }],
    ["pdfSize", { pdfSize: Number.POSITIVE_INFINITY }],
    ["pdfSize", { pdfSize: -1 }],
    ["pdfModifiedMs", { pdfModifiedMs: Number.NaN }],
    ["pdfModifiedMs", { pdfModifiedMs: Number.NEGATIVE_INFINITY }],
    ["pdfModifiedMs", { pdfModifiedMs: -1 }],
  ])("lève une RangeError nommant %s", async (field, overrides) => {
    const error = await encodeIndex(makeIndex(overrides)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toContain(field);
  });

  it("lève une RangeError pour un nombre de pages hors u32", async () => {
    const fake = { length: FAKE_PAGE_COUNT } as unknown as readonly number[];
    const fakeBoxes = { length: FAKE_PAGE_COUNT } as unknown as readonly (readonly WordBox[])[];
    const error = await encodeIndex(makeIndex({ pageTermCounts: fake, pageBoxes: fakeBoxes })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toContain("pageCount");
  });

  it("nomme le terme dans l'erreur d'ordinaux décroissants", async () => {
    const index = makeIndex({
      pageTermCounts: [2],
      pageBoxes: [[]],
      terms: [{ term: "zeta", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [5, 3] }] }],
    });
    await expect(encodeIndex(index)).rejects.toThrow(/zeta/);
  });
});

describe("encodeur : sourcePath", () => {
  it.each(["", "assets/doc.pdf", "assets/日本語/café 😀.pdf", "a".repeat(MAX_SOURCE_PATH_BYTES)])(
    "aller-retour de %j",
    async (sourcePath) => {
      const decoded = await decodeIndex(await encodeIndex(makeIndex({ sourcePath })));
      expect(decoded.sourcePath).toBe(sourcePath);
    },
  );

  it("refuse un chemin de plus de 65535 octets UTF-8 (en octets, pas en caractères)", async () => {
    const tooLong = "a".repeat(MAX_SOURCE_PATH_BYTES + 1);
    await expect(encodeIndex(makeIndex({ sourcePath: tooLong }))).rejects.toThrow(RangeError);
    await expect(encodeIndex(makeIndex({ sourcePath: tooLong }))).rejects.toThrow(/sourcePath/);
    const multibyte = "é".repeat(MAX_SOURCE_PATH_BYTES / 2 + 1);
    await expect(encodeIndex(makeIndex({ sourcePath: multibyte }))).rejects.toThrow(/sourcePath/);
  });
});

describe("encodeur : coordonnées de boîtes", () => {
  const withBox = (b: WordBox): DocumentIndex => makeIndex({ pageTermCounts: [0], pageBoxes: [[b]] });

  it.each([
    box(1.5, 0, 0, 0),
    box(-0.1, 0, 0, 0),
    box(0, 2, 0, 0),
    box(0, 0, -0.5, 0),
    box(0, 0, 0, 1.0001),
    box(0.6, 0, 0.6, 0),
    box(0, 0.7, 0, 0.5),
  ])("lève une RangeError pour %j", async (b) => {
    await expect(encodeIndex(withBox(b))).rejects.toThrow(RangeError);
  });

  it("écrête dans la tolérance epsilon et décode à l'intérieur de [0,1]", async () => {
    const e = BOX_EPSILON / 2;
    const decoded = await decodeIndex(await encodeIndex(withBox(box(-e, 1 + e, 0.5, 0))));
    const [b] = decoded.pageBoxes[0] ?? [];
    expect(b?.x).toBe(0);
    expect(b?.y).toBe(1);
  });

  it("préserve x+width <= 1 après quantification (ré-encodage possible)", async () => {
    const index = withBox(box(0.5, 0.5, 0.5, 0.5));
    const once = await decodeIndex(await encodeIndex(index));
    const [b] = once.pageBoxes[0] ?? [];
    expect((b?.x ?? 9) + (b?.width ?? 9)).toBeLessThanOrEqual(1 + 1e-12);
    await expect(encodeIndex(once)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("performance et mémoire", () => {
  function tracker(Real: typeof CompressionStream | typeof DecompressionStream) {
    const stats = { live: 0, max: 0, total: 0 };
    class Tracking {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(format: CompressionFormat) {
        const real = new Real(format);
        stats.live++;
        stats.total++;
        stats.max = Math.max(stats.max, stats.live);
        const tail = new TransformStream<Uint8Array, Uint8Array>({ flush: () => void stats.live-- });
        this.writable = real.writable as WritableStream<Uint8Array>;
        this.readable = (real.readable as ReadableStream<Uint8Array>).pipeThrough(tail);
      }
    }
    return { stats, Tracking };
  }

  const manyPages = (n: number): DocumentIndex =>
    makeIndex({
      pageTermCounts: Array.from({ length: n }, () => 1),
      pageBoxes: Array.from({ length: n }, () => [box(0.1, 0.1, 0.1, 0.1)]),
    });

  it("limite la concurrence des CompressionStream à STREAM_CONCURRENCY", async () => {
    const { stats, Tracking } = tracker(CompressionStream);
    vi.stubGlobal("CompressionStream", Tracking);
    await encodeIndex(manyPages(100));
    expect(stats.total).toBeGreaterThanOrEqual(100);
    expect(stats.max).toBeLessThanOrEqual(STREAM_CONCURRENCY);
  });

  it("limite la concurrence des DecompressionStream à STREAM_CONCURRENCY", async () => {
    const bytes = await encodeIndex(manyPages(100));
    const { stats, Tracking } = tracker(DecompressionStream);
    vi.stubGlobal("DecompressionStream", Tracking);
    await decodeIndex(bytes);
    expect(stats.total).toBeGreaterThanOrEqual(100);
    expect(stats.max).toBeLessThanOrEqual(STREAM_CONCURRENCY);
  });

  it("encode un million d'ordinaux sous une borne large", async () => {
    const ordinals = Array.from({ length: 1_000_000 }, (_, i) => i * 3);
    const index = makeIndex({
      pageTermCounts: [ordinals.length],
      pageBoxes: [[]],
      terms: [{ term: "t", postings: [{ page: 1, termFrequency: ordinals.length, wordOrdinals: ordinals }] }],
    });
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.terms[0]?.postings[0]?.wordOrdinals).toEqual(ordinals);
  }, 30_000);
});

describe("ByteWriter, pageBlobOffsets, mapInBatches", () => {
  it("ByteWriter croît par doublement et écrit varints et octets", () => {
    const writer = new ByteWriter(1);
    writer.varint(300);
    writer.bytes(bytesOf(1, 2, 3));
    writer.varint(0);
    expect(Array.from(writer.finish())).toEqual([0xac, 0x02, 1, 2, 3, 0]);
    expect(writer.length).toBe(6);
  });

  it("pageBlobOffsets précalcule les départs cumulés et valide la somme", () => {
    const section = cat(bytesOf(2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0), new Uint8Array(5));
    expect(pageBlobOffsets(section, 3)).toEqual([12, 14, 17, 17]);
    expect(() => pageBlobOffsets(section.subarray(0, 8), 3)).toThrow(DsxFormatError);
    expect(() => pageBlobOffsets(cat(section, bytesOf(0)), 3)).toThrow(CorruptOffsetError);
  });

  it("mapInBatches conserve l'ordre et borne le parallélisme", async () => {
    let live = 0;
    let max = 0;
    const result = await mapInBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++;
      max = Math.max(max, live);
      await Promise.resolve();
      live--;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBeLessThanOrEqual(3);
  });
});

describe("limites", () => {
  it("encode et décode 100 000 termes sous une borne large", async () => {
    const terms = Array.from({ length: 100_000 }, (_, i) => ({
      term: `terme${i}`,
      postings: [{ page: 1, termFrequency: 1, wordOrdinals: [i] }],
    }));
    const index = makeIndex({ pageTermCounts: [terms.length], pageBoxes: [[]], terms });
    const started = Date.now();
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.terms).toHaveLength(terms.length);
    expect(new Set(decoded.terms.map((t) => t.term))).toEqual(new Set(terms.map((t) => t.term)));
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
