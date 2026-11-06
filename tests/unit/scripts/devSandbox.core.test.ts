import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- module .mjs sans types
import * as core from "../../../scripts/lib/sandboxCore.mjs";
// @ts-expect-error -- module .mjs sans types
import { makeCorpus } from "../../../scripts/lib/testCorpus.mjs";

const fresh = (): { root: string; home: string } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsx-core-")));
  const home = join(root, "home");
  mkdirSync(join(home, "SiYuan", "conf"), { recursive: true });
  writeFileSync(join(home, "SiYuan", "conf", "conf.json"), "{}");
  return { root, home };
};

describe("parseArgs", () => {
  it("lit la commande et les valeurs par défaut", () => {
    const a = core.parseArgs(["start"]);
    expect(a).toMatchObject({ command: "start", port: 6807, pdfs: 8 });
    expect(a.dir).toMatch(/docseeker-sandbox$/);
  });
  it("lit --dir, --port et --pdfs, avec = ou espace", () => {
    expect(core.parseArgs(["start", "--dir", "/x/y", "--port", "7001", "--pdfs=3"])).toMatchObject({ dir: "/x/y", port: 7001, pdfs: 3 });
  });
  it("refuse commande inconnue, absente, option inconnue, valeurs invalides", () => {
    expect(() => core.parseArgs([])).toThrow(/commande/i);
    expect(() => core.parseArgs(["boom"])).toThrow(/commande/i);
    expect(() => core.parseArgs(["start", "--nope"])).toThrow(/option/i);
    expect(() => core.parseArgs(["start", "--port"])).toThrow(/--port/);
    expect(() => core.parseArgs(["start", "--port", "abc"])).toThrow(/port/i);
    expect(() => core.parseArgs(["start", "--port", "80"])).toThrow(/port/i);
    expect(() => core.parseArgs(["start", "--port", "70000"])).toThrow(/port/i);
    expect(() => core.parseArgs(["start", "--pdfs", "0"])).toThrow(/pdfs/i);
    expect(() => core.parseArgs(["start", "--pdfs", "1.5"])).toThrow(/pdfs/i);
  });
});

describe("assertPortAllowed", () => {
  it("refuse 6806 et 55165 (SiYuan réel)", () => {
    expect(() => core.assertPortAllowed(6806)).toThrow(/6806/);
    expect(() => core.assertPortAllowed(55165)).toThrow(/55165/);
    expect(() => core.assertPortAllowed(6807)).not.toThrow();
  });
});

describe("assertSandboxDirAllowed", () => {
  it("accepte un dossier neuf (inexistant) hors SiYuan", () => {
    const { root, home } = fresh();
    expect(() => core.assertSandboxDirAllowed(join(root, "sb"), { home })).not.toThrow();
  });
  it("refuse ~/SiYuan, ses sous-dossiers et le home lui-même", () => {
    const { home } = fresh();
    expect(() => core.assertSandboxDirAllowed(join(home, "SiYuan"), { home })).toThrow(/SiYuan/);
    expect(() => core.assertSandboxDirAllowed(join(home, "SiYuan", "data", "x"), { home })).toThrow(/SiYuan/);
    expect(() => core.assertSandboxDirAllowed(home, { home })).toThrow(/SiYuan/);
  });
  it("refuse un dossier qui contiendrait ~/SiYuan", () => {
    const { root, home } = fresh();
    expect(() => core.assertSandboxDirAllowed(root, { home })).toThrow(/SiYuan/);
  });
  it("refuse un lien symbolique qui pointe dans ~/SiYuan, même pour un enfant non créé", () => {
    const { root, home } = fresh();
    symlinkSync(join(home, "SiYuan"), join(root, "lien"));
    expect(() => core.assertSandboxDirAllowed(join(root, "lien"), { home })).toThrow(/SiYuan/);
    expect(() => core.assertSandboxDirAllowed(join(root, "lien", "nouveau"), { home })).toThrow(/SiYuan/);
  });
  it("refuse un dossier dans un autre workspace SiYuan (conf/conf.json dans un ancêtre)", () => {
    const { root, home } = fresh();
    const other = join(root, "autre-ws");
    mkdirSync(join(other, "conf"), { recursive: true });
    writeFileSync(join(other, "conf", "conf.json"), "{}");
    expect(() => core.assertSandboxDirAllowed(join(other, "data", "sb"), { home })).toThrow(/workspace/i);
    expect(() => core.assertSandboxDirAllowed(other, { home })).toThrow(/workspace/i);
  });
  it("refuse un dossier non vide sans marqueur, accepte avec marqueur", () => {
    const { root, home } = fresh();
    const d = join(root, "docs");
    mkdirSync(d);
    writeFileSync(join(d, "important.txt"), "x");
    expect(() => core.assertSandboxDirAllowed(d, { home })).toThrow(/marqueur|vide/i);
    writeFileSync(join(d, core.MARKER), "docseeker-sandbox\n");
    expect(() => core.assertSandboxDirAllowed(d, { home })).not.toThrow();
  });
  it("refuse un chemin vide ou relatif", () => {
    const { home } = fresh();
    expect(() => core.assertSandboxDirAllowed("", { home })).toThrow(/chemin/i);
    expect(() => core.assertSandboxDirAllowed("rel/x", { home })).toThrow(/absolu/i);
  });
});

