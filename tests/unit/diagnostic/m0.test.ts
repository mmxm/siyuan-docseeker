import { describe, expect, it, vi } from "vitest";
import {
  formatReport,
  runM0Diagnostic,
  type CheckResult,
  type M0Deps,
  type M0Report,
  type PdfjsLike,
} from "../../../src/diagnostic/m0";
import { KernelApiError, type DirEntry } from "../../../src/siyuan/kernelApi";

const PETAL = "/data/storage/petal/siyuan-docseeker";
const PROBE = `${PETAL}/m0-probe.bin`;
const file = (name: string): DirEntry => ({ name, isDir: false, isSymlink: false, updated: 1700000000 });

interface Overrides {
  files?: readonly string[];
  sizes?: Record<string, number>;
  kernel?: Partial<M0Deps["kernel"]>;
  fetch?: M0Deps["fetch"];
  pdfjs?: PdfjsLike | undefined;
  createWorker?: M0Deps["createWorker"] | null;
  payloadBytes?: number;
}

function makeDeps(o: Overrides = {}) {
  const files = o.files ?? ["big é.pdf", "small.pdf"];
  const sizes = o.sizes ?? { "/assets/big é.pdf": 5000, "/assets/small.pdf": 100 };
  const store = new Map<string, Uint8Array>();
  const removeFile = vi.fn(async (path: string) => {
    store.delete(path);
  });
  const kernel: M0Deps["kernel"] = {
    readDir: async () => files.map(file),
    getFile: async (p) => {
      const v = store.get(p);
      if (!v) throw new Error("absent");
      return v;
    },
    putFile: async (p, bytes) => {
      store.set(p, bytes);
    },
    removeFile,
    headAsset: async (url) => {
      const size = sizes[url];
      if (size === undefined) throw new KernelApiError(404, -1, "no head");
      return { size };
    },
    ...o.kernel,
  };
  const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 206 }));
  let t = 0;
  const pdfjs: PdfjsLike = {
    version: "4.0.1",
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 7,
        getPage: async () => ({ getTextContent: async () => ({ items: [1, 2, 3] }) }),
        destroy: vi.fn(),
      }),
    }),
  };
  const deps: M0Deps = {
    kernel,
    fetch: o.fetch ?? fetchMock,
    pdfjs: "pdfjs" in o ? o.pdfjs : pdfjs,
    ...(o.createWorker === null ? {} : { createWorker: o.createWorker ?? (() => ({ terminate: vi.fn(), onerror: null })) }),
    now: () => (t += 100),
    petalDir: PETAL,
    payloadBytes: o.payloadBytes ?? 4096,
  };
  return { deps, store, removeFile, fetchMock };
}

const by = (r: M0Report, id: string): CheckResult => {
  const c = r.results.find((x) => x.id === id);
  if (!c) throw new Error(`missing ${id}`);
  return c;
};

