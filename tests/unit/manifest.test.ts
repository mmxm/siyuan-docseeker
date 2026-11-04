import { describe, expect, it } from "vitest";
import { diffManifest, fingerprint, isPdfPath, type PdfEntry } from "../../src/core/manifest";

const entry = (path: string, size = 100, modifiedAt = 1000): PdfEntry => ({ path, size, modifiedAt });

describe("diffManifest", () => {
  it("detects added files", () => {
    const diff = diffManifest([], [entry("a.pdf")]);
    expect(diff.added).toEqual([entry("a.pdf")]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("detects removed files", () => {
    const diff = diffManifest([entry("a.pdf")], []);
    expect(diff.removed).toEqual([entry("a.pdf")]);
    expect(diff.added).toEqual([]);
  });

  it("detects a size change as modified", () => {
    const diff = diffManifest([entry("a.pdf", 100)], [entry("a.pdf", 200)]);
    expect(diff.modified).toEqual([entry("a.pdf", 200)]);
    expect(diff.unchanged).toEqual([]);
  });

  it("detects a date change as modified", () => {
    const diff = diffManifest([entry("a.pdf", 100, 1)], [entry("a.pdf", 100, 2)]);
    expect(diff.modified).toEqual([entry("a.pdf", 100, 2)]);
  });

  it("reports unchanged files", () => {
    const diff = diffManifest([entry("a.pdf")], [entry("a.pdf")]);
    expect(diff.unchanged).toEqual([entry("a.pdf")]);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("handles a mix of cases without mutating inputs", () => {
    const previous = Object.freeze([entry("keep.pdf"), entry("edit.pdf", 1), entry("gone.pdf")]);
    const current = Object.freeze([entry("keep.pdf"), entry("edit.pdf", 2), entry("new.pdf")]);
    const diff = diffManifest(previous, current);
    expect(diff.added.map((e) => e.path)).toEqual(["new.pdf"]);
    expect(diff.modified.map((e) => e.path)).toEqual(["edit.pdf"]);
    expect(diff.removed.map((e) => e.path)).toEqual(["gone.pdf"]);
    expect(diff.unchanged.map((e) => e.path)).toEqual(["keep.pdf"]);
  });

  it("handles two empty manifests", () => {
    expect(diffManifest([], [])).toEqual({ added: [], modified: [], removed: [], unchanged: [] });
  });
});

describe("fingerprint", () => {
  it("is stable for the same path and size", () => {
    expect(fingerprint(entry("a/b.pdf", 5, 1))).toBe(fingerprint(entry("a/b.pdf", 5, 999)));
  });

  it("changes with path or size", () => {
    const base = fingerprint(entry("a.pdf", 5));
    expect(fingerprint(entry("b.pdf", 5))).not.toBe(base);
    expect(fingerprint(entry("a.pdf", 6))).not.toBe(base);
  });

  it("is a filename-safe string even for special characters", () => {
    const value = fingerprint(entry("dossier/é 日本 😀 '; DROP.pdf", 5));
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("isPdfPath", () => {
  it.each([
    ["a.pdf", true],
    ["A.PDF", true],
    ["dir/sub/Doc.Pdf", true],
    ["a.pdf.sya", false],
    ["a.PDF.SYA", false],
    ["a.txt", false],
    ["pdf", false],
    ["a.pdfx", false],
    ["", false],
  ])("%s -> %s", (path, expected) => {
    expect(isPdfPath(path)).toBe(expected);
  });
});
