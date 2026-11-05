import { describe, expect, it } from "vitest";
// Module .mjs sans déclaration de types : importé tel quel (vitest le transpile, tsc le voit via allowJs absent).
// @ts-expect-error -- scripts/release.mjs n'a pas de fichier de types
import { compareVersions, missingZipEntries, parseVersion, readVersion, releaseCommands } from "../../../scripts/release.mjs";

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
  it("affiche les commandes manuelles exactes pour publier une version", () => {
    expect(releaseCommands("0.2.0")).toEqual([
      "git tag v0.2.0",
      "git push origin v0.2.0",
      'gh release create v0.2.0 package.zip --title "DocSeeker 0.2.0" --notes-file CHANGELOG.md',
    ]);
  });
});
