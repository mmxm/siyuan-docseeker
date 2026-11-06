/**
 * Options de présentation des résultats : filtres (dossier, nom, pages, date) et tri. Module pur, sans DOM.
 *
 * - Le dossier est un FILTRE appliqué après BM25 : il ne restreint pas la recherche, il masque des documents.
 * - Les filtres vivent en session seulement (jamais persistés) ; le tri est mémorisé par les réglages.
 * - Le tri (`sortDocs`) ne touche qu'à l'ordre des DOCUMENTS ; l'ordre des pages d'un document reste celui du classement.
 */
import { tokenize } from "../core/normalize";
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
  /** Préfixe de dossier (« assets/a/ ») ; chaîne vide : tous les dossiers. */
  readonly folder: string;
  /** Faux : seulement les PDF directement dans le dossier. Sans effet si `folder` est vide. */
  readonly includeSubfolders: boolean;
  /** Sous-chaîne du titre, comparée sans casse ni accents ; vide : pas de filtre. */
  readonly nameContains: string;
  readonly minPages?: number;
  readonly maxPages?: number;
  /** Date de modification du PDF minimale (incluse), en millisecondes. */
  readonly modifiedAfterMs?: number;
}

export interface SearchOptions {
  readonly sort: SortSpec;
  readonly filters: ResultFilters;
}

export const DEFAULT_SORT: SortSpec = Object.freeze({ key: "relevance", direction: "desc" });
export const NO_FILTERS: ResultFilters = Object.freeze({ folder: "", includeSubfolders: true, nameContains: "" });
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

/**
 * Forme canonique d'un dossier : espaces rognés, NFC, exactement un « / » final ; « », « / » et « assets// »
 * donnent respectivement « », « » et « assets/ ». La casse est conservée (comparaison sensible à la casse).
 */
export function normalizedFolder(folder: string): string {
  const f = nfc(folder.trim()).replace(/\/+$/, "");
  return f === "" ? "" : `${f}/`;
}

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

/** Reconstruit des options sûres à partir d'une entrée inconnue : valeurs invalides ramenées aux défauts. */
export function normalizeSearchOptions(input: unknown): SearchOptions {
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
  const filters: ResultFilters = {
    folder: typeof f["folder"] === "string" ? normalizedFolder(f["folder"]) : NO_FILTERS.folder,
    includeSubfolders: typeof f["includeSubfolders"] === "boolean" ? f["includeSubfolders"] : NO_FILTERS.includeSubfolders,
    nameContains: typeof f["nameContains"] === "string" ? f["nameContains"].trim() : NO_FILTERS.nameContains,
    ...(minPages !== undefined ? { minPages } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(modifiedAfterMs !== undefined ? { modifiedAfterMs } : {}),
  };
  return { sort: { key, direction }, filters };
}

/** Égalité champ par champ (indépendante de l'ordre des clés) ; à appliquer à des options normalisées. */
export function sameOptions(a: SearchOptions, b: SearchOptions): boolean {
  return (
    a.sort.key === b.sort.key &&
    a.sort.direction === b.sort.direction &&
    a.filters.folder === b.filters.folder &&
    a.filters.includeSubfolders === b.filters.includeSubfolders &&
    a.filters.nameContains === b.filters.nameContains &&
    a.filters.minPages === b.filters.minPages &&
    a.filters.maxPages === b.filters.maxPages &&
    a.filters.modifiedAfterMs === b.filters.modifiedAfterMs
  );
}

/** Nombre de critères actifs (le choix « sous-dossiers » n'est pas un critère à lui seul). */
export function countActiveFilters(filters: ResultFilters): number {
  let n = 0;
  if (normalizedFolder(filters.folder) !== "") n++;
  if (normalizedNeedle(filters.nameContains) !== "") n++;
  if (isValidPageRange(filters.minPages, filters.maxPages)) {
    if (filters.minPages !== undefined) n++;
    if (filters.maxPages !== undefined) n++;
  }
  if (filters.modifiedAfterMs !== undefined) n++;
  return n;
}

export interface FilterOutcome<T> {
  readonly kept: T[];
  /** Documents écartés par les filtres. */
  readonly hidden: number;
}

/**
 * Garde les documents qui passent tous les filtres (ET), dans l'ordre d'entrée. Un document absent de `getInfo`
 * est conservé (impossible à filtrer). `kept` est toujours une nouvelle liste.
 */
export function applyFilters<T extends { readonly docId: string }>(
  docs: readonly T[],
  filters: ResultFilters,
  getInfo: (docId: string) => DocInfo | undefined,
): FilterOutcome<T> {
  if (countActiveFilters(filters) === 0) return { kept: [...docs], hidden: 0 };
  const prefix = normalizedFolder(filters.folder);
  const needle = normalizedNeedle(filters.nameContains);
  const rangeOk = isValidPageRange(filters.minPages, filters.maxPages);
  const kept: T[] = [];
  let hidden = 0;
  for (const doc of docs) {
    const info = getInfo(doc.docId);
    if (!info) {
      kept.push(doc);
      continue;
    }
    let ok = true;
    if (prefix !== "") {
      const path = nfc(info.path);
      ok = path.startsWith(prefix) && (filters.includeSubfolders || !path.slice(prefix.length).includes("/"));
    }
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

/** Tous les dossiers contenant un PDF, avec leurs parents (« assets/ », « assets/a/ »...), dédoublonnés et triés. */
export function listFolders(docs: readonly DocInfo[]): readonly string[] {
  const folders = new Set<string>();
  for (const doc of docs) {
    const path = nfc(doc.path);
    for (let i = path.indexOf("/", 1); i !== -1; i = path.indexOf("/", i + 1)) folders.add(path.slice(0, i + 1));
  }
  return [...folders].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
