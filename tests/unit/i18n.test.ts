import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fr = JSON.parse(readFileSync("i18n/fr_FR.json", "utf8")) as Record<string, string>;
const read = (path: string): string => readFileSync(path, "utf8");

describe("i18n/fr_FR.json", () => {
  it("contient toutes les clés demandées par le panneau et le plugin", () => {
    const sources = ["src/ui/settingsPanel.ts", "src/index.ts", "src/searchTab.ts"].map(read).join("\n");
    const keys = new Set([...sources.matchAll(/\bt\("([A-Za-z]+)"\)/g)].map((m) => m[1]!));
    // Clés construites dynamiquement : titre et `<clé>Desc` de chaque item du panneau.
    for (const key of ["reindex", "clearIndex", "diagnostic", "warnLog"]) {
      keys.add(key);
      keys.add(`${key}Desc`);
    }
    for (const key of ["clearPartialOne", "clearPartialMany"]) keys.add(key);
    const missing = [...keys].filter((k) => typeof fr[k] !== "string");
    expect(missing).toEqual([]);
  });

  it("n'a plus de clé de l'ancienne section Avancé et pas d'usage de « fichier(s) »", () => {
    expect(fr).not.toHaveProperty("advanced");
    expect(Object.values(fr).join("\n")).not.toMatch(/\(s\)/);
    expect(fr.diagnostic).toBe("Diagnostic technique");
  });

  it("ne code pas le nombre d'entrées du journal dans le texte", () => {
    expect(fr.warnLogDesc).not.toMatch(/\d/);
  });

  it("les titres et descriptions du panneau ne contiennent pas de balise ni d'entité (SiYuan les insère comme HTML)", () => {
    for (const key of ["reindex", "clearIndex", "diagnostic", "warnLog"]) {
      for (const k of [key, `${key}Desc`]) expect(fr[k], k).not.toMatch(/[<>&]/);
    }
  });
});
