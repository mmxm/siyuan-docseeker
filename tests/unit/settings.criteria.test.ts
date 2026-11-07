import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SettingsFileUnreadableError, createSettings, normalizeSettings } from "../../src/settings";
import { NO_FILTERS } from "../../src/search/resultOptions";
import type { SavedCriteria } from "../../src/search/savedCriteria";

const BOX = "20240101120000-abcdefg";
const crit = (name: string, extra: Partial<SavedCriteria> = {}): SavedCriteria => ({
  name,
  query: "chat",
  filters: { ...NO_FILTERS },
  sort: { key: "relevance", direction: "desc" },
  groupByDocument: true,
  ...extra,
});

describe("normalizeSettings : savedCriteria", () => {
  it("défaut : liste vide ; champ absent (ancien fichier) valide, sans avertissement", () => {
    const warn = vi.fn();
    expect(DEFAULT_SETTINGS.savedCriteria).toEqual([]);
    expect(normalizeSettings({ autoIndex: true }, warn).savedCriteria).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("critères valides conservés, sans avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ savedCriteria: [crit("a"), crit("b")] }, warn).savedCriteria.map((c) => c.name)).toEqual(["a", "b"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("critère invalide ignoré avec un avertissement par critère, les autres gardés", () => {
    const warn = vi.fn();
    const out = normalizeSettings({ savedCriteria: [crit("a"), { name: "b" }, crit("c"), "x"] }, warn);
    expect(out.savedCriteria.map((c) => c.name)).toEqual(["a", "c"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/n°2/);
  });

  it("champ non tableau : liste vide et un avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ savedCriteria: "oups" }, warn).savedCriteria).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("portée injectée avec un docPath malveillant : critère rejeté à la lecture", () => {
    const warn = vi.fn();
    const evil = crit("evil", { filters: { ...NO_FILTERS, scopes: [{ kind: "document", box: BOX, docPath: "/x' or '1'='1.sy", label: "x" }] } });
    const out = normalizeSettings({ savedCriteria: [evil, crit("ok")] }, warn);
    expect(out.savedCriteria.map((c) => c.name)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** Fichier partagé en mémoire : deux magasins (deux fenêtres) lisent et écrivent le même `settings.json`. */
function sharedFile(initial?: unknown) {
  let file: unknown = initial === undefined ? undefined : structuredClone(initial);
  const saves: unknown[] = [];
  const make = () => {
    const warn = vi.fn();
    const store = createSettings({
      load: async () => structuredClone(file),
      save: async (value) => {
        file = structuredClone(value);
        saves.push(structuredClone(value));
      },
      onWarn: warn,
    });
    return { store, warn };
  };
  return { make, read: () => file as { savedCriteria?: SavedCriteria[] } | undefined, saves };
}

describe("createSettings : critères enregistrés", () => {
  it("critères seuls ignorés : avertissement par critère, mais le fichier n'est PAS réécrit (les critères non lus restent sur disque)", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), { name: 5 }] });
    const { store, warn } = f.make();
    await store.load();
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.saves).toHaveLength(0);
    expect((f.read()?.savedCriteria as unknown[]).length).toBe(2);
  });

  it("un autre réglage corrompu réécrit le fichier, sans perdre les critères valides", async () => {
    const f = sharedFile({ autoIndex: "oui", savedCriteria: [crit("a")] });
    const { store } = f.make();
    await store.load();
    expect(f.saves).toHaveLength(1);
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["a"]);
  });

  it("ancien fichier sans le champ : pas de réécriture", async () => {
    const f = sharedFile({ autoIndex: true, intervalMinutes: 5 });
    const { store } = f.make();
    await store.load();
    expect(f.saves).toHaveLength(0);
  });

  it("saveCriteria : ajoute, notifie, écrit ; renvoie replaced", async () => {
    const f = sharedFile();
    const { store } = f.make();
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    await expect(store.saveCriteria(crit("a"))).resolves.toEqual({ replaced: false });
    await expect(store.saveCriteria(crit("A", { query: "autre" }))).resolves.toEqual({ replaced: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.read()?.savedCriteria).toHaveLength(1);
    expect(f.read()?.savedCriteria?.[0]?.query).toBe("autre");
  });

  it("saveCriteria attend la lecture du fichier avant d'écrire (jamais les défauts par-dessus)", async () => {
    const f = sharedFile({ autoIndex: false, intervalMinutes: 15, savedCriteria: [crit("deja")] });
    const { store } = f.make();
    await store.saveCriteria(crit("nouveau")); // sans load() préalable
    expect(f.read()).toMatchObject({ autoIndex: false, intervalMinutes: 15 });
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["deja", "nouveau"]);
  });

  it("limite : 30 critères, un 31e est refusé sans écriture, remplacer reste permis", async () => {
    const f = sharedFile({ savedCriteria: Array.from({ length: 30 }, (_, i) => crit(`c${i}`)) });
    const { store } = f.make();
    await store.load();
    f.saves.length = 0;
    await expect(store.saveCriteria(crit("nouveau"))).resolves.toEqual({ error: "limit" });
    expect(f.saves).toHaveLength(0);
    await expect(store.saveCriteria(crit("c3", { query: "z" }))).resolves.toEqual({ replaced: true });
    expect(store.get().savedCriteria).toHaveLength(30);
  });

  it("saveCriteria avec removeNames : renomme et fusionne en une seule écriture, nouveau critère en fin", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), crit("vieux"), crit("c")] });
    const { store } = f.make();
    await expect(store.saveCriteria(crit("neuf"), ["vieux"])).resolves.toEqual({ replaced: false });
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["a", "c", "neuf"]);
    expect(f.saves).toHaveLength(1);
    await expect(store.saveCriteria(crit("a", { query: "z" }), ["c"])).resolves.toEqual({ replaced: true });
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["neuf", "a"]);
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["neuf", "a"]);
  });

  it("renommage dont l'écriture échoue : la liste en mémoire garde l'ancien nom, le rejet est propagé", async () => {
    let file: unknown = { savedCriteria: [crit("vieux")] };
    let fail = true;
    const store = createSettings({
      load: async () => structuredClone(file),
      save: async (v) => {
        if (fail) throw new Error("disque plein");
        file = structuredClone(v);
      },
      onWarn: vi.fn(),
    });
    await store.load();
    await expect(store.saveCriteria(crit("neuf"), ["vieux"])).rejects.toThrow("disque plein");
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["vieux"]);
    fail = false;
    await store.saveCriteria(crit("neuf"), ["vieux"]);
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["neuf"]);
  });

  it("renommage et fusion relisent le fichier : le critère ajouté par une autre fenêtre est gardé", async () => {
    const f = sharedFile({ savedCriteria: [crit("vieux")] });
    const a = f.make().store;
    const b = f.make().store;
    await a.load();
    await b.load();
    await b.saveCriteria(crit("de-b"));
    await a.saveCriteria(crit("neuf"), ["vieux"]);
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["de-b", "neuf"]);
  });

  it("DEUX INSTANCES qui enregistrent chacune un critère : aucun n'écrase l'autre", async () => {
    const f = sharedFile();
    const a = f.make().store;
    const b = f.make().store;
    await Promise.all([a.load(), b.load()]);
    await a.saveCriteria(crit("de-a"));
    await b.saveCriteria(crit("de-b"));
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["de-a", "de-b"]);
    expect(b.get().savedCriteria.map((c) => c.name)).toEqual(["de-a", "de-b"]);
  });

  it("DEUX INSTANCES : la limite de 30 compte les critères de l'autre fenêtre", async () => {
    const f = sharedFile({ savedCriteria: Array.from({ length: 29 }, (_, i) => crit(`c${i}`)) });
    const a = f.make().store;
    const b = f.make().store;
    await Promise.all([a.load(), b.load()]);
    await expect(a.saveCriteria(crit("x"))).resolves.toEqual({ replaced: false });
    await expect(b.saveCriteria(crit("y"))).resolves.toEqual({ error: "limit" });
    expect(f.read()?.savedCriteria).toHaveLength(30);
  });

  it("DEUX INSTANCES : une suppression ne ressuscite pas ce que l'autre a ajouté", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), crit("b")] });
    const a = f.make().store;
    const b = f.make().store;
    await Promise.all([a.load(), b.load()]);
    await a.saveCriteria(crit("c"));
    await b.deleteCriteria("a");
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["b", "c"]);
  });

  it("deux enregistrements simultanés du même magasin sont sérialisés (aucun perdu)", async () => {
    const f = sharedFile();
    const { store } = f.make();
    await Promise.all([store.saveCriteria(crit("a")), store.saveCriteria(crit("b")), store.deleteCriteria("zzz")]);
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("deleteCriteria renvoie vrai si retiré, faux sinon (sans écriture)", async () => {
    const f = sharedFile({ savedCriteria: [crit("a")] });
    const { store } = f.make();
    await store.load();
    f.saves.length = 0;
    await expect(store.deleteCriteria("inconnu")).resolves.toBe(false);
    expect(f.saves).toHaveLength(0);
    await expect(store.deleteCriteria("A")).resolves.toBe(true);
    expect(store.get().savedCriteria).toEqual([]);
  });

  it("écriture en échec : rejette, l'état en mémoire est restauré (et notifié) et la tentative suivante réécrit", async () => {
    let failing = true;
    let file: unknown;
    const store = createSettings({
      load: async () => structuredClone(file),
      save: async (v) => {
        if (failing) throw new Error("disque plein");
        file = structuredClone(v);
      },
      onWarn: vi.fn(),
    });
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    await expect(store.saveCriteria(crit("a"))).rejects.toThrow("disque plein");
    expect(store.get().savedCriteria).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2); // ajout puis restauration : les menus se resynchronisent
    failing = false;
    await store.saveCriteria(crit("b"));
    expect((file as { savedCriteria: SavedCriteria[] }).savedCriteria.map((c) => c.name)).toEqual(["b"]);
  });

  it("suppression dont l'écriture échoue : le critère reste dans la liste en mémoire, comme dans le fichier", async () => {
    let file: unknown = { savedCriteria: [crit("a"), crit("b")] };
    const store = createSettings({
      load: async () => structuredClone(file),
      save: async () => {
        throw new Error("disque plein");
      },
      onWarn: vi.fn(),
    });
    await store.load();
    await expect(store.deleteCriteria("a")).rejects.toThrow("disque plein");
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a", "b"]);
    expect((file as { savedCriteria: unknown[] }).savedCriteria).toHaveLength(2);
  });

  it("l'échec d'une écriture de critère ne bloque pas la file : l'écriture suivante réussit", async () => {
    let calls = 0;
    const saved: unknown[] = [];
    const store = createSettings({
      load: async () => undefined,
      save: async (v) => {
        calls += 1;
        if (calls === 1) throw new Error("une fois");
        saved.push(v);
      },
      onWarn: vi.fn(),
    });
    await expect(store.saveCriteria(crit("a"))).rejects.toThrow("une fois");
    await expect(store.saveCriteria(crit("b"))).resolves.toEqual({ replaced: false });
    expect(saved).toHaveLength(1);
  });

  it("relecture impossible : rejette sans rien écrire", async () => {
    const save = vi.fn(async () => undefined);
    let calls = 0;
    const store = createSettings({
      load: async () => {
        calls += 1;
        if (calls > 1) throw new Error("E/S");
        return undefined;
      },
      save,
      onWarn: vi.fn(),
    });
    await store.load();
    await expect(store.saveCriteria(crit("a"))).rejects.toThrow("E/S");
    expect(save).not.toHaveBeenCalled();
  });

  it("une relecture dont des critères sont corrompus les signale (trace) et garde les valides", async () => {
    const f = sharedFile({ savedCriteria: [crit("a")] });
    const { store, warn } = f.make();
    await store.load();
    // L'autre fenêtre a écrit un critère invalide entre-temps.
    const other = f.make().store;
    await other.load();
    const file = f.read() as { savedCriteria: unknown[] };
    file.savedCriteria.push({ name: "pourri" });
    await store.saveCriteria(crit("b"));
    expect(warn).toHaveBeenCalled();
    // Le critère que cette version ne comprend pas n'est pas perdu : il reste dans le fichier, après les critères valides.
    expect((f.read()?.savedCriteria as unknown[]).map((c) => (c as { name: string }).name)).toEqual(["a", "b", "pourri"]);
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("createSettings : entrées de critères non reconnues conservées dans le fichier (E)", () => {
  const unknownEntry = { name: "venu-du-futur", version: 9, payload: { x: 1 } };
  const fileOf = (f: ReturnType<typeof sharedFile>): unknown[] => f.read()?.savedCriteria as unknown[];

  it("2 valides + 1 inconnue : après l'enregistrement d'un critère, le fichier contient les 3 anciennes et la nouvelle", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), unknownEntry, crit("b")] });
    const { store } = f.make();
    await store.load();
    await store.saveCriteria(crit("c"));
    expect(fileOf(f)).toEqual([crit("a"), crit("b"), crit("c"), unknownEntry]);
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a", "b", "c"]); // jamais réinjectée dans la liste affichée
  });

  it("suppression : la ou les entrées inconnues restent aussi", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), unknownEntry, crit("b")] });
    const { store } = f.make();
    await store.load();
    await store.deleteCriteria("a");
    expect(fileOf(f)).toEqual([crit("b"), unknownEntry]);
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["b"]);
  });

  it("une entrée inconnue copiée telle quelle (valeurs brutes, y compris non objets) et jamais comptée dans la limite de 30", async () => {
    const odd = [unknownEntry, "texte", 42, null, [1, 2]];
    const valid = Array.from({ length: 29 }, (_v, i) => crit(`c${i}`));
    const f = sharedFile({ savedCriteria: [...valid, ...odd] });
    const { store } = f.make();
    await store.load();
    expect(await store.saveCriteria(crit("trentieme"))).toEqual({ replaced: false }); // 30 valides, malgré 5 inconnues
    expect(fileOf(f)).toEqual([...valid, crit("trentieme"), ...odd]);
    expect(await store.saveCriteria(crit("trente-et-un"))).toEqual({ error: "limit" });
  });

  it("au plus 30 entrées inconnues sont conservées", async () => {
    const junk = Array.from({ length: 45 }, (_v, i) => ({ junk: i }));
    const f = sharedFile({ savedCriteria: [crit("a"), ...junk] });
    const { store } = f.make();
    await store.load();
    await store.saveCriteria(crit("b"));
    expect(fileOf(f)).toEqual([crit("a"), crit("b"), ...junk.slice(0, 30)]);
  });

  it("un autre réglage modifié (update) conserve aussi les entrées inconnues", async () => {
    const f = sharedFile({ savedCriteria: [crit("a"), unknownEntry] });
    const { store } = f.make();
    await store.load();
    await store.update({ autoIndex: false });
    expect(fileOf(f)).toEqual([crit("a"), unknownEntry]);
  });

  it("la réécriture d'un fichier corrompu (autre réglage) conserve les entrées inconnues", async () => {
    const f = sharedFile({ autoIndex: "oui", savedCriteria: [crit("a"), unknownEntry] });
    const { store } = f.make();
    await store.load();
    expect(f.saves).toHaveLength(1);
    expect(fileOf(f)).toEqual([crit("a"), unknownEntry]);
  });

  it("entrée inconnue ajoutée par une autre fenêtre entre-temps : relue et conservée", async () => {
    const f = sharedFile({ savedCriteria: [crit("a")] });
    const { store } = f.make();
    await store.load();
    (f.read() as { savedCriteria: unknown[] }).savedCriteria.push(unknownEntry);
    await store.saveCriteria(crit("b"));
    expect(fileOf(f)).toEqual([crit("a"), crit("b"), unknownEntry]);
  });

  it("écriture en échec : la liste affichée est restaurée, sans entrée inconnue", async () => {
    let file: unknown = { savedCriteria: [crit("a"), unknownEntry] };
    let fail = true;
    const store = createSettings({
      load: async () => structuredClone(file),
      save: async (v) => {
        if (fail) throw new Error("disque plein");
        file = structuredClone(v);
      },
      onWarn: vi.fn(),
    });
    await store.load();
    await expect(store.saveCriteria(crit("b"))).rejects.toThrow("disque plein");
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a"]);
    fail = false;
    await store.saveCriteria(crit("b"));
    expect((file as { savedCriteria: unknown[] }).savedCriteria).toEqual([crit("a"), crit("b"), unknownEntry]);
  });
});

