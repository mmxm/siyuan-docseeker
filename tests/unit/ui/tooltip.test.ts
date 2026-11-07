// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { escapeForTooltip } from "../../../src/ui/tooltip";
import { simulateTooltip } from "../helpers/tooltip";

describe("escapeForTooltip", () => {
  it("échappe & < > \" ' (et laisse le reste intact)", () => {
    expect(escapeForTooltip(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
    expect(escapeForTooltip("Cahier A/Été 😀")).toBe("Cahier A/Été 😀");
    expect(escapeForTooltip("")).toBe("");
  });

  it("n'échappe pas deux fois à l'intérieur d'un appel, et reste lisible une fois insérée comme HTML", () => {
    const raw = `<img src=x onerror=alert(1)> & "q" 'r'`;
    const label = document.createElement("span");
    label.setAttribute("aria-label", escapeForTooltip(raw));
    const shown = simulateTooltip(label);
    expect(shown.querySelector("img")).toBeNull();
    expect(shown.children).toHaveLength(0);
    expect(shown.textContent).toBe(raw);
  });

  it("le simulateur détecte un libellé NON échappé (garde-fou du test)", () => {
    const label = document.createElement("span");
    label.setAttribute("aria-label", `<img src=x onerror=alert(1)>`);
    expect(simulateTooltip(label).querySelector("img")).not.toBeNull();
  });
});

describe("audit des infobulles natives (classe ariaLabel)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));

  it("seuls les fichiers audités posent la classe ariaLabel ; celui qui y met une donnée (searchToolbar) échappe sa valeur", () => {
    const users = files("src")
      .filter((f) => /\bariaLabel\b/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      .map((f) => f.replace(/^src\//, ""))
      .sort();
    // Libellés constants (i18n) : icons.ts, criteriaBar.ts. Donnée non fiable (noms de documents) : searchToolbar.ts, avec escapeForTooltip.
    expect(users).toEqual(["ui/criteriaBar.ts", "ui/icons.ts", "ui/searchToolbar.ts"]);
    expect(readFileSync("src/ui/searchToolbar.ts", "utf8")).toContain('setAttribute("aria-label", escapeForTooltip(');
  });
});
