import {
  BYTES_PER_BOX,
  DSX_FORMAT_VERSION,
  DSX_MAGIC_BYTES,
  HEADER_OFFSETS,
  MAX_EXTRACTOR_VERSION_BYTES,
  SECTION_ENTRY_BYTES,
  UINT16_MAX,
  type DocumentIndex,
  type TermEntry,
  type WordBox,
} from "./format";

const UTF8 = new TextEncoder();
const VARINT_PAYLOAD = 0x80;
const VARINT_BASE = 128;
const UINT32_BYTES = 4;

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Varint requires a non-negative safe integer, got ${value}`);
  }
  const out: number[] = [];
  let rest = value;
  while (rest >= VARINT_BASE) {
    out.push((rest % VARINT_BASE) | VARINT_PAYLOAD);
    rest = Math.floor(rest / VARINT_BASE);
  }
  out.push(rest);
  return Uint8Array.from(out);
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

function uint32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(UINT32_BYTES);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function compareUtf8(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function quantize(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`Box coordinate is not finite: ${value}`);
  return Math.round(Math.min(1, Math.max(0, value)) * UINT16_MAX);
}

function encodeBoxes(boxes: readonly WordBox[]): Uint8Array {
  const count = encodeVarint(boxes.length);
  const out = new Uint8Array(count.length + boxes.length * BYTES_PER_BOX);
  out.set(count, 0);
  const view = new DataView(out.buffer);
  boxes.forEach((box, i) => {
    const base = count.length + i * BYTES_PER_BOX;
    view.setUint16(base, quantize(box.x), true);
    view.setUint16(base + 2, quantize(box.y), true);
    view.setUint16(base + 4, quantize(box.width), true);
    view.setUint16(base + 6, quantize(box.height), true);
  });
  return out;
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

function encodePostings(entry: TermEntry, pageCount: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let previousPage = 0;
  for (const posting of entry.postings) {
    if (posting.page <= previousPage || posting.page > pageCount) {
      throw new Error(`Invalid posting page ${posting.page} for term "${entry.term}"`);
    }
    if (posting.termFrequency !== posting.wordOrdinals.length) {
      throw new Error(`termFrequency does not match wordOrdinals for term "${entry.term}"`);
    }
    chunks.push(encodeVarint(posting.page - previousPage), encodeVarint(posting.termFrequency));
    let previousOrdinal = 0;
    for (const ordinal of posting.wordOrdinals) {
      chunks.push(encodeVarint(ordinal - previousOrdinal));
      previousOrdinal = ordinal;
    }
    previousPage = posting.page;
  }
  return concat(chunks);
}

function sharedPrefixLength(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function encodeTermSections(index: DocumentIndex): { dictionary: Uint8Array; postings: Uint8Array } {
  const terms = sortedTerms(index.terms);
  const dictionary: Uint8Array[] = [encodeVarint(terms.length)];
  const postings: Uint8Array[] = [];
  let postingsOffset = 0;
  let previous: Uint8Array = new Uint8Array(0);
  for (const { entry, bytes } of terms) {
    const shared = sharedPrefixLength(previous, bytes);
    const suffix = bytes.subarray(shared);
    const block = encodePostings(entry, index.pageTermCounts.length);
    dictionary.push(
      encodeVarint(shared),
      encodeVarint(suffix.length),
      suffix,
      encodeVarint(entry.postings.length),
      encodeVarint(postingsOffset),
    );
    postings.push(block);
    postingsOffset += block.length;
    previous = bytes;
  }
  return { dictionary: concat(dictionary), postings: concat(postings) };
}

async function encodeBoxesSection(pageBoxes: readonly (readonly WordBox[])[]): Promise<Uint8Array> {
  const blobs = await Promise.all(pageBoxes.map((boxes) => deflateRaw(encodeBoxes(boxes))));
  return concat([...blobs.map((blob) => uint32Bytes(blob.length)), ...blobs]);
}

function encodeHeader(index: DocumentIndex, sections: readonly Uint8Array[]): Uint8Array {
  const extractor = UTF8.encode(index.extractorVersion);
  if (extractor.length > MAX_EXTRACTOR_VERSION_BYTES) {
    throw new RangeError("extractorVersion is too long (max 255 UTF-8 bytes)");
  }
  const tableStart = HEADER_OFFSETS.extractorBytes + extractor.length;
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
  let offset = header.length;
  sections.forEach((section, i) => {
    view.setUint32(tableStart + i * SECTION_ENTRY_BYTES, offset, true);
    view.setUint32(tableStart + i * SECTION_ENTRY_BYTES + UINT32_BYTES, section.length, true);
    offset += section.length;
  });
  return header;
}

export async function encodeIndex(index: DocumentIndex): Promise<Uint8Array> {
  if (index.pageBoxes.length !== index.pageTermCounts.length) {
    throw new Error("pageBoxes and pageTermCounts must have the same number of pages");
  }
  const lengths = concat(index.pageTermCounts.map(encodeVarint));
  const { dictionary, postings } = encodeTermSections(index);
  const sections = [
    await deflateRaw(lengths),
    await deflateRaw(dictionary),
    await deflateRaw(postings),
    await encodeBoxesSection(index.pageBoxes),
  ];
  return concat([encodeHeader(index, sections), ...sections]);
}
