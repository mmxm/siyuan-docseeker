/**
 * Options de présentation des résultats : filtres (portée de documents, nom, pages, date) et tri. Module pur, sans DOM.
 *
 * - Les filtres s'appliquent après BM25 : ils ne restreignent pas la recherche, ils masquent des documents.
 * - Les filtres vivent en session seulement (jamais persistés) ; le tri est mémorisé par les réglages.
 * - Le tri (`sortDocs`) ne touche qu'à l'ordre des DOCUMENTS ; l'ordre des pages d'un document reste celui du classement.
 */
import { tokenize } from "../core/normalize";
import { readScopes, type DocumentScope } from "./docScope";
import type { DocInfo } from "./searchStore";

/**
 * - relevance : pertinence (BM25 puis re-classement) ; desc = ordre actuel, asc = son inverse.
 * - name / path : titre / chemin du PDF ; modified : date de modification du PDF.
 * - matches : nombre de pages CORRESPONDANTES du résultat (`matchingPages`), pas le nombre de pages du PDF.
 */
export type SortKey = "relevance" | "name" | "modified" | "path" | "matches";
export type SortDirection = "asc" | "desc";

export interface SortSpec {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

export interface ResultFilters {
  /** Faux : les documents choisis sans leurs sous-documents (cahiers entiers : toujours vrai). Sans effet sans `scopes`. */
  readonly includeSubfolders: boolean;
  /** Sous-chaîne du titre, comparée sans casse ni accents ; vide : pas de filtre. */
  readonly nameContains: string;
  readonly minPages?: number;
  readonly maxPages?: number;
  /** Date de modification du PDF minimale (incluse), en millisecondes. */
  readonly modifiedAfterMs?: number;
  /**
   * Portées de documents SiYuan (1 à 20, OU) : seuls les PDF cités par l'un de ces cahiers ou documents sont gardés.
   * `includeSubfolders` vaut alors « inclure les sous-documents ». L'ancien champ singulier `scope` et l'ancien filtre par
   * dossier d'assets `folder` ne sont lus qu'à la normalisation (le second est ignoré, avec une trace).
   */
  readonly scopes?: readonly DocumentScope[];
}

export interface SearchOptions {
  readonly sort: SortSpec;
  readonly filters: ResultFilters;
}

export const DEFAULT_SORT: SortSpec = Object.freeze({ key: "relevance", direction: "desc" });
export const NO_FILTERS: ResultFilters = Object.freeze({ includeSubfolders: true, nameContains: "" });
export const DEFAULT_OPTIONS: SearchOptions = Object.freeze({ sort: DEFAULT_SORT, filters: NO_FILTERS });

const SORT_KEYS: readonly SortKey[] = ["relevance", "name", "modified", "path", "matches"];
const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Objet non nul (tableaux compris) ; partagé avec les réglages. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** Plus petite borne de pages valide (une page au moins) ; partagée avec la barre d'outils. */
export const MIN_PAGE_BOUND = 1;
export const isPageBound = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= MIN_PAGE_BOUND;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** NFC : les noms macOS (NFD) et les saisies (NFC) se comparent comme égaux. */
const nfc = (s: string): string => s.normalize("NFC");

/** Plafond des textes de filtre lus d'un fichier non fiable (points de code). */
export const MAX_FILTER_TEXT = 200;
/** Coupe par points de code (jamais au milieu d'une paire de substitution). */
const capText = (s: string): string => (s.length <= MAX_FILTER_TEXT ? s : Array.from(s).slice(0, MAX_FILTER_TEXT).join(""));

/**
 * Besoin de recherche sur le nom : même tokenisation que l'index (casse, accents et ponctuation ignorés), jetons
 * rejoints par une espace. « mon fichier », « mon_fichier » et « mon-fichier » se valent donc ; une saisie faite
 * seulement d'espaces ou de diacritiques donne une chaîne vide, c'est-à-dire un filtre inactif.
 */
export function normalizedNeedle(nameContains: string): string {
  return tokenize(nameContains).join(" ");
}

/** Vrai si les bornes ne se contredisent pas (une borne absente ne contredit rien). */
export function isValidPageRange(min: number | undefined, max: number | undefined): boolean {
  return min === undefined || max === undefined || min <= max;
}

/** Ancien filtre `folder` d'une entrée inconnue, s'il est présent et non vide ; sinon undefined. */
export function legacyFolderOf(filters: unknown): string | undefined {
  return isRecord(filters) && typeof filters["folder"] === "string" && filters["folder"].trim() !== "" ? filters["folder"] : undefined;
}

/**
 * Reconstruit des options sûres à partir d'une entrée inconnue : valeurs invalides ramenées aux défauts. Une portée présente
 * mais invalide est retirée ; `onInvalidScope` (optionnel) en est alors informé, pour que ce retrait ne soit jamais silencieux.
 * De même `onLegacyFolder` reçoit l'ancien dossier d'assets (non vide), ignoré depuis que le chemin est une portée de documents.
 */
export function normalizeSearchOptions(
  input: unknown,
  onInvalidScope?: (raw: unknown) => void,
  onLegacyFolder?: (folder: string) => void,
): SearchOptions {
  const src = isRecord(input) ? input : {};
  const sortSrc = isRecord(src["sort"]) ? src["sort"] : {};
  const knownKey = SORT_KEYS.find((k) => k === sortSrc["key"]);
  // Clé inconnue : tri par défaut en entier (une direction seule n'aurait pas de sens).
  const key = knownKey ?? DEFAULT_SORT.key;
  const direction = (knownKey && SORT_DIRECTIONS.find((d) => d === sortSrc["direction"])) || DEFAULT_SORT.direction;
  const f = isRecord(src["filters"]) ? src["filters"] : {};
  let minPages = isPageBound(f["minPages"]) ? f["minPages"] : undefined;
  let maxPages = isPageBound(f["maxPages"]) ? f["maxPages"] : undefined;
  if (!isValidPageRange(minPages, maxPages)) {
    minPages = undefined;
    maxPages = undefined;
  }
  const modifiedAfterMs = isFiniteNumber(f["modifiedAfterMs"]) ? f["modifiedAfterMs"] : undefined;
  const { scopes, invalid } = readScopes(f);
  if (invalid !== undefined) onInvalidScope?.(invalid);
  const legacy = legacyFolderOf(f);
  if (legacy !== undefined) onLegacyFolder?.(legacy);
  const filters: ResultFilters = {
    includeSubfolders: typeof f["includeSubfolders"] === "boolean" ? f["includeSubfolders"] : NO_FILTERS.includeSubfolders,
    nameContains: typeof f["nameContains"] === "string" ? capText(f["nameContains"].trim()) : NO_FILTERS.nameContains,
    ...(minPages !== undefined ? { minPages } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(modifiedAfterMs !== undefined ? { modifiedAfterMs } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
  };
  return { sort: { key, direction }, filters };
}

/** Identité d'une portée : la cible (type, cahier, chemin du document), jamais le libellé (un document renommé reste le même). */
const scopeTarget = (s: DocumentScope): string => `${s.kind}|${s.box}|${s.kind === "document" ? s.docPath : ""}`;

/** Mêmes cibles, sans tenir compte de l'ordre. */
function sameScopes(a: readonly DocumentScope[] | undefined, b: readonly DocumentScope[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  const left = a.map(scopeTarget).sort();
  const right = b.map(scopeTarget).sort();
  return left.every((key, i) => key === right[i]);
}

/** Des cahiers seuls contiennent toujours tous leurs documents : l'indicateur « enfants » n'y a aucun effet. */
const effectiveIncludeSubfolders = (f: ResultFilters): boolean =>
  f.scopes !== undefined && !f.scopes.some((s) => s.kind === "document") ? true : f.includeSubfolders;

/** Égalité champ par champ (indépendante de l'ordre des clés) ; à appliquer à des options normalisées. */
export function sameOptions(a: SearchOptions, b: SearchOptions): boolean {
  return (
    a.sort.key === b.sort.key &&
    a.sort.direction === b.sort.direction &&
    effectiveIncludeSubfolders(a.filters) === effectiveIncludeSubfolders(b.filters) &&
    a.filters.nameContains === b.filters.nameContains &&
    a.filters.minPages === b.filters.minPages &&
    a.filters.maxPages === b.filters.maxPages &&
    a.filters.modifiedAfterMs === b.filters.modifiedAfterMs &&
    sameScopes(a.filters.scopes, b.filters.scopes)
  );
}

/** Nombre de critères actifs (le choix « sous-dossiers » n'est pas un critère à lui seul). */
export function countActiveFilters(filters: ResultFilters): number {
  let n = 0;
  if (normalizedNeedle(filters.nameContains) !== "") n++;
  if (isValidPageRange(filters.minPages, filters.maxPages)) {
    if (filters.minPages !== undefined) n++;
    if (filters.maxPages !== undefined) n++;
  }
  if (filters.modifiedAfterMs !== undefined) n++;
  if (filters.scopes !== undefined) n++;
  return n;
}

export interface FilterOutcome<T> {
  readonly kept: T[];
  /** Documents écartés par les filtres. */
  readonly hidden: number;
}

/**
 * Garde les documents qui passent tous les filtres (ET), dans l'ordre d'entrée. Un document absent de `getInfo`
 * est conservé (impossible à filtrer), sauf avec une portée : sans chemin connu il ne peut être prouvé cité. `kept` est
 * toujours une nouvelle liste.
 *
 * Portée : `scopePaths` est l'ensemble NFC des PDF cités (déjà résolu, enfants compris ou non). Une portée active sans
 * `scopePaths` (résolution absente ou en cours) ne garde AUCUN document : jamais d'ignorance silencieuse du filtre.
 */
export function applyFilters<T extends { readonly docId: string }>(
  docs: readonly T[],
  filters: ResultFilters,
  getInfo: (docId: string) => DocInfo | undefined,
  scopePaths?: ReadonlySet<string>,
): FilterOutcome<T> {
  if (countActiveFilters(filters) === 0) return { kept: [...docs], hidden: 0 };
  const scoped = filters.scopes !== undefined;
  if (scoped && scopePaths === undefined) return { kept: [], hidden: docs.length };
  const needle = normalizedNeedle(filters.nameContains);
  const rangeOk = isValidPageRange(filters.minPages, filters.maxPages);
  const kept: T[] = [];
  let hidden = 0;
  for (const doc of docs) {
    const info = getInfo(doc.docId);
    if (!info) {
      if (scoped) hidden++;
      else kept.push(doc);
      continue;
    }
    let ok = !scoped || (scopePaths?.has(nfc(info.path)) ?? false);
    if (ok && needle !== "") ok = tokenize(info.title).join(" ").includes(needle);
    if (ok && rangeOk) {
      if (filters.minPages !== undefined && info.pageCount < filters.minPages) ok = false;
      if (filters.maxPages !== undefined && info.pageCount > filters.maxPages) ok = false;
    }
    if (ok && filters.modifiedAfterMs !== undefined) ok = info.pdfModifiedMs >= filters.modifiedAfterMs;
    if (ok) kept.push(doc);
    else hidden++;
  }
  return { kept, hidden };
}

// --- Tri ---------------------------------------------------------------------------------------------------------

/** Tris proposés à l'utilisateur, dans l'ordre d'affichage ; `labelKey` est une clé i18n. */
export const SORT_CHOICES: readonly { readonly spec: SortSpec; readonly labelKey: string }[] = Object.freeze([
  { spec: DEFAULT_SORT, labelKey: "sortRelevanceDesc" },
  { spec: Object.freeze({ key: "relevance", direction: "asc" }), labelKey: "sortRelevanceAsc" },
  { spec: Object.freeze({ key: "modified", direction: "asc" }), labelKey: "sortModifiedAsc" },
  { spec: Object.freeze({ key: "modified", direction: "desc" }), labelKey: "sortModifiedDesc" },
  { spec: Object.freeze({ key: "name", direction: "asc" }), labelKey: "sortNameAsc" },
  { spec: Object.freeze({ key: "name", direction: "desc" }), labelKey: "sortNameDesc" },
  { spec: Object.freeze({ key: "path", direction: "asc" }), labelKey: "sortPathAsc" },
  { spec: Object.freeze({ key: "matches", direction: "desc" }), labelKey: "sortMatchesDesc" },
] as const);

/** « clé:sens » (ex. « name:asc »), valeur des options du sélecteur. */
export const sortToValue = (sort: SortSpec): string => `${sort.key}:${sort.direction}`;

/** Vrai pour un tri proposé par le sélecteur (un tri valide mais hors choix, ex. « path:desc », n'est pas mémorisé). */
export const isProposedSort = (sort: SortSpec): boolean => sortFromValue(sortToValue(sort)) !== undefined;

/** Inverse de `sortToValue`, limité aux tris proposés ; undefined pour toute autre valeur. */
export function sortFromValue(value: unknown): SortSpec | undefined {
  if (typeof value !== "string") return undefined;
  return SORT_CHOICES.find((c) => sortToValue(c.spec) === value)?.spec;
}

let defaultCollator: Intl.Collator | undefined;
/** Ordre alphabétique français : chiffres comparés comme des nombres, casse et accents ignorés. */
const frenchCollator = (): Intl.Collator =>
  (defaultCollator ??= new Intl.Collator("fr", { numeric: true, sensitivity: "base" }));

/**
 * Trie des documents de résultat (nouvelle liste ; l'entrée, supposée en ordre de pertinence, n'est pas modifiée).
 * Égalités : ordre d'entrée (le sens ne les inverse pas), puis docId. Un document sans info est placé en fin de
 * liste pour les clés qui en dépendent (name, path, modified), dans son ordre d'entrée.
 */
export function sortDocs<T extends { readonly docId: string; readonly matchingPages: number }>(
  docs: readonly T[],
  sort: SortSpec,
  getInfo: (docId: string) => DocInfo | undefined,
  collator: Intl.Collator = frenchCollator(),
): T[] {
  const indexed = docs.map((doc, index) => ({ doc, index }));
  if (sort.key === "relevance") {
    if (sort.direction === "desc") return indexed.map((e) => e.doc);
    return indexed.reverse().map((e) => e.doc);
  }
  const sign = sort.direction === "asc" ? 1 : -1;
  const compareValue = (a: T, b: T): number | undefined => {
    if (sort.key === "matches") return (a.matchingPages - b.matchingPages) * sign;
    const ia = getInfo(a.docId);
    const ib = getInfo(b.docId);
    if (!ia || !ib) return ia ? -1 : ib ? 1 : 0; // sans info : toujours après, quel que soit le sens
    if (sort.key === "modified") {
      // Date non finie (NaN, ±Infinity) : « sans info », en fin quel que soit le sens (sinon le comparateur n'est pas transitif).
      const fa = Number.isFinite(ia.pdfModifiedMs);
      const fb = Number.isFinite(ib.pdfModifiedMs);
      if (!fa || !fb) return fa ? -1 : fb ? 1 : 0;
      return (ia.pdfModifiedMs - ib.pdfModifiedMs) * sign;
    }
    return collator.compare(sort.key === "name" ? ia.title : ia.path, sort.key === "name" ? ib.title : ib.path) * sign;
  };
  return indexed
    .sort((x, y) => {
      const byValue = compareValue(x.doc, y.doc);
      if (byValue) return byValue;
      if (x.index !== y.index) return x.index - y.index;
      return x.doc.docId < y.doc.docId ? -1 : x.doc.docId > y.doc.docId ? 1 : 0;
    })
    .map((e) => e.doc);
}
