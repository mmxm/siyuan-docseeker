// @vitest-environment jsdom
// Mobile : ouverture du PDF dans le visionneur natif de SiYuan (clic sur un lien `assets/x.pdf?page=N` d'un paragraphe temporaire).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNativeMobilePdfOpener,
  NativeEditorMissingError,
  NativeModelNotOpenError,
  openNativeMobilePdf,
} from "../../../src/siyuan/nativeMobilePdf";
import { InvalidPdfPathError } from "../../../src/siyuan/openPdf";

const target = (path = "assets/doc.pdf", page = 7) => ({ app: {}, pdf: { path, page } });

let wysiwyg: HTMLElement;
beforeEach(() => {
  wysiwyg = document.createElement("div");
  document.body.append(wysiwyg);
});
afterEach(() => {
  document.body.replaceChildren();
});

/** Écoute les clics sur les liens du paragraphe temporaire ; `onClick` simule l'ouverture du modèle. */
function listen(onClick: (span: HTMLElement) => void = () => undefined): HTMLElement[] {
  const clicked: HTMLElement[] = [];
  wysiwyg.addEventListener("click", (event) => {
    const span = event.target as HTMLElement;
    clicked.push(span);
    onClick(span);
  });
  return clicked;
}

/** Horloge factice : `sleep` la fait avancer, le délai d'attente se mesure donc en temps écoulé et non en nombre de sondages. */
function make(over: Partial<Parameters<typeof createNativeMobilePdfOpener>[0]> = {}) {
  const clock = { t: 0 };
  const isModelOpen = vi.fn((_doc: Document) => true);
  const sleep = vi.fn(async (ms: number) => {
    clock.t += ms;
  });
  const open = createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, isModelOpen, sleep, now: () => clock.t, ...over });
  return { open, isModelOpen, sleep, clock };
}
const fakeTime = () => {
  const clock = { t: 0 };
  return { now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms), clock };
};

