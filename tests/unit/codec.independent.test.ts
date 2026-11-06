import { describe, expect, it } from "vitest";
import { decodeIndex, decodePageBoxes } from "../../src/core/codec/decode";

/**
 * Décodeur indépendant : le fichier est construit octet par octet d'après la spécification
 * (en tête de src/core/codec/format.ts), sans appeler l'encodeur ni les constantes du codec.
 * Seule la compression deflate-raw des sections passe par CompressionStream.
 */
async function deflate(data: readonly number[]): Promise<number[]> {
  const stream = new Blob([Uint8Array.from(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return Array.from(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Entier little-endian sur `size` octets. */
function le(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, i) => Math.floor(value / 256 ** i) % 256);
}

async function handBuiltFile(): Promise<Uint8Array> {
  // --- Contenu logique : 1 page, 3 termes sur la page, 1 terme "a" présent sur la page 1 à l'ordinal 5,
  //     1 boîte x=0, y=0, largeur=65535/65535, hauteur=32768/65535.
  const lengthsRaw = [0x03]; // section 0 : P=1 varint = nombre de termes de la page 1 (3)
  const dictionaryRaw = [
    0x01, // T = 1 terme
    0x00, // préfixe commun avec le terme précédent = 0
    0x01, // longueur du suffixe = 1
    0x61, // suffixe "a"
    0x01, // df = 1 posting
    0x00, // offset des postings dans la section 2 = 0
  ];
  const postingsRaw = [
    0x01, // delta de page = 1 -> page 1
    0x01, // tf = 1
    0x05, // delta d'ordinal = 5 -> ordinal 5
  ];
  const boxBlobRaw = [
    0x01, // n = 1 boîte
    ...le(0, 2), // x = 0
    ...le(0, 2), // y = 0
    ...le(65535, 2), // largeur = 1
    ...le(32768, 2), // hauteur = 32768/65535
  ];
  const sections = [await deflate(lengthsRaw), await deflate(dictionaryRaw), await deflate(postingsRaw)];
  const boxBlob = await deflate(boxBlobRaw);
  const boxesSection = [...le(boxBlob.length, 4), ...boxBlob]; // table de P=1 longueur u32, puis le blob
  sections.push(boxesSection);

  // --- En-tête.
  const extractor = [0x65]; // "e" (E = 1)
  const path = [0x70, 0x2f, 0x78]; // "p/x" (S = 3)
  const HEADER_BYTES = 29 + 1 + 2 + 3 + 32; // 29 fixes + E + u16 S + S + table de 4 entrées de 8 octets
  const table: number[] = [];
  let offset = HEADER_BYTES;
  for (const section of sections) {
    table.push(...le(offset, 4), ...le(section.length, 4)); // (offset absolu u32, longueur u32)
    offset += section.length;
  }
  const header = [
    0x44, 0x53, 0x58, 0x31, // magic "DSX1"
    ...le(1, 2), // version du format = 1
    ...le(7, 2), // version du normaliseur = 7
    ...le(1, 4), // nombre de pages P = 1
    0, 0, 0, 0, 0, 0, 0x70, 0x40, // f64 LE de 256 (0x4070000000000000) : taille du PDF
    0, 0, 0, 0, 0, 0, 0x90, 0x40, // f64 LE de 1024 (0x4090000000000000) : date de modification
    extractor.length, // E
    ...extractor,
    ...le(path.length, 2), // S
    ...path,
    ...table,
  ];
  expect(header).toHaveLength(HEADER_BYTES);
  return Uint8Array.from([...header, ...sections.flat()]);
}

describe("décodeur indépendant", () => {
  it("lit un fichier minimal construit à la main d'après la spécification", async () => {
    const decoded = await decodeIndex(await handBuiltFile());
    expect(decoded).toEqual({
      normalizerVersion: 7,
      extractorVersion: "e",
      sourcePath: "p/x",
      pdfSize: 256,
      pdfModifiedMs: 1024,
      pageTermCounts: [3],
      terms: [{ term: "a", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [5] }] }],
      pageBoxes: [[{ x: 0, y: 0, width: 1, height: 32768 / 65535 }]],
      // Fichier v1 : pas de taille de page stockée, repli A4.
      pageSizes: [{ widthPt: 595, heightPt: 842 }],
    });
  });

  it("lit les boîtes d'une page seule", async () => {
    expect(await decodePageBoxes(await handBuiltFile(), 1)).toEqual([
      { x: 0, y: 0, width: 1, height: 32768 / 65535 },
    ]);
  });
});
