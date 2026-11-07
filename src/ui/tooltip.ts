/**
 * Les infobulles natives de SiYuan (classe `ariaLabel`) insèrent le contenu de `aria-label` COMME HTML. Toute donnée non fiable
 * (nom de document, de cahier, de critère, de PDF) doit donc passer par cette fonction avant d'être posée dans un `aria-label`
 * d'un élément à infobulle. L'infobulle affiche alors le texte d'origine (les entités sont décodées à l'insertion).
 */
export function escapeForTooltip(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
