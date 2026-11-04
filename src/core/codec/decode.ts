import {
  BYTES_PER_BOX,
  BudgetExceededError,
  CorruptDataError,
  CorruptOffsetError,
  DSX_FORMAT_VERSION,
  DSX_MAGIC_BYTES,
  DSX_MIN_FORMAT_VERSION,
  DsxFormatError,
  HEADER_OFFSETS,
  BLOB_RATIO_GRACE_BYTES,
  SECTION_RATIO_GRACE_BYTES,
  InvalidMagicError,
  MAGIC_LENGTH,
  MAX_BOXES_PER_PAGE,
  MAX_INFLATED_BLOB_BYTES,
  MAX_INFLATED_BYTES,
  MAX_INFLATION_RATIO,
  MAX_PAGES,
  MAX_TERMS,
  MAX_TOTAL_BOXES,
  MAX_TOTAL_INFLATED_BYTES,
  MAX_TOTAL_POSTING_ITEMS,
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
  type SearchIndexData,
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

export interface BudgetLimits {
  readonly maxInflatedBytes: number;
  readonly maxBoxes: number;
  readonly maxPostingItems: number;
}

const DEFAULT_LIMITS: BudgetLimits = {
  maxInflatedBytes: MAX_TOTAL_INFLATED_BYTES,
  maxBoxes: MAX_TOTAL_BOXES,
  maxPostingItems: MAX_TOTAL_POSTING_ITEMS,
};

/** Budget cumulé partagé par toute une opération de décodage (un fichier non fiable ne peut pas le contourner). */
export class DecodeBudget {
  private inflatedBytes = 0;
  private boxes = 0;
  private postingItems = 0;

  constructor(private readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  addInflatedBytes(count: number): void {
    this.inflatedBytes += count;
    if (this.inflatedBytes > this.limits.maxInflatedBytes) {
      throw new BudgetExceededError(`more than ${this.limits.maxInflatedBytes} inflated bytes in total`);
    }
  }

  addBoxes(count: number): void {
    this.boxes += count;
    if (this.boxes > this.limits.maxBoxes) {
      throw new BudgetExceededError(`more than ${this.limits.maxBoxes} boxes in total`);
    }
  }

  addPostingItems(count: number): void {
    this.postingItems += count;
    if (this.postingItems > this.limits.maxPostingItems) {
      throw new BudgetExceededError(`more than ${this.limits.maxPostingItems} postings and word ordinals in total`);
    }
  }
}

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

/** Une bombe de décompression dépasse largement le rapport réaliste d'un flux deflate. */
function assertPlausibleRatio(inflated: number, compressed: number, graceBytes: number, what: string): void {
  if (inflated > graceBytes && inflated > compressed * MAX_INFLATION_RATIO) {
    throw new BudgetExceededError(`${what} inflates more than ${MAX_INFLATION_RATIO}x its compressed size`);
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
interface InflateLimits {
  /** Taille maximale de la sortie pour ce flux. */
  readonly limit: number;
  /** Sortie en dessous de laquelle le ratio n'est pas contrôlé. */
  readonly ratioGraceBytes: number;
}

const SECTION_LIMITS: InflateLimits = { limit: MAX_INFLATED_BYTES, ratioGraceBytes: SECTION_RATIO_GRACE_BYTES };
const BLOB_LIMITS: InflateLimits = { limit: MAX_INFLATED_BLOB_BYTES, ratioGraceBytes: BLOB_RATIO_GRACE_BYTES };

async function inflateRaw(
  data: Uint8Array,
  { limit, ratioGraceBytes }: InflateLimits,
  what: string,
  budget: DecodeBudget,
): Promise<Uint8Array> {
  const decompressor = new DecompressionStream("deflate-raw"); // hors du try : erreur d'environnement
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(decompressor).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      budget.addInflatedBytes(value.length);
      assertPlausibleRatio(total, data.length, ratioGraceBytes, what);
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
  if (pageCount > MAX_PAGES) throw new BudgetExceededError(`${pageCount} pages exceed the limit of ${MAX_PAGES}`);
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

function decodePostings(
  reader: Reader,
  count: number,
  pageCount: number,
  term: string,
  budget: DecodeBudget,
): Posting[] {
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
    budget.addPostingItems(1 + termFrequency);
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

function decodeTerms(
  dictionary: Uint8Array,
  postingsRaw: Uint8Array,
  pageCount: number,
  budget: DecodeBudget,
): TermEntry[] {
  const dict = new Reader(dictionary);
  const postingsReader = new Reader(postingsRaw);
  const termCount = dict.varint();
  if (termCount > MAX_TERMS) throw new BudgetExceededError(`${termCount} terms exceed the limit of ${MAX_TERMS}`);
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
    terms.push({ term, postings: decodePostings(postingsReader, documentFrequency, pageCount, term, budget) });
    previous = current;
  }
  dict.assertEnd("dictionary section");
  postingsReader.assertEnd("postings section");
  return terms;
}

/** Valide la structure d'un blob de boîtes sans rien matérialiser ; renvoie le nombre et les octets bruts. */
function parseBoxBlob(raw: Uint8Array, budget: DecodeBudget): { count: number; data: Uint8Array } {
  const reader = new Reader(raw);
  const count = reader.varint();
  if (count > MAX_BOXES_PER_PAGE) {
    throw new BudgetExceededError(`${count} boxes on one page exceed the limit of ${MAX_BOXES_PER_PAGE}`);
  }
  reader.requireRoom(count, BYTES_PER_BOX, "box count");
  budget.addBoxes(count);
  const data = reader.take(count * BYTES_PER_BOX);
  reader.assertEnd("page box blob");
  return { count, data };
}

function decodeBoxes(raw: Uint8Array, budget: DecodeBudget): WordBox[] {
  const { count, data } = parseBoxBlob(raw, budget);
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

async function inflatePageBlob(
  section: Uint8Array,
  offsets: readonly number[],
  pageIndex: number,
  budget: DecodeBudget,
): Promise<Uint8Array> {
  const start = offsets[pageIndex] ?? 0;
  const end = offsets[pageIndex + 1] ?? start;
  const what = `page ${pageIndex + 1} boxes`;
  return inflateRaw(section.subarray(start, end), BLOB_LIMITS, what, budget);
}

/** Décode uniquement les boîtes de la page demandée (base 1). */
export async function decodePageBoxes(bytes: Uint8Array, pageNumber: number): Promise<readonly WordBox[]> {
  const header = parseHeader(bytes);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > header.pageCount) {
    throw new RangeError(`Page ${pageNumber} out of range 1..${header.pageCount}`);
  }
  const budget = new DecodeBudget();
  const section = sectionBytes(bytes, header.sections[SECTION.boxes]);
  const offsets = pageBlobOffsets(section, header.pageCount);
  return decodeBoxes(await inflatePageBlob(section, offsets, pageNumber - 1, budget), budget);
}

interface DecodedCore {
  readonly data: SearchIndexData;
  readonly boxesSection: Uint8Array;
  readonly offsets: readonly number[];
}

/** Tout sauf les boîtes : sections 0 à 2 décodées, table des blobs de boîtes validée. */
async function decodeCore(bytes: Uint8Array, budget: DecodeBudget): Promise<DecodedCore> {
  const header = parseHeader(bytes);
  const part = (id: number) => sectionBytes(bytes, header.sections[id]);
  const inflate = (id: number, what: string) => inflateRaw(part(id), SECTION_LIMITS, what, budget);
  const [lengths, dictionary, postings] = await Promise.all([
    inflate(SECTION.pageLengths, "page lengths section"),
    inflate(SECTION.dictionary, "dictionary section"),
    inflate(SECTION.postings, "postings section"),
  ]);
  const boxesSection = part(SECTION.boxes);
  const offsets = pageBlobOffsets(boxesSection, header.pageCount);
  const data: SearchIndexData = {
    normalizerVersion: header.normalizerVersion,
    extractorVersion: header.extractorVersion,
    sourcePath: header.sourcePath,
    pdfSize: header.pdfSize,
    pdfModifiedMs: header.pdfModifiedMs,
    pageTermCounts: decodePageLengths(lengths, header.pageCount),
    terms: decodeTerms(dictionary, postings, header.pageCount, budget),
  };
  return { data, boxesSection, offsets };
}

const pageIndexes = (offsets: readonly number[]): number[] => Array.from(offsets.slice(1), (_, i) => i);

/** Décodage complet (tests, outils) : une WordBox par boîte. Préférer decodeIndexForSearch pour la recherche. */
export async function decodeIndex(bytes: Uint8Array): Promise<DocumentIndex> {
  const budget = new DecodeBudget();
  const { data, boxesSection, offsets } = await decodeCore(bytes, budget);
  const pageBoxes = await mapInBatches(pageIndexes(offsets), STREAM_CONCURRENCY, async (i) =>
    decodeBoxes(await inflatePageBlob(boxesSection, offsets, i, budget), budget),
  );
  return { ...data, pageBoxes };
}

/**
 * Décodage pour la recherche : termes, postings et pageTermCounts. Les blobs de boîtes sont inflatés
 * et leur structure validée page par page, sans jamais créer de WordBox.
 */
export async function decodeIndexForSearch(bytes: Uint8Array): Promise<SearchIndexData> {
  const budget = new DecodeBudget();
  const { data, boxesSection, offsets } = await decodeCore(bytes, budget);
  await mapInBatches(pageIndexes(offsets), STREAM_CONCURRENCY, async (i) => {
    parseBoxBlob(await inflatePageBlob(boxesSection, offsets, i, budget), budget);
  });
  return data;
}
