import { describe, expect, it } from "vitest";
import { encodeIndex, encodeVarint } from "../../src/core/codec/encode";
import { decodeIndex, decodePageBoxes, readVarint } from "../../src/core/codec/decode";
import {
  CorruptOffsetError,
  DSX_FORMAT_VERSION,
  InvalidMagicError,
  TruncatedFileError,
  UnsupportedVersionError,
  type DocumentIndex,
  type WordBox,
} from "../../src/core/codec/format";

const QUANTUM = 1 / 65535;
const MAX_JSON_RATIO_INVERSE = 4;

function makeIndex(overrides: Partial<DocumentIndex> = {}): DocumentIndex {
  const pageTermCounts = overrides.pageTermCounts ?? [];
  return {
    normalizerVersion: 1,
    extractorVersion: "4.0.379",
    sourcePath: "assets/doc.pdf",
    pdfSize: 1234567,
    pdfModifiedMs: 1700000000000,
    pageTermCounts: [],
    terms: [],
    pageBoxes: [],
    pageSizes: pageTermCounts.map(() => ({ widthPt: 595, heightPt: 842 })),
    ...overrides,
  };
}

function box(x: number, y: number, width: number, height: number): WordBox {
  return { x, y, width, height };
}

function smallIndex(): DocumentIndex {
  return makeIndex({
    pageTermCounts: [3, 0, 2],
    terms: [
      { term: "alpha", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [0, 2] }] },
      {
        term: "beta",
        postings: [
          { page: 1, termFrequency: 1, wordOrdinals: [1] },
          { page: 3, termFrequency: 1, wordOrdinals: [0] },
        ],
      },
      { term: "gamma", postings: [{ page: 3, termFrequency: 1, wordOrdinals: [1] }] },
    ],
    pageBoxes: [
      [box(0, 0, 0.5, 0.25), box(0.5, 0.25, 0.25, 0.25), box(0.75, 0.5, 0.25, 0.5)],
      [],
      [box(0.1, 0.2, 0.3, 0.4), box(1, 1, 0, 0)],
    ],
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Début de la table des sections : 29 + E + 2 + S (voir la spécification de format.ts). */
function sectionTableStart(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const afterExtractor = 29 + (bytes[28] ?? 0);
  return afterExtractor + 2 + view.getUint16(afterExtractor, true);
}

function expectBoxesClose(actual: readonly WordBox[], expected: readonly WordBox[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    const a = actual[i];
    if (a === undefined) throw new Error(`box ${i} is missing in the decoded page`);
    expect(Math.abs(a.x - e.x)).toBeLessThanOrEqual(QUANTUM);
    expect(Math.abs(a.y - e.y)).toBeLessThanOrEqual(QUANTUM);
    expect(Math.abs(a.width - e.width)).toBeLessThanOrEqual(QUANTUM);
    expect(Math.abs(a.height - e.height)).toBeLessThanOrEqual(QUANTUM);
  });
}

describe("varint", () => {
  it.each([0, 1, 127, 128, 300, 16384, 2 ** 32 - 1, Number.MAX_SAFE_INTEGER])("round-trips %i", (value) => {
    const bytes = encodeVarint(value);
    expect(readVarint(bytes, 0)).toEqual({ value, next: bytes.length });
  });

  it("uses the expected byte lengths", () => {
    expect(Array.from(encodeVarint(0))).toEqual([0]);
    expect(Array.from(encodeVarint(127))).toEqual([127]);
    expect(Array.from(encodeVarint(128))).toEqual([0x80, 0x01]);
    expect(encodeVarint(2 ** 32 - 1)).toHaveLength(5);
  });

  it("rejects negative, fractional and non-finite values", () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => encodeVarint(1.5)).toThrow(RangeError);
    expect(() => encodeVarint(Number.NaN)).toThrow(RangeError);
  });

  it("rejects a truncated varint", () => {
    expect(() => readVarint(new Uint8Array([0x80]), 0)).toThrow(TruncatedFileError);
  });
});

