import {
  BYTES_PER_BOX,
  CorruptDataError,
  CorruptOffsetError,
  DSX_FORMAT_VERSION,
  DSX_MAGIC_BYTES,
  DSX_MIN_FORMAT_VERSION,
  DsxFormatError,
  HEADER_OFFSETS,
  InvalidMagicError,
  MAGIC_LENGTH,
  MAX_INFLATED_BLOB_BYTES,
  MAX_INFLATED_BYTES,
  SECTION,
  SECTION_COUNT,
  SECTION_ENTRY_BYTES,
  SOURCE_PATH_LENGTH_BYTES,
  STREAM_CONCURRENCY,
  TruncatedFileError,
  UINT16_MAX,
  UnsupportedVersionError,
  compareUtf8,
  mapInBatches,
  type DocumentIndex,
  type Posting,
  type TermEntry,
  type WordBox,
} from "./format";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE = 0x80;
const VARINT_BASE = 128;
const UINT32_BYTES = 4;
/** Un terme du dictionnaire occupe au moins 4 octets (préfixe, longueur, df, offset). */
const MIN_TERM_BYTES = 4;
/** Un posting occupe au moins 2 octets (delta de page, tf). */
const MIN_POSTING_BYTES = 2;

interface SectionRange {
  readonly offset: number;
  readonly length: number;
}

interface ParsedHeader {
  readonly normalizerVersion: number;
  readonly extractorVersion: string;
  readonly sourcePath: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
  readonly pageCount: number;
  readonly sections: readonly SectionRange[];
}

export function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  let position = start;
  for (;;) {
    const byte = bytes[position];
    if (byte === undefined) throw new TruncatedFileError("unexpected end of varint");
    value += (byte & VARINT_PAYLOAD_MASK) * multiplier;
    position++;
    if (!Number.isSafeInteger(value)) throw new CorruptDataError("varint exceeds 2^53-1");
    if ((byte & VARINT_CONTINUE) === 0) {
      if (byte === 0 && position - start > 1) throw new CorruptDataError("non-canonical varint");
      return { value, next: position };
    }
    multiplier *= VARINT_BASE;
    if (!Number.isSafeInteger(multiplier)) throw new CorruptDataError("varint too large");
  }
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return UTF8.decode(bytes);
  } catch (cause) {
    throw new CorruptDataError(`invalid UTF-8 in ${what}`, cause);
  }
}

