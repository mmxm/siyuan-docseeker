import { describe, expect, it, vi } from "vitest";
import { FRONTENDS, isMobileFrontend, readFrontend } from "../../../src/platform/frontend";

describe("isMobileFrontend", () => {
  it.each([
    ["desktop", false],
    ["desktop-window", false],
    ["browser-desktop", false],
    ["mobile", true],
    ["browser-mobile", true],
  ] as const)("%s -> %s", (frontend, expected) => {
    expect(isMobileFrontend(frontend)).toBe(expected);
  });
});

describe("readFrontend", () => {
  it.each(FRONTENDS)("renvoie %s sans avertir", (frontend) => {
    const warn = vi.fn();
    expect(readFrontend(() => frontend, warn)).toBe(frontend);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "tablet", 42, {}])("valeur inconnue %j : bureau et avertissement", (value) => {
    const warn = vi.fn();
    expect(readFrontend(() => value, warn)).toBe("desktop");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("erreur de getFrontend : bureau, avertissement avec l'erreur", () => {
    const warn = vi.fn();
    const boom = new Error("boom");
    expect(readFrontend(() => { throw boom; }, warn)).toBe("desktop");
    expect(warn).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it("valeur dont String() lève (Symbol, objet sans prototype) : bureau, sans lever", () => {
    for (const value of [Symbol("x"), Object.create(null)]) {
      const warn = vi.fn();
      expect(() => readFrontend(() => value, warn)).not.toThrow();
      expect(readFrontend(() => value, warn)).toBe("desktop");
      expect(warn).toHaveBeenCalled();
    }
  });

  it("le message d'avertissement contient la valeur fautive", () => {
    const warn = vi.fn();
    readFrontend(() => "tablet", warn);
    expect(warn.mock.calls[0]?.[0]).toContain("tablet");
  });

  it("la liste des interfaces connues est figée", () => {
    expect([...FRONTENDS]).toEqual(["desktop", "desktop-window", "mobile", "browser-desktop", "browser-mobile"]);
  });
});
