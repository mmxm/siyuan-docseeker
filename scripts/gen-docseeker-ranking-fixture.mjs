#!/usr/bin/env node
// Genere tests/fixtures/docseeker-ranking.json : jeu de reference du classement DocSeeker,
// calcule par le VRAI moteur Rust (`search_core::process_search_results`) sur des lignes SQL SYNTHETIQUES.
//
// Regeneration :
//   DOCSEEKER_RUST_DIR=/chemin/vers/DocFastExplorer/backend-rust node scripts/gen-docseeker-ranking-fixture.mjs
//   (ou : DOCSEEKER_RUST_DIR=... npm run gen:ranking-fixture)
// Prerequis : cargo (>= 1.8x) et les crates deja en cache (ou acces reseau au registre).
// Variables optionnelles :
//   DOCSEEKER_REF_BUILD_DIR  dossier de build temporaire (defaut : <tmp>/docseeker-ref-build)
//   CARGO_TARGET_DIR         dossier target de Cargo (defaut : <build>/target)
// Le depot Rust n'est JAMAIS modifie (lecture seule, target hors depot). Aucun chemin absolu dans le JSON.
// Cargo n'accepte pas de variable d'environnement dans une dependance `path` : le script genere donc le
// Cargo.toml depuis tools/docseeker-ref/Cargo.toml.template dans le dossier de build (Cargo.lock copie du depot).
//
// Fidelite : seuls la recherche FTS5/SQLite (bm25, fenetre LIMIT 15, ORDER BY score DESC, title ASC) est
// EMULEE ici (pas de base SQLite) ; tout le reste (occurrences, tris, bonus, score final, ordre) vient du Rust.
// Unites : les `words_json` du Rust sont en POINTS REELS de la page (le seuil de 25 pt et la fusion a 2,5 pt
// sont en points ; 842 n'est code en dur que pour y_ratio). Le JSON stocke les boites en FRACTIONS de page
// (comme WordBox) et, par page, `size` {widthPt, heightPt} quand elle n'est pas A4 (595 x 842) ; le script
// reconvertit en points avec cette taille pour le Rust.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF_DIR = join(ROOT, "tools", "docseeker-ref");
const OUT = join(ROOT, "tests", "fixtures", "docseeker-ranking.json");
const COMMAND = "node scripts/gen-docseeker-ranking-fixture.mjs";

const PAGE_W = 595;
const PAGE_H = 842;
const LINE_H = 12;
const CHAR_W = 6;
const WORD_GAP = 8; // > 2,5 pt : jamais fusionne par le Rust, < 25 pt : meme occurrence
const SQL_WINDOW = 15; // LIMIT par defaut de la recherche (routes/search.rs, engine.rs)
const SQL_PAGES_PER_DOC = 5; // `rp.page_rank <= 5` dans la requete SQL

const round9 = (v) => Number(v.toFixed(9));

// ---------- construction des pages synthetiques ----------

/** Une ligne de mots. `words` : "mot" ou ["mot", ecartAvantEnPoints, hauteurEnPoints]. Retourne des boites en fractions. */
function line(words, { y, lineNo, x = 50, h = LINE_H, gap = WORD_GAP, pw = PAGE_W, ph = PAGE_H }) {
  const boxes = [];
  let cursor = x;
  words.forEach((w, i) => {
    const [text, gapBefore = gap, wordH = h] = Array.isArray(w) ? w : [w];
    if (i > 0) cursor += gapBefore;
    const width = [...text].length * CHAR_W;
    boxes.push({
      text,
      x: round9(cursor / pw),
      y: round9(y / ph),
      width: round9(width / pw),
      height: round9(wordH / ph),
      line: lineNo,
    });
    cursor += width;
  });
  return boxes;
}

/** Lignes empilees : `lines` = tableaux de mots, une ligne tous les 30 pt. */
function textPage(lines, opts = {}) {
  const { y0 = 60, step = 30, ...rest } = opts;
  return lines.flatMap((words, i) => line(words, { y: y0 + i * step, lineNo: i, ...rest }));
}

const sentence = (s) => s.split(" ");

