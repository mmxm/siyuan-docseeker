/**
 * Historique des requêtes soumises : fonctions pures sur des listes immuables (la plus récente en tête).
 * Dédoublonnage exact après trim (la casse de l'utilisateur est conservée), plafond de 20,
 * requêtes vides ou démesurées ignorées.
 */
export const HISTORY_LIMIT = 20;
/** Au-delà, la requête n'est pas mémorisée (borne la taille de settings.json). */
export const HISTORY_QUERY_MAX_LENGTH = 200;

const usable = (query: string): boolean => query !== "" && query.length <= HISTORY_QUERY_MAX_LENGTH;

export function addToHistory(history: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!usable(q)) return [...history];
  return [q, ...history.filter((h) => h !== q)].slice(0, HISTORY_LIMIT);
}

export function clearHistory(): string[] {
  return [];
}

/**
 * Liste lue depuis un fichier non fiable. `valid` est faux quand il a fallu corriger quelque chose
 * (type, entrée non texte, doublon, dépassement) ; absent (ancien fichier) est valide et donne [].
 */
export function normalizeHistory(raw: unknown): { history: string[]; valid: boolean } {
  if (raw === undefined) return { history: [], valid: true };
  if (!Array.isArray(raw)) return { history: [], valid: false };
  const history: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const q = item.trim();
    if (usable(q) && !history.includes(q)) history.push(q);
    if (history.length >= HISTORY_LIMIT) break;
  }
  const valid = history.length === raw.length && history.every((q, i) => q === raw[i]);
  return { history, valid };
}
