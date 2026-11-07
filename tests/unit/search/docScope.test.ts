import { describe, expect, it } from "vitest";
import { DOC_PATH, MAX_SCOPES, SQL_ID, buildScopeSql, normalizedScopes, scopeKey, type DocumentScope } from "../../../src/search/docScope";

const BOX = "20210808180117-6v0mkxr";
const ID1 = "20210808180117-czj9bvb";
const ID2 = "20210808180118-abcdefg";

/** Une portée seule passe par la liste (la fonction unitaire n'est plus exportée). */
const normalizedScope = (raw: unknown): DocumentScope | undefined => normalizedScopes([raw])?.[0];

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
  it("distingue cahier, document et inclusion des enfants (le cahier seul n'en dépend pas)", () => {
    const nb = normalizedScope({ kind: "notebook", box: BOX, label: "a" })!;
    const doc = normalizedScope({ kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "a" })!;
    expect(scopeKey([nb], true)).toBe(scopeKey([nb], false));
    const keys = new Set([scopeKey([nb], true), scopeKey([doc], true), scopeKey([doc], false)]);
    expect(keys.size).toBe(3);
    // Mélange cahier + document : l'indicateur compte (il concerne le document).
    expect(scopeKey([nb, doc], true)).not.toBe(scopeKey([nb, doc], false));
  });
});

describe("buildScopeSql", () => {
  const ID3 = "20210808180119-zzzzzzz";
  const nb: DocumentScope = { kind: "notebook", box: BOX, label: "a" };
  const doc = (docPath: string): DocumentScope => ({ kind: "document", box: BOX, docPath, label: "a" });

  it("cahier entier (enfants inclus) : filtre sur box seul", () => {
    expect(buildScopeSql([nb], true, 50000)).toBe(
      `select distinct path from assets where box = '${BOX}' and lower(path) like '%.pdf' limit 50000`,
    );
  });

  it("cahier sans l'indicateur « enfants » : le cahier contient TOUJOURS tous ses documents (comme SiYuan)", () => {
    expect(buildScopeSql([nb], false, 50000)).toBe(buildScopeSql([nb], true, 50000));
    expect(buildScopeSql([nb], false, 50000)).not.toContain("not like");
  });

  it("portée x enfants : le cahier ne dépend pas de l'indicateur, le document si (3 clés et 3 SQL distincts)", () => {
    const d = doc(`/${ID1}.sy`);
    const combos = [nb, d].flatMap((s) => [true, false].map((c) => [scopeKey([s], c), buildScopeSql([s], c, 10)] as const));
    expect(new Set(combos.map((c) => c[0])).size).toBe(3);
    expect(new Set(combos.map((c) => c[1])).size).toBe(3);
  });

  it("document seul : docpath égal", () => {
    expect(buildScopeSql([doc(`/${ID1}/${ID2}.sy`)], false, 10)).toBe(
      `select distinct path from assets where box = '${BOX}' and docpath = '/${ID1}/${ID2}.sy' and lower(path) like '%.pdf' limit 10`,
    );
  });

  it("document et enfants (3 niveaux) : le document ou ses descendants", () => {
    expect(buildScopeSql([doc(`/${ID1}/${ID2}/${ID3}.sy`)], true, 10)).toBe(
      `select distinct path from assets where box = '${BOX}' and (docpath = '/${ID1}/${ID2}/${ID3}.sy' or docpath like '/${ID1}/${ID2}/${ID3}/%') and lower(path) like '%.pdf' limit 10`,
    );
    expect(buildScopeSql([doc(`/${ID1}.sy`)], true, 10)).toContain(`docpath like '/${ID1}/%'`);
  });

  it("deux cahiers : OU de deux conditions entre parenthèses", () => {
    const nb2: DocumentScope = { kind: "notebook", box: "20210808180120-bbbbbbb", label: "b" };
    expect(buildScopeSql([nb, nb2], true, 10)).toBe(
      `select distinct path from assets where ((box = '${BOX}') or (box = '20210808180120-bbbbbbb')) and lower(path) like '%.pdf' limit 10`,
    );
    expect(buildScopeSql([nb, nb2], false, 10)).toBe(buildScopeSql([nb, nb2], true, 10));
  });

  it("un cahier et un document", () => {
    expect(buildScopeSql([nb, doc(`/${ID1}.sy`)], true, 10)).toBe(
      `select distinct path from assets where ((box = '${BOX}') or (box = '${BOX}' and (docpath = '/${ID1}.sy' or docpath like '/${ID1}/%'))) and lower(path) like '%.pdf' limit 10`,
    );
  });

  it("deux documents avec et sans enfants", () => {
    const a = doc(`/${ID1}.sy`);
    const b = doc(`/${ID1}/${ID2}.sy`);
    expect(buildScopeSql([a, b], true, 10)).toBe(
      `select distinct path from assets where ((box = '${BOX}' and (docpath = '/${ID1}.sy' or docpath like '/${ID1}/%')) or (box = '${BOX}' and (docpath = '/${ID1}/${ID2}.sy' or docpath like '/${ID1}/${ID2}/%'))) and lower(path) like '%.pdf' limit 10`,
    );
    expect(buildScopeSql([a, b], false, 10)).toBe(
      `select distinct path from assets where ((box = '${BOX}' and docpath = '/${ID1}.sy') or (box = '${BOX}' and docpath = '/${ID1}/${ID2}.sy')) and lower(path) like '%.pdf' limit 10`,
    );
  });

  it("une portée forgée en 2e position lève (jamais interpolée)", () => {
    expect(() => buildScopeSql([nb, doc("/x' OR 1=1")], true, 10)).toThrow();
    expect(() => buildScopeSql([nb, { kind: "notebook", box: "x' OR 1=1", label: "a" }], true, 10)).toThrow();
  });

  it("liste vide ou au-delà de la limite : lève", () => {
    expect(() => buildScopeSql([], true, 10)).toThrow();
    const many = Array.from({ length: MAX_SCOPES + 1 }, (_v, i) => ({ ...nb, box: `20210808180117-${String(i).padStart(7, "a").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}` }));
    expect(() => buildScopeSql(many, true, 10)).toThrow();
  });

  it("lève sur une portée forgée (id, docPath ou limite invalides)", () => {
    expect(() => buildScopeSql([{ kind: "notebook", box: "x' OR 1=1", label: "a" }], true, 10)).toThrow();
    expect(() => buildScopeSql([doc("/x' OR 1=1")], true, 10)).toThrow();
    expect(() => buildScopeSql([doc(`/${ID1}%.sy`)], true, 10)).toThrow();
    expect(() => buildScopeSql([nb], true, 0)).toThrow();
    expect(() => buildScopeSql([nb], true, 1.5)).toThrow();
    expect(() => buildScopeSql([nb], true, Number.NaN)).toThrow();
  });
});

