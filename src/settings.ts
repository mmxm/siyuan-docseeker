import { normalizeHistory } from "./search/searchHistory";
import { DEFAULT_SORT, isRecord, sortFromValue, type SortSpec } from "./search/resultOptions";
import { MAX_CRITERIA, normalizeCriteriaList, removeCriteria, upsertCriteria, type SaveCriteriaResult, type SavedCriteria } from "./search/savedCriteria";

/**
 * Réglages persistés du plugin (indexation automatique). Module pur : le chargement et l'enregistrement
 * (`loadData` / `saveData` du plugin, fichier `settings.json` à part du dossier `idx/`) sont injectés.
 * Toute valeur inconnue ou corrompue retombe sur le défaut du champ et est journalisée.
 */
export const SETTINGS_FILE = "settings.json";
export const FREQUENCY_MINUTES = [5, 15, 60] as const;
/** Où s'ouvre la recherche : dans un onglet, ou dans une fenêtre flottante comme la recherche native de SiYuan. */
export const OPEN_MODES = ["tab", "dialog"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];
const isOpenMode = (value: unknown): value is OpenMode => (OPEN_MODES as readonly unknown[]).includes(value);

export interface DocSeekerSettings {
  readonly autoIndex: boolean;
  readonly intervalMinutes: number;
  /** Tri des résultats (parmi les tris proposés par le sélecteur). Les filtres ne sont jamais mémorisés. */
  readonly sort: SortSpec;
  /** Résultats regroupés par document (vrai) ou liste plate de pages. */
  readonly groupByDocument: boolean;
  /** Requêtes soumises, la plus récente en tête (20 au plus). */
  readonly history: readonly string[];
  /** Ouverture de la recherche par l'icône de la barre et la commande « Rechercher dans les PDF ». */
  readonly openMode: OpenMode;
  /** Critères de recherche enregistrés (30 au plus, noms uniques) ; champ absent d'un ancien fichier : liste vide. */
  readonly savedCriteria: readonly SavedCriteria[];
}

export const DEFAULT_SETTINGS: DocSeekerSettings = {
  autoIndex: true,
  intervalMinutes: 5,
  sort: DEFAULT_SORT,
  groupByDocument: true,
  history: [],
  openMode: "tab",
  savedCriteria: [],
};

type Warn = (message: string, error?: unknown) => void;

/** Réglages validés ; `raw` absent (premier lancement) donne les défauts sans avertissement. */
export function normalizeSettings(
  raw: unknown,
  onWarn: Warn,
  onCriteriaIgnored?: (count: number) => void,
  /** Avertissements sur les critères ignorés ; par défaut `onWarn`. Séparés pour que l'appelant sache si SEULS des critères sont en cause. */
  onCriteriaWarn: Warn = onWarn,
): DocSeekerSettings {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SETTINGS;
  if (!isRecord(raw) || Array.isArray(raw)) {
    onWarn("Réglages illisibles : valeurs par défaut utilisées (indexation automatique activée, vérification toutes les 5 minutes)");
    return DEFAULT_SETTINGS;
  }
  const { autoIndex, intervalMinutes, sort, groupByDocument, history, openMode, savedCriteria } = raw;
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
  // Champ absent (ancien fichier) : onglet sans avertissement ; toute autre valeur que les deux modes est signalée.
  let nextOpenMode = DEFAULT_SETTINGS.openMode;
  if (openMode !== undefined) {
    if (isOpenMode(openMode)) nextOpenMode = openMode;
    else onWarn("Réglage « ouverture de la recherche » invalide : défaut utilisé (onglet)");
  }
  // Champ absent (ancien fichier) : liste vide sans avertissement ; chaque critère ignoré est signalé (précisément).
  const criteria = normalizeCriteriaList(savedCriteria);
  for (const warning of criteria.warnings) onCriteriaWarn(warning);
  if (criteria.ignored > 0) onCriteriaIgnored?.(criteria.ignored);
  return {
    autoIndex: nextAuto,
    intervalMinutes: nextInterval,
    sort: nextSort,
    groupByDocument: nextGroup,
    history: nextHistory.history,
    openMode: nextOpenMode,
    savedCriteria: criteria.list,
  };
}

/** `settings.json` n'est plus un objet à la relecture : on refuse d'écrire par-dessus (les critères qu'il contenait seraient perdus). */
export class SettingsFileUnreadableError extends Error {
  constructor() {
    super("settings.json illisible à la relecture : enregistrement annulé");
    this.name = "SettingsFileUnreadableError";
  }
}

