import { describe, expect, it } from "vitest";
import { decodeIndex } from "../../../src/core/codec/decode";
import { encodeIndex } from "../../../src/core/codec/encode";
import { CURRENT_INDEX_VERSION, fingerprint, type PdfEntry } from "../../../src/core/manifest";
import {
  EXTRACTOR_VERSION,
  FAILURE_BACKOFF_MS,
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  createIndexer,
  type IndexerEvent,
  type PdfDocumentLike,
} from "../../../src/indexer/indexer";
import type { DiscoveryResult } from "../../../src/siyuan/discovery";

const enc = new TextEncoder();
const dec = new TextDecoder();
const TEXT = "alpha beta gamma delta epsilon zeta eta theta";

const entry = (path: string, size = 100, modifiedAt = 1000): PdfEntry => ({ path, size, modifiedAt });
const dsxName = (e: PdfEntry): string => `${fingerprint(e)}.dsx`;
const discovery = (entries: PdfEntry[]): DiscoveryResult => ({ manifest: entries, issues: [], complete: true, unsized: [] });

class FakeStore {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  removes: string[] = [];
  failDsxWrite = false;
  failRemove = false;
  failBackupWrite = false;
  async read(name: string): Promise<Uint8Array | null> {
    return this.files.get(name) ?? null;
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    if (this.failDsxWrite && name.endsWith(".dsx")) throw new Error(`write failed ${name}`);
    if (this.failBackupWrite && name.startsWith("manifest.rejected")) throw new Error(`write failed ${name}`);
    this.writes.push(name);
    this.files.set(name, bytes);
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
  async remove(name: string): Promise<boolean> {
    if (this.failRemove) throw new Error(`remove failed ${name}`);
    this.removes.push(name);
    return this.files.delete(name);
  }
  manifest(): { version: number; entries: Record<string, unknown>[] } {
    return JSON.parse(dec.decode(this.files.get(MANIFEST_FILE_NAME)!)) as { version: number; entries: Record<string, unknown>[] };
  }
  versionOf(path: string): unknown {
    return this.manifest().entries.find((e) => e.path === path)?.indexVersion;
  }
  setRawManifest(value: unknown): void {
    this.files.set(MANIFEST_FILE_NAME, enc.encode(typeof value === "string" ? value : JSON.stringify(value)));
  }
}

interface PdfOpts {
  text?: string;
  width?: number;
  gate?: Promise<void>;
}
const fakePdf = (opts: PdfOpts = {}): PdfDocumentLike => ({
  numPages: 2,
  async getPage() {
    await opts.gate;
    return {
      getViewport: () => ({ transform: [1, 0, 0, -1, 0, 100], width: opts.width ?? 100, height: 100 }),
      getTextContent: async () => ({
        items: [{ str: opts.text ?? TEXT, transform: [10, 0, 0, 10, 5, 50], width: 80, height: 10 }],
      }),
    };
  },
  async destroy() {},
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface Harness {
  store: FakeStore;
  indexer: ReturnType<typeof createIndexer>;
  events: IndexerEvent[];
  loaded: string[];
  warnings: string[];
  discovered: { current: PdfEntry[] };
  pdfs: Map<string, PdfDocumentLike | Error>;
  clock: { now: number };
  discover: () => Promise<DiscoveryResult>;
}

function setup(entries: PdfEntry[], store = new FakeStore(), concurrency = 2): Harness {
  const discovered = { current: entries };
  const events: IndexerEvent[] = [];
  const loaded: string[] = [];
  const warnings: string[] = [];
  const pdfs = new Map<string, PdfDocumentLike | Error>();
  const clock = { now: 1_700_000_000_000 };
  const indexer = createIndexer({
    discover: () => harness.discover(),
    store,
    loadPdf: async (path) => {
      loaded.push(path);
      const pdf = pdfs.get(path) ?? fakePdf();
      if (pdf instanceof Error) throw pdf;
      return pdf;
    },
    now: () => clock.now,
    concurrency,
    onWarn: (message) => warnings.push(message),
  });
  indexer.onEvent((e) => events.push(e));
  const harness: Harness = { store, indexer, events, loaded, warnings, discovered, pdfs, clock, discover: async () => discovery(discovered.current) };
  return harness;
}

/** Un index v1 existant pour `e` : un .dsx lisible (octets arbitraires reconnaissables) + manifeste sans indexVersion. */
async function seedLegacy(store: FakeStore, entries: PdfEntry[], extra: Record<string, unknown> = {}): Promise<Map<string, Uint8Array>> {
  const old = new Map<string, Uint8Array>();
  for (const e of entries) {
    const bytes = await encodeIndex({
      normalizerVersion: 1,
      extractorVersion: "docseeker-extract-1",
      sourcePath: e.path,
      pdfSize: e.size,
      pdfModifiedMs: e.modifiedAt,
      pageTermCounts: [1],
      terms: [{ term: "legacy", postings: [{ page: 1, termFrequency: 1, wordOrdinals: [0] }] }],
      pageBoxes: [[{ x: 0, y: 0, width: 0.1, height: 0.1 }]],
      pageSizes: [{ widthPt: 595, heightPt: 842 }],
    });
    store.files.set(dsxName(e), bytes);
    old.set(dsxName(e), bytes);
  }
  store.setRawManifest({ version: MANIFEST_VERSION, entries: entries.map((e) => ({ ...e, ...extra })) });
  return old;
}

describe("constantes de version", () => {
  it("l'extracteur passe à docseeker-extract-2, l'index courant est 2, le manifeste global reste en version 1", () => {
    expect(EXTRACTOR_VERSION).toBe("docseeker-extract-2");
    expect(CURRENT_INDEX_VERSION).toBe(2);
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe("migration v1 -> v2 : PDF inchangé réindexé", () => {
  it("un manifeste sans indexVersion : le PDF inchangé est relu, réécrit, et l'entrée porte la version courante", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    const h = setup([a], store);

    const summary = await h.indexer.start();

    expect(h.loaded).toEqual(["assets/a.pdf"]);
    expect(summary.migrated).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(store.versionOf("assets/a.pdf")).toBe(CURRENT_INDEX_VERSION);
    expect(store.manifest().version).toBe(MANIFEST_VERSION);
    const fresh = store.files.get(dsxName(a))!;
    expect(fresh).not.toEqual(old.get(dsxName(a)));
    const doc = await decodeIndex(fresh);
    expect(doc.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(doc.terms.map((t) => t.term)).toContain("alpha");
    expect(h.warnings).toEqual([]);
  });

  it("idempotence : une 2e passe ne relit ni ne réécrit rien", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    await h.indexer.start();
    h.loaded.length = 0;
    const writesBefore = store.writes.length;
    const second = await h.indexer.start();
    expect(h.loaded).toEqual([]);
    expect(store.writes).toHaveLength(writesBefore);
    expect(second).toMatchObject({ migrated: 0, indexed: 0, failed: 0 });
  });

  it("une nouvelle entrée est écrite avec la version courante et ne compte pas comme migration", async () => {
    const a = entry("assets/a.pdf");
    const h = setup([a]);
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ indexed: 1, migrated: 0 });
    expect(h.store.versionOf("assets/a.pdf")).toBe(CURRENT_INDEX_VERSION);
    const again = await h.indexer.start();
    expect(again.migrated).toBe(0);
    expect(h.loaded).toHaveLength(1);
  });

  it("un PDF modifié compte comme réindexé, pas comme migré", async () => {
    const a = entry("assets/a.pdf", 100, 1);
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const changed = entry("assets/a.pdf", 100, 2);
    const h = setup([changed], store);
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ indexed: 1, migrated: 0 });
    expect(store.versionOf("assets/a.pdf")).toBe(CURRENT_INDEX_VERSION);
  });

  it("une passe automatique migre aussi", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    const summary = await h.indexer.start({ automatic: true });
    expect(summary.migrated).toBe(1);
  });

  it("le PDF sans texte (aucun .dsx) est lui aussi relu une fois, puis noté à la version courante", async () => {
    const scan = entry("assets/scan.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 1, entries: [scan] });
    const h = setup([scan], store);
    h.pdfs.set(scan.path, fakePdf({ text: "x" }));
    const first = await h.indexer.start();
    expect(first).toMatchObject({ skippedScanned: 1, migrated: 1, indexed: 0 });
    expect(store.versionOf(scan.path)).toBe(CURRENT_INDEX_VERSION);
    h.loaded.length = 0;
    expect((await h.indexer.start()).migrated).toBe(0);
    expect(h.loaded).toEqual([]);
  });

  it("l'événement plan annonce le nombre de PDF migrés, seulement s'il y en a", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a, b], store);
    await h.indexer.start();
    expect(h.events.filter((e) => e.type === "plan")).toEqual([{ type: "plan", toIndex: 2, migrating: 1, complete: true }]);
    h.events.length = 0;
    await h.indexer.start();
    expect(h.events.some((e) => e.type === "plan")).toBe(false);
  });
});

