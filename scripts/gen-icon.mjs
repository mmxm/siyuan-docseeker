#!/usr/bin/env node
// Génère l'icône du plugin : icon.svg (SVG écrit en dur ci-dessous) puis icon.png (160 x 160) à la racine.
// Conversion par `qlmanage` (QuickLook, livré avec macOS) : aucune dépendance npm, rien à installer.
// Usage : node scripts/gen-icon.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 160;

// Fond bleu plein, page PDF blanche avec une ligne surlignée en jaune, loupe jaune par-dessus.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="#1d4ed8"/>
  <rect x="26" y="20" width="84" height="104" rx="6" fill="#ffffff"/>
  <rect x="36" y="34" width="60" height="7" rx="3.5" fill="#94a3b8"/>
  <rect x="36" y="52" width="46" height="11" rx="2" fill="#fde047"/>
  <rect x="36" y="54" width="40" height="7" rx="3.5" fill="#1e293b"/>
  <rect x="36" y="72" width="56" height="7" rx="3.5" fill="#94a3b8"/>
  <rect x="36" y="88" width="40" height="7" rx="3.5" fill="#94a3b8"/>
  <line x1="121" y1="115" x2="143" y2="137" stroke="#fbbf24" stroke-width="13" stroke-linecap="round"/>
  <circle cx="104" cy="98" r="25" fill="#dbeafe" stroke="#fbbf24" stroke-width="9"/>
</svg>
`;

const svgPath = join(ROOT, "icon.svg");
const pngPath = join(ROOT, "icon.png");
writeFileSync(svgPath, SVG);

// qlmanage écrit `<nom>.png` (il ajoute .png au nom du fichier source) dans le dossier de sortie.
const workDir = mkdtempSync(join(tmpdir(), "docseeker-icon-"));
try {
  execFileSync("qlmanage", ["-t", "-s", String(SIZE), "-o", workDir, svgPath], { stdio: "ignore" });
  copyFileSync(join(workDir, "icon.svg.png"), pngPath);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
console.log(`Créé : ${svgPath}`);
console.log(`Créé : ${pngPath}`);
