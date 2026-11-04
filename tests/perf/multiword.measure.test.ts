/**
 * Validation de bout en bout des requêtes à plusieurs mots et des préfixes sur les vrais .dsx (lecture seule).
 *
 * Lancer : `npm run measure:multiword` (hors `npm test`). DSX_DIR optionnel (défaut :
 * ~/SiYuan/data/storage/petal/siyuan-docseeker/idx). Même pipeline que l'onglet : tokenize, searchPages,
 * groupByDocument, decodePageMatches + makeTermMatcher. Pour chaque requête : pages, documents, top 3 et
 * vérification que chaque page résultat contient TOUS les mots (postings) et que decodePageMatches rend
 * exactement les boîtes attendues (somme des tf des termes retenus par le matcher) pour chaque mot requis.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupByDocument, postingsOf, searchPages, vocabulary, type Bm25Index } from "../../src/core/bm25";
import { decodeIndexForSearch } from "../../src/core/codec/decode";
import { decodePageMatches } from "../../src/core/codec/decode";
import { toBm25Index } from "../../src/core/indexMerge";
import { tokenize } from "../../src/core/normalize";
import { makeTermMatcher } from "../../src/search/queryMatch";

const DIR = process.env["DSX_DIR"] ?? join(homedir(), "SiYuan/data/storage/petal/siyuan-docseeker/idx");
const MAX_PAGES_CHECKED = 40;

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

describe("requêtes multi-mots et préfixes sur index réels", () => {
  it("valide chaque requête de bout en bout", async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".dsx")).sort();
    expect(files.length).toBeGreaterThan(0);
    const raws = new Map<string, Uint8Array>();
    const documents = [];
    for (const f of files) {
      const raw = new Uint8Array(readFileSync(join(DIR, f)));
      raws.set(f, raw);
      documents.push({ docId: f, index: await decodeIndexForSearch(raw) });
    }
    const index: Bm25Index = toBm25Index(documents);
    const vocab = vocabulary(index);
    const df = new Map(vocab.map((t) => [t, postingsOf(index, t).length] as const));
    const pageKey = (docId: string, page: number): string => `${docId}#${page}`;
    const pagesOf = (term: string): Set<string> => new Set(postingsOf(index, term).map((p) => pageKey(p.docId, p.page)));

    // Termes réels : fréquents, alphabétiques, >= 7 lettres ; couples qui co-occurrent sur au moins une page.
    const frequent = vocab.filter((t) => /^[a-z]{7,}$/.test(t)).sort((a, b) => (df.get(b) ?? 0) - (df.get(a) ?? 0));
    const top = frequent.slice(0, 60);
    const pageSets = new Map(top.map((t) => [t, pagesOf(t)] as const));
    const overlap = (a: string, b: string): number => [...(pageSets.get(a) ?? [])].filter((k) => pageSets.get(b)?.has(k)).length;
    let pair: [string, string] | undefined;
    for (const a of top) for (const b of top) if (!pair && a < b && overlap(a, b) >= 3 && overlap(a, b) < (df.get(a) ?? 0)) pair = [a, b];
    expect(pair, "aucun couple de termes co-occurrents").toBeDefined();
    const [w1, w2] = pair as [string, string];
    const w3 = top.find((t) => t !== w1 && t !== w2 && [...(pageSets.get(w1) ?? [])].some((k) => pageSets.get(w2)?.has(k) && pageSets.get(t)?.has(k)));
    const prefixOf = (t: string): string => t.slice(0, Math.max(4, Math.ceil(t.length / 2)));
    const accented = vocab.find((t) => /^[a-z]{7,}$/.test(t) && (df.get(t) ?? 0) > 5) ?? w1;
    const accent = (t: string): string => t.replace(/[aeiou]/, (v) => ({ a: "à", e: "é", i: "î", o: "ô", u: "ü" })[v] as string);
    const shout = accented.toUpperCase();
    const queries: { label: string; query: string; expectEmpty?: boolean; allowEmpty?: boolean }[] = [
      { label: "1 mot", query: w1 },
      { label: "2 mots AND", query: `${w1} ${w2}` },
      { label: "2 mots ordre inversé", query: `${w2} ${w1}` },
      ...(w3 ? [{ label: "3 mots", query: `${w1} ${w2} ${w3}` }] : []),
      { label: "dernier mot en préfixe", query: `${w1} ${prefixOf(w2)}` },
      { label: "mot précoce en préfixe (ne doit pas matcher en préfixe)", query: `${prefixOf(w1)} ${w2}` , allowEmpty: true },
      { label: "préfixe seul", query: prefixOf(w1) },
      { label: "majuscules", query: shout },
      { label: "accents + majuscules", query: `${accent(w1).toUpperCase()} ${accent(w2)}` },
      { label: "mot absent", query: "zzzqxjwv", expectEmpty: true },
      { label: "AND avec mot absent", query: `${w1} zzzqxjwv`, expectEmpty: true },
      { label: "ponctuation et espaces multiples", query: `  ${w1},,   -- ${w2}!!  ` },
      { label: "requête dupliquée", query: `${w1} ${w1}` },
      { label: "requête vide", query: "", expectEmpty: true },
      { label: "ponctuation seule", query: " ,; -- ", expectEmpty: true },
    ];
    if (/\bbronchopneumopathie\b/.test(vocab.join(" "))) {
      queries.push({ label: "exemple réel", query: "bronchopneumopathie obstr" });
    }

    for (const { label, query, expectEmpty, allowEmpty } of queries) {
      const t0 = performance.now();
      const hits = searchPages(index, query);
      const grouped = groupByDocument(hits);
      const ms = performance.now() - t0;
      const words = tokenize(query);
      log(`QUERY [${label}] ${JSON.stringify(query)} -> tokens ${JSON.stringify(words)}: ${hits.length} pages, ${grouped.length} docs, ${ms.toFixed(1)} ms`);
      for (const d of grouped.slice(0, 3)) {
        log(`   top ${d.docId} pages ${d.pages.map((p) => `${p.page}(${p.score.toFixed(2)})`).join(",")} / ${d.matchingPages}`);
      }
      if (expectEmpty) {
        expect(hits.length, label).toBe(0);
        continue;
      }
      if (!allowEmpty) expect(hits.length, label).toBeGreaterThan(0);

      // Termes du vocabulaire retenus par mot : égalité sauf le dernier (préfixe).
      const termsOfWord = words.map((w, i) => (i === words.length - 1 ? vocab.filter((t) => t.startsWith(w)) : vocab.filter((t) => t === w)));
      const tfOf = new Map<string, Map<string, number>>(); // terme -> page -> tf
      for (const t of new Set(termsOfWord.flat())) {
        tfOf.set(t, new Map(postingsOf(index, t).map((p) => [pageKey(p.docId, p.page), p.tf] as const)));
      }
      const matcher = makeTermMatcher(query);
      const allowed = new Set(termsOfWord.flat());
      // Cohérence matcher / recherche sur tout le vocabulaire.
      for (const t of vocab) expect(matcher(t), `${query} / ${t}`).toBe(allowed.has(t));

      // Contrôle exhaustif de l'ensemble de pages : intersection indépendante.
      const expectedPages = words
        .map((_, i) => new Set((termsOfWord[i] ?? []).flatMap((t) => [...(tfOf.get(t)?.keys() ?? [])])))
        .reduce((acc, s) => new Set([...acc].filter((k) => s.has(k))));
      expect(new Set(hits.map((h) => pageKey(h.docId, h.page))), `${label}: pages`).toEqual(expectedPages);

      let checked = 0;
      for (const hit of hits.slice(0, MAX_PAGES_CHECKED)) {
        const key = pageKey(hit.docId, hit.page);
        let expectedBoxes = 0;
        for (const [i, w] of words.entries()) {
          const tf = (termsOfWord[i] ?? []).reduce((s, t) => s + (tfOf.get(t)?.get(key) ?? 0), 0);
          expect(tf, `${label}: ${key} doit contenir « ${w} »`).toBeGreaterThan(0);
        }
        for (const t of allowed) expectedBoxes += tfOf.get(t)?.get(key) ?? 0;
        const match = await decodePageMatches(raws.get(hit.docId) as Uint8Array, hit.page, matcher);
        expect(match.boxes.length, `${key} boîtes`).toBeGreaterThan(0);
        expect(match.ordinals.length, `${label}: ${key} ordinaux`).toBe(expectedBoxes);
        expect(new Set(match.ordinals).size).toBe(match.ordinals.length);
        checked++;
      }
      log(`   OK: ${checked} pages vérifiées (tous les mots présents, boîtes cohérentes)`);
    }
  });
});
