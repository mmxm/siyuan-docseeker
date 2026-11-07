/** Icônes SVG du sprite de SiYuan et boutons-icônes natifs, partagés par la barre d'outils et la vue (DOM seulement). */
export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";
/** Position de l'infobulle native (`ariaLabel`) de SiYuan : sous le bouton. */
export const ICON_TOOLTIP_POSITION = "9south";

/** `svg > use` pointant le symbole `id` du sprite (identifiant constant du code, jamais une donnée). */
export function svgIcon(doc: Document, id: string, className?: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  if (className) svg.setAttribute("class", className);
  const use = doc.createElementNS(SVG_NS, "use");
  use.setAttributeNS(XLINK_NS, "xlink:href", `#${id}`);
  svg.appendChild(use);
  return svg;
}

/** Vrai `<button type=button>` à infobulle native : le libellé (texte brut) est l'attribut `aria-label`. */
export function makeIconButton(doc: Document, className: string, label: string, icons: readonly SVGSVGElement[]): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = `${className} ariaLabel`;
  b.setAttribute("aria-label", label);
  b.setAttribute("data-position", ICON_TOOLTIP_POSITION);
  b.append(...icons);
  return b;
}
