import { describe, expect, it } from "vitest";
import { decodeIndex, decodeIndexForSearch, decodePageBoxes, decodePageMatches, decodePagesMatches } from "../../src/core/codec/decode";
import { encodeIndex } from "../../src/core/codec/encode";
import {
  BudgetExceededError,
  CorruptDataError,
  DSX_FORMAT_VERSION,
  DsxFormatError,
  FALLBACK_PAGE_SIZE,
  MAX_PAGE_DIMENSION_PT,
  TruncatedFileError,
  UnsupportedVersionError,
  pageDimensionToUnits,
  unitsToPageDimension,
  type DocumentIndex,
} from "../../src/core/codec/format";
import { ASSUMED_PAGE_HEIGHT_PT, ASSUMED_PAGE_WIDTH_PT } from "../../src/core/constants";
import { formatVersionOf, inflateRaw, pageBlobLocations } from "./helpers/dsxLayout";

/**
 * Fixtures construites octet par octet d'après la spécification (en-tête de format.ts), sans appeler
 * l'encodeur : v1 (blob = varint n + boîtes) et v2 (blob = varint largeur, varint hauteur en dixièmes
 * de point, varint n + boîtes).
 */
async function deflate(data: readonly number[]): Promise<number[]> {
  const stream = new Blob([Uint8Array.from(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return Array.from(new Uint8Array(await new Response(stream).arrayBuffer()));
}

function le(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, i) => Math.floor(value / 256 ** i) % 256);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

const ONE_BOX = [0x01, ...le(0, 2), ...le(0, 2), ...le(65535, 2), ...le(32768, 2)];

/** Fichier d'une page, un terme "a" à l'ordinal 0 ; `blobRaw` = contenu décompressé du blob de la page. */
async function handBuilt(version: number, blobRaw: readonly number[]): Promise<Uint8Array> {
  const sections = [
    await deflate([0x01]),
    await deflate([0x01, 0x00, 0x01, 0x61, 0x01, 0x00]),
    await deflate([0x01, 0x01, 0x00]),
  ];
  const blob = await deflate(blobRaw);
  sections.push([...le(blob.length, 4), ...blob]);
  const extractor = [0x65];
  const path = [0x70];
  const headerBytes = 29 + extractor.length + 2 + path.length + 32;
  const table: number[] = [];
  let offset = headerBytes;
  for (const section of sections) {
    table.push(...le(offset, 4), ...le(section.length, 4));
    offset += section.length;
  }
  const header = [
    0x44, 0x53, 0x58, 0x31,
    ...le(version, 2),
    ...le(7, 2),
    ...le(1, 4),
    0, 0, 0, 0, 0, 0, 0x70, 0x40,
    0, 0, 0, 0, 0, 0, 0x90, 0x40,
    extractor.length,
    ...extractor,
    ...le(path.length, 2),
    ...path,
    ...table,
  ];
  return Uint8Array.from([...header, ...sections.flat()]);
}

const v1File = (): Promise<Uint8Array> => handBuilt(1, ONE_BOX);
// 612 x 792 pt = 6120 et 7920 dixièmes.
const v2File = (widthTenths = 6120, heightTenths = 7920): Promise<Uint8Array> =>
  handBuilt(2, [...varint(widthTenths), ...varint(heightTenths), ...ONE_BOX]);

const FALLBACK = { widthPt: ASSUMED_PAGE_WIDTH_PT, heightPt: ASSUMED_PAGE_HEIGHT_PT };
const BOX = { x: 0, y: 0, width: 1, height: 32768 / 65535 };

function makeIndex(overrides: Partial<DocumentIndex> = {}): DocumentIndex {
  return {
    normalizerVersion: 1,
    extractorVersion: "docseeker-extract-2",
    sourcePath: "a.pdf",
    pdfSize: 10,
    pdfModifiedMs: 20,
    pageTermCounts: [1, 0],
    terms: [{ term: "a", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [0] }] }],
    pageBoxes: [[{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }], []],
    pageSizes: [
      { widthPt: 595.3, heightPt: 841.9 },
      { widthPt: 842, heightPt: 595 },
    ],
    ...overrides,
  };
}

