import { describe, expect, it } from "vitest";
import {
  CROP_RENDER_SCALE,
  DEFAULT_MAX_OPEN_DOCUMENTS,
  DEFAULT_RENDER_CONCURRENCY,
  THUMBNAIL_CACHE_MAX_BYTES,
  THUMBNAIL_CACHE_MAX_ENTRIES,
} from "../../../src/core/constants";
import { FRONTENDS } from "../../../src/platform/frontend";
import { applySettingsOverride, desktopProfile, mobileProfile, profileFor } from "../../../src/platform/profile";
import { DEFAULT_SETTINGS } from "../../../src/settings";

describe("desktopProfile", () => {
  it("reprend les constantes importées, sans copie de valeurs", () => {
    const p = desktopProfile();
    expect(p.renderConcurrency).toBe(DEFAULT_RENDER_CONCURRENCY);
    expect(p.maxOpenDocuments).toBe(DEFAULT_MAX_OPEN_DOCUMENTS);
    expect(p.cropScale).toBe(CROP_RENDER_SCALE);
    expect(p.thumbnailCache).toEqual({ maxEntries: THUMBNAIL_CACHE_MAX_ENTRIES, maxBytes: THUMBNAIL_CACHE_MAX_BYTES });
  });

  it("garde les valeurs historiques du bureau", () => {
    const p = desktopProfile();
    expect([p.renderConcurrency, p.maxOpenDocuments, p.cropScale]).toEqual([2, 3, 1.5]);
    expect(p.thumbnailCache).toEqual({ maxEntries: 2000, maxBytes: 64 * 1024 * 1024 });
    expect(p.readOnly).toBe(false);
    expect(p.lazyIndexLoad).toBe(false);
  });

  it("ne modifie pas les réglages", () => {
    expect(applySettingsOverride(DEFAULT_SETTINGS, desktopProfile())).toEqual(DEFAULT_SETTINGS);
  });
});

describe("mobileProfile", () => {
  it("est en lecture seule avec des plafonds réduits", () => {
    const p = mobileProfile();
    expect(p.readOnly).toBe(true);
    expect(p.renderConcurrency).toBe(1);
    expect(p.maxOpenDocuments).toBe(1);
    expect(p.cropScale).toBe(1.0);
    expect(p.thumbnailCache).toEqual({ maxEntries: 500, maxBytes: 16 * 1024 * 1024 });
    expect(p.lazyIndexLoad).toBe(true);
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
