/**
 * Requêtes SQL du noyau liées à l'arborescence de documents SiYuan : PDF cités par une portée, arbre des documents.
 * Rien n'est avalé : toute anomalie (troncature, ligne mal formée) lève une erreur typée.
 */
import { DOC_PATH, SCOPE_SQL_LIMIT, SQL_ID, buildScopeSql, pathsFromScopeResult, type DocumentScope } from "../search/docScope";
import { DocTreeTooLargeError, buildDocTree, type DocTree, type DocTreeRow } from "../search/docTree";
import { MalformedResponseError, type KernelApi } from "./kernelApi";

const HTTP_OK = 200;
const DOC_TREE_LIMIT = 20_000;
const DOC_TREE_SQL = `select box, path, hpath from blocks where type='d' order by path limit ${DOC_TREE_LIMIT}`;

/** Chemins (« assets/x.pdf », NFC, sans doublon) des PDF cités par la portée. */
export async function queryDocAssets(
  kernel: Pick<KernelApi, "sql">,
  scope: DocumentScope,
  includeChildren: boolean,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const result = await kernel.sql(buildScopeSql(scope, includeChildren, SCOPE_SQL_LIMIT), signal);
  return pathsFromScopeResult(result);
}

function toTreeRow(row: Record<string, unknown>): DocTreeRow {
  const { box, path, hpath } = row;
  if (
    typeof box !== "string" ||
    !SQL_ID.test(box) ||
    typeof path !== "string" ||
    !DOC_PATH.test(path) ||
    typeof hpath !== "string"
  ) {
    throw new MalformedResponseError(HTTP_OK, "unexpected document row (box, path, hpath required)");
  }
  return { box, path, hpath };
}

/** Cahiers ouverts et documents, prêts pour le sélecteur de portée. */
export async function listDocTree(kernel: Pick<KernelApi, "sql" | "lsNotebooks">, signal?: AbortSignal): Promise<DocTree> {
  const [notebooks, result] = await Promise.all([kernel.lsNotebooks(signal), kernel.sql(DOC_TREE_SQL, signal)]);
  if (result.truncated || result.rows.length >= DOC_TREE_LIMIT) throw new DocTreeTooLargeError(DOC_TREE_LIMIT);
  return buildDocTree(notebooks, result.rows.map(toTreeRow));
}
