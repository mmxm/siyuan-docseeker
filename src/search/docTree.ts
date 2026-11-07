/**
 * Arbre des cahiers et documents SiYuan, aplati dans l'ordre d'affichage (un cahier, puis ses documents, chaque
 * enfant juste sous son parent), et filtre de recherche. Module pur, sans DOM ni accès au noyau.
 */
import type { NotebookInfo } from "../siyuan/kernelApi";

export interface DocTreeNode {
  readonly kind: "notebook" | "document";
  readonly box: string;
  /** `blocks.path` complet du document (« /ID1/ID2.sy ») ; absent pour un cahier. */
  readonly docPath?: string;
  /** Chemin lisible du document (« /Parent/Enfant ») ; chaîne vide pour un cahier. */
  readonly hpath: string;
  /** Nom du cahier, ou titre du document (dernier segment du hpath). */
  readonly label: string;
  /** 0 pour un cahier, 1 pour un document de premier niveau, etc. */
  readonly depth: number;
}

export type DocTree = readonly DocTreeNode[];

/** Ligne de `select box, path, hpath from blocks where type='d'`. */
export interface DocTreeRow {
  readonly box: string;
  readonly path: string;
  readonly hpath: string;
}

/** L'arbre dépasse la limite de lecture : une liste partielle serait trompeuse. */
export class DocTreeTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Document tree exceeds ${limit} documents`);
    this.name = "DocTreeTooLargeError";
  }
}

export interface DocTreeFilterResult {
  readonly items: readonly DocTreeNode[];
  /** Correspondances non renvoyées à cause de `max`. */
  readonly hidden: number;
}

const segmentsOf = (hpath: string): string[] => hpath.normalize("NFC").split("/").filter((s) => s !== "");

let collator: Intl.Collator | undefined;
const compareText = (a: string, b: string): number =>
  (collator ??= new Intl.Collator("fr", { numeric: true, sensitivity: "base" })).compare(a, b);

/** Ligne et ses segments de hpath, calculés une seule fois avant le tri. */
interface KeyedRow {
  readonly row: DocTreeRow;
  readonly segments: readonly string[];
}

const exact = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Comparaison segment par segment : un parent précède ses enfants, qui restent contigus (« A B » ne s'intercale pas).
 * Le collateur ignore la casse : deux segments qui n'en diffèrent que par elle sont départagés par comparaison exacte
 * AVANT de passer au segment suivant (sinon /A, /a, /A/x, /a/y entremêleraient les familles).
 */
function compareRows(a: KeyedRow, b: KeyedRow): number {
  const sa = a.segments;
  const sb = b.segments;
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const x = sa[i] as string;
    const y = sb[i] as string;
    const c = compareText(x, y) || exact(x, y);
    if (c !== 0) return c;
  }
  if (sa.length !== sb.length) return sa.length - sb.length;
  return exact(a.row.path, b.row.path);
}

/** Cahiers ouverts dans l'ordre reçu, chacun suivi de ses documents triés par hpath. Cahiers fermés ou inconnus omis. */
export function buildDocTree(notebooks: readonly NotebookInfo[], rows: readonly DocTreeRow[]): DocTree {
  const byBox = new Map<string, DocTreeRow[]>();
  for (const row of rows) {
    const list = byBox.get(row.box);
    if (list) list.push(row);
    else byBox.set(row.box, [row]);
  }
  const nodes: DocTreeNode[] = [];
  for (const notebook of notebooks) {
    if (notebook.closed) continue;
    nodes.push({ kind: "notebook", box: notebook.id, hpath: "", label: notebook.name.normalize("NFC"), depth: 0 });
    const keyed = (byBox.get(notebook.id) ?? []).map((row): KeyedRow => ({ row, segments: segmentsOf(row.hpath) }));
    for (const { row, segments } of keyed.sort(compareRows)) {
      nodes.push({
        kind: "document",
        box: row.box,
        docPath: row.path,
        hpath: row.hpath.normalize("NFC"),
        label: segments[segments.length - 1] ?? "",
        depth: Math.max(1, segments.length),
      });
    }
  }
  return nodes;
}

/** Sans casse ni accents (NFD sans marques combinantes), pour comparer « Été » et « ete ». */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Éléments dont le nom (cahier) ou le chemin (document) contient le besoin ; au plus `max` éléments renvoyés. */
export function filterDocTree(tree: DocTree, needle: string, max: number): DocTreeFilterResult {
  const wanted = fold(needle.trim());
  const matches = wanted === "" ? tree : tree.filter((n) => fold(n.kind === "notebook" ? n.label : n.hpath).includes(wanted));
  const limit = Math.max(0, max);
  return { items: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit) };
}
