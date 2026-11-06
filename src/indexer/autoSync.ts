/**
 * Planificateur de l'indexation automatique. Module pur : minuteurs, source d'événement « fenêtre
 * refocalisée », horloge et synchronisation sont injectés (aucun window/document).
 *
 * Déclencheurs : première synchronisation après `firstDelayMs`, retour du focus (au moins
 * `minFocusGapMs` après la fin de la précédente), périodique (`intervalMinutes`, compté depuis la fin de la
 * précédente). Jamais deux synchronisations simultanées ; rien si désactivé ou après `dispose`.
 * Si `isBusy()` (vidage en cours, saisie récente…), on ne lance rien et on retente après `busyRetryMs`.
 * Une erreur ou des échecs d'indexation sont journalisés (`onWarn`) sans arrêter la boucle ; un résultat
 * identique à celui de la passe précédente n'est pas journalisé de nouveau (un PDF défaillant est retenté à
 * chaque passe, le journal ne doit pas se remplir).
 */
export const FIRST_SYNC_DELAY_MS = 3000;
export const MIN_FOCUS_GAP_MS = 30_000;
export const BUSY_RETRY_MS = 10_000;
const MINUTE_MS = 60_000;
/** Un résultat identique est rejournalisé toutes les N passes, pour ne pas être évincé du journal borné. */
export const REPEAT_LOG_EVERY = 12;

export interface AutoSyncResult {
  readonly failed: number;
  /** « chemin : message » de chaque échec de la passe (bilan de l'indexeur). */
  readonly failures?: readonly string[];
  /** Passe annulée : elle ne dit rien de l'état des échecs (la signature du journal est conservée). */
  readonly cancelled?: boolean;
  /** Éléments que le parcours n'a pas pu lire, et leurs chemins. */
  readonly incomplete?: number;
  readonly incompleteDetails?: readonly string[];
}

