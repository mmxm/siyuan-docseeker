/**
 * Format binaire `.dsx` (un index par PDF), version de format 2 (le décodeur lit aussi la version 1).
 * Tous les entiers fixes sont little-endian. `varint` = LEB128 non signé canonique
 * (7 bits par octet, poids faible d'abord, bit 7 = suite ; pas d'octet final nul superflu ;
 * valeur <= 2^53-1).
 *
 * En-tête (taille variable) :
 *   0   4  magic ASCII "DSX1"
 *   4   2  u16 version du format (>= 1)
 *   6   2  u16 version du normaliseur
 *   8   4  u32 nombre de pages P
 *   12  8  f64 taille du PDF en octets (fini, >= 0)
 *   20  8  f64 date de modification du PDF en ms (finie, >= 0)
 *   28  1  u8  E = longueur en octets UTF-8 de la version de l'extracteur (0..255)
 *   29  E  version de l'extracteur (UTF-8)
 *   29+E      2  u16 S = longueur en octets UTF-8 de `sourcePath` (0..65535)
 *   31+E      S  `sourcePath` (UTF-8) : chemin du PDF indexé ; l'appelant le compare au
 *                chemin attendu pour détecter une collision d'empreinte de nom de fichier
 *   31+E+S    32 table des 4 sections : 4 x (u32 offset absolu, u32 longueur)
 *   Les sections se suivent sans trou, la première commence juste après la table, et la
 *   dernière finit exactement à la fin du fichier (aucun octet en trop).
 *
 * Bornes anti-DoS (fichiers synchronisés donc non fiables) : P <= MAX_PAGES, T <= MAX_TERMS,
 * n <= MAX_BOXES_PER_PAGE par page, et un budget global par opération de décodage
 * (MAX_TOTAL_INFLATED_BYTES, MAX_TOTAL_BOXES, MAX_TOTAL_POSTING_ITEMS) ainsi qu'un ratio
 * d'inflation <= MAX_INFLATION_RATIO ; sinon BudgetExceededError.
 *
 * Sections 0 à 2 : flux deflate-raw ; une fois décompressées (<= MAX_INFLATED_BYTES), elles
 * doivent être entièrement consommées.
 *   0 longueurs   : P varint (nombre de termes de chaque page).
 *   1 dictionnaire: varint T (nombre de termes), puis T fois, en ordre UTF-8 strictement
 *                   croissant : varint préfixe commun avec le terme précédent, varint longueur
 *                   du suffixe, suffixe UTF-8, varint df (nombre de postings), varint offset
 *                   des postings du terme dans la section 2 (doit égaler l'offset réel).
 *   2 postings    : par terme, df fois : varint delta de page (> 0, pages strictement
 *                   croissantes, base 1, <= P), varint tf, tf varint de deltas d'ordinaux.
 *   3 boîtes      : P u32 (longueurs des blobs), puis P blobs deflate-raw (chacun
 *                   <= MAX_INFLATED_BLOB_BYTES une fois décompressé, décodable seul) contenant
 *                   [v2 seulement : varint largeur de page, varint hauteur de page, en dixièmes de
 *                   point, chacun dans 1..MAX_PAGE_DIMENSION_PT*10, soit 1 à 3 octets chacun],
 *                   varint n, puis n boîtes de 4 u16 (x, y, largeur, hauteur) en
 *                   fractions de 65535 ; la somme des longueurs doit égaler la section.
 *
 * Versions : la v1 n'a pas de taille de page (le décodeur applique alors le repli A4,
 * ASSUMED_PAGE_WIDTH_PT x ASSUMED_PAGE_HEIGHT_PT) ; la v2 ajoute la taille de page (PDF.js, viewport
 * d'échelle 1, rotation appliquée) en tête de chaque blob de boîtes, pour convertir les fractions de page
 * en points (bonus de police, proximité). Versions rejetées explicitement : > 2 -> UnsupportedVersionError
 * (fichier d'une version future) ; 0 -> CorruptDataError (aucune version du plugin ne l'a jamais écrite).
 * L'encodeur écrit toujours la v2.
 */