describe("createSettings : critères illisibles au chargement (message unique par session)", () => {
  const withHook = (file: unknown) => {
    const onCriteriaIgnored = vi.fn();
    const store = createSettings({ load: async () => structuredClone(file), save: async () => undefined, onWarn: vi.fn(), onCriteriaIgnored });
    return { store, onCriteriaIgnored };
  };

  it("appelé une fois avec le nombre de critères ignorés", async () => {
    const { store, onCriteriaIgnored } = withHook({ savedCriteria: [crit("a"), { name: 1 }, 7] });
    await store.load();
    await store.load();
    expect(onCriteriaIgnored).toHaveBeenCalledTimes(1);
    expect(onCriteriaIgnored).toHaveBeenCalledWith(2);
  });

  it("jamais appelé quand tout est valide ou que le champ est absent", async () => {
    for (const file of [{ savedCriteria: [crit("a")] }, { autoIndex: true }, undefined]) {
      const { store, onCriteriaIgnored } = withHook(file);
      await store.load();
      expect(onCriteriaIgnored).not.toHaveBeenCalled();
    }
  });

  it("un hook qui lève est tracé et ne casse pas le chargement", async () => {
    const warn = vi.fn();
    const store = createSettings({
      load: async () => ({ savedCriteria: [{ name: 1 }] }),
      save: async () => undefined,
      onWarn: warn,
      onCriteriaIgnored: () => {
        throw new Error("toast KO");
      },
    });
    await expect(store.load()).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/critères/i), expect.any(Error));
  });
});

