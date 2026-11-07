/** Construction DOM sans HTML : tout passe par `createElement` et `setAttribute` (jamais d'`innerHTML`, les données sont du texte). */

/** Élément `tag` avec ses classes (séparées par des espaces) et ses attributs. Les gestionnaires `on*` sont refusés. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  classes = "",
  attrs: Readonly<Record<string, string>> = {},
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (classes !== "") element.className = classes;
  for (const [name, value] of Object.entries(attrs)) {
    if (/^on/i.test(name)) throw new TypeError(`Attribut refusé : « ${name} » (gestionnaire d'évènement)`);
    element.setAttribute(name, value);
  }
  return element;
}
