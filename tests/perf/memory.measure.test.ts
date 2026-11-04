/**
 * Mesure de la mémoire de l'index de recherche décodé (risque 1 d'AVANCEMENT.md).
 *
 * Lancer : `npm run measure:memory` (hors `npm test`). Variables optionnelles :
 *   DSX_DIR  dossier des .dsx (défaut : ~/SiYuan/data/storage/petal/siyuan-docseeker/idx), lecture seule ;
 *   COPIES   nombre de copies de chaque .dsx chargées sous des docId distincts (défaut 1) pour
 *            extrapoler à un grand corpus (ex. COPIES=20).
 * Méthode : tas utilisé après GC (plusieurs passes) avant, après décodage (données décodées retenues :
 * decodedKbPerPage), puis après toBm25Index avec les données décodées relâchées (kbPerPage = coût de l'index
 * BM25 seul, ce qui reste en mémoire pendant l'usage). Les Mo des tableaux typés sont inclus (heapUsed ne
 * compte pas les ArrayBuffer hors tas : on ajoute arrayBuffers).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchPages } from "../../src/core/bm25";
import { decodeIndexForSearch } from "../../src/core/codec/decode";
import { toBm25Index } from "../../src/core/indexMerge";

const DIR = process.env["DSX_DIR"] ?? join(homedir(), "SiYuan/data/storage/petal/siyuan-docseeker/idx");
const COPIES = Number(process.env["COPIES"] ?? "1");
const BYTES_PER_KB = 1024;
const GC_PASSES = 5;

function settledHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("exécuter avec --expose-gc (npm run measure:memory)");
  for (let i = 0; i < GC_PASSES; i++) gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

describe("mémoire de l'index de recherche", () => {
  it("mesure heapUsed par page", async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".dsx")).sort();
    expect(files.length).toBeGreaterThan(0);
    const raws = files.map((f) => new Uint8Array(readFileSync(join(DIR, f))));
    const before = settledHeap();
    const documents = [];
    for (let copy = 0; copy < COPIES; copy++) {
      for (const [i, raw] of raws.entries()) {
        documents.push({ docId: `${files[i]}#${copy}`, index: await decodeIndexForSearch(raw) });
      }
    }
    const decoded = settledHeap();
    let index = toBm25Index(documents);
    documents.length = 0; // relâche les données décodées : seul l'index BM25 reste référencé
    const after = settledHeap();
    const pages = index.pageCount;
    const perPageKb = (bytes: number): number => +(bytes / BYTES_PER_KB / pages).toFixed(2);
    const kbPerPage = (after - before) / BYTES_PER_KB / pages;
    const report = {
      files: files.length,
      copies: COPIES,
      pages,
      termsPerDocSum: index.segments.reduce((sum, segment) => sum + segment.terms.length, 0),
      decodedKbPerPage: perPageKb(decoded - before),
      heapMB: +((after - before) / BYTES_PER_KB / BYTES_PER_KB).toFixed(1),
      kbPerPage: +kbPerPage.toFixed(2),
      projectedMBFor40000Pages: +((kbPerPage * 40_000) / BYTES_PER_KB).toFixed(1),
    };
    process.stderr.write(`MEMORY_REPORT ${JSON.stringify(report)}\n`);
    expect(searchPages(index, "the").length).toBeGreaterThanOrEqual(0); // garde l'index vivant
    index = toBm25Index([]);
  });
});
