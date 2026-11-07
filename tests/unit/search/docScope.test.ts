import { describe, expect, it } from "vitest";
import { DOC_PATH, SQL_ID, buildScopeSql, normalizedScope, scopeKey, type DocumentScope } from "../../../src/search/docScope";

const BOX = "20210808180117-6v0mkxr";
const ID1 = "20210808180117-czj9bvb";
const ID2 = "20210808180118-abcdefg";

describe("normalizedScope", () => {
  it("accepte un cahier et un document, dans un ordre de clés fixe", () => {
    expect(JSON.stringify(normalizedScope({ label: "Cahier", box: BOX, kind: "notebook" }))).toBe(
      JSON.stringify({ kind: "notebook", box: BOX, label: "Cahier" }),
    );
    const doc = normalizedScope({ label: "Doc", docPath: `/${ID1}/${ID2}.sy`, box: BOX, kind: "document" });
    expect(JSON.stringify(doc)).toBe(JSON.stringify({ kind: "document", box: BOX, docPath: `/${ID1}/${ID2}.sy`, label: "Doc" }));
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["chaîne", "x"],
    ["tableau", []],
    ["kind inconnu", { kind: "x", box: BOX, label: "a" }],
    ["box invalide", { kind: "notebook", box: "abc", label: "a" }],
    ["box injectée", { kind: "notebook", box: "x' OR 1=1", label: "a" }],
    ["label absent", { kind: "notebook", box: BOX }],
    ["label non chaîne", { kind: "notebook", box: BOX, label: 3 }],
    ["document sans docPath", { kind: "document", box: BOX, label: "a" }],
    ["docPath injecté", { kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" }],
    ["docPath avec %", { kind: "document", box: BOX, docPath: `/${ID1}%.sy`, label: "a" }],
    ["docPath avec _", { kind: "document", box: BOX, docPath: `/${ID1}_.sy`, label: "a" }],
    ["docPath sans .sy", { kind: "document", box: BOX, docPath: `/${ID1}`, label: "a" }],
    ["docPath avec saut de ligne", { kind: "document", box: BOX, docPath: `/${ID1}.sy\n`, label: "a" }],
  ])("rejette %s", (_n, raw) => {
    expect(normalizedScope(raw)).toBeUndefined();
  });

  it("retire les marques bidi (Cf) et les caractères de contrôle (Cc) du libellé avant le plafond", () => {
    const s = normalizedScope({ kind: "notebook", box: BOX, label: "\u202Eab\u200Bc\u0007d\n" });
    expect(s?.label).toBe("abcd");
    const long = normalizedScope({ kind: "notebook", box: BOX, label: `${"\u202E".repeat(300)}${"x".repeat(250)}` });
    expect(long?.label).toBe("x".repeat(200));
  });

  it("tronque le libellé à 200 caractères et le met en NFC", () => {
    const s = normalizedScope({ kind: "notebook", box: BOX, label: "é".repeat(300) });
    expect(s?.label).toBe("é".repeat(200));
  });

  it("tronque par points de code : jamais de demi-paire de substitution", () => {
    const s = normalizedScope({ kind: "notebook", box: BOX, label: "😀".repeat(300) });
    expect(Array.from(s?.label ?? "")).toHaveLength(200);
    expect(s?.label).toBe("😀".repeat(200));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s?.label ?? "")).toBe(false); // aucune demi-paire
  });

  it("ignore les clés étrangères d'un cahier (docPath)", () => {
    const s = normalizedScope({ kind: "notebook", box: BOX, label: "a", docPath: "/zzz" });
    expect(s).toEqual({ kind: "notebook", box: BOX, label: "a" });
  });

  it("expose les regex strictes", () => {
    expect(SQL_ID.test(BOX)).toBe(true);
    expect(DOC_PATH.test(`/${ID1}.sy`)).toBe(true);
    expect(DOC_PATH.test(`/${ID1}/${ID2}.sy`)).toBe(true);
    expect(DOC_PATH.test(`/${ID1}'.sy`)).toBe(false);
  });
});

describe("scopeKey", () => {
  it("distingue cahier, document et inclusion des enfants", () => {
    const nb = normalizedScope({ kind: "notebook", box: BOX, label: "a" })!;
    const doc = normalizedScope({ kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "a" })!;
    const keys = new Set([scopeKey(nb, true), scopeKey(nb, false), scopeKey(doc, true), scopeKey(doc, false)]);
    expect(keys.size).toBe(4);
  });
});

describe("buildScopeSql", () => {
  const ID3 = "20210808180119-zzzzzzz";
  const nb: DocumentScope = { kind: "notebook", box: BOX, label: "a" };
  const doc = (docPath: string): DocumentScope => ({ kind: "document", box: BOX, docPath, label: "a" });

  it("cahier entier (enfants inclus) : filtre sur box seul", () => {
    expect(buildScopeSql(nb, true, 50000)).toBe(
      `select distinct path from assets where box = '${BOX}' and lower(path) like '%.pdf' limit 50000`,
    );
  });

  it("cahier sans enfants : seulement les documents de premier niveau (docpath sans second '/')", () => {
    expect(buildScopeSql(nb, false, 50000)).toBe(
      `select distinct path from assets where box = '${BOX}' and docpath not like '/%/%' and lower(path) like '%.pdf' limit 50000`,
    );
  });

  it("les 4 combinaisons portée x enfants donnent 4 clés et 4 SQL distincts", () => {
    const d = doc(`/${ID1}.sy`);
    const combos = [nb, d].flatMap((s) => [true, false].map((c) => [scopeKey(s, c), buildScopeSql(s, c, 10)] as const));
    expect(new Set(combos.map((c) => c[0])).size).toBe(4);
    expect(new Set(combos.map((c) => c[1])).size).toBe(4);
  });

  it("document seul : docpath égal", () => {
    expect(buildScopeSql(doc(`/${ID1}/${ID2}.sy`), false, 10)).toBe(
      `select distinct path from assets where box = '${BOX}' and docpath = '/${ID1}/${ID2}.sy' and lower(path) like '%.pdf' limit 10`,
    );
  });

  it("document et enfants (3 niveaux) : le document ou ses descendants", () => {
    expect(buildScopeSql(doc(`/${ID1}/${ID2}/${ID3}.sy`), true, 10)).toBe(
      `select distinct path from assets where box = '${BOX}' and (docpath = '/${ID1}/${ID2}/${ID3}.sy' or docpath like '/${ID1}/${ID2}/${ID3}/%') and lower(path) like '%.pdf' limit 10`,
    );
    expect(buildScopeSql(doc(`/${ID1}.sy`), true, 10)).toContain(`docpath like '/${ID1}/%'`);
  });

  it("lève sur une portée forgée (id, docPath ou limite invalides)", () => {
    expect(() => buildScopeSql({ kind: "notebook", box: "x' OR 1=1", label: "a" }, true, 10)).toThrow();
    expect(() => buildScopeSql(doc("/x' OR 1=1"), true, 10)).toThrow();
    expect(() => buildScopeSql(doc(`/${ID1}%.sy`), true, 10)).toThrow();
    expect(() => buildScopeSql(nb, true, 0)).toThrow();
    expect(() => buildScopeSql(nb, true, 1.5)).toThrow();
    expect(() => buildScopeSql(nb, true, Number.NaN)).toThrow();
  });
});