describe("constantes et conversions partagées des tailles de page", () => {
  it("le plafond d'une dimension est de 20 000 pt", () => {
    expect(MAX_PAGE_DIMENSION_PT).toBe(20_000);
  });

  it("pageDimensionToUnits arrondit au dixième de point et unitsToPageDimension l'inverse", () => {
    expect(pageDimensionToUnits(595.3)).toBe(5953);
    expect(pageDimensionToUnits(841.9)).toBe(8419);
    expect(pageDimensionToUnits(595.276)).toBe(5953);
    expect(pageDimensionToUnits(0.04)).toBe(0);
    expect(unitsToPageDimension(5953)).toBe(595.3);
    expect(unitsToPageDimension(1)).toBe(0.1);
  });

  it("le repli A4 unique : ASSUMED_PAGE_WIDTH_PT = 595 donne 5950 dixièmes", () => {
    expect(ASSUMED_PAGE_WIDTH_PT).toBe(595);
    expect(pageDimensionToUnits(FALLBACK_PAGE_SIZE.widthPt)).toBe(5950);
    expect(pageDimensionToUnits(FALLBACK_PAGE_SIZE.heightPt)).toBe(8420);
    expect(FALLBACK_PAGE_SIZE).toEqual({ widthPt: ASSUMED_PAGE_WIDTH_PT, heightPt: ASSUMED_PAGE_HEIGHT_PT });
  });
});

describe("octets d'un blob de boîtes v2 (assemblage manuel indépendant)", () => {
  it("595.3 x 841.9 -> varint(5953) || varint(8419) || varint(n) || boîtes, version 2 à l'offset 4", async () => {
    const index = makeIndex({
      pageTermCounts: [1],
      pageBoxes: [[{ x: 0, y: 0, width: 1, height: 32768 / 65535 }]],
      pageSizes: [{ widthPt: 595.3, heightPt: 841.9 }],
    });
    const bytes = await encodeIndex(index);
    expect(bytes[4]).toBe(2);
    expect(bytes[5]).toBe(0);
    expect(formatVersionOf(bytes)).toBe(2);
    const [blob] = pageBlobLocations(bytes);
    const raw = await inflateRaw(bytes.subarray(blob!.offset, blob!.offset + blob!.length));
    expect(Array.from(raw)).toEqual([...varint(5953), ...varint(8419), ...varint(1), ...ONE_BOX.slice(1)]);
  });
});

describe("format v2 : tailles de page", () => {
  it("l'encodeur écrit la version 2", async () => {
    expect(DSX_FORMAT_VERSION).toBe(2);
    const bytes = await encodeIndex(makeIndex());
    expect(new DataView(bytes.buffer).getUint16(4, true)).toBe(2);
  });

  it("aller-retour : tailles de page conservées au dixième de point", async () => {
    const index = makeIndex();
    const decoded = await decodeIndex(await encodeIndex(index));
    expect(decoded.pageSizes).toEqual(index.pageSizes);
  });

  it("arrondit au dixième de point à l'encodage", async () => {
    const decoded = await decodeIndex(
      await encodeIndex(makeIndex({ pageSizes: [{ widthPt: 595.276, heightPt: 841.89 }, { widthPt: 1, heightPt: 2 }] })),
    );
    expect(decoded.pageSizes[0]).toEqual({ widthPt: 595.3, heightPt: 841.9 });
  });

  it("accepte les bornes (0,1 pt et le maximum)", async () => {
    const sizes = [
      { widthPt: 0.1, heightPt: 0.1 },
      { widthPt: MAX_PAGE_DIMENSION_PT, heightPt: MAX_PAGE_DIMENSION_PT },
    ];
    const decoded = await decodeIndex(await encodeIndex(makeIndex({ pageSizes: sizes })));
    expect(decoded.pageSizes).toEqual(sizes);
  });

  it("un fichier v2 construit à la main est lu (tailles et boîtes)", async () => {
    const decoded = await decodeIndex(await v2File());
    expect(decoded.pageSizes).toEqual([{ widthPt: 612, heightPt: 792 }]);
    expect(decoded.pageBoxes).toEqual([[BOX]]);
    expect(await decodePageBoxes(await v2File(), 1)).toEqual([BOX]);
  });

  it("decodePagesMatches et decodePageMatches exposent pageSize", async () => {
    const bytes = await v2File();
    const many = await decodePagesMatches(bytes, [1], (t) => t === "a");
    expect(many.get(1)?.pageSize).toEqual({ widthPt: 612, heightPt: 792 });
    expect(many.get(1)?.ordinals).toEqual([0]);
    const one = await decodePageMatches(bytes, 1, (t) => t === "a");
    expect(one.pageSize).toEqual({ widthPt: 612, heightPt: 792 });
  });

  it("decodeIndexForSearch lit la v2 sans inflater les blobs", async () => {
    const search = await decodeIndexForSearch(await v2File());
    expect(search.pageTermCounts).toEqual(Uint32Array.of(1));
  });
});

