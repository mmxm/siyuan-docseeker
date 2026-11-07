/**
 * Petit client typé de l'API HTTP du noyau SiYuan (sans dépendance).
 *
 * VÉRIFIÉ (code Go du noyau, kernel/api/file.go + kernel/apicontract/*.go, lu via `gh api`) :
 *  - Tous les endpoints sont en POST. readDir, getFile, removeFile, renameFile reçoivent un corps JSON
 *    ({path} ; renameFile : {path,newPath}) ; putFile reçoit un multipart (path, isDir, modTime, file).
 *  - Endpoints JSON : réponse HTTP 200 avec l'enveloppe {code,msg,data} ; code 0 = succès, sinon échec
 *    (404 chemin absent, 409 conflit, 403, 400, 500, -1 erreur générique, -3 notebook chiffré).
 *  - getFile : succès = HTTP 200 + octets bruts ; échec = HTTP 202 (ErrorStatus: 202) + enveloppe JSON.
 *    Un fichier absent ne se reconnaît donc pas au statut mais au `code` 404 de l'enveloppe. Un fichier
 *    JSON légitime est renvoyé en 200 : seul le statut 200 vaut succès (même règle que better-sync).
 *  - readDir : data = [{name,isDir,isSymlink,updated}] ; `updated` est en SECONDES (ModTime().Unix()).
 *    putFile : `modTime` en MILLISECONDES. Les chemins sont relatifs à la racine du workspace (/data/...).
 *  - renameFile : 409 si la destination existe déjà (pas d'écrasement) ; crée le dossier parent.
 *  - putFile crée les dossiers parents ; refuse (400) un nom de fichier invalide à la création.
 *
 * NotFoundError n'est émis que si l'enveloppe du noyau porte code 404. Un HTTP 404 brut (proxy, mauvaise
 * baseUrl) est une KernelApiError : le confondre avec « fichier absent » ferait reconstruire/écraser un
 * index. Seule exception : headAsset (HEAD, réponse sans corps, servi par un handler statique).
 *
 * NON VÉRIFIÉ contre un noyau réel (à valider au spike M0) : HEAD /assets/... et Content-Length
 * (le noyau sert /assets via un handler statique, hors contrat apicontract) ; en-têtes de réponse
 * exposés au navigateur ; limite de taille de putFile ; statut exact renvoyé par le middleware
 * d'authentification (401/403 brut ou enveloppe) quand la session a expiré.
 *
 * Authentification : en webapp, le cookie de session est envoyé par le navigateur
 * (`credentials: 'same-origin'`). Aucun jeton n'est stocké ni lu dans ce code.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
  /** Toujours booléen : une entrée readDir sans `isSymlink` est rejetée (MalformedResponseError). */
  readonly isSymlink: boolean;
  /** Date de modification en SECONDES Unix (telle que renvoyée par readDir). */
  readonly updated: number;
}

export interface AssetHead {
  readonly size: number;
}

/** Résultat de `/api/query/sql` : lignes (objets colonne -> valeur) et indicateur de troncature par le noyau. */
export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

export interface NotebookInfo {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  /** Icône du cahier : code Unicode hexadécimal (« 1f4d4 »), ou chaîne vide. */
  readonly icon: string;
}

/** Document renvoyé par `listDocsByPath` (enfants directs d'un cahier ou d'un document). */
export interface DocFile {
  /** `blocks.path` complet (« /ID1/ID2.sy »). */
  readonly path: string;
  readonly name: string;
  /** Icône : code Unicode hexadécimal, ou chaîne vide. */
  readonly icon: string;
  /** Nombre de documents enfants (0 : feuille). */
  readonly subFileCount: number;
}

/** Résultat de `searchDocs`. `path` vaut « / » pour un cahier. */
export interface DocSearchHit {
  readonly path: string;
  /** Chemin lisible, nom du cahier compris (« Cahier/Parent/Document »). */
  readonly hPath: string;
  readonly title: string;
  readonly box: string;
  readonly boxIcon: string;
}