describe("createSettings : relecture d'un fichier devenu illisible", () => {
  it("fichier non objet à la relecture : l'enregistrement est refusé (erreur typée, tracée), rien n'est écrit", async () => {
    let file: unknown = { savedCriteria: [crit("a")] };
    const warn = vi.fn();
    const save = vi.fn(async (v: unknown) => void (file = structuredClone(v)));
    const store = createSettings({ load: async () => structuredClone(file), save, onWarn: warn });
    await store.load();
    file = "pas du json";
    await expect(store.saveCriteria(crit("b"))).rejects.toBeInstanceOf(SettingsFileUnreadableError);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/illisibles/), expect.any(SettingsFileUnreadableError));
    expect(save).not.toHaveBeenCalled();
    expect(file).toBe("pas du json");
    expect(store.get().savedCriteria.map((c) => c.name)).toEqual(["a"]);
  });

  it("idem pour une suppression", async () => {
    let file: unknown = { savedCriteria: [crit("a")] };
    const save = vi.fn(async () => undefined);
    const store = createSettings({ load: async () => structuredClone(file), save, onWarn: vi.fn() });
    await store.load();
    file = [1, 2];
    await expect(store.deleteCriteria("a")).rejects.toBeInstanceOf(SettingsFileUnreadableError);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("createSettings : lecture initiale en échec", () => {
  it("load() qui rejette : défauts en mémoire, trace, et AUCUNE écriture (les critères du disque ne sont pas effacés)", async () => {
    const save = vi.fn(async () => undefined);
    const warn = vi.fn();
    const store = createSettings({
      load: async () => {
        throw new Error("E/S passagère");
      },
      save,
      onWarn: warn,
    });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Lecture/), expect.any(Error));
    expect(save).not.toHaveBeenCalled();
  });
});

