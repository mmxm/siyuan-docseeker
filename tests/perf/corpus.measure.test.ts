/**
 * Mesure sur un grand corpus de vrais PDF : indexation hors SiYuan, chargement à froid, latence des requêtes.
 *
 * Lancer : `npm run measure:corpus` (hors `npm test`). Variables optionnelles :
 *   CORPUS_DIR         PDF source, LECTURE SEULE (défaut /Users/francois/Documents/DocFastExplorer/data/documents) ;
 *   DSX_OUT            dossier de travail des .dsx (défaut : scratchpad de la session, sous-dossier corpus-idx) ;
 *   CORPUS_LIMIT       nombre maximal de PDF ; CORPUS_FILES : sous-chaîne (insensible à la casse) du nom ;
 *   CORPUS_BUDGET_MIN  budget d'indexation en minutes (défaut 25) ; au-delà, on mesure ce qui est indexé ;
 *   QUERY_RUNS         répétitions par requête (défaut 30, minimum 20).
 *
 * (a) Indexation : le vrai `createIndexer` + `createLoadPdf` du plugin, avec le PDF.js de SiYuan 6.4.299 lu en
 *     lecture seule dans /Applications/SiYuan.app (même version que dans le plugin), un PDF à la fois.
 *     Reprise : un PDF dont le .dsx (ou le marqueur .scanned) existe déjà n'est pas refait.
 * (b) Chargement à froid : `createSearchStore` (decodeIndexForSearch + toBm25Index), comme dans le plugin.
 * (c) Requêtes : searchPages + groupByDocument, médiane/p95, effet du plafond MAX_EXPANDED_PAGES.
 * Rapport : lignes `CORPUS_REPORT {json}` sur stderr.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupByDocument, MAX_EXPANDED_PAGES, postingsOf, searchPages, vocabulary } from "../../src/core/bm25";
import { decodeIndexForSearch } from "../../src/core/codec/decode";
import { fingerprint, type PdfEntry } from "../../src/core/manifest";
import { createIndexer, type PdfDocumentLike } from "../../src/indexer/indexer";
import { createLoadPdf, type PdfjsLoader } from "../../src/indexer/loadPdf";
import { createSearchStore } from "../../src/search/searchStore";
import type { PetalStore } from "../../src/siyuan/petalStore";
import {
  parseBudgetMinutes,
  pendingEntries,
  selectCorpusNames,
  summarizeTimings,
} from "./corpusTools";

const CORPUS_DIR = process.env["CORPUS_DIR"] ?? "/Users/francois/Documents/DocFastExplorer/data/documents";
const DSX_OUT =
  process.env["DSX_OUT"] ??
  "/private/tmp/claude-501/-Users-francois-siyuhan-docseeker/c15e2439-27f9-4b2a-b077-6141e8ac46d8/scratchpad/corpus-idx";
const PDFJS_DIR = process.env["PDFJS_DIR"] ?? "/Applications/SiYuan.app/Contents/Resources/stage/protyle/js/pdf";
const LIMIT = Number(process.env["CORPUS_LIMIT"]);
const FILTER = process.env["CORPUS_FILES"];
const BUDGET_MS = parseBudgetMinutes(process.env["CORPUS_BUDGET_MIN"]) * 60_000;
const QUERY_RUNS = Math.max(20, Number(process.env["QUERY_RUNS"] ?? "30") || 30);
const MB = 1024 * 1024;
const GC_PASSES = 5;
const SCANNED_SUFFIX = ".scanned";
const QUERIES = ["sévérité bpco", "diabète", "insuffisance cardiaque", "bpco", "traitement", "dia"];
const WIDEST_TERMS = 3;
const MIN_WIDE_TERM_LENGTH = 5;

const report = (kind: string, data: unknown): void => {
  process.stderr.write(`CORPUS_REPORT ${JSON.stringify({ kind, ...(data as object) })}\n`);
};

function settledHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("exécuter avec --expose-gc (npm run measure:corpus)");
  for (let i = 0; i < GC_PASSES; i++) gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

const mb = (bytes: number): number => +(bytes / MB).toFixed(1);
const ms = (value: number): number => +value.toFixed(3);

/** PDF.js de SiYuan chargé en lecture seule ; `getDocument({url})` est servi depuis CORPUS_DIR. */
async function makePdfjs(): Promise<PdfjsLoader> {
  const lib = (await import(/* @vite-ignore */ `${PDFJS_DIR}/pdf.min.mjs`)) as {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(src: unknown): { promise: Promise<PdfDocumentLike>; destroy(): Promise<void> };
  };
  lib.GlobalWorkerOptions.workerSrc = `file://${PDFJS_DIR}/pdf.worker.min.mjs`;
  return {
    getDocument({ url }) {
      const file = join(CORPUS_DIR, decodeURIComponent(url.slice(1)));
      const task = lib.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0, isEvalSupported: false });
      return task;
    },
  };
}