export interface KernelApi {
  /**
   * Chaque méthode accepte un `signal` optionnel (annulation par l'appelant, propagée telle quelle) et
   * échoue avec KernelTimeoutError si le noyau ne répond pas dans le délai configuré.
   */
  readDir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[]>;
  getFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** `modTime` en millisecondes (défaut : maintenant). */
  putFile(path: string, bytes: Uint8Array, modTime?: number, signal?: AbortSignal): Promise<void>;
  removeFile(path: string, signal?: AbortSignal): Promise<void>;
  renameFile(path: string, newPath: string, signal?: AbortSignal): Promise<void>;
  headAsset(url: string, signal?: AbortSignal): Promise<AssetHead>;
  /** SQL en lecture du noyau. Sans LIMIT explicite le noyau tronque à 64 lignes : l'appelant fixe toujours un LIMIT. */
  sql(stmt: string, signal?: AbortSignal): Promise<SqlResult>;
  /** Liste des cahiers (fermés compris). */
  lsNotebooks(signal?: AbortSignal): Promise<readonly NotebookInfo[]>;
  /** Enfants directs de `path` (« / » : racine du cahier) ; l'arbre se lit paresseusement, un niveau à la fois. */
  listDocsByPath(notebook: string, path: string, signal?: AbortSignal): Promise<readonly DocFile[]>;
  /** Documents et cahiers dont le nom contient `k` (recherche de la boîte « Spécifier le chemin »). */
  searchDocs(k: string, signal?: AbortSignal): Promise<readonly DocSearchHit[]>;
  /** Chemins lisibles (« Cahier/Parent/Document ») des documents donnés ; une erreur de format si le noyau n'en renvoie pas autant. */
  getHPathsByPaths(paths: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

export interface KernelApiOptions {
  readonly fetch?: FetchLike;
  /** Préfixe d'URL (vide en webapp, même origine). */
  readonly baseUrl?: string;
  /** Délai maximal par appel, corps de réponse compris (défaut : DEFAULT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/** Délai par défaut d'un appel au noyau. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Longueur maximale du texte de réponse recopié dans un message d'erreur. */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

const CODE_OK = 0;
const CODE_NOT_FOUND = 404;
const CODE_CONFLICT = 409;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_PARTIAL_CONTENT = 206;
const CONTENT_RANGE_TOTAL = /^bytes \d+-\d+\/(\d+)$/;
const CODE_UNKNOWN = -1;
const CREDENTIALS_MODE = "same-origin";
const JSON_CONTENT_TYPE = "application/json";
const DECIMAL_INTEGER = /^\d+$/;

/** Échec renvoyé par le noyau ou par la couche HTTP. */
export class KernelApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "KernelApiError";
  }
}

export class NotFoundError extends KernelApiError {
  constructor(status: number, message: string) {
    super(status, CODE_NOT_FOUND, message);
    this.name = "NotFoundError";
  }
}

/** Conflit (ex. renameFile vers une destination existante). */
export class ConflictError extends KernelApiError {
  constructor(status: number, message: string) {
    super(status, CODE_CONFLICT, message);
    this.name = "ConflictError";
  }
}

/** Réponse du noyau structurellement invalide (ex. entrée readDir sans `isSymlink` booléen). */
export class MalformedResponseError extends KernelApiError {
  constructor(status: number, message: string) {
    super(status, CODE_UNKNOWN, message);
    this.name = "MalformedResponseError";
  }
}

/** Le noyau n'a pas encore indexé les métadonnées des documents (requête SQL impossible pour l'instant). */
export class IndexUnavailableError extends KernelApiError {
  constructor(status: number, code: number, message: string) {
    super(status, code, message);
    this.name = "IndexUnavailableError";
  }
}

/** Le noyau n'a pas répondu dans le délai imparti. */
export class KernelTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Kernel request timed out after ${timeoutMs} ms`);
    this.name = "KernelTimeoutError";
  }
}

interface Envelope {
  readonly code: number;
  readonly msg: string;
  readonly data: unknown;
  readonly truncated: unknown;
}

const INDEX_UNAVAILABLE_REASON = "indexUnavailable";
const INDEX_UNAVAILABLE_MESSAGE = "document metadata is not ready";

function isIndexUnavailable(message: string, data: unknown): boolean {
  const reason = typeof data === "object" && data !== null ? (data as Record<string, unknown>).reason : undefined;
  return reason === INDEX_UNAVAILABLE_REASON || message.includes(INDEX_UNAVAILABLE_MESSAGE);
}

function toError(status: number, code: number, message: string, data?: unknown): KernelApiError {
  if (isIndexUnavailable(message, data)) return new IndexUnavailableError(status, code, message);
  if (code === CODE_NOT_FOUND) return new NotFoundError(status, message);
  if (code === CODE_CONFLICT) return new ConflictError(status, message);
  return new KernelApiError(status, code, message);
}

function parseEnvelope(text: string): Envelope | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.code !== "number") return null;
    return { code: record.code, msg: typeof record.msg === "string" ? record.msg : "", data: record.data, truncated: record.truncated };
  } catch {
    return null;
  }
}

const truncate = (text: string): string => text.slice(0, MAX_ERROR_MESSAGE_LENGTH);

/**
 * Convertit une réponse en échec typé ; sert aussi pour les statuts HTTP non prévus.
 * `rawNotFoundIsAbsence` : un 404 sans enveloppe vaut « absent » (HEAD d'un asset uniquement).
 */
async function failureFrom(response: Response, rawNotFoundIsAbsence = false): Promise<KernelApiError> {
  const text = await response.text();
  const envelope = parseEnvelope(text);
  if (envelope !== null && envelope.code !== CODE_OK) {
    return toError(response.status, envelope.code, truncate(envelope.msg), envelope.data);
  }
  const message = truncate(text || `HTTP ${response.status}`);
  if (rawNotFoundIsAbsence && response.status === HTTP_NOT_FOUND) return new NotFoundError(response.status, message);
  return new KernelApiError(response.status, CODE_UNKNOWN, message);
}

async function readEnvelope(response: Response): Promise<Envelope> {
  if (!response.ok) throw await failureFrom(response);
  const text = await response.text();
  const envelope = parseEnvelope(text);
  if (envelope === null) throw new KernelApiError(response.status, CODE_UNKNOWN, "invalid JSON envelope");
  if (envelope.code !== CODE_OK) throw toError(response.status, envelope.code, truncate(envelope.msg), envelope.data);
  return envelope;
}

/** Applique le délai et l'annulation de l'appelant ; robuste à un fetch qui ignore le signal. */
async function withDeadline<T>(
  timeoutMs: number,
  external: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (external?.aborted) throw external.reason;
  const controller = new AbortController();
  const onExternal = (): void => controller.abort(external?.reason);
  external?.addEventListener("abort", onExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new KernelTimeoutError(timeoutMs)), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternal);
  }
}

function isDirEntry(value: unknown): value is DirEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.isDir === "boolean" &&
    typeof entry.isSymlink === "boolean" &&
    typeof entry.updated === "number"
  );
}

function parseDirEntries(data: unknown): readonly DirEntry[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data) || !data.every(isDirEntry)) {
    throw new MalformedResponseError(HTTP_OK, "unexpected readDir payload (name/isDir/isSymlink/updated required)");
  }
  return data.map((entry) => ({
    name: entry.name,
    isDir: entry.isDir,
    isSymlink: entry.isSymlink,
    updated: entry.updated,
  }));
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseSqlResult(envelope: Envelope): SqlResult {
  const { data, truncated } = envelope;
  const rows = data === null || data === undefined ? [] : data;
  if (!Array.isArray(rows) || !rows.every(isPlainRecord)) {
    throw new MalformedResponseError(HTTP_OK, "unexpected sql payload (array of row objects required)");
  }
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new MalformedResponseError(HTTP_OK, "unexpected sql payload (truncated must be a boolean)");
  }
  return { rows: rows.map((row) => ({ ...row })), truncated: truncated === true };
}

function parseNotebooks(data: unknown): readonly NotebookInfo[] {
  const list = isPlainRecord(data) ? data.notebooks : undefined;
  if (
    !Array.isArray(list) ||
    !list.every((n) => isPlainRecord(n) && typeof n.id === "string" && typeof n.name === "string" && typeof n.closed === "boolean")
  ) {
    throw new MalformedResponseError(HTTP_OK, "unexpected lsNotebooks payload (notebooks[{id,name,closed}] required)");
  }
  return (list as Record<string, unknown>[]).map((n) => ({
    id: n["id"] as string,
    name: n["name"] as string,
    closed: n["closed"] as boolean,
    icon: typeof n["icon"] === "string" ? n["icon"] : "",
  }));
}

const malformed = (what: string): MalformedResponseError => new MalformedResponseError(HTTP_OK, `unexpected ${what} payload`);

function parseDocFiles(data: unknown): readonly DocFile[] {
  const files = isPlainRecord(data) ? data["files"] : undefined;
  if (files === null) return [];
  if (!Array.isArray(files)) throw malformed("listDocsByPath (files[] required)");
  return files.map((f: unknown): DocFile => {
    if (!isPlainRecord(f) || typeof f["path"] !== "string" || typeof f["name"] !== "string") throw malformed("listDocsByPath (path, name required)");
    const { icon, subFileCount } = f;
    if ((icon !== undefined && typeof icon !== "string") || (subFileCount !== undefined && typeof subFileCount !== "number")) {
      throw malformed("listDocsByPath (icon must be text, subFileCount a number)");
    }
    return { path: f["path"], name: f["name"], icon: icon ?? "", subFileCount: subFileCount ?? 0 };
  });
}

function parseDocHits(data: unknown): readonly DocSearchHit[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw malformed("searchDocs (array required)");
  return data.map((h: unknown): DocSearchHit => {
    if (!isPlainRecord(h)) throw malformed("searchDocs (object entries required)");
    const { path, hPath, title, box, boxIcon } = h;
    if (typeof path !== "string" || typeof hPath !== "string" || typeof title !== "string" || typeof box !== "string") {
      throw malformed("searchDocs (path, hPath, title, box required)");
    }
    if (boxIcon !== undefined && typeof boxIcon !== "string") throw malformed("searchDocs (boxIcon must be text)");
    return { path, hPath, title, box, boxIcon: boxIcon ?? "" };
  });
}

function parseHPaths(data: unknown): readonly string[] {
  if (!Array.isArray(data) || !data.every((h) => typeof h === "string")) throw malformed("getHPathsByPaths (array of text required)");
  return data as string[];
}

/** Encode chaque segment sans toucher aux `/` (les noms de PDF contiennent espaces, accents). */
function encodeUrlPath(path: string): string {
  const segments = path.split("/").map((segment) => encodeURIComponent(segment));
  return segments.join("/");
}

function parseContentLength(response: Response): number {
  const header = response.headers.get("Content-Length");
  if (header === null || !DECIMAL_INTEGER.test(header.trim())) {
    throw new KernelApiError(response.status, CODE_UNKNOWN, `missing or invalid Content-Length: ${header}`);
  }
  const size = Number(header);
  if (!Number.isSafeInteger(size)) {
    throw new KernelApiError(response.status, CODE_UNKNOWN, `Content-Length out of range: ${header}`);
  }
  return size;
}

export function createKernelApi(options: KernelApiOptions = {}): KernelApi {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const guarded = <T>(external: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    withDeadline(timeoutMs, external, run);

  const postJson = (endpoint: string, body: Record<string, unknown>, external?: AbortSignal): Promise<Envelope> =>
    guarded(external, async (signal) => {
      const response = await doFetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        credentials: CREDENTIALS_MODE,
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify(body),
        signal,
      });
      return readEnvelope(response);
    });

  const getFile = (path: string, external?: AbortSignal): Promise<Uint8Array> =>
    guarded(external, async (signal) => {
      const response = await doFetch(`${baseUrl}/api/file/getFile`, {
        method: "POST",
        credentials: CREDENTIALS_MODE,
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify({ path }),
        signal,
      });
      if (response.status !== HTTP_OK) throw await failureFrom(response);
      return new Uint8Array(await response.arrayBuffer());
    });

  const putFile = (path: string, bytes: Uint8Array, modTime: number, external?: AbortSignal): Promise<void> =>
    guarded(external, async (signal) => {
      const form = new FormData();
      form.append("path", path);
      form.append("isDir", "false");
      form.append("modTime", String(modTime));
      form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), "file");
      // Pas de Content-Type : le navigateur fixe lui-même la frontière multipart.
      const response = await doFetch(`${baseUrl}/api/file/putFile`, {
        method: "POST",
        credentials: CREDENTIALS_MODE,
        body: form,
        signal,
      });
      await readEnvelope(response);
    });

  /** GET `Range: bytes=0-0` : la taille totale est dans `Content-Range: bytes 0-0/<total>`. */
  const sizeFromRangeProbe = async (url: string, signal: AbortSignal): Promise<AssetHead> => {
    const response = await doFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      credentials: CREDENTIALS_MODE,
      signal,
    });
    if (response.status !== HTTP_PARTIAL_CONTENT && !response.ok) throw await failureFrom(response, true);
    // Le corps n'est pas lu (Range ignoré => 200 avec tout le fichier) ; on libère la connexion.
    await response.body?.cancel().catch(() => undefined);
    // Réponse 200 (Range ignoré, ex. fichier vide) : Content-Length est la taille totale.
    if (response.status !== HTTP_PARTIAL_CONTENT) return { size: parseContentLength(response) };
    const total = CONTENT_RANGE_TOTAL.exec(response.headers.get("Content-Range") ?? "")?.[1];
    const size = total === undefined ? Number.NaN : Number(total);
    if (!Number.isSafeInteger(size)) {
      throw new KernelApiError(response.status, CODE_UNKNOWN, "missing or invalid Content-Range total");
    }
    return { size };
  };

  const headAsset = (url: string, external?: AbortSignal): Promise<AssetHead> =>
    guarded(external, async (signal) => {
      const absolute = url.startsWith("/") ? url : `/${url}`;
      const assetUrl = `${baseUrl}${encodeUrlPath(absolute)}`;
      const response = await doFetch(assetUrl, { method: "HEAD", credentials: CREDENTIALS_MODE, signal });
      if (response.ok) return { size: parseContentLength(response) };
      if (response.status !== HTTP_NOT_FOUND) throw await failureFrom(response, true);
      // Constaté (SiYuan 3.8.9) : HEAD répond 404 pour certains noms accentués alors que GET fonctionne.
      return sizeFromRangeProbe(assetUrl, signal);
    });

  return {
    async readDir(path, signal) {
      const envelope = await postJson("/api/file/readDir", { path }, signal);
      return parseDirEntries(envelope.data);
    },
    getFile,
    putFile: (path, bytes, modTime = Date.now(), signal) => putFile(path, bytes, modTime, signal),
    async removeFile(path, signal) {
      await postJson("/api/file/removeFile", { path }, signal);
    },
    async renameFile(path, newPath, signal) {
      await postJson("/api/file/renameFile", { path, newPath }, signal);
    },
    headAsset,
    async sql(stmt, signal) {
      return parseSqlResult(await postJson("/api/query/sql", { stmt }, signal));
    },
    async lsNotebooks(signal) {
      return parseNotebooks((await postJson("/api/notebook/lsNotebooks", {}, signal)).data);
    },
    async listDocsByPath(notebook, path, signal) {
      return parseDocFiles((await postJson("/api/filetree/listDocsByPath", { notebook, path, flashcard: false }, signal)).data);
    },
    async searchDocs(k, signal) {
      return parseDocHits((await postJson("/api/filetree/searchDocs", { k, flashcard: false }, signal)).data);
    },
    async getHPathsByPaths(paths, signal) {
      return parseHPaths((await postJson("/api/filetree/getHPathsByPaths", { paths: [...paths] }, signal)).data);
    },
  };
}
