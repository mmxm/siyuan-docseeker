/**
 * Requête SQL du noyau liée à l'arborescence de documents SiYuan : PDF cités par une portée.
 * Rien n'est avalé : toute anomalie (troncature, ligne mal formée) lève une erreur typée.
 */
import { SCOPE_SQL_LIMIT, buildScopeSql, pathsFromScopeResult, type DocumentScope } from "../search/docScope";
import type { KernelApi } from "./kernelApi";

/** Chemins (« assets/x.pdf », NFC, sans doublon) des PDF cités par la portée. */
export async function queryDocAssets(
  kernel: Pick<KernelApi, "sql">,
  scopes: readonly DocumentScope[],
  includeChildren: boolean,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const result = await kernel.sql(buildScopeSql(scopes, includeChildren, SCOPE_SQL_LIMIT), signal);
  return pathsFromScopeResult(result);
}
