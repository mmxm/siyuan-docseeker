// @vitest-environment jsdom
// Repli mobile (en attendant le visionneur de page, E5) : ouvre le PDF dans le navigateur à la page demandée. Seul adaptateur autorisé
// à appeler window.open.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InvalidPdfPathError, openPdfInBrowser } from "../../../src/siyuan/openPdf";

describe("openPdfInBrowser", () => {
  it("ouvre /assets/x.pdf#page=N dans un nouvel onglet et renvoie vrai", () => {
    const opened = { opener: "x" as unknown };
    const open = vi.fn(() => opened);
    expect(openPdfInBrowser({ path: "assets/x.pdf", page: 7, open })).toBe(true);
    expect(open).toHaveBeenCalledWith("/assets/x.pdf#page=7", "_blank");
    expect(opened.opener).toBeNull(); // la page ouverte ne garde pas la main sur SiYuan
  });

  it("encode les segments (espaces, accents, caractères d'URL) sans toucher aux séparateurs", () => {
    const open = vi.fn(() => ({ opener: null }));
    openPdfInBrowser({ path: "assets/Mon dossier/Rapport é&=1-2024.pdf", page: 1, open });
    expect(open).toHaveBeenCalledWith("/assets/Mon%20dossier/Rapport%20%C3%A9%26%3D1-2024.pdf#page=1", "_blank");
  });

  it("fenêtre bloquée (open renvoie null) : renvoie faux, sans lever", () => {
    expect(openPdfInBrowser({ path: "assets/x.pdf", page: 1, open: () => null })).toBe(false);
  });

  it("opener non modifiable (lève) : la fenêtre EST ouverte, donc vrai ; l'incident est tracé, jamais avalé", () => {
    const boom = new Error("opener figé");
    const opened = {
      get opener(): unknown {
        return "x";
      },
      set opener(_value: unknown) {
        throw boom;
      },
    };
    const onWarn = vi.fn();
    expect(openPdfInBrowser({ path: "assets/x.pdf", page: 1, open: () => opened, onWarn })).toBe(true);
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it("open qui lève : l'erreur est propagée (l'appelant la trace)", () => {
    expect(() => openPdfInBrowser({ path: "assets/x.pdf", page: 1, open: () => { throw new Error("bloqué"); } })).toThrow("bloqué");
  });

  it.each(["../secret.pdf", "assets/../x.pdf", "assets/x.pdf#page=9", "assets/x.pdf?a=1", "http://evil/x.pdf", "assets/x%2e.pdf", "x.pdf"])(
    "chemin refusé avant tout appel : %s",
    (path) => {
      const open = vi.fn();
      expect(() => openPdfInBrowser({ path, page: 1, open })).toThrow(InvalidPdfPathError);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN])("page invalide refusée : %s", (page) => {
    const open = vi.fn();
    expect(() => openPdfInBrowser({ path: "assets/x.pdf", page, open })).toThrow(RangeError);
    expect(open).not.toHaveBeenCalled();
  });

  it("par défaut, passe par window.open", () => {
    const spy = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openPdfInBrowser({ path: "assets/x.pdf", page: 3 })).toBe(false);
    expect(spy).toHaveBeenCalledWith("/assets/x.pdf#page=3", "_blank");
    spy.mockRestore();
  });
});

describe("window.open : un seul adaptateur", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  it("aucun appel à window.open dans src/ hors src/siyuan/openPdf.ts", () => {
    const offenders = files("src").filter((f) => f !== join("src", "siyuan", "openPdf.ts") && /\bwindow\.open\s*\(|(^|[^.\w])open\s*\(\s*["'`]\//m.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")));
    expect(offenders).toEqual([]);
  });
});
