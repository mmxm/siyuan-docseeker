import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Lecture de texte simple (pas de dépendance YAML) : les invariants de sécurité des workflows GitHub Actions.
const ROOT = join(__dirname, "..", "..", "..");
const read = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");
const ci = read("ci.yml");
const release = read("release.yml");

/** Bloc `on:` : de la ligne « on: » jusqu'à la prochaine clé de premier niveau. */
function onBlock(text: string): string {
  const match = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(text);
  if (!match) throw new Error("bloc on: introuvable");
  return match[1] ?? "";
}

/** Contenu de tous les `run:` (ligne simple ou bloc `|`). */
function runBodies(text: string): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    if (/^[|>]/.test(m[2] ?? "")) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j] ?? "";
        if (line.trim() !== "" && line.search(/\S/) <= indent) break;
        block.push(line);
      }
      bodies.push(block.join("\n"));
    } else {
      bodies.push(m[2] ?? "");
    }
  }
  return bodies;
}

describe.each([
  ["ci.yml", ci],
  ["release.yml", release],
])("%s", (_name, text) => {
  it("déclare des permissions explicites de premier niveau", () => {
    expect(text).toMatch(/^permissions:\n\s+contents: (read|none)$/m);
  });

  it("épingle chaque action tierce sur un SHA de 40 hexadécimaux avec le tag en commentaire", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)].map((m) => (m[1] ?? "").trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, use).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("n'interpole aucun ${{ github.* }} ni ${{ inputs.* }} dans un run:", () => {
    const bodies = runBodies(text);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body, body).not.toMatch(/\$\{\{\s*(github|inputs)\./);
  });

  it("n'utilise aucun secret autre que GITHUB_TOKEN", () => {
    for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) expect(m[1]).toBe("GITHUB_TOKEN");
  });

  it("utilise Node 22", () => {
    expect(text).toMatch(/node-version: "?22"?/);
  });
});

describe("ci.yml", () => {
  it("se lance sur push vers main et sur pull_request, en lecture seule", () => {
    const on = onBlock(ci);
    expect(on).toMatch(/push:\n\s+branches: \[main\]/);
    expect(on).toMatch(/^\s+pull_request:/m);
    expect(ci).not.toMatch(/contents: write/);
  });

  it("enchaîne npm ci, typecheck, test, package", () => {
    const runs = runBodies(ci).join("\n");
    for (const cmd of ["npm ci", "npm run typecheck", "npm test", "npm run package"]) expect(runs).toContain(cmd);
  });
});

describe("release.yml", () => {
  it("se déclenche uniquement par tag vX.Y.Z et workflow_dispatch, jamais par push de branche", () => {
    const on = onBlock(release);
    expect(on).toMatch(/push:\n\s+tags:\n\s+- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
    expect(on).toMatch(/^\s+workflow_dispatch:/m);
    expect(on).not.toMatch(/branches/);
    expect(on).not.toMatch(/pull_request|schedule|release:/);
    const keys = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(["push", "workflow_dispatch"]);
  });

  it("limite contents: write au seul job de publication", () => {
    expect(release.match(/contents: write/g)).toHaveLength(1);
    const publish = release.slice(release.indexOf("\n  publish:"));
    expect(publish).toContain("contents: write");
    expect(release.slice(0, release.indexOf("\n  publish:"))).not.toContain("contents: write");
  });

  it("ne publie que sur un tag, avec --verify-tag, et empêche deux releases du même tag", () => {
    expect(release).toMatch(/if: github\.ref_type == 'tag'/);
    expect(release).toContain("gh release create");
    expect(release).toContain("--verify-tag");
    expect(release).toMatch(/^concurrency:\n\s+group: .*github\.ref/m);
    expect(release).toMatch(/cancel-in-progress: false/);
  });

  it("vérifie que le tag est dans l'historique de main et la cohérence du tag", () => {
    const runs = runBodies(release).join("\n");
    expect(runs).toContain("git merge-base --is-ancestor");
    expect(runs).toContain("node scripts/release.mjs --ci");
    for (const cmd of ["npm ci", "npm run typecheck", "npm test", "npm run package", "sha256"]) expect(runs).toContain(cmd);
  });

  it("n'écrit les données non fiables que via env:", () => {
    expect(release).toMatch(/env:\n\s+TAG: \$\{\{ github\.ref_name \}\}/);
  });

  it("n'utilise ${{ github.* }} que dans env, if, concurrency ou with", () => {
    for (const [name, text] of [["ci.yml", ci], ["release.yml", release]] as const) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!/\$\{\{\s*github\./.test(line) || line.trim().startsWith("#")) return;
        if (/^\s*(- )?if:/.test(line)) return;
        expect(parentKey(lines, i), `${name}:${i + 1} ${line.trim()}`).toMatch(/^(env|with|concurrency)$/);
      });
    }
  });

  it("garde le job publish derrière build, sans checkout, avec des artifacts aux noms cohérents", () => {
    const publish = release.slice(release.indexOf("\n  publish:"));
    expect(publish).toMatch(/^ {4}needs: build$/m);
    expect(publish).not.toContain("actions/checkout");
    const up = /upload-artifact@[\s\S]*?name: (\S+)/.exec(release.slice(0, release.indexOf("\n  publish:")));
    const down = /download-artifact@[\s\S]*?name: (\S+)/.exec(publish);
    expect(up?.[1]).toBeTruthy();
    expect(down?.[1]).toBe(up?.[1]);
  });

  it("vérifie main et --ci avant le package, et exige que le tag pointe sur la tête de main", () => {
    const build = release.slice(0, release.indexOf("\n  publish:"));
    const pos = (needle: string) => {
      const index = build.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(pos("git merge-base --is-ancestor")).toBeLessThan(pos("npm run package"));
    expect(pos("node scripts/release.mjs --ci")).toBeLessThan(pos("npm run package"));
    expect(pos("git rev-parse origin/main")).toBeLessThan(pos("npm run package"));
    expect(build).toMatch(/if: github\.ref_type == 'tag'/);
    expect(build).toContain("git fetch --tags");
    expect(build).not.toContain("--no-tags");
  });

  it("n'utilise ni cache npm ni scripts d'installation dans la release", () => {
    expect(release).not.toMatch(/cache: npm/);
    expect(release).toContain("npm ci --ignore-scripts");
    expect(ci).toMatch(/cache: npm/);
  });

  it("revalide le tag à la publication et cible le commit exact", () => {
    const publish = release.slice(release.indexOf("\n  publish:"));
    expect(publish).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(publish).toMatch(/gh api "repos\/\$GH_REPO\/git\/ref\/tags\/\$TAG" --jq \.object\.sha/);
    expect(publish).toContain('--target "$GITHUB_SHA"');
  });

  it("documente que le mode à blanc échoue sans section CHANGELOG", () => {
    expect(release).toMatch(/#.*à blanc.*CHANGELOG/i);
  });
});

/** Clé parente (indentation strictement plus faible) de la ligne i. */
function parentKey(lines: string[], i: number): string {
  const indent = (lines[i] ?? "").search(/\S/);
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) < indent) return (/^\s*(?:- )?([\w-]+):/.exec(line)?.[1]) ?? "";
  }
  return "";
}
