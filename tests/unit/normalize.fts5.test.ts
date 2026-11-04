import fc from "fast-check";
import { describe, expect, it } from "vitest";
import rawFixture from "../fixtures/fts5-tokens.json";
import { normalizeText, tokenize } from "../../src/core/normalize";

// Tokens de reference = sortie reelle du tokenizer FTS5 `unicode61 remove_diacritics 2`
// (scripts/gen-fts5-tokens-fixture.mjs, via fts5vocab).
interface TokenCase {
  readonly label: string;
  readonly text: string;
  readonly tokens: readonly string[];
}
const cases: readonly TokenCase[] = rawFixture.cases;
const byLabel = (label: string): TokenCase => {
  const found = cases.find((c) => c.label === label);
  if (!found) throw new Error(`cas inconnu : ${label}`);
  return found;
};

/**
 * Divergences CONNUES et voulues par rapport a FTS5 : notre normalisation applique NFKD (+ oe/ae),
 * FTS5 unicode61 ne replie pas les formes de compatibilite. Avantage : un PDF contenant la ligature
 * « ﬁ » ou « Ａ » est trouve par « fi » / « a ». Index et requete utilisent la meme fonction : coherent.
 * Seul un index FTS5 de DocSeeker differerait sur ces mots (non necessaire pour le plugin).
 */
const KNOWN_DIVERGENCES: Readonly<Record<string, readonly string[]>> = {
  "ligature fi": ["final", "flux"],
  "pleine largeur": ["abc123"],
  "oe ligature": ["oeuvre", "coeur"],
  "ae ligature": ["aeon"],
  "chiffres exposants": ["m2", "x3"],
  ordinal: ["1e", "o"],
  fraction: ["1", "2", "3", "4"],
};

describe("tokenize : valeurs exotiques ecrites a la main", () => {
  const expectTokens = (text: string, expected: readonly string[]): void => {
    expect(tokenize(text)).toEqual(expected);
  };

  it("eszett et l barre : pas de decomposition, minuscules seules / diacritique retire", () => {
    expectTokens("Straße", ["straße"]);
    expectTokens("Łódź", ["łodz"]);
  });

  it("I point en chef : le point est une marque combinante retiree ; i sans point conserve", () => {
    expectTokens("İstanbul", ["istanbul"]);
    expectTokens("ısı", ["ısı"]);
  });

  it("ligature fi et pleine largeur sont repliees (NFKD)", () => {
    expectTokens("ﬁnal", ["final"]);
    expectTokens("Ａｂｃ１２３", ["abc123"]);
  });

  it("chiffres arabes-indiques et CJK sont des tokens", () => {
    expectTokens("٠١٢٣ ٤٥٦", ["٠١٢٣", "٤٥٦"]);
    expectTokens("日本語 テスト", ["日本語", "テスト"]);
  });

  it("emoji = separateur ; marque combinante isolee ne cree pas de token", () => {
    expectTokens("a😀b", ["a", "b"]);
    expectTokens("́", []);
    expectTokens("́ abc", ["abc"]);
    expectTokens("a ́b", ["a", "b"]);
  });

  it("NFC et NFD donnent les memes tokens", () => {
    expect(tokenize("café")).toEqual(tokenize("café"));
    expectTokens("café", ["cafe"]);
  });

  it("sigma final : repli vers sigma comme FTS5 (ς -> σ)", () => {
    expectTokens("ΟΔΟΣ", ["οδοσ"]);
    expectTokens("οδος", ["οδοσ"]);
  });
});

describe("tokenize contre le vrai tokenizer FTS5 unicode61", () => {
  for (const c of cases) {
    const divergence = KNOWN_DIVERGENCES[c.label];
    if (divergence === undefined) {
      it(`identique a FTS5 : ${c.label} (${JSON.stringify(c.text)})`, () => {
        expect(tokenize(c.text)).toEqual(c.tokens);
      });
    } else {
      it(`divergence documentee : ${c.label} (${JSON.stringify(c.text)})`, () => {
        expect(tokenize(c.text)).toEqual(divergence);
        expect(tokenize(c.text)).not.toEqual(c.tokens);
      });
    }
  }

  it("les divergences documentees correspondent bien a des cas de la fixture", () => {
    for (const label of Object.keys(KNOWN_DIVERGENCES)) expect(byLabel(label).text).not.toBe("");
  });

  it("la fixture contient des cas FTS5 attendus (sanity)", () => {
    expect(byLabel("NFD").tokens).toEqual(["cafe"]);
    expect(byLabel("emoji").tokens).toEqual(["ok", "go"]);
  });
});

describe("proprietes", () => {
  it("tokenize(normalizeText(x)) === tokenize(x)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (x) => {
        expect(tokenize(normalizeText(x))).toEqual(tokenize(x));
      }),
      { numRuns: 500 },
    );
  });

  it("memes proprietes sur du texte accentue et des formes de compatibilite", () => {
    const alphabet = fc.constantFrom(..."aÉéœﬁＡς ́İß-'😀٣日Σ");
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 30 }).map((a) => a.join("")), (x) => {
        expect(tokenize(normalizeText(x))).toEqual(tokenize(x));
        expect(tokenize(x).every((t) => t.length > 0 && !/\s/u.test(t))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
