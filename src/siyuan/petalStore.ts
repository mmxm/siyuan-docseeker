/**
 * Stockage des fichiers d'index sous `/data/storage/petal/<pluginName>/idx/<empreinte>.dsx`.
 *
 * Écriture « atomique » :
 *  1. putFile `<nom>.<id aléatoire>.tmp` (unique par écriture) ; 2. renameFile `.tmp` -> `<nom>`.
 * VÉRIFIÉ dans le noyau (kernel/api/file.go) : renameFile répond 409 si la destination existe, il
 * n'écrase donc pas. Pour remplacer un fichier existant, on met l'ancien de côté en `<nom>.bak`, puis
 * on renomme le .tmp, puis on supprime le .bak ; en cas d'échec l'ancien fichier est restauré.
 * Les écritures (et suppressions) d'un même nom sont sérialisées dans ce processus.
 *
 * Ce n'est pas atomique au sens POSIX : entre les deux renames il n'y a pas de `<nom>`. Atténuation :
 * read() se rabat sur `<nom>.bak` et list() inclut les noms qui n'ont qu'un .bak. Une coupure à cet
 * endroit laisse `<nom>.bak` sans `<nom>` ; `removeStaleTmp()` le restaure au démarrage.
 * Les erreurs de nettoyage ne sont jamais avalées : elles sont jointes à l'erreur d'origine
 * (AggregateError) ou signalées par `onWarning` quand l'écriture a réussi.
 */
import { ConflictError, NotFoundError, type DirEntry, type KernelApi } from "./kernelApi";

export type PetalApi = Pick<KernelApi, "readDir" | "getFile" | "putFile" | "removeFile" | "renameFile">;

export interface PetalStoreOptions {
  readonly api: PetalApi;
  readonly pluginName?: string;
  /** Générateur de l'identifiant du .tmp (injectable pour des tests déterministes). */
  readonly randomId?: () => string;
  /** Horloge en millisecondes (injectable). */
  readonly now?: () => number;
  /** Reçoit les échecs non fatals (ex. .bak non supprimé après une écriture réussie). */
  readonly onWarning?: (message: string, error: unknown) => void;
}

export interface StaleCleanupFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface StaleCleanupReport {
  readonly handled: readonly string[];
  readonly failed: readonly StaleCleanupFailure[];
}

export interface PetalStore {
  write(name: string, bytes: Uint8Array): Promise<void>;
  /** Octets du fichier ; se rabat sur `<nom>.bak` si le final est absent ; null si les deux le sont. */
  read(name: string): Promise<Uint8Array | null>;
  list(): Promise<readonly string[]>;
  /** Supprime le fichier et son .bak éventuel ; true si quelque chose a été supprimé. */
  remove(name: string): Promise<boolean>;
  /**
   * À appeler au démarrage. Supprime les .tmp orphelins, restaure/supprime les .bak, uniquement s'ils
   * sont plus vieux que STALE_TMP_AGE_MS. Les noms invalides renvoyés par le noyau sont ignorés.
   */
  removeStaleTmp(): Promise<StaleCleanupReport>;
  /**
   * Vide l'index : supprime d'abord le manifeste, puis les `.dsx`, avec leurs `.tmp`/`.bak` (supprimés AVANT
   * le fichier final, qui est conservé si l'un d'eux résiste). Tout autre fichier du dossier est laissé
   * intact. Un échec sur un fichier n'interrompt pas les autres (sauf le manifeste, voir `manifestFailed`) :
   * il est rapporté dans `failed`, de même que les fichiers apparus pendant le vidage.
   * Ne rejette que si le dossier est illisible au départ (hors absence).
   */
  clear(): Promise<ClearReport>;
}

export interface ClearReport {
  readonly removed: readonly string[];
  readonly failed: readonly StaleCleanupFailure[];
  /**
   * Le manifeste n'a pas pu être supprimé : aucun `.dsx` n'a alors été touché (l'indexeur décide d'après le
   * manifeste seul ; manifeste présent + `.dsx` absents laisserait un trou permanent dans l'index).
   */
  readonly manifestFailed: boolean;
}

