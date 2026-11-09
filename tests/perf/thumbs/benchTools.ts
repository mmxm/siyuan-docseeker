/** Fonctions pures du banc de vignettes (testées dans tests/unit/perf/thumbBenchTools.test.ts). */
import { median, percentile } from "../corpusTools";

export interface ReadySummary {
  readonly first: number;
  readonly median: number;
  readonly last: number;
  readonly errors: number;
}

/** Temps (ms) jusqu'à « ready » par cadre ; un temps négatif marque une erreur (valeur absolue = durée). */
export function summarizeReady(readyMs: readonly number[]): ReadySummary {
  const times = readyMs.map(Math.abs);
  return {
    first: percentile(times, 0),
    median: median(times),
    last: percentile(times, 100),
    errors: readyMs.filter((x) => x < 0).length,
  };
}

/** Nom du corpus égal à `wanted` à la normalisation Unicode près (macOS renvoie du NFD). */
export function matchCorpusName(names: readonly string[], wanted: string): string | undefined {
  const target = wanted.normalize("NFC");
  return names.find((n) => n.normalize("NFC") === target);
}

export interface ScenarioPart {
  readonly file: string;
  readonly pages: readonly number[];
}
export interface ThumbItem {
  readonly file: string;
  readonly page: number;
}

export function expandScenario(parts: readonly ScenarioPart[]): ThumbItem[] {
  return parts.flatMap((p) => p.pages.map((page) => ({ file: p.file, page })));
}

const PILLY = "Pilly - 2E 2023.pdf";
const TEXT = "027 - Prévention des risques fœtaux _ infection, médicaments, toxiques, irradiation.pdf";
const MIX_PAGES = [12, 40, 77] as const;

/** Scénarios reproductibles : PDF lourd en images, PDF texte, mélange de 5 PDF. */
export const DEFAULT_SCENARIOS: Record<"pilly" | "text" | "mix", readonly ScenarioPart[]> = {
  pilly: [{ file: PILLY, pages: [12, 40, 77, 120, 150, 200, 233, 260, 300, 331, 380, 420] }],
  text: [{ file: TEXT, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
  mix: [
    "Cardiologie - 3E 2025.pdf",
    PILLY,
    "Néphrologie - 11E 2024.pdf",
    TEXT,
    "Chirurgie Générale Viscérale et Digestive - 4E 2025.pdf",
  ].map((file) => ({ file, pages: MIX_PAGES })),
};
