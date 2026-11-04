/**
 * Découverte des PDF sous /data/assets via l'API noyau, sans lecture du contenu.
 *
 * VÉRIFIÉ (kernel/api/file.go) : readDir renvoie {name,isDir,isSymlink,updated} où `updated` est
 * ModTime().Unix(), donc en SECONDES ; le noyau fait os.Stat (suit les liens), donc un lien vers un
 * dossier a isDir=true et isSymlink=true. `PdfEntry.modifiedAt` est en MILLISECONDES : conversion x1000.
 * readDir ne fournit pas la taille : elle vient de `sizeOf` (par défaut HEAD /assets/... -> Content-Length,
 * à valider au spike M0).
 *
 * Boucles : readDir ne détecte pas les cycles de liens symboliques. On borne la profondeur
 * (MAX_DIRECTORY_DEPTH) et on ne suit qu'un seul lien symbolique de dossier le long d'un chemin
 * (MAX_SYMLINK_HOPS). Limite : un lien non cyclique vers un dossier déjà parcouru produit des chemins
 * dupliqués (même fichier sous deux noms) ; le noyau n'expose pas de realpath pour les dédupliquer.
 */
import { diffManifest, isPdfPath, type Manifest, type PdfEntry } from "../core/manifest";
import type { DirEntry, KernelApi } from "./kernelApi";

export type DiscoveryApi = Pick<KernelApi, "readDir" | "headAsset">;

export type DiscoveryIssueKind = "directory" | "pdf" | "depth" | "symlink";

export interface DiscoveryIssue {
  readonly kind: DiscoveryIssueKind;
  readonly path: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly manifest: Manifest;
  readonly issues: readonly DiscoveryIssue[];
  /**
   * Vrai seulement si AUCUNE issue n'a pu faire manquer un PDF (dossier illisible, profondeur dépassée,
   * lien symbolique ignoré, taille inconnue). Un manifeste `complete: false` est un sous-ensemble : il ne
   * prouve l'absence d'aucun fichier.
   */
  readonly complete: boolean;
  /** PDF vus mais de taille inconnue : exclus du manifeste, jamais à traiter comme supprimés. */
  readonly unsized: readonly string[];
}

/** Plan d'actions sur l'index, dérivé d'un manifeste précédent et d'un résultat de découverte. */
export interface IndexUpdatePlan {
  readonly toIndex: readonly PdfEntry[];
  readonly toRemove: readonly PdfEntry[];
  readonly removalsAllowed: boolean;
}

