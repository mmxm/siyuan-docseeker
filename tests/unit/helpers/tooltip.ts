/**
 * Simule l'infobulle native de SiYuan (classe `ariaLabel`) : elle insère le contenu de `aria-label` comme HTML. Renvoie le
 * conteneur ainsi construit, pour vérifier qu'une donnée non fiable n'y crée aucun élément et reste lisible (entités).
 */
export function simulateTooltip(source: Element): HTMLElement {
  const holder = source.ownerDocument.createElement("div");
  holder.innerHTML = source.getAttribute("aria-label") ?? "";
  return holder;
}