describe("scopeKey (liste)", () => {
  const nb: DocumentScope = { kind: "notebook", box: BOX, label: "a" };
  const d1: DocumentScope = { kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "x" };
  const d2: DocumentScope = { kind: "document", box: BOX, docPath: `/${ID1}/${ID2}.sy`, label: "y" };

  it("indépendante de l'ordre et des libellés", () => {
    expect(scopeKey([nb, d1, d2], true)).toBe(scopeKey([d2, nb, { ...d1, label: "autre" }], true));
  });

  it("deux listes différentes ne collisionnent pas, ni avec une portée seule", () => {
    const keys = new Set([
      scopeKey([nb], true),
      scopeKey([d1], true),
      scopeKey([nb, d1], true),
      scopeKey([nb, d1], false),
      scopeKey([d1, d2], true),
      scopeKey([nb, d2], true),
    ]);
    expect(keys.size).toBe(6);
  });

  it("le séparateur ne permet pas de forger une collision", () => {
    expect(scopeKey([nb, d1], true)).not.toBe(scopeKey([{ ...nb, box: `${BOX}` }], true) + scopeKey([d1], true));
    expect(scopeKey([nb, d1], true).split("\n")).toHaveLength(2 + 1);
  });
});

describe("normalizedScopes", () => {
  const box = (i: number): string => `20210808180117-${String(i).padStart(7, "a").replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;
  const nbi = (i: number): unknown => ({ kind: "notebook", box: box(i), label: `n${i}` });

  it("accepte 1 à 20 portées valides, dans l'ordre", () => {
    expect(normalizedScopes([nbi(0)])).toHaveLength(1);
    const twenty = normalizedScopes(Array.from({ length: MAX_SCOPES }, (_v, i) => nbi(i)));
    expect(twenty).toHaveLength(20);
    expect(twenty?.[3]?.box).toBe(box(3));
  });

  it("rejette 0 portée, 21 portées, un non-tableau", () => {
    expect(normalizedScopes([])).toBeUndefined();
    expect(normalizedScopes(Array.from({ length: MAX_SCOPES + 1 }, (_v, i) => nbi(i)))).toBeUndefined();
    expect(normalizedScopes({ kind: "notebook", box: BOX, label: "a" })).toBeUndefined();
    expect(normalizedScopes(null)).toBeUndefined();
    expect(normalizedScopes("x")).toBeUndefined();
  });

  it("rejette toute la liste si une portée est invalide ou si une clé est en double", () => {
    expect(normalizedScopes([nbi(0), { kind: "document", box: BOX, docPath: "/x' OR 1=1", label: "a" }])).toBeUndefined();
    expect(normalizedScopes([nbi(0), nbi(0)])).toBeUndefined();
    expect(normalizedScopes([nbi(0), { ...(nbi(0) as object), label: "autre libellé" }])).toBeUndefined();
  });

  it("un cahier et un document du même cahier ne sont pas des doublons", () => {
    expect(
      normalizedScopes([
        { kind: "notebook", box: BOX, label: "a" },
        { kind: "document", box: BOX, docPath: `/${ID1}.sy`, label: "b" },
      ]),
    ).toHaveLength(2);
  });

  it("reconstruit des objets sûrs (clés étrangères retirées)", () => {
    const out = normalizedScopes([{ kind: "notebook", box: BOX, label: "a", docPath: "/zzz" }]);
    expect(out).toEqual([{ kind: "notebook", box: BOX, label: "a" }]);
  });
});