/** La racine de découverte n'a pas pu être lue : aucun manifeste fiable n'existe. */
export class DiscoveryRootError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`Cannot read discovery root "${path}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DiscoveryRootError";
  }
}

export interface DiscoverOptions {
  readonly api: DiscoveryApi;
  readonly root?: string;
  /** Reçoit le chemin de manifeste (`assets/x.pdf`) et renvoie la taille en octets. */
  readonly sizeOf?: (path: string) => Promise<number>;
}

export const DEFAULT_ASSETS_ROOT = "/data/assets";
export const MAX_CONCURRENT_SIZE_REQUESTS = 6;
export const MAX_DIRECTORY_DEPTH = 16;
export const MAX_SYMLINK_HOPS = 1;
const MS_PER_SECOND = 1000;
const DATA_PREFIX = "/data/";

interface PendingDir {
  readonly path: string;
  readonly depth: number;
  readonly symlinkHops: number;
}

interface Candidate {
  readonly path: string;
  readonly modifiedAt: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charAt(end - 1) === "/") end -= 1;
  return path.slice(0, end);
}

/** `/data/assets/a.pdf` -> `assets/a.pdf` (chemin tel que servi sous /assets et stocké dans le manifeste). */
function toManifestPath(absolutePath: string): string {
  return absolutePath.startsWith(DATA_PREFIX) ? absolutePath.slice(DATA_PREFIX.length) : absolutePath.replace(/^\/+/, "");
}

/** Exécute `task` sur chaque élément avec au plus `limit` tâches simultanées. */
async function runPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function classifyChild(
  parent: PendingDir,
  entry: DirEntry,
  issues: DiscoveryIssue[],
): { dir?: PendingDir; pdf?: Candidate } {
  const path = `${parent.path}/${entry.name}`;
  if (!entry.isDir) {
    return isPdfPath(entry.name) ? { pdf: { path, modifiedAt: entry.updated * MS_PER_SECOND } } : {};
  }
  const hops = parent.symlinkHops + (entry.isSymlink ? 1 : 0);
  if (hops > MAX_SYMLINK_HOPS) {
    issues.push({ kind: "symlink", path, message: "nested directory symlink not followed" });
    return {};
  }
  if (parent.depth + 1 > MAX_DIRECTORY_DEPTH) {
    issues.push({ kind: "depth", path, message: `deeper than ${MAX_DIRECTORY_DEPTH} levels` });
    return {};
  }
  return { dir: { path, depth: parent.depth + 1, symlinkHops: hops } };
}

async function walk(
  api: DiscoveryApi,
  root: string,
  issues: DiscoveryIssue[],
): Promise<readonly Candidate[]> {
  const candidates: Candidate[] = [];
  const stack: PendingDir[] = [{ path: root, depth: 0, symlinkHops: 0 }];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    let entries: readonly DirEntry[];
    try {
      entries = await api.readDir(current.path);
    } catch (error) {
      if (current.depth === 0) throw new DiscoveryRootError(current.path, error);
      issues.push({ kind: "directory", path: current.path, message: messageOf(error) });
      continue;
    }
    for (const entry of entries) {
      const child = classifyChild(current, entry, issues);
      if (child.dir) stack.push(child.dir);
      if (child.pdf) candidates.push(child.pdf);
    }
  }
  return candidates;
}

function isValidSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0;
}

export async function discoverPdfs(options: DiscoverOptions): Promise<DiscoveryResult> {
  const { api } = options;
  const root = trimTrailingSlashes(options.root ?? DEFAULT_ASSETS_ROOT);
  const sizeOf = options.sizeOf ?? (async (path: string) => (await api.headAsset(`/${path}`)).size);
  const issues: DiscoveryIssue[] = [];
  const candidates = await walk(api, root, issues);

  const entries: PdfEntry[] = [];
  const unsized: string[] = [];
  await runPool(candidates, MAX_CONCURRENT_SIZE_REQUESTS, async (candidate) => {
    const path = toManifestPath(candidate.path);
    try {
      const size = await sizeOf(path);
      if (!isValidSize(size)) throw new RangeError(`invalid size ${size}`);
      entries.push({ path, size, modifiedAt: candidate.modifiedAt });
    } catch (error) {
      unsized.push(path);
      issues.push({ kind: "pdf", path, message: messageOf(error) });
    }
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  unsized.sort();
  return { manifest: entries, issues, complete: issues.length === 0, unsized };
}

/**
 * Calcule les actions d'index à partir de `previous` et d'un résultat de découverte.
 *
 * CONTRAT : l'appelant ne doit supprimer un index QUE via `toRemove` de ce plan. Si `result.complete`
 * est faux, `toRemove` est toujours vide (`removalsAllowed` faux) : un PDF absent d'un manifeste partiel
 * n'est pas prouvé supprimé. Les PDF `unsized` ne sont jamais supprimés ni indexés (absents de
 * `toIndex` car hors manifeste) ; l'appelant doit les signaler et les retenter.
 */
export function planIndexUpdate(previous: Manifest, result: DiscoveryResult): IndexUpdatePlan {
  const diff = diffManifest(previous, result.manifest);
  const toIndex = [...diff.added, ...diff.modified];
  const removalsAllowed = result.complete;
  if (!removalsAllowed) return { toIndex, toRemove: [], removalsAllowed };
  const unsized = new Set(result.unsized);
  const toRemove = diff.removed.filter((entry) => !unsized.has(entry.path));
  return { toIndex, toRemove, removalsAllowed };
}
