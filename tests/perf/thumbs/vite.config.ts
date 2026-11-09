/**
 * Banc de mesure des vignettes dans un vrai navigateur : `npm run measure:thumbs`, puis ouvrir l'URL affichée.
 *
 * - À exécuter dans une page VISIBLE : PDF.js n'achève pas un rendu dans un onglet masqué.
 * - Sur iPhone, seulement en HTTPS : Safari ralentit fortement JS/WASM en HTTP non sécurisé (le serveur écoute en local
 *   uniquement ; pour un téléphone, passer par un tunnel HTTPS).
 * - Variables : BENCH_PORT (5198), PDFJS_DIR (stage/protyle/js de SiYuan.app), CORPUS_DIR (corpus DocFastExplorer).
 *   Les deux dossiers sont servis en lecture seule, sans sortie de dossier possible.
 * - Routes : /stage/protyle/js/*, /assets/* (Range, 206), /__stats, /__reset, /__list.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { parseRangeHeader, resolveInside } from "./serverTools";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROJECT = fileURLToPath(new URL("../../../", import.meta.url));
const PORT = Number(process.env["BENCH_PORT"] ?? 5198);
const PDFJS_DIR = process.env["PDFJS_DIR"] ?? "/Applications/SiYuan.app/Contents/Resources/stage/protyle/js";
const CORPUS_DIR = process.env["CORPUS_DIR"] ?? "/Users/francois/Documents/DocFastExplorer/data/documents";
const PDFJS_PREFIX = "/stage/protyle/js/";
const ASSETS_PREFIX = "/assets/";

const stats = { bytes: 0, requests: 0, ranges: 0, full: 0 };

function contentType(rel: string): string {
  if (/\.m?js$/.test(rel)) return "text/javascript";
  if (rel.endsWith(".wasm")) return "application/wasm";
  if (rel.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function serveFile(req: IncomingMessage, res: ServerResponse, root: string, rel: string, counted: boolean): void {
  const file = resolveInside(root, rel);
  let size = 0;
  try {
    const st = file === null ? null : statSync(file);
    if (file === null || st === null || !st.isFile()) throw new Error("absent");
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  const range = parseRangeHeader(req.headers.range, size);
  if (range.kind === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  const start = range.kind === "range" ? range.start : 0;
  const end = range.kind === "range" ? range.end : size - 1;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType(rel));
  res.setHeader("Cache-Control", "no-store");
  if (range.kind === "range") {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (counted) {
    stats.requests++;
    if (range.kind === "range") stats.ranges++;
    else stats.full++;
  }
  const stream = createReadStream(file as string, { start, end });
  if (counted) stream.on("data", (chunk) => (stats.bytes += chunk.length));
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  res.on("close", () => stream.destroy());
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function benchServer(): Plugin {
  return {
    name: "docseeker-thumb-bench",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let url: string;
        try {
          url = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        if (url === "/__stats") return json(res, stats);
        if (url === "/__reset") {
          Object.assign(stats, { bytes: 0, requests: 0, ranges: 0, full: 0 });
          return json(res, stats);
        }
        if (url === "/__list") return json(res, readdirSync(CORPUS_DIR).filter((n) => n.toLowerCase().endsWith(".pdf")));
        if (url.startsWith(PDFJS_PREFIX)) return serveFile(req, res, PDFJS_DIR, url.slice(PDFJS_PREFIX.length), false);
        if (url.startsWith(ASSETS_PREFIX)) return serveFile(req, res, CORPUS_DIR, url.slice(ASSETS_PREFIX.length), true);
        next();
      });
    },
  };
}

export default {
  root: HERE,
  server: { host: "127.0.0.1", port: PORT, strictPort: true, open: false, fs: { allow: [PROJECT] } },
  plugins: [benchServer()],
};
