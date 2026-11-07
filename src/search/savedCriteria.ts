/**
 * Critères de recherche enregistrés (comme la recherche native de SiYuan) : nom, requête, filtres (dossier OU portée de
 * documents, enfants, nom, pages, date), tri et regroupement. Module pur, sans DOM : tout ce qui vient de `settings.json` est
 * validé ici, un critère invalide est ignoré avec un avertissement précis (jamais en silence).
 *
 * Les clés des objets produits sont dans un ordre fixe : `JSON.stringify` est stable, ce qui permet de comparer des réglages.
 */
import { normalizedScope } from "./docScope";
import { isProposedSort, isRecord, normalizeSearchOptions, sameOptions, sortFromValue, type ResultFilters, type SortSpec } from "./resultOptions";
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

export type ParseResult = { readonly ok: true; readonly value: SavedCriteria } | { readonly ok: false; readonly reason: string };
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
  // Une portée présente mais invalide (identifiant ou chemin refusés) rejette le critère : la retirer élargirait la recherche en silence.
  if (filters["scope"] !== undefined && normalizedScope(filters["scope"]) === undefined) return fail("portée de documents invalide");
  const parsedSort =
    isRecord(sort) && typeof sort["key"] === "string" && typeof sort["direction"] === "string"
      ? sortFromValue(`${sort["key"]}:${sort["direction"]}`)
      : undefined;
  if (!parsedSort) return fail("tri inconnu");
  if (typeof groupByDocument !== "boolean") return fail("regroupement illisible");
  return { ok: true, value: canonical(name.name, trimmed, filters as unknown as ResultFilters, parsedSort, groupByDocument) };
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
export function normalizeCriteriaList(raw: unknown): { list: SavedCriteria[]; warnings: string[]; ignored: number } {
  if (raw === undefined) return { list: [], warnings: [], ignored: 0 };
  if (!Array.isArray(raw)) return { list: [], warnings: ["Critères enregistrés illisibles : la liste est ignorée"], ignored: 1 };
  const list: SavedCriteria[] = [];
  const warnings: string[] = [];
  let ignored = 0;
  const seen = new Set<string>();
  const skip = (rank: number, item: unknown, reason: string): void => {
    ignored += 1;
    if (warnings.length < MAX_CRITERIA_WARNINGS) warnings.push(`Critère n°${rank}${labelOf(item)} ignoré : ${reason}`);
  };
  raw.forEach((item: unknown, index) => {
    const rank = index + 1;
    const parsed = parseSavedCriteria(item);
    if (!parsed.ok) return skip(rank, item, parsed.reason);
    const key = criteriaNameKey(parsed.value.name);
    if (seen.has(key)) return skip(rank, item, "un critère de même nom existe déjà (doublon)");
    if (list.length >= MAX_CRITERIA) return skip(rank, item, `plus de ${MAX_CRITERIA} critères`);
    seen.add(key);
    list.push(parsed.value);
  });
  if (ignored > MAX_CRITERIA_WARNINGS) {
    const more = ignored - MAX_CRITERIA_WARNINGS;
    warnings.push(`… et ${more} ${more === 1 ? "autre critère ignoré" : "autres critères ignorés"}`);
  }
  return { list, warnings, ignored };
}

export type UpsertResult =
  | { readonly list: SavedCriteria[]; readonly replaced: boolean }
  | { readonly error: "limit" | "empty" | "tooLong" | "query" | "sort" };

/** Résultat d'un enregistrement : critère ajouté ou remplacé, ou refus (sans écriture). */
export type SaveCriteriaResult = { readonly replaced: boolean } | Extract<UpsertResult, { error: string }>;

/**
 * Ajoute un critère, ou remplace celui de même nom (insensible casse/accents/NFC, position gardée). Remplacer reste possible à
 * `MAX_CRITERIA` ; ajouter est refusé (`limit`). La liste d'entrée n'est pas modifiée.
 */
export function upsertCriteria(list: readonly SavedCriteria[], criteria: SavedCriteria): UpsertResult {
  const name = checkName(criteria.name);
  if ("error" in name) return name;
  const query = criteria.query.trim();
  if (length(query) > MAX_CRITERIA_QUERY) return { error: "query" };
  if (!isProposedSort(criteria.sort)) return { error: "sort" };
  const next = canonical(name.name, query, criteria.filters, criteria.sort, criteria.groupByDocument);
  const key = criteriaNameKey(next.name);
  const at = list.findIndex((c) => criteriaNameKey(c.name) === key);
  if (at >= 0) return { list: list.map((c, i) => (i === at ? next : c)), replaced: true };
  if (list.length >= MAX_CRITERIA) return { error: "limit" };
  return { list: [...list, next], replaced: false };
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
