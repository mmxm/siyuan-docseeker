import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeIndex } from "../../src/core/codec/encode";
import { decodeIndex } from "../../src/core/codec/decode";
import { DsxFormatError, compareUtf8, type DocumentIndex, type TermEntry, type WordBox } from "../../src/core/codec/format";

const QUANTUM = 1 / 65535;
const SEED = 20260401;
const ROUNDTRIP_RUNS = 100;
const CORRUPTION_RUNS = 400;
const FUZZ_TIMEOUT_MS = 120_000;
const UTF8 = new TextEncoder();

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const boxArb: fc.Arbitrary<WordBox> = fc
  .tuple(unit, unit, unit, unit)
  .map(([x, y, fw, fh]) => ({ x, y, width: fw * (1 - x), height: fh * (1 - y) }));

function termsArb(pageCount: number): fc.Arbitrary<TermEntry[]> {
  const postingsArb = pageCount === 0
    ? fc.constant([])
    : fc.uniqueArray(fc.integer({ min: 1, max: pageCount }), { maxLength: pageCount }).chain((pages) =>
        fc.tuple(
          ...[...pages].sort((a, b) => a - b).map((page) =>
            fc
              .array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 6 })
              .map((o) => [...o].sort((a, b) => a - b))
              .map((wordOrdinals) => ({ page, termFrequency: wordOrdinals.length, wordOrdinals })),
          ),
        ),
      );
  return fc
    .uniqueArray(fc.string({ unit: "grapheme", maxLength: 8 }), { maxLength: 8 })
    .chain((names) => fc.tuple(...names.map((term) => postingsArb.map((postings) => ({ term, postings })))));
}

const indexArb: fc.Arbitrary<DocumentIndex> = fc.integer({ min: 0, max: 5 }).chain((pageCount) =>
  fc.record({
    normalizerVersion: fc.integer({ min: 0, max: 65535 }),
    extractorVersion: fc.string({ unit: "grapheme", maxLength: 20 }),
    sourcePath: fc.string({ unit: "grapheme", maxLength: 40 }),
    pdfSize: fc.nat({ max: 2 ** 40 }),
    pdfModifiedMs: fc.nat({ max: 2 ** 41 }),
    pageTermCounts: fc.array(fc.nat({ max: 100000 }), { minLength: pageCount, maxLength: pageCount }),
    terms: termsArb(pageCount),
    pageBoxes: fc.array(fc.array(boxArb, { maxLength: 4 }), { minLength: pageCount, maxLength: pageCount }),
  }),
);

function sortedByUtf8(terms: readonly TermEntry[]): TermEntry[] {
  return [...terms].sort((a, b) => compareUtf8(UTF8.encode(a.term), UTF8.encode(b.term)));
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("aller-retour aléatoire", () => {
  it("decode(encode(x)) égale x, encode est déterministe et le ré-encodage idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(indexArb, async (index) => {
        const bytes = await encodeIndex(index);
        expect(hex(await encodeIndex(index))).toBe(hex(bytes));
        const decoded = await decodeIndex(bytes);
        expect({ ...decoded, pageBoxes: [] }).toEqual({ ...index, terms: sortedByUtf8(index.terms), pageBoxes: [] });
        expect(decoded.pageBoxes).toHaveLength(index.pageBoxes.length);
        index.pageBoxes.forEach((boxes, p) => {
          expect(decoded.pageBoxes[p]).toHaveLength(boxes.length);
          boxes.forEach((b, i) => {
            const d = decoded.pageBoxes[p]?.[i];
            if (d === undefined) throw new Error(`missing box ${i} on page ${p}`);
            for (const key of ["x", "y", "width", "height"] as const) {
              expect(Math.abs(d[key] - b[key])).toBeLessThanOrEqual(QUANTUM);
            }
          });
        });
        expect(hex(await encodeIndex(decoded))).toBe(hex(bytes));
      }),
      { seed: SEED, numRuns: ROUNDTRIP_RUNS },
    );
  }, FUZZ_TIMEOUT_MS);
});

describe("fuzz de corruption", () => {
  const sample: DocumentIndex = {
    normalizerVersion: 1,
    extractorVersion: "4.0.379",
    sourcePath: "assets/日本語.pdf",
    pdfSize: 1234,
    pdfModifiedMs: 99,
    pageTermCounts: [3, 0, 2],
    terms: [
      { term: "alpha", postings: [{ page: 1, termFrequency: 2, wordOrdinals: [0, 2] }] },
      { term: "beta", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [1] }, { page: 3, termFrequency: 1, wordOrdinals: [0] }] },
    ],
    pageBoxes: [[{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }], [], [{ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]],
  };

  /** Réussir ou lever un DsxFormatError : aucune autre erreur n'est acceptable. */
  async function outcome(bytes: Uint8Array): Promise<void> {
    try {
      await decodeIndex(bytes);
    } catch (error) {
      if (!(error instanceof DsxFormatError)) throw error;
    }
  }

  it("un octet inversé ne produit que des DsxFormatError", async () => {
    const bytes = await encodeIndex(sample);
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), async (position, mask) => {
        const mutated = bytes.slice();
        mutated[position] = (mutated[position] ?? 0) ^ mask;
        await outcome(mutated);
      }),
      { seed: SEED, numRuns: CORRUPTION_RUNS },
    );
  }, FUZZ_TIMEOUT_MS);

  it("toute troncature est un DsxFormatError", async () => {
    const bytes = await encodeIndex(sample);
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: bytes.length - 1 }), async (cut) => {
        await expect(decodeIndex(bytes.slice(0, cut))).rejects.toBeInstanceOf(DsxFormatError);
      }),
      { seed: SEED, numRuns: CORRUPTION_RUNS },
    );
  }, FUZZ_TIMEOUT_MS);
});
