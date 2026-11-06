// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traceKeys } from "../../../src/diagnostic/traceKeys";

const T0 = new Date(2026, 0, 2, 3, 4, 5, 6).getTime();

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
}

describe("traceKeys", () => {
  let root: HTMLElement;
  let list: HTMLElement;
  let card: HTMLElement;
  let lines: string[];
  let stop: () => void;
  let queue: Array<() => void>;
  const defer = (fn: () => void) => void queue.push(fn);
  const flush = () => queue.splice(0).forEach((f) => f());
  let extra: Array<() => void>;
  const onWindowCapture = (fn: (e: Event) => void) => {
    window.addEventListener("keydown", fn, { capture: true });
    extra.push(() => window.removeEventListener("keydown", fn, { capture: true }));
  };

  beforeEach(() => {
    document.body.textContent = "";
    root = document.createElement("div");
    root.id = "root1";
    root.className = "docseeker-root";
    list = document.createElement("div");
    list.className = "docseeker-list";
    card = document.createElement("button");
    card.id = "card1";
    card.className = "docseeker-card";
    list.append(card);
    root.append(list);
    document.body.append(root);
    lines = [];
    queue = [];
    extra = [];
  });

  afterEach(() => {
    stop?.();
    extra.forEach((f) => f());
  });

  const start = (opts: Parameters<typeof traceKeys>[2] = {}) => {
    stop = traceKeys(root, (l) => lines.push(l), { now: () => T0, defer, ...opts });
  };

  it("journalise les phases dans l'ordre", () => {
    start();
    card.dispatchEvent(key("ArrowDown"));
    const phases = lines.map((l) => l.split(" ").slice(1, 3).join(" "));
    expect(phases).toEqual([
      "window capture",
      "document capture",
      "root capture",
      "list capture",
      "root bubble",
    ]);
  });

  it("format de ligne stable", () => {
    start();
    card.focus();
    card.dispatchEvent(key("ArrowDown"));
    expect(lines[0]).toBe(
      "03:04:05.006 window capture key=ArrowDown target=button#card1.docseeker-card active=button#card1.docseeker-card prevented=false stopped=unknown",
    );
  });

  it("détecte defaultPrevented posé avant nous", () => {
    start();
    onWindowCapture((e) => e.preventDefault());
    // notre écouteur est déjà posé avant : le second le voit via root
    const ev = key("ArrowUp");
    card.dispatchEvent(ev);
    expect(lines.find((l) => l.includes("root capture"))).toContain("prevented=true");
    expect(lines.find((l) => l.includes("window capture"))).toContain("prevented=false");
  });

  it("signale une interception avant root", () => {
    start();
    onWindowCapture((e) => e.stopPropagation());
    card.dispatchEvent(key("ArrowLeft"));
    flush();
    expect(lines.some((l) => l.includes("window capture"))).toBe(true);
    expect(lines.some((l) => l.includes("root capture"))).toBe(false);
    expect(lines[lines.length - 1]).toContain("INTERCEPTÉ avant root key=ArrowLeft");
  });

  it("pas de synthèse si root est atteint", () => {
    start();
    card.dispatchEvent(key("Enter"));
    flush();
    expect(lines.some((l) => l.includes("INTERCEPTÉ"))).toBe(false);
  });

  it("la synthèse passe par defer (par défaut asynchrone)", () => {
    vi.useFakeTimers();
    try {
      stop = traceKeys(root, (l) => lines.push(l), { now: () => T0 });
      onWindowCapture((e) => e.stopPropagation());
      card.dispatchEvent(key("Tab"));
      expect(lines.some((l) => l.includes("INTERCEPTÉ"))).toBe(false);
      vi.runAllTimers();
      expect(lines.some((l) => l.includes("INTERCEPTÉ"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("trace le changement de focus entre phases", () => {
    const other = document.createElement("input");
    other.id = "other";
    document.body.append(other);
    root.addEventListener("keydown", () => other.focus());
    start();
    card.focus();
    card.dispatchEvent(key("ArrowRight"));
    expect(lines.find((l) => l.includes("root capture"))).toContain("active=button#card1");
    expect(lines.find((l) => l.includes("root bubble"))).toContain("active=input#other");
  });

  it("ignore les touches hors liste et respecte keys", () => {
    start();
    card.dispatchEvent(key("a"));
    expect(lines).toEqual([]);
    stop();
    start({ keys: ["x"] });
    card.dispatchEvent(key("ArrowDown"));
    card.dispatchEvent(key("x"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes("key=x"))).toBe(true);
  });

  it("couvre une liste ajoutée après l'installation", () => {
    start();
    const late = document.createElement("div");
    late.className = "docseeker-list";
    const b = document.createElement("button");
    late.append(b);
    root.append(late);
    b.dispatchEvent(key("Home"));
    expect(lines.filter((l) => l.includes("list capture"))).toHaveLength(1);
  });

  it("ne modifie jamais l'événement", () => {
    start();
    const ev = key("Escape");
    const p = vi.spyOn(ev, "preventDefault");
    const s = vi.spyOn(ev, "stopPropagation");
    card.dispatchEvent(ev);
    expect(p).not.toHaveBeenCalled();
    expect(s).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("la désinscription retire tous les écouteurs", () => {
    const targets: EventTarget[] = [window, document, root, list];
    const spies = targets.map((t) => vi.spyOn(t, "addEventListener"));
    const rem = targets.map((t) => vi.spyOn(t, "removeEventListener"));
    start();
    card.dispatchEvent(key("End"));
    stop();
    const added = spies.flatMap((s) => s.mock.calls.filter((c) => c[0] === "keydown"));
    const removed = rem.flatMap((s) => s.mock.calls.filter((c) => c[0] === "keydown"));
    expect(added.length).toBeGreaterThanOrEqual(5);
    expect(removed.length).toBe(added.length);
    for (const [, fn, opt] of added) {
      expect(removed.some((r) => r[1] === fn && Boolean(typeof r[2] === "object" ? (r[2] as AddEventListenerOptions).capture : r[2]) === Boolean(typeof opt === "object" ? (opt as AddEventListenerOptions).capture : opt))).toBe(true);
    }
    lines.length = 0;
    card.dispatchEvent(key("PageUp"));
    expect(lines).toEqual([]);
    vi.restoreAllMocks();
  });

  it("la désinscription retire aussi les listes ajoutées tard", () => {
    start();
    const late = document.createElement("div");
    late.className = "docseeker-list";
    root.append(late);
    late.dispatchEvent(key("Home"));
    stop();
    lines.length = 0;
    late.dispatchEvent(key("PageDown"));
    expect(lines).toEqual([]);
  });

  it("n'écrit aucune valeur de champ ni texte", () => {
    const input = document.createElement("input");
    input.value = "SECRET-QUERY";
    input.id = "q";
    root.append(input);
    card.textContent = "CONTENU-PDF";
    start();
    input.focus();
    input.dispatchEvent(key("Enter"));
    card.dispatchEvent(key("Enter"));
    const all = lines.join("\n");
    expect(all).not.toContain("SECRET-QUERY");
    expect(all).not.toContain("CONTENU-PDF");
    expect(all).toContain("input#q");
  });
});
