/**
 * Orchestrateur d'indexation : synchronise les `.dsx` avec les PDF découverts.
 *
 * Entièrement injectable (aucun window/document/Worker). Choix documentés :
 * - Manifeste précédent : `manifest.json` dans le store ({version, entries}), validé à la lecture.
 *   Illisible/corrompu => on repart de zéro (tout est réindexé) SANS jamais supprimer d'index.
 *   Erreur d'E/S à la lecture => la synchronisation est abandonnée (on ne sait pas ce qui existe).
 * - Un PDF n'entre dans le manifeste qu'après écriture réussie de son `.dsx` (un échec sera retenté).
 *   Exception : un PDF scanné n'a pas de `.dsx` mais est enregistré, pour ne pas être réextrait à chaque passe.
 * - RISQUE 4 : le signal est vérifié juste avant `store.write` / `store.remove` et avant chaque écriture du
 *   manifeste ; un traitement abandonné ne publie donc rien.
 * - Version d'index PAR ENTRÉE du manifeste (`indexVersion`, CURRENT_INDEX_VERSION ; absente = 1). La comparaison est
 *   faite ici, dans `synchronize` (`entriesNeedingMigration`) : un PDF INCHANGÉ dont l'entrée est plus ancienne est
 *   réindexé comme un PDF modifié. Tant que la réindexation n'a pas réussi, ni le `.dsx` ni l'entrée ne sont touchés
 *   (le `.dsx` v1 reste lisible ; le store remplace un fichier existant sans trou, voir petalStore) ; en cas
 *   d'échec le PDF suit le retrait progressif (5 min / 30 min / 2 h) comme tout échec. Une entrée de version
 *   postérieure n'est jamais rétrogradée tant que le PDF est inchangé (elle est conservée telle quelle et tracée,
 *   une seule fois par chemin et valeur) ; si le PDF change ou si on force sa réindexation, le `.dsx` écrit est en
 *   version courante et l'entrée est donc réécrite en version courante. `MANIFEST_VERSION` (format du fichier
 *   manifeste) ne change pas : un champ en plus ne casse pas la lecture par une version antérieure.
 * - Une réindexation ciblée (`reindex(chemin)`) ne migre que ce PDF ; les autres passes migrent toute la bibliothèque.
 * - Manifeste rejeté (version globale inconnue, entrée invalide, JSON illisible) : l'original est sauvegardé AVANT
 *   toute écriture dans `manifest.rejected.json` (le suffixe `.bak` est réservé par le store). Une sauvegarde
 *   existante d'un autre contenu n'est jamais écrasée (l'original va alors dans `manifest.rejected-<horodatage-ms>.json`).
 *   L'opération est idempotente (aucune écriture si une sauvegarde identique existe) et plafonnée à
 *   `MAX_REJECTED_MANIFEST_BACKUPS` fichiers (les plus anciennes datées sont supprimées, avec trace).
 *   Sauvegarde impossible => la passe échoue (`ManifestBackupError`) sans rien écrire.
 * - Avertissements non fatals (manifeste ignoré, indexVersion inattendue, page aberrante, ancien index non supprimé) :
 *   `deps.onWarn` (obligatoire : aucune anomalie n'est avalée sans trace).
 * - Nom du fichier : `<empreinte>.dsx` (empreinte = chemin + taille). Si la taille change, l'ancien fichier
 *   est supprimé après la mise à jour du manifeste (échec de ce nettoyage tracé : fichier orphelin inoffensif).
 */
import { encodeIndex } from "../core/codec/encode";
import {
  buildDocumentIndex,
  isLikelyScanned,
  type ExtractedPage,
  type TextItemLike,
} from "../core/extract";
import {
  CURRENT_INDEX_VERSION,
  entriesNeedingMigration,
  fingerprint,
  readIndexVersion,
  type IndexedEntry,
  type Manifest,
  type PdfEntry,
} from "../core/manifest";
import { createIndexQueue, type IndexQueue, type QueueState } from "../core/queue";
import { planIndexUpdate, type DiscoveryResult } from "../siyuan/discovery";
import type { PetalStore } from "../siyuan/petalStore";

