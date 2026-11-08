import {
  CROP_RENDER_SCALE,
  DEFAULT_MAX_OPEN_DOCUMENTS,
  DEFAULT_RENDER_CONCURRENCY,
  THUMBNAIL_CACHE_MAX_BYTES,
  THUMBNAIL_CACHE_MAX_ENTRIES,
} from "../core/constants";
import type { DocSeekerSettings, OpenMode } from "../settings";
import { isMobileFrontend, type Frontend } from "./frontend";

/** Plafonds et comportements qui dépendent de la plateforme. Le profil bureau reprend les constantes actuelles. */
export interface PlatformProfile {
  /** Lecture seule : ni indexation, ni écriture d'index (l'index est construit sur ordinateur). */
  readonly readOnly: boolean;
  readonly renderConcurrency: number;
  readonly maxOpenDocuments: number;
  readonly cropScale: number;
  readonly thumbnailCache: { readonly maxEntries: number; readonly maxBytes: number };
  /** Index chargé à la première ouverture de la recherche plutôt qu'au démarrage. */
  readonly lazyIndexLoad: boolean;
  /** Valeurs imposées à la lecture des réglages (jamais écrites dans `settings.json`, qui est synchronisé). */
  readonly settingsOverride: { readonly autoIndex?: boolean; readonly openMode?: OpenMode };
}

export function desktopProfile(): PlatformProfile {
  return {
    readOnly: false,
    renderConcurrency: DEFAULT_RENDER_CONCURRENCY,
    maxOpenDocuments: DEFAULT_MAX_OPEN_DOCUMENTS,
    cropScale: CROP_RENDER_SCALE,
    thumbnailCache: { maxEntries: THUMBNAIL_CACHE_MAX_ENTRIES, maxBytes: THUMBNAIL_CACHE_MAX_BYTES },
    lazyIndexLoad: false,
    settingsOverride: {},
  };
}

export function mobileProfile(): PlatformProfile {
  return {
    readOnly: true,
    renderConcurrency: 1,
    maxOpenDocuments: 1,
    cropScale: 1.0,
    thumbnailCache: { maxEntries: 500, maxBytes: 16 * 1024 * 1024 },
    lazyIndexLoad: true,
    settingsOverride: { autoIndex: false, openMode: "dialog" },
  };
}

export function profileFor(frontend: Frontend): PlatformProfile {
  return isMobileFrontend(frontend) ? mobileProfile() : desktopProfile();
}

/** Réglages effectifs : copie avec les surcharges du profil. L'original (et le fichier) restent intacts. */
export function applySettingsOverride(settings: DocSeekerSettings, profile: PlatformProfile): DocSeekerSettings {
  return { ...settings, ...profile.settingsOverride };
}
