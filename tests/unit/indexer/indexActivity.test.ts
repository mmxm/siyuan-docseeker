import { describe, expect, it, vi } from "vitest";
import { createIndexActivity } from "../../../src/indexer/indexActivity";
import type { IndexerEvent } from "../../../src/indexer/indexer";

function setup() {
  const listeners = new Set<(e: IndexerEvent) => void>();
  let progress: { done: number; total: number } | null = null;
  const activity = createIndexActivity({
    indexer: {
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    getProgress: () => progress,
  });
  const emit = (e: IndexerEvent) => [...listeners].forEach((l) => l(e));
  const idle = (
    over: Partial<{ indexed: number; skippedScanned: number; failed: number; removed: number; migrated: number; incomplete: number; failures: string[] }> = {},
  ) =>
    emit({
      type: "idle",
      summary: { indexed: 0, skippedScanned: 0, failed: 0, removed: 0, migrated: 0, cancelled: false, incomplete: 0, ...over },
    });
  return { activity, emit, idle, listeners, setProgress: (p: typeof progress) => (progress = p) };
}

describe("indexActivity", () => {
  it("état initial : au repos, rien à afficher", () => {
    expect(setup().activity.getSnapshot()).toEqual({ phase: "idle", done: 0, total: 0, failed: 0, incomplete: 0, discovery: false });
  });

  it("une passe sans changement (started puis idle à zéro) ne produit aucun état ni notification", () => {
    const s = setup();
    const l = vi.fn();
    s.activity.subscribe(l);
    s.emit({ type: "started" });
    s.idle();
    expect(l).not.toHaveBeenCalled();
    expect(s.activity.getSnapshot().phase).toBe("idle");
  });

  it("passe avec travail : en cours N/M, puis à jour", () => {
    const s = setup();
    const l = vi.fn();
    s.activity.subscribe(l);
    s.emit({ type: "started" });
    s.setProgress({ done: 0, total: 3 });
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 10 });
    expect(s.activity.getSnapshot()).toEqual({ phase: "running", done: 0, total: 3, failed: 0, incomplete: 0, discovery: false });
    const calls = l.mock.calls.length;
    s.emit({ type: "progress", path: "a.pdf", page: 2, total: 10 });
    expect(l.mock.calls.length).toBe(calls); // pas de notification par page
    s.setProgress({ done: 1, total: 3 });
    s.emit({ type: "indexed", path: "a.pdf", pages: 10 });
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "running", done: 1, total: 3 });
    s.idle({ indexed: 3 });
    expect(s.activity.getSnapshot().phase).toBe("done");
  });

  it("une suppression seule fait passer par « en cours » puis « à jour »", () => {
    const s = setup();
    s.emit({ type: "started" });
    s.emit({ type: "removed", path: "a.pdf" });
    expect(s.activity.getSnapshot().phase).toBe("running");
    s.idle({ removed: 1 });
    expect(s.activity.getSnapshot().phase).toBe("done");
  });

  it("des échecs seuls : état « failed » avec le nombre, sans passer par « en cours »", () => {
    const s = setup();
    const phases: string[] = [];
    s.activity.subscribe(() => phases.push(s.activity.getSnapshot().phase));
    s.emit({ type: "started" });
    s.emit({ type: "failed", path: "a.pdf", message: "vide" });
    s.idle({ failed: 1 });
    expect(phases).toEqual(["failed"]);
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "failed", failed: 1 });
  });

  it("travail avec échecs : termine en « failed »", () => {
    const s = setup();
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 1 });
    s.idle({ indexed: 1, failed: 2 });
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "failed", failed: 2 });
  });

  it("une passe suivante sans échec ni travail efface l'état d'échec", () => {
    const s = setup();
    s.idle({ failed: 1 });
    expect(s.activity.getSnapshot().phase).toBe("failed");
    s.idle();
    expect(s.activity.getSnapshot().phase).toBe("idle");
  });

  it("une passe d'échec identique à la précédente ne notifie pas", () => {
    const s = setup();
    s.idle({ failed: 1 });
    const l = vi.fn();
    s.activity.subscribe(l);
    s.idle({ failed: 1 });
    expect(l).not.toHaveBeenCalled();
  });

  it("passe annulée sans travail : retombe au repos", () => {
    const s = setup();
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 2 });
    s.emit({ type: "idle", summary: { indexed: 0, skippedScanned: 0, failed: 0, removed: 0, migrated: 0, cancelled: true, incomplete: 0 } });
    expect(s.activity.getSnapshot().phase).toBe("idle");
  });

  it("un getProgress absent ou qui lève ne casse rien (total 0)", () => {
    const listeners = new Set<(e: IndexerEvent) => void>();
    const a = createIndexActivity({
      indexer: { onEvent: (l) => (listeners.add(l), () => listeners.delete(l)) },
      getProgress: () => { throw new Error("KO"); },
    });
    expect(() => [...listeners].forEach((l) => l({ type: "progress", path: "a", page: 1, total: 1 }))).not.toThrow();
    expect(a.getSnapshot()).toMatchObject({ phase: "running", total: 0 });
  });

  it("dispose se désabonne de l'indexeur et des abonnés ; subscribe renvoie un désabonnement", () => {
    const s = setup();
    const l = vi.fn();
    const off = s.activity.subscribe(l);
    off();
    s.idle({ failed: 1 });
    expect(l).not.toHaveBeenCalled();
    s.activity.dispose();
    s.activity.dispose();
    expect(s.listeners.size).toBe(0);
  });

  it("un abonné qui lève n'empêche pas les autres", () => {
    const s = setup();
    s.activity.subscribe(() => { throw new Error("boom"); });
    const good = vi.fn();
    s.activity.subscribe(good);
    s.idle({ failed: 1 });
    expect(good).toHaveBeenCalled();
  });
});