export const DEFAULT_PLUGIN_NAME = "docseeker";
export const PETAL_ROOT = "/data/storage/petal";
/** Âge minimal (ms) d'un .tmp/.bak pour être considéré comme abandonné. */
export const STALE_TMP_AGE_MS = 10 * 60 * 1000;
const IDX_DIR_NAME = "idx";
const TMP_SUFFIX = ".tmp";
const BAK_SUFFIX = ".bak";
const MAX_NAME_LENGTH = 200;
const ALLOWED_NAME = /^[A-Za-z0-9._-]+$/;
const MS_PER_SECOND = 1000;
/**
 * Fichiers du plugin que `clear()` peut supprimer : `.dsx`, manifeste et sauvegardes de manifeste rejeté
 * (`manifest.rejected.json`, `manifest.rejected-<horodatage-ms>.json`, elles contiennent des chemins de PDF),
 * avec leurs `.bak` ou `.<id>.tmp`. Le manifeste est vidé d'abord, les sauvegardes avec les autres groupes ensuite.
 */
const CLEARABLE = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\.dsx|manifest\.json|manifest\.rejected(?:-\d+)?\.json)(?:\.bak|\.[A-Za-z0-9_-]+\.tmp)?$/;
const MANIFEST_NAME = "manifest.json";
const TRANSIENT_TAIL = /(?:\.bak|\.[A-Za-z0-9_-]+\.tmp)$/;

/** Nom de fichier rejeté (traversée de chemin, caractères interdits, suffixe réservé…). */
export class InvalidNameError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly reason: string,
  ) {
    super(`Invalid petal file name ${JSON.stringify(fileName)}: ${reason}`);
    this.name = "InvalidNameError";
  }
}

/** L'opération a échoué ET son nettoyage/sa restauration aussi : `errors[0]` est l'erreur d'origine. */
export class PetalCleanupError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, `Operation failed and cleanup also failed (${errors.length} errors)`);
    this.name = "PetalCleanupError";
  }
}

function segmentProblem(value: string): string | null {
  if (value.length === 0) return "empty";
  if (value.length > MAX_NAME_LENGTH) return "too long";
  if (!ALLOWED_NAME.test(value)) return "characters outside [A-Za-z0-9._-]";
  if (value.startsWith(".")) return "must not start with a dot";
  if (value.includes("..")) return "must not contain '..'";
  return null;
}

function assertSafeSegment(value: string): void {
  const problem = segmentProblem(value);
  if (problem !== null) throw new InvalidNameError(value, problem);
}

const isTransient = (name: string): boolean => name.endsWith(TMP_SUFFIX) || name.endsWith(BAK_SUFFIX);

function assertValidName(name: string): void {
  assertSafeSegment(name);
  if (isTransient(name)) throw new InvalidNameError(name, "reserved suffix (.tmp/.bak)");
}

/** Exécute une action ; renvoie les erreurs rencontrées (jamais d'exception). */
async function attempt(action: () => Promise<unknown>, ignoreNotFound: boolean): Promise<unknown[]> {
  try {
    await action();
    return [];
  } catch (error) {
    return ignoreNotFound && error instanceof NotFoundError ? [] : [error];
  }
}

/** Joint les erreurs secondaires à l'erreur d'origine (inchangée s'il n'y en a pas). */
function withSecondary(original: unknown, extras: readonly unknown[]): unknown {
  if (extras.length === 0) return original;
  const base = original instanceof PetalCleanupError ? original.errors : [original];
  return new PetalCleanupError([...base, ...extras]);
}

const swallow = (): void => undefined;

const warnToConsole = (message: string, error: unknown): void => {
  console.warn(`[docseeker] ${message}`, error);
};

