/**
 * Diagnostic technique « spike M0 » : à exécuter DANS un SiYuan réel (commande du plugin).
 * Module pur et injectable : aucun accès à window/document ; tout vient de `M0Deps`.
 * Aucun secret n'est lu ni écrit : seuls des chemins, tailles et statuts HTTP apparaissent dans le rapport.
 */
import type { PdfEntry } from "../core/manifest";
import { ensureWorkerSrc } from "../indexer/loadPdf";
import { discoverPdfs } from "../siyuan/discovery";
import type { FetchLike, KernelApi } from "../siyuan/kernelApi";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly durationMs: number;
}

export interface M0Report {
  readonly results: readonly CheckResult[];
  /** Vrai si aucun check n'est en échec (les checks ignorés ne comptent pas). */
  readonly ok: boolean;
}

export interface PdfjsLike {
  readonly version?: string;
  GlobalWorkerOptions?: { workerSrc?: string };
  getDocument(src: { url: string }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: readonly unknown[] }> }>;
      destroy?(): unknown;
    }>;
  };
}

export interface M0Deps {
  readonly kernel: Pick<KernelApi, "readDir" | "getFile" | "putFile" | "removeFile" | "headAsset">;
  readonly fetch: FetchLike;
  readonly pdfjs: PdfjsLike | undefined;
  /** Message de l'échec de chargement de PDF.js, rapporté quand `pdfjs` est absent. */
  readonly pdfjsError?: string;
  readonly createWorker?: (url: string) => { terminate(): void; onerror: unknown };
  readonly now: () => number;
  readonly petalDir: string;
  readonly payloadBytes?: number;
  /** Lecture seule (mobile) : le dossier du plugin est synchronisé, le test d'écriture/lecture n'écrit donc rien. */
  readonly readOnly?: boolean;
}

export const DEFAULT_PAYLOAD_BYTES = 50 * 1024 * 1024;
export const PDF_WORKER_URL = "/stage/protyle/js/pdf/pdf.worker.min.mjs";
const MAX_DETAIL_LENGTH = 200;
const RANDOM_CHUNK = 65_536;
const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_SECOND = 1000;
const HTTP_PARTIAL = 206;
const HTTP_OK = 200;
const RANGE_HEADER = "bytes=0-1023";

interface Outcome {
  readonly status: CheckStatus;
  readonly detail: string;
}

const pass = (detail: string): Outcome => ({ status: "pass", detail });
const fail = (detail: string): Outcome => ({ status: "fail", detail });
const skip = (detail: string): Outcome => ({ status: "skip", detail });

const truncate = (text: string): string => text.slice(0, MAX_DETAIL_LENGTH);
const messageOf = (error: unknown): string => truncate(error instanceof Error ? error.message : String(error));

/** Même encodage que kernelApi (non exporté) : par segment, les `/` sont conservés. */
const assetUrl = (manifestPath: string): string =>
  `/${manifestPath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += RANDOM_CHUNK) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + RANDOM_CHUNK, length)));
  }
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

interface Pdfs {
  readonly biggest: PdfEntry;
  readonly smallest: PdfEntry;
}

async function checkDiscovery(deps: M0Deps): Promise<{ outcome: Outcome; pdfs: Pdfs | undefined; none: boolean }> {
  const result = await discoverPdfs({ api: deps.kernel });
  const manifest = result.manifest;
  const first = manifest[0];
  if (first === undefined) {
    const detail = `0 PDF trouvé (complet : ${result.complete ? "oui" : "non"}, ${result.issues.length} anomalie(s))`;
    return { outcome: result.complete ? pass(detail) : fail(detail), pdfs: undefined, none: true };
  }
  let biggest = first;
  let smallest = first;
  for (const entry of manifest) {
    if (entry.size > biggest.size) biggest = entry;
    // Un PDF vide (0 octet) ne peut pas être ouvert : on teste PDF.js sur le plus petit PDF non vide.
    if (entry.size > 0 && (smallest.size === 0 || entry.size < smallest.size)) smallest = entry;
  }
  const detail =
    `${manifest.length} PDF, ${result.complete ? "complet" : `incomplet (${result.issues.length} anomalie(s))`}, ` +
    `plus gros : ${biggest.path} (${biggest.size} octets)`;
  return { outcome: result.complete ? pass(detail) : fail(detail), pdfs: { biggest, smallest }, none: false };
}

async function checkHead(deps: M0Deps, pdf: PdfEntry): Promise<Outcome> {
  const head = await deps.kernel.headAsset(`/${pdf.path}`) // headAsset encode lui-même;
  return pass(`Content-Length lu : ${head.size} octets pour ${pdf.path}`);
}

async function checkRange(deps: M0Deps, pdf: PdfEntry): Promise<Outcome> {
  const response = await deps.fetch(assetUrl(pdf.path), {
    method: "GET",
    credentials: "same-origin",
    headers: { Range: RANGE_HEADER },
  });
  try {
    await response.body?.cancel();
  } catch {
    // l'annulation du corps est facultative
  }
  if (response.status === HTTP_PARTIAL) return pass(`HTTP 206 : Range pris en charge sur ${pdf.path}`);
  if (response.status === HTTP_OK) return fail("HTTP 200 : pas de Range (le fichier est renvoyé en entier)");
  return fail(`HTTP ${response.status} inattendu pour une requête Range`);
}

async function probeRoundtrip(deps: M0Deps, path: string, size: number): Promise<Outcome> {
  const payload = randomBytes(size);
  const start = deps.now();
  await deps.kernel.putFile(path, payload);
  const back = await deps.kernel.getFile(path);
  const seconds = Math.max(deps.now() - start, 1) / MS_PER_SECOND;
  if (back.length !== payload.length) {
    return fail(`taille différente après relecture : ${back.length} octets au lieu de ${payload.length}`);
  }
  if (!sameBytes(payload, back)) return fail("octets différents après relecture");
  const mibPerSecond = (2 * size) / BYTES_PER_MIB / seconds;
  return pass(`${size} octets écrits puis relus à l'identique, débit ≈ ${mibPerSecond.toFixed(1)} Mo/s`);
}