describe("compatibilité v1", () => {
  it("lit un fichier v1 construit à la main avec le repli A4 (595 x 842)", async () => {
    const decoded = await decodeIndex(await v1File());
    expect(decoded.pageSizes).toEqual([FALLBACK]);
    expect(decoded.pageBoxes).toEqual([[BOX]]);
    expect(decoded.terms).toEqual([{ term: "a", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [0] }] }]);
  });

  it("decodePageBoxes, decodePagesMatches et decodeIndexForSearch lisent la v1", async () => {
    const bytes = await v1File();
    expect(await decodePageBoxes(bytes, 1)).toEqual([BOX]);
    const match = await decodePageMatches(bytes, 1, (t) => t === "a");
    expect(match.pageSize).toEqual(FALLBACK);
    expect(match.boxes).toEqual([BOX]);
    expect((await decodeIndexForSearch(bytes)).pageTermCounts).toEqual(Uint32Array.of(1));
  });

  it("une v1 ne doit pas être lue comme une v2 (blob v1 sous un en-tête v2 : rejeté ou incohérent)", async () => {
    const wrong = await handBuilt(2, ONE_BOX);
    await expect(decodeIndex(wrong)).rejects.toThrow(CorruptDataError);
  });
});

describe("blobs v2 sous un en-tête v1 et varint géants", () => {
  /** Rejeté par une erreur de format typée (jamais lu en silence). */
  const rejectsAsMalformed = async (promise: Promise<unknown>): Promise<void> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DsxFormatError);
    expect([TruncatedFileError, CorruptDataError].some((cls) => error instanceof cls)).toBe(true);
  };

  it("un blob v2 sous un en-tête v1 est rejeté par tous les décodeurs", async () => {
    const wrong = await handBuilt(1, [...varint(6120), ...varint(7920), ...ONE_BOX]);
    await rejectsAsMalformed(decodeIndex(wrong));
    await rejectsAsMalformed(decodePageBoxes(wrong, 1));
    await rejectsAsMalformed(decodePageMatches(wrong, 1, () => true));
    await rejectsAsMalformed(decodePagesMatches(wrong, [1], () => true));
  });

  const hugeVarint = (value: bigint): number[] => {
    const out: number[] = [];
    let rest = value;
    while (rest >= 128n) {
      out.push(Number(rest % 128n) | 0x80);
      rest /= 128n;
    }
    out.push(Number(rest));
    return out;
  };

  it.each([
    ["2^53", 2n ** 53n],
    ["2^63", 2n ** 63n],
  ])("largeur en varint %s (> 2^53-1) : rejetée", async (_name, value) => {
    await rejectsAsMalformed(decodeIndex(await handBuilt(2, [...hugeVarint(value), ...varint(7920), ...ONE_BOX])));
    await rejectsAsMalformed(decodePageBoxes(await handBuilt(2, [...hugeVarint(value), ...varint(7920), ...ONE_BOX]), 1));
  });

  it("hauteur en varint > 2^53-1 : rejetée", async () => {
    await rejectsAsMalformed(decodeIndex(await handBuilt(2, [...varint(6120), ...hugeVarint(2n ** 53n), ...ONE_BOX])));
  });

  it("2^53-1 exactement : dépasse le plafond de page (BudgetExceededError)", async () => {
    await expect(decodeIndex(await handBuilt(2, [...hugeVarint(2n ** 53n - 1n), ...varint(7920), ...ONE_BOX]))).rejects.toThrow(
      BudgetExceededError,
    );
  });
});

