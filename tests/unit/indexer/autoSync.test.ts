import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoSync, type AutoSyncDeps, type AutoSyncResult } from "../../../src/indexer/autoSync";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Timer { id: number; at: number; fn: () => void }

function harness(over: Partial<AutoSyncDeps> = {}) {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  const focusListeners = new Set<() => void>();
  const sync = vi.fn(async (): Promise<AutoSyncResult | void> => undefined);
  const warn = vi.fn();
  const deps: AutoSyncDeps = {
    sync,
    onWarn: warn,
    now: () => time,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { id, at: time + ms, fn });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    onFocus: (l) => {
      focusListeners.add(l);
      return () => focusListeners.delete(l);
    },
    ...over,
  };
  const advance = async (ms: number): Promise<void> => {
    const target = time + ms;
    for (;;) {
      const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due.id);
      time = Math.max(time, due.at);
      due.fn();
      await flush();
    }
    time = target;
    await flush();
  };
  const focus = async (): Promise<void> => {
    for (const l of [...focusListeners]) l();
    await flush();
  };
  return { deps, sync, warn, advance, focus, timers, focusListeners, setTime: (t: number) => (time = t) };
}

const ON = { enabled: true, intervalMinutes: 5 };
const MIN = 60_000;
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => vi.restoreAllMocks());