describe("migration : l'ancien index reste lisible et interrogeable", () => {
  it("pendant la migration, l'ancien .dsx et l'ancienne entrée sont intacts ; ils changent ensemble à la fin", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    const gate = deferred();
    const h = setup([a], store);
    h.pdfs.set(a.path, fakePdf({ gate: gate.promise }));
    const run = h.indexer.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBeUndefined();
    expect(store.removes).toEqual([]);
    gate.resolve();
    await run;
    expect(store.files.get(dsxName(a))).not.toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBe(CURRENT_INDEX_VERSION);
    // Jamais de suppression du .dsx migré : le nom est identique, il est remplacé par l'écriture atomique du store.
    expect(store.removes).toEqual([]);
  });

  it("le .dsx est écrit AVANT le manifeste", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    await h.indexer.start();
    const names = store.writes;
    expect(names.indexOf(dsxName(a))).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(dsxName(a))).toBeLessThan(names.indexOf(MANIFEST_FILE_NAME));
  });
});

describe("migration : échecs, suppression, annulation, reprise", () => {
  it("PDF illisible : l'ancien .dsx et l'ancienne entrée sont conservés, l'échec est compté", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    const h = setup([a], store);
    h.pdfs.set(a.path, new Error("boom"));
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ failed: 1, migrated: 0, indexed: 0 });
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBeUndefined();
    expect(store.removes).toEqual([]);
  });

  it("échec d'écriture du .dsx : l'ancien est conservé, l'entrée reste ancienne", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    store.failDsxWrite = true;
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ failed: 1, migrated: 0 });
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBeUndefined();
  });

  it("le retrait progressif s'applique : pas de boucle, retentative après 5 min puis réussite", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    h.pdfs.set(a.path, new Error("boom"));
    await h.indexer.start({ automatic: true });
    expect(h.loaded).toHaveLength(1);

    const skipped = await h.indexer.start({ automatic: true });
    expect(h.loaded).toHaveLength(1); // sauté
    expect(skipped.failed).toBe(1);

    h.clock.now += (FAILURE_BACKOFF_MS[0] as number) + 1;
    h.pdfs.delete(a.path); // réparé
    const retry = await h.indexer.start({ automatic: true });
    expect(h.loaded).toHaveLength(2);
    expect(retry).toMatchObject({ migrated: 1, failed: 0 });
    expect(store.versionOf(a.path)).toBe(CURRENT_INDEX_VERSION);
  });

  it("PDF supprimé avant la migration : retiré normalement, jamais migré", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a, b]);
    const h = setup([b], store); // a a disparu
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ removed: 1, migrated: 1, failed: 0 });
    expect(h.loaded).toEqual(["assets/b.pdf"]);
    expect(store.files.has(dsxName(a))).toBe(false);
    expect(store.manifest().entries.map((e) => e.path)).toEqual(["assets/b.pdf"]);
  });

  it("PDF supprimé pendant la migration (chargement impossible) : échec, ancien index conservé, retiré à la passe suivante", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    const h = setup([a], store);
    h.pdfs.set(a.path, new Error("404"));
    const first = await h.indexer.start();
    expect(first.failed).toBe(1);
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    h.discovered.current = [];
    const second = await h.indexer.start();
    expect(second).toMatchObject({ removed: 1, failed: 0 });
    expect(store.files.has(dsxName(a))).toBe(false);
  });

  it("annulation en cours de migration : rien n'est écrit, l'ancien index est intact", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    const gate = deferred();
    const h = setup([a], store);
    h.pdfs.set(a.path, fakePdf({ gate: gate.promise }));
    const writesBefore = store.writes.length;
    const run = h.indexer.start();
    await new Promise((r) => setTimeout(r, 10));
    h.indexer.cancel();
    gate.resolve();
    const summary = await run;
    expect(summary.cancelled).toBe(true);
    expect(summary.migrated).toBe(0);
    expect(store.writes).toHaveLength(writesBefore);
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBeUndefined();
  });

  it("reprise après interruption : seuls les PDF restants sont migrés", async () => {
    const entries = [entry("assets/a.pdf"), entry("assets/b.pdf"), entry("assets/c.pdf")];
    const store = new FakeStore();
    await seedLegacy(store, entries);
    const h = setup(entries, store, 1);
    const stopInterrupting = h.indexer.onEvent((e) => {
      if (e.type === "indexed") h.indexer.cancel(); // interruption après le premier PDF
    });
    const first = await h.indexer.start();
    stopInterrupting();
    expect(first.cancelled).toBe(true);
    expect(first.migrated).toBe(1);
    const versions = entries.map((e) => store.versionOf(e.path));
    expect(versions.filter((v) => v === CURRENT_INDEX_VERSION)).toHaveLength(1);
    // réécrites par le manifeste avec leur version normalisée (absente -> 1)
    expect(versions.filter((v) => v === 1)).toHaveLength(2);
    for (const e of entries) expect(store.files.has(dsxName(e))).toBe(true); // personne n'a disparu

    h.loaded.length = 0;
    const second = await h.indexer.start();
    expect(second.migrated).toBe(2);
    expect(h.loaded).toHaveLength(2);
    for (const e of entries) expect(store.versionOf(e.path)).toBe(CURRENT_INDEX_VERSION);
    h.loaded.length = 0;
    expect((await h.indexer.start()).migrated).toBe(0);
    expect(h.loaded).toEqual([]);
  });
});

