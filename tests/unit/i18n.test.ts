import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FREQUENCY_MINUTES } from "../../src/settings";

const fr = JSON.parse(readFileSync("i18n/fr_FR.json", "utf8")) as Record<string, string>;
const NEW_KEYS = [
  "autoIndexRunning", "autoIndexCount", "autoIndexUpToDate", "autoIndexFailed", "autoIndexDiscoveryFailed",
  "autoIndexPartialOne", "autoIndexPartialMany", "indexingMayMiss", "clearDoneRebuilding", "clearDoneWillRebuild",
  "settingsSaveFailed", "autoIndexIntervalDisabledHint",
];
const read = (path: string): string => readFileSync(path, "utf8");

describe("i18n/fr_FR.json", () => {
  it("contient toutes les clés demandées par le panneau et le plugin", () => {
    const sources = ["src/ui/settingsPanel.ts", "src/index.ts", "src/searchTab.ts"].map(read).join("\n");
    const keys = new Set([...sources.matchAll(/\bt\("([A-Za-z]+)"\)/g)].map((m) => m[1]!));
    // Clés construites dynamiquement : titre et `<clé>Desc` de chaque item du panneau.
    for (const key of ["autoIndex", "autoIndexInterval", "reindex", "clearIndex", "diagnostic", "warnLog"]) {
      keys.add(key);
      keys.add(`${key}Desc`);
    }
    for (const key of ["clearPartialOne", "clearPartialMany"]) keys.add(key);
    // Libellés de fréquence construits à partir de la liste des fréquences.
    for (const minutes of FREQUENCY_MINUTES) keys.add(`freq${minutes}`);
    // Clés lues avec un texte par défaut (searchTab) : elles doivent quand même exister en français.
    for (const key of NEW_KEYS) keys.add(key);
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
    for (const key of ["autoIndex", "autoIndexInterval", "reindex", "clearIndex", "diagnostic", "warnLog"]) {
      for (const k of [key, `${key}Desc`]) expect(fr[k], k).not.toMatch(/[<>&]/);
    }
  });

  it("les libellés de fréquence et les textes d'indexation automatique sont sans balise ni entité", () => {
    const keys = [...FREQUENCY_MINUTES.map((m) => `freq${m}`), ...NEW_KEYS];
    for (const k of keys) expect(fr[k], k).not.toMatch(/[<>&]/);
  });

  it("a retiré les clés mortes (pause/reprise, fréquence d'une minute, anciens libellés d'indicateur)", () => {
    for (const key of ["pause", "resume", "indexingPaused", "freq1", "autoIndexRunningShort"]) expect(fr).not.toHaveProperty(key);
  });

  it("les fréquences proposées ont chacune un libellé", () => {
    expect(FREQUENCY_MINUTES).toEqual([5, 15, 60]);
    for (const m of FREQUENCY_MINUTES) expect(fr[`freq${m}`], `freq${m}`).toBeTypeOf("string");
  });

  it("les descriptions disent « ou modifiés », la limite de 30 secondes, l'attente de la saisie et la reconstruction automatique", () => {
    expect(fr.autoIndexDesc).toMatch(/modifiés/);
    expect(fr.autoIndexIntervalDesc).toMatch(/30 secondes/);
    expect(fr.autoIndexIntervalDesc).toMatch(/taper/);
    expect(fr.clearConfirmText).toMatch(/indexation automatique/);
    expect(fr.clearIndexDesc).toMatch(/indexation automatique/);
  });

  it("les textes de l'indicateur ont leurs variables et les pluriels par clés One/Many", () => {
    expect(fr.autoIndexCount).toBe("{done}/{total} PDF");
    expect(fr.autoIndexRunning).toBe("Indexation en cours");
    expect(fr.autoIndexFailed).toContain("{n}");
    expect(fr.autoIndexPartialOne).toContain("{n}");
    expect(fr.autoIndexPartialMany).toContain("{n}");
    expect(fr.autoIndexPartialMany).toContain("n'ont pas pu être lus");
    expect(fr.settingsSaveFailed).toBe("Réglage appliqué mais non enregistré : il sera perdu au redémarrage.");
  });

  it("annonce les nouveaux états d'indexation, avec les variables attendues", () => {
    expect(fr.autoIndexCount).toContain("{done}");
    expect(fr.autoIndexCount).toContain("{total}");
    expect(fr.autoIndexFailed).toContain("{n}");
    expect(fr.clearDoneRebuilding).toBe("Index vidé. Reconstruction en cours…");
    expect(fr.clearDone).toBe("Index vidé. Lancez Réindexer pour le reconstruire.");
  });
});