describe("assertDeletable", () => {
  it("exige le marqueur", () => {
    const { root, home } = fresh();
    const d = join(root, "sb");
    mkdirSync(d);
    expect(() => core.assertDeletable(d, { home })).toThrow(/marqueur/i);
    writeFileSync(join(d, core.MARKER), "x");
    expect(() => core.assertDeletable(d, { home })).not.toThrow();
  });
  it("refuse un dossier marqué qui est (ou contient) ~/SiYuan", () => {
    const { home } = fresh();
    writeFileSync(join(home, "SiYuan", core.MARKER), "x");
    expect(() => core.assertDeletable(join(home, "SiYuan"), { home })).toThrow(/SiYuan/);
  });
});

describe("kernelArgs", () => {
  it("construit les arguments du noyau jetable", () => {
    expect(core.kernelArgs({ port: 6807, workspace: "/w", homeDir: "/h" })).toEqual([
      "serve", "--port", "6807", "--workspace", "/w", "--home-dir", "/h", "--accessAuthCode", "", "--lang", "fr_FR",
    ]);
  });
  it("refuse un port interdit", () => {
    expect(() => core.kernelArgs({ port: 6806, workspace: "/w", homeDir: "/h" })).toThrow(/6806/);
  });
});

describe("isSandboxKernelCommand", () => {
  const ws = "/tmp/sb/workspace";
  it("reconnaît le noyau avec ce workspace", () => {
    expect(core.isSandboxKernelCommand(`/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel serve --port 6807 --workspace ${ws} --home-dir /tmp/sb/home`, ws)).toBe(true);
  });
  it("refuse un autre workspace, y compris un préfixe, et un autre exécutable", () => {
    expect(core.isSandboxKernelCommand(`/x/SiYuan-Kernel serve --workspace ${ws}-bis --home-dir /h`, ws)).toBe(false);
    expect(core.isSandboxKernelCommand("/x/SiYuan-Kernel serve --port 55165 --workspace /Users/f/SiYuan", ws)).toBe(false);
    expect(core.isSandboxKernelCommand(`/bin/sleep --workspace ${ws}`, ws)).toBe(false);
    expect(core.isSandboxKernelCommand("", ws)).toBe(false);
  });
  it("accepte un workspace en fin de ligne", () => {
    expect(core.isSandboxKernelCommand(`/x/SiYuan-Kernel serve --workspace ${ws}`, ws)).toBe(true);
  });
});

describe("petals.json", () => {
  const manifest = { name: "siyuan-docseeker", version: "0.2.0", displayName: { default: "DocSeeker", fr_FR: "DocSeeker Fr" } };
  it("active le plugin au format du noyau", () => {
    const list = core.buildPetals(manifest, []);
    expect(list).toEqual([
      {
        name: "siyuan-docseeker", displayName: "DocSeeker Fr", version: "0.2.0", enabled: true,
        incompatible: false, disabledInPublish: false, userDisabledInPublish: false, disallowInstall: false,
        js: "", css: "", i18n: null, kernel: { js: "", existed: false, incompatible: true },
      },
    ]);
  });
  it("remplace l'entrée existante et conserve les autres", () => {
    const other = { name: "autre", enabled: false };
    const list = core.buildPetals(manifest, [other, { name: "siyuan-docseeker", enabled: false }]);
    expect(list.map((p: { name: string }) => p.name)).toEqual(["autre", "siyuan-docseeker"]);
    expect(list[1].enabled).toBe(true);
  });
  it("retombe sur displayName.default, puis sur name", () => {
    expect(core.buildPetals({ name: "a", version: "1", displayName: { default: "D" } }, [])[0].displayName).toBe("D");
    expect(core.buildPetals({ name: "a", version: "1" }, [])[0].displayName).toBe("a");
  });
  it("refuse un manifeste sans name ou une liste invalide", () => {
    expect(() => core.buildPetals({ version: "1" }, [])).toThrow(/name/);
    expect(() => core.buildPetals(manifest, {})).toThrow(/liste/i);
  });
});

describe("bundleFiles", () => {
  it("liste ce qu'il faut installer", () => {
    expect(core.BUNDLE_ENTRIES).toEqual(["index.js", "plugin.json", "i18n", "icon.png", "README.md", "README_en_US.md"]);
  });
});

describe("makeCorpus", () => {
  it("produit n PDF déterministes avec sous-dossiers, pages multiples et un paysage", () => {
    const c = makeCorpus(8);
    expect(c).toHaveLength(8);
    expect(new Set(c.map((f: { relPath: string }) => f.relPath)).size).toBe(8);
    for (const f of c) {
      expect(f.relPath).toMatch(/\.pdf$/);
      expect(f.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
    expect(c.some((f: { relPath: string }) => f.relPath.includes("/"))).toBe(true);
    const text = (f: { bytes: Buffer }) => f.bytes.toString("latin1");
    expect(c.some((f: { bytes: Buffer }) => /\/Count [2-9]/.test(text(f)))).toBe(true);
    expect(c.some((f: { bytes: Buffer }) => /MediaBox \[0 0 842 595\]/.test(text(f)))).toBe(true);
    expect(new Set(c.flatMap((f: { bytes: Buffer }) => [...text(f).matchAll(/\/F1 (\d+) Tf/g)].map((m) => m[1]))).size).toBeGreaterThanOrEqual(3);
    expect(c.filter((f: { bytes: Buffer }) => text(f).includes("contrat")).length).toBeGreaterThanOrEqual(2);
    expect(makeCorpus(8)[3].bytes.equals(c[3].bytes)).toBe(true);
  });
  it("gère n petit et n grand sans doublon de chemin", () => {
    expect(makeCorpus(1)).toHaveLength(1);
    const big = makeCorpus(40);
    expect(big).toHaveLength(40);
    expect(new Set(big.map((f: { relPath: string }) => f.relPath)).size).toBe(40);
  });
  it("refuse n invalide", () => {
    expect(() => makeCorpus(0)).toThrow(/pdfs/i);
  });
});
