/**
 * Activité d'indexation destinée à l'indicateur discret de l'onglet de recherche. Module pur.
 *
 * - « running » n'apparaît qu'au premier vrai travail (page lue, PDF indexé ou retiré) : une passe
 *   automatique sans changement (started puis idle à zéro) ne produit aucun état ni notification.
 * - Les événements `progress` (un par page) ne notifient que si le N/M change.
 * - À la fin : « failed » si des échecs ; sinon « partial » si le parcours était incomplet (jamais « à jour »
 *   dans ce cas) ; sinon « done » si du travail a eu lieu ; sinon « idle ».
 * - Un PDF déjà en échec à la passe précédente (y compris sauté par le retrait progressif) qui émet de nouveau
 *   des `progress` n'est pas du travail nouveau : l'état reste « failed » (pas de clignotement).
 */
import { DISCOVERY_FAILURE_PATH, MANIFEST_FILE_NAME, type IndexerEvent } from "./indexer";

export type ActivityPhase = "idle" | "running" | "done" | "partial" | "failed";

export interface IndexActivitySnapshot {
  readonly phase: ActivityPhase;
  readonly done: number;
  readonly total: number;
  readonly failed: number;
  /** Éléments non parcourus (état « partial »). */
  readonly incomplete: number;
  /** Vrai si l'échec porte sur la découverte ou le manifeste plutôt que sur des PDF. */
  readonly discovery: boolean;
}

export interface IndexActivityDeps {
  readonly indexer: { onEvent(listener: (event: IndexerEvent) => void): () => void };
  /** PDF terminés / à traiter dans la passe en cours (file de l'indexeur), ou null. */
  readonly getProgress?: () => { done: number; total: number } | null;
  readonly onWarn?: (message: string, error?: unknown) => void;
}

export interface IndexActivity {
  getSnapshot(): IndexActivitySnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const IDLE: IndexActivitySnapshot = { phase: "idle", done: 0, total: 0, failed: 0, incomplete: 0, discovery: false };

export function createIndexActivity(deps: IndexActivityDeps): IndexActivity {
  let snapshot = IDLE;
  let worked = false;
  /** Échecs « chemin : message » du dernier bilan : ces PDF ne comptent pas comme du travail nouveau. */
  let lastFailures: readonly string[] = [];
  const persistent = (path: string): boolean => lastFailures.some((line) => line.startsWith(`${path} : `));
  const listeners = new Set<() => void>();

  const set = (next: IndexActivitySnapshot): void => {
    if (
      next.phase === snapshot.phase &&
      next.done === snapshot.done &&
      next.total === snapshot.total &&
      next.failed === snapshot.failed &&
      next.incomplete === snapshot.incomplete &&
      next.discovery === snapshot.discovery
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        deps.onWarn?.("Écouteur d'activité d'indexation en échec", error);
      }
    }
  };

  const running = (): void => {
    let progress: { done: number; total: number } | null = null;
    try {
      progress = deps.getProgress?.() ?? null;
    } catch (error) {
      deps.onWarn?.("Progression de l'indexation indisponible", error);
    }
    worked = true;
    set({ phase: "running", done: progress?.done ?? 0, total: progress?.total ?? 0, failed: 0, incomplete: 0, discovery: false });
  };

  const unsubscribe = deps.indexer.onEvent((event) => {
    switch (event.type) {
      case "started":
        worked = false;
        return;
      case "progress":
        if (!persistent(event.path)) running();
        return;
      case "indexed":
      case "removed":
      case "skipped-scanned":
        running();
        return;
      case "failed":
        return;
      case "idle": {
        const { failed, incomplete, cancelled } = event.summary;
        const didWork = worked;
        worked = false;
        if (!cancelled) lastFailures = event.summary.failures ?? [];
        if (failed > 0) {
          const discovery = (event.summary.failures ?? []).some(
            (line) => line.startsWith(`${DISCOVERY_FAILURE_PATH} : `) || line.startsWith(`${MANIFEST_FILE_NAME} : `),
          );
          set({ phase: "failed", done: 0, total: 0, failed, incomplete: 0, discovery });
        } else if (incomplete > 0 && !cancelled) {
          set({ phase: "partial", done: 0, total: 0, failed: 0, incomplete, discovery: false });
        } else if (didWork && !cancelled) set({ ...IDLE, phase: "done" });
        else set(IDLE);
        return;
      }
    }
  });

  let disposed = false;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