export interface AutoSyncConfig {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

export interface AutoSyncDeps {
  /** Une passe d'indexation ; peut rejeter. */
  readonly sync: () => Promise<AutoSyncResult | void>;
  /** Exécuté une fois avant la première synchronisation (même si la synchronisation est désactivée). */
  readonly prepare?: () => Promise<unknown>;
  readonly isBusy?: () => boolean;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** S'abonne au retour du focus de la fenêtre ; renvoie le désabonnement. */
  readonly onFocus: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly onWarn: (message: string, error?: unknown) => void;
  readonly firstDelayMs?: number;
  readonly minFocusGapMs?: number;
  readonly busyRetryMs?: number;
}

export interface AutoSync {
  start(config: AutoSyncConfig): void;
  configure(config: AutoSyncConfig): void;
  /**
   * Synchronise tout de suite (ex. après « Vider l'index »), sans intervalle minimal. Vrai seulement si une
   * passe démarre ou si la première synchronisation (déjà planifiée) va avoir lieu ; faux sinon.
   */
  triggerNow(): boolean;
  dispose(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function createAutoSync(deps: AutoSyncDeps): AutoSync {
  const firstDelay = deps.firstDelayMs ?? FIRST_SYNC_DELAY_MS;
  const minFocusGap = deps.minFocusGapMs ?? MIN_FOCUS_GAP_MS;
  const busyRetry = deps.busyRetryMs ?? BUSY_RETRY_MS;

  let config: AutoSyncConfig = { enabled: false, intervalMinutes: 5 };
  let started = false;
  let booted = false;
  let running = false;
  let disposed = false;
  let timer: unknown;
  let hasTimer = false;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let lastSignature: string | undefined;
  let sameCount = 0;
  let busyWarned = false;
  let unsubscribeFocus: (() => void) | undefined;

  /** Journalise sans jamais lever : un journal défaillant ne doit pas arrêter la boucle. */
  const warn = (message: string, error?: unknown): void => {
    try {
      deps.onWarn(message, error);
    } catch {
      // dernier recours : rien de plus à faire si le journal lui-même est en panne
    }
  };
  const safeNow = (fallback: number): number => {
    try {
      return deps.now();
    } catch (error) {
      warn("Horloge de l'indexation automatique en échec", error);
      return fallback;
    }
  };

  const clearTimer = (): void => {
    if (!hasTimer) return;
    hasTimer = false;
    try {
      deps.clearTimer(timer);
    } catch (error) {
      warn("Annulation du minuteur d'indexation automatique en échec", error);
    }
  };
  /** Arme un minuteur ; faux (et journalisé) si le minuteur n'a pas pu être créé. */
  const arm = (ms: number, fn: () => void): boolean => {
    clearTimer();
    if (disposed || running) return true;
    try {
      timer = deps.setTimer(() => {
        hasTimer = false;
        fn();
      }, ms);
      hasTimer = true;
      return true;
    } catch (error) {
      warn("Minuteur d'indexation automatique impossible", error);
      return false;
    }
  };
  const armPeriodic = (): void => {
    if (booted && config.enabled) arm(config.intervalMinutes * MINUTE_MS, attempt);
  };

  const busy = (): boolean => {
    try {
      const value = deps.isBusy?.() ?? false;
      busyWarned = false;
      return value;
    } catch (error) {
      if (!busyWarned) warn("Contrôle d'occupation de l'indexation automatique en échec", error);
      busyWarned = true;
      return false; // détecteur en panne : on n'empêche pas l'indexation
    }
  };

  /** Journalise un résultat ; identique au précédent, il n'est répété que toutes les REPEAT_LOG_EVERY passes. */
  const logOnce = (signature: string, lines: readonly { message: string; error?: unknown }[]): void => {
    if (signature === lastSignature && ++sameCount < REPEAT_LOG_EVERY) return;
    lastSignature = signature;
    sameCount = 0;
    for (const line of lines) warn(line.message, line.error);
  };

  function report(result: AutoSyncResult | void): void {
    if (!result) {
      lastSignature = undefined;
      return;
    }
    if (result.cancelled) return; // une passe annulée ne dit rien : on garde la signature
    const lines: { message: string }[] = [];
    if (result.failed > 0) {
      lines.push({ message: `Indexation automatique : ${result.failed} PDF en échec` });
      for (const detail of result.failures ?? []) lines.push({ message: detail });
    }
    const incomplete = result.incomplete ?? 0;
    if (incomplete > 0) {
      lines.push({
        message: `Indexation automatique incomplète : ${plural(incomplete, "élément non parcouru", "éléments non parcourus")} (détails dans le journal)`,
      });
      for (const detail of result.incompleteDetails ?? []) lines.push({ message: detail });
    }
    if (lines.length === 0) {
      lastSignature = undefined;
      return;
    }
    logOnce(`result:${lines.map((l) => l.message).join("\n")}`, lines);
  }

  async function execute(): Promise<void> {
    clearTimer();
    running = true;
    try {
      let result: AutoSyncResult | void;
      try {
        result = await deps.sync();
      } catch (error) {
        logOnce(`error:${messageOf(error)}`, [{ message: "Indexation automatique en échec", error }]);
        return;
      }
      report(result);
    } catch (error) {
      warn("Compte rendu de l'indexation automatique en échec", error);
    } finally {
      running = false;
      lastEnd = safeNow(Number.NEGATIVE_INFINITY);
      armPeriodic(); // toujours : la boucle ne s'arrête jamais
    }
  }

  /** Lance une passe sans jamais laisser remonter une exception. */
  const launch = (): void => {
    execute().catch((error: unknown) => warn("Indexation automatique en échec", error));
  };

  /** Minuteur échu (ou démarrage) : lance si possible, sinon retente bientôt. */
  function attempt(): void {
    if (disposed || !config.enabled || !booted || running) return;
    if (busy()) {
      arm(busyRetry, attempt);
      return;
    }
    launch();
  }

  const onFocus = (): void => {
    if (disposed || !config.enabled || !booted || running) return;
    if (safeNow(Number.POSITIVE_INFINITY) - lastEnd < minFocusGap) return;
    if (busy()) return;
    launch();
  };

  async function boot(): Promise<void> {
    try {
      await deps.prepare?.();
    } catch (error) {
      warn("Nettoyage des fichiers temporaires au démarrage en échec", error);
    }
    if (disposed) return;
    booted = true;
    attempt();
  }

  return {
    start(initial) {
      if (disposed || started) return;
      config = initial;
      try {
        unsubscribeFocus = deps.onFocus(onFocus);
        if (!arm(firstDelay, () => void boot())) throw new Error("minuteur initial impossible");
        started = true;
      } catch (error) {
        warn("Démarrage de l'indexation automatique en échec", error);
        try {
          unsubscribeFocus?.();
        } catch (cleanupError) {
          warn("Retrait de l'écouteur de focus en échec", cleanupError);
        }
        unsubscribeFocus = undefined;
        clearTimer();
        started = false;
      }
    },
    configure(next) {
      const prev = config;
      config = next;
      if (disposed || !started) return;
      if (!next.enabled) {
        if (booted) clearTimer();
        return;
      }
      if (!booted || running) return;
      if (!prev.enabled) attempt();
      else if (prev.intervalMinutes !== next.intervalMinutes) armPeriodic();
    },
    triggerNow() {
      if (disposed || !started || !config.enabled || running) return false;
      if (!booted) return true; // la première synchronisation arrive : inutile d'en lancer une autre
      launch();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      try {
        unsubscribeFocus?.();
      } catch (error) {
        warn("Retrait de l'écouteur de focus en échec", error);
      }
      unsubscribeFocus = undefined;
    },
  };
}