export const MANIFEST_FILE_NAME = "manifest.json";
export const MANIFEST_VERSION = 1;
export const EVENT_MESSAGE_MAX_LENGTH = 200;
export const NORMALIZER_VERSION = 1;
/** Sauvegarde de l'original d'un manifeste rejeté (le suffixe `.bak` est réservé par le store). */
export const REJECTED_MANIFEST_BACKUP = "manifest.rejected.json";
/** Nombre maximal de sauvegardes de manifeste rejeté conservées (`manifest.rejected*.json`). */
export const MAX_REJECTED_MANIFEST_BACKUPS = 5;
const REJECTED_BACKUP_NAME = /^manifest\.rejected(?:-(\d+))?\.json$/;
export const EXTRACTOR_VERSION = "docseeker-extract-2";
const EMPTY_SUMMARY: IndexSummary = {
  indexed: 0,
  skippedScanned: 0,
  failed: 0,
  removed: 0,
  migrated: 0,
  cancelled: false,
  incomplete: 0,
  incompleteDetails: [],
  failures: [],
};
/** Délais avant une nouvelle tentative d'un PDF en échec (passes automatiques) : 5 min, 30 min, 2 h (plafond). */
export const FAILURE_BACKOFF_MS: readonly number[] = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** Pas d'attente tant que `shouldYield` est vrai. */
export const YIELD_STEP_MS = 500;
/** Chemin des échecs qui ne portent pas sur un PDF (découverte) ; le manifeste utilise MANIFEST_FILE_NAME. */
export const DISCOVERY_FAILURE_PATH = "(discovery)";

export interface PdfViewportLike {
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
}

export interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void> | void;
}

export interface IndexerDeps {
  readonly discover: () => Promise<DiscoveryResult>;
  readonly store: Pick<PetalStore, "read" | "write" | "remove" | "list">;
  readonly loadPdf: (path: string, signal: AbortSignal) => Promise<PdfDocumentLike>;
  readonly now: () => number;
  readonly concurrency?: number;
  readonly onListenerError?: (error: unknown) => void;
  /** Appelé si la libération d'un document échoue ; le résultat de l'indexation n'est pas modifié. */
  readonly onDestroyError?: (error: unknown) => void;
  /** Reçoit chaque avertissement non fatal (message en français). Obligatoire ; une exception du rappel est signalée à `onListenerError`. */
  readonly onWarn: (message: string) => void;
  /**
   * Vrai tant que l'utilisateur est actif : une passe AUTOMATIQUE attend, avant chaque chargement de PDF,
   * par pas de `YIELD_STEP_MS`. Jamais pour une passe manuelle. Un détecteur qui lève compte comme faux.
   */
  readonly shouldYield?: () => boolean;
  /** Attente injectable (tests sans vrai minuteur). */
  readonly delay?: (ms: number) => Promise<void>;
}

export interface IndexSummary {
  readonly indexed: number;
  readonly skippedScanned: number;
  readonly failed: number;
  readonly removed: number;
  /**
   * PDF inchangés réindexés parce que leur index était d'une version plus ancienne (migration .dsx v1 -> v2).
   * Déjà compris dans `indexed` (ou `skippedScanned` pour un PDF sans texte).
   */
  readonly migrated: number;
  readonly cancelled: boolean;
  /** Éléments que le parcours n'a pas pu lire (dossier illisible, taille inconnue…) : l'index peut être incomplet. */
  readonly incomplete: number;
  /** « chemin : raison » pour chaque élément non parcouru. */
  readonly incompleteDetails?: readonly string[];
  /** « chemin : message » pour chaque échec, y compris les PDF sautés par le retrait progressif. */
  readonly failures?: readonly string[];
}