/** Magasin disque limité à DSX_OUT ; le manifeste du pipeline reste en mémoire (un PDF par passe). */
function makeStore(): Pick<PetalStore, "read" | "write" | "remove"> {
  const memory = new Map<string, Uint8Array>();
  const isManifest = (name: string): boolean => name === "manifest.json";
  return {
    async read(name) {
      if (isManifest(name)) return memory.get(name) ?? null;
      const path = join(DSX_OUT, name);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
    async write(name, bytes) {
      if (isManifest(name)) memory.set(name, bytes);
      else writeFileSync(join(DSX_OUT, name), bytes);
    },
    async remove() {
      return false; // jamais de suppression dans le dossier de travail
    },
  };
}

async function indexCorpus(entries: readonly PdfEntry[]): Promise<void> {
  const pdfjs = await makePdfjs();
  const loadPdf = createLoadPdf(() => pdfjs);
  const isDone = (e: PdfEntry): boolean =>
    existsSync(join(DSX_OUT, `${fingerprint(e)}.dsx`)) || existsSync(join(DSX_OUT, `${fingerprint(e)}${SCANNED_SUFFIX}`));
  const todo = pendingEntries(entries, isDone);
  report("index-plan", { retained: entries.length, alreadyDone: entries.length - todo.length, todo: todo.length });
  const started = performance.now();
  for (const [i, entry] of todo.entries()) {
    if (performance.now() - started > BUDGET_MS) {
      report("index-budget-exhausted", { doneThisRun: i, remaining: todo.length - i });
      return;
    }
    const events: { type: string; pages?: number; message?: string }[] = [];
    const indexer = createIndexer({
      discover: async () => ({ manifest: [entry], issues: [], complete: true, unsized: [] }),
      store: makeStore(),
      loadPdf,
      now: Date.now,
      concurrency: 1,
    });
    indexer.onEvent((event) => {
      if (event.type !== "progress") events.push(event);
    });
    const t0 = performance.now();
    await indexer.start();
    const seconds = (performance.now() - t0) / 1000;
    const outcome = events.find((e) => ["indexed", "skipped-scanned", "failed"].includes(e.type));
    const dsx = join(DSX_OUT, `${fingerprint(entry)}.dsx`);
    if (outcome?.type === "skipped-scanned") writeFileSync(join(DSX_OUT, `${fingerprint(entry)}${SCANNED_SUFFIX}`), "");
    report("index-file", {
      n: `${i + 1}/${todo.length}`,
      name: entry.path,
      outcome: outcome?.type ?? "unknown",
      message: outcome?.message,
      pages: outcome?.pages,
      pdfMB: mb(entry.size),
      dsxKB: existsSync(dsx) ? +(statSync(dsx).size / 1024).toFixed(1) : null,
      seconds: +seconds.toFixed(1),
    });
    (globalThis as { gc?: () => void }).gc?.();
  }
}

function dsxNames(): string[] {
  return readdirSync(DSX_OUT).filter((n) => n.endsWith(".dsx")).sort();
}

describe("corpus réel", () => {
  it("indexe, charge à froid et interroge", async () => {
    mkdirSync(DSX_OUT, { recursive: true });
    const names = selectCorpusNames(readdirSync(CORPUS_DIR), { limit: LIMIT, filter: FILTER });
    expect(names.length, `aucun PDF retenu dans ${CORPUS_DIR}`).toBeGreaterThan(0);
    const entries: PdfEntry[] = names.map((name) => {
      const stat = statSync(join(CORPUS_DIR, name));
      return { path: name, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) };
    });

    // (a) indexation
    await indexCorpus(entries);
    const wanted = new Set(entries.map((e) => `${fingerprint(e)}.dsx`));
    const present = dsxNames().filter((n) => wanted.has(n));
    expect(present.length, "aucun .dsx produit").toBeGreaterThan(0);
    const dsxBytes = present.reduce((sum, n) => sum + statSync(join(DSX_OUT, n)).size, 0);

    // (b) chargement à froid, restreint aux .dsx du corpus retenu
    const warnings: string[] = [];
    const store = createSearchStore({
      store: {
        list: async () => present,
        read: async (name) => new Uint8Array(readFileSync(join(DSX_OUT, name))),
      },
      decode: decodeIndexForSearch,
      onWarn: (message) => warnings.push(message),
    });
    const heapBefore = settledHeap();
    const t0 = performance.now();
    await store.load();
    const loadSeconds = (performance.now() - t0) / 1000;
    const heapAfter = settledHeap();
    const index = store.getIndex();
    const totalTokens = index.segments.reduce((sum, s) => sum + s.totalTokens, 0);
    const distinctTermsSum = index.segments.reduce((sum, s) => sum + s.terms.length, 0);
    const postingsTotal = index.segments.reduce((sum, s) => sum + s.pages.length, 0);
    report("cold-load", {
      docs: store.listDocs().length,
      failed: warnings.length,
      pages: index.pageCount,
      words: totalTokens,
      distinctTermsSumPerDoc: distinctTermsSum,
      postings: postingsTotal,
      loadSeconds: +loadSeconds.toFixed(2),
      dsxMB: mb(dsxBytes),
      heapMB: mb(heapAfter - heapBefore),
      heapOverDsx: +((heapAfter - heapBefore) / dsxBytes).toFixed(2),
      kbPerPage: +((heapAfter - heapBefore) / 1024 / index.pageCount).toFixed(2),
      rssMB: mb(process.memoryUsage().rss),
    });
    expect(store.listDocs().length).toBeGreaterThan(0);

    // (c) requêtes : requêtes fixes + les termes les plus fréquents (requêtes les plus larges)
    const vocab = vocabulary(index).filter((t) => /^[a-z]+$/.test(t) && t.length >= MIN_WIDE_TERM_LENGTH);
    const widest = vocab
      .map((t) => [t, postingsOf(index, t).length] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, WIDEST_TERMS)
      .map(([t]) => t);
    for (const query of [...QUERIES, ...widest]) {
      searchPages(index, query); // échauffement (JIT), hors mesure
      const searchOnly: number[] = [];
      const total: number[] = [];
      let hitsLength = 0;
      let documents = 0;
      for (let run = 0; run < QUERY_RUNS; run++) {
        const a = performance.now();
        const hits = searchPages(index, query);
        const b = performance.now();
        const grouped = groupByDocument(hits);
        const c = performance.now();
        searchOnly.push(b - a);
        total.push(c - a);
        hitsLength = hits.length;
        documents = grouped.length;
      }
      const s = summarizeTimings(total);
      const so = summarizeTimings(searchOnly);
      report("query", {
        query,
        pageHits: hitsLength,
        documents,
        searchMsMedian: ms(so.median),
        totalMsMedian: ms(s.median),
        totalMsP95: ms(s.p95),
        totalMsMax: ms(s.max),
        runs: s.runs,
      });
    }

    // Effet du plafond MAX_EXPANDED_PAGES : mémoire retenue par les résultats groupés seuls
    // (les PageHit ne survivent que par les `pages` de chaque DocumentHit ; la liste plate est relâchée).
    for (const query of widest) {
      const base = settledHeap();
      const grouped = groupByDocument(searchPages(index, query));
      const retained = Math.max(0, settledHeap() - base); // bruit de GC possible sur de petits résultats
      const returned = grouped.reduce((sum, d) => sum + d.pages.length, 0);
      const matching = grouped.reduce((sum, d) => sum + d.matchingPages, 0);
      const perPage = returned > 0 ? retained / returned : 0;
      report("cap", {
        query,
        cap: MAX_EXPANDED_PAGES,
        documents: grouped.length,
        cappedDocs: grouped.filter((d) => d.matchingPages > MAX_EXPANDED_PAGES).length,
        matchingPages: matching,
        returnedPages: returned,
        retainedKB: +(retained / 1024).toFixed(1),
        bytesPerReturnedPage: +perPage.toFixed(1),
        uncappedEstimateKB: +((perPage * matching) / 1024).toFixed(1),
      });
    }
    expect(warnings).toEqual([]);
  });
});
