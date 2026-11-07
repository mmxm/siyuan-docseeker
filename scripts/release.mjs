#!/usr/bin/env node
// Vérifie qu'une release est prête (`npm run release:check`) SANS rien publier :
// pas de commit, pas de tag, pas de push, pas de release GitHub. Affiche ensuite les commandes à lancer à la main.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** Commandes manuelles de publication, affichées et jamais exécutées par ce script. Notes générées comme en CI. */
export function releaseCommands(version) {
  const tag = `v${version}`;
  return [
    `node scripts/release.mjs --ci ${tag} release-notes.md`,
    `git tag ${tag}`,
    `git push origin ${tag}`,
  ];
}

/** Tags `vX.Y.Z` de `tags` dont la version est supérieure ou égale à `version`, hors `currentTag`. Les tags non versionnés sont ignorés. */
export function notNewerTags(version, tags, currentTag) {
  return tags.filter((tag) => {
    if (tag === currentTag) return false;
    try {
      return compareVersions(versionFromTag(tag), version) >= 0;
    } catch {
      return false;
    }
  });
}

/** Chemin absolu du fichier de notes, qui doit rester strictement sous `cwd`. Lève une erreur sinon. */
export function resolveNotesPath(notesPath, cwd) {
  const absolute = resolve(cwd, notesPath);
  const rel = relative(cwd, absolute);
  if (!notesPath || !rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin de notes refusé : ${JSON.stringify(notesPath)} (doit être un fichier sous le répertoire courant)`);
  }
  return absolute;
}

/** `vX.Y.Z` strict -> `X.Y.Z`. Lève une erreur pour tout autre format. */
export function versionFromTag(tag) {
  const match = typeof tag === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(tag) : null;
  if (!match) throw new Error(`Tag invalide : ${JSON.stringify(tag)} (attendu vX.Y.Z)`);
  try {
    parseVersion(match[1]);
  } catch {
    throw new Error(`Tag invalide : ${JSON.stringify(tag)} (attendu vX.Y.Z sans zéro initial)`);
  }
  return match[1];
}

/** Corps de la section `## <version>` du CHANGELOG, sans le titre, jusqu'au prochain `## `. Comparaison littérale. */
export function extractChangelogSection(changelogText, version) {
  const lines = String(changelogText).replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md : pas de section « ## ${version} »`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) throw new Error(`CHANGELOG.md : la section « ## ${version} » est vide`);
  return body;
}

/** Vérifications du mode --ci : tag, package.json, plugin.json et CHANGELOG concordent. Renvoie { version, notes }. */
export function prepareCiRelease({ tag, packageJson, pluginJson, changelog, tags = [] }) {
  const version = versionFromTag(tag);
  const pkgVersion = readVersion(packageJson, "package.json");
  const pluginVersion = readVersion(pluginJson, "plugin.json");
  if (pkgVersion !== version) throw new Error(`package.json (${pkgVersion}) ne correspond pas au tag ${tag}`);
  if (pluginVersion !== version) throw new Error(`plugin.json (${pluginVersion}) ne correspond pas au tag ${tag}`);
  const newer = notNewerTags(version, tags, tag);
  if (newer.length) throw new Error(`version ${version} non strictement supérieure aux tags existants : ${newer.join(", ")}`);
  return { version, notes: extractChangelogSection(changelog, version) };
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
    try {
      extractChangelogSection(changelog, version);
      ok(`CHANGELOG.md contient la section ${version}`);
    } catch (error) {
      fail(error.message);
    }

    const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
    if (tags.includes(`v${version}`)) {
      fail(`le tag v${version} existe déjà`);
    } else {
      const notNewer = notNewerTags(version, tags, `v${version}`);
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
if (isMain && process.argv[2] === "--ci") {
  // Intégration continue : `node scripts/release.mjs --ci vX.Y.Z release-notes.md`. N'exige ni arbre propre ni branche main.
  const [tag, notesPath] = process.argv.slice(3);
  try {
    if (!tag || !notesPath) throw new Error("Usage : node scripts/release.mjs --ci <tag> <fichier-de-notes>");
    const { version, notes } = prepareCiRelease({
      tag,
      packageJson: readRootFile("package.json"),
      pluginJson: readRootFile("plugin.json"),
      changelog: existsSync(join(ROOT, "CHANGELOG.md")) ? readRootFile("CHANGELOG.md") : "",
      tags: git(["tag", "--list", "v*"]).split("\n").filter(Boolean),
    });
    writeFileSync(resolveNotesPath(notesPath, process.cwd()), `${notes}\n`);
    console.log(`Release ${version} cohérente (tag, package.json, plugin.json, CHANGELOG). Notes écrites dans ${notesPath}.`);
  } catch (error) {
    console.error(`ECHEC : ${error.message}`);
    process.exitCode = 1;
  }
} else if (isMain) {
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