describe("manifeste : valeurs inattendues gérées explicitement", () => {
  it.each([
    ["chaîne", "2"],
    ["zéro", 0],
    ["négatif", -1],
    ["fractionnaire", 1.5],
    ["NaN (null en JSON)", null],
    ["booléen", true],
    ["tableau", [2]],
  ])("indexVersion invalide (%s) : traité comme 1, tracé, PDF migré", async (_name, bad) => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a], { indexVersion: bad });
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(summary.migrated).toBe(1);
    expect(h.warnings.some((w) => w.includes("assets/a.pdf") && w.includes("indexVersion"))).toBe(true);
    expect(store.versionOf(a.path)).toBe(CURRENT_INDEX_VERSION);
  });

  it("indexVersion future (3) : entrée conservée telle quelle, pas de réindexation, trace", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 3 }] });
    const h = setup([a, b], store);
    const summary = await h.indexer.start();
    expect(h.loaded).toEqual(["assets/b.pdf"]);
    expect(summary).toMatchObject({ migrated: 0, indexed: 1, failed: 0 });
    expect(store.files.get(dsxName(a))).toBe(old.get(dsxName(a)));
    expect(store.versionOf(a.path)).toBe(3); // pas rétrogradée par la réécriture du manifeste
    expect(h.warnings.some((w) => w.includes("assets/a.pdf") && w.includes("3"))).toBe(true);
  });

  it("manifeste d'une version globale inconnue : tracé, repart de zéro sans rien supprimer", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const old = await seedLegacy(store, [a]);
    store.setRawManifest({ version: 99, entries: [a] });
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(h.warnings.some((w) => w.includes(MANIFEST_FILE_NAME) && w.includes("99"))).toBe(true);
    expect(summary).toMatchObject({ indexed: 1, removed: 0, failed: 0 });
    expect(store.removes).toEqual([]);
    expect(store.files.get(dsxName(a))).not.toBe(old.get(dsxName(a)));
    expect(store.manifest().version).toBe(MANIFEST_VERSION);
  });

  it.each([
    ["JSON invalide", "{not json"],
    ["entrées invalides", { version: 1, entries: [{ path: 1 }] }],
    ["chemins en double", { version: 1, entries: [entry("a.pdf"), entry("a.pdf")] }],
  ])("manifeste corrompu (%s) : tracé", async (_name, raw) => {
    const store = new FakeStore();
    store.setRawManifest(raw);
    const h = setup([entry("a.pdf")], store);
    await h.indexer.start();
    expect(h.warnings.some((w) => w.includes(MANIFEST_FILE_NAME))).toBe(true);
  });

  it("un manifeste valide ne produit aucun avertissement", async () => {
    const a = entry("a.pdf");
    const h = setup([a]);
    await h.indexer.start();
    await h.indexer.start();
    expect(h.warnings).toEqual([]);
  });

  it("un onWarn qui lève ne casse pas la passe", async () => {
    const store = new FakeStore();
    store.setRawManifest("{not json");
    const indexer = createIndexer({
      discover: async () => discovery([entry("a.pdf")]),
      store,
      loadPdf: async () => fakePdf(),
      now: () => 0,
      onWarn: () => {
        throw new Error("boom");
      },
    });
    expect((await indexer.start()).indexed).toBe(1);
  });
});