describe("openNativeMobilePdf", () => {
  it("clique le span data-type=a avec data-href assets/x.pdf?page=N dans un paragraphe valide", async () => {
    const clicked = listen();
    const { open } = make();
    await open(target("assets/doc.pdf", 7));
    expect(clicked).toHaveLength(1);
    const span = clicked[0]!;
    expect(span.getAttribute("data-type")).toBe("a");
    expect(span.getAttribute("data-href")).toBe("assets/doc.pdf?page=7");
    const para = span.closest("div.p")!;
    expect(para.getAttribute("data-type")).toBe("NodeParagraph");
    expect(para.getAttribute("data-node-id")).toMatch(/^\d{14}-[0-9a-z]{7}$/);
    expect(span.parentElement!.getAttribute("contenteditable")).toBe("true");
    expect(span.parentElement!.parentElement).toBe(para);
  });

  it("le clic est un MouseEvent qui remonte et s'annule", async () => {
    let seen: Event | undefined;
    wysiwyg.addEventListener("click", (e) => (seen = e));
    await make().open(target());
    expect(seen).toBeInstanceOf(MouseEvent);
    expect(seen!.bubbles).toBe(true);
    expect(seen!.cancelable).toBe(true);
  });

  it("retire le paragraphe temporaire après succès", async () => {
    listen();
    await make().open(target());
    expect(wysiwyg.childElementCount).toBe(0);
  });

  it("retire le paragraphe si le modèle ne s'ouvre pas", async () => {
    listen();
    const { open } = make({ isModelOpen: () => false, timeoutMs: 10 });
    await expect(open(target())).rejects.toThrow();
    expect(wysiwyg.childElementCount).toBe(0);
  });

  it("retire le paragraphe même si dispatchEvent lève (try/finally)", async () => {
    const boom = new Error("dispatch KO");
    const spy = vi.spyOn(EventTarget.prototype, "dispatchEvent").mockImplementation(() => {
      throw boom;
    });
    try {
      await expect(make().open(target())).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }
    expect(wysiwyg.childElementCount).toBe(0);
  });

  it("lève une erreur explicite si l'éditeur mobile est absent, sans rien cliquer", async () => {
    const { open } = make({ getWysiwyg: () => undefined });
    await expect(open(target())).rejects.toThrow(/éditeur/i);
    await expect(open(target())).rejects.toBeInstanceOf(NativeEditorMissingError);
  });

  it("lève si le modèle n'est pas ouvert après le clic", async () => {
    listen();
    const { open } = make({ isModelOpen: () => false, timeoutMs: 10 });
    await expect(open(target())).rejects.toThrow(/visionneur|modèle/i);
    await expect(open(target())).rejects.toBeInstanceOf(NativeModelNotOpenError);
  });

  it("mesure le délai en temps écoulé (horloge), pas en nombre de sondages", async () => {
    listen();
    const clock = { t: 0 };
    const sleep = vi.fn(async () => void (clock.t += 1000)); // chaque attente dure en réalité 1 s
    const open = createNativeMobilePdfOpener({
      getWysiwyg: () => wysiwyg,
      isModelOpen: () => false,
      sleep,
      now: () => clock.t,
      timeoutMs: 3000,
      pollMs: 50,
    });
    await expect(open(target())).rejects.toBeInstanceOf(NativeModelNotOpenError);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("dernier test avant de lever : un modèle ouvert pendant la dernière attente est accepté", async () => {
    listen();
    const clock = { t: 0 };
    let open = false;
    const sleep = vi.fn(async () => {
      clock.t += 5000; // dépasse le délai ; le modèle s'ouvre pendant cette attente
      open = true;
    });
    const opener = createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, isModelOpen: () => open, sleep, now: () => clock.t, timeoutMs: 3000 });
    await expect(opener(target())).resolves.toBeUndefined();
  });

  it("signal déjà annulé : aucun clic, aucun paragraphe, sortie sans erreur", async () => {
    const clicked = listen();
    const controller = new AbortController();
    controller.abort();
    const { open, isModelOpen } = make();
    await expect(open({ ...target(), signal: controller.signal })).resolves.toBeUndefined();
    expect(clicked).toHaveLength(0);
    expect(wysiwyg.childElementCount).toBe(0);
    expect(isModelOpen).not.toHaveBeenCalled();
  });

  it("signal annulé pendant le sondage : sortie de la boucle sans erreur", async () => {
    const clicked = listen();
    const controller = new AbortController();
    const { open, isModelOpen, sleep } = make({ isModelOpen: () => false, timeoutMs: 100000 });
    sleep.mockImplementation(async () => controller.abort());
    await expect(open({ ...target(), signal: controller.signal })).resolves.toBeUndefined();
    expect(clicked).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    void isModelOpen;
  });

  it("deux appels simultanés : le second ne clique qu'après la fin du premier", async () => {
    const clicked = listen();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let open = false;
    const { open: opener } = make({
      isModelOpen: () => open,
      sleep: async () => {
        await gate;
        open = true;
      },
    });
    const first = opener(target("assets/a.pdf", 1));
    const second = opener(target("assets/b.pdf", 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.getAttribute("data-href")).toBe("assets/a.pdf?page=1");
    release();
    await Promise.all([first, second]);
    expect(clicked).toHaveLength(2);
    expect(wysiwyg.childElementCount).toBe(0);
  });

  it("attend l'ouverture du modèle (sondage) puis réussit", async () => {
    listen();
    let calls = 0;
    const { open, sleep } = make({ isModelOpen: () => ++calls >= 3 });
    await expect(open(target())).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("refuse un chemin invalide sans toucher au DOM", async () => {
    const clicked = listen();
    const { open } = make();
    await expect(open(target("assets/../secret.pdf"))).rejects.toBeInstanceOf(InvalidPdfPathError);
    await expect(open(target("notes/x.pdf"))).rejects.toBeInstanceOf(InvalidPdfPathError);
    expect(clicked).toHaveLength(0);
    expect(wysiwyg.childElementCount).toBe(0);
  });

  it("refuse une page invalide", async () => {
    const { open } = make();
    await expect(open(target("assets/a.pdf", 0))).rejects.toThrow(RangeError);
    await expect(open(target("assets/a.pdf", 1.5))).rejects.toThrow(RangeError);
  });

  it("aucune injection par un nom de fichier avec guillemets, chevrons ou esperluette", async () => {
    const clicked = listen();
    const name = `assets/a"b<img src=x onerror=alert(1)>&c'.pdf`;
    await make().open(target(name, 3));
    const span = clicked[0]!;
    expect(span.getAttribute("data-href")).toBe(`${name}?page=3`);
    expect(span.attributes).toHaveLength(2);
    expect(wysiwyg.querySelector("img")).toBeNull();
  });
});

describe("test de succès par défaut", () => {
  const model = (transform: string, content: boolean) => {
    const el = document.createElement("div");
    el.id = "model";
    el.style.transform = transform;
    const main = document.createElement("div");
    main.id = "modelMain";
    if (content) main.innerHTML = '<div class="pdfViewer"><div class="page" data-page-number="1"></div></div>';
    el.append(main);
    document.body.append(el);
  };

  it("réussit quand #model est à translateX(0) et #modelMain contient le PDF", async () => {
    model("translateX(0px)", true);
    listen();
    await createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime() })(target());
  });

  it("tolère translateX(0) sans unité", async () => {
    model("translateX(0)", true);
    listen();
    await createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime() })(target());
  });

  it("tolère transform « none » si #model couvre l'écran (rect plein écran)", async () => {
    model("none", true);
    const el = document.getElementById("model")!;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight, x: 0, y: 0, toJSON: () => ({}) });
    listen();
    await createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime() })(target());
  });

  it("refuse transform « none » si #model n'occupe aucune place (rect vide ou hors écran)", async () => {
    model("none", true);
    listen();
    await expect(createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime(), timeoutMs: 5 })(target())).rejects.toBeInstanceOf(NativeModelNotOpenError);
  });

  it("échoue si #model est hors écran", async () => {
    model("translateX(100%)", true);
    listen();
    await expect(
      createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime(), timeoutMs: 5 })(target()),
    ).rejects.toThrow();
  });

  it("échoue si #modelMain est vide ou absent", async () => {
    model("translateX(0px)", false);
    listen();
    await expect(
      createNativeMobilePdfOpener({ getWysiwyg: () => wysiwyg, ...fakeTime(), timeoutMs: 5 })(target()),
    ).rejects.toThrow();
  });
});

describe("accès défensif à window.siyuan", () => {
  it("l'export par défaut lève proprement quand window.siyuan est absent", async () => {
    await expect(openNativeMobilePdf(target())).rejects.toThrow(/éditeur/i);
  });

  it("lit window.siyuan.mobile.editor.protyle.wysiwyg.element", async () => {
    const w = window as unknown as { siyuan?: unknown };
    w.siyuan = { mobile: { editor: { protyle: { wysiwyg: { element: wysiwyg } } } } };
    const clicked = listen();
    try {
      const open = createNativeMobilePdfOpener({ ...fakeTime(), timeoutMs: 5 }); // lecteur par défaut
      await expect(open(target())).rejects.toThrow(/visionneur|modèle/i); // pas de #model en jsdom
      expect(clicked).toHaveLength(1);
    } finally {
      delete w.siyuan;
    }
  });
});