describe("isolation des pages corrompues", () => {
  it("decodePageBoxes(bytes, 2) réussit quand seule la page 1 est corrompue", async () => {
    const bytes = (await encodeIndex(makeIndex())).slice();
    const [first] = pageBlobLocations(bytes);
    bytes.fill(0xff, first!.offset, first!.offset + first!.length);
    await expect(decodePageBoxes(bytes, 1)).rejects.toBeInstanceOf(DsxFormatError);
    await expect(decodePageBoxes(bytes, 2)).resolves.toEqual([]);
    expect((await decodePageMatches(bytes, 2, () => true)).pageSize).toEqual({ widthPt: 842, heightPt: 595 });
  });
});

describe("versions rejetées", () => {
  it("version 3 : UnsupportedVersionError explicite", async () => {
    const bad = (await v2File()).slice();
    new DataView(bad.buffer).setUint16(4, 3, true);
    await expect(decodeIndex(bad)).rejects.toThrow(UnsupportedVersionError);
    await expect(decodeIndex(bad)).rejects.toThrow(/version 3/);
    await expect(decodeIndexForSearch(bad)).rejects.toThrow(UnsupportedVersionError);
    await expect(decodePagesMatches(bad, [1], () => true)).rejects.toThrow(UnsupportedVersionError);
  });

  it("version 65535 et version 0 sont rejetées", async () => {
    const huge = (await v2File()).slice();
    new DataView(huge.buffer).setUint16(4, 0xffff, true);
    await expect(decodeIndex(huge)).rejects.toThrow(UnsupportedVersionError);
    const zero = (await v2File()).slice();
    new DataView(zero.buffer).setUint16(4, 0, true);
    // Version 0 : jamais écrite par aucune version du plugin, donc données corrompues (et non « version future »).
    await expect(decodeIndex(zero)).rejects.toThrow(CorruptDataError);
    await expect(decodeIndex(zero)).rejects.toThrow(/invalid format version 0/);
    await expect(decodeIndex(zero)).rejects.not.toThrow(UnsupportedVersionError);
  });
});

