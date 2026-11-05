/** Fonctions pures de `corpus.measure.test.ts` (testées dans tests/unit/perf). */
import type { PdfEntry } from "../../src/core/manifest";

export const DEFAULT_BUDGET_MINUTES = 25;
const EXCLUDED_MARKERS = ["OffNote", "RaceNote", "RT_", "ZipExport"] as const;
const PDF_SUFFIX = ".pdf";

export interface CorpusSelection {
  readonly limit?: number | undefined;
  readonly filter?: string | undefined;
}

export interface TimingSummary {
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly runs: number;
}

/** Fichiers de test du corpus (notes, exports) à écarter. */
export function isExcludedName(name: string): boolean {
  return EXCLUDED_MARKERS.some((marker) => name.includes(marker));
}

/** PDF retenus, triés par nom ; `filter` : sous-chaîne insensible à la casse ; `limit` <= 0 ou invalide : aucune. */
export function selectCorpusNames(names: readonly string[], { limit, filter }: CorpusSelection): string[] {
  const needle = filter?.toLowerCase() ?? "";
  const kept = names
    .filter((n) => n.toLowerCase().endsWith(PDF_SUFFIX) && !isExcludedName(n) && n.toLowerCase().includes(needle))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return limit !== undefined && Number.isInteger(limit) && limit > 0 ? kept.slice(0, limit) : kept;
}

/** Rang le plus proche (p dans [0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("percentile of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarizeTimings(values: readonly number[]): TimingSummary {
  return {
    min: percentile(values, 0),
    median: median(values),
    p95: percentile(values, 95),
    max: percentile(values, 100),
    runs: values.length,
  };
}

/** Reprise : les entrées dont le résultat (.dsx ou marqueur « scanné ») existe déjà ne sont pas refaites. */
export function pendingEntries(entries: readonly PdfEntry[], isDone: (entry: PdfEntry) => boolean): PdfEntry[] {
  return entries.filter((e) => !isDone(e));
}

export function parseBudgetMinutes(raw: string | undefined): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_BUDGET_MINUTES;
}
