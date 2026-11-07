import { describe, expect, it, vi } from "vitest";
import type { DocumentScope } from "../../../src/search/docScope";
import {
  NO_FILTERS,
  applyFilters,
  countActiveFilters,
  normalizeSearchOptions,
  sameOptions,
  type ResultFilters,
} from "../../../src/search/resultOptions";
import type { DocInfo } from "../../../src/search/searchStore";

const BOX = "20210808180117-6v0mkxr";
const ID1 = "20210808180117-czj9bvb";
const scope: DocumentScope = { kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "Mon doc" };
const withScope = (over: Partial<ResultFilters> = {}): ResultFilters => ({ ...NO_FILTERS, scope, ...over });

const info = (docId: string, path: string, over: Partial<DocInfo> = {}): DocInfo => ({
  docId,
  path,
  title: docId,
  pageCount: 10,
  pdfSize: 1,
  pdfModifiedMs: 1000,
  ...over,
});

describe("normalizeSearchOptions : portée", () => {
  it("garde une portée valide, dans un ordre de clés stable", () => {
    const o = normalizeSearchOptions({ filters: { scope: { label: "Mon doc", docPath: `/${ID1}.sy`, box: BOX, kind: "document" } } });
    expect(o.filters.scope).toEqual(scope);
    expect(JSON.stringify(o.filters.scope)).toBe(JSON.stringify(scope));
  });

  it("rejette une portée invalide ou injectée ; NO_FILTERS reste sans portée", () => {
    expect(normalizeSearchOptions({ filters: { scope: { kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" } } }).filters.scope).toBeUndefined();
    expect(normalizeSearchOptions({ filters: { scope: 3 } }).filters).not.toHaveProperty("scope");
    expect(normalizeSearchOptions({}).filters).toEqual(NO_FILTERS);
    expect("scope" in NO_FILTERS).toBe(false);
  });

  it("exclusion mutuelle : portée ET dossier => portée gardée, dossier vidé", () => {
    const o = normalizeSearchOptions({ filters: { scope, folder: "assets/a" } });
    expect(o.filters.scope).toEqual(scope);
    expect(o.filters.folder).toBe("");
  });

  it("le dossier est conservé quand il n'y a pas de portée", () => {
    expect(normalizeSearchOptions({ filters: { folder: "assets/a" } }).filters.folder).toBe("assets/a/");
  });
});

describe("sameOptions / countActiveFilters : portée", () => {
  const sort = { key: "relevance", direction: "desc" } as const;
  it("compare les portées par contenu", () => {
    const a = { sort, filters: withScope() };
    expect(sameOptions(a, { sort, filters: withScope({ scope: { ...scope } }) })).toBe(true);
    expect(sameOptions(a, { sort, filters: NO_FILTERS })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ scope: { ...scope, label: "Autre" } }) })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ scope: { kind: "notebook", box: BOX, label: "Mon doc" } }) })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ includeSubfolders: false }) })).toBe(false);
  });

  it("la portée compte pour un critère", () => {
    expect(countActiveFilters(NO_FILTERS)).toBe(0);
    expect(countActiveFilters(withScope())).toBe(1);
    expect(countActiveFilters(withScope({ nameContains: "x" }))).toBe(2);
  });
});