describe("autoSync : première synchronisation", () => {
  it("n'agit pas avant le délai de 3 s, puis synchronise une fois", async () => {
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(2999);
    expect(h.sync).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("prepare() est appelé une fois avant la première synchronisation, même si la synchronisation est désactivée", async () => {
    const order: string[] = [];
    const hh = harness({ prepare: async () => void order.push("prepare") });
    hh.sync.mockImplementation(async () => void order.push("sync"));
    createAutoSync(hh.deps).start(ON);
    await hh.advance(3000);
    await hh.advance(5 * MIN);
    expect(order).toEqual(["prepare", "sync", "sync"]);

    const off = harness({ prepare: vi.fn(async () => undefined) });
    createAutoSync(off.deps).start({ enabled: false, intervalMinutes: 5 });
    await off.advance(10 * MIN);
    expect(off.deps.prepare).toHaveBeenCalledTimes(1);
    expect(off.sync).not.toHaveBeenCalled();
  });

  it("un prepare() qui échoue est journalisé et ne bloque pas la synchronisation", async () => {
    const hh = harness({ prepare: async () => { throw new Error("tmp KO"); } });
    createAutoSync(hh.deps).start(ON);
    await hh.advance(3000);
    expect(hh.warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });

  it("un prepare() qui lève de façon synchrone est traité de même", async () => {
    const hh = harness({ prepare: () => { throw new Error("sync KO"); } });
    createAutoSync(hh.deps).start(ON);
    await hh.advance(3000);
    expect(hh.warn).toHaveBeenCalled();
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });

  it("le retour du focus avant la première synchronisation est ignoré", async () => {
    createAutoSync(h.deps).start(ON);
    await h.advance(1000);
    await h.focus();
    expect(h.sync).not.toHaveBeenCalled();
  });
});

describe("autoSync : périodique", () => {
  it("resynchronise à l'intervalle réglé, compté depuis la fin de la précédente", async () => {
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    await h.advance(MIN - 1);
    expect(h.sync).toHaveBeenCalledTimes(1);
    await h.advance(1);
    expect(h.sync).toHaveBeenCalledTimes(2);
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(3);
  });

  it("n'enchaîne jamais deux synchronisations simultanées", async () => {
    let release: () => void = () => undefined;
    h.sync.mockImplementation(() => new Promise<void>((r) => (release = r)));
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    await h.advance(10 * MIN);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("une exception ou un rejet n'arrête pas la boucle et est journalisé", async () => {
    h.sync.mockRejectedValueOnce(new Error("noyau KO"));
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    expect(h.warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("un sync() qui lève de façon synchrone est traité de même", async () => {
    h.sync.mockImplementationOnce(() => { throw new Error("sync"); });
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    expect(h.warn).toHaveBeenCalled();
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("la même erreur répétée n'est journalisée qu'une fois jusqu'à une passe réussie", async () => {
    h.sync.mockRejectedValue(new Error("noyau KO"));
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    await h.advance(MIN);
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(3);
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.sync.mockResolvedValueOnce(undefined);
    await h.advance(MIN);
    h.sync.mockRejectedValue(new Error("noyau KO"));
    await h.advance(MIN);
    expect(h.warn).toHaveBeenCalledTimes(2);
  });
});

describe("autoSync : échecs d'indexation", () => {
  it("journalise le nombre d'échecs et leurs détails, une fois tant que le résultat ne change pas", async () => {
    h.sync.mockResolvedValue({ failed: 2, failures: ["a.pdf : vide", "b.pdf : corrompu"] });
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    const first = h.warn.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    const text = h.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("2");
    expect(text).toContain("a.pdf : vide");
    await h.advance(MIN);
    await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBe(first);
    h.sync.mockResolvedValue({ failed: 1, failures: ["b.pdf : corrompu"] });
    await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBeGreaterThan(first);
  });

  it("aucun échec : aucune trace", async () => {
    h.sync.mockResolvedValue({ failed: 0, failures: [] });
    createAutoSync(h.deps).start(ON);
    await h.advance(3000);
    expect(h.warn).not.toHaveBeenCalled();
  });
});

describe("autoSync : retour du focus", () => {
  it("synchronise au retour du focus, avec un intervalle minimal de 30 s depuis la fin de la précédente", async () => {
    createAutoSync(h.deps).start(ON);
    await h.advance(3000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    await h.advance(10_000);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(1);
    await h.advance(20_000);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(2);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("une synchronisation sur focus reporte la suivante périodique", async () => {
    createAutoSync(h.deps).start(ON);
    await h.advance(3000);
    await h.advance(4 * MIN);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(2);
    await h.advance(4 * MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(3);
  });
});

describe("autoSync : occupation (vidage, saisie)", () => {
  it("si occupé, ne lance rien et retente après 10 s, sans attendre tout l'intervalle", async () => {
    let busy = true;
    const hh = harness({ isBusy: () => busy });
    createAutoSync(hh.deps).start({ enabled: true, intervalMinutes: 60 });
    await hh.advance(3000);
    expect(hh.sync).not.toHaveBeenCalled();
    await hh.advance(10_000);
    expect(hh.sync).not.toHaveBeenCalled();
    busy = false;
    await hh.advance(10_000);
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });

  it("le focus est ignoré quand occupé", async () => {
    const hh = harness({ isBusy: () => true });
    createAutoSync(hh.deps).start(ON);
    await hh.advance(3000);
    await hh.focus();
    expect(hh.sync).not.toHaveBeenCalled();
  });

  it("un isBusy qui lève est journalisé une seule fois et compte comme « pas occupé »", async () => {
    const hh = harness({ isBusy: () => { throw new Error("busy KO"); } });
    createAutoSync(hh.deps).start({ enabled: true, intervalMinutes: 1 });
    await hh.advance(3000);
    await hh.advance(MIN);
    await hh.advance(MIN);
    expect(hh.sync).toHaveBeenCalledTimes(3);
    expect(hh.warn).toHaveBeenCalledTimes(1);
  });
});

describe("autoSync : réglages", () => {
  it("désactivé : rien (ni première synchronisation, ni focus, ni périodique)", async () => {
    createAutoSync(h.deps).start({ enabled: false, intervalMinutes: 1 });
    await h.advance(10 * MIN);
    await h.focus();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("couper l'interrupteur annule le minuteur ; la synchronisation en cours n'est pas interrompue", async () => {
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(3000);
    a.configure({ enabled: false, intervalMinutes: 5 });
    expect(h.timers.size).toBe(0);
    await h.advance(30 * MIN);
    await h.focus();
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("activer l'interrupteur déclenche une synchronisation immédiate (après le démarrage)", async () => {
    const a = createAutoSync(h.deps);
    a.start({ enabled: false, intervalMinutes: 5 });
    await h.advance(3000);
    a.configure(ON);
    await flush();
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("activer avant la fin du délai initial ne synchronise pas deux fois", async () => {
    const a = createAutoSync(h.deps);
    a.start({ enabled: false, intervalMinutes: 5 });
    await h.advance(1000);
    a.configure(ON);
    await flush();
    expect(h.sync).not.toHaveBeenCalled();
    await h.advance(2000);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("changer l'intervalle reprogramme le minuteur sans synchroniser", async () => {
    const a = createAutoSync(h.deps);
    a.start({ enabled: true, intervalMinutes: 60 });
    await h.advance(3000);
    a.configure({ enabled: true, intervalMinutes: 1 });
    expect(h.sync).toHaveBeenCalledTimes(1);
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });
});

describe("autoSync : triggerNow", () => {
  it("lance une synchronisation tout de suite, sans respecter l'intervalle minimal", async () => {
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(3000);
    a.triggerNow();
    await flush();
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it("ne fait rien si désactivé, si une synchronisation est en cours, ou après dispose", async () => {
    const off = createAutoSync(h.deps);
    off.start({ enabled: false, intervalMinutes: 5 });
    await h.advance(3000);
    off.triggerNow();
    expect(h.sync).not.toHaveBeenCalled();

    const hh = harness();
    let release: () => void = () => undefined;
    hh.sync.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const a = createAutoSync(hh.deps);
    a.start(ON);
    await hh.advance(3000);
    a.triggerNow();
    expect(hh.sync).toHaveBeenCalledTimes(1);
    release();
    await flush();
    a.dispose();
    a.triggerNow();
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });
});

describe("autoSync : dispose", () => {
  it("annule minuteurs et écouteurs, idempotent, et n'agit plus", async () => {
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(3000);
    a.dispose();
    a.dispose();
    expect(h.timers.size).toBe(0);
    expect(h.focusListeners.size).toBe(0);
    await h.advance(60 * MIN);
    await h.focus();
    a.configure(ON);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("dispose avant le délai initial : rien ne se passe, prepare non appelé", async () => {
    const prepare = vi.fn(async () => undefined);
    const hh = harness({ prepare });
    const a = createAutoSync(hh.deps);
    a.start(ON);
    a.dispose();
    await hh.advance(MIN);
    expect(hh.sync).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("dispose pendant prepare : pas de synchronisation", async () => {
    let release: () => void = () => undefined;
    const hh = harness({ prepare: () => new Promise<void>((r) => (release = r)) });
    const a = createAutoSync(hh.deps);
    a.start(ON);
    await hh.advance(3000);
    a.dispose();
    release();
    await flush();
    expect(hh.sync).not.toHaveBeenCalled();
  });

  it("dispose pendant une synchronisation : pas de nouveau minuteur ensuite", async () => {
    let release: () => void = () => undefined;
    h.sync.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(3000);
    a.dispose();
    release();
    await flush();
    expect(h.timers.size).toBe(0);
  });

  it("start() deux fois ne double ni minuteur ni écouteur", async () => {
    const a = createAutoSync(h.deps);
    a.start(ON);
    a.start(ON);
    expect(h.focusListeners.size).toBe(1);
    await h.advance(3000);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });
});

describe("autoSync : résilience", () => {
  it("un onWarn qui lève n'arrête pas la boucle (le minuteur périodique est toujours réarmé)", async () => {
    const hh = harness({ onWarn: () => { throw new Error("journal KO"); } });
    hh.sync.mockRejectedValue(new Error("noyau KO"));
    createAutoSync(hh.deps).start({ enabled: true, intervalMinutes: 1 });
    await hh.advance(3000);
    await hh.advance(60_000);
    expect(hh.sync).toHaveBeenCalledTimes(2);
  });

  it("un now() qui lève n'arrête pas la boucle", async () => {
    let broken = false;
    const hh = harness({ now: () => { if (broken) throw new Error("horloge KO"); return 0; } });
    createAutoSync(hh.deps).start({ enabled: true, intervalMinutes: 1 });
    broken = true;
    await hh.advance(3000);
    await hh.advance(60_000);
    expect(hh.sync).toHaveBeenCalledTimes(2);
  });

  it("onFocus qui lève : start() ne lève pas, rien n'est armé, et un nouvel appel de start() est possible", async () => {
    let fail = true;
    const base = harness();
    const hh = harness({
      onFocus: (l) => {
        if (fail) throw new Error("focus KO");
        return base.deps.onFocus(l);
      },
    });
    const a = createAutoSync(hh.deps);
    expect(() => a.start(ON)).not.toThrow();
    expect(hh.warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect(hh.timers.size).toBe(0);
    fail = false;
    a.start(ON);
    await hh.advance(3000);
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });

  it("setTimer qui lève au démarrage : journalisé, start() reste rejouable, écouteur de focus retiré", async () => {
    let fail = true;
    const base = harness();
    const hh = harness({
      setTimer: (fn, ms) => {
        if (fail) throw new Error("timer KO");
        return base.deps.setTimer(fn, ms);
      },
      onFocus: base.deps.onFocus,
    });
    const a = createAutoSync(hh.deps);
    expect(() => a.start(ON)).not.toThrow();
    expect(base.focusListeners.size).toBe(0);
    expect(hh.warn).toHaveBeenCalled();
    fail = false;
    a.start(ON);
    expect(base.focusListeners.size).toBe(1);
  });
});

describe("autoSync : journal dédupliqué", () => {
  it("une passe annulée ne remet pas la signature à zéro", async () => {
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    h.sync.mockResolvedValue({ failed: 1, failures: ["a.pdf : vide"] });
    await h.advance(3000);
    const n = h.warn.mock.calls.length;
    h.sync.mockResolvedValue({ failed: 0, cancelled: true });
    await h.advance(MIN);
    h.sync.mockResolvedValue({ failed: 1, failures: ["a.pdf : vide"] });
    await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBe(n);
  });

  it("un échec persistant est rejournalisé toutes les 12 passes", async () => {
    h.sync.mockResolvedValue({ failed: 1, failures: ["a.pdf : vide"] });
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    const first = h.warn.mock.calls.length;
    for (let i = 0; i < 11; i++) await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBe(first);
    await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBe(first * 2);
  });

  it("journalise un parcours incomplet avec ses chemins, une seule fois", async () => {
    h.sync.mockResolvedValue({ failed: 0, incomplete: 2, incompleteDetails: ["assets/prive : illisible", "x.pdf : taille inconnue"] });
    createAutoSync(h.deps).start({ enabled: true, intervalMinutes: 1 });
    await h.advance(3000);
    const text = h.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Indexation automatique incomplète : 2 éléments non parcourus (détails dans le journal)");
    expect(text).toContain("assets/prive : illisible");
    const n = h.warn.mock.calls.length;
    await h.advance(MIN);
    expect(h.warn.mock.calls.length).toBe(n);
  });

  it("un seul élément : singulier", async () => {
    h.sync.mockResolvedValue({ failed: 0, incomplete: 1, incompleteDetails: ["a : b"] });
    createAutoSync(h.deps).start(ON);
    await h.advance(3000);
    expect(String(h.warn.mock.calls[0]![0])).toContain("1 élément non parcouru ");
  });
});

describe("autoSync : triggerNow renvoie un booléen", () => {
  it("false avant booted si désactivé, true si le premier tour va bien synchroniser", async () => {
    const off = createAutoSync(h.deps);
    off.start({ enabled: false, intervalMinutes: 5 });
    expect(off.triggerNow()).toBe(false);
    const hh = harness();
    const on = createAutoSync(hh.deps);
    expect(on.triggerNow()).toBe(false); // pas démarré
    on.start(ON);
    expect(on.triggerNow()).toBe(true); // la première synchronisation est planifiée
    await hh.advance(3000);
    expect(hh.sync).toHaveBeenCalledTimes(1);
  });

  it("true quand une passe démarre, false pendant une passe et après dispose", async () => {
    let release: () => void = () => undefined;
    h.sync.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const a = createAutoSync(h.deps);
    a.start(ON);
    await h.advance(3000);
    expect(a.triggerNow()).toBe(false);
    release();
    await flush();
    expect(a.triggerNow()).toBe(true);
    a.dispose();
    expect(a.triggerNow()).toBe(false);
  });
});

describe("autoSync : configure pendant une passe", () => {
  it("le nouvel intervalle s'applique à la fin de la passe en cours", async () => {
    let release: () => void = () => undefined;
    h.sync.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const a = createAutoSync(h.deps);
    a.start({ enabled: true, intervalMinutes: 60 });
    await h.advance(3000);
    a.configure({ enabled: true, intervalMinutes: 1 });
    expect(h.timers.size).toBe(0);
    release();
    await flush();
    await h.advance(MIN);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });
});
