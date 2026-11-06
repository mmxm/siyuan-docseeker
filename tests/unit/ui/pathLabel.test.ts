import { describe, expect, it } from "vitest";
import { containingFolder } from "../../../src/ui/pathLabel";

describe("containingFolder", () => {
  it.each([
    ["/assets/doc.pdf", "/assets/"],
    ["assets/doc.pdf", "assets/"],
    ["/assets/sous-dossier/doc.pdf", "/assets/sous-dossier/"],
    ["assets/a/b/c/doc.pdf", "assets/a/b/c/"],
    ["/doc.pdf", "/"],
    ["doc.pdf", ""],
    ["", ""],
    ["/assets/sous-dossier/", "/assets/sous-dossier/"],
    ["/assets/rapport final.pdf", "/assets/"],
  ])("%j -> %j", (path, expected) => {
    expect(containingFolder(path)).toBe(expected);
  });

  it("conserve les noms Unicode tels quels (NFC comme NFD), sans normaliser", () => {
    const nfd = "/assets/été/résumé \u{1F600}.pdf";
    expect(containingFolder(nfd)).toBe("/assets/été/");
    expect(containingFolder("/assets/été/日本語.pdf")).toBe("/assets/été/");
  });
});
