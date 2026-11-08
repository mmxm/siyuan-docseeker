// @vitest-environment jsdom
// E4b : tailles de dialogue min(...) et dvh acceptées, entrées malveillantes toujours refusées (largeur et hauteur).
import { beforeEach, describe, expect, it } from "vitest";
import { Dialog, Menu } from "siyuan";
import { openCustomDialog, openDialog, openConfirmDialog, openInputDialog } from "../../../src/siyuan/nativeUi";

interface StubDialog { options: { width?: string; height?: string } }
const stub = Dialog as unknown as { instances: StubDialog[]; reset(): void };
const last = (): StubDialog => stub.instances.at(-1)!;

beforeEach(() => {
  document.body.innerHTML = "";
  (Menu as unknown as { reset(): void }).reset();
  stub.reset();
});

const VALID = ["420px", "0px", "0vw", "94vw", "90vh", "90dvh", "100dvw", "min(420px, 94vw)", "min(520px,94vw)", "min(420px, 94dvw)", "min(1px, 2dvh)"];
const HOSTILE = [
  '420px;"onload=1', "50%", "px", "420", "99999px", "min(420px, 94vw);x", "min(420px, 94vw", "min(420px)", "min(420px, 94vw, 3px)",
  "min(expression(1), 2px)", "min(420px, url(x))", "calc(1px + 2px)", "max(420px, 94vw)", "min(420px, 94vw) ", " min(420px, 94vw)",
  'min(420px, 94vw)"onload=1', "min(420px, 94vw)<img>", "min(420px,  94vw)", "min(-1px, 94vw)", "min(1e3px, 94vw)", "min(420 px, 94vw)",
  "min(420px, 94vw)\n", "min(\\34 20px, 94vw)", "var(--x)", "",
];
const noop = () => undefined;
const labels = { cancel: "Annuler", confirm: "OK" };

describe("tailles de dialogue : openDialog", () => {
  it.each(VALID.slice(0, 1).concat(["min(420px, 94vw)", "min(420px,94vw)"]))("accepte la largeur « %s »", (width) => {
    openDialog({ title: "T", width, labels, build: noop, onConfirm: () => true });
    expect(last().options.width).toBe(width);
  });
  it.each(HOSTILE)("refuse la largeur « %s »", (width) => {
    expect(() => openDialog({ title: "T", width, labels, build: noop, onConfirm: () => true })).toThrow(TypeError);
  });
});

describe("tailles de dialogue : openInputDialog et openConfirmDialog", () => {
  it("largeur par défaut min(520px, 94vw) (bureau : 520px tant que la fenêtre fait plus de 553px)", () => {
    openInputDialog({ title: "T", value: "", placeholder: "", dataKey: "dialog-x", labels, onConfirm: noop });
    expect(last().options.width).toBe("min(520px, 94vw)");
    openConfirmDialog({ title: "T", text: "t", labels, onConfirm: noop });
    expect(last().options.width).toBe("min(520px, 94vw)");
  });
  it.each(["min(420px, 94vw)", "520px"])("accepte la largeur « %s »", (width) => {
    openInputDialog({ title: "T", value: "", placeholder: "", dataKey: "dialog-x", labels, onConfirm: noop, width });
    expect(last().options.width).toBe(width);
  });
  it.each(HOSTILE)("refuse la largeur « %s »", (width) => {
    expect(() => openInputDialog({ title: "T", value: "", placeholder: "", dataKey: "dialog-x", labels, onConfirm: noop, width })).toThrow(/Largeur de dialogue refusée/);
  });
});

describe("tailles de dialogue : openCustomDialog", () => {
  const content = (): DocumentFragment => document.createDocumentFragment();
  it.each(VALID)("accepte largeur et hauteur « %s »", (size) => {
    openCustomDialog({ title: "T", width: size, height: size, dataKey: "dialog-x", content: content() });
    expect([last().options.width, last().options.height]).toEqual([size, size]);
  });
  it.each(HOSTILE)("refuse la largeur « %s »", (width) => {
    expect(() => openCustomDialog({ title: "T", width, height: "70vh", dataKey: "dialog-x", content: content() })).toThrow(TypeError);
  });
  it.each(HOSTILE)("refuse la hauteur « %s »", (height) => {
    expect(() => openCustomDialog({ title: "T", width: "50vw", height, dataKey: "dialog-x", content: content() })).toThrow(TypeError);
  });
});

describe("bornes de taille", () => {
  it("0px est accepté explicitement (valeur CSS valide, sans risque) ; 5 chiffres refusés", () => {
    openDialog({ title: "T", width: "0px", labels, build: noop, onConfirm: () => true });
    expect(last().options.width).toBe("0px");
    expect(() => openDialog({ title: "T", width: "10000px", labels, build: noop, onConfirm: () => true })).toThrow(TypeError);
    expect(() => openDialog({ title: "T", width: "min(10000px, 1px)", labels, build: noop, onConfirm: () => true })).toThrow(TypeError);
  });
});

describe("classe des dialogues natifs (cibles tactiles du CSS)", () => {
  it("les quatre ouvreurs marquent leur dialogue docseeker-dialog", () => {
    openDialog({ title: "T", labels, build: noop, onConfirm: () => true });
    openInputDialog({ title: "T", value: "", placeholder: "", dataKey: "dialog-x", labels, onConfirm: noop });
    openConfirmDialog({ title: "T", text: "t", labels, onConfirm: noop });
    openCustomDialog({ title: "T", width: "50vw", height: "70vh", dataKey: "dialog-x", content: document.createDocumentFragment() });
    expect(stub.instances).toHaveLength(4);
    for (const d of stub.instances) expect((d as unknown as { element: HTMLElement }).element.classList.contains("docseeker-dialog")).toBe(true);
  });
});
