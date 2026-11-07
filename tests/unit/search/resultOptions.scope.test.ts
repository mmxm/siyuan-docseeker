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
const withScope = (over: Partial<ResultFilters> = {}): ResultFilters => ({ ...NO_FILTERS, scopes: [scope], ...over });

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
    const o = normalizeSearchOptions({ filters: { scopes: [{ label: "Mon doc", docPath: `/${ID1}.sy`, box: BOX, kind: "document" }] } });
    expect(o.filters.scopes).toEqual([scope]);
    expect(JSON.stringify(o.filters.scopes)).toBe(JSON.stringify([scope]));
  });

  it("rejette une portée invalide ou injectée ; NO_FILTERS reste sans portée", () => {
    expect(normalizeSearchOptions({ filters: { scopes: [{ kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" }] } }).filters.scopes).toBeUndefined();
    expect(normalizeSearchOptions({ filters: { scopes: 3 } }).filters).not.toHaveProperty("scopes");
    expect(normalizeSearchOptions({}).filters).toEqual(NO_FILTERS);
    expect("scopes" in NO_FILTERS).toBe(false);
  });

  it("portée ET ancien dossier : portée gardée, dossier ignoré (clé absente)", () => {
    const o = normalizeSearchOptions({ filters: { scopes: [scope], folder: "assets/a" } });
    expect(o.filters.scopes).toEqual([scope]);
    expect(o.filters).not.toHaveProperty("folder");
  });
});

const BOX2 = "20210808180120-bbbbbbb";
const scope2: DocumentScope = { kind: "notebook", box: BOX2, label: "Cahier 2" };

describe("normalizeSearchOptions : plusieurs portées et ancien format", () => {
  it("lit l'ancien `scope` singulier comme une liste d'un élément, jamais réécrit sous l'ancienne forme", () => {
    const o = normalizeSearchOptions({ filters: { scope: { kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "Mon doc" } } });
    expect(o.filters.scopes).toEqual([scope]);
    expect(o.filters).not.toHaveProperty("scope");
    expect(JSON.stringify(o.filters)).not.toContain('"scope":');
  });

  it("ancien `scope` invalide : retiré et signalé avec la valeur brute", () => {
    const onInvalidScope = vi.fn();
    const raw = { kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" };
    const o = normalizeSearchOptions({ filters: { scope: raw } }, onInvalidScope);
    expect(o.filters).not.toHaveProperty("scopes");
    expect(onInvalidScope).toHaveBeenCalledExactlyOnceWith(raw);
  });

  it("garde deux portées dans l'ordre", () => {
    const o = normalizeSearchOptions({ filters: { scopes: [scope, scope2] } });
    expect(o.filters.scopes).toEqual([scope, scope2]);
  });

  it("une portée invalide dans la liste écarte TOUTE la liste, avec avertissement", () => {
    const onInvalidScope = vi.fn();
    const bad = { kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" };
    const o = normalizeSearchOptions({ filters: { scopes: [scope, bad], folder: "assets/a" } }, onInvalidScope);
    expect(o.filters).not.toHaveProperty("scopes");
    expect(onInvalidScope).toHaveBeenCalledExactlyOnceWith([scope, bad]);
    expect(o.filters).not.toHaveProperty("folder");
  });

  it("21 portées ou un doublon : liste écartée avec avertissement", () => {
    const onInvalidScope = vi.fn();
    expect(normalizeSearchOptions({ filters: { scopes: [scope, { ...scope }] } }, onInvalidScope).filters).not.toHaveProperty("scopes");
    const many = Array.from({ length: 21 }, (_v, i) => ({ kind: "notebook", box: `20210808180117-aaaaa${String(i).padStart(2, "0").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`, label: "n" }));
    expect(normalizeSearchOptions({ filters: { scopes: many } }, onInvalidScope).filters).not.toHaveProperty("scopes");
    expect(onInvalidScope).toHaveBeenCalledTimes(2);
  });

  it("une liste valide n'est pas affectée par un ancien dossier", () => {
    expect(normalizeSearchOptions({ filters: { scopes: [scope, scope2], folder: "assets/a" } }).filters.scopes).toEqual([scope, scope2]);
  });
});

describe("sameOptions / countActiveFilters : portée", () => {
  const sort = { key: "relevance", direction: "desc" } as const;
  it("compare les portées par contenu", () => {
    const a = { sort, filters: withScope() };
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [{ ...scope }] }) })).toBe(true);
    expect(sameOptions(a, { sort, filters: NO_FILTERS })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [{ kind: "notebook", box: BOX, label: "Mon doc" }] }) })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [{ ...scope, docPath: `/${ID1}/${ID1}.sy` }] }) })).toBe(false);
    expect(sameOptions(a, { sort, filters: withScope({ includeSubfolders: false }) })).toBe(false);
  });

  it("compare les listes par longueur et contenu ordonné", () => {
    const a = { sort, filters: withScope({ scopes: [scope, scope2] }) };
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [{ ...scope }, { ...scope2 }] }) })).toBe(true);
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [scope] }) })).toBe(false);
  });

  it("la cible compte, pas le libellé ni l'ordre : un document renommé ou un autre ordre reste le même critère", () => {
    const a = { sort, filters: withScope({ scopes: [scope, scope2] }) };
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [{ ...scope, label: "Renommé" }, scope2] }) })).toBe(true);
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [scope2, scope] }) })).toBe(true);
    expect(sameOptions(a, { sort, filters: withScope({ scopes: [scope, { kind: "notebook", box: BOX, label: "Cahier 2" }] }) })).toBe(false);
  });

  it("cahiers seuls : l'indicateur « enfants » n'a aucun effet (ancienne valeur false lue comme true)", () => {
    const nb: DocumentScope = { kind: "notebook", box: BOX, label: "C" };
    const a = { sort, filters: { ...NO_FILTERS, scopes: [nb], includeSubfolders: false } };
    expect(sameOptions(a, { sort, filters: { ...NO_FILTERS, scopes: [nb], includeSubfolders: true } })).toBe(true);
    const mixed = (flag: boolean) => ({ sort, filters: { ...NO_FILTERS, scopes: [nb, scope], includeSubfolders: flag } });
    expect(sameOptions(mixed(true), mixed(false))).toBe(false);
  });

  it("une liste de plusieurs portées compte pour UN seul critère", () => {
    expect(countActiveFilters(withScope({ scopes: [scope, scope2] }))).toBe(1);
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
    const o = normalizeSearchOptions({ filters: { scopes: [raw] } }, onInvalidScope);
    expect(o.filters.scopes).toBeUndefined();
    expect(onInvalidScope).toHaveBeenCalledExactlyOnceWith([raw]);
  });

  it("ne l'appelle ni pour une portée valide ni pour une portée absente", () => {
    const onInvalidScope = vi.fn();
    normalizeSearchOptions({ filters: { scopes: [scope] } }, onInvalidScope);
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
  it("valeurs courtes inchangées", () => {
    const f = normalizeSearchOptions({ filters: { nameContains: " abc " } }).filters;
    expect(f.nameContains).toBe("abc");
  });
});
