import { describe, expect, it, vi } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import type { DocTree, DocTreeNode } from "../../../src/search/docTree";
import { DOC_MENU_MAX_ITEMS, docMenuItems, scopeOfNode } from "../../../src/ui/docMenu";
import { DEFAULT_STRINGS } from "../../../src/ui/searchView";

const t = (key: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  (DEFAULT_STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));
const NB = "20240101000000-aaaaaaa";
const NB2 = "20240101000000-bbbbbbb";
const id = (n: number): string => `20240102000000-${n.toString(36).padStart(7, "0")}`;
const NBSP2 = "  ";

const nb = (box: string, label: string): DocTreeNode => ({ kind: "notebook", box, hpath: "", label, depth: 0 });
const doc = (box: string, ids: string[], hpath: string): DocTreeNode => {
  const segments = hpath.split("/").filter(Boolean);
  return {
    kind: "document",
    box,
    docPath: `/${ids.join("/")}.sy`,
    hpath,
    label: segments.at(-1) ?? "",
    depth: segments.length,
  };
};

const small: DocTree = [
  nb(NB, "Cahier A"),
  doc(NB, [id(1)], "/Parent"),
  doc(NB, [id(1), id(2)], "/Parent/Enfant"),
  nb(NB2, "Cahier B"),
  doc(NB2, [id(3)], "/Autre"),
];

const build = (tree: DocTree, current?: DocumentScope, choose = vi.fn()) => ({
  items: docMenuItems({ tree, current, t, choose }),
  choose,
});

describe("scopeOfNode", () => {
  it("cahier : son nom ; document : « Cahier / Parent / Enfant »", () => {
    expect(scopeOfNode(small, small[0]!)).toEqual({ kind: "notebook", box: NB, label: "Cahier A" });
    expect(scopeOfNode(small, small[2]!)).toEqual({
      kind: "document",
      box: NB,
      docPath: `/${id(1)}/${id(2)}.sy`,
      label: "Cahier A / Parent / Enfant",
    });
  });

  it("document de premier niveau : « Cahier / Document »", () => {
    expect(scopeOfNode(small, small[4]!).label).toBe("Cahier B / Autre");
  });

  it("document dont le cahier est absent de l'arbre : le libellé reste le chemin lisible", () => {
    expect(scopeOfNode([], small[1]!).label).toBe("Parent");
  });
});

describe("docMenuItems", () => {
  it("cahiers sans retrait, documents indentés selon la profondeur", () => {
    const { items } = build(small);
    expect(items.map((i) => i.label)).toEqual(["Cahier A", `${NBSP2}Parent`, `${NBSP2}${NBSP2}Enfant`, "Cahier B", `${NBSP2}Autre`]);
    expect(items.every((i) => !i.disabled && !i.current && typeof i.click === "function")).toBe(true);
  });

  it("une seule entrée courante : le document choisi", () => {
    const current: DocumentScope = { kind: "document", box: NB, docPath: `/${id(1)}/${id(2)}.sy`, label: "x" };
    const { items } = build(small, current);
    expect(items.filter((i) => i.current)).toHaveLength(1);
    expect(items.find((i) => i.current)?.label).toBe(`${NBSP2}${NBSP2}Enfant`);
  });

  it("le cahier choisi est courant, pas ses documents", () => {
    const { items } = build(small, { kind: "notebook", box: NB2, label: "x" });
    expect(items.filter((i) => i.current).map((i) => i.label)).toEqual(["Cahier B"]);
  });

  it("choisir une entrée appelle choose avec la portée du nœud", () => {
    const { items, choose } = build(small);
    items[2]!.click!();
    expect(choose).toHaveBeenCalledWith(scopeOfNode(small, small[2]!));
  });

  it("plafond de 500 entrées puis une ligne désactivée « … N autres documents masqués »", () => {
    const tree = [nb(NB, "C"), ...Array.from({ length: 599 }, (_, i) => doc(NB, [id(i + 10)], `/D${i}`))];
    const { items } = build(tree);
    expect(items).toHaveLength(DOC_MENU_MAX_ITEMS + 1);
    expect(items.at(-1)).toEqual({ label: "… 100 autres documents masqués", disabled: true });
    expect(items.slice(0, -1).some((i) => i.disabled)).toBe(false);
  });

  it("singulier à un seul élément masqué ; pas de ligne sous le plafond", () => {
    const tree = [nb(NB, "C"), ...Array.from({ length: 500 }, (_, i) => doc(NB, [id(i + 10)], `/D${i}`))];
    expect(build(tree).items.at(-1)?.label).toBe("… 1 autre document masqué");
    expect(build(tree.slice(0, 500)).items.some((i) => i.disabled)).toBe(false);
  });

  it("la portée courante au-delà du plafond reste listée (courante) et n'est plus comptée comme masquée", () => {
    const tree = [nb(NB, "C"), ...Array.from({ length: 599 }, (_, i) => doc(NB, [id(i + 10)], `/D${i}`))];
    const last = tree.at(-1)!;
    const { items } = build(tree, { kind: "document", box: NB, docPath: last.docPath!, label: "C / D598" });
    expect(items.filter((i) => i.current)).toHaveLength(1);
    expect(items.at(-2)).toMatchObject({ label: `${NBSP2}D598`, current: true });
    expect(items.at(-1)?.label).toBe("… 99 autres documents masqués");
  });

  it("la portée courante absente de l'arbre (document supprimé) reste listée avec son libellé", () => {
    const gone: DocumentScope = { kind: "document", box: NB, docPath: `/${id(99)}.sy`, label: "Cahier A / Disparu" };
    const { items, choose } = build(small, gone);
    expect(items.at(-1)).toMatchObject({ label: "Cahier A / Disparu", current: true });
    items.at(-1)!.click!();
    expect(choose).toHaveBeenCalledWith(gone);
  });

  it("retrait plafonné à 8 niveaux, libellé tronqué à 120 caractères (jamais au milieu d'un emoji)", () => {
    const deep = doc(NB, Array.from({ length: 12 }, (_, i) => id(i + 100)), `/${Array.from({ length: 12 }, (_, i) => `n${i}`).join("/")}`);
    const long = doc(NB, [id(200)], `/${"😀".repeat(130)}`);
    const { items } = build([nb(NB, "C"), deep, long]);
    expect(items[1]!.label!.startsWith(NBSP2.repeat(8) + "n")).toBe(true);
    const text = items[2]!.label!.slice(NBSP2.length);
    expect(Array.from(text)).toHaveLength(120);
    expect(text.endsWith("…")).toBe(true);
    expect(Array.from(text).slice(0, 119).every((c) => c === "😀")).toBe(true);
  });

  it("un titre contenant du HTML reste du texte brut dans le libellé (l'adaptateur l'échappe)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { items } = build([nb(NB, evil), doc(NB, [id(1)], `/${evil}`)]);
    expect(items[0]!.label).toBe(evil);
    expect(items[1]!.label).toBe(NBSP2 + evil);
  });
});
