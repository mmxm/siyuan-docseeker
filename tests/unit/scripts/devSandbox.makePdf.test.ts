import { describe, expect, it } from "vitest";
// @ts-expect-error -- module .mjs sans types
import { makePdf } from "../../../scripts/lib/makePdf.mjs";

type Spec = { width?: number; height?: number; texts: { x: number; y: number; size: number; text: string }[] };
const make = (pages: Spec[]): Buffer => makePdf({ pages });
const latin1 = (b: Buffer): string => b.toString("latin1");

/** Petit parseur de test : relit xref/trailer et extrait le texte des flux de contenu. */
function parse(pdf: Buffer) {
  const s = latin1(pdf);
  expect(s.startsWith("%PDF-1.4\n")).toBe(true);
  expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
  const sx = /startxref\n(\d+)\n%%EOF\s*$/.exec(s);
  expect(sx).not.toBeNull();
  const xrefPos = Number(sx![1]);
  expect(s.slice(xrefPos, xrefPos + 5)).toBe("xref\n");
  const m = /^xref\n0 (\d+)\n((?:\d{10} \d{5} [nf] \n)+)trailer\n<< \/Size (\d+) \/Root (\d+) 0 R >>/.exec(s.slice(xrefPos));
  expect(m).not.toBeNull();
  const count = Number(m![1]);
  const entries = m![2]!.trimEnd().split("\n");
  expect(entries).toHaveLength(count);
  expect(Number(m![3])).toBe(count);
  expect(entries[0]).toBe("0000000000 65535 f ");
  entries.slice(1).forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  const pageCount = Number(/\/Type \/Pages \/Count (\d+)/.exec(s)![1]);
  const mediaBoxes = [...s.matchAll(/\/Type \/Page \/Parent[^>]*\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map((x) => [Number(x[1]), Number(x[2])]);
  const streams = [...s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)].map((x) => {
    expect(x[2]!.length).toBe(Number(x[1]));
    return x[2]!;
  });
  const texts = streams.map((st) => [...st!.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((t) => t[1]!.replace(/\\([\\()])/g, "$1")));
  return { pageCount, mediaBoxes, texts, root: Number(m![4]), s };
}

describe("makePdf", () => {
  it("produit un PDF avec xref et trailer valides, une page A4 par défaut", () => {
    const pdf = make([{ texts: [{ x: 72, y: 700, size: 12, text: "Bonjour le monde" }] }]);
    const p = parse(pdf);
    expect(p.pageCount).toBe(1);
    expect(p.mediaBoxes).toEqual([[595, 842]]);
    expect(p.texts).toEqual([["Bonjour le monde"]]);
    expect(/\/Type \/Catalog \/Pages 2 0 R/.test(p.s)).toBe(true);
    expect(p.root).toBe(1);
  });

  it("gère plusieurs pages, un format paysage et des tailles variées", () => {
    const pdf = make([
      { texts: [{ x: 50, y: 800, size: 28, text: "Titre" }, { x: 50, y: 760, size: 9, text: "petit texte" }] },
      { width: 842, height: 595, texts: [{ x: 50, y: 500, size: 14, text: "paysage" }] },
    ]);
    const p = parse(pdf);
    expect(p.pageCount).toBe(2);
    expect(p.mediaBoxes).toEqual([[595, 842], [842, 595]]);
    expect(p.texts).toEqual([["Titre", "petit texte"], ["paysage"]]);
    expect(latin1(pdf)).toContain("/F1 28 Tf");
    expect(latin1(pdf)).toContain("/F1 9 Tf");
  });

  it("échappe parenthèses et barres obliques inverses", () => {
    const t = "a (b) c\\d";
    const p = parse(make([{ texts: [{ x: 1, y: 1, size: 10, text: t }] }]));
    expect(p.texts).toEqual([[t]]);
    expect(p.s).toContain("(a \\(b\\) c\\\\d) Tj");
  });

  it("encode les lettres accentuées en latin1 (octets, pas UTF-8)", () => {
    const pdf = make([{ texts: [{ x: 1, y: 1, size: 10, text: "été à Noël" }] }]);
    expect(pdf.includes(Buffer.from([0xe9, 0x74, 0xe9]))).toBe(true);
    expect(pdf.includes(Buffer.from("été", "utf8"))).toBe(false);
    expect(latin1(pdf)).toContain("/Encoding /WinAnsiEncoding");
  });

  it("est déterministe", () => {
    const spec = [{ texts: [{ x: 1, y: 2, size: 10, text: "x" }] }];
    expect(make(spec).equals(make(spec))).toBe(true);
  });

  it("accepte une page sans texte", () => {
    expect(parse(make([{ texts: [] }])).texts).toEqual([[]]);
  });

  it("refuse les entrées invalides avec un message clair", () => {
    expect(() => makePdf({ pages: [] })).toThrow(/page/i);
    expect(() => makePdf(null)).toThrow(/pages/i);
    expect(() => make([{ texts: [{ x: 1, y: 1, size: 10, text: "日本" }] }])).toThrow(/latin1|caractère/i);
    expect(() => make([{ texts: [{ x: 1, y: 1, size: 0, text: "a" }] }])).toThrow(/taille/i);
    expect(() => make([{ texts: [{ x: NaN, y: 1, size: 10, text: "a" }] }])).toThrow(/position/i);
    expect(() => make([{ width: -1, texts: [] }])).toThrow(/dimension|largeur/i);
    expect(() => make([{ texts: [{ x: 1, y: 1, size: 10, text: "a\nb" }] }])).toThrow(/saut|ligne/i);
  });
});

// Relecture par un vrai PDF.js (celui de SiYuan, s'il est installé) : le PDF produit est lisible.
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error -- module .mjs sans types
import { makeCorpus } from "../../../scripts/lib/testCorpus.mjs";

const PDFJS_DIR = process.env.PDFJS_DIR ?? "/Applications/SiYuan.app/Contents/Resources/stage/protyle/js/pdf";
describe.skipIf(!existsSync(`${PDFJS_DIR}/pdf.min.mjs`))("makePdf relu par PDF.js", () => {
  it("extrait le texte, les accents, les tailles et la page paysage du corpus", async () => {
    type Lib = {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument(s: unknown): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ view: number[]; getTextContent(): Promise<{ items: { str: string; height: number }[] }> }> }> };
    };
    const lib = (await import(/* @vite-ignore */ `${PDFJS_DIR}/pdf.min.mjs`)) as Lib;
    lib.GlobalWorkerOptions.workerSrc = `file://${PDFJS_DIR}/pdf.worker.min.mjs`;
    const corpus = makeCorpus(8) as { relPath: string; bytes: Buffer }[];
    const read = async (bytes: Buffer) => {
      const doc = await lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
      return Promise.all(Array.from({ length: doc.numPages }, async (_, i) => {
        const page = await doc.getPage(i + 1);
        return { view: page.view, items: (await page.getTextContent()).items.filter((x) => x.str) };
      }));
    };
    const rapport = await read(corpus.find((f) => f.relPath.endsWith("rapport-annuel.pdf"))!.bytes);
    expect(rapport).toHaveLength(3);
    expect(rapport[0]!.items[0]).toMatchObject({ str: "Rapport annuel", height: 28 });
    expect(rapport[0]!.items.map((x) => x.str)).toContain("Les résultats financiers progressent de douze pour cent.");
    const paysage = await read(corpus.find((f) => f.relPath.endsWith("plan-strategique.pdf"))!.bytes);
    expect(paysage[0]!.view).toEqual([0, 0, 842, 595]);
  });
});