describe("round trip", () => {
  it("handles an empty document", async () => {
    const index = makeIndex();
    expect(await decodeIndex(await encodeIndex(index))).toEqual(index);
  });

  it("handles documents with only empty pages", async () => {
    const index = makeIndex({ pageTermCounts: [0, 0], pageBoxes: [[], []] });
    expect(await decodeIndex(await encodeIndex(index))).toEqual(index);
  });

  it("round-trips terms, postings and metadata exactly", async () => {
    const index = smallIndex();
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.terms).toEqual(index.terms);
    expect(decoded.pageTermCounts).toEqual(index.pageTermCounts);
    expect(decoded.normalizerVersion).toBe(1);
    expect(decoded.extractorVersion).toBe("4.0.379");
    expect(decoded.pdfSize).toBe(1234567);
    expect(decoded.pdfModifiedMs).toBe(1700000000000);
    expect(decoded.pageBoxes[1]).toEqual([]);
  });

  it("preserves Unicode terms and extractor version", async () => {
    const terms = ["café", "naïve", "日本語", "検索", "😀emoji"].sort();
    const index = makeIndex({
      extractorVersion: "pdfjs-é-日本",
      pageTermCounts: [terms.length],
      terms: terms.map((term, i) => ({
        term,
        postings: [{ page: 1, termFrequency: 1, wordOrdinals: [i] }],
      })),
      pageBoxes: [terms.map(() => box(0, 0, 0.1, 0.1))],
    });
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.terms.map((t) => t.term)).toEqual(terms);
    expect(decoded.extractorVersion).toBe("pdfjs-é-日本");
  });

  it("handles many pages", async () => {
    const pageCount = 1500;
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
    const index = makeIndex({
      pageTermCounts: pages.map((p) => p % 7),
      terms: [
        {
          term: "common",
          postings: pages.map((page) => ({ page, termFrequency: 1, wordOrdinals: [page % 5] })),
        },
      ],
      pageBoxes: pages.map(() => [box(0.25, 0.25, 0.5, 0.5)]),
    });
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.terms).toEqual(index.terms);
    expect(decoded.pageTermCounts).toEqual(index.pageTermCounts);
    expect(decoded.pageBoxes).toHaveLength(pageCount);
  });

  it("handles terms sharing long prefixes", async () => {
    const terms = ["inter", "interact", "interaction", "interactions", "interface", "internal", "x"];
    const index = makeIndex({
      pageTermCounts: [terms.length],
      terms: terms.map((term, i) => ({
        term,
        postings: [{ page: 1, termFrequency: 1, wordOrdinals: [i] }],
      })),
      pageBoxes: [terms.map(() => box(0, 0, 0, 0))],
    });
    expect((await decodeIndex(await encodeIndex(index))).terms).toEqual(index.terms);
  });

  it("sorts unsorted terms by UTF-8 byte order and rejects duplicates", async () => {
    const posting = [{ page: 1, termFrequency: 1, wordOrdinals: [0] }];
    const unsorted = makeIndex({
      pageTermCounts: [1],
      terms: [
        { term: "b", postings: posting },
        { term: "a", postings: posting },
      ],
      pageBoxes: [[box(0, 0, 0, 0)]],
    });
    const decoded = await decodeIndex(await encodeIndex(unsorted));
    expect(decoded.terms.map((t) => t.term)).toEqual(["a", "b"]);
    const duplicated = { ...unsorted, terms: [unsorted.terms[0], unsorted.terms[0]] as never };
    await expect(encodeIndex(duplicated)).rejects.toThrow(/duplicate/i);
  });

  it("quantizes boxes at the 0 and 1 bounds within 1/65535", async () => {
    const boxes = [box(0, 0, 0, 0), box(0, 0, 1, 1), box(1, 1, 0, 0), box(0.123456, 0.654321, 0.333333, 0.345678)];
    const index = makeIndex({ pageTermCounts: [0], pageBoxes: [boxes] });
    const decoded = await decodeIndex(await encodeIndex(index));
    expectBoxesClose(decoded.pageBoxes[0] ?? [], boxes);
    expect(decoded.pageBoxes[0]?.[0]).toEqual(box(0, 0, 0, 0));
    expect(decoded.pageBoxes[0]?.[1]).toEqual(box(0, 0, 1, 1));
    expect(decoded.pageBoxes[0]?.[2]).toEqual(box(1, 1, 0, 0));
  });

  it("is idempotent after quantization", async () => {
    const once = await encodeIndex(smallIndex());
    const twice = await encodeIndex(await decodeIndex(once));
    expect(toHex(twice)).toBe(toHex(once));
  });

  it("rejects invalid inputs at encode time", async () => {
    await expect(encodeIndex(makeIndex({ pageTermCounts: [1] }))).rejects.toThrow(/page/i);
    await expect(
      encodeIndex(makeIndex({ pageTermCounts: [0], pageBoxes: [[box(Number.NaN, 0, 0, 0)]] })),
    ).rejects.toThrow(RangeError);
    await expect(
      encodeIndex(
        makeIndex({
          pageTermCounts: [1],
          pageBoxes: [[]],
          terms: [{ term: "a", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [0] }] }],
        }),
      ),
    ).rejects.toThrow(/termFrequency/);
  });
});