export interface SettingsDeps {
  readonly load: () => Promise<unknown>;
  readonly save: (value: DocSeekerSettings) => Promise<unknown>;
  readonly onWarn: Warn;
  /** Appelé UNE fois, à la lecture initiale, si des critères enregistrés ont été ignorés (message visible, une fois par session). */
  readonly onCriteriaIgnored?: (count: number) => void;
  /**
   * Lecture seule (mobile) : `/data/storage/petal/<plugin>/` est synchronisé par SiYuan, toute écriture ferait des allers-retours de
   * synchronisation avec le bureau. Évalué à chaque écriture ; si vrai, les changements ne vivent qu'en mémoire (session) et `save` n'est jamais appelé.
   */
  readonly readOnly?: () => boolean;
}

export interface SettingsStore {
  get(): DocSeekerSettings;
  /** Lit le fichier UNE fois (appels suivants : même promesse) ; ne rejette jamais (échec : défauts + avertissement). */
  load(): Promise<DocSeekerSettings>;
  /** Résolue quand le fichier est lu (lance le chargement au besoin). Avant, `get()` renvoie les défauts. */
  readonly ready: Promise<void>;
  /** Attend `ready` s'il n'est pas résolu (jamais d'écriture des défauts par-dessus le fichier), puis applique et notifie, puis enregistre ; rejette si l'enregistrement échoue (valeur gardée en mémoire). Les critères enregistrés ne sont jamais écrasés : ils sont relus dans le fichier juste avant l'écriture (rejet si le fichier est illisible). */
  update(patch: Partial<DocSeekerSettings>): Promise<void>;
  subscribe(listener: () => void): () => void;
  /**
   * Enregistre un critère (remplace celui de même nom, retire aussi `removeNames` : renommage et fusion, en une seule écriture ; le
   * critère enregistré passe en fin de liste, comme dans la recherche native). RELIT le fichier et applique le changement à la liste lue, pour ne pas écraser
   * ce qu'une autre fenêtre y a écrit ; opérations sérialisées avec les autres écritures. Refus (`error`) sans écriture ; rejette si
   * la relecture ou l'écriture échoue (en cas d'échec d'écriture, la liste en mémoire est restaurée et les écouteurs notifiés).
   */
  saveCriteria(criteria: SavedCriteria, removeNames?: readonly string[]): Promise<SaveCriteriaResult>;
  /** Retire un critère (relecture et fusion comme `saveCriteria`) ; vrai s'il existait. */
  deleteCriteria(name: string): Promise<boolean>;
}