describe("createSettings : écriture des autres réglages entre deux fenêtres", () => {
  it("update() relit les critères du fichier : le critère enregistré par l'autre fenêtre n'est pas effacé", async () => {
    const f = sharedFile();
    const a = f.make().store;
    const b = f.make().store;
    await Promise.all([a.load(), b.load()]);
    await b.saveCriteria(crit("de-b"));
    await a.update({ groupByDocument: false });
    expect(f.read()).toMatchObject({ groupByDocument: false });
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["de-b"]);
    expect(a.get().savedCriteria.map((c) => c.name)).toEqual(["de-b"]); // la mémoire de A suit
  });

  it("update() ne ressuscite pas un critère supprimé par l'autre fenêtre", async () => {
    const f = sharedFile({ savedCriteria: [crit("x"), crit("y")] });
    const a = f.make().store;
    const b = f.make().store;
    await Promise.all([a.load(), b.load()]);
    await b.deleteCriteria("x");
    await a.update({ openMode: "dialog" });
    expect(f.read()?.savedCriteria?.map((c) => c.name)).toEqual(["y"]);
  });

  it("update() avec un fichier devenu illisible : rejette sans écrire", async () => {
    let file: unknown = {};
    const save = vi.fn(async () => undefined);
    const store = createSettings({ load: async () => file, save, onWarn: vi.fn() });
    await store.load();
    file = "casse";
    await expect(store.update({ groupByDocument: false })).rejects.toBeInstanceOf(SettingsFileUnreadableError);
    expect(save).not.toHaveBeenCalled();
  });
});
