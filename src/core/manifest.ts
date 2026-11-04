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
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_RADIX = 36;

function indexByPath(manifest: Manifest): ReadonlyMap<string, PdfEntry> {
  return new Map(manifest.map((entry) => [entry.path, entry] as const));
}

function hasChanged(previous: PdfEntry, current: PdfEntry): boolean {
  return previous.size !== current.size || previous.modifiedAt !== current.modifiedAt;
}

export function diffManifest(previous: Manifest, current: Manifest): ManifestDiff {
  const previousByPath = indexByPath(previous);
  const currentPaths = new Set(current.map((entry) => entry.path));
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

/** Hash FNV-1a 32 bits, déterministe et sans dépendance. */
function hashString(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(HASH_RADIX);
}

/** Empreinte (chemin + taille) utilisable comme nom de fichier d'index. */
export function fingerprint(entry: PdfEntry): string {
  return `${hashString(entry.path)}-${entry.size}`;
}

export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(PDF_EXTENSION);
}