import { ASSUMED_PAGE_HEIGHT_PT, ASSUMED_PAGE_WIDTH_PT } from "../constants";

export const DSX_MAGIC = "DSX1";
export const DSX_MAGIC_BYTES: Readonly<Uint8Array> = new Uint8Array([0x44, 0x53, 0x58, 0x31]);
/** Version écrite par l'encodeur (v2 : tailles de page). */
export const DSX_FORMAT_VERSION = 2;
/** Première version dont le blob de boîtes contient la taille de page. */
export const DSX_PAGE_SIZE_FORMAT_VERSION = 2;

export const MAGIC_LENGTH = 4;
export const UINT16_MAX = 0xffff;
export const BYTES_PER_BOX = 8;
export const MAX_EXTRACTOR_VERSION_BYTES = 255;
export const SOURCE_PATH_LENGTH_BYTES = 2;
export const MAX_SOURCE_PATH_BYTES = UINT16_MAX;
export const UINT32_MAX = 0xffff_ffff;
export const DSX_MIN_FORMAT_VERSION = 1;
/** Taille de page stockée en dixièmes de point. */
export const PAGE_SIZE_UNITS_PER_PT = 10;
/** Plafond d'une dimension de page, en points (la spécification PDF plafonne à 14 400 ; marge pour UserUnit). */
export const MAX_PAGE_DIMENSION_PT = 20_000;
/** Plafond d'une dimension de page en dixièmes de point (valeur stockée). */
export const MAX_PAGE_DIMENSION_UNITS = MAX_PAGE_DIMENSION_PT * PAGE_SIZE_UNITS_PER_PT;

/** Points -> dixièmes de point (arrondi). SEULE définition de l'arrondi au dixième : encodeur, décodeur, extraction. */
export function pageDimensionToUnits(points: number): number {
  return Math.round(points * PAGE_SIZE_UNITS_PER_PT);
}

/** Dixièmes de point -> points. */
export function unitsToPageDimension(units: number): number {
  return units / PAGE_SIZE_UNITS_PER_PT;
}

/** Taille maximale d'une section 0 à 2 décompressée (64 Mio ; un PDF de 5 000 pages en occupe quelques Mio). */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
/** Taille maximale d'un blob de boîtes (une page) décompressé : MAX_BOXES_PER_PAGE boîtes + varint, arrondi à 1 Mio. */
export const MAX_INFLATED_BLOB_BYTES = 1024 * 1024;
/** Budget global d'octets inflatés pour toute une opération de décodage (sections + blobs). */
export const MAX_TOTAL_INFLATED_BYTES = 320 * 1024 * 1024;
/** Nombre maximal de pages d'un document. */
export const MAX_PAGES = 100_000;
/** Nombre maximal de boîtes (mots) sur une page. */
export const MAX_BOXES_PER_PAGE = 50_000;
/** Budget global de boîtes pour toute une opération de décodage. */
export const MAX_TOTAL_BOXES = 4_000_000;
/** Nombre maximal de termes du dictionnaire. */
export const MAX_TERMS = 2_000_000;
/** Budget global de postings + ordinaux de mots (objets matérialisés) pour une opération de décodage. */
export const MAX_TOTAL_POSTING_ITEMS = 12_000_000;
/** Rapport maximal sortie/entrée d'un flux deflate ; deflate plafonne théoriquement vers 1032. */
export const MAX_INFLATION_RATIO = 600;
/** Blobs de boîtes : sortie en dessous de laquelle le ratio n'est pas contrôlé. */
export const BLOB_RATIO_GRACE_BYTES = 256 * 1024;
/**
 * Sections 0 à 2 : les postings/longueurs réguliers (ordinaux consécutifs) sont légitimement très
 * compressibles ; le ratio n'est donc contrôlé qu'au-delà de cette sortie (le plafond absolu reste MAX_INFLATED_BYTES).
 */
