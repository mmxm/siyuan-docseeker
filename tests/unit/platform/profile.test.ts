import { describe, expect, it } from "vitest";
import {
  CROP_RENDER_SCALE,
  DESKTOP_MAX_OPEN_DOCUMENTS,
  DESKTOP_RENDER_CONCURRENCY,
  THUMBNAIL_CACHE_MAX_BYTES,
  PAGE_MATCHES_MAX_BYTES,
  THUMBNAIL_CACHE_MAX_ENTRIES,
} from "../../../src/core/constants";
import { FRONTENDS } from "../../../src/platform/frontend";
import { applySettingsOverride, desktopProfile, mobileProfile, profileFor } from "../../../src/platform/profile";
import { DEFAULT_SETTINGS } from "../../../src/settings";

describe("desktopProfile", () => {
  it("reprend les constantes importées, sans copie de valeurs", () => {
    const p = desktopProfile();
    expect(p.renderConcurrency).toBe(DESKTOP_RENDER_CONCURRENCY);
    expect(p.maxOpenDocuments).toBe(DESKTOP_MAX_OPEN_DOCUMENTS);
    expect(p.cropScale).toBe(CROP_RENDER_SCALE);
    expect(p.thumbnailCache).toEqual({ maxEntries: THUMBNAIL_CACHE_MAX_ENTRIES, maxBytes: THUMBNAIL_CACHE_MAX_BYTES });
  });

  it("garde les valeurs historiques du bureau", () => {
    const p = desktopProfile();
    expect([p.renderConcurrency, p.maxOpenDocuments, p.cropScale]).toEqual([4, 6, 1.5]);
    expect(p.thumbnailCache).toEqual({ maxEntries: 2000, maxBytes: 64 * 1024 * 1024 });
    expect(p.readOnly).toBe(false);
    expect(p.lazyIndexLoad).toBe(false);
  });

  it("ne modifie pas les réglages", () => {
    expect(applySettingsOverride(DEFAULT_SETTINGS, desktopProfile())).toEqual(DEFAULT_SETTINGS);
  });

  it("garde les plafonds historiques de correspondances, de décodage et de téléchargement (E3)", () => {
    const p = desktopProfile();
    expect(p.pageMatchesLimit).toBe(PAGE_MATCHES_MAX_BYTES);
    expect(p.pageMatchesLimit).toBe(64 * 1024 * 1024);
    expect(p.decodeConcurrency).toBe(2);
    expect(p.renderConcurrency).toBe(4);
    expect(p.workersPerDocument).toBe(3);
    expect(p.maxOpenDocuments).toBe(6);
  });

  it("n'impose aucun plafond de canevas (paramètre non passé à PDF.js)", () => {
    expect(desktopProfile().canvasMaxAreaInBytes).toBeUndefined();
    expect("canvasMaxAreaInBytes" in desktopProfile() && desktopProfile().canvasMaxAreaInBytes !== undefined).toBe(false);
  });
});

describe("mobileProfile", () => {
  it("est en lecture seule avec des plafonds réduits", () => {
    const p = mobileProfile();
    expect(p.readOnly).toBe(true);
    expect(p.cropScale).toBe(1.0);
    expect(p.thumbnailCache).toEqual({ maxEntries: 500, maxBytes: 16 * 1024 * 1024 });
    expect(p.lazyIndexLoad).toBe(true);
  });

  it("réduit correspondances, décodage et téléchargement (E3)", () => {
    const p = mobileProfile();
    expect(p.pageMatchesLimit).toBe(16 * 1024 * 1024);
    expect(p.decodeConcurrency).toBe(1);
    expect(p.renderConcurrency).toBe(2);
    expect(p.workersPerDocument).toBe(2);
    expect(p.maxOpenDocuments).toBe(2);
  });

  it("plafonne le canevas à 8 M pixels x 4 octets (limite iOS ~16,7 M px)", () => {
    const v = mobileProfile().canvasMaxAreaInBytes;
    expect(v).toBe(32_000_000);
    expect(Number.isInteger(v) && v! > 0).toBe(true);
  });

  it("surcharge autoIndex et openMode sans muter l'original", () => {
    const base = { ...DEFAULT_SETTINGS, autoIndex: true, openMode: "tab" as const };
    const frozen = Object.freeze(base);
    const eff = applySettingsOverride(frozen, mobileProfile());
    expect(eff.autoIndex).toBe(false);
    expect(eff.openMode).toBe("dialog");
    expect(eff.history).toBe(frozen.history);
    expect(frozen.autoIndex).toBe(true);
    expect(frozen.openMode).toBe("tab");
  });
});

describe("profileFor", () => {
  it.each(FRONTENDS)("%s", (frontend) => {
    const mobile = frontend === "mobile" || frontend === "browser-mobile";
    expect(profileFor(frontend)).toEqual(mobile ? mobileProfile() : desktopProfile());
  });
});

describe("profileFor : table littérale, indépendante du code testé", () => {
  it.each([
    ["desktop", false],
    ["desktop-window", false],
    ["browser-desktop", false],
    ["mobile", true],
    ["browser-mobile", true],
  ] as const)("%s : lecture seule = %s", (frontend, readOnly) => {
    expect(profileFor(frontend).readOnly).toBe(readOnly);
  });

  it("chaque appel renvoie un objet neuf (pas d'état partagé)", () => {
    const a = desktopProfile();
    const b = desktopProfile();
    expect(a).not.toBe(b);
    expect(a.thumbnailCache).not.toBe(b.thumbnailCache);
  });
});

describe("entrée mobile (E4) : champs du profil", () => {
  it("bureau : fenêtre flottante classique, onglets et réglages natifs (comportement actuel)", () => {
    const p = desktopProfile();
    expect(p.floatingLayout).toBe("window");
    expect(p.canOpenTab).toBe(true);
    expect(p.settingsInDialog).toBe(false);
  });

  it("mobile : dialogue plein écran, pas d'onglet (openTab est un stub), réglages dans un dialogue", () => {
    const p = mobileProfile();
    expect(p.floatingLayout).toBe("fullscreen");
    expect(p.canOpenTab).toBe(false);
    expect(p.settingsInDialog).toBe(true);
  });

  it.each(FRONTENDS)("%s : table littérale", (frontend) => {
    const mobile = frontend === "mobile" || frontend === "browser-mobile";
    const p = profileFor(frontend);
    expect([p.floatingLayout, p.canOpenTab, p.settingsInDialog]).toEqual(mobile ? ["fullscreen", false, true] : ["window", true, false]);
  });
});