describe("avertissements d'extraction", () => {
  it("une page aberrante n'échoue pas le PDF : repli A4, avertissement préfixé du chemin", async () => {
    const a = entry("assets/a.pdf");
    const h = setup([a]);
    h.pdfs.set(a.path, fakePdf({ width: 30000 }));
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ indexed: 1, failed: 0 });
    expect(h.warnings.some((w) => w.startsWith("assets/a.pdf : ") && w.includes("page 1"))).toBe(true);
    const doc = await decodeIndex(h.store.files.get(dsxName(a))!);
    expect(doc.pageSizes).toEqual([
      { widthPt: 595, heightPt: 842 },
      { widthPt: 595, heightPt: 842 },
    ]);
  });
});

const BACKUP_FILE = "manifest.rejected.json";
const backupNames = (store: FakeStore): string[] => [...store.files.keys()].filter((n) => n.startsWith("manifest.rejected"));

describe("revue : suppression de l'ancien index en échec (tryRemove)", () => {
  it("un PDF dont la taille change et dont l'ancien .dsx ne peut être supprimé : tracé, l'indexation réussit", async () => {
    const old = entry("assets/a.pdf", 100);
    const store = new FakeStore();
    await seedLegacy(store, [old]);
    store.failRemove = true;
    const h = setup([entry("assets/a.pdf", 200)], store);
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ indexed: 1, failed: 0 });
    expect(h.warnings.some((w) => w.startsWith("assets/a.pdf : suppression de l'ancien index en échec : remove failed"))).toBe(true);
  });

  it("le message de l'erreur est tronqué dans la trace", async () => {
    const store = new FakeStore();
    await seedLegacy(store, [entry("assets/a.pdf", 100)]);
    store.remove = async () => {
      throw new Error("x".repeat(1000));
    };
    const h = setup([entry("assets/a.pdf", 200)], store);
    await h.indexer.start();
    const line = h.warnings.find((w) => w.includes("suppression de l'ancien index"))!;
    expect(line.length).toBeLessThan(400);
  });
});

