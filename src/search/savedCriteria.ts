/**
 * Critères de recherche enregistrés (comme la recherche native de SiYuan) : nom, requête, filtres (portée de
 * documents, enfants, nom, pages, date), tri et regroupement. Module pur, sans DOM : tout ce qui vient de `settings.json` est
 * validé ici, un critère invalide est ignoré avec un avertissement précis (jamais en silence).
 *
 * Les clés des objets produits sont dans un ordre fixe : `JSON.stringify` est stable, ce qui permet de comparer des réglages.
 */
import { readScopes } from "./docScope";
import { isProposedSort, legacyFolderOf, isRecord, normalizeSearchOptions, sameOptions, sortFromValue, type ResultFilters, type SortSpec } from "./resultOptions";
import { HISTORY_QUERY_MAX_LENGTH } from "./searchHistory";

export const MAX_CRITERIA = 30;
export const MAX_CRITERIA_NAME = 80;
/** Même plafond que l'historique des requêtes. */
export const MAX_CRITERIA_QUERY = HISTORY_QUERY_MAX_LENGTH;

export interface SavedCriteria {
  readonly name: string;
  /** Requête rognée, vide autorisée (critère à filtres seuls). */
  readonly query: string;
  readonly filters: ResultFilters;
  readonly sort: SortSpec;
  readonly groupByDocument: boolean;
}

/** État de recherche comparable à un critère (sans nom). */
export type CriteriaState = Omit<SavedCriteria, "name">;

/** Caractères de contrôle (\p{Cc}) et de format (\p{Cf} : bidi, largeur nulle...) : jamais dans un nom. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** Nom d'affichage : sans contrôle ni format, espaces internes réduits, rogné, NFC. */
export function cleanCriteriaName(name: string): string {
  return name.replace(INVISIBLE, "").replace(/\s+/gu, " ").trim().normalize("NFC");
}

/** Clé d'unicité : insensible à la casse, aux accents et à la forme Unicode (NFC/NFD). */
export function criteriaNameKey(name: string): string {
  return cleanCriteriaName(name).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().normalize("NFC");
}

const length = (text: string): number => Array.from(text).length;

type NameCheck = { readonly name: string } | { readonly error: "empty" | "tooLong" };
function checkName(raw: string): NameCheck {
  const name = cleanCriteriaName(raw);
  if (name === "") return { error: "empty" };
  if (length(name) > MAX_CRITERIA_NAME) return { error: "tooLong" };
  return { name };
}

/** Forme canonique d'un critère déjà vérifié (ordre de clés fixe, filtres et tri normalisés). */
function canonical(name: string, query: string, filters: ResultFilters, sort: SortSpec, groupByDocument: boolean): SavedCriteria {
  const options = normalizeSearchOptions({ sort, filters });
  return { name, query, filters: options.filters, sort: { key: options.sort.key, direction: options.sort.direction }, groupByDocument };
}

export type ParseResult =
  | {
      readonly ok: true;
      readonly value: SavedCriteria;
      /** Vrai si le critère portait l'ancien filtre par dossier d'assets (non vide), désormais ignoré. */
      readonly ignoredFolder?: true;
    }
  | { readonly ok: false; readonly reason: string };
const fail = (reason: string): ParseResult => ({ ok: false, reason });

/** Critère lu depuis un fichier non fiable. `reason` : phrase courte, sans donnée du fichier. */
export function parseSavedCriteria(raw: unknown): ParseResult {
  if (!isRecord(raw) || Array.isArray(raw)) return fail("ce n'est pas un objet");
  if (typeof raw["name"] !== "string") return fail("nom absent ou illisible");
  const name = checkName(raw["name"]);
  if ("error" in name) return fail(name.error === "empty" ? "nom vide" : `nom de plus de ${MAX_CRITERIA_NAME} caractères`);
  const { query } = raw;
  if (typeof query !== "string") return fail("requête illisible");
  const trimmed = query.trim();
  if (length(trimmed) > MAX_CRITERIA_QUERY) return fail(`requête de plus de ${MAX_CRITERIA_QUERY} caractères`);
  const { filters, sort, groupByDocument } = raw;
  if (!isRecord(filters) || Array.isArray(filters)) return fail("filtres absents ou illisibles");
  // Une liste de portées présente mais invalide (une portée refusée, 0 ou plus de 20, doublon) rejette le critère : la retirer
  // élargirait la recherche en silence. L'ancien `scope` singulier est lu comme une liste d'un élément.
  if (readScopes(filters).invalid !== undefined) return fail("portée de documents invalide");
  const parsedSort =
    isRecord(sort) && typeof sort["key"] === "string" && typeof sort["direction"] === "string"
      ? sortFromValue(`${sort["key"]}:${sort["direction"]}`)
      : undefined;
  if (!parsedSort) return fail("tri inconnu");
  if (typeof groupByDocument !== "boolean") return fail("regroupement illisible");
  const value = canonical(name.name, trimmed, filters as unknown as ResultFilters, parsedSort, groupByDocument);
  return legacyFolderOf(filters) !== undefined ? { ok: true, value, ignoredFolder: true } : { ok: true, value };
}