export type IndexerEvent =
  | { readonly type: "started" }
  /**
   * Émis après le plan, seulement s'il y a des PDF à migrer : `toIndex` PDF à traiter dont `migrating` à migrer.
   * `complete` : le parcours était complet (sinon des PDF absents du parcours peuvent manquer aux résultats).
   */
  | { readonly type: "plan"; readonly toIndex: number; readonly migrating: number; readonly complete: boolean }
  | { readonly type: "progress"; readonly path: string; readonly page: number; readonly total: number }
  | { readonly type: "indexed"; readonly path: string; readonly pages: number }
  | { readonly type: "skipped-scanned"; readonly path: string }
  | { readonly type: "failed"; readonly path: string; readonly message: string }
  | { readonly type: "removed"; readonly path: string }
  | { readonly type: "idle"; readonly summary: IndexSummary };

export interface IndexerState {
  readonly status: "idle" | "running" | "paused";
  readonly paused: boolean;
  readonly queue: QueueState | null;
  readonly lastSummary: IndexSummary | null;
}

export interface Indexer {
  /**
   * Lance une synchronisation ; si une est en cours, renvoie la même promesse. Ne rejette jamais.
   * `automatic` : passe planifiée (retrait progressif des PDF en échec, pause pendant l'activité) ;
   * sans option, passe manuelle qui remet les compteurs d'échecs à zéro.
   */
  start(options?: { readonly automatic?: boolean }): Promise<IndexSummary>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Force la réindexation d'un PDF (ou de tous), après la synchronisation en cours le cas échéant. */
  reindex(path?: string): Promise<IndexSummary>;
  /** Vide la table de retrait progressif des PDF en échec (ex. après « Vider l'index »). */
  resetFailures(): void;
  getState(): IndexerState;
  onEvent(listener: (event: IndexerEvent) => void): () => void;
}

interface Run {
  readonly abort: AbortController;
  readonly automatic: boolean;
  promise: Promise<IndexSummary>;
  queue: IndexQueue | null;
}

interface Counters {
  indexed: number;
  skippedScanned: number;
  failed: number;
  removed: number;
  migrated: number;
  incomplete: number;
  incompleteDetails: string[];
  failures: string[];
}

interface FailureRecord {
  readonly fingerprint: string;
  readonly attempts: number;
  readonly nextAt: number;
  readonly message: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const truncate = (message: string): string => message.slice(0, EVENT_MESSAGE_MAX_LENGTH);

function abortError(): Error {
  const error = new Error("Indexing aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

const dsxName = (entry: PdfEntry): string => `${fingerprint(entry)}.dsx`;

function isValidEntry(value: unknown): value is PdfEntry & { readonly indexVersion?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const { path, size, modifiedAt } = value as Record<string, unknown>;
  return (
    typeof path === "string" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof modifiedAt === "number" &&
    Number.isFinite(modifiedAt)
  );
}

/** Entrées validées d'un manifeste. `problem` : pourquoi le manifeste est ignoré (null = valide). */
type ParsedManifest =
  | { readonly entries: IndexedEntry[]; readonly warnings: readonly string[]; readonly problem: null }
  | { readonly entries: null; readonly warnings: readonly string[]; readonly problem: string };

const rejected = (problem: string): ParsedManifest => ({ entries: null, warnings: [], problem });

function parseManifest(bytes: Uint8Array): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return rejected(`contenu illisible (${truncate(messageOf(error))})`);
  }
  if (typeof parsed !== "object" || parsed === null) return rejected("contenu inattendu (objet attendu)");
  const { version, entries } = parsed as Record<string, unknown>;
  if (version !== MANIFEST_VERSION) {
    return rejected(`version ${JSON.stringify(version) ?? String(version)} inconnue (version ${MANIFEST_VERSION} attendue)`);
  }
  if (!Array.isArray(entries) || !entries.every(isValidEntry)) return rejected("entrées invalides");
  const paths = new Set(entries.map((e) => e.path));
  if (paths.size !== entries.length) return rejected("chemins en double");
  const warnings: string[] = [];
  const result = entries.map((e): IndexedEntry => {
    const reading = readIndexVersion(e.indexVersion);
    if (reading.problem !== undefined) warnings.push(`${e.path} : ${reading.problem}`);
    return { path: e.path, size: e.size, modifiedAt: e.modifiedAt, indexVersion: reading.version };
  });
  return { entries: result, warnings, problem: null };
}

const serializeManifest = (entries: ReadonlyMap<string, IndexedEntry>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version: MANIFEST_VERSION, entries: [...entries.values()] }));

