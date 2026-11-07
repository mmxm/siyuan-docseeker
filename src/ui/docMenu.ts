/**
 * Entrées du menu « Spécifier le chemin » pour l'arbre des documents SiYuan : un cahier (niveau 0) puis ses documents
 * indentés. Pur : aucun DOM ; les libellés sont du texte brut (l'adaptateur de menu les échappe).
 */
import type { DocumentScope } from "../search/docScope";
import { filterDocTree, type DocTree, type DocTreeNode } from "../search/docTree";
import { indentedLabel } from "./menuLabels";
import type { NativeMenuItem } from "./nativeUiTypes";

/** Nombre maximal d'entrées de l'arbre dans le menu (le noyau peut renvoyer des dizaines de milliers de documents). */
export const DOC_MENU_MAX_ITEMS = 500;
const LABEL_SEPARATOR = " / ";

const segmentsOf = (hpath: string): string[] => hpath.split("/").filter((s) => s !== "");

/** Portée choisie pour un nœud : « Cahier » ou « Cahier / Parent / Document ». */
export function scopeOfNode(tree: DocTree, node: DocTreeNode): DocumentScope {
  if (node.kind === "notebook" || node.docPath === undefined) return { kind: "notebook", box: node.box, label: node.label };
  const notebook = tree.find((n) => n.kind === "notebook" && n.box === node.box);
  const parts = notebook ? [notebook.label, ...segmentsOf(node.hpath)] : segmentsOf(node.hpath);
  return { kind: "document", box: node.box, docPath: node.docPath, label: parts.join(LABEL_SEPARATOR) };
}

const sameTarget = (scope: DocumentScope, node: DocTreeNode): boolean =>
  scope.box === node.box &&
  (scope.kind === "notebook" ? node.kind === "notebook" : node.kind === "document" && node.docPath === scope.docPath);

/** Même cible (cahier ou document) : le libellé n'entre pas dans la comparaison. */
export function sameScopeTarget(a: DocumentScope, b: DocumentScope | undefined): boolean {
  if (b === undefined || a.kind !== b.kind || a.box !== b.box) return false;
  return a.kind === "notebook" || (b.kind === "document" && a.docPath === b.docPath);
}

export interface DocMenuArgs {
  readonly tree: DocTree;
  /** Portée active, ou undefined. Elle reste listée (et seule courante) même hors plafond ou absente de l'arbre. */
  readonly current: DocumentScope | undefined;
  readonly t: (key: string, vars?: Readonly<Record<string, string | number>>) => string;
  readonly choose: (scope: DocumentScope) => void;
}

export function docMenuItems({ tree, current, t, choose }: DocMenuArgs): NativeMenuItem[] {
  const { items: shown, hidden } = filterDocTree(tree, "", DOC_MENU_MAX_ITEMS);
  const items: NativeMenuItem[] = shown.map((node) => {
    const item = { label: indentedLabel(node.depth, node.label), click: () => choose(scopeOfNode(tree, node)) };
    return current !== undefined && sameTarget(current, node) ? { ...item, current: true } : item;
  });
  let hiddenCount = hidden;
  if (current !== undefined && !items.some((i) => i.current === true)) {
    const beyond = tree.find((n) => sameTarget(current, n));
    if (beyond) hiddenCount -= 1; // listée ci-dessous : elle n'est plus « masquée »
    items.push({
      label: beyond ? indentedLabel(beyond.depth, beyond.label) : indentedLabel(0, current.label),
      current: true,
      click: () => choose(current),
    });
  }
  if (hiddenCount > 0) {
    items.push({ label: t(hiddenCount === 1 ? "docsMoreOne" : "docsMoreMany", { n: hiddenCount }), disabled: true });
  }
  return items;
}
