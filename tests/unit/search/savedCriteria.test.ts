import { describe, expect, it } from "vitest";
import {
  MAX_CRITERIA,
  MAX_CRITERIA_NAME,
  MAX_CRITERIA_QUERY,
  cleanCriteriaName,
  criteriaNameKey,
  normalizeCriteriaList,
  parseSavedCriteria,
  planCriteriaSave,
  removeCriteria,
  sameCriteria,
  upsertCriteria,
  type SavedCriteria,
} from "../../../src/search/savedCriteria";
import { NO_FILTERS } from "../../../src/search/resultOptions";

const BOX = "20240101120000-abcdefg";
const DOC = "/20240101120000-abcdefg/20240102120000-hijklmn.sy";
const make = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS },
  sort: { key: "relevance", direction: "desc" },
  groupByDocument: true,
  ...extra,
});

describe("constantes", () => {
  it("limites demandées", () => {
    expect(MAX_CRITERIA).toBe(30);
    expect(MAX_CRITERIA_NAME).toBe(80);
    expect(MAX_CRITERIA_QUERY).toBe(200);
  });
});

describe("cleanCriteriaName / criteriaNameKey", () => {
  it("rogne, réduit les espaces internes, retire contrôles et caractères de format", () => {
    expect(cleanCriteriaName("  Mon \t  critère\n ")).toBe("Mon critère");
    expect(cleanCriteriaName("a​b‮c\u0007d")).toBe("abcd");
  });
  it("espaces seuls : vide", () => {
    expect(cleanCriteriaName("   \t ")).toBe("");
  });
  it("clé d'unicité insensible à la casse, aux accents et à la forme NFC/NFD", () => {
    expect(criteriaNameKey("Éléphant")).toBe(criteriaNameKey("elephant"));
    expect(criteriaNameKey("Éléphant")).toBe(criteriaNameKey("ÉLÉPHANT"));
    expect(criteriaNameKey("a b")).not.toBe(criteriaNameKey("ab"));
  });
});