describe("revue : manifeste rejeté, sauvegarde de l'original", () => {
  it("version globale future : l'original est sauvegardé avant la première écriture, rien n'est supprimé, trace", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 99, entries: [a], extra: "futur" });
    const original = store.files.get(MANIFEST_FILE_NAME)!;
    const order: string[] = [];
    const baseWrite = store.write.bind(store);
    store.write = async (name, bytes) => {
      order.push(name);
      await baseWrite(name, bytes);
    };
    const h = setup([a], store);
    await h.indexer.start();
    expect(store.files.get(BACKUP_FILE)).toEqual(original);
    expect(order.indexOf(BACKUP_FILE)).toBe(0);
    expect(store.removes).toEqual([]);
    expect(h.warnings.some((w) => w.includes(BACKUP_FILE))).toBe(true);
    expect(store.manifest().version).toBe(MANIFEST_VERSION);
  });

  it("passe interrompue : le manifeste d'origine n'est pas perdu (la sauvegarde le contient)", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 99, entries: [a, b] });
    const original = store.files.get(MANIFEST_FILE_NAME)!;
    const gate = deferred();
    const h = setup([a, b], store);
    h.pdfs.set(a.path, fakePdf({ gate: gate.promise }));
    h.pdfs.set(b.path, fakePdf({ gate: gate.promise }));
    const run = h.indexer.start();
    await new Promise((r) => setTimeout(r, 10));
    h.indexer.cancel();
    gate.resolve();
    await run;
    expect(store.files.get(BACKUP_FILE)).toEqual(original);
    expect(store.removes).toEqual([]);
  });

  it("une sauvegarde déjà présente d'un autre contenu n'est jamais écrasée : l'original va dans un second fichier", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    const previousBackup = enc.encode(JSON.stringify({ version: 200, entries: [] }));
    store.files.set(BACKUP_FILE, previousBackup);
    store.setRawManifest("{not json");
    const original = store.files.get(MANIFEST_FILE_NAME)!;
    const h = setup([a], store);
    await h.indexer.start();
    expect(store.files.get(BACKUP_FILE)).toEqual(previousBackup);
    const others = backupNames(store).filter((n) => n !== BACKUP_FILE);
    expect(others).toHaveLength(1);
    expect(store.files.get(others[0] as string)).toEqual(original);
  });

  it("une sauvegarde déjà présente et identique n'est pas dupliquée", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest("{not json");
    store.files.set(BACKUP_FILE, store.files.get(MANIFEST_FILE_NAME)!);
    const h = setup([a], store);
    await h.indexer.start();
    expect(backupNames(store)).toEqual([BACKUP_FILE]);
  });

  it("sauvegarde impossible : la passe échoue et le manifeste d'origine n'est pas réécrit", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 99, entries: [a] });
    const original = store.files.get(MANIFEST_FILE_NAME)!;
    store.failBackupWrite = true;
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(summary.failed).toBe(1);
    expect(summary.failures?.[0]).toContain(MANIFEST_FILE_NAME);
    expect(store.files.get(MANIFEST_FILE_NAME)).toBe(original);
    expect(h.loaded).toEqual([]);
  });

  it("manifeste B rejeté, sauvegarde A différente : 3 passes successives ne créent qu'un seul fichier daté", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.files.set(BACKUP_FILE, enc.encode(JSON.stringify({ version: 200, entries: [] })));
    store.setRawManifest("{not json");
    const h = setup([a], store);
    h.pdfs.set(a.path, new Error("illisible"));
    for (let i = 0; i < 3; i++) {
      h.clock.now += 1000;
      await h.indexer.start();
      store.setRawManifest("{not json");
    }
    expect(backupNames(store).filter((n) => n !== BACKUP_FILE)).toHaveLength(1);
    expect(backupNames(store)).toHaveLength(2);
  });

  it("plafond : au plus 5 sauvegardes, les plus anciennes datées sont supprimées avec trace, manifest.rejected.json est gardé", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.files.set(BACKUP_FILE, enc.encode("sauvegarde-0"));
    for (let i = 1; i <= 5; i++) store.files.set(`manifest.rejected-${1000 + i}.json`, enc.encode(`sauvegarde-${i}`));
    store.setRawManifest("{not json");
    const h = setup([a], store);
    await h.indexer.start();
    const names = backupNames(store);
    expect(names).toHaveLength(5);
    expect(names).toContain(BACKUP_FILE);
    expect(names).not.toContain("manifest.rejected-1001.json");
    expect(names).not.toContain("manifest.rejected-1002.json");
    expect(names).toContain(`manifest.rejected-${h.clock.now}.json`);
    expect(h.warnings.some((w) => w.includes("manifest.rejected-1001.json") && w.includes("supprim"))).toBe(true);
  });

  it("échec de lecture de la sauvegarde : ManifestBackupError, message exact, manifeste non réécrit", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest("{not json");
    const original = store.files.get(MANIFEST_FILE_NAME)!;
    store.list = async () => {
      throw new Error("list KO");
    };
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(summary.failures).toEqual([`${MANIFEST_FILE_NAME} : sauvegarde du manifeste rejeté impossible : list KO`]);
    expect(store.files.get(MANIFEST_FILE_NAME)).toBe(original);
    expect(store.writes).toEqual([]);
  });

  it("échec d'écriture de la sauvegarde : message exact, aucune écriture du manifeste", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest("{not json");
    store.failBackupWrite = true;
    const h = setup([a], store);
    const summary = await h.indexer.start();
    expect(summary.failures).toEqual([
      `${MANIFEST_FILE_NAME} : sauvegarde du manifeste rejeté impossible : write failed ${BACKUP_FILE}`,
    ]);
    expect(store.writes).toEqual([]);
  });

  it("les avertissements « original sauvegardé » et « ignoré » ne sont émis qu'une fois par sauvegarde et problème", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest("{not json");
    const h = setup([a], store);
    h.pdfs.set(a.path, new Error("illisible"));
    for (let i = 0; i < 3; i++) {
      await h.indexer.start();
      store.setRawManifest("{not json");
    }
    expect(h.warnings.filter((w) => w.includes("original sauvegardé"))).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("ignoré ("))).toHaveLength(1);
  });

  it("un manifeste valide ne crée aucune sauvegarde", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    await h.indexer.start();
    expect(backupNames(store)).toEqual([]);
  });
});

