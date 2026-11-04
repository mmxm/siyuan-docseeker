import {
  BYTES_PER_BOX,
  CorruptDataError,
  CorruptOffsetError,
  DSX_FORMAT_VERSION,
  DSX_MAGIC_BYTES,
  HEADER_OFFSETS,
  InvalidMagicError,
  MAGIC_LENGTH,
  SECTION,
  SECTION_COUNT,
  SECTION_ENTRY_BYTES,
  TruncatedFileError,
  UINT16_MAX,
  UnsupportedVersionError,
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

interface SectionRange {
  readonly offset: number;
  readonly length: number;
}

interface ParsedHeader {
  readonly normalizerVersion: number;
  readonly extractorVersion: string;
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
    if ((byte & VARINT_CONTINUE) === 0) return { value, next: position };
    multiplier *= VARINT_BASE;
    if (!Number.isSafeInteger(multiplier)) throw new CorruptDataError("varint too large");
  }
}

class Reader {
  private position = 0;
  constructor(private readonly bytes: Uint8Array) {}

  varint(): number {
    const { value, next } = readVarint(this.bytes, this.position);
    this.position = next;
    return value;
  }

  take(length: number): Uint8Array {
    const end = this.position + length;
    if (end > this.bytes.length) throw new TruncatedFileError("unexpected end of section");
    const slice = this.bytes.subarray(this.position, end);
    this.position = end;
    return slice;
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (cause) {
    throw new CorruptDataError(`cannot decompress section (${String(cause)})`);
  }
}

function parseHeader(bytes: Uint8Array): ParsedHeader {
  if (bytes.length < MAGIC_LENGTH) throw new TruncatedFileError("file shorter than magic signature");
  if (!DSX_MAGIC_BYTES.every((b, i) => bytes[i] === b)) throw new InvalidMagicError();
  if (bytes.length < HEADER_OFFSETS.extractorBytes) throw new TruncatedFileError("incomplete header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(HEADER_OFFSETS.formatVersion, true);
  if (version > DSX_FORMAT_VERSION) throw new UnsupportedVersionError(version);
  const extractorEnd = HEADER_OFFSETS.extractorBytes + (bytes[HEADER_OFFSETS.extractorLength] ?? 0);
  const headerEnd = extractorEnd + SECTION_COUNT * SECTION_ENTRY_BYTES;
  if (bytes.length < headerEnd) throw new TruncatedFileError("incomplete section table");
  const sections = readSectionTable(view, extractorEnd, headerEnd, bytes.length);
  return {
    normalizerVersion: view.getUint16(HEADER_OFFSETS.normalizerVersion, true),
    extractorVersion: UTF8.decode(bytes.subarray(HEADER_OFFSETS.extractorBytes, extractorEnd)),
    pdfSize: view.getFloat64(HEADER_OFFSETS.pdfSize, true),
    pdfModifiedMs: view.getFloat64(HEADER_OFFSETS.pdfModifiedMs, true),
    pageCount: view.getUint32(HEADER_OFFSETS.pageCount, true),
    sections,
  };
}

function readSectionTable(
  view: DataView,
  tableStart: number,
  headerEnd: number,
  fileLength: number,
): SectionRange[] {
  const sections: SectionRange[] = [];
  let expectedOffset = headerEnd;
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
  return sections;
}

function sectionBytes(bytes: Uint8Array, range: SectionRange | undefined): Uint8Array {
  if (!range) throw new CorruptDataError("missing section");
  return bytes.subarray(range.offset, range.offset + range.length);
}

function decodePageLengths(raw: Uint8Array, pageCount: number): number[] {
  const reader = new Reader(raw);
  return Array.from({ length: pageCount }, () => reader.varint());
}

function decodePostings(reader: Reader, count: number, pageCount: number): Posting[] {
  const postings: Posting[] = [];
  let page = 0;
  for (let i = 0; i < count; i++) {
    page += reader.varint();
    if (page > pageCount) throw new CorruptDataError(`posting page ${page} exceeds ${pageCount} pages`);
    const termFrequency = reader.varint();
    let ordinal = 0;
    const wordOrdinals = Array.from({ length: termFrequency }, () => (ordinal += reader.varint()));
    postings.push({ page, termFrequency, wordOrdinals });
  }
  return postings;
}

function decodeTerms(dictionary: Uint8Array, postingsRaw: Uint8Array, pageCount: number): TermEntry[] {
  const dict = new Reader(dictionary);
  const postingsReader = new Reader(postingsRaw);
  const termCount = dict.varint();
  const terms: TermEntry[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < termCount; i++) {
    const shared = dict.varint();
    if (shared > previous.length) throw new CorruptDataError("front-coding prefix exceeds previous term");
    const suffix = dict.take(dict.varint());
    const current = new Uint8Array(shared + suffix.length);
    current.set(previous.subarray(0, shared), 0);
    current.set(suffix, shared);
    const documentFrequency = dict.varint();
    dict.varint(); // offset des postings : séquentiel, conservé pour la recherche directe
    terms.push({
      term: UTF8.decode(current),
      postings: decodePostings(postingsReader, documentFrequency, pageCount),
    });
    previous = current;
  }
  return terms;
}

function decodeBoxes(raw: Uint8Array): WordBox[] {
  const reader = new Reader(raw);
  const count = reader.varint();
  const data = reader.take(count * BYTES_PER_BOX);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: count }, (_, i) => {
    const base = i * BYTES_PER_BOX;
    return {
      x: view.getUint16(base, true) / UINT16_MAX,
      y: view.getUint16(base + 2, true) / UINT16_MAX,
      width: view.getUint16(base + 4, true) / UINT16_MAX,
      height: view.getUint16(base + 6, true) / UINT16_MAX,
    };
  });
}

