import { describe, expect, it, vi } from "vitest";
import { buildDocTree, filterDocTree, type DocTreeRow } from "../../../src/search/docTree";

const NB1 = "20210808180117-aaaaaaa";
const NB2 = "20210808180117-bbbbbbb";
const NB3 = "20210808180117-ccccccc";
const id = (n: number): string => `2021080818${String(n).padStart(4, "0")}-abcdefg`;

const notebooks = [
  { id: NB1, name: "Alpha", closed: false },
  { id: NB2, name: "Fermé", closed: true },
  { id: NB3, name: "Beta", closed: false },
];
const row = (box: string, path: string, hpath: string): DocTreeRow => ({ box, path, hpath });

describe("buildDocTree", () => {
  const rows: DocTreeRow[] = [
    row(NB3, `/${id(9)}.sy`, "/Zèbre"),
    row(NB1, `/${id(2)}/${id(3)}.sy`, "/Parent/Enfant"),
    row(NB1, `/${id(1)}.sy`, "/Parent B"),
    row(NB1, `/${id(2)}.sy`, "/Parent"),
    row(NB2, `/${id(5)}.sy`, "/Dans cahier fermé"),
    row("20210808180117-zzzzzzz", `/${id(6)}.sy`, "/Cahier inconnu"),
  ];
  const tree = buildDocTree(notebooks, rows);

  it("liste les cahiers ouverts puis leurs documents, cahiers fermés ou inconnus omis", () => {
    expect(tree.map((n) => [n.kind, n.label])).toEqual([
      ["notebook", "Alpha"],
      ["document", "Parent"],
      ["document", "Enfant"],
      ["document", "Parent B"],
      ["notebook", "Beta"],
      ["document", "Zèbre"],
    ]);
  });

  it("garde les enfants juste sous leur parent (« Parent B » ne s'intercale pas)", () => {
    const hpaths = tree.filter((n) => n.kind === "document" && n.box === NB1).map((n) => n.hpath);
    expect(hpaths).toEqual(["/Parent", "/Parent/Enfant", "/Parent B"]);
  });

  it("calcule la profondeur d'après le hpath et conserve box et docPath", () => {
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 2, 1, 0, 1]);
    const child = tree.find((n) => n.label === "Enfant");
    expect(child).toMatchObject({ kind: "document", box: NB1, docPath: `/${id(2)}/${id(3)}.sy`, hpath: "/Parent/Enfant" });
    expect(tree[0]).toMatchObject({ kind: "notebook", box: NB1, depth: 0 });
    expect(tree[0]?.docPath).toBeUndefined();
  });

  it("à hpath identique, l'ordre est celui du chemin (stable, indépendant de l'entrée)", () => {
    const a = row(NB1, `/${id(1)}.sy`, "/Même");
    const b = row(NB1, `/${id(2)}.sy`, "/Même");
    const paths = (t: ReturnType<typeof buildDocTree>): (string | undefined)[] => t.filter((n) => n.kind === "document").map((n) => n.docPath);
    expect(paths(buildDocTree([notebooks[0]!], [b, a]))).toEqual([a.path, b.path]);
    expect(paths(buildDocTree([notebooks[0]!], [a, b]))).toEqual([a.path, b.path]);
  });

  it("ne modifie pas ses entrées et gère le vide", () => {
    const before = JSON.stringify(rows);
    buildDocTree(notebooks, rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(buildDocTree([], [])).toEqual([]);
  });

  it("un hpath avec des « / » en trop ou vide reste exploitable", () => {
    const t = buildDocTree([notebooks[0]!], [row(NB1, `/${id(1)}.sy`, "//A//B/"), row(NB1, `/${id(2)}.sy`, "")]);
    expect(t.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(t[2]?.label).toBe("B");
  });
});

describe("filterDocTree", () => {
  const tree = buildDocTree(
    notebooks,
    Array.from({ length: 10 }, (_, i) => row(NB1, `/${id(i + 1)}.sy`, `/Rapport été ${i}`)).concat([
      row(NB1, `/${id(50)}.sy`, "/Cuisine/Café"),
    ]),
  );

  it("besoin vide : tout est gardé jusqu'à max, le reste est compté", () => {
    const r = filterDocTree(tree, "  ", 5);
    expect(r.items).toHaveLength(5);
    expect(r.hidden).toBe(tree.length - 5);
  });

  it("insensible à la casse, aux accents et à NFC/NFD", () => {
    expect(filterDocTree(tree, "ETE 3", 50).items.map((n) => n.hpath)).toEqual(["/Rapport été 3"]);
    expect(filterDocTree(tree, "cafe", 50).items.map((n) => n.label)).toEqual(["Café"]);
    expect(filterDocTree(tree, "café", 50).items).toHaveLength(1);
    expect(filterDocTree(tree, "cuisine/caf", 50).items).toHaveLength(1);
  });

  it("trouve un cahier par son nom", () => {
    expect(filterDocTree(tree, "alpha", 50).items.map((n) => n.kind)).toEqual(["notebook"]);
  });

  it("aucun résultat : liste vide, hidden 0 ; max respecté avec hidden exact", () => {
    expect(filterDocTree(tree, "introuvable", 50)).toEqual({ items: [], hidden: 0 });
    const r = filterDocTree(tree, "rapport", 4);
    expect(r.items).toHaveLength(4);
    expect(r.hidden).toBe(6);
  });

  it("max <= 0 donne aucun élément mais compte tout", () => {
    expect(filterDocTree(tree, "rapport", 0)).toEqual({ items: [], hidden: 10 });
  });
});

describe("buildDocTree : ordre et coût", () => {
  it("départage A et a par comparaison exacte : le parent reste contigu à ses enfants", () => {
    const rows = [
      row(NB1, `/${id(4)}/${id(5)}.sy`, "/a/y"),
      row(NB1, `/${id(1)}.sy`, "/A"),
      row(NB1, `/${id(2)}.sy`, "/a"),
      row(NB1, `/${id(1)}/${id(3)}.sy`, "/A/x"),
    ];
    const hp = buildDocTree(notebooks, rows).filter((n) => n.kind === "document").map((n) => n.hpath);
    const iA = hp.indexOf("/A");
    const ia = hp.indexOf("/a");
    expect(hp[iA + 1]).toBe("/A/x");
    expect(hp[ia + 1]).toBe("/a/y");
  });

  it("calcule les segments une fois par ligne, pas à chaque comparaison", () => {
    const spy = vi.spyOn(String.prototype, "normalize");
    const rows = Array.from({ length: 500 }, (_v, i) => row(NB1, `/${id(i)}.sy`, `/Doc ${(i * 7919) % 500}`));
    buildDocTree(notebooks, rows);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBeLessThan(500 * 6);
  });
});