class Reader {
  position = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.position;
  }

  varint(): number {
    const { value, next } = readVarint(this.bytes, this.position);
    this.position = next;
    return value;
  }

  take(length: number): Uint8Array {
    if (length > this.remaining) throw new TruncatedFileError("unexpected end of section");
    const slice = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  /** Vérifie que `count` éléments d'au moins `minBytes` octets tiennent dans ce qui reste. */
  requireRoom(count: number, minBytes: number, what: string): void {
    if (count > this.remaining / minBytes) {
      throw new CorruptDataError(`${what} (${count}) exceeds the ${this.remaining} remaining bytes`);
    }
  }

  assertEnd(what: string): void {
    if (this.remaining !== 0) throw new CorruptDataError(`${this.remaining} unexpected trailing bytes in ${what}`);
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Décompresse en s'arrêtant dès que `limit` est dépassé. Les erreurs d'environnement remontent telles quelles. */
async function inflateRaw(data: Uint8Array, limit: number, what: string): Promise<Uint8Array> {
  const decompressor = new DecompressionStream("deflate-raw"); // hors du try : erreur d'environnement
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(decompressor).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new CorruptDataError(`${what} inflates beyond ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof DsxFormatError) throw cause;
    throw new CorruptDataError(`cannot decompress ${what}`, cause);
  }
  return concatChunks(chunks, total);
}

function parseHeader(bytes: Uint8Array): ParsedHeader {
  if (bytes.length < MAGIC_LENGTH) throw new TruncatedFileError("file shorter than magic signature");
  if (!DSX_MAGIC_BYTES.every((b, i) => bytes[i] === b)) throw new InvalidMagicError();
  if (bytes.length < HEADER_OFFSETS.extractorBytes) throw new TruncatedFileError("incomplete header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(HEADER_OFFSETS.formatVersion, true);
  if (version > DSX_FORMAT_VERSION) throw new UnsupportedVersionError(version);
  if (version < DSX_MIN_FORMAT_VERSION) throw new CorruptDataError(`invalid format version ${version}`);
  const pdfSize = view.getFloat64(HEADER_OFFSETS.pdfSize, true);
  const pdfModifiedMs = view.getFloat64(HEADER_OFFSETS.pdfModifiedMs, true);
  for (const [name, value] of [["pdfSize", pdfSize], ["pdfModifiedMs", pdfModifiedMs]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new CorruptDataError(`${name} is not a finite number >= 0`);
  }
  const strings = readHeaderStrings(bytes, view);
  const sections = readSectionTable(view, strings.tableStart, bytes.length);
  const pageCount = view.getUint32(HEADER_OFFSETS.pageCount, true);
  const boxes = sections[SECTION.boxes];
  if (boxes && boxes.length < pageCount * UINT32_BYTES) throw new TruncatedFileError("incomplete page box table");
  return {
    normalizerVersion: view.getUint16(HEADER_OFFSETS.normalizerVersion, true),
    extractorVersion: strings.extractorVersion,
    sourcePath: strings.sourcePath,
    pdfSize,
    pdfModifiedMs,
    pageCount,
    sections,
  };
}

function readHeaderStrings(
  bytes: Uint8Array,
  view: DataView,
): { extractorVersion: string; sourcePath: string; tableStart: number } {
  const extractorEnd = HEADER_OFFSETS.extractorBytes + (bytes[HEADER_OFFSETS.extractorLength] ?? 0);
  if (bytes.length < extractorEnd + SOURCE_PATH_LENGTH_BYTES) throw new TruncatedFileError("incomplete header");
  const pathStart = extractorEnd + SOURCE_PATH_LENGTH_BYTES;
  const tableStart = pathStart + view.getUint16(extractorEnd, true);
  if (bytes.length < tableStart + SECTION_COUNT * SECTION_ENTRY_BYTES) {
    throw new TruncatedFileError("incomplete section table");
  }
  return {
    extractorVersion: decodeUtf8(bytes.subarray(HEADER_OFFSETS.extractorBytes, extractorEnd), "extractorVersion"),
    sourcePath: decodeUtf8(bytes.subarray(pathStart, tableStart), "sourcePath"),
    tableStart,
  };
}

function readSectionTable(view: DataView, tableStart: number, fileLength: number): SectionRange[] {
  const sections: SectionRange[] = [];
  let expectedOffset = tableStart + SECTION_COUNT * SECTION_ENTRY_BYTES;
  for (let i = 0; i < SECTION_COUNT; i++) {
    const offset = view.getUint32(tableStart + i * SECTION_ENTRY_BYTES, true);
    const length = view.getUint32(tableStart + i * SECTION_ENTRY_BYTES + UINT32_BYTES, true);
    if (offset !== expectedOffset) {
      throw new CorruptOffsetError(`section ${i} starts at ${offset}, expected ${expectedOffset}`);
    }
    if (offset + length > fileLength) {
      throw new TruncatedFileError(`section ${i} ends at ${offset + length}, file has ${fileLength} bytes`);
    }
    sections.push({ offset, length });
    expectedOffset = offset + length;
  }
  if (expectedOffset !== fileLength) {
    throw new CorruptDataError(`${fileLength - expectedOffset} unexpected trailing bytes after the last section`);
  }
  return sections;
}

function sectionBytes(bytes: Uint8Array, range: SectionRange | undefined): Uint8Array {
  if (!range) throw new CorruptDataError("missing section");
  return bytes.subarray(range.offset, range.offset + range.length);
}

function decodePageLengths(raw: Uint8Array, pageCount: number): number[] {
  const reader = new Reader(raw);
  reader.requireRoom(pageCount, 1, "page count");
  const lengths: number[] = [];
  for (let i = 0; i < pageCount; i++) lengths.push(reader.varint());
  reader.assertEnd("page lengths section");
  return lengths;
}

function decodePostings(reader: Reader, count: number, pageCount: number, term: string): Posting[] {
  reader.requireRoom(count, MIN_POSTING_BYTES, `document frequency of "${term}"`);
  const postings: Posting[] = [];
  let page = 0;
  for (let i = 0; i < count; i++) {
    const delta = reader.varint();
    if (delta === 0) throw new CorruptDataError(`posting pages of "${term}" are not strictly increasing`);
    page += delta;
    if (page > pageCount) throw new CorruptDataError(`posting page ${page} exceeds ${pageCount} pages`);
    const termFrequency = reader.varint();
    reader.requireRoom(termFrequency, 1, `term frequency of "${term}"`);
    const wordOrdinals: number[] = [];
    let ordinal = 0;
    for (let k = 0; k < termFrequency; k++) {
      ordinal += reader.varint();
      if (!Number.isSafeInteger(ordinal)) throw new CorruptDataError(`word ordinal overflow for "${term}"`);
      wordOrdinals.push(ordinal);
    }
    postings.push({ page, termFrequency, wordOrdinals });
  }
  return postings;
}

function readTermBytes(dict: Reader, previous: Uint8Array): Uint8Array {
  const shared = dict.varint();
  if (shared > previous.length) throw new CorruptDataError("front-coding prefix exceeds previous term");
  const suffix = dict.take(dict.varint());
  const current = new Uint8Array(shared + suffix.length);
  current.set(previous.subarray(0, shared), 0);
  current.set(suffix, shared);
  return current;
}

function decodeTerms(dictionary: Uint8Array, postingsRaw: Uint8Array, pageCount: number): TermEntry[] {
  const dict = new Reader(dictionary);
  const postingsReader = new Reader(postingsRaw);
  const termCount = dict.varint();
  dict.requireRoom(termCount, MIN_TERM_BYTES, "term count");
  const terms: TermEntry[] = [];
  let previous: Uint8Array | undefined;
  for (let i = 0; i < termCount; i++) {
    const current = readTermBytes(dict, previous ?? new Uint8Array(0));
    if (previous && compareUtf8(previous, current) >= 0) {
      throw new CorruptDataError(`terms are not in strictly increasing order at term ${i}`);
    }
    const term = decodeUtf8(current, `term ${i}`);
    const documentFrequency = dict.varint();
    const declaredOffset = dict.varint();
    if (declaredOffset !== postingsReader.position) {
      throw new CorruptOffsetError(`term "${term}" postings at ${declaredOffset}, expected ${postingsReader.position}`);
    }
    terms.push({ term, postings: decodePostings(postingsReader, documentFrequency, pageCount, term) });
    previous = current;
  }
  dict.assertEnd("dictionary section");
  postingsReader.assertEnd("postings section");
  return terms;
}

function decodeBoxes(raw: Uint8Array): WordBox[] {
  const reader = new Reader(raw);
  const count = reader.varint();
  reader.requireRoom(count, BYTES_PER_BOX, "box count");
  const data = reader.take(count * BYTES_PER_BOX);
  reader.assertEnd("page box blob");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: WordBox[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * BYTES_PER_BOX;
    boxes.push({
      x: view.getUint16(base, true) / UINT16_MAX,
      y: view.getUint16(base + 2, true) / UINT16_MAX,
      width: view.getUint16(base + 4, true) / UINT16_MAX,
      height: view.getUint16(base + 6, true) / UINT16_MAX,
    });
  }
  return boxes;
}

/**
 * Offsets cumulatifs (P+1 valeurs) des blobs de boîtes dans la section : calculés une seule fois,
 * la page i occupe [offsets[i], offsets[i+1]). La somme doit égaler exactement la taille de la section.
 */
export function pageBlobOffsets(section: Uint8Array, pageCount: number): number[] {
  const tableBytes = pageCount * UINT32_BYTES;
  if (section.length < tableBytes) throw new TruncatedFileError("incomplete page box table");
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const offsets = [tableBytes];
  let end = tableBytes;
  for (let i = 0; i < pageCount; i++) {
    end += view.getUint32(i * UINT32_BYTES, true);
    if (end > section.length) throw new CorruptOffsetError(`page ${i + 1} box blob`);
    offsets.push(end);
  }
  if (end !== section.length) throw new CorruptOffsetError("page box blobs do not fill the section");
  return offsets;
}

async function decodePageBlob(section: Uint8Array, offsets: readonly number[], pageIndex: number): Promise<WordBox[]> {
  const start = offsets[pageIndex] ?? 0;
  const end = offsets[pageIndex + 1] ?? start;
  const raw = await inflateRaw(section.subarray(start, end), MAX_INFLATED_BLOB_BYTES, `page ${pageIndex + 1} boxes`);
  return decodeBoxes(raw);
}

/** Décode uniquement les boîtes de la page demandée (base 1). */
export async function decodePageBoxes(bytes: Uint8Array, pageNumber: number): Promise<readonly WordBox[]> {
  const header = parseHeader(bytes);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > header.pageCount) {
    throw new RangeError(`Page ${pageNumber} out of range 1..${header.pageCount}`);
  }
  const section = sectionBytes(bytes, header.sections[SECTION.boxes]);
  return decodePageBlob(section, pageBlobOffsets(section, header.pageCount), pageNumber - 1);
}

export async function decodeIndex(bytes: Uint8Array): Promise<DocumentIndex> {
  const header = parseHeader(bytes);
  const part = (id: number) => sectionBytes(bytes, header.sections[id]);
  const [lengths, dictionary, postings] = await Promise.all([
    inflateRaw(part(SECTION.pageLengths), MAX_INFLATED_BYTES, "page lengths section"),
    inflateRaw(part(SECTION.dictionary), MAX_INFLATED_BYTES, "dictionary section"),
    inflateRaw(part(SECTION.postings), MAX_INFLATED_BYTES, "postings section"),
  ]);
  const boxesSection = part(SECTION.boxes);
  const offsets = pageBlobOffsets(boxesSection, header.pageCount);
  const pages = Array.from(offsets.slice(1), (_, i) => i);
  const pageBoxes = await mapInBatches(pages, STREAM_CONCURRENCY, (i) => decodePageBlob(boxesSection, offsets, i));
  return {
    normalizerVersion: header.normalizerVersion,
    extractorVersion: header.extractorVersion,
    sourcePath: header.sourcePath,
    pdfSize: header.pdfSize,
    pdfModifiedMs: header.pdfModifiedMs,
    pageTermCounts: decodePageLengths(lengths, header.pageCount),
    terms: decodeTerms(dictionary, postings, header.pageCount),
    pageBoxes,
  };
}
