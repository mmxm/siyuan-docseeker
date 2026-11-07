import { describe, expect, it } from "vitest";
// Module .mjs sans déclaration de types : importé tel quel (vitest le transpile, tsc le voit via allowJs absent).
import {
  compareVersions,
  extractChangelogSection,
  missingZipEntries,
  parseVersion,
  notNewerTags,
  prepareCiRelease,
  resolveNotesPath,
  readVersion,
  releaseCommands,
  versionFromTag,
// @ts-expect-error -- scripts/release.mjs n'a pas de fichier de types
} from "../../../scripts/release.mjs";

describe("parseVersion", () => {
  it("lit une version x.y.z en nombres", () => {
    expect(parseVersion("0.2.0")).toEqual([0, 2, 0]);
    expect(parseVersion("10.0.12")).toEqual([10, 0, 12]);
  });

  it("refuse tout ce qui n'est pas x.y.z strict", () => {
    for (const bad of ["0.2", "v0.2.0", "0.2.0-beta", "0.2.0.1", "", "a.b.c", " 0.2.0"]) {
      expect(() => parseVersion(bad), bad).toThrow(/version/i);
    }
  });
});

describe("compareVersions", () => {
  it("compare numériquement, pas alphabétiquement", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  it("renvoie 0 pour des versions égales et compare le patch en dernier", () => {
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.2.0")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
  });

  it("propage l'erreur si une version est invalide", () => {
    expect(() => compareVersions("0.2", "0.1.0")).toThrow(/version/i);
  });
});

describe("readVersion", () => {
  it("lit le champ version d'un JSON", () => {
    expect(readVersion('{"name":"x","version":"0.2.0"}', "plugin.json")).toBe("0.2.0");
  });

  it("nomme le fichier dans le message d'erreur si le champ manque ou est invalide", () => {
    expect(() => readVersion('{"name":"x"}', "plugin.json")).toThrow(/plugin\.json/);
    expect(() => readVersion('{"version":"0.2"}', "package.json")).toThrow(/package\.json/);
  });

  it("signale un JSON invalide avec le nom du fichier", () => {
    expect(() => readVersion("{ pas du json", "package.json")).toThrow(/package\.json/);
  });
});

describe("missingZipEntries", () => {
  const required = ["index.js", "plugin.json", "i18n/fr_FR.json", "README.md", "README_en_US.md", "icon.png"];

  it("renvoie une liste vide quand toutes les entrées sont présentes", () => {
    expect(missingZipEntries([...required, "preview.png"], required)).toEqual([]);
  });

  it("renvoie les entrées manquantes, dans l'ordre demandé", () => {
    expect(missingZipEntries(["index.js", "README.md"], required)).toEqual([
      "plugin.json",
      "i18n/fr_FR.json",
      "README_en_US.md",
      "icon.png",
    ]);
  });
});

describe("releaseCommands", () => {
  it("affiche les commandes manuelles exactes pour publier une version, le workflow publie la release après le push du tag", () => {
    expect(releaseCommands("0.2.0")).toEqual([
      "node scripts/release.mjs --ci v0.2.0 release-notes.md",
      "git tag v0.2.0",
      "git push origin v0.2.0",
    ]);
  });
});

describe("notNewerTags", () => {
  it("liste les tags vX.Y.Z supérieurs ou égaux, en ignorant le tag courant et les tags non versionnés", () => {
    const tags = ["v0.1.0", "v0.3.0", "v0.4.0", "v10.0.0", "foo", "v1.0"];
    expect(notNewerTags("0.3.0", tags, "v0.3.0")).toEqual(["v0.4.0", "v10.0.0"]);
  });

  it("renvoie une liste vide quand la version dépasse tous les tags", () => {
    expect(notNewerTags("0.3.0", ["v0.2.0", "v0.2.9"], "v0.3.0")).toEqual([]);
  });

  it("compare numériquement", () => {
    expect(notNewerTags("0.10.0", ["v0.9.0"], "v0.10.0")).toEqual([]);
    expect(notNewerTags("0.9.0", ["v0.10.0"], "v0.9.0")).toEqual(["v0.10.0"]);
  });
});

describe("resolveNotesPath", () => {
  it("accepte un chemin dans le répertoire courant", () => {
    expect(resolveNotesPath("release-notes.md", "/work")).toBe("/work/release-notes.md");
    expect(resolveNotesPath("sub/notes.md", "/work")).toBe("/work/sub/notes.md");
  });

  it("refuse un chemin hors du répertoire courant ou le répertoire lui-même", () => {
    for (const bad of ["../notes.md", "/etc/passwd", "sub/../../x.md", ".", ""]) {
      expect(() => resolveNotesPath(bad, "/work"), bad).toThrow(/notes/i);
    }
    expect(() => resolveNotesPath("/work-evil/x.md", "/work")).toThrow(/notes/i);
  });
});

describe("versionFromTag", () => {
  it("extrait X.Y.Z d'un tag vX.Y.Z strict", () => {
    expect(versionFromTag("v0.3.0")).toBe("0.3.0");
    expect(versionFromTag("v10.20.30")).toBe("10.20.30");
  });

  it("refuse tout autre format", () => {
    for (const bad of ["0.3.0", "v0.3", "v0.3.0-beta", "v0.3.0\n", "refs/tags/v0.3.0", "V0.3.0", "v01.3.0", "", " v0.3.0"]) {
      expect(() => versionFromTag(bad), bad).toThrow(/tag/i);
    }
    expect(() => versionFromTag(undefined)).toThrow(/tag/i);
  });
});

describe("extractChangelogSection", () => {
  const changelog = [
    "# Journal",
    "",
    "## Non publié",
    "- futur",
    "",
    "## 0.3.0",
    "",
    "- ajout A",
    "- ajout B",
    "",
    "## 0.3.01",
    "- piège",
    "",
    "## 10.3.0",
    "- autre piège",
    "",
    "## 0.2.0",
    "- ancien",
    "",
  ].join("\n");

  it("renvoie le corps de la section sans le titre, jusqu'au prochain « ## »", () => {
    expect(extractChangelogSection(changelog, "0.3.0")).toBe("- ajout A\n- ajout B");
  });

  it("compare la version littéralement (pas de préfixe, pas de regex)", () => {
    expect(extractChangelogSection(changelog, "0.2.0")).toBe("- ancien");
    expect(() => extractChangelogSection(changelog, "0.3")).toThrow(/0\.3/);
    expect(() => extractChangelogSection("## 0x3x0\n- a", "0.3.0")).toThrow(/0\.3\.0/);
  });

  it("gère la dernière section et les fins de ligne CRLF", () => {
    expect(extractChangelogSection("## 1.0.0\r\n- a\r\n- b\r\n", "1.0.0")).toBe("- a\n- b");
  });

  it("ne confond pas un titre de niveau 3 avec une fin de section", () => {
    expect(extractChangelogSection("## 1.0.0\n### Ajouts\n- a\n## 0.9.0\n- b", "1.0.0")).toBe("### Ajouts\n- a");
  });

  it("signale une section absente ou vide", () => {
    expect(() => extractChangelogSection(changelog, "9.9.9")).toThrow(/9\.9\.9/);
    expect(() => extractChangelogSection("## 1.0.0\n\n   \n## 0.9.0\n- b", "1.0.0")).toThrow(/vide/);
    expect(() => extractChangelogSection("", "1.0.0")).toThrow(/1\.0\.0/);
  });
});

describe("prepareCiRelease", () => {
  const pkg = '{"version":"0.3.0"}';
  const plugin = '{"version":"0.3.0"}';
  const changelog = "## 0.3.0\n- ajout\n";

  it("renvoie version et notes quand tag, package.json, plugin.json et CHANGELOG concordent", () => {
    expect(prepareCiRelease({ tag: "v0.3.0", packageJson: pkg, pluginJson: plugin, changelog })).toEqual({
      version: "0.3.0",
      notes: "- ajout",
    });
  });

  it("échoue si le tag diffère de package.json", () => {
    expect(() => prepareCiRelease({ tag: "v0.3.1", packageJson: pkg, pluginJson: plugin, changelog })).toThrow(/package\.json/);
  });

  it("échoue si plugin.json diffère", () => {
    expect(() => prepareCiRelease({ tag: "v0.3.0", packageJson: pkg, pluginJson: '{"version":"0.2.0"}', changelog })).toThrow(/plugin\.json/);
  });

  it("échoue si le tag est invalide ou la section CHANGELOG absente", () => {
    expect(() => prepareCiRelease({ tag: "0.3.0", packageJson: pkg, pluginJson: plugin, changelog })).toThrow(/tag/i);
    expect(() => prepareCiRelease({ tag: "v0.3.0", packageJson: pkg, pluginJson: plugin, changelog: "## 0.2.0\n- a" })).toThrow(/CHANGELOG/);
  });

  it("échoue si un autre tag existant est supérieur ou égal à la version", () => {
    const base = { tag: "v0.3.0", packageJson: pkg, pluginJson: plugin, changelog };
    expect(() => prepareCiRelease({ ...base, tags: ["v0.2.0", "v0.3.0", "v0.4.0"] })).toThrow(/v0\.4\.0/);
    expect(prepareCiRelease({ ...base, tags: ["v0.2.0", "v0.3.0"] }).version).toBe("0.3.0");
  });
});
