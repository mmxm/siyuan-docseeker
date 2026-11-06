#!/usr/bin/env node
// Banc d'essai : lance un noyau SiYuan jetable (autre port, autre workspace) avec le plugin installé,
// pour tester dans une vraie interface sans toucher à ~/SiYuan. Usage : node scripts/dev-sandbox.mjs <commande> [--dir D] [--port P] [--pdfs N]
// Commandes : start, stop, reset, status, install. Variable DOCSEEKER_KERNEL : chemin du binaire SiYuan-Kernel.
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUNDLE_ENTRIES, MARKER, PLUGIN_NAME, assertDeletable, assertPortAllowed, assertSandboxDirAllowed, buildPetals,
  isSandboxKernelCommand, kernelArgs, parseArgs,
} from "./lib/sandboxCore.mjs";
import { makeCorpus } from "./lib/testCorpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KERNEL = process.env.DOCSEEKER_KERNEL || "/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel";

const paths = (dir) => ({
  dir,
  workspace: join(dir, "workspace"),
  home: join(dir, "home"),
  pidFile: join(dir, "kernel.pid"),
  stateFile: join(dir, "sandbox.json"),
  log: join(dir, "kernel.log"),
  plugin: join(dir, "workspace", "data", "plugins", PLUGIN_NAME),
  petals: join(dir, "workspace", "data", "storage", "petal", "petals.json"),
});

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fail(`${what} illisible (${file}) : ${e.message}`);
  }
}

