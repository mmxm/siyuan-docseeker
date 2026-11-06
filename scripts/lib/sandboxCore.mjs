// Logique pure (ou presque) du banc d'essai : arguments, chemins interdits, arguments du noyau, petals.json.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const MARKER = ".docseeker-sandbox";
export const PLUGIN_NAME = "siyuan-docseeker";
export const DEFAULT_PORT = 6807;
export const FORBIDDEN_PORTS = [6806, 55165];
export const COMMANDS = ["start", "stop", "reset", "status", "install"];
export const BUNDLE_ENTRIES = ["index.js", "plugin.json", "i18n", "icon.png", "README.md", "README_en_US.md"];

export function defaultDir() {
  return join(tmpdir(), "docseeker-sandbox");
}

function parseIntStrict(raw, what) {
  if (!/^\d+$/.test(raw)) throw new Error(`${what} invalide : « ${raw} » (entier attendu)`);
  return Number(raw);
}

export function assertPortAllowed(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`port invalide : ${port} (1024 à 65535)`);
  if (FORBIDDEN_PORTS.includes(port)) throw new Error(`port ${port} interdit : réservé au SiYuan réel (${FORBIDDEN_PORTS.join(" et ")})`);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(`commande inconnue ou absente : « ${command ?? ""} ». Commandes : ${COMMANDS.join(", ")}`);
  }
  const out = { command, dir: defaultDir(), port: DEFAULT_PORT, pdfs: 8 };
  for (let i = 0; i < rest.length; i++) {
    let [name, value] = rest[i].split(/=(.*)/s, 2);
    if (!["--dir", "--port", "--pdfs"].includes(name)) throw new Error(`option inconnue : ${rest[i]}`);
    if (value === undefined) {
      value = rest[++i];
      if (value === undefined) throw new Error(`l'option ${name} attend une valeur`);
    }
    if (name === "--dir") out.dir = value;
    else if (name === "--port") out.port = parseIntStrict(value, "port");
    else {
      out.pdfs = parseIntStrict(value, "--pdfs");
      if (out.pdfs < 1) throw new Error(`--pdfs invalide : ${value} (au moins 1)`);
    }
  }
  if (!Number.isSafeInteger(out.pdfs)) throw new Error("--pdfs invalide");
  assertPortAllowed(out.port);
  return out;
}

/** realpath du plus long ancêtre existant, suivi du reste (liens symboliques résolus même si la cible n'existe pas). */
export function realpathDeep(p) {
  const rest = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(cur.slice(parent.length).replace(/^[\\/]/, ""));
    cur = parent;
  }
  return join(realpathSync(cur), ...rest);
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function assertLocation(dir, home) {
  if (typeof dir !== "string" || dir === "") throw new Error("chemin vide : indiquez --dir");
  if (!isAbsolute(dir)) throw new Error(`le chemin doit être absolu : ${dir}`);
  const real = realpathDeep(dir);
  const siyuan = realpathDeep(join(home, "SiYuan"));
  if (inside(real, siyuan) || inside(siyuan, real)) {
    throw new Error(`refus : ${dir} (${real}) est ou contient le dossier SiYuan réel ${siyuan}`);
  }
  for (let cur = real; ; cur = dirname(cur)) {
    if (existsSync(join(cur, "conf", "conf.json")) || existsSync(join(cur, ".siyuan"))) {
      throw new Error(`refus : ${real} est dans un workspace SiYuan existant (${cur})`);
    }
    if (dirname(cur) === cur) break;
  }
  return real;
}

/** Vérifie qu'on peut utiliser `dir` comme dossier jetable. Renvoie son chemin réel. */
export function assertSandboxDirAllowed(dir, { home = homedir() } = {}) {
  const real = assertLocation(dir, home);
  if (existsSync(real) && !existsSync(join(real, MARKER)) && readdirSync(real).length > 0) {
    throw new Error(`refus : ${real} n'est pas vide et n'a pas le marqueur ${MARKER} (dossier non créé par ce script)`);
  }
  return real;
}

/** Vérifie qu'on peut supprimer `dir` : marqueur obligatoire, jamais SiYuan. */
export function assertDeletable(dir, { home = homedir() } = {}) {
  const real = assertLocation(dir, home);
  if (!existsSync(join(real, MARKER))) throw new Error(`refus de supprimer ${real} : marqueur ${MARKER} absent`);
  return real;
}

export function kernelArgs({ port, workspace, homeDir }) {
  assertPortAllowed(port);
  return ["serve", "--port", String(port), "--workspace", workspace, "--home-dir", homeDir, "--accessAuthCode", "", "--lang", "fr_FR"];
}

/** La ligne de commande (ps) est-elle bien celle du noyau jetable de ce workspace ? */
export function isSandboxKernelCommand(command, workspace) {
  if (typeof command !== "string" || !command.includes("SiYuan-Kernel")) return false;
  const marker = `--workspace ${workspace}`;
  const at = command.indexOf(marker);
  if (at < 0) return false;
  const next = command.charAt(at + marker.length);
  return next === "" || next === " ";
}

/** Contenu de data/storage/petal/petals.json avec le plugin activé (format écrit par le noyau). */
export function buildPetals(manifest, existing) {
  if (!manifest || typeof manifest.name !== "string" || !manifest.name) throw new Error("plugin.json : champ name manquant");
  if (!Array.isArray(existing)) throw new Error("petals.json existant : une liste est attendue");
  const dn = manifest.displayName;
  const displayName = (dn && (dn.fr_FR || dn.default)) || manifest.name;
  const entry = {
    name: manifest.name, displayName, version: manifest.version, enabled: true,
    incompatible: false, disabledInPublish: false, userDisabledInPublish: false, disallowInstall: false,
    js: "", css: "", i18n: null, kernel: { js: "", existed: false, incompatible: true },
  };
  const others = existing.filter((p) => p?.name !== manifest.name);
  return [...others, entry];
}
