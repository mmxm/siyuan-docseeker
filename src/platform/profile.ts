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
  /**
   * Aire maximale (en octets, 4 par pixel) d'un canevas d'image pour PDF.js (`getDocument`) ; PDF.js sous-échantillonne
   * les images plus grandes. Absent (bureau) : le paramètre n'est pas passé, comportement inchangé.
   */
  readonly canvasMaxAreaInBytes?: number;
  /** Index chargé à la première ouverture de la recherche plutôt qu'au démarrage. */
  readonly lazyIndexLoad: boolean;
  /** Disposition de la fenêtre de recherche : fenêtre flottante (bureau) ou plein écran (mobile). */
  readonly floatingLayout: "window" | "fullscreen";
  /** Faux sur mobile : `openTab` y est un stub qui ne fait rien (aucun onglet, aucun Alt+clic, aucun transfert vers un onglet). */
  readonly canOpenTab: boolean;
  /** Vrai sur mobile : les réglages s'ouvrent dans un dialogue du plugin plutôt que par `openSetting` (chemin non garanti). */
  readonly settingsInDialog: boolean;
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
    floatingLayout: "window",
    canOpenTab: true,
    settingsInDialog: false,
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
    // 8 M pixels x 4 octets : marge sous la limite d'un canevas iOS Safari (~16,7 M px, au-delà le dessin échoue
    // silencieusement et la vignette reste blanche) et mémoire limitée du mobile.
    canvasMaxAreaInBytes: 8_000_000 * 4,
    lazyIndexLoad: true,
    floatingLayout: "fullscreen",
    canOpenTab: false,
    settingsInDialog: true,
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
