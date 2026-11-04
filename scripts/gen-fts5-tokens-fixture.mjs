#!/usr/bin/env node
// Genere tests/fixtures/fts5-tokens.json : tokens produits par le VRAI tokenizer FTS5
// `unicode61 remove_diacritics 2` (via fts5vocab) pour des valeurs Unicode exotiques.
// Commande : node scripts/gen-fts5-tokens-fixture.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "fts5-tokens.json");
const COMMAND = "node scripts/gen-fts5-tokens-fixture.mjs";

const SAMPLES = {
  "eszett": "Straße",
  "l barre": "Łódź",
  "I majuscule pointe": "İstanbul",
  "i sans point": "ısı",
  "ligature fi": "ﬁnal ﬂux",
  "pleine largeur": "Ａｂｃ１２３",
  "arabo-indiques": "٠١٢٣ ٤٥٦",
  "CJK": "日本語 テスト",
  "emoji": "ok 😀 go",
  "marque combinante isolee": "́ abc",
  "marque combinante apres espace": "a ́b",
  "NFC": "café",
  "NFD": "café",
  "oe ligature": "Œuvre cœur",
  "ae ligature": "Æon",
  "apostrophe": "l'été aujourd’hui",
  "souligne": "snake_case",
  "chiffres exposants": "m² x³",
  "grec sigma final majuscule": "ΟΔΟΣ",
  "grec sigma final minuscule": "οδος",
  "turc i point": "Iİiı",
  "SS majuscule": "STRASSE",
  "tiret et nbsp": "a\u00a0b\u2013c",
  "cyrillique": "Привет Мир",
  "ordinal": "1ᵉ º",
  "fraction": "½ 3/4",
};

const q = (s) => `'${s.replaceAll("'", "''")}'`;
const run = (db, sql) => execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 1 << 26 });

const dir = mkdtempSync(join(tmpdir(), "fts5tok-"));
try {
  const cases = Object.entries(SAMPLES).map(([label, text], i) => {
    const db = join(dir, `s${i}.db`); // une base par echantillon
    const out = run(db, `CREATE VIRTUAL TABLE s USING fts5(x, tokenize='unicode61 remove_diacritics 2'); INSERT INTO s VALUES(${q(text)}); CREATE VIRTUAL TABLE v USING fts5vocab(s, 'instance'); SELECT term, "offset" AS off FROM v ORDER BY off;`);
    const rows = out.trim() === "" ? [] : JSON.parse(out);
    return { label, text, tokens: rows.map((r) => r.term) };
  });
  writeFileSync(OUT, JSON.stringify({ generatedBy: COMMAND, tokenizer: "unicode61 remove_diacritics 2", cases }, null, 2) + "\n");
  console.log(`ecrit ${OUT} (${cases.length} cas)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
