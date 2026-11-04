/** Découverte incrémentale : comparaison de deux manifestes de PDF. */

export interface PdfEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export type Manifest = readonly PdfEntry[];

export interface ManifestDiff {
  readonly added: readonly PdfEntry[];
  readonly modified: readonly PdfEntry[];
  readonly removed: readonly PdfEntry[];
  readonly unchanged: readonly PdfEntry[];
}

const PDF_EXTENSION = ".pdf";
const HASH_RADIX = 36;
const HASH_SEED_1 = 0xdeadbeef;
const HASH_SEED_2 = 0x41c6ce57;
const HASH_MULT_1 = 2654435761;
const HASH_MULT_2 = 1597334677;
const HASH_MIX_1 = 2246822507;
const HASH_MIX_2 = 3266489909;
const HASH_HIGH_MASK = 2097151; // 21 bits -> 53 bits au total
const UINT32_RANGE = 4294967296;
const SHIFT_16 = 16;
const SHIFT_13 = 13;

/** Entrée de manifeste invalide (taille ou date non valide). */
export class InvalidEntryError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Invalid manifest entry "${path}": ${reason}`);
    this.name = "InvalidEntryError";
  }
}

/** Le même chemin apparaît plusieurs fois dans un manifeste. */
export class DuplicatePathError extends Error {
  constructor(public readonly path: string) {
    super(`Duplicate path in manifest: "${path}"`);
    this.name = "DuplicatePathError";
  }
}

function assertValidEntry(entry: PdfEntry): void {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new InvalidEntryError(entry.path, `size must be a non-negative integer, got ${entry.size}`);
  }
  if (!Number.isFinite(entry.modifiedAt)) {
    throw new InvalidEntryError(entry.path, `modifiedAt must be finite, got ${entry.modifiedAt}`);
  }
}

/** Valide les entrées et l'unicité des chemins (sensible à la casse). */
function indexByPath(manifest: Manifest): ReadonlyMap<string, PdfEntry> {
  const index = new Map<string, PdfEntry>();
  for (const entry of manifest) {
    assertValidEntry(entry);
    if (index.has(entry.path)) throw new DuplicatePathError(entry.path);
    index.set(entry.path, entry);
  }
  return index;
}

function hasChanged(previous: PdfEntry, current: PdfEntry): boolean {
  return previous.size !== current.size || previous.modifiedAt !== current.modifiedAt;
}

/**
 * Compare deux manifestes. Les chemins sont comparés de façon sensible à la casse
 * (`A.pdf` et `a.pdf` sont deux fichiers distincts). Toute date différente, y compris
 * plus ancienne (restauration d'une version), donne « modified ».
 */
export function diffManifest(previous: Manifest, current: Manifest): ManifestDiff {
  const previousByPath = indexByPath(previous);
  const currentPaths = new Set(indexByPath(current).keys());
  const added: PdfEntry[] = [];
  const modified: PdfEntry[] = [];
  const unchanged: PdfEntry[] = [];

  for (const entry of current) {
    const before = previousByPath.get(entry.path);
    if (before === undefined) added.push(entry);
    else if (hasChanged(before, entry)) modified.push(entry);
    else unchanged.push(entry);
  }
  const removed = previous.filter((entry) => !currentPaths.has(entry.path));
  return { added, modified, removed, unchanged };
}

/** Hash synchrone 53 bits (cyrb53, seed 0), sans dépendance. */
function hashString(value: string): string {
  let h1 = HASH_SEED_1;
  let h2 = HASH_SEED_2;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, HASH_MULT_1);
    h2 = Math.imul(h2 ^ code, HASH_MULT_2);
  }
  h1 = Math.imul(h1 ^ (h1 >>> SHIFT_16), HASH_MIX_1) ^ Math.imul(h2 ^ (h2 >>> SHIFT_13), HASH_MIX_2);
  h2 = Math.imul(h2 ^ (h2 >>> SHIFT_16), HASH_MIX_1) ^ Math.imul(h1 ^ (h1 >>> SHIFT_13), HASH_MIX_2);
  return (UINT32_RANGE * (HASH_HIGH_MASK & h2) + (h1 >>> 0)).toString(HASH_RADIX);
}

/** Empreinte (chemin 53 bits + taille), [A-Za-z0-9-], indépendante de modifiedAt. */
export function fingerprint(entry: PdfEntry): string {
  assertValidEntry(entry);
  return `${hashString(entry.path)}-${entry.size}`;
}

export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(PDF_EXTENSION);
}
