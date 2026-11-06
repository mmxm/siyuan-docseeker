import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, FREQUENCY_MINUTES, SETTINGS_FILE, createSettings, normalizeSettings } from "../../src/settings";

/** Valeurs par défaut des champs de présentation (tri et regroupement), ajoutés après les deux premiers réglages. */
const EXTRA = { sort: { key: "relevance", direction: "desc" }, groupByDocument: true, history: [] } as const;

describe("normalizeSettings", () => {
  it("défauts : indexation automatique activée, 5 minutes", () => {
    expect(DEFAULT_SETTINGS).toEqual({ autoIndex: true, intervalMinutes: 5, ...EXTRA });
    expect(FREQUENCY_MINUTES).toEqual([5, 15, 60]);
    expect(SETTINGS_FILE).toBe("settings.json");
  });

  it("absence de fichier (undefined, null, chaîne vide) : défauts sans avertissement", () => {
    const warn = vi.fn();
    for (const raw of [undefined, null, ""]) expect(normalizeSettings(raw, warn)).toEqual(DEFAULT_SETTINGS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("valeurs valides conservées", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ autoIndex: false, intervalMinutes: 60 }, warn)).toEqual({ autoIndex: false, intervalMinutes: 60, ...EXTRA });
    expect(warn).not.toHaveBeenCalled();
  });

  it("champ absent : défaut, sans avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ intervalMinutes: 15 }, warn)).toEqual({ autoIndex: true, intervalMinutes: 15, ...EXTRA });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["intervalle inconnu", { autoIndex: true, intervalMinutes: 7 }, { autoIndex: true, intervalMinutes: 5, ...EXTRA }],
    ["intervalle texte", { autoIndex: true, intervalMinutes: "15" }, { autoIndex: true, intervalMinutes: 5, ...EXTRA }],
    ["intervalle NaN", { intervalMinutes: Number.NaN }, { autoIndex: true, intervalMinutes: 5, ...EXTRA }],
    ["interrupteur texte", { autoIndex: "false", intervalMinutes: 15 }, { autoIndex: true, intervalMinutes: 15, ...EXTRA }],
    ["interrupteur nul", { autoIndex: null, intervalMinutes: 15 }, { autoIndex: true, intervalMinutes: 15, ...EXTRA }],
    ["ancien intervalle d'une minute (retiré)", { autoIndex: true, intervalMinutes: 1 }, { autoIndex: true, intervalMinutes: 5, ...EXTRA }],
  ])("%s : retombe sur le défaut du champ et journalise", (_name, raw, expected) => {
    const warn = vi.fn();
    expect(normalizeSettings(raw, warn)).toEqual(expected);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([["texte", "abc"], ["nombre", 3], ["tableau", [1]], ["booléen", true]])(
    "contenu non objet (%s) : défauts et avertissement",
    (_n, raw) => {
      const warn = vi.fn();
      expect(normalizeSettings(raw, warn)).toEqual(DEFAULT_SETTINGS);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("createSettings", () => {
  const make = (stored: unknown, saveImpl: (v: unknown) => Promise<void> = async () => undefined) => {
    const save = vi.fn(saveImpl);
    const warn = vi.fn();
    const store = createSettings({ load: async () => stored, save, onWarn: warn });
    return { store, save, warn };
  };

  it("get() renvoie les défauts avant load()", () => {
    expect(make(undefined).store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("load() valide le contenu et notifie", async () => {
    const { store } = make({ autoIndex: false, intervalMinutes: 15 });
    const listener = vi.fn();
    store.subscribe(listener);
    await store.load();
    expect(store.get()).toEqual({ autoIndex: false, intervalMinutes: 15, ...EXTRA });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("load() qui rejette : défauts, avertissement, ne rejette pas", async () => {
    const warn = vi.fn();
    const store = createSettings({ load: async () => { throw new Error("E/S"); }, save: async () => undefined, onWarn: warn });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it("load() qui lève de façon synchrone est traité de même", async () => {
    const warn = vi.fn();
    const store = createSettings({ load: () => { throw new Error("sync"); }, save: async () => undefined, onWarn: warn });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
  });

  it("update() applique tout de suite, notifie, puis enregistre l'objet complet", async () => {
    const { store, save } = make(undefined);
    await store.load(); // chargé : l'application est alors immédiate
    const listener = vi.fn();
    store.subscribe(listener);
    const done = store.update({ intervalMinutes: 15 });
    expect(store.get().intervalMinutes).toBe(15);
    expect(listener).toHaveBeenCalledTimes(1);
    await done;
    expect(save).toHaveBeenCalledWith({ autoIndex: true, intervalMinutes: 15, ...EXTRA });
  });

  it("update() garde la valeur en mémoire et rejette si l'enregistrement échoue", async () => {
    const { store } = make(undefined, async () => { throw new Error("disque plein"); });
    await expect(store.update({ autoIndex: false })).rejects.toThrow("disque plein");
    expect(store.get().autoIndex).toBe(false);
  });

  it("update() avec une valeur invalide : défaut du champ et avertissement", async () => {
    const { store, warn } = make(undefined);
    await store.update({ intervalMinutes: 3 });
    expect(store.get().intervalMinutes).toBe(5);
    expect(warn).toHaveBeenCalled();
  });

  it("update() sans changement n'enregistre ni ne notifie", async () => {
    const { store, save } = make(undefined);
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.update({ autoIndex: true });
    expect(save).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe renvoie un désabonnement ; un écouteur qui lève est journalisé sans bloquer les autres", async () => {
    const { store, warn } = make(undefined);
    await store.load();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    store.subscribe(bad);
    const off = store.subscribe(good);
    await store.update({ autoIndex: false });
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    off();
    await store.update({ autoIndex: true });
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("createSettings : enregistrement sérialisé", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };

  it("enregistrements sérialisés, la dernière valeur gagne (les changements groupés n'écrivent qu'une fois)", async () => {
    const first = deferred();
    const saved: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    const store = createSettings({
      load: async () => undefined,
      save: async (v) => {
        active++;
        maxActive = Math.max(maxActive, active);
        saved.push(v);
        if (saved.length === 1) await first.promise;
        active--;
      },
      onWarn: vi.fn(),
    });
    await store.ready;
    const a = store.update({ intervalMinutes: 15 });
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toHaveLength(1); // le premier enregistrement est en vol
    const b = store.update({ intervalMinutes: 60 });
    const c = store.update({ autoIndex: false });
    await Promise.resolve();
    expect(saved).toHaveLength(1); // les suivants attendent
    first.resolve();
    await Promise.all([a, b, c]);
    expect(maxActive).toBe(1);
    expect(saved).toEqual([
      { autoIndex: true, intervalMinutes: 15, ...EXTRA },
      { autoIndex: false, intervalMinutes: 60, ...EXTRA },
    ]);
  });

  it("après un échec d'enregistrement, une modification à valeur identique retente", async () => {
    const save = vi.fn<(v: unknown) => Promise<void>>().mockRejectedValueOnce(new Error("disque plein")).mockResolvedValue(undefined);
    const store = createSettings({ load: async () => undefined, save, onWarn: vi.fn() });
    await expect(store.update({ autoIndex: false })).rejects.toThrow("disque plein");
    await store.update({ autoIndex: false });
    expect(save).toHaveBeenCalledTimes(2);
    await store.update({ autoIndex: false }); // déjà enregistré : rien de plus
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("un échec n'empêche pas les enregistrements suivants de la file", async () => {
    const save = vi.fn<(v: unknown) => Promise<void>>().mockRejectedValueOnce(new Error("KO")).mockResolvedValue(undefined);
    const store = createSettings({ load: async () => undefined, save, onWarn: vi.fn() });
    const a = store.update({ intervalMinutes: 15 });
    const b = store.update({ intervalMinutes: 60 });
    await expect(a).rejects.toThrow("KO");
    await expect(b).resolves.toBeUndefined();
    expect(save).toHaveBeenLastCalledWith({ autoIndex: true, intervalMinutes: 60, ...EXTRA });
  });
});

describe("createSettings : fichier corrompu", () => {
  it("contenu illisible : avertissement qui annonce l'interrupteur activé, et fichier réécrit avec les valeurs valides", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const warn = vi.fn();
    const store = createSettings({ load: async () => "pas du json", save, onWarn: warn });
    await store.load();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/activée/), undefined);
    expect(save).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it("valeur inconnue : les autres champs sont conservés dans le fichier réécrit", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const store = createSettings({ load: async () => ({ autoIndex: false, intervalMinutes: 1 }), save, onWarn: vi.fn() });
    await store.load();
    expect(save).toHaveBeenCalledWith({ autoIndex: false, intervalMinutes: 5, ...EXTRA });
  });

  it("fichier absent ou valide : aucune réécriture", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    await createSettings({ load: async () => undefined, save, onWarn: vi.fn() }).load();
    await createSettings({ load: async () => ({ autoIndex: true, intervalMinutes: 15 }), save, onWarn: vi.fn() }).load();
    expect(save).not.toHaveBeenCalled();
  });

  it("la réécriture qui échoue est journalisée, load() ne rejette pas", async () => {
    const warn = vi.fn();
    const store = createSettings({ load: async () => 42, save: async () => { throw new Error("lecture seule"); }, onWarn: warn });
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "lecture seule" }));
  });
});

describe("réglages de présentation : tri et regroupement", () => {
  it("défauts : pertinence décroissante, regroupement par document actif", () => {
    expect(DEFAULT_SETTINGS.sort).toEqual({ key: "relevance", direction: "desc" });
    expect(DEFAULT_SETTINGS.groupByDocument).toBe(true);
  });

  it("un ANCIEN fichier (deux champs) se charge sans avertissement, avec les défauts pour les nouveaux", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ autoIndex: false, intervalMinutes: 15 }, warn)).toEqual({
      autoIndex: false, intervalMinutes: 15, ...EXTRA,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("valeurs valides conservées (objet de tri, et forme texte « clé:sens »)", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ sort: { key: "name", direction: "asc" }, groupByDocument: false }, warn)).toMatchObject({
      sort: { key: "name", direction: "asc" }, groupByDocument: false,
    });
    expect(normalizeSettings({ sort: "matches:desc" }, warn).sort).toEqual({ key: "matches", direction: "desc" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["texte inconnu", "foo:asc"],
    ["clé inconnue", { key: "foo", direction: "asc" }],
    ["ancienne clé pages", { key: "pages", direction: "desc" }],
    ["sens inconnu", { key: "name", direction: "up" }],
    ["tri non proposé", "path:desc"],
    ["nombre", 3],
    ["nul", null],
  ])("tri invalide (%s) : défaut ET avertissement unique", (_n, sort) => {
    const warn = vi.fn();
    expect(normalizeSettings({ autoIndex: true, intervalMinutes: 5, sort }, warn).sort).toEqual(EXTRA.sort);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([["texte", "false"], ["nombre", 0], ["nul", null]])("regroupement invalide (%s) : défaut true ET avertissement", (_n, groupByDocument) => {
    const warn = vi.fn();
    expect(normalizeSettings({ groupByDocument }, warn).groupByDocument).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  const make = () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const warn = vi.fn();
    return { store: createSettings({ load: async () => undefined, save, onWarn: warn }), save, warn };
  };

  it("update({ sort }) : applique, notifie, enregistre l'objet complet avec le tri", async () => {
    const { store, save } = make();
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.update({ sort: { key: "modified", direction: "desc" } });
    expect(store.get().sort).toEqual({ key: "modified", direction: "desc" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ autoIndex: true, intervalMinutes: 5, sort: { key: "modified", direction: "desc" }, groupByDocument: true, history: [] });
  });

  it("update({ groupByDocument }) : applique, notifie, enregistre", async () => {
    const { store, save } = make();
    await store.update({ groupByDocument: false });
    expect(store.get().groupByDocument).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("update() compare l'objet normalisé COMPLET : un tri identique mais NOUVEL objet ne notifie ni n'enregistre", async () => {
    const { store, save } = make();
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.update({ sort: { key: "relevance", direction: "desc" } });
    await store.update({ sort: "relevance:desc" as never });
    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("update() avec un tri invalide : défaut (donc sans changement), avertissement, rien enregistré", async () => {
    const { store, save, warn } = make();
    await store.update({ sort: { key: "foo", direction: "asc" } as never });
    expect(store.get().sort).toEqual(EXTRA.sort);
    expect(warn).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("fichier ancien : aucune réécriture au chargement", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const warn = vi.fn();
    await createSettings({ load: async () => ({ autoIndex: true, intervalMinutes: 15 }), save, onWarn: warn }).load();
    expect(save).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("tri invalide dans le fichier : défaut, avertissement et réécriture avec les valeurs valides", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const warn = vi.fn();
    const store = createSettings({ load: async () => ({ autoIndex: false, intervalMinutes: 15, sort: "foo:asc" }), save, onWarn: warn });
    await store.load();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ autoIndex: false, intervalMinutes: 15, ...EXTRA });
    expect(save).toHaveBeenCalledWith({ autoIndex: false, intervalMinutes: 15, ...EXTRA });
  });
});

describe("createSettings : chargement unique et mise à jour avant la fin du chargement (J10 10c)", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  };
  const STORED = { autoIndex: false, intervalMinutes: 60, sort: { key: "name", direction: "asc" }, groupByDocument: false };

  it("ready : promesse résolue une fois le fichier lu ; load() est idempotent (une seule lecture)", async () => {
    const load = vi.fn(async () => STORED);
    const store = createSettings({ load, save: vi.fn(async () => undefined), onWarn: vi.fn() });
    expect(store.ready).toBeInstanceOf(Promise);
    const [a, b] = await Promise.all([store.load(), store.load()]);
    await store.ready;
    await store.load();
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(store.get().autoIndex).toBe(false);
  });

  it("update() lancé AVANT la fin du chargement n'écrase pas le fichier existant (autoIndex et fréquence conservés)", async () => {
    const gate = deferred<unknown>();
    const save = vi.fn(async (_v: unknown) => undefined);
    const store = createSettings({ load: () => gate.promise, save, onWarn: vi.fn() });
    const pending = store.update({ sort: { key: "modified", direction: "desc" } });
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled(); // rien n'est écrit tant que le fichier n'est pas lu
    gate.resolve(STORED);
    await pending;
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...STORED, history: [], sort: { key: "modified", direction: "desc" } });
    expect(store.get()).toMatchObject({ autoIndex: false, intervalMinutes: 60, groupByDocument: false });
  });

  it("deux update() avant la fin du chargement : fusionnés dans l'ordre d'appel sur le fichier lu", async () => {
    const gate = deferred<unknown>();
    const save = vi.fn(async (_v: unknown) => undefined);
    const store = createSettings({ load: () => gate.promise, save, onWarn: vi.fn() });
    const p1 = store.update({ groupByDocument: true });
    const p2 = store.update({ sort: { key: "path", direction: "asc" } });
    gate.resolve(STORED);
    await Promise.all([p1, p2]);
    expect(save).toHaveBeenLastCalledWith({ ...STORED, history: [], groupByDocument: true, sort: { key: "path", direction: "asc" } });
    expect(store.get()).toMatchObject({ autoIndex: false, intervalMinutes: 60 });
  });

  it("update() sans appel préalable à load() ne se bloque pas : il déclenche le chargement", async () => {
    const save = vi.fn(async (_v: unknown) => undefined);
    const store = createSettings({ load: async () => STORED, save, onWarn: vi.fn() });
    await store.update({ groupByDocument: true });
    expect(save).toHaveBeenCalledWith({ ...STORED, history: [], groupByDocument: true });
  });

  it("une fois chargé, update() applique et notifie toujours de façon synchrone (pas d'attente inutile)", async () => {
    const store = createSettings({ load: async () => STORED, save: vi.fn(async () => undefined), onWarn: vi.fn() });
    await store.ready;
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.get().groupByDocument));
    void store.update({ groupByDocument: true });
    expect(seen).toEqual([true]);
  });

  it("load() pendant un enregistrement en vol : pas de relecture, version intacte (pas d'écriture en trop, rien d'écrasé)", async () => {
    const gate = deferred<void>();
    const saved: unknown[] = [];
    const load = vi.fn(async () => STORED);
    const store = createSettings({
      load,
      save: async (v) => {
        saved.push(v);
        if (saved.length === 1) await gate.promise;
      },
      onWarn: vi.fn(),
    });
    await store.ready;
    const first = store.update({ groupByDocument: true });
    await Promise.resolve();
    await store.load(); // pendant que le premier enregistrement est en vol
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.get().groupByDocument).toBe(true); // la modification de l'utilisateur n'est pas écrasée
    gate.resolve();
    await first;
    await store.update({ groupByDocument: true }); // identique et déjà enregistré : aucune écriture
    expect(saved).toHaveLength(1);
  });

  it("fichier illisible puis update avant la fin du chargement : la réécriture corrigée et la modification se suivent", async () => {
    const gate = deferred<unknown>();
    const saved: unknown[] = [];
    const store = createSettings({ load: () => gate.promise, save: async (v) => void saved.push(v), onWarn: vi.fn() });
    const pending = store.update({ intervalMinutes: 15 });
    gate.resolve({ autoIndex: false, intervalMinutes: 7 }); // intervalle invalide : réécriture
    await pending;
    expect(saved.at(-1)).toMatchObject({ autoIndex: false, intervalMinutes: 15 });
  });
});

describe("historique des requêtes (history)", () => {
  it("défaut : liste vide", () => {
    expect(DEFAULT_SETTINGS.history).toEqual([]);
  });
  it("ancien fichier sans le champ : [] SANS avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ autoIndex: true, intervalMinutes: 5 }, warn).history).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
  it("liste valide conservée dans l'ordre", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ history: ["b", "a"] }, warn).history).toEqual(["b", "a"]);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([["texte", "chat"], ["nombre", 3], ["nul", null], ["objet", {}]])("type invalide (%s) : [] ET avertissement", (_n, history) => {
    const warn = vi.fn();
    expect(normalizeSettings({ history }, warn).history).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/historique/i);
  });
  it("entrées invalides ou en double retirées, avec avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ history: ["a", 1, "", "a", " b "] }, warn).history).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("plus de 20 entrées : tronqué à 20, avertissement", () => {
    const warn = vi.fn();
    const raw = Array.from({ length: 25 }, (_, i) => `q${i}`);
    expect(normalizeSettings({ history: raw }, warn).history).toEqual(raw.slice(0, 20));
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("lecture d'un ancien fichier : ready se résout, rien n'est réécrit, aucun avertissement", async () => {
    const save = vi.fn(async () => undefined);
    const onWarn = vi.fn();
    const store = createSettings({ load: async () => ({ autoIndex: false, intervalMinutes: 15 }), save, onWarn });
    await store.ready;
    expect(store.get().history).toEqual([]);
    expect(onWarn).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("update({ history }) : applique, notifie, enregistre", async () => {
    const save = vi.fn(async () => undefined);
    const store = createSettings({ load: async () => undefined, save, onWarn: vi.fn() });
    await store.ready;
    const seen: string[][] = [];
    store.subscribe(() => seen.push([...store.get().history]));
    await store.update({ history: ["x", "y"] });
    expect(store.get().history).toEqual(["x", "y"]);
    expect(seen).toEqual([["x", "y"]]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ history: ["x", "y"] }));
  });
  it("update({ history }) identique : aucune écriture", async () => {
    const save = vi.fn(async () => undefined);
    const store = createSettings({ load: async () => ({ history: ["x"] }), save, onWarn: vi.fn() });
    await store.ready;
    await store.update({ history: ["x"] });
    expect(save).not.toHaveBeenCalled();
  });
  it("échec d'écriture : update rejette, la valeur reste en mémoire", async () => {
    const store = createSettings({ load: async () => undefined, save: async () => { throw new Error("disque"); }, onWarn: vi.fn() });
    await store.ready;
    await expect(store.update({ history: ["x"] })).rejects.toThrow("disque");
    expect(store.get().history).toEqual(["x"]);
  });
});