/** `size` : taille de page en points, seulement si elle n'est pas A4 (les boites doivent alors etre construites avec). */
const page = (n, bm25, words, size) => ({ page: n, bm25, words, ...(size ? { size } : {}) });

/** Score de document tel que calcule par sql.rs : titre + |meilleur bm25| * 100 + min(pages * 5, 300). */
function sqlDocScore(pages, titleBonus) {
  if (pages.length === 0) return titleBonus;
  const best = Math.min(...pages.map((p) => p.bm25));
  return round9(titleBonus + Math.abs(best) * 100 + Math.min(pages.length * 5, 300));
}

function doc(docId, title, pages, { titleBonus = 0, score } = {}) {
  return {
    docId,
    title,
    docRelevanceScore: score ?? sqlDocScore(pages, titleBonus),
    matchingPagesCount: pages.length,
    pages,
  };
}

// ---------- emulation du SQL (ordre, fenetre) ----------

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // BINARY de SQLite sur des titres ASCII

function sqlOrder(docs) {
  return [...docs].sort(
    (a, b) => b.docRelevanceScore - a.docRelevanceScore || cmpStr(a.title, b.title) || a.docId - b.docId,
  );
}

function toWordsJson(words, size = { widthPt: PAGE_W, heightPt: PAGE_H }) {
  // Tuple WordEntry : [x0, y0, x1, y1, mot, block_no, line_no], en points.
  return JSON.stringify(
    words.map((w) => [
      w.x * size.widthPt,
      w.y * size.heightPt,
      (w.x + w.width) * size.widthPt,
      (w.y + w.height) * size.heightPt,
      w.text,
      0,
      w.line,
    ]),
  );
}

function buildRows(windowed) {
  const rows = [];
  for (const d of windowed) {
    const base = {
      doc_id: d.docId,
      filename: `${d.title}.pdf`,
      title: d.title,
      folder_id: null,
      total_pages: 10,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
      doc_relevance_score: d.docRelevanceScore,
      matching_pages_count: d.matchingPagesCount,
      doc_type: "pdf",
    };
    if (d.pages.length === 0) {
      // LEFT JOIN sans page : COALESCE(page_number, 1), words_json '[]', bm25 0.0
      rows.push({ ...base, page_number: 1, words_json: "[]", page_bm25: 0 });
      continue;
    }
    // `rp.page_rank <= 5` : seules les 5 meilleures pages (bm25 le plus negatif, puis page) arrivent au Rust.
    const byBm25 = [...d.pages].sort((a, b) => a.bm25 - b.bm25 || a.page - b.page).slice(0, SQL_PAGES_PER_DOC);
    for (const p of byBm25) {
      rows.push({ ...base, page_number: p.page, words_json: toWordsJson(p.words, p.size), page_bm25: p.bm25 });
    }
  }
  return rows;
}

// ---------- appel du binaire Rust ----------

function buildReference() {
  const rustDir = process.env.DOCSEEKER_RUST_DIR;
  if (!rustDir) throw new Error("DOCSEEKER_RUST_DIR doit pointer vers DocFastExplorer/backend-rust");
  const buildDir = process.env.DOCSEEKER_REF_BUILD_DIR ?? join(tmpdir(), "docseeker-ref-build");
  mkdirSync(join(buildDir, "src"), { recursive: true });
  const searchCore = join(rustDir, "crates", "search-core");
  if (searchCore.includes("'")) throw new Error("apostrophe interdite dans DOCSEEKER_RUST_DIR");
  const template = readFileSync(join(REF_DIR, "Cargo.toml.template"), "utf8");
  writeFileSync(join(buildDir, "Cargo.toml"), template.replaceAll("__SEARCH_CORE_PATH__", () => searchCore));
  copyFileSync(join(REF_DIR, "src", "main.rs"), join(buildDir, "src", "main.rs"));
  copyFileSync(join(REF_DIR, "Cargo.lock"), join(buildDir, "Cargo.lock"));
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(buildDir, "target");
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: buildDir, env, stdio: ["ignore", "inherit", "inherit"] });
  let engine = { rustCommit: "inconnu" };
  try {
    const git = (...a) => execFileSync("git", ["-C", rustDir, ...a], { encoding: "utf8" }).trim();
    engine = { rustCommit: git("rev-parse", "HEAD"), rustDirty: git("status", "--porcelain", "--", "crates/search-core").length > 0 };
  } catch {
    /* depot sans git : on garde "inconnu" */
  }
  return { bin: join(targetDir, "release", "docseeker-ref"), engine };
}