function readPid(p) {
  if (!existsSync(p.pidFile)) return null;
  const pid = Number(readFileSync(p.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) fail(`fichier pid invalide : ${p.pidFile}`);
  return pid;
}

/** "none" (pas de processus), "kernel" (c'est bien le noyau jetable), ou erreur si autre chose. */
function kernelState(p, pid) {
  if (pid === null) return "none";
  let cmd;
  try {
    cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "none"; // ps échoue quand le pid n'existe pas
  }
  if (isSandboxKernelCommand(cmd, p.workspace)) return "kernel";
  return fail(`le pid ${pid} n'est pas le noyau jetable de ${p.workspace} (commande : ${cmd}). Rien n'est tué.`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

async function fetchVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/system/version`, { signal: AbortSignal.timeout(2000) });
  const body = await res.json();
  return body.data;
}

/** Un noyau neuf n'exécute pas les plugins tant que la confiance au marché n'est pas donnée (bazaar.trust) : on l'active, puis on vérifie. */
async function trustAndVerifyPlugin(port) {
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    if (json.code !== 0) fail(`${path} a échoué : ${json.msg}`);
    return json.data;
  };
  await post("/api/setting/setBazaar", { trust: true });
  const loaded = await post("/api/petal/loadPetals", { frontend: "browser-desktop" });
  if (!Array.isArray(loaded) || !loaded.some((x) => x.name === PLUGIN_NAME && x.enabled)) {
    fail(`le noyau ne charge pas le plugin ${PLUGIN_NAME} (loadPetals : ${JSON.stringify(loaded).slice(0, 200)})`);
  }
}

function countPdfs(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countPdfs(join(dir, e.name));
    else if (e.name.toLowerCase().endsWith(".pdf")) n++;
  }
  return n;
}

function installBundle(p) {
  if (!existsSync(join(ROOT, "dist", "index.js"))) fail("dist/index.js absent : lancez `npm run build` d'abord");
  mkdirSync(p.plugin, { recursive: true });
  const copied = [];
  for (const entry of BUNDLE_ENTRIES) {
    const src = entry === "index.js" ? join(ROOT, "dist", "index.js") : join(ROOT, entry);
    if (!existsSync(src)) {
      if (entry === "index.js" || entry === "plugin.json") fail(`fichier requis absent : ${src}`);
      console.warn(`avertissement : ${src} absent, ignoré`);
      continue;
    }
    cpSync(src, join(p.plugin, entry), { recursive: true });
    copied.push(entry);
  }
  const manifest = readJson(join(ROOT, "plugin.json"), "plugin.json");
  const existing = existsSync(p.petals) ? readJson(p.petals, "petals.json") : [];
  mkdirSync(dirname(p.petals), { recursive: true });
  writeFileSync(p.petals, JSON.stringify(buildPetals(manifest, existing), null, "\t") + "\n");
  return copied;
}

function writePdfs(p, count) {
  let written = 0;
  for (const f of makeCorpus(count)) {
    const target = join(p.workspace, "data", f.relPath);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
    written++;
  }
  return written;
}

async function start(args) {
  const dir = assertSandboxDirAllowed(args.dir);
  const p = paths(dir);
  if (!existsSync(KERNEL)) fail(`noyau introuvable : ${KERNEL} (variable DOCSEEKER_KERNEL pour un autre chemin)`);
  if (kernelState(p, readPid(p)) === "kernel") fail(`le noyau jetable tourne déjà (pid ${readPid(p)}). Utilisez stop.`);
  if (!(await portFree(args.port))) fail(`le port ${args.port} est déjà utilisé`);

  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, MARKER))) writeFileSync(join(dir, MARKER), "Dossier jetable créé par scripts/dev-sandbox.mjs. Ne pas y mettre de données.\n");
  mkdirSync(p.workspace, { recursive: true });
  mkdirSync(p.home, { recursive: true });
  mkdirSync(join(p.workspace, "data", "assets"), { recursive: true });
  const copied = installBundle(p);
  const written = writePdfs(p, args.pdfs);

  const logFd = openSync(p.log, "a");
  let child;
  try {
    child = spawn(KERNEL, kernelArgs({ port: args.port, workspace: p.workspace, homeDir: p.home }), {
      detached: true, stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  let exited = null;
  child.once("exit", (code, sig) => { exited = `code ${code}, signal ${sig}`; });
  child.once("error", (e) => { exited = `erreur de lancement : ${e.message}`; });
  child.unref();
  if (!child.pid) { await sleep(100); fail(`le noyau n'a pas démarré (${exited ?? "pid inconnu"})`); }
  writeFileSync(p.pidFile, `${child.pid}\n`);
  writeFileSync(p.stateFile, JSON.stringify({ port: args.port }) + "\n");

  const deadline = Date.now() + 60_000;
  let version;
  while (version === undefined) {
    if (exited) fail(`le noyau s'est arrêté au démarrage (${exited}). Journal : ${p.log}`);
    try {
      version = await fetchVersion(args.port);
    } catch {
      if (Date.now() > deadline) fail(`le noyau ne répond pas sur le port ${args.port} après 60 s. Journal : ${p.log}`);
      await sleep(300);
    }
  }
  await trustAndVerifyPlugin(args.port);
  console.log(`Noyau jetable prêt : version ${version}, pid ${child.pid}, plugin installé (${copied.join(", ")}) et chargé par le noyau, ${written} PDF créés.`);
  console.log(`URL : http://127.0.0.1:${args.port}/`);
  console.log(`Dossier : ${dir}`);
}

async function stop(args) {
  const dir = assertSandboxDirAllowed(args.dir);
  const p = paths(dir);
  const pid = readPid(p);
  if (kernelState(p, pid) === "none") { console.log("Aucun noyau jetable en cours (rien à arrêter)."); return; }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (kernelState(p, pid) === "none") { console.log(`Noyau jetable arrêté (pid ${pid}). Rien n'a été supprimé.`); return; }
  }
  fail(`le noyau (pid ${pid}) ne s'arrête pas après 10 s ; arrêtez-le à la main`);
}

async function reset(args) {
  const dir = assertDeletable(args.dir);
  const p = paths(dir);
  if (kernelState(p, readPid(p)) === "kernel") fail("le noyau jetable tourne : lancez d'abord `stop`");
  rmSync(dir, { recursive: true, force: false });
  console.log(`Dossier jetable supprimé : ${dir}`);
}

async function status(args) {
  const dir = assertSandboxDirAllowed(args.dir);
  const p = paths(dir);
  if (!existsSync(join(dir, MARKER))) { console.log(`Aucun banc d'essai dans ${dir}.`); return; }
  const pid = readPid(p);
  const running = kernelState(p, pid) === "kernel";
  const port = existsSync(p.stateFile) ? readJson(p.stateFile, "sandbox.json").port : args.port;
  console.log(`Dossier : ${dir}`);
  console.log(`État : ${running ? "en cours" : "arrêté"}`);
  console.log(`Port : ${port}`);
  console.log(`PID : ${running ? pid : "-"}`);
  console.log(`URL : ${running ? `http://127.0.0.1:${port}/` : "-"}`);
  console.log(`PDF : ${countPdfs(join(p.workspace, "data", "assets"))}`);
  if (running) {
    try { console.log(`Version du noyau : ${await fetchVersion(port)}`); } catch (e) { console.log(`Version du noyau : injoignable (${e.message})`); }
  }
}

async function install(args) {
  const dir = assertSandboxDirAllowed(args.dir);
  const p = paths(dir);
  if (!existsSync(join(dir, MARKER)) || !existsSync(p.workspace)) fail(`aucun banc d'essai dans ${dir} : lancez d'abord \`start\``);
  const copied = installBundle(p);
  const running = kernelState(p, readPid(p)) === "kernel";
  console.log(`Plugin réinstallé (${copied.join(", ")}) ; PDF inchangés.`);
  if (running) console.log("Rechargez la page du navigateur (F5) pour charger le nouveau bundle.");
}

const COMMANDS = { start, stop, reset, status, install };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertPortAllowed(args.port);
  await COMMANDS[args.command](args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`dev-sandbox : ${e.message}`);
    process.exitCode = 1;
  });
}