describe("indexActivity : parcours incomplet", () => {
  it("passe sans changement mais incomplète : état « partial » avec le nombre, pas « idle »", () => {
    const s = setup();
    s.idle({ incomplete: 2 });
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "partial", incomplete: 2, failed: 0 });
  });

  it("passe avec travail et incomplète : « partial », jamais « done »", () => {
    const s = setup();
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 1 });
    s.idle({ indexed: 1, incomplete: 1 });
    expect(s.activity.getSnapshot().phase).toBe("partial");
  });

  it("les échecs l'emportent sur l'incomplétude", () => {
    const s = setup();
    s.idle({ failed: 1, incomplete: 3 });
    expect(s.activity.getSnapshot().phase).toBe("failed");
  });

  it("une passe complète suivante efface l'état partiel", () => {
    const s = setup();
    s.idle({ incomplete: 1 });
    s.idle();
    expect(s.activity.getSnapshot().phase).toBe("idle");
  });
});

describe("indexActivity : échecs persistants et découverte", () => {
  it("un PDF déjà en échec à la passe précédente qui émet des progress ne fait pas repasser en « running »", () => {
    const s = setup();
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 9 });
    s.emit({ type: "failed", path: "a.pdf", message: "page 2 illisible" });
    s.idle({ failed: 1, failures: ["a.pdf : page 2 illisible"] });
    expect(s.activity.getSnapshot().phase).toBe("failed");
    const phases: string[] = [];
    s.activity.subscribe(() => phases.push(s.activity.getSnapshot().phase));
    s.emit({ type: "started" });
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 9 });
    s.emit({ type: "failed", path: "a.pdf", message: "page 2 illisible" });
    s.idle({ failed: 1, failures: ["a.pdf : page 2 illisible"] });
    expect(phases).toEqual([]);
    expect(s.activity.getSnapshot().phase).toBe("failed");
  });

  it("du travail nouveau pendant un échec persistant repasse en « running »", () => {
    const s = setup();
    s.idle({ failed: 1, failures: ["a.pdf : KO"] });
    s.emit({ type: "progress", path: "b.pdf", page: 1, total: 2 });
    expect(s.activity.getSnapshot().phase).toBe("running");
    s.idle({ indexed: 1, failed: 1, failures: ["a.pdf : KO"] });
    expect(s.activity.getSnapshot().phase).toBe("failed");
  });

  it("un PDF sauté par le retrait progressif (sans événement) reste persistant à la passe suivante", () => {
    const s = setup();
    s.idle({ failed: 1, failures: ["a.pdf : KO"] });
    s.idle({ failed: 1, failures: ["a.pdf : KO"] }); // sauté : aucun événement
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 2 }); // nouvel essai après le délai
    expect(s.activity.getSnapshot().phase).toBe("failed");
  });

  it("un échec de découverte ou de manifeste est signalé comme tel", () => {
    const s = setup();
    s.emit({ type: "failed", path: "(discovery)", message: "racine illisible" });
    s.idle({ failed: 1, failures: ["(discovery) : racine illisible"] });
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "failed", discovery: true });
    s.emit({ type: "failed", path: "a.pdf", message: "x" });
    s.idle({ failed: 1, failures: ["a.pdf : x"] });
    expect(s.activity.getSnapshot()).toMatchObject({ phase: "failed", discovery: false });
    s.emit({ type: "failed", path: "manifest.json", message: "illisible" });
    s.idle({ failed: 1, failures: ["manifest.json : illisible"] });
    expect(s.activity.getSnapshot().discovery).toBe(true);
  });
});