export const SECTION_RATIO_GRACE_BYTES = 16 * 1024 * 1024;
/** Nombre maximal de flux de (dé)compression simultanés. */
export const STREAM_CONCURRENCY = 8;
/** Tolérance sur les coordonnées de boîtes hors de [0,1] avant de lever une erreur. */
export const BOX_EPSILON = 1e-6;

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

/** Taille d'une page en points (PDF.js, viewport d'échelle 1), au dixième de point. */
export interface PageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** Taille de page des fichiers v1 (qui n'en stockent pas) et des pages aberrantes : A4. SEULE définition. */
export const FALLBACK_PAGE_SIZE: PageSize = Object.freeze({
  widthPt: ASSUMED_PAGE_WIDTH_PT,
  heightPt: ASSUMED_PAGE_HEIGHT_PT,
});

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
  /** Chemin du PDF indexé (UTF-8, <= 65535 octets) ; sert à détecter les collisions d'empreinte. */
  readonly sourcePath: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
  /** Nombre de termes par page ; la longueur donne le nombre de pages. */
  readonly pageTermCounts: readonly number[];
  readonly terms: readonly TermEntry[];
  /** Une liste de boîtes par page (mêmes longueur que pageTermCounts). */
  readonly pageBoxes: readonly (readonly WordBox[])[];
  /**
   * Une taille par page (mêmes longueur que pageTermCounts). Obligatoire à l'encodage (v2). À la lecture d'un
   * fichier v1, chaque entrée est le repli A4 (ASSUMED_PAGE_WIDTH_PT x ASSUMED_PAGE_HEIGHT_PT).
   */
  readonly pageSizes: readonly PageSize[];
}

export class DsxFormatError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
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
      `Unsupported .dsx format version ${found} (this build reads versions ${DSX_MIN_FORMAT_VERSION} to ${DSX_FORMAT_VERSION})`,
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
  constructor(detail: string, cause?: unknown) {
    super(`Corrupt .dsx file: ${detail}`, cause === undefined ? undefined : { cause });
  }
}

/** Budget global (octets inflatés, boîtes, postings, ratio d'inflation, pages, termes) dépassé. */
export class BudgetExceededError extends CorruptDataError {
  constructor(detail: string) {
    super(`decoding budget exceeded: ${detail}`);
  }
}

/**
 * Postings de tous les termes d'un document en disposition compacte (CSR) : quelques tableaux typés
 * au lieu d'un objet par posting. Les postings du terme `i` occupent [offsets[i], offsets[i+1]) dans
 * `pages` (strictement croissantes, base 1) et `termFrequencies`.
 */
export interface CompactPostings {
  /** Termes dans l'ordre du dictionnaire `.dsx` (UTF-8 strictement croissant). */
  readonly terms: readonly string[];
  /** terms.length + 1 offsets. */
  readonly offsets: Uint32Array;
  readonly pages: Uint32Array;
  readonly termFrequencies: Uint32Array;
}

/** Index sans boîtes ni ordinaux de mots, compact : suffisant pour la recherche. */
export interface SearchIndexData {
  readonly normalizerVersion: number;
  readonly extractorVersion: string;
  readonly sourcePath: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
  /** Nombre de termes par page (longueur = nombre de pages). */
  readonly pageTermCounts: Uint32Array;
  readonly postings: CompactPostings;
}

/**
 * Copie `values` dans un Uint32Array après avoir vérifié que chacune est un entier de [0, UINT32_MAX]
 * (Uint32Array.from tronquerait ou réduirait modulo 2^32 en silence).
 * @throws RangeError contextualisé par `what` sur la première valeur invalide.
 */
export function toUint32Lengths(values: readonly number[], what: string): Uint32Array {
  const out = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new RangeError(`${what}[${i}] = ${value} n'est pas un entier de [0, ${UINT32_MAX}]`);
    }
    out[i] = value;
  }
  return out;
}

/** Comparaison lexicographique d'octets UTF-8 (ordre des termes du dictionnaire). */
export function compareUtf8(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Applique `task` à chaque élément par lots de `size`, en conservant l'ordre. */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    results.push(...(await Promise.all(batch.map((item, i) => task(item, start + i)))));
  }
  return results;
}