describe("applyFilters : portée", () => {
  const docs = [{ docId: "in" }, { docId: "out" }, { docId: "never" }];
  const infos = new Map([
    ["in", info("in", "assets/in.pdf")],
    ["out", info("out", "assets/out.pdf")],
    ["never", info("never", "assets/never cité.pdf")],
  ]);
  const get = (id: string): DocInfo | undefined => infos.get(id);

  it("ne garde que les PDF cités ; les autres, dont un PDF jamais cité, comptent comme masqués", () => {
    const r = applyFilters(docs, withScope(), get, new Set(["assets/in.pdf"]));
    expect(r.kept.map((d) => d.docId)).toEqual(["in"]);
    expect(r.hidden).toBe(2);
  });

  it("compare en NFC (chemin d'index NFD, portée NFC)", () => {
    const nfdDocs = [{ docId: "d" }];
    const r = applyFilters(nfdDocs, withScope(), () => info("d", "assets/été.pdf"), new Set(["assets/été.pdf"]));
    expect(r.kept).toHaveLength(1);
  });

  it("portée active sans ensemble de chemins : aucun document gardé, jamais d'ignorance silencieuse", () => {
    const r = applyFilters(docs, withScope(), get, undefined);
    expect(r.kept).toEqual([]);
    expect(r.hidden).toBe(3);
  });

  it("un document sans info n'est pas gardé quand une portée est active", () => {
    const r = applyFilters([{ docId: "ghost" }], withScope(), () => undefined, new Set(["assets/in.pdf"]));
    expect(r.kept).toEqual([]);
    expect(r.hidden).toBe(1);
  });

  it("ET avec les autres filtres", () => {
    const r = applyFilters(docs, withScope({ nameContains: "out" }), get, new Set(["assets/in.pdf", "assets/out.pdf"]));
    expect(r.kept.map((d) => d.docId)).toEqual(["out"]);
    expect(r.hidden).toBe(2);
    const r2 = applyFilters(docs, withScope({ minPages: 50 }), get, new Set(["assets/in.pdf"]));
    expect(r2.kept).toEqual([]);
  });

  it("sans portée, scopePaths est ignoré", () => {
    const r = applyFilters(docs, NO_FILTERS, get, new Set());
    expect(r.kept).toHaveLength(3);
  });

  it("l'inclusion des enfants n'agit pas sur un dossier absent (le résolveur a déjà tranché)", () => {
    const a = applyFilters(docs, withScope({ includeSubfolders: false }), get, new Set(["assets/in.pdf"]));
    const b = applyFilters(docs, withScope({ includeSubfolders: true }), get, new Set(["assets/in.pdf"]));
    expect(a.kept).toEqual(b.kept);
  });
});

describe("normalizeSearchOptions : portée invalide signalée", () => {
  it("appelle onInvalidScope avec l'entrée brute quand une portée présente est retirée", () => {
    const onInvalidScope = vi.fn();
    const raw = { kind: "x", box: BOX, label: "L" };
    const o = normalizeSearchOptions({ filters: { scope: raw } }, onInvalidScope);
    expect(o.filters.scope).toBeUndefined();
    expect(onInvalidScope).toHaveBeenCalledExactlyOnceWith(raw);
  });

  it("ne l'appelle ni pour une portée valide ni pour une portée absente", () => {
    const onInvalidScope = vi.fn();
    normalizeSearchOptions({ filters: { scope } }, onInvalidScope);
    normalizeSearchOptions({ filters: {} }, onInvalidScope);
    normalizeSearchOptions(undefined, onInvalidScope);
    expect(onInvalidScope).not.toHaveBeenCalled();
  });
});

describe("normalizeSearchOptions : bornes de longueur (fichier non fiable)", () => {
  it("nameContains coupé à 200 points de code, sans demi-paire de substitution", () => {
    const out = normalizeSearchOptions({ filters: { nameContains: "😀".repeat(5000) } }).filters.nameContains;
    expect(out).toBe("😀".repeat(200));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false); // aucune demi-paire
  });
  it("dossier coupé à 200 points de code (plus le « / » final)", () => {
    const out = normalizeSearchOptions({ filters: { folder: "é".repeat(5000) } }).filters.folder;
    expect(out).toBe(`${"é".repeat(200)}/`);
    const emoji = normalizeSearchOptions({ filters: { folder: "😀".repeat(5000) } }).filters.folder;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji)).toBe(false); // aucune demi-paire
    expect(Array.from(emoji)).toHaveLength(201);
  });
  it("valeurs courtes inchangées", () => {
    const f = normalizeSearchOptions({ filters: { folder: "assets/a", nameContains: " abc " } }).filters;
    expect(f.folder).toBe("assets/a/");
    expect(f.nameContains).toBe("abc");
  });
});