describe("parseSavedCriteria", () => {
  const valid = {
    name: "  Mon  critère ",
    query: " chat ",
    filters: { includeSubfolders: false, nameContains: "x", minPages: 2, maxPages: 9, modifiedAfterMs: 5 },
    sort: { key: "name", direction: "asc" },
    groupByDocument: false,
  };

  it("reconstruit un critère canonique, clés dans un ordre fixe", () => {
    const r = parseSavedCriteria(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("Mon critère");
    expect(r.value.query).toBe("chat");
    expect(Object.keys(r.value)).toEqual(["name", "query", "filters", "sort", "groupByDocument"]);
    expect(Object.keys(r.value.filters)).toEqual(["includeSubfolders", "nameContains", "minPages", "maxPages", "modifiedAfterMs"]);
    expect(Object.keys(r.value.sort)).toEqual(["key", "direction"]);
  });

  it("deux ordres de clés différents donnent le même JSON", () => {
    const a = parseSavedCriteria(valid);
    const b = parseSavedCriteria({ groupByDocument: false, sort: { direction: "asc", key: "name" }, filters: valid.filters, query: "chat", name: "Mon critère" });
    expect(a.ok && b.ok && JSON.stringify(a.value) === JSON.stringify(b.value)).toBe(true);
  });

  it("requête vide acceptée (critère à filtres seuls)", () => {
    const r = parseSavedCriteria({ ...valid, query: "" });
    expect(r.ok).toBe(true);
  });

  it("portée valide conservée", () => {
    const r = parseSavedCriteria({ ...valid, filters: { ...valid.filters, scopes: [{ kind: "document", box: BOX, docPath: DOC, label: "Cahier / Doc" }] } });
    expect(r.ok && r.value.filters.scopes).toEqual([{ kind: "document", box: BOX, docPath: DOC, label: "Cahier / Doc" }]);
    expect(r.ok && r.value.filters).not.toHaveProperty("folder");
  });

  it("lit l'ancien format `scope` singulier comme une liste d'un élément (jamais réécrit en singulier)", () => {
    const old = { kind: "document", box: BOX, docPath: DOC, label: "Cahier / Doc" };
    const r = parseSavedCriteria({ ...valid, filters: { ...valid.filters, scope: old } });
    expect(r.ok && r.value.filters.scopes).toEqual([old]);
    expect(r.ok && r.value.filters).not.toHaveProperty("scope");
  });

  it("deux portées conservées dans l'ordre", () => {
    const nb = { kind: "notebook", box: BOX, label: "C" };
    const doc = { kind: "document", box: BOX, docPath: DOC, label: "D" };
    const r = parseSavedCriteria({ ...valid, filters: { ...valid.filters, scopes: [nb, doc] } });
    expect(r.ok && r.value.filters.scopes).toEqual([nb, doc]);
  });

  it("une portée invalide dans la liste, 21 portées, un doublon ou une liste vide rejettent le critère", () => {
    const nb = { kind: "notebook", box: BOX, label: "C" };
    const bad = { kind: "document", box: BOX, docPath: "/x' or 1=1 --.sy", label: "x" };
    const many = Array.from({ length: 21 }, (_v, i) => ({ kind: "notebook", box: `20210808180117-aaaaa${"abcdefghij"[Math.floor(i / 10)]}${"abcdefghij"[i % 10]}`, label: "n" }));
    for (const scopes of [[nb, bad], many, [nb, { ...nb }], [], "x"]) {
      const r = parseSavedCriteria({ ...valid, filters: { ...valid.filters, scopes } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/portée/);
    }
    expect(parseSavedCriteria({ ...valid, filters: { ...valid.filters, scope: bad } }).ok).toBe(false);
  });

  it.each([
    ["non objet", 42, /objet/],
    ["tableau", [], /objet/],
    ["nom absent", { ...valid, name: undefined }, /nom/],
    ["nom non texte", { ...valid, name: 3 }, /nom/],
    ["nom vide après nettoyage", { ...valid, name: " ​ " }, /nom/],
    ["nom trop long", { ...valid, name: "x".repeat(81) }, /nom/],
    ["requête non texte", { ...valid, query: 3 }, /requête/],
    ["requête trop longue", { ...valid, query: "x".repeat(201) }, /requête/],
    ["filtres absents", { ...valid, filters: undefined }, /filtres/],
    ["filtres non objet", { ...valid, filters: "x" }, /filtres/],
    ["tri inconnu", { ...valid, sort: { key: "bidon", direction: "asc" } }, /tri/],
    ["tri valide mais non proposé", { ...valid, sort: { key: "path", direction: "desc" } }, /tri/],
    ["tri absent", { ...valid, sort: undefined }, /tri/],
    ["regroupement non booléen", { ...valid, groupByDocument: "oui" }, /regroupement/],
    ["portée avec docPath malveillant", { ...valid, filters: { ...valid.filters, scopes: [{ kind: "document", box: BOX, docPath: "/x' or 1=1 --.sy", label: "x" }] } }, /portée/],
    ["portée avec box malveillant", { ...valid, filters: { ...valid.filters, scopes: [{ kind: "notebook", box: "x'; drop", label: "x" }] } }, /portée/],
  ])("%s : rejeté avec une raison précise", (_n, raw, reason) => {
    const r = parseSavedCriteria(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
});

describe("normalizeCriteriaList", () => {
  it("absent : liste vide sans avertissement (ancien fichier)", () => {
    expect(normalizeCriteriaList(undefined)).toEqual({ list: [], warnings: [], ignored: 0, unrecognized: [] });
  });
  it("entrées illisibles rendues telles quelles (unrecognized) ; doublons et excédent ne le sont pas", () => {
    const junk = { name: "futur", v: 2 };
    const r = normalizeCriteriaList([make("a"), junk, "texte", make("A")]);
    expect(r.list.map((c) => c.name)).toEqual(["a"]);
    expect(r.unrecognized).toEqual([junk, "texte"]);
    expect(r.unrecognized[0]).toBe(junk);
  });
  it("non tableau : liste vide et un avertissement", () => {
    const r = normalizeCriteriaList({});
    expect(r.list).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
  it("garde les critères valides, ignore chaque invalide avec un avertissement précis (rang et nom)", () => {
    const good = make("Bon");
    const r = normalizeCriteriaList([good, { ...good, name: "Mauvais", sort: { key: "zzz", direction: "asc" } }, 7, make("Autre")]);
    expect(r.list.map((c) => c.name)).toEqual(["Bon", "Autre"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/2/);
    expect(r.warnings[0]).toMatch(/Mauvais/);
    expect(r.warnings[0]).toMatch(/tri/);
    expect(r.warnings[1]).toMatch(/3/);
  });
  it("doublon de nom (casse, accents) : le second est ignoré avec avertissement", () => {
    const r = normalizeCriteriaList([make("Été"), make("ete")]);
    expect(r.list.map((c) => c.name)).toEqual(["Été"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/doublon|existe/i);
  });
  it("plafonne à 30 avec un avertissement", () => {
    const many = Array.from({ length: 35 }, (_, i) => make(`c${i}`));
    const r = normalizeCriteriaList(many);
    expect(r.list).toHaveLength(MAX_CRITERIA);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("liste énorme de critères invalides : au plus 10 avertissements puis un seul « et N autres », ignored compte tout", () => {
    const r = normalizeCriteriaList(Array.from({ length: 5000 }, () => 7));
    expect(r.list).toEqual([]);
    expect(r.ignored).toBe(5000);
    expect(r.warnings).toHaveLength(11);
    expect(r.warnings[10]).toMatch(/4990 autres/);
  });
  it("exactement 10 critères ignorés : 10 avertissements, pas de ligne de synthèse", () => {
    const r = normalizeCriteriaList(Array.from({ length: 10 }, () => 7));
    expect(r.warnings).toHaveLength(10);
    expect(r.ignored).toBe(10);
  });
  it("11 ignorés : 10 avertissements + « et 1 autre »", () => {
    const r = normalizeCriteriaList(Array.from({ length: 11 }, () => 7));
    expect(r.warnings).toHaveLength(11);
    expect(r.warnings[10]).toMatch(/1 autre/);
  });
  it("liste non tableau : ignored = 1", () => {
    expect(normalizeCriteriaList({}).ignored).toBe(1);
  });
  it("l'avertissement ne contient pas de caractère de contrôle du nom", () => {
    const r = normalizeCriteriaList([{ name: "a\u0007b", query: 3 }]);
    expect(r.warnings[0]).not.toMatch(/\u0007/);
  });
});

describe("upsertCriteria", () => {
  it("ajoute en fin", () => {
    const r = upsertCriteria([make("a")], make("b"));
    expect(r).toMatchObject({ replaced: false });
    expect("list" in r && r.list.map((c) => c.name)).toEqual(["a", "b"]);
  });
  it("normalise le nom enregistré", () => {
    const r = upsertCriteria([], make("  x   y "));
    expect("list" in r && r.list[0]?.name).toBe("x y");
  });
  it("remplace un nom existant (casse, accents, NFC) et le place en fin, comme la recherche native", () => {
    const r = upsertCriteria([make("Été", { query: "a" }), make("b")], make("ETE", { query: "z" }));
    expect(r).toMatchObject({ replaced: true });
    if ("list" in r) {
      expect(r.list.map((c) => c.name)).toEqual(["b", "ETE"]);
      expect(r.list[1]?.query).toBe("z");
    }
  });
  it("renommer : retire l'ancien nom puis ajoute le nouveau en fin (replaced faux)", () => {
    const r = upsertCriteria([make("a"), make("vieux"), make("c")], make("neuf"), ["vieux"]);
    expect(r).toMatchObject({ replaced: false });
    expect("list" in r && r.list.map((c) => c.name)).toEqual(["a", "c", "neuf"]);
  });
  it("fusionner : retire l'autre critère ET celui de même nom, un seul reste", () => {
    const r = upsertCriteria([make("a"), make("x"), make("y")], make("y", { query: "z" }), ["x"]);
    expect(r).toMatchObject({ replaced: true });
    expect("list" in r && r.list.map((c) => c.name)).toEqual(["a", "y"]);
  });
  it("les noms à retirer suivent la règle d'unicité (casse, accents)", () => {
    const r = upsertCriteria([make("Été"), make("b")], make("c"), ["ETE"]);
    expect("list" in r && r.list.map((c) => c.name)).toEqual(["b", "c"]);
  });
  it("30 critères : renommer reste possible (une place se libère), ajouter non", () => {
    const full = Array.from({ length: 30 }, (_, i) => make(`c${i}`));
    const r = upsertCriteria(full, make("neuf"), ["c3"]);
    expect("list" in r && r.list).toHaveLength(30);
    expect(upsertCriteria(full, make("neuf"))).toEqual({ error: "limit" });
  });
  it("erreur (nom trop long) : aucun retrait", () => {
    expect(upsertCriteria([make("a")], make("x".repeat(81)), ["a"])).toEqual({ error: "tooLong" });
  });
  it("30 critères : un nouveau est refusé (limit), la liste n'est pas modifiée", () => {
    const full = Array.from({ length: 30 }, (_, i) => make(`c${i}`));
    expect(upsertCriteria(full, make("nouveau"))).toEqual({ error: "limit" });
  });
  it("30 critères : remplacer est autorisé", () => {
    const full = Array.from({ length: 30 }, (_, i) => make(`c${i}`));
    const r = upsertCriteria(full, make("C5", { query: "neuf" }));
    expect(r).toMatchObject({ replaced: true });
    expect("list" in r && r.list).toHaveLength(30);
  });
  it("nom vide, trop long ou requête trop longue : erreur précise", () => {
    expect(upsertCriteria([], make("  ​ "))).toEqual({ error: "empty" });
    expect(upsertCriteria([], make("x".repeat(MAX_CRITERIA_NAME + 1)))).toEqual({ error: "tooLong" });
    expect(upsertCriteria([], make("ok", { query: "x".repeat(201) }))).toEqual({ error: "query" });
  });
  it("tri valide mais hors des choix du sélecteur : refusé (il ne pourrait pas être relu)", () => {
    expect(upsertCriteria([], make("ok", { sort: { key: "path", direction: "desc" } }))).toEqual({ error: "sort" });
  });
  it("n'altère pas la liste d'entrée", () => {
    const input = [make("a")];
    upsertCriteria(input, make("b"));
    expect(input).toHaveLength(1);
  });
});

describe("removeCriteria", () => {
  it("retire par nom (insensible casse/accents) ; inconnu : liste équivalente", () => {
    const list = [make("Été"), make("b")];
    expect(removeCriteria(list, "ete").map((c) => c.name)).toEqual(["b"]);
    expect(removeCriteria(list, "zzz")).toHaveLength(2);
  });
});

describe("sameCriteria", () => {
  it("vrai pour un état identique, quelle que soit la casse de la requête exacte ? non : requête exacte après trim", () => {
    const a = make("a");
    expect(sameCriteria(a, { query: " chat ", filters: a.filters, sort: a.sort, groupByDocument: true })).toBe(true);
    expect(sameCriteria(a, { query: "Chat", filters: a.filters, sort: a.sort, groupByDocument: true })).toBe(false);
  });
  it("faux dès que filtres, tri ou regroupement diffèrent", () => {
    const a = make("a");
    const base = { query: "chat", filters: a.filters, sort: a.sort, groupByDocument: true };
    expect(sameCriteria(a, { ...base, filters: { ...a.filters, nameContains: "x" } })).toBe(false);
    expect(sameCriteria(a, { ...base, sort: { key: "name", direction: "asc" } })).toBe(false);
    expect(sameCriteria(a, { ...base, groupByDocument: false })).toBe(false);
  });
  it("la portée compte", () => {
    const scope = { kind: "notebook", box: BOX, label: "C" } as const;
    const a = make("a", { filters: { ...NO_FILTERS, scopes: [scope] } });
    expect(sameCriteria(a, { query: "chat", filters: { ...NO_FILTERS, scopes: [scope] }, sort: a.sort, groupByDocument: true })).toBe(true);
    expect(sameCriteria(a, { query: "chat", filters: { ...NO_FILTERS }, sort: a.sort, groupByDocument: true })).toBe(false);
  });
});

describe("planCriteriaSave : cas de la recherche native", () => {
  const state = (over: Partial<SavedCriteria> = {}) => {
    const { name: _n, ...rest } = make("x", over);
    return rest;
  };
  const other = { query: "autre" };

  it("nom vide (ou espaces, caractères invisibles) : empty", () => {
    expect(planCriteriaSave([], "  \u200b ", state())).toEqual({ kind: "empty" });
  });
  it("nom de plus de 80 caractères : tooLong ; requête de plus de 200 : query", () => {
    expect(planCriteriaSave([], "x".repeat(81), state())).toEqual({ kind: "tooLong" });
    expect(planCriteriaSave([], "ok", state({ query: "x".repeat(201) }))).toEqual({ kind: "query" });
  });
  it("rien de pareil : save avec le nom nettoyé", () => {
    expect(planCriteriaSave([make("a", other)], "  nouveau ", state())).toEqual({ kind: "save", name: "nouveau", removeNames: [] });
  });
  it("30 critères et un nouveau nom : limit", () => {
    const full = Array.from({ length: 30 }, (_, i) => make(`c${i}`, { query: `q${i}` }));
    expect(planCriteriaSave(full, "neuf", state())).toEqual({ kind: "limit" });
  });
  it("30 critères mais écrasement : permis", () => {
    const full = Array.from({ length: 30 }, (_, i) => make(`c${i}`, { query: `q${i}` }));
    expect(planCriteriaSave(full, "c4", state())).toMatchObject({ kind: "overwrite" });
  });
  it("même nom, configuration différente : overwrite", () => {
    expect(planCriteriaSave([make("a", other)], "a", state())).toEqual({ kind: "overwrite", name: "a", removeNames: [] });
  });
  it("même nom à la casse près (clé d'unicité), configuration différente : overwrite", () => {
    expect(planCriteriaSave([make("Été", other)], "ETE", state())).toMatchObject({ kind: "overwrite", name: "ETE" });
  });
  it("même configuration, nom différent : rename (de x vers y)", () => {
    expect(planCriteriaSave([make("vieux")], "neuf", state())).toEqual({ kind: "rename", name: "neuf", from: "vieux", removeNames: ["vieux"] });
  });
  it("deux critères distincts, l'un de même nom, l'autre de même configuration : merge", () => {
    const list = [make("cible", other), make("copie")];
    expect(planCriteriaSave(list, "cible", state())).toEqual({ kind: "merge", name: "cible", from: "copie", removeNames: ["copie"] });
  });
  it("même nom ET même configuration, même critère : noop", () => {
    expect(planCriteriaSave([make("a")], "a", state())).toEqual({ kind: "noop" });
  });
  it("même critère, nom différent seulement par la casse : rename (on peut corriger la casse)", () => {
    expect(planCriteriaSave([make("Chat")], "chat", state())).toMatchObject({ kind: "rename", from: "Chat", name: "chat" });
  });
  it("plusieurs critères de même configuration : le dernier est renommé (comme le natif)", () => {
    const list = [make("a"), make("b")];
    expect(planCriteriaSave(list, "neuf", state())).toMatchObject({ kind: "rename", from: "b" });
  });
  it("le chemin compte (le natif compare idPath) : même requête mais autre portée = configuration différente", () => {
    const scope = { kind: "notebook", box: BOX, label: "C" } as const;
    const list = [make("a", { filters: { ...NO_FILTERS, scopes: [scope] } })];
    expect(planCriteriaSave(list, "b", state())).toMatchObject({ kind: "save" });
  });
  it("n'altère pas la liste d'entrée", () => {
    const list = [make("a")];
    planCriteriaSave(list, "b", state());
    expect(list).toHaveLength(1);
  });
});
