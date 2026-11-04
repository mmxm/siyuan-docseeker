import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Manifest, PdfEntry } from "../../../src/core/manifest";
import { planIndexUpdate, type DiscoveryResult } from "../../../src/siyuan/discovery";

const entry = (path: string, size = 1, modifiedAt = 1): PdfEntry => ({ path, size, modifiedAt });
const result = (manifest: Manifest, over: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
  manifest,
  issues: [],
  complete: true,
  unsized: [],
  ...over,
});

describe("planIndexUpdate", () => {
  it("résultat complet : indexe ajoutés et modifiés, supprime les disparus", () => {
    const previous = [entry("assets/keep.pdf"), entry("assets/gone.pdf"), entry("assets/mod.pdf", 1)];
    const current = [entry("assets/keep.pdf"), entry("assets/mod.pdf", 2), entry("assets/new.pdf")];
    const plan = planIndexUpdate(previous, result(current));
    expect(plan.toIndex.map((e) => e.path).sort()).toEqual(["assets/mod.pdf", "assets/new.pdf"]);
    expect(plan.toRemove.map((e) => e.path)).toEqual(["assets/gone.pdf"]);
    expect(plan.removalsAllowed).toBe(true);
  });

  it("résultat incomplet vide (scénario session expirée) : aucune suppression", () => {
    const previous = [entry("assets/a.pdf"), entry("assets/b.pdf")];
    const plan = planIndexUpdate(previous, result([], { complete: false }));
    expect(plan.toRemove).toEqual([]);
    expect(plan.removalsAllowed).toBe(false);
  });

  it("un PDF unsized n'est ni supprimé ni indexé", () => {
    const previous = [entry("assets/a.pdf")];
    const plan = planIndexUpdate(previous, result([], { complete: false, unsized: ["assets/a.pdf", "assets/n.pdf"] }));
    expect(plan.toRemove).toEqual([]);
    expect(plan.toIndex).toEqual([]);
  });

  it("incohérence : complete vrai mais unsized non vide -> pas de suppression des unsized", () => {
    const previous = [entry("assets/a.pdf"), entry("assets/b.pdf")];
    const plan = planIndexUpdate(previous, result([], { unsized: ["assets/a.pdf"] }));
    expect(plan.toRemove.map((e) => e.path)).toEqual(["assets/b.pdf"]);
  });

  const pathArb: fc.Arbitrary<string> = fc.constantFrom<string[]>("assets/a.pdf", "assets/b.pdf", "assets/c.pdf", "assets/d/e.pdf", "assets/f.pdf");
  const manifestArb = fc
    .uniqueArray(pathArb, { selector: (p) => p })
    .chain((paths) =>
      fc.tuple(...paths.map((p) => fc.record({ path: fc.constant(p), size: fc.nat(1000), modifiedAt: fc.nat(1000) }))),
    );

  it("propriété : un résultat incomplet ne supprime jamais rien", () => {
    fc.assert(
      fc.property(manifestArb, manifestArb, fc.array(pathArb), (previous, current, unsized) => {
        const plan = planIndexUpdate(previous, result(current, { complete: false, unsized }));
        return plan.toRemove.length === 0 && plan.removalsAllowed === false;
      }),
    );
  });

  it("propriété : un PDF de previous vu ou unsized n'est jamais dans toRemove", () => {
    fc.assert(
      fc.property(manifestArb, manifestArb, fc.array(pathArb), fc.boolean(), (previous, current, unsized, complete) => {
        const plan = planIndexUpdate(previous, result(current, { complete, unsized }));
        const protectedPaths = new Set([...current.map((e) => e.path), ...unsized]);
        return plan.toRemove.every((e) => !protectedPaths.has(e.path));
      }),
    );
  });
});