describe("revue : entrée d'une version postérieure", () => {
  it("un PDF modifié dont l'entrée est en version 3 est réécrit en version courante (le .dsx écrit est en v2)", async () => {
    const a = entry("assets/a.pdf", 100, 1);
    const store = new FakeStore();
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 3 }] });
    const h = setup([entry("assets/a.pdf", 100, 2)], store);
    const summary = await h.indexer.start();
    expect(summary).toMatchObject({ indexed: 1, migrated: 0 });
    expect(store.versionOf(a.path)).toBe(CURRENT_INDEX_VERSION);
  });

  it("une réindexation forcée d'un PDF inchangé en version 3 le réécrit en version courante, sans le compter migré", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 3 }] });
    const h = setup([a], store);
    const summary = await h.indexer.reindex(a.path);
    expect(summary).toMatchObject({ indexed: 1, migrated: 0 });
    expect(store.versionOf(a.path)).toBe(CURRENT_INDEX_VERSION);
  });

  it("l'avertissement d'indexVersion n'est pas répété à chaque passe", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 3 }] });
    const h = setup([a], store);
    await h.indexer.start();
    await h.indexer.start();
    await h.indexer.start({ automatic: true });
    expect(h.warnings.filter((w) => w.includes("assets/a.pdf") && w.includes("indexVersion"))).toHaveLength(1);
  });

  it("une valeur différente pour le même chemin est de nouveau signalée", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 3 }] });
    const h = setup([a], store);
    await h.indexer.start();
    store.setRawManifest({ version: 1, entries: [{ ...a, indexVersion: 4 }] });
    await h.indexer.start();
    expect(h.warnings.filter((w) => w.includes("assets/a.pdf") && w.includes("indexVersion"))).toHaveLength(2);
  });
});