/** Courte étiquette sûre d'un nom lu (pour le journal) : nettoyée et bornée. */
const labelOf = (raw: unknown): string => {
  if (!isRecord(raw) || typeof raw["name"] !== "string") return "";
  const clean = cleanCriteriaName(raw["name"]);
  return clean === "" ? "" : ` « ${Array.from(clean).slice(0, 40).join("")} »`;
};

/** Au-delà, les critères ignorés ne sont plus signalés un par un (un fichier hostile ne doit pas inonder le journal). */
export const MAX_CRITERIA_WARNINGS = 10;

/**
 * Liste lue depuis un fichier non fiable : absente (ancien fichier) = vide sans avertissement ; chaque critère invalide, doublon
 * ou au-delà de `MAX_CRITERIA` est ignoré. Au plus `MAX_CRITERIA_WARNINGS` avertissements précis, puis une seule ligne de
 * synthèse ; `ignored` compte tous les critères ignorés.
 */
export function normalizeCriteriaList(raw: unknown): {
  list: SavedCriteria[];
  warnings: string[];
  ignored: number;
  /** Entrées brutes que cette version ne comprend pas (illisibles), telles quelles : à recopier à l'écriture, jamais à afficher. */
  unrecognized: unknown[];
} {
  if (raw === undefined) return { list: [], warnings: [], ignored: 0, unrecognized: [] };
  if (!Array.isArray(raw)) return { list: [], warnings: ["Critères enregistrés illisibles : la liste est ignorée"], ignored: 1, unrecognized: [] };
  const list: SavedCriteria[] = [];
  const warnings: string[] = [];
  const unrecognized: unknown[] = [];
  let ignored = 0;
  let legacyFolders = 0;
  const seen = new Set<string>();
  const skip = (rank: number, item: unknown, reason: string): void => {
    ignored += 1;
    if (warnings.length < MAX_CRITERIA_WARNINGS) warnings.push(`Critère n°${rank}${labelOf(item)} ignoré : ${reason}`);
  };
  raw.forEach((item: unknown, index) => {
    const rank = index + 1;
    const parsed = parseSavedCriteria(item);
    if (!parsed.ok) {
      unrecognized.push(item);
      return skip(rank, item, parsed.reason);
    }
    const key = criteriaNameKey(parsed.value.name);
    if (seen.has(key)) return skip(rank, item, "un critère de même nom existe déjà (doublon)");
    if (list.length >= MAX_CRITERIA) return skip(rank, item, `plus de ${MAX_CRITERIA} critères`);
    seen.add(key);
    list.push(parsed.value);
    if (parsed.ignoredFolder) legacyFolders += 1;
  });
  if (ignored > MAX_CRITERIA_WARNINGS) {
    const more = ignored - MAX_CRITERIA_WARNINGS;
    warnings.push(`… et ${more} ${more === 1 ? "autre critère ignoré" : "autres critères ignorés"}`);
  }
  // Une seule ligne pour tous les critères concernés : le filtre par dossier d'assets n'existe plus, le chemin est une portée de documents.
  if (legacyFolders > 0) {
    warnings.push(
      `${legacyFolders} ${legacyFolders === 1 ? "critère enregistré portait" : "critères enregistrés portaient"} un filtre par dossier, désormais ignoré`,
    );
  }
  return { list, warnings, ignored, unrecognized };
}

export type UpsertResult =
  | { readonly list: SavedCriteria[]; readonly replaced: boolean }
  | { readonly error: "limit" | "empty" | "tooLong" | "query" | "sort" };

/** Résultat d'un enregistrement : critère ajouté ou remplacé, ou refus (sans écriture). */
export type SaveCriteriaResult = { readonly replaced: boolean } | Extract<UpsertResult, { error: string }>;