async function checkRoundtrip(deps: M0Deps): Promise<Outcome> {
  if (deps.readOnly === true) return skip("écriture ignorée : mode lecture seule (le dossier du plugin est synchronisé)");
  const path = `${deps.petalDir}/m0-probe.bin`;
  let outcome: Outcome;
  let removalError: string | undefined;
  try {
    outcome = await probeRoundtrip(deps, path, deps.payloadBytes ?? DEFAULT_PAYLOAD_BYTES);
  } catch (error) {
    outcome = fail(messageOf(error));
  } finally {
    try {
      await deps.kernel.removeFile(path);
    } catch (error) {
      removalError = messageOf(error);
    }
  }
  if (removalError === undefined) return outcome;
  const previous = outcome.status === "fail" ? `${outcome.detail} ; ` : "";
  return fail(truncate(`${previous}removeFile a échoué : ${removalError}`));
}

async function checkPdfjs(deps: M0Deps, pdf: PdfEntry): Promise<Outcome> {
  const pdfjs = deps.pdfjs;
  if (pdfjs === undefined) {
    const cause = deps.pdfjsError === undefined ? "" : ` : ${deps.pdfjsError}`;
    return fail(truncate(`pdfjs indisponible (window.pdfjsLib non défini)${cause}`));
  }
  // Même préparation que l'indexeur ; si GlobalWorkerOptions est absent, PDF.js produit son erreur (check en échec).
  ensureWorkerSrc(pdfjs);
  const doc = await pdfjs.getDocument({ url: assetUrl(pdf.path) }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return pass(
      `pdfjs ${pdfjs.version ?? "version inconnue"} : ${pdf.path}, ${doc.numPages} page(s), ` +
        `${content.items.length} item(s) de texte en page 1`,
    );
  } finally {
    await doc.destroy?.();
  }
}

function checkWorker(deps: M0Deps): Outcome {
  if (deps.createWorker === undefined) return skip("createWorker non fourni");
  const worker = deps.createWorker(PDF_WORKER_URL);
  worker.terminate();
  return pass(`Worker same-origin créé puis terminé : ${PDF_WORKER_URL}`);
}

const NO_PDF = "aucun PDF disponible pour ce test";

export async function runM0Diagnostic(deps: M0Deps): Promise<M0Report> {
  const results: CheckResult[] = [];
  const run = async (id: string, label: string, body: () => Promise<Outcome> | Outcome): Promise<void> => {
    const start = deps.now();
    let outcome: Outcome;
    try {
      outcome = await body();
    } catch (error) {
      outcome = fail(messageOf(error));
    }
    results.push({ id, label, ...outcome, durationMs: deps.now() - start });
  };

  let pdfs: Pdfs | undefined;
  let reason = "découverte des PDF en échec";
  await run("discovery", "Découverte des PDF", async () => {
    const found = await checkDiscovery(deps);
    pdfs = found.pdfs;
    if (found.none) reason = NO_PDF;
    return found.outcome;
  });

  const withPdf = (pick: (p: Pdfs) => PdfEntry, test: (pdf: PdfEntry) => Promise<Outcome>) => async (): Promise<Outcome> =>
    pdfs === undefined ? skip(reason) : test(pick(pdfs));
  const biggest = (p: Pdfs): PdfEntry => p.biggest;
  const smallest = (p: Pdfs): PdfEntry => p.smallest;

  await run("head", "HEAD /assets (Content-Length)", withPdf(biggest, (pdf) => checkHead(deps, pdf)));
  await run("range", "Requête Range (206)", withPdf(biggest, (pdf) => checkRange(deps, pdf)));
  await run("roundtrip", "Écriture/lecture putFile/getFile", () => checkRoundtrip(deps));
  await run("pdfjs", "PDF.js (getDocument + texte)", withPdf(smallest, (pdf) => checkPdfjs(deps, pdf)));
  await run("worker", "Worker module same-origin", () => checkWorker(deps));
  await run("auth", "Authentification (session expirée)", () =>
    skip("non testable automatiquement : vérifier en faisant expirer la session puis en relançant une requête noyau"),
  );

  return { results, ok: results.every((r) => r.status !== "fail") };
}

const TAGS: Record<CheckStatus, string> = { pass: "OK", fail: "ÉCHEC", skip: "IGNORÉ" };

export function formatReport(report: M0Report): string {
  const count = (status: CheckStatus): number => report.results.filter((r) => r.status === status).length;
  const lines = report.results.map((r) => `[${TAGS[r.status]}] ${r.label} — ${r.detail}`);
  const failures = count("fail");
  const verdict = failures === 0 ? "aucun échec" : `${failures} échec(s)`;
  lines.push("", `Résumé : ${count("pass")} OK, ${failures} échec(s), ${count("skip")} ignoré(s) — ${verdict}`);
  return lines.join("\n");
}
