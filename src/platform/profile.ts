import {
  CROP_RENDER_SCALE,
  DEFAULT_DECODE_CONCURRENCY,
  DEFAULT_MAX_OPEN_DOCUMENTS,
  DEFAULT_RENDER_CONCURRENCY,
  PAGE_MATCHES_MAX_BYTES,
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
  /** Plafond cumulé d'octets des fichiers d'index gardés en mémoire pour les correspondances par page. */
  readonly pageMatchesLimit: number;
  /** Décodages d'index en parallèle au chargement. */
  readonly decodeConcurrency: number;
  /** Ne pas télécharger le PDF en entier : PDF.js ne lit que les plages utiles (mobile). */
  readonly disableAutoFetch: boolean;
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
    pageMatchesLimit: PAGE_MATCHES_MAX_BYTES,
    decodeConcurrency: DEFAULT_DECODE_CONCURRENCY,
    disableAutoFetch: false,
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
    pageMatchesLimit: 16 * 1024 * 1024,
    decodeConcurrency: 1,
    disableAutoFetch: true,
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