function toPage(pageNumber: number, viewport: PdfViewportLike, content: { items: readonly unknown[] }): ExtractedPage {
  const items = content.items.filter(
    (item): item is TextItemLike => typeof (item as { str?: unknown } | null)?.str === "string",
  );
  return {
    pageNumber,
    viewportTransform: viewport.transform,
    viewWidth: viewport.width,
    viewHeight: viewport.height,
    items,
  };
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const listeners = new Set<(event: IndexerEvent) => void>();
  let run: Run | null = null;
  let paused = false;
  let lastSummary: IndexSummary | null = null;
  /** PDF en échec : échecs consécutifs et prochain essai autorisé pour une passe automatique (mémoire seulement). */
  const failedPdfs = new Map<string, FailureRecord>();
  /** Avertissements d'indexVersion déjà émis (chemin + valeur) : pas de répétition à chaque passe. */
  const warnedVersions = new Set<string>();
  /** Avertissements « manifeste rejeté » déjà émis (sauvegarde + problème) : pas de répétition à chaque passe. */
  const warnedRejections = new Set<string>();
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const reportInternal = (error: unknown): void => {
    try {
      deps.onListenerError?.(error);
    } catch {
      // un gestionnaire d'erreurs défaillant ne doit rien casser
    }
  };
  const mustYield = (): boolean => {
    try {
      return deps.shouldYield?.() ?? false;
    } catch (error) {
      reportInternal(error);
      return false;
    }
  };
  /** Attend la fin de l'activité de l'utilisateur (passe automatique seulement), par pas, annulable. */
  async function yieldToUser(runCtx: Run): Promise<void> {
    if (!runCtx.automatic) return;
    while (mustYield()) {
      throwIfAborted(runCtx.abort.signal);
      await delay(YIELD_STEP_MS);
    }
    throwIfAborted(runCtx.abort.signal);
  }
  const recordFailure = (entry: PdfEntry, message: string): void => {
    const attempts = (failedPdfs.get(entry.path)?.attempts ?? 0) + 1;
    const wait = FAILURE_BACKOFF_MS[Math.min(attempts, FAILURE_BACKOFF_MS.length) - 1] as number;
    failedPdfs.set(entry.path, { fingerprint: fingerprint(entry), attempts, nextAt: deps.now() + wait, message });
  };

  const warn = (message: string): void => {
    try {
      deps.onWarn(message);
    } catch (error) {
      reportInternal(error);
    }
  };

  const emit = (event: IndexerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          deps.onListenerError?.(error);
        } catch {
          // un gestionnaire d'erreurs défaillant ne doit rien casser
        }
      }
    }
  };

  /** Compte un échec, le retient dans le bilan et l'annonce. */
  function fail(counters: Counters, path: string, message: string): void {
    counters.failed += 1;
    counters.failures.push(`${path} : ${message}`);
    emit({ type: "failed", path, message });
  }

  async function loadPrevious(): Promise<IndexedEntry[]> {
    const bytes = await deps.store.read(MANIFEST_FILE_NAME);
    if (bytes === null) return [];
    const parsed = parseManifest(bytes);
    for (const message of parsed.warnings) {
      if (warnedVersions.has(message)) continue;
      warnedVersions.add(message);
      warn(`${MANIFEST_FILE_NAME} : ${message}`);
    }
    if (parsed.entries === null) {
      // Jamais de suppression d'index sur un manifeste inutilisable : tout est réindexé, rien n'est retiré.
      // L'original est sauvegardé avant la première écriture (une lecture ou écriture qui échoue abandonne la passe).
      const backup = await backupRejectedManifest(bytes);
      const key = `${backup}\n${parsed.problem}`;
      if (!warnedRejections.has(key)) {
        warnedRejections.add(key);
        warn(`${MANIFEST_FILE_NAME} : original sauvegardé dans ${backup}`);
        warn(`${MANIFEST_FILE_NAME} ignoré (${parsed.problem}) : réindexation complète, aucun index supprimé`);
      }
      return [];
    }
    return parsed.entries;
  }

  const sameBytes = (x: Uint8Array, y: Uint8Array): boolean => x.length === y.length && x.every((byte, i) => byte === y[i]);

  /**
   * Sauvegarde les octets d'un manifeste rejeté, de façon idempotente et sans écraser une sauvegarde différente ;
   * renvoie le nom de la sauvegarde (existante identique ou créée). Toute erreur devient `ManifestBackupError`.
   */
  async function backupRejectedManifest(bytes: Uint8Array): Promise<string> {
    let name: string;
    let existing: string[];
    try {
      existing = (await deps.store.list()).filter((n) => REJECTED_BACKUP_NAME.test(n));
      for (const candidate of existing) {
        const content = await deps.store.read(candidate);
        if (content !== null && sameBytes(content, bytes)) return candidate;
      }
      name = existing.includes(REJECTED_MANIFEST_BACKUP) ? `manifest.rejected-${deps.now()}.json` : REJECTED_MANIFEST_BACKUP;
      await deps.store.write(name, bytes);
    } catch (error) {
      throw new ManifestBackupError(truncate(messageOf(error)));
    }
    await pruneRejectedBackups([...existing, name], name);
    return name;
  }

  /** Plafonne les sauvegardes : retire les plus anciennes datées (jamais `manifest.rejected.json`, jamais `keep`). */
  async function pruneRejectedBackups(names: readonly string[], keep: string): Promise<void> {
    const excess = names.length - MAX_REJECTED_MANIFEST_BACKUPS;
    if (excess <= 0) return;
    const dated = names
      .filter((n) => n !== keep)
      .map((n) => ({ n, at: Number(REJECTED_BACKUP_NAME.exec(n)?.[1]) }))
      .filter((d) => Number.isFinite(d.at))
      .sort((x, y) => x.at - y.at)
      .slice(0, excess);
    for (const { n } of dated) {
      try {
        await deps.store.remove(n);
        warn(`${MANIFEST_FILE_NAME} : ancienne sauvegarde ${n} supprimée (plafond de ${MAX_REJECTED_MANIFEST_BACKUPS} sauvegardes)`);
      } catch (error) {
        warn(`${MANIFEST_FILE_NAME} : suppression de l'ancienne sauvegarde ${n} impossible : ${truncate(messageOf(error))}`);
      }
    }
  }

  async function execute(runCtx: Run, force: ReadonlySet<string> | "all" | null): Promise<IndexSummary> {
    const counters: Counters = {
      indexed: 0,
      skippedScanned: 0,
      failed: 0,
      removed: 0,
      migrated: 0,
      incomplete: 0,
      incompleteDetails: [],
      failures: [],
    };
    const signal = runCtx.abort.signal;
    const summary = (): IndexSummary => ({
      ...counters,
      incompleteDetails: [...counters.incompleteDetails],
      failures: [...counters.failures],
      cancelled: signal.aborted,
    });
    emit({ type: "started" });
    try {
      await synchronize(runCtx, counters, force);
    } catch (error) {
      if (!signal.aborted) {
        const path = error instanceof ManifestReadError || error instanceof ManifestBackupError ? MANIFEST_FILE_NAME : DISCOVERY_FAILURE_PATH;
        fail(counters, path, truncate(messageOf(error)));
      }
    }
    const result = summary();
    lastSummary = result;
    run = null;
    emit({ type: "idle", summary: result });
    return result;
  }

  async function synchronize(runCtx: Run, counters: Counters, force: ReadonlySet<string> | "all" | null): Promise<void> {
    const signal = runCtx.abort.signal;
    const previous = await loadPrevious().catch((error: unknown) => {
      if (error instanceof ManifestBackupError) throw error;
      throw new ManifestReadError(messageOf(error));
    });
    throwIfAborted(signal);
    const discovered = await deps.discover();
    throwIfAborted(signal);
    // Un parcours incomplet n'est jamais « à jour » : on le fait remonter (la garde de suppression est dans planIndexUpdate).
    // discoverPdfs range un PDF sans taille dans `issues` ET `unsized` : on ne le compte qu'une fois.
    const issuePaths = new Set(discovered.issues.map((issue) => issue.path));
    counters.incompleteDetails = [
      ...discovered.issues.map((issue) => `${issue.path} : ${issue.message}`),
      ...discovered.unsized.filter((path) => !issuePaths.has(path)).map((path) => `${path} : taille inconnue`),
    ];
    counters.incomplete = counters.incompleteDetails.length;

    let current = new Map<string, IndexedEntry>(previous.map((e) => [e.path, e]));
    // Écritures du manifeste sérialisées ; le signal est revérifié juste avant chaque écriture.
    let chain: Promise<void> = Promise.resolve();
    const persist = (mutate: (next: Map<string, IndexedEntry>) => void, jobSignal: AbortSignal): Promise<void> => {
      const task = chain.then(async () => {
        throwIfAborted(jobSignal);
        throwIfAborted(signal);
        const next = new Map(current);
        mutate(next);
        await deps.store.write(MANIFEST_FILE_NAME, serializeManifest(next));
        current = next;
      });
      chain = task.catch(() => undefined);
      return task;
    };

    const plan = planIndexUpdate(previous as Manifest, discovered);
    const forced = forcedEntries(discovered.manifest, force);
    let toIndex = [...plan.toIndex];
    // Migration : PDF inchangés dont l'index est d'une version plus ancienne, réindexés comme les modifiés.
    // Une réindexation ciblée ne migre que le PDF demandé ; les autres passes migrent toute la bibliothèque.
    const migrating = entriesNeedingMigration(previous, discovered.manifest).filter(
      (e) => force === null || force === "all" || force.has(e.path),
    );
    for (const entry of migrating) if (!toIndex.some((e) => e.path === entry.path)) toIndex.push(entry);
    for (const entry of forced) if (!toIndex.some((e) => e.path === entry.path)) toIndex.push(entry);
    // Retrait progressif : la table ne garde que les PDF encore présents ; une passe automatique saute ceux dont
    // l'empreinte est inchangée et dont le prochain essai n'est pas atteint (ils restent comptés en échec).
    const present = new Set(discovered.manifest.map((e) => e.path));
    if (discovered.complete) for (const path of [...failedPdfs.keys()]) if (!present.has(path)) failedPdfs.delete(path);
    if (runCtx.automatic) {
      const nowMs = deps.now();
      toIndex = toIndex.filter((entry) => {
        const record = failedPdfs.get(entry.path);
        if (!record || record.fingerprint !== fingerprint(entry) || nowMs >= record.nextAt) return true;
        counters.failed += 1;
        counters.failures.push(`${entry.path} : ${record.message}`);
        return false;
      });
    }

    if (migrating.length > 0) {
      const migratingPaths = new Set(migrating.map((e) => e.path));
      emit({
        type: "plan",
        toIndex: toIndex.length,
        migrating: toIndex.filter((e) => migratingPaths.has(e.path)).length,
        complete: discovered.complete,
      });
    }

    if (plan.removalsAllowed) {
      for (const entry of plan.toRemove) {
        throwIfAborted(signal);
        await removeEntry(entry, signal, counters, persist);
      }
    }
    throwIfAborted(signal);
    await indexAll(runCtx, toIndex, counters, () => current, persist);
  }

  async function removeEntry(
    entry: PdfEntry,
    signal: AbortSignal,
    counters: Counters,
    persist: (m: (n: Map<string, IndexedEntry>) => void, s: AbortSignal) => Promise<void>,
  ): Promise<void> {
    try {
      throwIfAborted(signal);
      await deps.store.remove(dsxName(entry));
      await persist((n) => n.delete(entry.path), signal);
      counters.removed += 1;
      emit({ type: "removed", path: entry.path });
    } catch (error) {
      if (signal.aborted) return;
      fail(counters, entry.path, truncate(messageOf(error)));
    }
  }

  async function indexAll(
    runCtx: Run,
    toIndex: readonly PdfEntry[],
    counters: Counters,
    currentEntries: () => ReadonlyMap<string, IndexedEntry>,
    persist: (m: (n: Map<string, IndexedEntry>) => void, s: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (toIndex.length === 0) return;
    const byPath = new Map(toIndex.map((e) => [e.path, e]));
    const runSignal = runCtx.abort.signal;

    const processOne = async (path: string, ctx: { signal: AbortSignal; reportProgress(d: number, t?: number): void }): Promise<void> => {
      const entry = byPath.get(path) as PdfEntry;
      const jobSignal = ctx.signal;
      const aborted = (): boolean => jobSignal.aborted || runSignal.aborted;
      const guard = (): void => {
        if (aborted()) throw abortError();
      };
      let doc: PdfDocumentLike | undefined;
      try {
        await yieldToUser(runCtx);
        guard();
        doc = await deps.loadPdf(path, jobSignal);
        guard();
        const total = doc.numPages;
        const pages: ExtractedPage[] = [];
        for (let n = 1; n <= total; n += 1) {
          const page = await doc.getPage(n);
          guard();
          const content = await page.getTextContent();
          guard();
          pages.push(toPage(n, page.getViewport({ scale: 1 }), content));
          ctx.reportProgress(n, total);
          emit({ type: "progress", path, page: n, total });
        }
        guard();
        const previousEntry = currentEntries().get(path);
        const stored: IndexedEntry = { ...entry, indexVersion: CURRENT_INDEX_VERSION };
        const isMigration =
          previousEntry !== undefined &&
          previousEntry.size === entry.size &&
          previousEntry.modifiedAt === entry.modifiedAt &&
          previousEntry.indexVersion < CURRENT_INDEX_VERSION;
        if (isLikelyScanned(pages)) {
          await persist((m) => m.set(path, stored), jobSignal);
          if (previousEntry !== undefined) await tryRemove(dsxName(previousEntry), path);
          failedPdfs.delete(path);
          counters.skippedScanned += 1;
          if (isMigration) counters.migrated += 1;
          emit({ type: "skipped-scanned", path });
          return;
        }
        const index = buildDocumentIndex(
          {
            normalizerVersion: NORMALIZER_VERSION,
            extractorVersion: EXTRACTOR_VERSION,
            pdfSize: entry.size,
            pdfModifiedMs: entry.modifiedAt,
            sourcePath: path,
            pageCount: total,
          },
          pages,
          { onWarn: (message) => warn(`${path} : ${message}`) },
        );
        const bytes = await encodeIndex(index);
        guard(); // dernier contrôle avant publication (RISQUE 4)
        await deps.store.write(dsxName(entry), bytes);
        await persist((m) => m.set(path, stored), jobSignal);
        if (previousEntry !== undefined && dsxName(previousEntry) !== dsxName(entry)) {
          await tryRemove(dsxName(previousEntry), path);
        }
        failedPdfs.delete(path);
        counters.indexed += 1;
        if (isMigration) counters.migrated += 1;
        emit({ type: "indexed", path, pages: total });
      } catch (error) {
        if (!aborted()) {
          const message = truncate(messageOf(error));
          recordFailure(entry, message);
          fail(counters, path, message);
        }
        throw error;
      } finally {
        if (doc !== undefined) {
          try {
            await doc.destroy();
          } catch (error) {
            // la libération est au mieux ; elle ne doit pas masquer le résultat du traitement
            try {
              deps.onDestroyError?.(error);
            } catch {
              // un gestionnaire d'erreurs défaillant ne doit rien casser
            }
          }
        }
      }
    };

    const queue = createIndexQueue({
      process: processOne,
      ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    });
    runCtx.queue = queue;
    if (paused) queue.pause();
    if (runSignal.aborted) return;
    for (const path of byPath.keys()) queue.enqueue(path);
    await queue.onIdle();
  }

  /** Supprime l'ancien `.dsx` après une indexation réussie ; un échec est tracé (orphelin inoffensif), jamais fatal. */
  async function tryRemove(name: string, path: string): Promise<void> {
    try {
      await deps.store.remove(name);
    } catch (error) {
      warn(`${path} : suppression de l'ancien index en échec : ${truncate(messageOf(error))}`);
    }
  }

  function begin(force: ReadonlySet<string> | "all" | null, automatic: boolean): Run {
    const abort = new AbortController();
    const runCtx: Run = { abort, automatic, queue: null, promise: Promise.resolve(EMPTY_SUMMARY) };
    run = runCtx; // publié avant `execute` : un listener de « started » voit déjà la synchronisation en cours
    runCtx.promise = execute(runCtx, force);
    return runCtx;
  }

  function startRun(force: ReadonlySet<string> | "all" | null, automatic: boolean): Promise<IndexSummary> {
    if (run !== null) return run.promise;
    if (!automatic) failedPdfs.clear(); // passe manuelle ou forcée : tous les PDF sont retentés
    return begin(force, automatic).promise;
  }

  return {
    start(options) {
      if (run !== null) {
        if (options?.automatic !== true) failedPdfs.clear(); // une demande manuelle qui rejoint une passe : retentera tout
        return run.promise;
      }
      return startRun(null, options?.automatic === true);
    },
    pause() {
      paused = true;
      run?.queue?.pause();
    },
    resume() {
      paused = false;
      run?.queue?.resume();
    },
    cancel() {
      if (run === null) return;
      run.abort.abort();
      const queue = run.queue;
      if (queue === null) return;
      const state = queue.state();
      for (const id of [...state.pending, ...state.running]) queue.cancel(id);
    },
    resetFailures() {
      failedPdfs.clear();
    },
    reindex(path) {
      const force: ReadonlySet<string> | "all" = path === undefined ? "all" : new Set([path]);
      failedPdfs.clear();
      if (run === null) return startRun(force, false);
      return run.promise.then(() => startRun(force, false));
    },
    getState() {
      const status = run === null ? "idle" : paused ? "paused" : "running";
      return { status, paused, queue: run?.queue?.state() ?? null, lastSummary };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

class ManifestBackupError extends Error {
  constructor(cause: string) {
    super(`sauvegarde du manifeste rejeté impossible : ${cause}`);
    this.name = "ManifestBackupError";
  }
}

class ManifestReadError extends Error {
  constructor(message: string) {
    super(`Cannot read ${MANIFEST_FILE_NAME}: ${message}`);
    this.name = "ManifestReadError";
  }
}

function forcedEntries(manifest: Manifest, force: ReadonlySet<string> | "all" | null): readonly PdfEntry[] {
  if (force === null) return [];
  return force === "all" ? manifest : manifest.filter((e) => force.has(e.path));
}
