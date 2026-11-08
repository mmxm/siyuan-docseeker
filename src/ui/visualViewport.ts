/**
 * Suivi de `window.visualViewport` (E4b). Sur iOS, `100dvh` ne rétrécit PAS quand le clavier s'ouvre : la liste des résultats
 * passerait dessous. La hauteur et le décalage vertical réellement visibles sont donc recopiés dans des variables CSS que la
 * feuille de style utilise pour le conteneur plein écran (`var(--docseeker-vvh, 100dvh)`, `translateY(var(--docseeker-vv-top))`).
 */
export const VIEWPORT_HEIGHT_VAR = "--docseeker-vvh";
export const VIEWPORT_TOP_VAR = "--docseeker-vv-top";
/** Attribut posé sur la cible tant que le clavier est ouvert (la feuille de style masque alors la barre basse « Fermer »). */
export const KEYBOARD_ATTR = "data-docseeker-keyboard";
/** Écart (px) entre la fenêtre et le viewport visuel au-delà duquel on considère le clavier ouvert (la barre d'adresse ne l'atteint pas). */
const KEYBOARD_MIN_DELTA = 150;

/**
 * Écrit la hauteur visible (`--docseeker-vvh`), le décalage (`--docseeker-vv-top`) et l'attribut clavier sur `target`, tout de suite
 * puis à chaque `resize` et `scroll` du viewport visuel. Renvoie la fonction d'arrêt (idempotente) : elle retire les écouteurs
 * TOUT DE SUITE mais laisse les valeurs en place, pour que la fenêtre garde sa hauteur pendant l'animation de fermeture (l'élément
 * est détruit juste après). Sans `visualViewport` (ancien moteur) : ne fait rien, le repli `dvh` de la feuille de style s'applique.
 * Une valeur invalide (hauteur <= 0, décalage négatif, non finie) n'est pas écrite et efface la précédente.
 */
export function trackVisualViewport(win: Window, target: HTMLElement): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;
  const write = (name: string, value: number, valid: boolean): void => {
    if (valid) target.style.setProperty(name, `${value}px`);
    else target.style.removeProperty(name);
  };
  const update = (): void => {
    const { height, offsetTop } = viewport;
    write(VIEWPORT_HEIGHT_VAR, height, Number.isFinite(height) && height > 0);
    write(VIEWPORT_TOP_VAR, offsetTop, Number.isFinite(offsetTop) && offsetTop >= 0);
    const keyboard = Number.isFinite(height) && height > 0 && Number.isFinite(win.innerHeight) && win.innerHeight - height > KEYBOARD_MIN_DELTA;
    if (keyboard) target.setAttribute(KEYBOARD_ATTR, "true");
    else target.removeAttribute(KEYBOARD_ATTR);
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}
