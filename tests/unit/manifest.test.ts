import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  diffManifest,
  DuplicatePathError,
  fingerprint,
  InvalidEntryError,
  isPdfPath,
  type PdfEntry,
} from "../../src/core/manifest";

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
    expect(value).toMatch(/^[A-Za-z0-9-]+$/);
  });

  // Valeurs écrites à la main (implémentation de référence indépendante, cyrb53 seed 0, base 36).
  it.each([
    ["a.pdf", 100, "135al877yhu-100"],
    ["docs/Report 2024.pdf", 2048, "lyofhoi2es-2048"],
    ["é/日本.pdf", 0, "2bwj4av9tr4-0"],
  ])("is stable on fixed value %s (%i)", (path, size, expected) => {
    expect(fingerprint(entry(path, size))).toBe(expected);
  });

  it("rejects an invalid size", () => {
    expect(() => fingerprint(entry("a.pdf", -1))).toThrow(InvalidEntryError);
  });

  it("has no collision on 10 000 random paths of equal size", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 40 }), {
        minLength: 10_000, maxLength: 10_000,
      }), (paths) => {
        const prints = new Set(paths.map((p) => fingerprint(entry(p, 4096))));
        expect(prints.size).toBe(paths.length);
      }),
      { numRuns: 1 },
    );
  });

  it("has no collision on 10 000 near-identical paths", () => {
    const paths = Array.from({ length: 10_000 }, (_, i) => `docs/scan-${i}.pdf`);
    const prints = new Set(paths.map((p) => fingerprint(entry(p, 4096))));
    expect(prints.size).toBe(paths.length);
  });

  it("is deterministic and ignores modifiedAt", () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), fc.integer(), fc.integer(), (path, size, m1, m2) => {
        expect(fingerprint(entry(path, size, m1))).toBe(fingerprint(entry(path, size, m2)));
      }),
    );
  });
});

describe("validation", () => {
  it("throws DuplicatePathError with the path for duplicates in current", () => {
    const run = () => diffManifest([], [entry("a.pdf"), entry("b.pdf"), entry("a.pdf", 5)]);
    expect(run).toThrow(DuplicatePathError);
    try {
      run();
    } catch (error) {
      expect((error as DuplicatePathError).path).toBe("a.pdf");
    }
  });

  it("throws DuplicatePathError for duplicates in previous", () => {
    expect(() => diffManifest([entry("a.pdf"), entry("a.pdf")], [])).toThrow(DuplicatePathError);
  });

  it.each([
    ["NaN modifiedAt", entry("a.pdf", 1, Number.NaN)],
    ["infinite modifiedAt", entry("a.pdf", 1, Number.POSITIVE_INFINITY)],
    ["negative size", entry("a.pdf", -1)],
    ["NaN size", entry("a.pdf", Number.NaN)],
    ["infinite size", entry("a.pdf", Number.POSITIVE_INFINITY)],
    ["fractional size", entry("a.pdf", 1.5)],
  ])("throws InvalidEntryError for %s", (_label, bad) => {
    expect(() => diffManifest([], [bad])).toThrow(InvalidEntryError);
    expect(() => diffManifest([bad], [])).toThrow(InvalidEntryError);
  });

  it("InvalidEntryError names the path", () => {
    expect(() => diffManifest([], [entry("x.pdf", -1)])).toThrow(/x\.pdf/);
  });

  it("treats a decreasing date (restored old version) as modified", () => {
    const diff = diffManifest([entry("a.pdf", 100, 2000)], [entry("a.pdf", 100, 1000)]);
    expect(diff.modified).toEqual([entry("a.pdf", 100, 1000)]);
  });

  it("is case-sensitive on paths (A.pdf and a.pdf are distinct files)", () => {
    const diff = diffManifest([entry("a.pdf")], [entry("A.pdf")]);
    expect(diff.added.map((e) => e.path)).toEqual(["A.pdf"]);
    expect(diff.removed.map((e) => e.path)).toEqual(["a.pdf"]);
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
    ["dir.pdf/", false],
    ["dir.pdf/sub", false],
    ["noextension", false],
    [".pdf", true],
    ["", false],
  ])("%s -> %s", (path, expected) => {
    expect(isPdfPath(path)).toBe(expected);
  });
});
