/**
 * Réglages persistés du plugin (indexation automatique). Module pur : le chargement et l'enregistrement
 * (`loadData` / `saveData` du plugin, fichier `settings.json` à part du dossier `idx/`) sont injectés.
 * Toute valeur inconnue ou corrompue retombe sur le défaut du champ et est journalisée.
 */
export const SETTINGS_FILE = "settings.json";
export const FREQUENCY_MINUTES = [5, 15, 60] as const;

export interface DocSeekerSettings {
  readonly autoIndex: boolean;
  readonly intervalMinutes: number;
}

export const DEFAULT_SETTINGS: DocSeekerSettings = { autoIndex: true, intervalMinutes: 5 };

type Warn = (message: string, error?: unknown) => void;

/** Réglages validés ; `raw` absent (premier lancement) donne les défauts sans avertissement. */
export function normalizeSettings(raw: unknown, onWarn: Warn): DocSeekerSettings {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SETTINGS;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    onWarn("Réglages illisibles : valeurs par défaut utilisées (indexation automatique activée, vérification toutes les 5 minutes)");
    return DEFAULT_SETTINGS;
  }
  const { autoIndex, intervalMinutes } = raw as Record<string, unknown>;
  let nextAuto = DEFAULT_SETTINGS.autoIndex;
  if (autoIndex !== undefined) {
    if (typeof autoIndex === "boolean") nextAuto = autoIndex;
    else onWarn("Réglage « indexation automatique » invalide : défaut utilisé (activée)");
  }
  let nextInterval = DEFAULT_SETTINGS.intervalMinutes;
  if (intervalMinutes !== undefined) {
    if (typeof intervalMinutes === "number" && (FREQUENCY_MINUTES as readonly number[]).includes(intervalMinutes)) {
      nextInterval = intervalMinutes;
    } else {
      onWarn("Réglage « fréquence de vérification » invalide : défaut utilisé (5 minutes)");
    }
  }
  return { autoIndex: nextAuto, intervalMinutes: nextInterval };
}

export interface SettingsDeps {
  readonly load: () => Promise<unknown>;
  readonly save: (value: DocSeekerSettings) => Promise<unknown>;
  readonly onWarn: Warn;
}

export interface SettingsStore {
  get(): DocSeekerSettings;
  /** Lit le fichier ; ne rejette jamais (échec : défauts + avertissement). */
  load(): Promise<DocSeekerSettings>;
  /** Applique et notifie tout de suite, puis enregistre ; rejette si l'enregistrement échoue (valeur gardée en mémoire). */
  update(patch: Partial<DocSeekerSettings>): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createSettings(deps: SettingsDeps): SettingsStore {
  let current = DEFAULT_SETTINGS;
  const listeners = new Set<() => void>();
  /** `version` croît à chaque changement de valeur ; `savedVersion` est la dernière version enregistrée. */
  let version = 0;
  let savedVersion = 0;
  let chain: Promise<void> = Promise.resolve();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        deps.onWarn("Écouteur de réglages en échec", error);
      }
    }
  };

  /** File d'enregistrements : un seul à la fois, toujours la valeur la plus récente, rien si déjà enregistrée. */
  const persist = (): Promise<void> => {
    const task = chain.then(async () => {
      if (savedVersion === version) return;
      const target = version;
      await deps.save(current);
      savedVersion = Math.max(savedVersion, target);
    });
    chain = task.catch(() => undefined);
    return task;
  };

  return {
    get: () => current,
    async load() {
      let warned = false;
      const warn: Warn = (message, error) => {
        warned = true;
        deps.onWarn(message, error);
      };
      try {
        current = normalizeSettings(await deps.load(), warn);
      } catch (error) {
        warn("Lecture des réglages en échec : valeurs par défaut utilisées", error);
        current = DEFAULT_SETTINGS;
      }
      version = savedVersion = 0;
      notify();
      if (warned) {
        // Fichier corrompu : on le réécrit avec les valeurs valides pour que l'avertissement ne revienne pas.
        version = 1;
        try {
          await persist();
        } catch (error) {
          deps.onWarn("Réécriture des réglages corrigés en échec", error);
        }
      }
      return current;
    },
    async update(patch) {
      const next = normalizeSettings({ ...current, ...patch }, deps.onWarn);
      const changed = next.autoIndex !== current.autoIndex || next.intervalMinutes !== current.intervalMinutes;
      if (!changed && savedVersion === version) return;
      if (changed) {
        current = next;
        version += 1;
        notify();
      }
      await persist(); // si le précédent enregistrement a échoué, cette modification (même identique) le retente
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
