/**
 * Classification d'un terme indexé (ou d'un mot d'une page) par rapport à un mot de la requête.
 * Source unique de la règle de correspondance : `searchPages` (bm25.ts) et le surlignage (queryMatch.ts)
 * l'utilisent tous deux, pour que ce qui est trouvé soit exactement ce qui est surligné.
 *
 * Règle, par ordre de force :
 *  - Exact     : terme === mot (tous les mots de la requête).
 *  - Prefix    : le terme commence par le mot (dernier mot de la requête seulement).
 *  - Substring : le terme contient le mot (tous les mots, si le mot a au moins MIN_SUBSTRING_LENGTH caractères).
 */

/** Longueur minimale (en points de code, après normalisation) d'un mot pour qu'il accepte la sous-chaîne. */
export const MIN_SUBSTRING_LENGTH = 3;

export const MatchClass = { None: 0, Substring: 1, Prefix: 2, Exact: 3 } as const;
export type MatchClass = (typeof MatchClass)[keyof typeof MatchClass];

/**
 * Poids appliqué au tf d'un terme selon sa classe : un terme exact compte pleinement,
 * un préfixe un peu moins, une sous-chaîne interne nettement moins. Déterministe, sans réglage par requête.
 */
export const MATCH_WEIGHT: Readonly<Record<MatchClass, number>> = {
  [MatchClass.None]: 0,
  [MatchClass.Substring]: 0.3,
  [MatchClass.Prefix]: 0.6,
  [MatchClass.Exact]: 1,
};

export interface QueryWordRule {
  readonly word: string;
  readonly allowPrefix: boolean;
  readonly allowSubstring: boolean;
}

/** Règles des mots d'une requête déjà tokenisée : le préfixe n'est permis qu'au dernier mot. */
export function queryWordRules(words: readonly string[]): readonly QueryWordRule[] {
  const lastIndex = words.length - 1;
  return words.map((word, i) => ({
    word,
    allowPrefix: i === lastIndex,
    allowSubstring: [...word].length >= MIN_SUBSTRING_LENGTH,
  }));
}

/** Classe de correspondance de `term` pour la règle ; sans allocation (appelée dans la boucle chaude). */
export function classifyTerm(term: string, { word, allowPrefix, allowSubstring }: QueryWordRule): MatchClass {
  if (term === word) return MatchClass.Exact;
  if (allowPrefix && term.startsWith(word)) return MatchClass.Prefix;
  if (allowSubstring && term.includes(word)) return MatchClass.Substring;
  return MatchClass.None;
}