const defaultRandomId = (): string => globalThis.crypto.randomUUID().replace(/-/g, "");

/** Fichiers ordinaires au nom sûr ; tout autre nom renvoyé par le noyau est ignoré. */
const isUsableEntry = (entry: DirEntry): boolean =>
  !entry.isDir && !entry.isSymlink && segmentProblem(entry.name) === null;

export function createPetalStore(options: PetalStoreOptions): PetalStore {
  const { api } = options;
  const pluginName = options.pluginName ?? DEFAULT_PLUGIN_NAME;
  assertSafeSegment(pluginName);
  const randomId = options.randomId ?? defaultRandomId;
  const now = options.now ?? Date.now;
  const warn = options.onWarning ?? warnToConsole;
  const dir = `${PETAL_ROOT}/${pluginName}/${IDX_DIR_NAME}`;
  const pathOf = (name: string): string => `${dir}/${name}`;
  const queues = new Map<string, Promise<void>>();

  /** Exécute `task` après les tâches déjà en file pour ce nom ; la file est nettoyée à la fin. */
  const serialized = <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(name) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(swallow, swallow);
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return run;
  };

  /** Remplace un fichier existant : ancien -> .bak, tmp -> final, puis .bak supprimé. */
  const replaceExisting = async (tmpPath: string, finalPath: string): Promise<void> => {
    const bakPath = `${finalPath}${BAK_SUFFIX}`;
    const [leftoverError] = await attempt(() => api.removeFile(bakPath), true); // reste d'une tentative précédente
    if (leftoverError !== undefined) throw leftoverError;
    await api.renameFile(finalPath, bakPath);
    try {
      await api.renameFile(tmpPath, finalPath);
    } catch (error) {
      throw withSecondary(error, await attempt(() => api.renameFile(bakPath, finalPath), false));
    }
    for (const error of await attempt(() => api.removeFile(bakPath), true)) {
      warn(`could not remove ${bakPath} after a successful write`, error);
    }
  };

  const publish = async (tmpPath: string, finalPath: string): Promise<void> => {
    try {
      await api.renameFile(tmpPath, finalPath);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await replaceExisting(tmpPath, finalPath);
    }
  };

  const listEntries = async (): Promise<readonly DirEntry[] | null> => {
    try {
      return await api.readDir(dir);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };

  const listNames = async (): Promise<readonly string[]> =>
    (await listEntries() ?? []).filter((entry) => !entry.isDir).map((entry) => entry.name);

  const readOrNull = async (path: string): Promise<Uint8Array | null> => {
    try {
      return await api.getFile(path);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };

  /** Restaure ou supprime un .bak ancien, en revérifiant le final juste avant d'agir. */
  const settleBackup = (bakName: string): Promise<void> => {
    const finalName = bakName.slice(0, -BAK_SUFFIX.length);
    return serialized(finalName, async () => {
      const finalExists = (await listNames()).includes(finalName);
      if (finalExists) await removeIgnoringAbsence(pathOf(bakName));
      else await api.renameFile(pathOf(bakName), pathOf(finalName));
    });
  };

  const removeIgnoringAbsence = async (path: string): Promise<boolean> => {
    try {
      await api.removeFile(path);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  };

  return {
    async write(name, bytes) {
      assertValidName(name);
      const id = randomId();
      assertSafeSegment(id);
      const finalPath = pathOf(name);
      const tmpPath = `${finalPath}.${id}${TMP_SUFFIX}`;
      return serialized(name, async () => {
        try {
          await api.putFile(tmpPath, bytes);
          await publish(tmpPath, finalPath);
        } catch (error) {
          throw withSecondary(error, await attempt(() => api.removeFile(tmpPath), true));
        }
      });
    },

    async read(name) {
      assertValidName(name);
      const path = pathOf(name);
      return (await readOrNull(path)) ?? (await readOrNull(`${path}${BAK_SUFFIX}`));
    },

    async list() {
      const names = await listNames();
      const visible = new Set<string>();
      for (const name of names) {
        if (!isTransient(name)) visible.add(name);
        else if (name.endsWith(BAK_SUFFIX)) {
          const stem = name.slice(0, -BAK_SUFFIX.length);
          if (stem.length > 0 && !isTransient(stem)) visible.add(stem);
        }
      }
      return [...visible].sort();
    },

    async remove(name) {
      assertValidName(name);
      return serialized(name, async () => {
        const path = pathOf(name);
        const removedFinal = await removeIgnoringAbsence(path);
        const removedBackup = await removeIgnoringAbsence(`${path}${BAK_SUFFIX}`);
        return removedFinal || removedBackup;
      });
    },

    async removeStaleTmp() {
      const entries = (await listEntries()) ?? [];
      const cutoff = now() - STALE_TMP_AGE_MS;
      const stale = entries
        .filter(isUsableEntry)
        .filter((entry) => isTransient(entry.name) && entry.updated * MS_PER_SECOND < cutoff)
        .map((entry) => entry.name);
      const handled: string[] = [];
      const failed: StaleCleanupFailure[] = [];
      const backups = stale.filter((n) => n.endsWith(BAK_SUFFIX) && !isTransient(n.slice(0, -BAK_SUFFIX.length)));
      const temps = stale.filter((n) => n.endsWith(TMP_SUFFIX));
      const jobs = [
        ...backups.map((name) => ({ name, run: () => settleBackup(name) })),
        ...temps.map((name) => ({ name, run: () => removeIgnoringAbsence(pathOf(name)) })),
      ];
      for (const job of jobs) {
        try {
          await job.run();
          handled.push(job.name);
        } catch (error) {
          failed.push({ name: job.name, error });
        }
      }
      return { handled, failed };
    },

    async clear() {
      const listClearable = async (): Promise<string[]> =>
        ((await listEntries()) ?? []).filter(isUsableEntry).map((e) => e.name).filter((n) => CLEARABLE.test(n));
      const groups = new Map<string, string[]>(); // fichier final -> [.bak/.tmp..., final]
      for (const name of await listClearable()) {
        const key = name.replace(TRANSIENT_TAIL, "");
        const group = groups.get(key) ?? [];
        group.push(name);
        groups.set(key, group);
      }
      const removed: string[] = [];
      const failed: StaleCleanupFailure[] = [];
      /** Transitoires d'abord, final ensuite ; le final est conservé si un transitoire résiste. */
      const clearGroup = async (key: string, names: readonly string[]): Promise<boolean> => {
        const ordered = [...names.filter((n) => n !== key), ...names.filter((n) => n === key)];
        let blocked = false;
        for (const name of ordered) {
          if (blocked && name === key) {
            failed.push({ name, error: new Error("conservé : un fichier .bak/.tmp associé n'a pas pu être supprimé") });
            continue;
          }
          try {
            await serialized(key, () => removeIgnoringAbsence(pathOf(name)));
            removed.push(name);
          } catch (error) {
            failed.push({ name, error });
            blocked = true;
          }
        }
        return !blocked;
      };
      const manifestNames = groups.get(MANIFEST_NAME);
      groups.delete(MANIFEST_NAME);
      if (manifestNames && !(await clearGroup(MANIFEST_NAME, manifestNames))) {
        return { removed, failed, manifestFailed: true };
      }
      for (const [key, names] of groups) await clearGroup(key, names);
      try {
        const known = new Set([...removed, ...failed.map((f) => f.name)]);
        for (const name of await listClearable()) {
          if (!known.has(name) || removed.includes(name)) {
            failed.push({ name, error: new Error("fichier apparu pendant le vidage (indexation concurrente ?)") });
          }
        }
      } catch (error) {
        failed.push({ name: "(relecture du dossier)", error });
      }
      return { removed, failed, manifestFailed: false };
    },
  };
}
