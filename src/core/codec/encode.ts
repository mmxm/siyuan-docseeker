import {
  BOX_EPSILON,
  BYTES_PER_BOX,
  DSX_FORMAT_VERSION,
  DSX_MAGIC_BYTES,
  HEADER_OFFSETS,
  MAX_EXTRACTOR_VERSION_BYTES,
  MAX_SOURCE_PATH_BYTES,
  SECTION_ENTRY_BYTES,
  SOURCE_PATH_LENGTH_BYTES,
  STREAM_CONCURRENCY,
  UINT16_MAX,
  UINT32_MAX,
  compareUtf8,
  mapInBatches,
  type DocumentIndex,
  type TermEntry,
  type WordBox,
} from "./format";

export { compareUtf8 };

const UTF8 = new TextEncoder();
const VARINT_PAYLOAD = 0x80;
const VARINT_BASE = 128;
const UINT32_BYTES = 4;
const INITIAL_CAPACITY = 256;
/** Un entier sûr (< 2^53) tient en au plus 8 octets varint. */
const VARINT_MAX_BYTES = 8;

/** Tampon d'octets à croissance par doublement (évite un Uint8Array par entier). */
export class ByteWriter {
  private buffer: Uint8Array;
  private used = 0;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.buffer = new Uint8Array(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.used;
  }

  private reserve(extra: number): void {
    const needed = this.used + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.used), 0);
    this.buffer = grown;
  }

  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Varint requires a non-negative safe integer, got ${value}`);
    }
    this.reserve(VARINT_MAX_BYTES);
    let rest = value;
    while (rest >= VARINT_BASE) {
      this.buffer[this.used++] = (rest % VARINT_BASE) | VARINT_PAYLOAD;
      rest = Math.floor(rest / VARINT_BASE);
    }
    this.buffer[this.used++] = rest;
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.buffer.set(data, this.used);
    this.used += data.length;
  }

  /** Copie des octets écrits. */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }
}

export function encodeVarint(value: number): Uint8Array {
  const writer = new ByteWriter(VARINT_MAX_BYTES);
  writer.varint(value);
  return writer.finish();
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function assertUint(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer in 0..${max}, got ${value}`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
  }
}

function uint32Bytes(name: string, value: number): Uint8Array {
  assertUint(name, value, UINT32_MAX);
  const out = new Uint8Array(UINT32_BYTES);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function checkCoordinate(name: string, value: number, where: string): void {
  if (!Number.isFinite(value) || value < -BOX_EPSILON || value > 1 + BOX_EPSILON) {
    throw new RangeError(`Box ${name}=${value} is outside [0,1] (${where})`);
  }
}

/** Valide une boîte (tolérance BOX_EPSILON) et renvoie ses 4 coordonnées quantifiées. */
function quantizeBox(box: WordBox, where: string): readonly [number, number, number, number] {
  const fields = { x: box.x, y: box.y, width: box.width, height: box.height };
  for (const [name, value] of Object.entries(fields)) checkCoordinate(name, value, where);
  if (box.x + box.width > 1 + BOX_EPSILON) throw new RangeError(`Box x+width=${box.x + box.width} exceeds 1 (${where})`);
  if (box.y + box.height > 1 + BOX_EPSILON) throw new RangeError(`Box y+height=${box.y + box.height} exceeds 1 (${where})`);
  const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * UINT16_MAX);
  const qx = q(box.x);
  const qy = q(box.y);
  // Le plafond garde x+largeur <= 1 après arrondi, pour que le ré-encodage d'un index décodé reste valide.
  return [qx, qy, Math.min(q(box.width), UINT16_MAX - qx), Math.min(q(box.height), UINT16_MAX - qy)];
}

function encodeBoxes(boxes: readonly WordBox[], page: number): Uint8Array {
  const writer = new ByteWriter(boxes.length * BYTES_PER_BOX + VARINT_MAX_BYTES);
  writer.varint(boxes.length);
  const cell = new Uint8Array(BYTES_PER_BOX);
  const view = new DataView(cell.buffer);
  boxes.forEach((box, i) => {
    quantizeBox(box, `page ${page}, box ${i}`).forEach((value, k) => view.setUint16(k * 2, value, true));
    writer.bytes(cell);
  });
  return writer.finish();
}

function sortedTerms(terms: readonly TermEntry[]): readonly { entry: TermEntry; bytes: Uint8Array }[] {
  const keyed = terms.map((entry) => ({ entry, bytes: UTF8.encode(entry.term) }));
  const sorted = [...keyed].sort((a, b) => compareUtf8(a.bytes, b.bytes));
  sorted.forEach((item, i) => {
    const previous = sorted[i - 1];
    if (previous && compareUtf8(previous.bytes, item.bytes) === 0) {
      throw new Error(`Duplicate term in index: "${item.entry.term}"`);
    }
  });
  return sorted;
}

function writePostings(out: ByteWriter, entry: TermEntry, pageCount: number): void {
  let previousPage = 0;
  for (const posting of entry.postings) {
    if (posting.page <= previousPage || posting.page > pageCount) {
      throw new Error(`Invalid posting page ${posting.page} for term "${entry.term}"`);
    }
    if (posting.termFrequency !== posting.wordOrdinals.length) {
      throw new Error(`termFrequency does not match wordOrdinals for term "${entry.term}"`);
    }
    out.varint(posting.page - previousPage);
    out.varint(posting.termFrequency);
    let previousOrdinal = 0;
    for (const ordinal of posting.wordOrdinals) {
      if (ordinal < previousOrdinal) {
        throw new RangeError(`Word ordinals must not decrease for term "${entry.term}" (page ${posting.page})`);
      }
      out.varint(ordinal - previousOrdinal);
      previousOrdinal = ordinal;
    }
    previousPage = posting.page;
  }
}

