/**
 * Normalisation et tokenisation equivalentes a SQLite FTS5 `unicode61 remove_diacritics 2`
 * (DocSeeker : backend-rust/crates/search-core/src/schema.rs:54-59 et text_norm.rs:4-16).
 */

const DIACRITIC_MARKS = /\p{M}/gu;
const TOKEN_RUN = /[\p{L}\p{N}]+/gu;

/** Ligatures non decomposees par NFKD. */
const LIGATURE_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/œ/g, "oe"],
  [/æ/g, "ae"],
];

/** FTS5 replie le sigma final (ς) sur σ ; toLowerCase() de JS produit ς en fin de mot (ΟΔΟΣ -> οδος). */
const FINAL_SIGMA = /ς/g;
const SIGMA = "σ";

export interface TokenWithOffset {
  readonly token: string;
  /** Position ordinale du token dans le texte (0, 1, 2...), pas un offset en caracteres. */
  readonly index: number;
}

/**
 * Divergences connues et voulues avec FTS5 (qui ne replie pas la compatibilite Unicode) : NFKD replie
 * ﬁ, Ａ pleine largeur, exposants, ½ ; oe/ae sont developpes (FTS5 garde œ/æ). Voir tests/unit/normalize.fts5.test.ts.
 *
 * NFKD, suppression des diacritiques, minuscules, oe/ae. La ponctuation est conservee. */
export function normalizeText(text: string): string {
  const lowered = text
    .normalize("NFKD")
    .replace(DIACRITIC_MARKS, "")
    .toLowerCase()
    .replace(FINAL_SIGMA, SIGMA);
  return LIGATURE_EXPANSIONS.reduce((acc, [pattern, expansion]) => acc.replace(pattern, expansion), lowered);
}

/** Decoupe en tokens alphanumeriques normalises ; tout le reste est separateur. */
export function tokenize(text: string): readonly string[] {
  return normalizeText(text).match(TOKEN_RUN) ?? [];
}

/** Comme `tokenize`, avec l'index ordinal de chaque token (utile pour les boites de mots). */
export function tokenizeWithOffsets(text: string): readonly TokenWithOffset[] {
  return tokenize(text).map((token, index) => ({ token, index }));
}
