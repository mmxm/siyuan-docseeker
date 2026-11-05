// Assemble package.zip pour SiYuan : index.js (build Vite), plugin.json, i18n/, README.md, README_en_US.md, icon.png.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const stage = join(root, "package");
const archive = join(root, "package.zip");

const required = [
  ["dist/index.js", "index.js"],
  ["plugin.json", "plugin.json"],
  ["i18n", "i18n"],
  ["README.md", "README.md"],
  ["README_en_US.md", "README_en_US.md"],
  ["icon.png", "icon.png"],
];
// preview.png : capture d'écran réelle à fournir par l'auteur ; absent du zip tant qu'elle n'existe pas.
const optional = [
  ["preview.png", "preview.png"],
  ["dist/index.css", "index.css"],
];

rmSync(stage, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(stage, { recursive: true });

for (const [from, to] of required) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`Fichier manquant : ${from} (si c'est dist/index.js, lancez d'abord le build)`);
    process.exit(1);
  }
  cpSync(source, join(stage, to), { recursive: true });
}
for (const [from, to] of optional) {
  const source = join(root, from);
  if (existsSync(source)) cpSync(source, join(stage, to), { recursive: true });
}

execFileSync("zip", ["-r", "-q", archive, "."], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`Créé : ${archive}`);
