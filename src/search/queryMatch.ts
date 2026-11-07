/**
 * Correspondance requête / termes, cohérente avec `searchPages` (bm25.ts) :
 * la règle (exact, préfixe du dernier mot, sous-chaîne) est définie une seule fois dans core/termMatch.ts.
 */
import { tokenize } from "../core/normalize";
import { MatchClass, classifyTerm, queryWordRules, type QueryWordRule } from "../core/termMatch";

export const FULL_TITLE_BONUS = 1500;
export const PARTIAL_TITLE_BONUS = 500;

const PDF_EXTENSION = /\.pdf$/i;
/** Suffixe d'identifiant de bloc SiYuan : -AAAAMMJJHHMMSS-xxxxxxx. */
const SIYUAN_ID_SUFFIX = /-\d{14}-[a-z0-9]{7}$/i;

/** Vrai si `term` correspond à au moins un mot de la requête (règle de termMatch.ts, comme searchPages). */
export function makeTermMatcher(query: string): (term: string) => boolean {
  const rules = queryWordRules(tokenize(query));
  return (term) => rules.some((rule) => classifyTerm(term, rule) !== MatchClass.None);
}

/** Positions des mots distincts de la requête (ordre d'apparition). */
function distinctPositions(rules: readonly QueryWordRule[]): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  for (const { word } of rules) if (!positions.has(word)) positions.set(word, positions.size);
  return positions;
}

/**
 * Indices (dans les mots distincts de la requête, ordre croissant) de TOUS les mots que `term` satisfait, [] sinon.
 * Un terme peut en satisfaire plusieurs (« abc bcd » et le terme « abcd ») : searchPages trouve alors la page, et le
 * surlignage comme la proximité doivent compter les deux mots. Même règle que makeTermMatcher.
 */
export function makeTermIndexesOf(query: string): (term: string) => readonly number[] {
  const rules = queryWordRules(tokenize(query));
  const positions = distinctPositions(rules);
  return (term) => {
    const found = new Set<number>();
    for (const rule of rules) {
      if (classifyTerm(term, rule) !== MatchClass.None) found.add(positions.get(rule.word) as number);
    }
    return [...found].sort((a, b) => a - b);
  };
}

/**
 * Index du mot que `term` satisfait le mieux (classe la plus forte, puis premier), -1 sinon : le mot principal à
 * surligner. Voir makeTermIndexesOf pour la liste complète.
 */
export function makeTermIndexer(query: string): (term: string) => number {
  const rules = queryWordRules(tokenize(query));
  const positions = distinctPositions(rules);
  return (term) => {
    const best = bestRule(term, rules);
    return best === undefined ? -1 : (positions.get(best.word) as number);
  };
}

/** Règle de classe la plus forte pour `term` (la première en cas d'égalité), undefined si aucune ne convient. */
function bestRule(term: string, rules: readonly QueryWordRule[]): QueryWordRule | undefined {
  let bestClass: MatchClass = MatchClass.None;
  let best: QueryWordRule | undefined;
  for (const rule of rules) {
    const matchClass = classifyTerm(term, rule);
    if (matchClass > bestClass) {
      bestClass = matchClass;
      best = rule;
    }
  }
  return best;
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
