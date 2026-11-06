import { normalizeHistory } from "./search/searchHistory";
import { DEFAULT_SORT, isRecord, sortFromValue, type SortSpec } from "./search/resultOptions";

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
  /** Tri des résultats (parmi les tris proposés par le sélecteur). Les filtres ne sont jamais mémorisés. */
  readonly sort: SortSpec;
  /** Résultats regroupés par document (vrai) ou liste plate de pages. */
  readonly groupByDocument: boolean;
  /** Requêtes soumises, la plus récente en tête (20 au plus). */
  readonly history: readonly string[];
}

export const DEFAULT_SETTINGS: DocSeekerSettings = {
  autoIndex: true,
  intervalMinutes: 5,
  sort: DEFAULT_SORT,
  groupByDocument: true,
  history: [],
};

type Warn = (message: string, error?: unknown) => void;

/** Réglages validés ; `raw` absent (premier lancement) donne les défauts sans avertissement. */
export function normalizeSettings(raw: unknown, onWarn: Warn): DocSeekerSettings {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SETTINGS;
  if (!isRecord(raw) || Array.isArray(raw)) {
    onWarn("Réglages illisibles : valeurs par défaut utilisées (indexation automatique activée, vérification toutes les 5 minutes)");
    return DEFAULT_SETTINGS;
  }
  const { autoIndex, intervalMinutes, sort, groupByDocument, history } = raw;
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
  let nextSort = DEFAULT_SETTINGS.sort;
  if (sort !== undefined) {
    // Forme texte « clé:sens » ou objet { key, direction } ; seuls les tris proposés par le sélecteur sont valides.
    const parsed = sortFromValue(
      typeof sort === "string"
        ? sort
        : isRecord(sort) && typeof sort["key"] === "string" && typeof sort["direction"] === "string"
          ? `${sort["key"]}:${sort["direction"]}`
          : undefined,
    );
    if (parsed) nextSort = parsed;
    else onWarn("Réglage « tri des résultats » invalide : défaut utilisé (pertinence)");
  }
  let nextGroup = DEFAULT_SETTINGS.groupByDocument;
  if (groupByDocument !== undefined) {
    if (typeof groupByDocument === "boolean") nextGroup = groupByDocument;
    else onWarn("Réglage « regrouper par document » invalide : défaut utilisé (activé)");
  }
  // Champ absent (ancien fichier) : liste vide sans avertissement ; sinon toute correction est signalée.
  const nextHistory = normalizeHistory(history);
  if (!nextHistory.valid) onWarn("Réglage « historique des requêtes » invalide ou corrigé : entrées valides conservées");
  return {
    autoIndex: nextAuto,
    intervalMinutes: nextInterval,
    sort: nextSort,
    groupByDocument: nextGroup,
    history: nextHistory.history,
  };
}

export interface SettingsDeps {
  readonly load: () => Promise<unknown>;
  readonly save: (value: DocSeekerSettings) => Promise<unknown>;
  readonly onWarn: Warn;
}

export interface SettingsStore {
  get(): DocSeekerSettings;
  /** Lit le fichier UNE fois (appels suivants : même promesse) ; ne rejette jamais (échec : défauts + avertissement). */
  load(): Promise<DocSeekerSettings>;
  /** Résolue quand le fichier est lu (lance le chargement au besoin). Avant, `get()` renvoie les défauts. */
  readonly ready: Promise<void>;
  /** Attend `ready` s'il n'est pas résolu (jamais d'écriture des défauts par-dessus le fichier), puis applique et notifie, puis enregistre ; rejette si l'enregistrement échoue (valeur gardée en mémoire). */
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

  let loading: Promise<DocSeekerSettings> | undefined;
  let loaded = false;

  const doLoad = async (): Promise<DocSeekerSettings> => {
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
    // Aucun update() n'a pu s'appliquer avant `loaded` : les compteurs repartent de zéro sans rien écraser.
    version = savedVersion = 0;
    loaded = true;
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
  };
  const load = (): Promise<DocSeekerSettings> => (loading ??= doLoad());
  let readyPromise: Promise<void> | undefined;

  const apply = async (patch: Partial<DocSeekerSettings>): Promise<void> => {
    const next = normalizeSettings({ ...current, ...patch }, deps.onWarn);
    // Objet normalisé complet (clés dans un ordre fixe) : un champ ajouté plus tard est comparé sans autre changement.
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (!changed && savedVersion === version) return;
    if (changed) {
      current = next;
      version += 1;
      notify();
    }
    await persist(); // si le précédent enregistrement a échoué, cette modification (même identique) le retente
  };

  return {
    get: () => current,
    load,
    get ready() {
      return (readyPromise ??= load().then(() => undefined));
    },
    update(patch) {
      // Chargé : application immédiate (synchrone). Sinon on attend le fichier, puis on fusionne dans l'ordre d'appel.
      return loaded ? apply(patch) : load().then(() => apply(patch));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