function sharedPrefixLength(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function encodeTermSections(index: DocumentIndex): { dictionary: Uint8Array; postings: Uint8Array } {
  const terms = sortedTerms(index.terms);
  const dictionary = new ByteWriter();
  const postings = new ByteWriter();
  dictionary.varint(terms.length);
  let previous: Uint8Array = new Uint8Array(0);
  for (const { entry, bytes } of terms) {
    const shared = sharedPrefixLength(previous, bytes);
    const suffix = bytes.subarray(shared);
    dictionary.varint(shared);
    dictionary.varint(suffix.length);
    dictionary.bytes(suffix);
    dictionary.varint(entry.postings.length);
    dictionary.varint(postings.length);
    writePostings(postings, entry, index.pageTermCounts.length);
    previous = bytes;
  }
  return { dictionary: dictionary.finish(), postings: postings.finish() };
}

async function encodeBoxesSection(pageBoxes: readonly (readonly WordBox[])[]): Promise<Uint8Array> {
  const blobs = await mapInBatches(pageBoxes, STREAM_CONCURRENCY, (boxes, i) =>
    deflateRaw(encodeBoxes(boxes, i + 1)),
  );
  return concat([...blobs.map((blob) => uint32Bytes("pageBlobLength", blob.length)), ...blobs]);
}

function validateMetadata(index: DocumentIndex): { extractor: Uint8Array; path: Uint8Array } {
  assertUint("pageCount", index.pageTermCounts.length, UINT32_MAX);
  assertUint("normalizerVersion", index.normalizerVersion, UINT16_MAX);
  assertFiniteNonNegative("pdfSize", index.pdfSize);
  assertFiniteNonNegative("pdfModifiedMs", index.pdfModifiedMs);
  const extractor = UTF8.encode(index.extractorVersion);
  if (extractor.length > MAX_EXTRACTOR_VERSION_BYTES) {
    throw new RangeError("extractorVersion is too long (max 255 UTF-8 bytes)");
  }
  const path = UTF8.encode(index.sourcePath);
  if (path.length > MAX_SOURCE_PATH_BYTES) {
    throw new RangeError(`sourcePath is too long (${path.length} UTF-8 bytes, max ${MAX_SOURCE_PATH_BYTES})`);
  }
  return { extractor, path };
}

function encodeHeader(index: DocumentIndex, sections: readonly Uint8Array[]): Uint8Array {
  const { extractor, path } = validateMetadata(index);
  const pathStart = HEADER_OFFSETS.extractorBytes + extractor.length;
  const tableStart = pathStart + SOURCE_PATH_LENGTH_BYTES + path.length;
  const header = new Uint8Array(tableStart + sections.length * SECTION_ENTRY_BYTES);
  const view = new DataView(header.buffer);
  header.set(DSX_MAGIC_BYTES, 0);
  view.setUint16(HEADER_OFFSETS.formatVersion, DSX_FORMAT_VERSION, true);
  view.setUint16(HEADER_OFFSETS.normalizerVersion, index.normalizerVersion, true);
  view.setUint32(HEADER_OFFSETS.pageCount, index.pageTermCounts.length, true);
  view.setFloat64(HEADER_OFFSETS.pdfSize, index.pdfSize, true);
  view.setFloat64(HEADER_OFFSETS.pdfModifiedMs, index.pdfModifiedMs, true);
  header[HEADER_OFFSETS.extractorLength] = extractor.length;
  header.set(extractor, HEADER_OFFSETS.extractorBytes);
  view.setUint16(pathStart, path.length, true);
  header.set(path, pathStart + SOURCE_PATH_LENGTH_BYTES);
  writeSectionTable(view, tableStart, header.length, sections);
  return header;
}

function writeSectionTable(view: DataView, tableStart: number, firstOffset: number, sections: readonly Uint8Array[]): void {
  let offset = firstOffset;
  sections.forEach((section, i) => {
    assertUint(`section ${i} offset`, offset, UINT32_MAX);
    assertUint(`section ${i} length`, section.length, UINT32_MAX);
    view.setUint32(tableStart + i * SECTION_ENTRY_BYTES, offset, true);
    view.setUint32(tableStart + i * SECTION_ENTRY_BYTES + UINT32_BYTES, section.length, true);
    offset += section.length;
  });
  assertUint("file size", offset, UINT32_MAX);
}

export async function encodeIndex(index: DocumentIndex): Promise<Uint8Array> {
  assertUint("pageCount", index.pageTermCounts.length, UINT32_MAX);
  if (index.pageBoxes.length !== index.pageTermCounts.length) {
    throw new Error("pageBoxes and pageTermCounts must have the same number of pages");
  }
  validateMetadata(index);
  const lengths = new ByteWriter();
  index.pageTermCounts.forEach((count) => lengths.varint(count));
  const { dictionary, postings } = encodeTermSections(index);
  const sections = [
    await deflateRaw(lengths.finish()),
    await deflateRaw(dictionary),
    await deflateRaw(postings),
    await encodeBoxesSection(index.pageBoxes),
  ];
  return concat([encodeHeader(index, sections), ...sections]);
}
