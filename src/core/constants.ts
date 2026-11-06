/** Shared thumbnail constants, ported from crop-worker.js (mirror of search-core constants.rs). */
export const CROP_RENDER_SCALE = 1.5;
export const DEFAULT_CROP_WIDTH = 300;
export const DEFAULT_CROP_HEIGHT = 120;
export const GOODNOTES_YELLOW_CSS = "rgba(255, 226, 0, 0.45)";

/** Classement multi-termes (mirror de search-core constants.rs et matching.rs). */
export const MULTI_TERMS_ALL_MATCHED_BONUS = 5000;
export const MULTI_TERMS_PARTIAL_MATCHED_BONUS = 2000;
/** Nombre de documents consécutifs re-triés après bonus (lot traité par processing.rs). */
export const RERANK_WINDOW = 15;
/** Pages par document dont on mesure la proximité des mots (MAX_MATCHING_PAGES_PER_DOC). */
export const PROXIMITY_PAGES = 5;
/** Écart horizontal maximal (exclu) entre deux mots d'une même occurrence, en points. */
export const OCCURRENCE_MAX_GAP_PT = 25;
/** Part minimale de la plus petite hauteur qui doit se chevaucher pour être sur la même ligne visuelle. */
export const SAME_LINE_OVERLAP = 0.6;
/** Largeur de page supposée (A4 en points) pour convertir les fractions de page en points. */
export const ASSUMED_PAGE_WIDTH_PT = 595;
/** Hauteur de page supposée (A4 en points) : repli pour les index v1 sans taille de page. */
export const ASSUMED_PAGE_HEIGHT_PT = 842;

/**
 * Bonus de police du moteur DocSeeker (search-core) : (meilleure taille - seuil) * multiplicateur, plafonné.
 * La « taille de police » y est en réalité la hauteur de la boîte du mot en points (arrondie à 0,1).
 */
export const FONT_SIZE_BONUS_THRESHOLD = 10;
export const FONT_SIZE_BONUS_MULTIPLIER = 25;
export const FONT_SIZE_BONUS_MAX = 400;
