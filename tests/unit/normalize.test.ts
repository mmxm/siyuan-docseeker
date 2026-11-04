import { describe, expect, it } from "vitest";
import { normalizeText, tokenize, tokenizeWithOffsets } from "../../src/core/normalize";

// Parite : DocSeeker indexe avec FTS5 `unicode61 remove_diacritics 2`
// (backend-rust/crates/search-core/src/schema.rs:54-59) et normalise les requetes avec
// normalize_text (backend-rust/crates/search-core/src/text_norm.rs:4-16 : NFD, sans marques, minuscules).

describe("normalizeText", () => {
  it("retourne une chaine vide pour une chaine vide", () => {
    expect(normalizeText("")).toBe("");
  });

  it("passe en minuscules", () => {
    expect(normalizeText("BonJour")).toBe("bonjour");
  });

  it("supprime les diacritiques francais", () => {
    expect(normalizeText("Élève Où ça Noël")).toBe("eleve ou ca noel");
  });

  it("developpe les ligatures oe et ae", () => {
    expect(normalizeText("Œuvre cœur Æon")).toBe("oeuvre coeur aeon");
  });

  it("developpe les ligatures typographiques (NFKD)", () => {
    expect(normalizeText("ﬁnal ﬂux")).toBe("final flux");
  });

  it("conserve les chiffres et la ponctuation", () => {
    expect(normalizeText("Page 12, l'été")).toBe("page 12, l'ete");
  });

  it("est idempotent", () => {
    const once = normalizeText("Crème Brûlée Œ");
    expect(normalizeText(once)).toBe(once);
  });
});

describe("tokenize", () => {
  it("retourne [] pour une chaine vide", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("retourne [] pour une chaine de separateurs seuls", () => {
    expect(tokenize(" - ' , ! ... ")).toEqual([]);
  });

  it("decoupe sur les espaces et normalise la casse", () => {
    expect(tokenize("Hello   WORLD")).toEqual(["hello", "world"]);
  });

  it("traite apostrophes et traits d'union comme separateurs", () => {
    expect(tokenize("l'été peut-être")).toEqual(["l", "ete", "peut", "etre"]);
  });

  it("traite les apostrophes typographiques comme separateurs", () => {
    expect(tokenize("aujourd’hui")).toEqual(["aujourd", "hui"]);
  });

  it("conserve les chiffres dans les tokens", () => {
    expect(tokenize("RFC 2616 v2.0")).toEqual(["rfc", "2616", "v2", "0"]);
  });

  it("developpe oe, ae et ligatures avant de decouper", () => {
    expect(tokenize("Cœur ﬁn æ")).toEqual(["coeur", "fin", "ae"]);
  });

  it("gere les emojis comme separateurs", () => {
    expect(tokenize("ok 😀 go")).toEqual(["ok", "go"]);
  });

  it("garde les lettres non latines", () => {
    expect(tokenize("Привет мир 日本")).toEqual(["привет", "мир", "日本"]);
  });

  it("traite 10 000 mots sans erreur", () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `mot${i}`).join(" ");
    const tokens = tokenize(text);
    expect(tokens).toHaveLength(10_000);
    expect(tokens[0]).toBe("mot0");
    expect(tokens[4_999]).toBe("mot4999");
    expect(tokens[tokens.length - 1]).toBe("mot9999");
  });
});

describe("tokenizeWithOffsets", () => {
  it("retourne [] pour une chaine vide", () => {
    expect(tokenizeWithOffsets("")).toEqual([]);
  });

  it("numerote les tokens par position ordinale", () => {
    expect(tokenizeWithOffsets("Le Chat-noir")).toEqual([
      { token: "le", index: 0 },
      { token: "chat", index: 1 },
      { token: "noir", index: 2 },
    ]);
  });

  it("est coherent avec tokenize", () => {
    const text = "Œuvre d'été 2024";
    expect(tokenizeWithOffsets(text).map((t) => t.token)).toEqual(tokenize(text));
  });
});
