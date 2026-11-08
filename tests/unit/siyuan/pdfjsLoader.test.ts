import { describe, expect, it, vi } from "vitest";
import {
  PDFJS_MODULE_SRC,
  createLazyPdfjs,
  type LazyPdfjsDeps,
} from "../../../src/siyuan/pdfjsLoader";

/** Faux DOM minimal : une balise script avec écouteurs, un parent qui la contient. */
function fakeEnv(options: { timeoutMs?: number } = {}) {
  const win: { pdfjsLib?: unknown } = {};
  const scripts: Array<{
    type: string;
    src: string;
    remove: ReturnType<typeof vi.fn>;
    listeners: Record<string, () => void>;
    addEventListener: (name: string, fn: () => void) => void;
  }> = [];
  const appended: unknown[] = [];
  const document = {
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe("script");
      const listeners: Record<string, () => void> = {};
      const script = {
        type: "",
        src: "",
        remove: vi.fn(),
        listeners,
        addEventListener: (name: string, fn: () => void) => {
          listeners[name] = fn;
        },
      };
      scripts.push(script);
      return script;
    }),
    head: { appendChild: vi.fn((node: unknown) => appended.push(node)) },
  };
  let clock = 0;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
  };
  const deps: LazyPdfjsDeps = {
    window: win,
    document: document as unknown as LazyPdfjsDeps["document"],
    timeoutMs: options.timeoutMs ?? 1000,
    pollIntervalMs: 100,
    now: () => clock,
    sleep,
  };
  return { win, scripts, appended, document, deps, sleep };
}