describe("runM0Diagnostic", () => {
  it("renvoie les 7 checks dans l'ordre et ok quand tout passe", async () => {
    const { deps } = makeDeps();
    const r = await runM0Diagnostic(deps);
    expect(r.results.map((c) => c.id)).toEqual(["discovery", "head", "range", "roundtrip", "pdfjs", "worker", "auth"]);
    expect(r.ok).toBe(true);
    expect(by(r, "auth").status).toBe("skip");
    for (const id of ["discovery", "head", "range", "roundtrip", "pdfjs", "worker"]) {
      expect(by(r, id).status).toBe("pass");
    }
    expect(r.results.every((c) => c.durationMs > 0)).toBe(true);
  });

  it("discovery: nb de PDF, complete et plus gros fichier", async () => {
    const { deps } = makeDeps();
    const c = by(await runM0Diagnostic(deps), "discovery");
    expect(c.detail).toContain("2");
    expect(c.detail).toContain("assets/big é.pdf");
    expect(c.detail).toContain("5000");
    expect(c.detail).toMatch(/complet/i);
  });

  it("discovery incomplète => fail ; autres checks continuent", async () => {
    const { deps } = makeDeps({ sizes: { "/assets/big é.pdf": 5000 } });
    const r = await runM0Diagnostic(deps);
    expect(by(r, "discovery").status).toBe("fail");
    expect(by(r, "roundtrip").status).toBe("pass");
    expect(r.ok).toBe(false);
  });

  it("discovery qui lève => fail et checks dépendants skip", async () => {
    const { deps } = makeDeps({ kernel: { readDir: async () => { throw new Error("boom"); } } });
    const r = await runM0Diagnostic(deps);
    expect(by(r, "discovery").status).toBe("fail");
    expect(by(r, "discovery").detail).toContain("boom");
    for (const id of ["head", "range", "pdfjs"]) expect(by(r, id).status).toBe("skip");
    expect(by(r, "roundtrip").status).toBe("pass");
  });

  it("aucun PDF => discovery pass, dépendants skip avec raison", async () => {
    const { deps } = makeDeps({ files: [], sizes: {} });
    const r = await runM0Diagnostic(deps);
    expect(by(r, "discovery").status).toBe("pass");
    for (const id of ["head", "range", "pdfjs"]) {
      expect(by(r, id).status).toBe("skip");
      expect(by(r, id).detail).toMatch(/aucun PDF/i);
    }
    expect(r.ok).toBe(true);
  });

  it("head: taille lue ; échec si headAsset lève", async () => {
    const ok = by(await runM0Diagnostic(makeDeps().deps), "head");
    expect(ok.detail).toContain("5000");
    const { deps } = makeDeps();
    let calls = 0;
    const orig = deps.kernel.headAsset;
    const failing: M0Deps = {
      ...deps,
      kernel: { ...deps.kernel, headAsset: async (u) => (++calls > 2 ? Promise.reject(new Error("no CL")) : orig(u)) },
    };
    const r = await runM0Diagnostic(failing);
    expect(by(r, "head").status).toBe("fail");
    expect(by(r, "head").detail).toContain("no CL");
  });

  it("range: envoie Range sur l'URL encodée par segment, 206 => pass", async () => {
    const { deps, fetchMock } = makeDeps();
    const r = await runM0Diagnostic(deps);
    const call = fetchMock.mock.calls.find(([u]) => u === "/assets/big%20%C3%A9.pdf");
    expect(call).toBeDefined();
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("Range")).toBe("bytes=0-1023");
    expect(by(r, "range").detail).toContain("206");
  });

  it("range: 200 => fail avec mention de l'absence de Range", async () => {
    const { deps } = makeDeps({ fetch: async () => new Response("x", { status: 200 }) });
    const c = by(await runM0Diagnostic(deps), "range");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/200/);
    expect(c.detail).toMatch(/pas de Range/i);
  });

  it("range: autre statut ou exception => fail", async () => {
    const a = by(await runM0Diagnostic(makeDeps({ fetch: async () => new Response(null, { status: 403 }) }).deps), "range");
    expect(a.status).toBe("fail");
    expect(a.detail).toContain("403");
    const b = by(await runM0Diagnostic(makeDeps({ fetch: async () => { throw new Error("net"); } }).deps), "range");
    expect(b.status).toBe("fail");
    expect(b.detail).toContain("net");
  });

  it("roundtrip: écrit sous petalDir/m0-probe.bin, relit, supprime, donne un débit", async () => {
    const { deps, store, removeFile } = makeDeps({ payloadBytes: 200_000 });
    const putSpy = vi.spyOn(deps.kernel, "putFile");
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/Mo\/s/);
    expect(putSpy.mock.calls[0]?.[0]).toBe(PROBE);
    expect(putSpy.mock.calls[0]?.[1]).toHaveLength(200_000);
    expect(removeFile).toHaveBeenCalledWith(PROBE);
    expect(store.size).toBe(0);
  });

  it("roundtrip: payload aléatoire (deux exécutions différentes)", async () => {
    const seen: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      const { deps } = makeDeps({ payloadBytes: 1024 });
      const put = deps.kernel.putFile;
      deps.kernel.putFile = async (p, b, m, s) => {
        seen.push(b);
        return put(p, b, m, s);
      };
      await runM0Diagnostic(deps);
    }
    expect(Buffer.from(seen[0] as Uint8Array).equals(Buffer.from(seen[1] as Uint8Array))).toBe(false);
  });

  it("roundtrip: utilise 50 Mio par défaut", async () => {
    const { deps } = makeDeps();
    const put = vi.fn(async () => {});
    const noPayload: M0Deps = { ...deps, kernel: { ...deps.kernel, putFile: put, getFile: async () => new Uint8Array(0) } };
    delete (noPayload as { payloadBytes?: number }).payloadBytes;
    await runM0Diagnostic(noPayload);
    expect((put.mock.calls[0] as unknown as [string, Uint8Array])[1]).toHaveLength(50 * 1024 * 1024);
  });

  it("roundtrip: octets différents => fail, removeFile quand même appelé", async () => {
    const { deps, removeFile } = makeDeps();
    deps.kernel.getFile = async () => new Uint8Array(4096);
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/différ|diff/i);
    expect(removeFile).toHaveBeenCalledWith(PROBE);
  });

  it("roundtrip: longueur différente => fail", async () => {
    const { deps } = makeDeps();
    deps.kernel.getFile = async () => new Uint8Array(3);
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/taille|longueur/i);
  });

  it("roundtrip: putFile lève => fail et removeFile appelé", async () => {
    const { deps, removeFile } = makeDeps({ kernel: { putFile: async () => { throw new Error("too big"); } } });
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("too big");
    expect(removeFile).toHaveBeenCalledWith(PROBE);
  });

  it("roundtrip: getFile lève => fail et removeFile appelé", async () => {
    const { deps, removeFile } = makeDeps({ kernel: { getFile: async () => { throw new Error("gone"); } } });
    expect(by(await runM0Diagnostic(deps), "roundtrip").status).toBe("fail");
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it("roundtrip: removeFile échoue => fail", async () => {
    const { deps } = makeDeps({ kernel: { removeFile: async () => { throw new Error("rm denied"); } } });
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("rm denied");
  });

  it("roundtrip: échec du test ET de removeFile => les deux sont mentionnés", async () => {
    const { deps } = makeDeps({
      kernel: {
        putFile: async () => { throw new Error("put bad"); },
        removeFile: async () => { throw new Error("rm bad"); },
      },
    });
    const c = by(await runM0Diagnostic(deps), "roundtrip");
    expect(c.detail).toContain("put bad");
    expect(c.detail).toContain("rm bad");
  });

  it("roundtrip: durée nulle ne produit pas d'Infinity", async () => {
    const { deps } = makeDeps();
    const frozen: M0Deps = { ...deps, now: () => 1 };
    const c = by(await runM0Diagnostic(frozen), "roundtrip");
    expect(c.status).toBe("pass");
    expect(c.detail).not.toMatch(/Infinity|NaN/);
  });

  it("pdfjs: version, pages et items sur le plus petit PDF via /assets", async () => {
    const getDocument = vi.fn((_s: { url: string }) => ({
      promise: Promise.resolve({
        numPages: 7,
        getPage: async () => ({ getTextContent: async () => ({ items: [1, 2, 3] }) }),
        destroy: vi.fn(),
      }),
    }));
    const { deps } = makeDeps({ pdfjs: { version: "4.0.1", getDocument } });
    const c = by(await runM0Diagnostic(deps), "pdfjs");
    expect(getDocument).toHaveBeenCalledWith({ url: "/assets/small.pdf" });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("4.0.1");
    expect(c.detail).toContain("7");
    expect(c.detail).toContain("3");
  });

  it("pdfjs: destroy appelé, version absente tolérée, destroy optionnel", async () => {
    const destroy = vi.fn();
    const mk = (withDestroy: boolean): PdfjsLike => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
          ...(withDestroy ? { destroy } : {}),
        }),
      }),
    });
    const a = by(await runM0Diagnostic(makeDeps({ pdfjs: mk(true) }).deps), "pdfjs");
    expect(a.status).toBe("pass");
    expect(a.detail).toMatch(/inconnue/i);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(by(await runM0Diagnostic(makeDeps({ pdfjs: mk(false) }).deps), "pdfjs").status).toBe("pass");
  });

  it("pdfjs: absent => fail ; getDocument qui rejette => fail", async () => {
    const a = by(await runM0Diagnostic(makeDeps({ pdfjs: undefined }).deps), "pdfjs");
    expect(a.status).toBe("fail");
    expect(a.detail).toMatch(/pdfjs/i);
    const bad: PdfjsLike = { getDocument: () => ({ promise: Promise.reject(new Error("invalid pdf")) }) };
    const b = by(await runM0Diagnostic(makeDeps({ pdfjs: bad }).deps), "pdfjs");
    expect(b.status).toBe("fail");
    expect(b.detail).toContain("invalid pdf");
  });

  it("worker: sans createWorker => skip", async () => {
    const { deps } = makeDeps({ createWorker: null });
    const r = await runM0Diagnostic(deps);
    expect(by(r, "worker").status).toBe("skip");
    expect(r.ok).toBe(true);
  });

  it("worker: crée l'URL same-origin puis terminate ; exception => fail et terminate si créé", async () => {
    const terminate = vi.fn();
    const createWorker = vi.fn((_u: string) => ({ terminate, onerror: null }));
    const { deps } = makeDeps({ createWorker });
    expect(by(await runM0Diagnostic(deps), "worker").status).toBe("pass");
    expect(createWorker).toHaveBeenCalledWith("/stage/protyle/js/pdf/pdf.worker.min.mjs");
    expect(terminate).toHaveBeenCalledTimes(1);
    const f = makeDeps({
      createWorker: () => {
        throw new Error("SecurityError");
      },
    });
    const c = by(await runM0Diagnostic(f.deps), "worker");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("SecurityError");
  });

  it("isole les exceptions et tronque le message à 200 caractères", async () => {
    const { deps } = makeDeps({ fetch: async () => { throw new Error("x".repeat(500)); } });
    const c = by(await runM0Diagnostic(deps), "range");
    expect(c.detail.length).toBeLessThanOrEqual(200 + 60);
    expect(c.detail).not.toContain("x".repeat(201));
  });

  it("une valeur levée non-Error est convertie en texte", async () => {
    const { deps } = makeDeps({ fetch: async () => Promise.reject("plain") });
    expect(by(await runM0Diagnostic(deps), "range").detail).toContain("plain");
  });
});

describe("formatReport", () => {
  const report: M0Report = {
    ok: false,
    results: [
      { id: "a", label: "Alpha", status: "pass", detail: "bien", durationMs: 1 },
      { id: "b", label: "Beta", status: "fail", detail: "mal", durationMs: 2 },
      { id: "c", label: "Gamma", status: "skip", detail: "rien", durationMs: 0 },
    ],
  };

  it("une ligne par check avec statut, puis un résumé", () => {
    const lines = formatReport(report).split("\n");
    expect(lines[0]).toBe("[OK] Alpha — bien");
    expect(lines[1]).toBe("[ÉCHEC] Beta — mal");
    expect(lines[2]).toBe("[IGNORÉ] Gamma — rien");
    const summary = lines.slice(3).join("\n");
    expect(summary).toMatch(/1 OK/);
    expect(summary).toMatch(/1 échec/);
    expect(summary).toMatch(/1 ignoré/);
  });

  it("résumé positif quand ok", () => {
    const text = formatReport({ ok: true, results: [{ id: "a", label: "A", status: "pass", detail: "d", durationMs: 1 }] });
    expect(text).toMatch(/aucun échec/i);
  });
});