/**
 * Enregistre un critère comme la recherche native : les critères de même nom, et ceux de `removeNames` (renommage, fusion), sont
 * retirés (insensible casse/accents/NFC), puis le nouveau est ajouté EN FIN. Remplacer reste possible à `MAX_CRITERIA` (une place
 * se libère) ; ajouter est refusé (`limit`). `replaced` : un critère de même nom existait. La liste d'entrée n'est pas modifiée.
 */
export function upsertCriteria(list: readonly SavedCriteria[], criteria: SavedCriteria, removeNames: readonly string[] = []): UpsertResult {
  const name = checkName(criteria.name);
  if ("error" in name) return name;
  const query = criteria.query.trim();
  if (length(query) > MAX_CRITERIA_QUERY) return { error: "query" };
  if (!isProposedSort(criteria.sort)) return { error: "sort" };
  const next = canonical(name.name, query, criteria.filters, criteria.sort, criteria.groupByDocument);
  const key = criteriaNameKey(next.name);
  const dropped = new Set([key, ...removeNames.map(criteriaNameKey)]);
  const kept = list.filter((c) => !dropped.has(criteriaNameKey(c.name)));
  if (kept.length >= MAX_CRITERIA) return { error: "limit" };
  return { list: [...kept, next], replaced: list.some((c) => criteriaNameKey(c.name) === key) };
}

/** Ce que « Enregistrer les critères de requête » doit faire d'un nom saisi (mêmes cas que la recherche native de SiYuan). */
export type CriteriaSavePlan =
  | { readonly kind: "empty" | "tooLong" | "query" | "limit" | "noop" }
  /** Aucun critère de même nom ni de même configuration : enregistrement direct. */
  | { readonly kind: "save"; readonly name: string; readonly removeNames: readonly string[] }
  /** Un critère de même nom, configuration différente : confirmation « écraser ». */
  | { readonly kind: "overwrite"; readonly name: string; readonly removeNames: readonly string[] }
  /** Même configuration sous un autre nom (`from`) : confirmation « mettre à jour le nom de `from` en `name` ». */
  | { readonly kind: "rename" | "merge"; readonly name: string; readonly from: string; readonly removeNames: readonly string[] };

/**
 * Décision de la recherche native (`saveCriterion`) : la configuration comprend requête, filtres (chemin compris, comme `idPath`
 * du natif), tri et regroupement. Plusieurs critères de même configuration : le dernier compte (comme la boucle native).
 * `merge` : le nom saisi existe sur un critère ET la configuration sur un autre, qui est supprimé. Sans E/S ni DOM.
 */
export function planCriteriaSave(list: readonly SavedCriteria[], rawName: string, state: CriteriaState): CriteriaSavePlan {
  const name = checkName(rawName);
  if ("error" in name) return { kind: name.error };
  if (length(state.query.trim()) > MAX_CRITERIA_QUERY) return { kind: "query" };
  const key = criteriaNameKey(name.name);
  const byName = list.findIndex((c) => criteriaNameKey(c.name) === key);
  let byConfig = -1;
  list.forEach((c, i) => {
    if (sameCriteria(c, state)) byConfig = i;
  });
  const fresh = name.name;
  if (byName >= 0 && byConfig < 0) return { kind: "overwrite", name: fresh, removeNames: [] };
  if (byName < 0 && byConfig < 0) return list.length >= MAX_CRITERIA ? { kind: "limit" } : { kind: "save", name: fresh, removeNames: [] };
  const from = (list[byConfig] as SavedCriteria).name;
  if (byName === byConfig) return from === fresh ? { kind: "noop" } : { kind: "rename", name: fresh, from, removeNames: [from] };
  if (byName < 0) return { kind: "rename", name: fresh, from, removeNames: [from] };
  return { kind: "merge", name: fresh, from, removeNames: [from] };
}

/** Retire le critère de ce nom (même règle d'unicité) ; liste inchangée si absent. */
export function removeCriteria(list: readonly SavedCriteria[], name: string): SavedCriteria[] {
  const key = criteriaNameKey(name);
  return list.filter((c) => criteriaNameKey(c.name) !== key);
}

/** L'état courant de la recherche est-il exactement celui du critère ? (requête rognée, filtres, tri, regroupement) */
export function sameCriteria(criteria: CriteriaState, current: CriteriaState): boolean {
  const a = normalizeSearchOptions({ sort: criteria.sort, filters: criteria.filters });
  const b = normalizeSearchOptions({ sort: current.sort, filters: current.filters });
  return criteria.query.trim() === current.query.trim() && sameOptions(a, b) && criteria.groupByDocument === current.groupByDocument;
}