export function createSettings(deps: SettingsDeps): SettingsStore {
  let current = DEFAULT_SETTINGS;
  const listeners = new Set<() => void>();
  /** `version` croît à chaque changement de valeur ; `savedVersion` est la dernière version enregistrée. */
  let version = 0;
  let savedVersion = 0;
  let chain: Promise<void> = Promise.resolve();
  /**
   * Entrées de critères du fichier que cette version ne comprend pas (autre version du plugin, entrée corrompue), copiées TELLES
   * QUELLES (30 au plus) après les critères valides à chaque écriture : elles ne sont jamais affichées, jamais comptées dans la limite
   * des 30 critères et jamais perdues. Mises à jour à chaque lecture du fichier (initiale ou relecture avant écriture).
   */
  let unrecognized: readonly unknown[] = [];
  const keepUnrecognized = (raw: readonly unknown[]): void => {
    unrecognized = raw.slice(0, MAX_CRITERIA);
  };
  /** Valeur écrite sur disque : les réglages, plus les entrées de critères non reconnues après les critères valides. */
  const forDisk = (value: DocSeekerSettings): DocSeekerSettings =>
    unrecognized.length === 0 ? value : { ...value, savedCriteria: [...value.savedCriteria, ...unrecognized] as SavedCriteria[] };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        deps.onWarn("Écouteur de réglages en échec", error);
      }
    }
  };

  /** Critères du fichier tel qu'il est MAINTENANT (une autre fenêtre a pu y écrire) ; rejette si la lecture échoue ou si le fichier n'est pas un objet. */
  const readFileCriteria = async (): Promise<readonly SavedCriteria[]> => {
    const raw = await deps.load();
    if (raw === undefined || raw === null || raw === "") return [];
    if (!isRecord(raw) || Array.isArray(raw)) {
      const error = new SettingsFileUnreadableError();
      deps.onWarn("Réglages illisibles à la relecture : écriture annulée", error);
      throw error;
    }
    const { list, warnings, unrecognized: rejected } = normalizeCriteriaList(raw["savedCriteria"]);
    for (const warning of warnings) deps.onWarn(warning);
    keepUnrecognized(rejected);
    return list;
  };

  /**
   * File d'enregistrements : un seul à la fois, toujours la valeur la plus récente, rien si déjà enregistrée. Les critères
   * enregistrés sont relus dans le fichier juste avant l'écriture (`mergeCriteria`) : un autre réglage modifié dans cette fenêtre
   * n'efface pas un critère enregistré ou supprimé dans une autre.
   */
  const persist = (mergeCriteria = true): Promise<void> => {
    if (deps.readOnly?.()) {
      savedVersion = version; // rien à écrire : la valeur en mémoire fait foi pour la session
      return Promise.resolve();
    }
    const task = chain.then(async () => {
      if (savedVersion === version) return;
      const target = version;
      if (mergeCriteria) {
        const fresh = await readFileCriteria();
        if (JSON.stringify(fresh) !== JSON.stringify(current.savedCriteria)) {
          current = { ...current, savedCriteria: fresh };
          notify();
        }
      }
      await deps.save(forDisk(current));
      savedVersion = Math.max(savedVersion, target);
    });
    chain = task.catch(() => undefined);
    return task;
  };

  let loading: Promise<DocSeekerSettings> | undefined;
  let loaded = false;

  const doLoad = async (): Promise<DocSeekerSettings> => {
    // `warned` : un réglage (hors critères) était corrompu, le fichier sera réécrit corrigé. Des critères seuls ignorés ne
    // déclenchent PAS de réécriture : ceux qu'on n'a pas pu lire (autre version, corruption) restent sur disque.
    let warned = false;
    const warn: Warn = (message, error) => {
      warned = true;
      deps.onWarn(message, error);
    };
    try {
      const raw = await deps.load();
      if (isRecord(raw) && !Array.isArray(raw)) keepUnrecognized(normalizeCriteriaList(raw["savedCriteria"]).unrecognized);
      current = normalizeSettings(
        raw,
        warn,
        (count) => {
          try {
            deps.onCriteriaIgnored?.(count);
          } catch (error) {
            deps.onWarn("Message sur les critères ignorés impossible", error);
          }
        },
        deps.onWarn,
      );
    } catch (error) {
      // Lecture en échec (E/S passagère) : défauts en mémoire, mais rien n'est écrit tant qu'un réglage n'est pas modifié,
      // sinon le fichier (et ses critères) serait remplacé par les défauts.
      deps.onWarn("Lecture des réglages en échec : valeurs par défaut utilisées, fichier laissé intact", error);
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
        await persist(false); // le fichier vient d'être lu : pas de relecture
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

  /**
   * Lecture-modification-écriture des critères, dans la file des enregistrements. `change` renvoie la nouvelle liste (ou `undefined`
   * si rien ne change) et le résultat à rendre.
   */
  const mutateCriteria = <R>(change: (fresh: readonly SavedCriteria[]) => { next?: SavedCriteria[]; result: R }): Promise<R> => {
    const run = (): Promise<R> => {
      const task = chain.then(async () => {
        // Lecture seule : le fichier n'est jamais réécrit, donc la liste en mémoire est la référence (le fichier serait périmé).
        const out = change(deps.readOnly?.() ? current.savedCriteria : await readFileCriteria());
        if (out.next === undefined) return out.result;
        const previous = current.savedCriteria;
        current = { ...current, savedCriteria: out.next };
        version += 1;
        notify();
        const target = version;
        try {
          if (!deps.readOnly?.()) await deps.save(forDisk(current));
        } catch (error) {
          // Écriture échouée : la liste en mémoire doit rester celle du fichier (un critère supprimé ne doit pas disparaître du menu
          // pour revenir au redémarrage). Seule la clé des critères est restaurée : un autre réglage modifié entre-temps est gardé.
          current = { ...current, savedCriteria: previous };
          notify();
          throw error;
        }
        savedVersion = Math.max(savedVersion, target);
        return out.result;
      });
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };
    return loaded ? run() : load().then(run);
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
    saveCriteria: (criteria, removeNames = []) =>
      mutateCriteria<SaveCriteriaResult>((fresh) => {
        const out = upsertCriteria(fresh, criteria, removeNames);
        return "error" in out ? { result: out } : { next: out.list, result: { replaced: out.replaced } };
      }),
    deleteCriteria: (name) =>
      mutateCriteria((fresh) => {
        const next = removeCriteria(fresh, name);
        const existed = next.length !== fresh.length;
        return existed ? { next, result: true } : { result: false };
      }),
  };
}