function runRust(bin, terms, rows) {
  const out = execFileSync(bin, [], { input: JSON.stringify({ terms, rows }), encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(out);
}

// ---------- scenarios ----------

const T = {
  contrat: "contrat",
  travail: "travail",
  employeur: "employeur",
};

function scenarios() {
  const S = [];
  const add = (name, description, query, terms, documents) => S.push({ name, description, query, terms, documents });

  // 1. Deux mots adjacents : bonus +5000 ; un document au meilleur bm25 mais mots eloignes n'a pas le bonus.
  add(
    "deux-mots-adjacents",
    "Deux mots adjacents sur une ligne => 1 occurrence a 2 mots distincts, bonus +5000. Le doc B (meilleur bm25, mots eloignes de 100 pt) n'a pas le bonus.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "A adjacents", [page(1, -3, textPage([sentence("le contrat travail est signe")]))]),
      doc(2, "B eloignes", [page(1, -9, textPage([["le", "contrat", ["travail", 100], "est", "signe"]]))]),
    ],
  );

  // 2. Trois mots adjacents.
  add(
    "trois-mots-adjacents",
    "Trois mots adjacents => 3 mots distincts, bonus +5000 (tous les mots).",
    "contrat travail employeur",
    [T.contrat, T.travail, T.employeur],
    [
      doc(1, "A trois", [page(2, -4, textPage([sentence("le contrat travail employeur signe")]))]),
      doc(2, "B deux", [page(1, -6, textPage([sentence("le contrat travail signe"), ["employeur"]]))]),
    ],
  );

  // 3. Meme page, lignes differentes.
  add(
    "meme-page-lignes-differentes",
    "Les deux mots sont sur la meme page mais sur deux lignes (30 pt d'ecart vertical) => 2 occurrences a 1 mot, aucun bonus.",
    "contrat travail",
    [T.contrat, T.travail],
    [doc(1, "Deux lignes", [page(1, -5, textPage([sentence("le contrat est la"), sentence("ici le travail est")]))])],
  );

  // 4. Ecarts horizontaux 24 pt / 26 pt (seuil 25 pt).
  add(
    "ecart-24-vs-26-pt",
    "Ecart horizontal de 24 pt (< 25 : meme occurrence, bonus) contre 26 pt (>= 25 : deux occurrences, pas de bonus). Page 595 pt.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Ecart 24", [page(1, -5, textPage([["contrat", ["travail", 24]]]))]),
      doc(2, "Ecart 26", [page(1, -5, textPage([["contrat", ["travail", 26]]]))]),
    ],
  );

  // 5. Mot a cheval sur deux lignes : fin de ligne puis debut de ligne suivante.
  add(
    "mot-a-cheval-deux-lignes",
    "'contrat' en fin de ligne 0 (x ~ 480-522) puis 'travail' en debut de ligne 1 : ecart horizontal negatif et pas de chevauchement vertical => 2 occurrences, aucun bonus.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Coupure de ligne", [
        page(1, -5, [
          ...line(["le", "texte", "du", "contrat"], { y: 100, lineNo: 0, x: 400 }),
          ...line(["travail", "suite"], { y: 112 + 6, lineNo: 1, x: 50 }),
        ]),
      ]),
    ],
  );

  // 6. Mot d'un seul caractere dans la requete brute : filtre par norm_terms, compte par terms.len().
  add(
    "mot-un-caractere",
    "Requete brute 'a contrat' : 'a' (1 car.) est ignore pour l'appariement mais compte dans terms.len()=2. 1 mot distinct trouve => pas de bonus (max_distinct < 2).",
    "a contrat",
    ["a", T.contrat],
    [doc(1, "Un caractere", [page(1, -4, textPage([sentence("a contrat a travail")]))])],
  );

  // 7. 18 documents : fenetre SQL de 15.
  const many = [];
  for (let i = 1; i <= 18; i++) {
    // bm25 de -18 (doc 1) a -1 (doc 18) : doc 18 a le plus faible score de base.
    const bm25 = -(19 - i);
    const adjacent = i === 18 || i === 7;
    const words = adjacent ? sentence("un contrat travail ici") : [["un", "contrat", ["travail", 120], "ici"]];
    many.push(doc(i, `Doc ${String(i).padStart(2, "0")}`, [page(1, bm25, textPage(adjacent ? [words] : words))]));
  }
  add(
    "dix-huit-documents-fenetre-15",
    "18 documents : la requete SQL ne garde que les 15 premiers (score de base desc, titre asc) AVANT le Rust. Doc 18 (mots adjacents, +5000) a le pire score de base : il est hors fenetre et n'apparait jamais. Doc 7 (adjacents) remonte en tete.",
    "contrat travail",
    [T.contrat, T.travail],
    many,
  );

  // 8. Egalites de score departagees par le titre (BINARY : majuscules avant minuscules).
  add(
    "egalites-departagees-par-titre",
    "Quatre documents au score identique : l'ordre vient du SQL (titre ASC, binaire : 'Zeta' < 'alpha'), le Rust est stable. Un cinquieme est sans page (titre seul, words_json '[]').",
    "contrat",
    [T.contrat],
    [
      doc(1, "alpha", [page(1, -5, textPage([sentence("le contrat")]))]),
      doc(2, "Zeta", [page(1, -5, textPage([sentence("le contrat")]))]),
      doc(3, "bravo", [page(1, -5, textPage([sentence("le contrat")]))]),
      doc(4, "Charlie", [page(1, -5, textPage([sentence("le contrat")]))]),
      doc(5, "Titre seul", [], { titleBonus: 1500 }),
    ],
  );

  // 9. Requete a un seul mot, hauteur 10 pt (pas de bonus de police).
  add(
    "un-seul-mot-sans-bonus",
    "Un seul terme, police 10 pt (seuil strict > 10) : relevance_score = score de base, aucun bonus.",
    "contrat",
    [T.contrat],
    [
      doc(1, "Un mot", [
        page(1, -5, textPage([sentence("le contrat"), sentence("un contrat encore")], { h: 10 })),
        page(3, -2, textPage([sentence("contrat")], { h: 10 })),
      ]),
    ],
  );

  // 10. Bonus partiel 2/3.
  add(
    "bonus-partiel-2-sur-3",
    "3 termes, meilleure occurrence a 2 mots distincts => bonus partiel 2/3 * 2000 = 1333,33 (arrondi 2 decimales dans le score).",
    "contrat travail employeur",
    [T.contrat, T.travail, T.employeur],
    [doc(1, "Partiel", [page(1, -5, textPage([sentence("le contrat travail signe")]))])],
  );

  // 11. 4 termes : 2/4 et 3/4.
  add(
    "bonus-partiel-4-termes",
    "4 termes : doc A a 2 mots distincts (2/4 * 2000 = 1000), doc B a 3 (3/4 * 2000 = 1500), doc C a 4 (5000).",
    "contrat travail employeur salarie",
    [T.contrat, T.travail, T.employeur, "salarie"],
    [
      doc(1, "A deux", [page(1, -5, textPage([sentence("contrat travail")]))]),
      doc(2, "B trois", [page(1, -5, textPage([sentence("contrat travail employeur")]))]),
      doc(3, "C quatre", [page(1, -5, textPage([sentence("contrat travail employeur salarie")]))]),
    ],
  );

  // 12. Mots sur des pages differentes : pas de bonus.
  add(
    "mots-sur-pages-differentes",
    "Chaque mot sur sa propre page : max_distinct = 1, aucun bonus multi-mots.",
    "contrat travail",
    [T.contrat, T.travail],
    [doc(1, "Pages separees", [page(1, -5, textPage([sentence("le contrat")])), page(2, -6, textPage([sentence("le travail")]))])],
  );

  // 13. Bonus de police.
  add(
    "bonus-taille-de-police",
    "Hauteurs de ligne 9, 10, 12, 14 et 40 pt : bonus = clamp((h-10)*25, 0, 400) sur la plus grande hauteur d'une occurrence.",
    "contrat",
    [T.contrat],
    [9, 10, 12, 14, 40].map((h, i) => doc(i + 1, `Police ${h}`, [page(1, -5, textPage([sentence("le contrat")], { h }))])),
  );

  // 14. Tri des occurrences au sein d'un document.
  add(
    "tri-des-occurrences",
    "Un document, 4 pages : tri par mots distincts desc, puis taille de police desc, puis bm25 asc (le plus negatif d'abord), puis page asc.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Tri", [
        page(1, -2, textPage([sentence("le contrat seul")])),
        page(2, -3, textPage([sentence("le contrat travail")])),
        page(3, -8, textPage([sentence("le contrat")], { h: 20 })),
        page(4, -3, textPage([sentence("le contrat travail")], { h: 18 })),
        page(5, -3, textPage([sentence("un travail")])),
      ]),
    ],
  );

  // 15. Prefixes, accents, sous-chaines.
  add(
    "prefixe-accents-sous-chaine",
    "Termes 'eleve' et 'contrat' : 'Élèves' (accents/prefixe), 'contrats' (prefixe), 'souscontrat' (sous-chaine, terme >= 4 car.) sont apparies.",
    "eleve contrat",
    ["eleve", T.contrat],
    [
      doc(1, "Accents", [page(1, -5, textPage([sentence("Élèves contrats signes")]))]),
      doc(2, "Sous-chaine", [page(1, -5, textPage([sentence("eleve souscontrat")]))]),
    ],
  );

  // 16. Expressions entre guillemets.
  add(
    "phrase-et-mot",
    "Terme-phrase 'contrat de travail' (tous les mots adjacents sur une ligne) + mot 'salarie' : 2 termes distincts dans une occurrence => +5000. Doc B : phrase interrompue (ordre different) => pas d'appariement de la phrase.",
    "\"contrat de travail\" salarie",
    ["contrat de travail", "salarie"],
    [
      doc(1, "A phrase", [page(1, -5, textPage([sentence("le contrat de travail salarie")]))]),
      doc(2, "B desordre", [page(1, -5, textPage([sentence("le travail de contrat salarie")]))]),
    ],
  );

  // 17. Troncature a 25 occurrences.
  const manyOccPages = [1, 2, 3, 4, 5].map((n) =>
    page(n, -n, textPage(Array.from({ length: 6 }, () => sentence("le contrat")))),
  );
  add(
    "troncature-25-occurrences",
    "5 pages x 6 occurrences = 30 : total_occurrences = max(matching_pages_count, 30) = 30, mais seules 25 occurrences sont exposees.",
    "contrat",
    [T.contrat],
    [doc(1, "Trente occurrences", manyOccPages)],
  );

  // ---------- Phase 2 : taille de police et tri des occurrences ----------
  const one = (h) => textPage([sentence("le contrat")], { h });

  // 18. Seuil strict a 10 pt et arrondi a 0,1 de la hauteur.
  add(
    "police-seuil-arrondi",
    "Hauteurs 9,96 / 10 / 10,04 (arrondies a 10,0 : aucun bonus) puis 10,06 et 10,14 (arrondies a 10,1 : bonus 2,5). Le bonus s'applique a la taille ARRONDIE.",
    "contrat",
    [T.contrat],
    [9.96, 10, 10.04, 10.06, 10.14].map((h, i) => doc(i + 1, `Seuil ${h}`, [page(1, -5, one(h))])),
  );

  // 19. Plafond du bonus.
  add(
    "police-plafond",
    "Hauteurs 25,9 (397,5), 26 (400, atteint), 40 et 100 pt (plafonnes a 400).",
    "contrat",
    [T.contrat],
    [25.9, 26, 40, 100].map((h, i) => doc(i + 1, `Plafond ${h}`, [page(1, -5, one(h))])),
  );

  // 20. Requete a un mot : le bonus de police retourne l'ordre BM25.
  add(
    "police-sur-requete-un-mot",
    "Un seul terme : A (meilleur bm25, police 9 pt) est depasse par B (bm25 un peu moins bon, 14 pt : +100) puis C (20 pt : +250, bm25 le plus faible).",
    "contrat",
    [T.contrat],
    [
      doc(1, "A petit", [page(1, -6, one(9))]),
      doc(2, "B moyen", [page(1, -5.4, one(14))]),
      doc(3, "C grand", [page(1, -4.7, one(20))]),
    ],
  );

  // 21. Mot isole en grande police dans une requete a deux termes.
  add(
    "police-mot-isole-deux-termes",
    "Deux termes : le doc A a 'travail' et 'contrat' sur deux lignes distinctes, en 30 pt (pas de bonus multi-mots, bonus de police 400). Le doc B a les deux mots adjacents en 9 pt (+5000).",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "A isole", [page(1, -6, textPage([sentence("le travail"), [["contrat"]]], { h: 30 }))]),
      doc(2, "B adjacents", [page(1, -5, textPage([sentence("le contrat travail")], { h: 9 }))]),
    ],
  );

  // 22. Police d'un groupe = max de ses mots.
  add(
    "police-max-du-groupe",
    "Occurrence a deux mots adjacents de hauteurs 10 et 20 pt : la police du groupe est 20 (bonus 250 en plus de +5000), pas la moyenne ni le premier mot. Doc B : 10 et 12.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "A groupe", [page(1, -5, textPage([[["contrat", 8, 10], ["travail", 8, 20]]]))]),
      doc(2, "B groupe", [page(1, -5, textPage([[["contrat", 8, 10], ["travail", 8, 12]]]))]),
    ],
  );

  // 23. Egalite de police apres arrondi : le bm25 departage.
  add(
    "police-egalite-arrondie",
    "Page 1 : 11,96 pt (arrondie a 12,0) et bm25 -5 ; page 2 : 12,04 pt (arrondie a 12,0) et bm25 -2. Police egale apres arrondi : la page 1 (meilleur bm25) passe devant, alors que la police brute avantagerait la page 2.",
    "contrat",
    [T.contrat],
    [doc(1, "Egalite", [page(1, -5, one(11.96)), page(2, -2, one(12.04))])],
  );

  // 24. Mots distincts avant police.
  add(
    "tri-distinct-avant-police",
    "Page 1 : deux mots distincts en 9 pt ; page 2 : un seul mot en 40 pt ; page 3 : un seul mot en 20 pt. Ordre attendu : 1, 2, 3 (distincts d'abord, puis police).",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Distinct", [
        page(1, -2, textPage([sentence("le contrat travail")], { h: 9 })),
        page(2, -9, textPage([sentence("le contrat")], { h: 40 })),
        page(3, -9, textPage([sentence("le travail")], { h: 20 })),
      ]),
    ],
  );

  // 25. Police avant bm25.
  add(
    "tri-police-avant-bm25",
    "Meme nombre de mots distincts : page 2 (bm25 -1, 16 pt) et page 3 (bm25 -5, 16 pt) devant la page 1 (bm25 -9, 10 pt) ; a police egale le meilleur bm25 gagne (3 avant 2), puis la page.",
    "contrat",
    [T.contrat],
    [
      doc(1, "Police bm25", [
        page(1, -9, one(10)),
        page(2, -1, one(16)),
        page(3, -5, one(16)),
        page(4, -5, one(16)),
      ]),
    ],
  );

  // 26. Meilleure occurrence de chaque page.
  add(
    "tri-meilleure-occurrence-par-page",
    "Page 1 : une occurrence a deux mots en 12 pt + un 'contrat' isole en 30 pt ; page 2 : deux mots en 14 pt ; page 3 : un mot en 40 pt. Une page vaut sa MEILLEURE occurrence (distincts puis police) : ordre 2, 1, 3 ; le 30 pt de la page 1 ne la fait pas remonter.",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Meilleure occurrence", [
        page(1, -4, [
          ...line(["le", "contrat", "travail"], { y: 60, lineNo: 0, h: 12 }),
          ...line(["contrat"], { y: 120, lineNo: 1, h: 30 }),
        ]),
        page(2, -4, textPage([sentence("le contrat travail")], { h: 14 })),
        page(3, -4, textPage([sentence("le contrat")], { h: 40 })),
      ]),
    ],
  );

  // 27. Pages au-dela des 5 meilleures.
  add(
    "police-hors-5-pages",
    "Le doc A a 6 pages ; la 6e (bm25 le plus faible) est en 40 pt mais le SQL (page_rank <= 5) ne la transmet pas : pas de bonus de police. Le doc B (score de base 810 < 930) a une 2e page en 20 pt dans ses 5 meilleures : +250, il passe devant A.",
    "contrat",
    [T.contrat],
    [
      doc(1, "A six pages", [
        page(1, -9, one(10)),
        page(2, -8, one(10)),
        page(3, -7, one(10)),
        page(4, -6, one(10)),
        page(5, -5, one(10)),
        page(6, -1, one(40)),
      ]),
      doc(2, "B grande police", [page(1, -8, one(10)), page(2, -2, one(20))]),
    ],
  );

  // 28. Format Letter : la largeur reelle (612 pt) fixe le seuil de 25 pt, la hauteur reelle (792 pt) la police.
  const LETTER = { widthPt: 612, heightPt: 792 };
  const letterPage = (n, bm25, gapPt, h) =>
    page(n, bm25, textPage([[["contrat"], ["travail", gapPt]]], { h, pw: LETTER.widthPt, ph: LETTER.heightPt }), LETTER);
  add(
    "page-letter",
    "Pages Letter 612 x 792 pt, 'contrat travail' a 24,5 pt (joints, +5000) ou 25,5 pt (separes : sur 612 pt, 25,5 pt = 0,0417 de page, soit 24,8 pt si on suppose 595 pt). Police 12 pt sur 792 pt (12,8 pt si on suppose 842 pt).",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Letter joints", [letterPage(1, -5, 24.5, 12)]),
      doc(2, "Letter separes", [letterPage(1, -5, 25.5, 12)]),
    ],
  );

  // 29. Format paysage : la largeur reelle (842 pt) fixe le seuil de 25 pt, la hauteur reelle (595 pt) la police.
  const LANDSCAPE = { widthPt: 842, heightPt: 595 };
  const landscapePage = (n, bm25, gapPt, h) =>
    page(n, bm25, textPage([[["contrat"], ["travail", gapPt]]], { h, pw: LANDSCAPE.widthPt, ph: LANDSCAPE.heightPt }), LANDSCAPE);
  add(
    "page-paysage",
    "Pages paysage 842 x 595 pt, 'contrat travail' a 24 pt (joints, +5000) ou 26 pt (separes : sur 842 pt, 26 pt = 0,0309 de page, soit 18,4 pt si on suppose 595 pt). Police 12 pt sur 595 pt (17 pt si on suppose 842 pt).",
    "contrat travail",
    [T.contrat, T.travail],
    [
      doc(1, "Paysage joints", [landscapePage(1, -5, 24, 12)]),
      doc(2, "Paysage separes", [landscapePage(1, -5, 26, 12)]),
    ],
  );

  return S;
}

// ---------- assemblage ----------

function main() {
  const { bin, engine } = buildReference();
  const out = [];
  for (const sc of scenarios()) {
    const ordered = sqlOrder(sc.documents);
    const windowed = ordered.slice(0, SQL_WINDOW);
    const windowedOutDocIds = ordered.slice(SQL_WINDOW).map((d) => d.docId);
    const result = runRust(bin, sc.terms, buildRows(windowed));
    out.push({
      name: sc.name,
      description: sc.description,
      query: sc.query,
      terms: sc.terms,
      documents: sc.documents,
      windowedOutDocIds,
      expected: result,
    });
  }
  const fixture = {
    generatedBy: COMMAND,
    engine,
    note:
      "Entrees synthetiques ; classement calcule par search_core::process_search_results (Rust). Seule la fenetre SQL (LIMIT 15, score desc, titre asc binaire) est emulee par le generateur. Boites en fractions de page ; le Rust les voit en points sur 595 x 842.",
    pageWidthPt: PAGE_W,
    pageHeightPt: PAGE_H,
    sqlWindow: SQL_WINDOW,
    scenarios: out,
  };
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${out.length} scenarios ecrits dans ${OUT}`);
}

main();