describe("invalid files", () => {
  it("rejects an invalid magic signature", async () => {
    const bytes = await encodeIndex(smallIndex());
    const bad = bytes.slice();
    bad[0] = 0x58;
    await expect(decodeIndex(bad)).rejects.toThrow(InvalidMagicError);
    await expect(decodeIndex(bad)).rejects.toThrow(/DSX1/);
  });

  it("rejects a future format version", async () => {
    const bad = (await encodeIndex(smallIndex())).slice();
    new DataView(bad.buffer).setUint16(4, DSX_FORMAT_VERSION + 1, true);
    await expect(decodeIndex(bad)).rejects.toThrow(UnsupportedVersionError);
    await expect(decodeIndex(bad)).rejects.toThrow(/version/i);
  });

  it("rejects truncated files at every cut point class", async () => {
    const bytes = await encodeIndex(smallIndex());
    for (const length of [0, 3, 10, 40, bytes.length - 1]) {
      await expect(decodeIndex(bytes.slice(0, length))).rejects.toThrow(TruncatedFileError);
    }
  });

  it("rejects an inconsistent section offset", async () => {
    const bytes = (await encodeIndex(smallIndex())).slice();
    new DataView(bytes.buffer).setUint32(sectionTableStart(bytes) + 8, 7, true);
    await expect(decodeIndex(bytes)).rejects.toThrow(CorruptOffsetError);
    await expect(decodePageBoxes(bytes, 1)).rejects.toThrow(CorruptOffsetError);
  });

  it("rejects an out-of-range page number", async () => {
    const bytes = await encodeIndex(smallIndex());
    await expect(decodePageBoxes(bytes, 0)).rejects.toThrow(RangeError);
    await expect(decodePageBoxes(bytes, 4)).rejects.toThrow(RangeError);
  });
});

describe("lazy page box decoding", () => {
  it("decodes one page without decoding the others", async () => {
    const bytes = (await encodeIndex(smallIndex())).slice();
    const boxesSectionStart = new DataView(bytes.buffer).getUint32(sectionTableStart(bytes) + 24, true);
    expect(boxesSectionStart).toBeGreaterThan(0);
    const clean = await decodePageBoxes(bytes, 3);
    expectBoxesClose(clean, smallIndex().pageBoxes[2] ?? []);

    // Corrupt the last byte of the file: page 3 blob is last, so corrupt page 1 blob instead.
    const corrupted = bytes.slice();
    corrupted[boxesSectionStart + 3 * 4] = 0xff;
    corrupted[boxesSectionStart + 3 * 4 + 1] = 0xff;
    await expect(decodePageBoxes(corrupted, 1)).rejects.toThrow();
    expectBoxesClose(await decodePageBoxes(corrupted, 3), smallIndex().pageBoxes[2] ?? []);
    expect(await decodePageBoxes(corrupted, 2)).toEqual([]);
    await expect(decodeIndex(corrupted)).rejects.toThrow();
  });
});

describe("stabilité du format et compression", () => {
  it("stabilité du format : octets figés pour un petit exemple (à régénérer volontairement)", async () => {
    const bytes = await encodeIndex(smallIndex());
    expect(toHex(bytes.slice(0, 8))).toBe("44535831" + "0200" + "0100");
    expect(toHex(bytes)).toBe(EXPECTED_SMALL_HEX);
  });

  it("compresses a repetitive example far below the equivalent JSON", async () => {
    const pages = Array.from({ length: 300 }, (_, i) => i + 1);
    const index = makeIndex({
      pageTermCounts: pages.map(() => 40),
      terms: ["alpha", "beta", "gamma", "delta"].map((term) => ({
        term,
        postings: pages.map((page) => ({ page, termFrequency: 2, wordOrdinals: [3, 9] })),
      })),
      pageBoxes: pages.map(() => Array.from({ length: 40 }, (_, k) => box(k / 40, 0.5, 0.02, 0.02))),
    });
    const bytes = await encodeIndex(index);
    const jsonSize = new TextEncoder().encode(JSON.stringify(index)).length;
    // Borne large et documentée : mesuré à environ 1/30 du JSON ; on exige seulement < 1/4,
    // pour ne casser que sur une régression réelle (compression absente) et non sur un réglage deflate.
    expect(bytes.length).toBeLessThan(jsonSize / MAX_JSON_RATIO_INVERSE);
  });
});

const EXPECTED_SMALL_HEX =
  "4453583102000100030000000000000087d6324100008056febc784207342e302e3337390e006173736574732f646f632e7064665400000005000000590000001d000000760000000f000000850000003d00000063666002006366604dcc29c84864646060494a2d49646261604d4fcccd4d64e40200636462606264646462646066640400160000000700000014000000dba7f7c4919901041a181cc01808ffef07b1fed70300dba7f7c4910100dba7f7c4916996a4b1f1599fb4b4ff40c0000400";