describe("createLazyPdfjs", () => {
  it("renvoie window.pdfjsLib sans rien injecter quand il existe déjà (bureau)", async () => {
    const env = fakeEnv();
    const lib = { getDocument: vi.fn() };
    env.win.pdfjsLib = lib;
    const get = createLazyPdfjs(env.deps);
    await expect(get()).resolves.toBe(lib);
    expect(env.document.createElement).not.toHaveBeenCalled();
    expect(env.appended).toHaveLength(0);
  });

  it("injecte un module, attend pdfjsLib puis retire la balise", async () => {
    const env = fakeEnv();
    const lib = { getDocument: vi.fn() };
    const baseSleep = env.sleep;
    let polls = 0;
    const deps = {
      ...env.deps,
      sleep: async (ms: number) => {
        polls += 1;
        if (polls === 3) env.win.pdfjsLib = lib;
        await baseSleep(ms);
      },
    };
    await expect(createLazyPdfjs(deps)()).resolves.toBe(lib);
    expect(env.scripts).toHaveLength(1);
    expect(env.scripts[0]!.type).toBe("module");
    expect(env.scripts[0]!.src).toBe(PDFJS_MODULE_SRC);
    expect(PDFJS_MODULE_SRC).toBe("/stage/protyle/js/pdf/pdf.min.mjs?v=6.4.299-siyuan.1");
    expect(env.appended).toEqual([env.scripts[0]]);
    expect(env.scripts[0]!.remove).toHaveBeenCalledTimes(1);
  });

  it("partage une seule injection entre appels concurrents", async () => {
    const env = fakeEnv();
    const lib = {};
    let polls = 0;
    const baseSleep = env.sleep;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        if (++polls === 2) env.win.pdfjsLib = lib;
        await baseSleep(ms);
      },
    });
    const results = await Promise.all([get(), get(), get()]);
    expect(results).toEqual([lib, lib, lib]);
    expect(env.scripts).toHaveLength(1);
  });

  it("rejette au délai maximal avec une erreur claire, retire la balise et réessaie ensuite", async () => {
    const env = fakeEnv({ timeoutMs: 500 });
    const get = createLazyPdfjs(env.deps);
    await expect(get()).rejects.toThrow(/PDF\.js.*500/);
    expect(env.scripts[0]!.remove).toHaveBeenCalledTimes(1);

    // l'échec n'est pas mis en cache : un nouvel appel réinjecte
    const lib = {};
    const baseSleep = env.sleep;
    let first = true;
    const retry = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        if (first) {
          first = false;
          env.win.pdfjsLib = lib;
        }
        await baseSleep(ms);
      },
    });
    await expect(retry()).resolves.toBe(lib);
  });

  it("le même chargeur réessaie après un échec (pas de cache d'échec)", async () => {
    const env = fakeEnv({ timeoutMs: 300 });
    const lib = {};
    let appear = false;
    const baseSleep = env.sleep;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        if (appear) env.win.pdfjsLib = lib;
        await baseSleep(ms);
      },
    });
    await expect(get()).rejects.toThrow();
    appear = true;
    await expect(get()).resolves.toBe(lib);
    expect(env.scripts).toHaveLength(2);
    expect(env.scripts[1]!.remove).toHaveBeenCalledTimes(1);
  });

  it("rejette tout de suite sur une erreur de chargement de la balise", async () => {
    const env = fakeEnv();
    const baseSleep = env.sleep;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        env.scripts[0]!.listeners["error"]?.();
        await baseSleep(ms);
      },
    });
    await expect(get()).rejects.toThrow(/chargement.*PDF\.js/i);
    expect(env.scripts[0]!.remove).toHaveBeenCalledTimes(1);
  });

  it("fige l'URL du module PDF.js (doit rester identique à celle du noyau SiYuan 3.8.9)", () => {
    // Si elle diverge de celle du noyau, le navigateur évalue un second exemplaire de PDF.js.
    expect(PDFJS_MODULE_SRC).toBe("/stage/protyle/js/pdf/pdf.min.mjs?v=6.4.299-siyuan.1");
  });

  it("échoue tout de suite si `load` survient sans que pdfjsLib soit posé", async () => {
    const env = fakeEnv({ timeoutMs: 10_000 });
    const baseSleep = env.sleep;
    let sleeps = 0;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        sleeps += 1;
        env.scripts[0]!.listeners["load"]?.();
        await baseSleep(ms);
      },
    });
    await expect(get()).rejects.toThrow(/sans (poser|définir).*pdfjsLib/i);
    expect(sleeps).toBe(1);
    expect(env.scripts[0]!.remove).toHaveBeenCalledTimes(1);
  });

  it("`load` avec pdfjsLib posé réussit", async () => {
    const env = fakeEnv();
    const lib = {};
    const baseSleep = env.sleep;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        env.win.pdfjsLib = lib;
        env.scripts[0]!.listeners["load"]?.();
        await baseSleep(ms);
      },
    });
    await expect(get()).resolves.toBe(lib);
  });

  it("le succès l'emporte si `error` arrive après que pdfjsLib est posé", async () => {
    const env = fakeEnv();
    const lib = {};
    const baseSleep = env.sleep;
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        env.win.pdfjsLib = lib;
        env.scripts[0]!.listeners["error"]?.();
        await baseSleep(ms);
      },
    });
    await expect(get()).resolves.toBe(lib);
  });

  it("conserve l'événement d'erreur dans `cause`", async () => {
    const env = fakeEnv();
    const baseSleep = env.sleep;
    const event = { type: "error" };
    const get = createLazyPdfjs({
      ...env.deps,
      sleep: async (ms) => {
        (env.scripts[0]!.listeners["error"] as (e?: unknown) => void)(event);
        await baseSleep(ms);
      },
    });
    const error = await get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(event);
  });

  it("appendChild qui lève : rejet propre, balise retirée, réessai possible", async () => {
    const env = fakeEnv();
    env.document.head.appendChild.mockImplementationOnce(() => {
      throw new Error("DOM refusé");
    });
    const get = createLazyPdfjs(env.deps);
    await expect(get()).rejects.toThrow("DOM refusé");
    expect(env.scripts[0]!.remove).toHaveBeenCalledTimes(1);
    env.win.pdfjsLib = {};
    await expect(get()).resolves.toBe(env.win.pdfjsLib);
  });

  it("les appelants concurrents reçoivent tous le rejet, sans unhandledRejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const env = fakeEnv({ timeoutMs: 300 });
      const get = createLazyPdfjs(env.deps);
      const results = await Promise.allSettled([get(), get(), get()]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
      expect(env.scripts).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
