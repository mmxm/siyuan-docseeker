import { afterEach, describe, expect, it, vi } from "vitest";
import { armRangeLoading, disarmRangeLoading, RANGE_CHUNK_BYTES } from "../../../src/siyuan/rangeLoading";

type Lib = { getDocument: (src: unknown) => unknown };
const EXTRA = { disableStream: true, disableAutoFetch: true, rangeChunkSize: RANGE_CHUNK_BYTES };

function makeLib() {
  const original = vi.fn((src: unknown) => ({ src }));
  const lib: Lib = { getDocument: original };
  return { lib, original };
}

afterEach(() => {
  disarmRangeLoading();
  vi.useRealTimers();
});

describe("armRangeLoading", () => {
  it("ajoute les options de plage au premier appel correspondant, sans modifier src", () => {
    const { lib, original } = makeLib();
    armRangeLoading(lib, "assets/x.pdf");
    const src = { url: "/assets/x.pdf", disableStream: false };
    lib.getDocument(src);
    expect(original).toHaveBeenCalledWith({ url: "/assets/x.pdf", ...EXTRA });
    expect(src).toEqual({ url: "/assets/x.pdf", disableStream: false });
  });

  it("sert une seule fois puis remet l'original", () => {
    const { lib, original } = makeLib();
    armRangeLoading(lib, "assets/x.pdf");
    lib.getDocument({ url: "/assets/x.pdf" });
    expect(lib.getDocument).toBe(original);
    lib.getDocument({ url: "/assets/x.pdf" });
    expect(original).toHaveBeenLastCalledWith({ url: "/assets/x.pdf" });
  });

  it.each([
    ["encodée", "assets/mon fichier.pdf", "/assets/mon%20fichier.pdf"],
    ["accents NFD contre NFC", "assets/é.pdf".normalize("NFC"), "/assets/" + "é".normalize("NFD") + ".pdf"],
    ["accents NFC contre NFD", "assets/é.pdf".normalize("NFD"), "/assets/" + "é".normalize("NFC") + ".pdf"],
    ["accents encodés", "assets/é.pdf", "/assets/%C3%A9.pdf"],
    ["relative", "assets/x.pdf", "assets/x.pdf?v=1"],
    ["absolue", "assets/x.pdf", "http://127.0.0.1:6806/assets/x.pdf"],
    ["objet URL", "assets/x.pdf", new URL("http://h/assets/x.pdf")],
  ])("reconnaît une URL %s", (_name, path, url) => {
    const { lib, original } = makeLib();
    armRangeLoading(lib, path);
    lib.getDocument({ url });
    expect(original).toHaveBeenCalledWith({ url, ...EXTRA });
  });

  it("laisse passer sans modifier ce qui ne correspond pas, et reste armé", () => {
    const { lib, original } = makeLib();
    armRangeLoading(lib, "assets/x.pdf");
    const others = [{ url: "/assets/y.pdf" }, { url: "/assets/%E0%A4%A.pdf" }, { url: 3 }, {}, "str", null];
    for (const src of others) lib.getDocument(src);
    expect(original.mock.calls.map((c) => c[0])).toEqual(others);
    expect(lib.getDocument).not.toBe(original);
    lib.getDocument({ url: "/assets/x.pdf" });
    expect(original).toHaveBeenLastCalledWith({ url: "/assets/x.pdf", ...EXTRA });
  });

  it("laisse passer un appel déjà en plages seules (vignettes du plugin) et reste armé pour le visionneur", () => {
    const { lib, original } = makeLib();
    armRangeLoading(lib, "assets/x.pdf");
    lib.getDocument({ url: "/assets/x.pdf", disableStream: true });
    expect(original).toHaveBeenLastCalledWith({ url: "/assets/x.pdf", disableStream: true });
    lib.getDocument({ url: "/assets/x.pdf", disableStream: false });
    expect(original).toHaveBeenLastCalledWith({ url: "/assets/x.pdf", ...EXTRA });
  });

  it("préserve this et la valeur renvoyée", () => {
    const seen: unknown[] = [];
    const lib = {
      getDocument(this: unknown, src: unknown) {
        seen.push(this);
        return { promise: src };
      },
    };
    armRangeLoading(lib, "assets/x.pdf");
    const result = lib.getDocument({ url: "/assets/x.pdf" }) as { promise: unknown };
    expect(seen[0]).toBe(lib);
    expect(result.promise).toEqual({ url: "/assets/x.pdf", ...EXTRA });
  });

  it("se désarme après le délai", () => {
    vi.useFakeTimers();
    const { lib, original } = makeLib();
    armRangeLoading(lib, "assets/x.pdf", { timeoutMs: 100 });
    vi.advanceTimersByTime(99);
    expect(lib.getDocument).not.toBe(original);
    vi.advanceTimersByTime(1);
    expect(lib.getDocument).toBe(original);
  });

  it("se désarme par la fonction renvoyée, de façon idempotente", () => {
    const { lib, original } = makeLib();
    const disarm = armRangeLoading(lib, "assets/x.pdf");
    disarm();
    disarm();
    expect(lib.getDocument).toBe(original);
  });

  it("n'écrase pas un patch posé par un tiers", () => {
    const { lib } = makeLib();
    const disarm = armRangeLoading(lib, "assets/x.pdf");
    const third = vi.fn();
    lib.getDocument = third;
    disarm();
    expect(lib.getDocument).toBe(third);
  });

  it("ne fait rien sans getDocument", () => {
    for (const lib of [{}, null, undefined, { getDocument: 1 }]) {
      expect(() => armRangeLoading(lib, "assets/x.pdf")()).not.toThrow();
    }
  });

  it("réarmer désarme d'abord le précédent", () => {
    const a = makeLib();
    const b = makeLib();
    armRangeLoading(a.lib, "assets/x.pdf");
    armRangeLoading(b.lib, "assets/x.pdf");
    expect(a.lib.getDocument).toBe(a.original);
    expect(b.lib.getDocument).not.toBe(b.original);
  });

  it("l'ancienne fonction de désarmement n'affecte pas le nouvel armement", () => {
    const { lib, original } = makeLib();
    const first = armRangeLoading(lib, "assets/x.pdf");
    armRangeLoading(lib, "assets/x.pdf");
    first();
    expect(lib.getDocument).not.toBe(original);
  });

  it("objet gelé : ne lève pas, trace, et ne touche à rien", () => {
    const original = vi.fn();
    const lib = Object.freeze({ getDocument: original });
    const onWarn = vi.fn();
    const disarm = armRangeLoading(lib, "assets/x.pdf", { onWarn });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(() => disarm()).not.toThrow();
    expect(lib.getDocument).toBe(original);
  });

  it("la restauration qui échoue ne lève pas (temporisateur, onunload)", () => {
    vi.useFakeTimers();
    let writable = true;
    let current: unknown = vi.fn();
    const lib = {
      get getDocument() {
        return current;
      },
      set getDocument(value: unknown) {
        if (!writable) throw new TypeError("lecture seule");
        current = value;
      },
    };
    armRangeLoading(lib, "assets/x.pdf", { timeoutMs: 10 });
    writable = false;
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(() => disarmRangeLoading()).not.toThrow();
  });

  it("trace l'expiration sans appel correspondant, mais pas un usage normal ni un désarmement manuel", () => {
    vi.useFakeTimers();
    const a = makeLib();
    const onWarn = vi.fn();
    armRangeLoading(a.lib, "assets/x.pdf", { timeoutMs: 100, onWarn });
    vi.advanceTimersByTime(100);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain("assets/x.pdf");
    const b = makeLib();
    const quiet = vi.fn();
    armRangeLoading(b.lib, "assets/x.pdf", { timeoutMs: 100, onWarn: quiet });
    b.lib.getDocument({ url: "/assets/x.pdf" });
    vi.advanceTimersByTime(200);
    armRangeLoading(b.lib, "assets/x.pdf", { timeoutMs: 100, onWarn: quiet })();
    vi.advanceTimersByTime(200);
    expect(quiet).not.toHaveBeenCalled();
  });
});