describe("bornes anti-bombe sur les tailles de page (entrée non fiable)", () => {
  const maxTenths = MAX_PAGE_DIMENSION_PT * 10;

  it.each([
    ["largeur nulle", 0, 7920, CorruptDataError],
    ["hauteur nulle", 6120, 0, CorruptDataError],
    ["largeur au-dessus du plafond", maxTenths + 1, 7920, BudgetExceededError],
    ["hauteur au-dessus du plafond", 6120, maxTenths + 1, BudgetExceededError],
    ["largeur énorme", 2 ** 40, 7920, BudgetExceededError],
  ])("decodeIndex rejette %s", async (_name, w, h, errorClass) => {
    await expect(decodeIndex(await v2File(w, h))).rejects.toThrow(errorClass);
  });

  it("decodePagesMatches rejette aussi une taille hors bornes", async () => {
    await expect(decodePagesMatches(await v2File(0, 7920), [1], () => true)).rejects.toThrow(CorruptDataError);
    await expect(decodePageBoxes(await v2File(maxTenths + 1, 7920), 1)).rejects.toThrow(CorruptDataError);
  });

  it("accepte exactement le plafond", async () => {
    const decoded = await decodeIndex(await v2File(maxTenths, 1));
    expect(decoded.pageSizes).toEqual([{ widthPt: MAX_PAGE_DIMENSION_PT, heightPt: 0.1 }]);
  });

  it("blob tronqué après la largeur ou au milieu d'un varint", async () => {
    await expect(decodeIndex(await handBuilt(2, varint(6120)))).rejects.toThrow(TruncatedFileError);
    await expect(decodeIndex(await handBuilt(2, [0x80]))).rejects.toThrow(TruncatedFileError);
    await expect(decodeIndex(await handBuilt(2, []))).rejects.toThrow(TruncatedFileError);
  });

  it("varint de largeur non canonique rejeté", async () => {
    await expect(decodeIndex(await handBuilt(2, [0x81, 0x00, ...varint(7920), ...ONE_BOX]))).rejects.toThrow(CorruptDataError);
  });

  it("fichier v2 tronqué à chaque coupe : erreur typée, jamais de succès", async () => {
    const bytes = await encodeIndex(makeIndex());
    // Toutes les coupes (le fichier fait quelques centaines d'octets), pas un échantillon.
    for (let cut = 0; cut < bytes.length; cut += 1) {
      await expect(decodeIndex(bytes.slice(0, cut)), `coupe à ${cut} octets`).rejects.toBeInstanceOf(DsxFormatError);
    }
  });
});

describe("encodeur : validation des tailles de page", () => {
  const ok = { widthPt: 1, heightPt: 1 };
  it.each([
    ["largeur nulle", [{ widthPt: 0, heightPt: 1 }, ok], /pageSizes\[0\]\.widthPt = 0 .*page 1/],
    ["largeur qui arrondit à zéro", [{ widthPt: 0.04, heightPt: 1 }, ok], /pageSizes\[0\]\.widthPt = 0\.04 .*page 1/],
    ["hauteur négative", [{ widthPt: 1, heightPt: -1 }, ok], /pageSizes\[0\]\.heightPt = -1 .*page 1/],
    ["largeur NaN sur la page 2", [ok, { widthPt: Number.NaN, heightPt: 1 }], /pageSizes\[1\]\.widthPt = NaN .*page 2/],
    ["hauteur infinie", [{ widthPt: 1, heightPt: Infinity }, ok], /pageSizes\[0\]\.heightPt = Infinity .*page 1/],
    [
      "hauteur au-dessus du plafond",
      [{ widthPt: 1, heightPt: MAX_PAGE_DIMENSION_PT + 1 }, ok],
      /pageSizes\[0\]\.heightPt = 20001 .*page 1/,
    ],
  ])("rejette %s par une RangeError qui nomme la page", async (_name, pageSizes, message) => {
    const error = await encodeIndex(makeIndex({ pageSizes })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(message);
  });

  it("rejette une longueur différente du nombre de pages", async () => {
    await expect(encodeIndex(makeIndex({ pageSizes: [ok] }))).rejects.toThrow(
      /pageSizes is required and must have the same number of pages as pageTermCounts/,
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["un nombre", 595],
    ["une chaîne", "A4"],
  ])("rejette un élément de pageSizes valant %s par une RangeError qui nomme la page (pas de cast)", async (_name, bad) => {
    const pageSizes = [ok, bad] as unknown as DocumentIndex["pageSizes"];
    const error = await encodeIndex(makeIndex({ pageSizes })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/pageSizes\[1\] .*page 2/);
  });

  it("rejette l'absence de pageSizes (pas de repli silencieux à l'écriture)", async () => {
    const { pageSizes: _omit, ...rest } = makeIndex();
    await expect(encodeIndex(rest as unknown as DocumentIndex)).rejects.toThrow(/pageSizes is required/);
  });
});
