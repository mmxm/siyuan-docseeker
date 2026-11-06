/**
 * Lecture indépendante de la disposition d'un fichier .dsx (d'après l'en-tête documenté dans format.ts),
 * sans passer par le décodeur : sert à localiser et à inspecter la section des boîtes dans les tests.
 */
export interface SectionLocation {
  readonly offset: number;
  readonly length: number;
}

export function formatVersionOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
}

/** Position (offset absolu, longueur) de la section `index` (0..3) d'après la table de l'en-tête. */
export function sectionLocation(bytes: Uint8Array, index: number): SectionLocation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extractorLength = bytes[28] as number;
  const pathLengthAt = 29 + extractorLength;
  const pathLength = view.getUint16(pathLengthAt, true);
  const tableStart = pathLengthAt + 2 + pathLength;
  return {
    offset: view.getUint32(tableStart + index * 8, true),
    length: view.getUint32(tableStart + index * 8 + 4, true),
  };
}

/** Blobs deflate-raw (compressés) de chaque page, dans la section des boîtes (P u32 de longueurs, puis les blobs). */
export function pageBlobLocations(bytes: Uint8Array): SectionLocation[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageCount = view.getUint32(8, true);
  const section = sectionLocation(bytes, 3);
  const locations: SectionLocation[] = [];
  let offset = section.offset + pageCount * 4;
  for (let i = 0; i < pageCount; i++) {
    const length = view.getUint32(section.offset + i * 4, true);
    locations.push({ offset, length });
    offset += length;
  }
  return locations;
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
