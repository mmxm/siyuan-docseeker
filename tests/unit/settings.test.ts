import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, FREQUENCY_MINUTES, SETTINGS_FILE, createSettings, normalizeSettings } from "../../src/settings";

describe("normalizeSettings", () => {
  it("défauts : indexation automatique activée, 5 minutes", () => {
    expect(DEFAULT_SETTINGS).toEqual({ autoIndex: true, intervalMinutes: 5 });
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
    expect(normalizeSettings({ autoIndex: false, intervalMinutes: 60 }, warn)).toEqual({ autoIndex: false, intervalMinutes: 60 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("champ absent : défaut, sans avertissement", () => {
    const warn = vi.fn();
    expect(normalizeSettings({ intervalMinutes: 15 }, warn)).toEqual({ autoIndex: true, intervalMinutes: 15 });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["intervalle inconnu", { autoIndex: true, intervalMinutes: 7 }, { autoIndex: true, intervalMinutes: 5 }],
    ["intervalle texte", { autoIndex: true, intervalMinutes: "15" }, { autoIndex: true, intervalMinutes: 5 }],
    ["intervalle NaN", { intervalMinutes: Number.NaN }, { autoIndex: true, intervalMinutes: 5 }],
    ["interrupteur texte", { autoIndex: "false", intervalMinutes: 15 }, { autoIndex: true, intervalMinutes: 15 }],
    ["interrupteur nul", { autoIndex: null, intervalMinutes: 15 }, { autoIndex: true, intervalMinutes: 15 }],
    ["ancien intervalle d'une minute (retiré)", { autoIndex: true, intervalMinutes: 1 }, { autoIndex: true, intervalMinutes: 5 }],
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
    expect(store.get()).toEqual({ autoIndex: false, intervalMinutes: 15 });
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
    const listener = vi.fn();
    store.subscribe(listener);
    const done = store.update({ intervalMinutes: 15 });
    expect(store.get().intervalMinutes).toBe(15);
    expect(listener).toHaveBeenCalledTimes(1);
    await done;
    expect(save).toHaveBeenCalledWith({ autoIndex: true, intervalMinutes: 15 });
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
    const listener = vi.fn();
    store.subscribe(listener);
    await store.update({ autoIndex: true });
    expect(save).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe renvoie un désabonnement ; un écouteur qui lève est journalisé sans bloquer les autres", async () => {
    const { store, warn } = make(undefined);
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
      { autoIndex: true, intervalMinutes: 15 },
      { autoIndex: false, intervalMinutes: 60 },
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
    expect(save).toHaveBeenLastCalledWith({ autoIndex: true, intervalMinutes: 60 });
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
    expect(save).toHaveBeenCalledWith({ autoIndex: false, intervalMinutes: 5 });
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