function pageBlobRange(
  section: Uint8Array,
  pageCount: number,
  pageIndex: number,
): { start: number; length: number } {
  const tableBytes = pageCount * UINT32_BYTES;
  if (section.length < tableBytes) throw new TruncatedFileError("incomplete page box table");
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  let start = tableBytes;
  for (let i = 0; i < pageIndex; i++) start += view.getUint32(i * UINT32_BYTES, true);
  const length = view.getUint32(pageIndex * UINT32_BYTES, true);
  if (start + length > section.length) throw new CorruptOffsetError(`page ${pageIndex + 1} box blob`);
  return { start, length };
}

async function decodePageBlob(section: Uint8Array, pageCount: number, pageIndex: number): Promise<WordBox[]> {
  const { start, length } = pageBlobRange(section, pageCount, pageIndex);
  return decodeBoxes(await inflateRaw(section.subarray(start, start + length)));
}

/** Décode uniquement les boîtes de la page demandée (base 1). */
export async function decodePageBoxes(bytes: Uint8Array, pageNumber: number): Promise<readonly WordBox[]> {
  const header = parseHeader(bytes);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > header.pageCount) {
    throw new RangeError(`Page ${pageNumber} out of range 1..${header.pageCount}`);
  }
  const section = sectionBytes(bytes, header.sections[SECTION.boxes]);
  return decodePageBlob(section, header.pageCount, pageNumber - 1);
}

export async function decodeIndex(bytes: Uint8Array): Promise<DocumentIndex> {
  const header = parseHeader(bytes);
  const part = (id: number) => sectionBytes(bytes, header.sections[id]);
  const [lengths, dictionary, postings] = await Promise.all([
    inflateRaw(part(SECTION.pageLengths)),
    inflateRaw(part(SECTION.dictionary)),
    inflateRaw(part(SECTION.postings)),
  ]);
  const boxesSection = part(SECTION.boxes);
  const pageBoxes = await Promise.all(
    Array.from({ length: header.pageCount }, (_, i) => decodePageBlob(boxesSection, header.pageCount, i)),
  );
  return {
    normalizerVersion: header.normalizerVersion,
    extractorVersion: header.extractorVersion,
    pdfSize: header.pdfSize,
    pdfModifiedMs: header.pdfModifiedMs,
    pageTermCounts: decodePageLengths(lengths, header.pageCount),
    terms: decodeTerms(dictionary, postings, header.pageCount),
    pageBoxes,
  };
}
