#!/usr/bin/env node
// Genere tests/fixtures/fts5-parity.json en interrogeant le VRAI SQLite FTS5 (binaire `sqlite3`).
// Commande : node scripts/gen-fts5-fixture.mjs
// Table : fts5(docId UNINDEXED, page UNINDEXED, text, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4')
// (meme tokenizer/prefix que DocSeeker, backend-rust/crates/search-core/src/schema.rs:54-59).
// Convention : le DERNIER mot de la requete est un prefixe (`mot*`), les autres sont exacts, joints par AND.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "fts5-parity.json");
const COMMAND = "node scripts/gen-fts5-fixture.mjs";

const PAGES = [
  ["contrats", 1, "Le contrat de travail est conclu entre l'employeur et le salarié. Contrat à durée déterminée."],
  ["contrats", 2, "Les obligations du salarié : exécution du contrat, loyauté, discrétion."],
  ["contrats", 3, "Résiliation du contrat : préavis, indemnité, motifs légitimes."],
  ["contrats", 4, "Annexe : modèle de contrat, signature des deux parties. Contrat Contrat."],
  ["contrats", 5, "Dispositions générales et définitions utiles pour le contrat."],
  ["cuisine", 1, "Crème brûlée : battre les œufs, ajouter la crème et le sucre."],
  ["cuisine", 2, "Le contrat de la pâtissière : crème pâtissière, cuisson douce, four à 150 degrés."],
  ["cuisine", 3, "Élève cuisinier : épluchez les légumes, émincez l'oignon."],
  ["cuisine", 4, "Tarte aux pommes, pâte brisée, crème d'amande et pommes caramélisées."],
  ["ecole", 1, "L'élève doit relire le contrat de l'école avant la rentrée."],
  ["ecole", 2, "Les élèves de CM2 étudient l'électricité et les circuits."],
  ["ecole", 3, "Électricité statique : expérience avec un ballon et des cheveux."],
  ["ecole", 4, "Le conseil de l'école élit les délégués élèves chaque année."],
  ["ecole", 5, "Calendrier scolaire : vacances d'été, rentrée en septembre. Contrat de classe."],
  ["voyage", 1, "Voyage à Genève : hôtel près de la gare, réservation du contrat de location."],
  ["voyage", 2, "Zürich et Genève : train de nuit, café crème sur la place."],
  ["voyage", 3, "Été à la mer : plage, soleil, glace à la fraise et crème solaire."],
  ["voyage", 4, "Contrôle des billets à la frontière ; contrat d'assurance voyage."],
  ["voyage", 5, "STRASBOURG, Cathédrale ET marché de Noël. Strasbourg la nuit."],
  ["voyage", 6, "Retour en train, valises, souvenirs et contrats signés."],
  // Page vide : comptee dans N et avgdl par FTS5 (verifie empiriquement), jamais dans les resultats.
  ["voyage", 7, ""],
];

const QUERIES = [
  ["un mot", "genève"],
  ["un mot rare", "cathedrale"],
  ["mot a casse variee", "STRASBOURG"],
  ["ET deux mots", "contrat crème"],
  ["ET trois mots", "école élève contrat"],
  ["prefixe court", "elec"],
  ["prefixe chevauchant (df union)", "eleve"],
  ["prefixe 2 lettres", "el"],
  ["prefixe sur terme frequent", "contr"],
  ["terme frequent exact-ish", "contrat"],
  ["ET avec prefixe sur frequent", "école contr"],
  ["ET exact frequent puis prefixe", "contrat ecole"],
  ["mot absent", "zebre"],
  ["ET dont un mot absent", "contrat zebre"],
  ["mots accentues", "été"],
  ["accents requete sans accent", "creme brulee"],
  ["prefixe 1 lettre", "c"],
];

function sqlite(db, sql) {
  return execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 1 << 26 });
}
const q = (s) => `'${s.replaceAll("'", "''")}'`;

function toMatch(query) {
  const words = query.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((w, i) => (i === words.length - 1 ? `${w}*` : w)).join(" AND ");
}

const dir = mkdtempSync(join(tmpdir(), "fts5-"));
const db = join(dir, "t.db");
try {
  const rows = [...PAGES].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const inserts = rows.map(([d, p, t]) => `INSERT INTO t(docId,page,text) VALUES(${q(d)},${p},${q(t)});`).join("\n");
  sqlite(db, `CREATE VIRTUAL TABLE t USING fts5(docId UNINDEXED, page UNINDEXED, text, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');\n${inserts}`);
  const queries = QUERIES.map(([label, query]) => {
    const match = toMatch(query);
    const out = sqlite(db, `SELECT docId, page, printf('%.17g', bm25(t)) AS s FROM t WHERE t MATCH ${q(match)} ORDER BY bm25(t), docId, page;`);
    const results = out.trim() === "" ? [] : JSON.parse(out).map((r) => ({ docId: r.docId, page: r.page, bm25: Number(r.s) }));
    return { label, query, match, results };
  });
  const sqliteVersion = sqlite(db, "select sqlite_version() as v;").match(/"v":"([^"]+)"/)?.[1];
  const fixture = {
    generatedBy: COMMAND,
    sqliteVersion,
    tokenizer: "unicode61 remove_diacritics 2",
    prefix: "2 3 4",
    pages: rows.map(([docId, page, text]) => ({ docId, page, text })),
    queries,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`ecrit ${OUT} (${rows.length} pages, ${queries.length} requetes)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
