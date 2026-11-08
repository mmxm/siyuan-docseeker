/**
 * Type d'interface de SiYuan (valeur de `getFrontend()` de l'API du plugin). La valeur est injectée :
 * on ne lit jamais `navigator` ni le user-agent, qui mentent sur iPadOS et dans les navigateurs.
 */
export const FRONTENDS = ["desktop", "desktop-window", "mobile", "browser-desktop", "browser-mobile"] as const;
export type Frontend = (typeof FRONTENDS)[number];

const isFrontend = (value: unknown): value is Frontend => (FRONTENDS as readonly unknown[]).includes(value);

export function isMobileFrontend(frontend: Frontend): boolean {
  return frontend === "mobile" || frontend === "browser-mobile";
}

/** Description sûre d'une valeur inattendue : `String()` peut lever (objet sans prototype, Symbol). */
function describe(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return typeof value;
  }
}

export type Warn = (message: string, error?: unknown) => void;

/**
 * Interface courante. Valeur inconnue ou erreur de `getFrontend` : comportement bureau (le seul
 * historique), avec un avertissement journalisé, jamais un silence.
 */
export function readFrontend(getFrontend: () => unknown, onWarn: Warn): Frontend {
  let value: unknown;
  try {
    value = getFrontend();
  } catch (error) {
    onWarn("Type d'interface SiYuan illisible : profil bureau utilisé", error);
    return "desktop";
  }
  if (isFrontend(value)) return value;
  onWarn(`Type d'interface SiYuan inconnu (${describe(value)}) : profil bureau utilisé`);
  return "desktop";
}
