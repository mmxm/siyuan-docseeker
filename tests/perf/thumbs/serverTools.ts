/** Fonctions pures du serveur du banc (Node uniquement ; testées dans tests/unit/perf/thumbBenchTools.test.ts). */
import { isAbsolute, resolve, sep } from "node:path";

/** Chemin `rel` sous `root`, ou null s'il en sort (traversée, absolu, octet nul, vide). */
export function resolveInside(root: string, rel: string): string | null {
  if (rel === "" || rel.includes("\0") || isAbsolute(rel)) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) ? full : null;
}

export type RangeRequest =
  | { readonly kind: "full" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

/** Analyse d'un en-tête `Range: bytes=a-b | a- | -n` (une seule plage) sur un fichier de `size` octets. */
export function parseRangeHeader(header: string | undefined, size: number): RangeRequest {
  if (header === undefined) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const bad: RangeRequest = { kind: "unsatisfiable" };
  if (!m || (m[1] === "" && m[2] === "") || size <= 0) return bad;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return bad;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? bad : { kind: "range", start, end };
}
