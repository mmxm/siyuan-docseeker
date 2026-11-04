/**
 * Correspondance requête / termes, cohérente avec `searchPages` (bm25.ts) :
 * égalité pour les mots entiers, préfixe pour le dernier mot seulement.
 */
import { tokenize } from "../core/normalize";

export const FULL_TITLE_BONUS = 1500;
export const PARTIAL_TITLE_BONUS = 500;

const PDF_EXTENSION = /\.pdf$/i;
/** Suffixe d'identifiant de bloc SiYuan : -AAAAMMJJHHMMSS-xxxxxxx. */
const SIYUAN_ID_SUFFIX = /-\d{14}-[a-z0-9]{7}$/i;

export function makeTermMatcher(query: string): (term: string) => boolean {
  const tokens = tokenize(query);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return () => false;
  const whole = new Set(tokens.slice(0, -1));
  return (term) => term.startsWith(last) || whole.has(term);
}

export function isSearchable(query: string): boolean {
  return tokenize(query).length > 0;
}

function titleTokens(title: string): ReadonlySet<string> {
  return new Set(tokenize(title.replace(PDF_EXTENSION, "").replace(SIYUAN_ID_SUFFIX, "")));
}

export function titleBonuses(
  docs: readonly { docId: string; title: string }[],
  query: string,
): ReadonlyMap<string, number> {
  const wanted = [...new Set(tokenize(query))];
  const bonuses = new Map<string, number>();
  if (wanted.length === 0) return bonuses;
  for (const { docId, title } of docs) {
    const present = titleTokens(title);
    const found = wanted.filter((token) => present.has(token)).length;
    if (found === wanted.length) bonuses.set(docId, FULL_TITLE_BONUS);
    else if (found > 0) bonuses.set(docId, PARTIAL_TITLE_BONUS);
  }
  return bonuses;
}
