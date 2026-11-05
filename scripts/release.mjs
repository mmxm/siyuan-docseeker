#!/usr/bin/env node
// Vérifie qu'une release est prête (`npm run release:check`) SANS rien publier :
// pas de commit, pas de tag, pas de push, pas de release GitHub. Affiche ensuite les commandes à lancer à la main.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_ZIP_ENTRIES = ["index.js", "plugin.json", "i18n/fr_FR.json", "README.md", "README_en_US.md", "icon.png"];

// ---------- fonctions pures (testées dans tests/unit/scripts/release.test.ts) ----------

/** Découpe une version stricte `x.y.z` en trois nombres. Lève une erreur sinon. */
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Version invalide : ${JSON.stringify(version)} (attendu x.y.z)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 ou 1 : compare deux versions `x.y.z` numériquement. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Lit le champ `version` d'un JSON (package.json, plugin.json). `label` sert au message d'erreur. */
export function readVersion(jsonText, label) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} : JSON invalide (${error.message})`);
  }
  try {
    parseVersion(data?.version);
  } catch (error) {
    throw new Error(`${label} : ${error.message}`);
  }
  return data.version;
}

/** Entrées de `required` absentes de `entries` (liste de chemins de l'archive), dans l'ordre de `required`. */
export function missingZipEntries(entries, required) {
  const present = new Set(entries);
  return required.filter((entry) => !present.has(entry));
}

/** Commandes manuelles de publication, affichées et jamais exécutées par ce script. */
export function releaseCommands(version) {
  const tag = `v${version}`;
  return [
    `git tag ${tag}`,
    `git push origin ${tag}`,
    `gh release create ${tag} package.zip --title "DocSeeker ${version}" --notes-file CHANGELOG.md`,
  ];
}

// ---------- vérifications (effets de bord : git, npm, unzip, fichiers) ----------

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).replace(/\n+$/, "");
}

function readRootFile(name) {
  return readFileSync(join(ROOT, name), "utf8");
}

function runNpm(script) {
  const result = spawnSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit" });
  return result.status === 0;
}

/** Exécute toutes les vérifications, affiche le résultat et renvoie la liste des échecs. */
function checkRelease() {
  const failures = [];
  const ok = (label) => console.log(`  [OK]    ${label}`);
  const fail = (label) => {
    failures.push(label);
    console.log(`  [ECHEC] ${label}`);
  };

  console.log("Vérifications de release (rien ne sera publié) :");

  const status = git(["status", "--porcelain"]);
  if (status) fail(`arbre git non propre (commiter ou annuler) :\n${status.split("\n").map((l) => `           ${l}`).join("\n")}`);
  else ok("arbre git propre");

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") ok("branche main");
  else fail(`branche « ${branch} » (attendu : main)`);

  let version = null;
  try {
    const pkgVersion = readVersion(readRootFile("package.json"), "package.json");
    const pluginVersion = readVersion(readRootFile("plugin.json"), "plugin.json");
    if (pkgVersion === pluginVersion) {
      version = pkgVersion;
      ok(`version ${version} (package.json == plugin.json)`);
    } else {
      fail(`version différente : package.json ${pkgVersion}, plugin.json ${pluginVersion}`);
    }
  } catch (error) {
    fail(error.message);
  }

  if (version) {
    const changelog = existsSync(join(ROOT, "CHANGELOG.md")) ? readRootFile("CHANGELOG.md") : "";
    if (new RegExp(`^## ${version.replaceAll(".", "\\.")}\\b`, "m").test(changelog)) ok(`CHANGELOG.md contient la section ${version}`);
    else fail(`CHANGELOG.md : pas de section « ## ${version} »`);

    const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
    if (tags.includes(`v${version}`)) {
      fail(`le tag v${version} existe déjà`);
    } else {
      const notNewer = tags.filter((tag) => {
        try {
          return compareVersions(tag.slice(1), version) >= 0;
        } catch {
          return false; // tag qui n'est pas une version : ignoré
        }
      });
      if (notNewer.length) fail(`version non croissante par rapport aux tags existants : ${notNewer.join(", ")}`);
      else ok(`tag v${version} absent, version plus récente que les tags existants`);
    }
  }

  for (const script of ["typecheck", "test"]) {
    if (runNpm(script)) ok(`npm run ${script}`);
    else fail(`npm run ${script}`);
  }

  if (runNpm("package")) {
    ok("npm run package (build + package.zip)");
    const entries = execFileSync("unzip", ["-Z1", join(ROOT, "package.zip")], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    console.log(`  Contenu de package.zip : ${entries.join(", ")}`);
    const missing = missingZipEntries(entries, REQUIRED_ZIP_ENTRIES);
    if (missing.length) fail(`package.zip : entrées manquantes ${missing.join(", ")}`);
    else ok("package.zip contient index.js, plugin.json, i18n, README (FR et EN), icon.png");
  } else {
    fail("npm run package");
  }

  return { failures, version };
}

// Exécuté seulement en ligne de commande (pas à l'import par les tests).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { failures, version } = checkRelease();
  console.log("");
  if (failures.length) {
    console.log(`Release NON prête : ${failures.length} vérification(s) en échec. Rien n'a été publié.`);
    process.exitCode = 1;
  } else {
    console.log(`Release ${version} prête. Rien n'a été publié.`);
  }
  if (version) {
    console.log("Commandes de publication à lancer à la main (après commit et push de main) :");
    for (const command of releaseCommands(version)) console.log(`  ${command}`);
  }
}
