/**
 * Un élément est « affiché » s'il est dans un document et non masqué (un onglet SiYuan inactif reste dans le DOM,
 * masqué par `display: none`). `checkVisibility()` quand le navigateur l'offre ; sinon on remonte les ancêtres
 * à la recherche d'un attribut `hidden` ou d'un `display: none`.
 */
export function isShown(el: Element): boolean {
  if (!el.isConnected) return false;
  const check = (el as { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") {
    try {
      return check.call(el);
    } catch {
      // repli ci-dessous
    }
  }
  const view = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (view?.getComputedStyle(node).display === "none") return false;
  }
  return true;
}
