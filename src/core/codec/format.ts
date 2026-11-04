/** Types et constantes du format binaire `.dsx` (un index par PDF). */

export const DSX_MAGIC = "DSX1";
export const DSX_MAGIC_BYTES: Readonly<Uint8Array> = new Uint8Array([0x44, 0x53, 0x58, 0x31]);
export const DSX_FORMAT_VERSION = 1;

export const MAGIC_LENGTH = 4;
export const UINT16_MAX = 0xffff;
export const BYTES_PER_BOX = 8;
export const MAX_EXTRACTOR_VERSION_BYTES = 255;

/** Offsets des champs de l'en-tête de taille fixe (little-endian). */
export const HEADER_OFFSETS = {
  formatVersion: 4,
  normalizerVersion: 6,
  pageCount: 8,
  pdfSize: 12,
  pdfModifiedMs: 20,
  extractorLength: 28,
  extractorBytes: 29,
} as const;

/** Ordre des sections dans le fichier. */
export const SECTION = {
  pageLengths: 0,
  dictionary: 1,
  postings: 2,
  boxes: 3,
} as const;
export const SECTION_COUNT = 4;
export const SECTION_ENTRY_BYTES = 8;

export interface WordBox {
  /** Fractions de la page (0..1), origine en haut à gauche. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Posting {
  /** Numéro de page, base 1. */
  readonly page: number;
  readonly termFrequency: number;
  /** Ordinaux de mots (croissants) dans la page. Longueur = termFrequency. */
  readonly wordOrdinals: readonly number[];
}

export interface TermEntry {
  readonly term: string;
  /** Pages strictement croissantes. */
  readonly postings: readonly Posting[];
}

export interface DocumentIndex {
  readonly normalizerVersion: number;
  readonly extractorVersion: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
  /** Nombre de termes par page ; la longueur donne le nombre de pages. */
  readonly pageTermCounts: readonly number[];
  readonly terms: readonly TermEntry[];
  /** Une liste de boîtes par page (mêmes longueur que pageTermCounts). */
  readonly pageBoxes: readonly (readonly WordBox[])[];
}

export class DsxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMagicError extends DsxFormatError {
  constructor() {
    super(`Not a DocSeeker index file: invalid magic signature (expected ${DSX_MAGIC})`);
  }
}

export class UnsupportedVersionError extends DsxFormatError {
  constructor(found: number) {
    super(
      `Unsupported .dsx format version ${found} (this build supports up to version ${DSX_FORMAT_VERSION})`,
    );
  }
}

export class TruncatedFileError extends DsxFormatError {
  constructor(detail: string) {
    super(`Truncated .dsx file: ${detail}`);
  }
}

export class CorruptOffsetError extends DsxFormatError {
  constructor(detail: string) {
    super(`Corrupt .dsx file: inconsistent offset (${detail})`);
  }
}

export class CorruptDataError extends DsxFormatError {
  constructor(detail: string) {
    super(`Corrupt .dsx file: ${detail}`);
  }
}