describe("indexActivity : migration de l'index", () => {
  it("une passe qui ne fait que migrer est marquée migrating pendant son exécution", () => {
    const s = setup();
    s.emit({ type: "started" });
    s.emit({ type: "plan", toIndex: 2, migrating: 2, complete: true });
    s.setProgress({ done: 0, total: 2 });
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 3 });
    expect(s.activity.getSnapshot()).toEqual({
      phase: "running", done: 0, total: 2, failed: 0, incomplete: 0, discovery: false, migrating: true,
    });
    s.idle({ indexed: 2, migrated: 2 });
    expect(s.activity.getSnapshot()).toEqual({ phase: "done", done: 0, total: 0, failed: 0, incomplete: 0, discovery: false });
  });

  it("une passe mixte (PDF nouveaux en plus) n'est pas marquée migrating : de vrais résultats manquent", () => {
    const s = setup();
    s.emit({ type: "started" });
    s.emit({ type: "plan", toIndex: 3, migrating: 2, complete: true });
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 3 });
    expect(s.activity.getSnapshot().migrating).toBeUndefined();
  });

  it("un parcours incomplet n'est jamais marqué migrating : des résultats peuvent manquer", () => {
    const s = setup();
    s.emit({ type: "started" });
    s.emit({ type: "plan", toIndex: 2, migrating: 2, complete: false });
    s.emit({ type: "progress", path: "a.pdf", page: 1, total: 3 });
    expect(s.activity.getSnapshot().phase).toBe("running");
    expect(s.activity.getSnapshot().migrating).toBeUndefined();
  });

  it("le marquage ne survit pas à la passe suivante", () => {
    const s = setup();
    s.emit({ type: "started" });
    s.emit({ type: "plan", toIndex: 1, migrating: 1, complete: true });
    s.idle({ indexed: 1, migrated: 1 });
    s.emit({ type: "started" });
    s.emit({ type: "progress", path: "b.pdf", page: 1, total: 3 });
    expect(s.activity.getSnapshot().phase).toBe("running");
    expect(s.activity.getSnapshot().migrating).toBeUndefined();
  });

  it("un événement plan seul ne produit ni état ni notification", () => {
    const s = setup();
    const l = vi.fn();
    s.activity.subscribe(l);
    s.emit({ type: "started" });
    s.emit({ type: "plan", toIndex: 1, migrating: 1, complete: true });
    expect(l).not.toHaveBeenCalled();
  });
});
