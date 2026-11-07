/** Présentation commune des libellés de menu issus des données (dossiers, documents) : retrait et longueur bornés. */
export const INDENT = "  "; // insécables : SiYuan insère les libellés de menu comme HTML, les espaces simples s'y perdent
export const MAX_MENU_INDENT = 8;
export const MAX_MENU_LABEL = 120;

/** Tronque à `max` caractères (points de code : jamais au milieu d'un emoji) en terminant par « … ». */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Libellé indenté de `depth` niveaux (plafonné), tronqué. */
export function indentedLabel(depth: number, text: string): string {
  return INDENT.repeat(Math.min(Math.max(depth, 0), MAX_MENU_INDENT)) + truncate(text, MAX_MENU_LABEL);
}