describe("revue : réindexation ciblée et migration", () => {
  it("reindex(chemin) ne migre pas le reste de la bibliothèque", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a, b]);
    const h = setup([a, b], store);
    const summary = await h.indexer.reindex(b.path);
    expect(h.loaded).toEqual(["assets/b.pdf"]);
    expect(summary).toMatchObject({ indexed: 1, migrated: 1 });
    expect(store.versionOf(a.path)).toBe(1); // non migré (version normalisée par la réécriture du manifeste)
    expect(store.versionOf(b.path)).toBe(CURRENT_INDEX_VERSION);
  });

  it("le plan d'un reindex ciblé d'un PDF en v1 annonce 1 migration, cohérente avec le bilan", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a, b]);
    const h = setup([a, b], store);
    const summary = await h.indexer.reindex(a.path);
    expect(h.events.filter((e) => e.type === "plan")).toEqual([{ type: "plan", toIndex: 1, migrating: 1, complete: true }]);
    expect(summary.migrated).toBe(1);
  });

  it("reindex(chemin) d'un PDF déjà en v2 : pas d'événement plan, pas de migration", async () => {
    const a = entry("assets/a.pdf");
    const h = setup([a]);
    await h.indexer.start();
    h.events.length = 0;
    const summary = await h.indexer.reindex(a.path);
    expect(h.events.some((e) => e.type === "plan")).toBe(false);
    expect(summary).toMatchObject({ indexed: 1, migrated: 0 });
  });

  it("reindex() complet migre toute la bibliothèque", async () => {
    const a = entry("assets/a.pdf");
    const b = entry("assets/b.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a, b]);
    const h = setup([a, b], store);
    const summary = await h.indexer.reindex();
    expect(summary).toMatchObject({ indexed: 2, migrated: 2 });
  });

  it("l'événement plan indique si le parcours était complet", async () => {
    const a = entry("assets/a.pdf");
    const store = new FakeStore();
    await seedLegacy(store, [a]);
    const h = setup([a], store);
    h.discover = async () => ({ manifest: [a], issues: [{ kind: "depth" as const, path: "assets/x", message: "illisible" }], complete: false, unsized: [] });
    await h.indexer.start();
    expect(h.events.filter((e) => e.type === "plan")).toEqual([{ type: "plan", toIndex: 1, migrating: 1, complete: false }]);
  });
});
