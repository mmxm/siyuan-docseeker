/** CSS de l'onglet de recherche (variables de thème SiYuan uniquement). */
export const SEARCH_STYLE_ID = "docseeker-search-style";

export const SEARCH_CSS = `
:root { --docseeker-hit: 32px; --docseeker-hit-compact: 24px; /* cible tactile minimale : 44px sous pointer: coarse (bloc plus bas) */ }
.docseeker-search { --docseeker-thumb-width: 96px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 6px; gap: 4px; color: var(--b3-theme-on-background); background: var(--b3-theme-background); }
.docseeker-search input[type="search"] { width: 100%; box-sizing: border-box; min-height: var(--docseeker-hit); }
.docseeker-search input[type="search"]:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-search-box { position: relative; display: flex; align-items: stretch; min-width: 0; }
.docseeker-search-box input[type="search"] { flex: 1 1 auto; min-width: 0; padding-left: 44px; padding-right: var(--docseeker-hit); }
.docseeker-search input[type="search"]::-webkit-search-cancel-button { display: none; -webkit-appearance: none; }
.docseeker-search-box .docseeker-history-icon, .docseeker-search-box .docseeker-clear { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; min-width: var(--docseeker-hit); min-height: var(--docseeker-hit); padding: 0; margin: 0; background: transparent; border: 0; border-radius: var(--b3-border-radius, 4px); color: var(--b3-theme-on-surface); cursor: pointer; }
.docseeker-search-box .docseeker-history-icon { left: 0; min-width: 44px; gap: 2px; }
.docseeker-search-box .docseeker-clear { right: 0; }
.docseeker-search-box .docseeker-history-icon:focus-visible, .docseeker-search-box .docseeker-clear:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-search-box .docseeker-clear[hidden] { display: none; }
.docseeker-search-box .docseeker-clear svg { position: static; }
.docseeker-search-box svg { height: 16px; width: 16px; flex: none; }
.docseeker-search-box .search__arrowdown { height: 12px; width: 12px; }
.docseeker-icons { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; min-width: 0; min-height: var(--docseeker-hit-compact); padding: 0; box-sizing: border-box; }
.docseeker-icons .block__icon { display: flex; align-items: center; justify-content: center; min-width: var(--docseeker-hit); min-height: var(--docseeker-hit-compact); box-sizing: border-box; margin: 0; padding: 4px; background: transparent; border: 0; color: var(--b3-theme-on-surface); cursor: pointer; font: inherit; }
.docseeker-icons .block__icon[aria-busy="true"] { opacity: 0.6; cursor: progress; }
.docseeker-icons .block__icon:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-icons .block__icon[aria-disabled="true"] { opacity: 0.38; cursor: not-allowed; }
.docseeker-icons .block__icon[hidden] { display: none; }
.docseeker-icons .block__icon svg { height: 16px; width: 16px; }
.docseeker-count { font-size: 12px; margin-right: 8px; }
.docseeker-count[hidden] { display: none; }
.docseeker-icons .search__path { flex: 0 1 auto; min-width: 0; max-width: 100%; padding-right: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.docseeker-icons .search__path[hidden] { display: none; }
.docseeker-icons .search__rmpath { cursor: pointer; }
.docseeker-icons .search__rmpath:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-icons .fn__space[hidden] { display: none; }
.docseeker-filter-field input { width: 100%; box-sizing: border-box; min-height: var(--docseeker-hit); }
.docseeker-floating-body { box-sizing: border-box; padding: 8px 16px 16px; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.docseeker-floating-body > .docseeker-search { flex: 1 1 auto; min-height: 0; height: auto; }
.docseeker-tab { box-sizing: border-box; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 16px; }
.docseeker-tab-search { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.docseeker-tab-search > .docseeker-search { flex: 1 1 auto; min-height: 0; height: auto; }
.docseeker-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.docseeker-filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 8px; padding: 4px 0 8px; align-items: end; }
.docseeker-filter-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.docseeker-filter-field label { font-size: 12px; color: var(--b3-theme-on-surface); overflow-wrap: anywhere; }

.docseeker-filter-field input:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-field [aria-invalid="true"] { border-color: var(--b3-theme-error); box-shadow: 0 0 0 1px var(--b3-theme-error); }
.docseeker-filter-error { margin: 0; font-size: 12px; color: var(--b3-theme-error); overflow-wrap: anywhere; }
.docseeker-filter-error[hidden] { display: none; }
.docseeker-search .search__header { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; min-width: 0; }
.docseeker-search .search__header .b3-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.docseeker-search .search__header .b3-chips.fn__none { display: none; }
.docseeker-search .search__header .b3-chip { max-width: 100%; overflow-wrap: anywhere; }
.docseeker-search .search__header button { min-height: 24px; padding-top: 0; padding-bottom: 0; box-sizing: border-box; }
.docseeker-search .search__header .b3-chip:focus-visible, .docseeker-search .search__header button:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-actions { display: flex; align-items: flex-end; }
.docseeker-filter-reset, .docseeker-reset-filters { min-height: var(--docseeker-hit-compact); min-width: var(--docseeker-hit); }
.docseeker-filter-reset:focus-visible, .docseeker-reset-filters:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-reset[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.docseeker-reset-filters[hidden] { display: none; }
.docseeker-status { font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-status:empty { display: none; }
.docseeker-index-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.docseeker-index-activity:empty { display: none; }
.docseeker-index-activity { font-size: 12px; color: var(--b3-theme-on-surface); white-space: normal; overflow-wrap: anywhere; }
.docseeker-index-count { font-size: 12px; color: var(--b3-theme-on-surface); opacity: 0.8; }
.docseeker-index-settings { min-height: var(--docseeker-hit-compact); min-width: var(--docseeker-hit); }
.docseeker-alert { font-size: 12px; color: var(--b3-theme-error); }
.docseeker-alert:empty { display: none; }
.docseeker-message { font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-message:empty { display: none; }
.docseeker-actions:empty { display: none; }
.docseeker-open-settings { min-height: var(--docseeker-hit); min-width: var(--docseeker-hit); }
.docseeker-open-settings:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.config-item:has(.docseeker-setting-action) .b3-label__text { word-break: normal; overflow-wrap: break-word; }
.docseeker-setting-action { width: 100%; box-sizing: border-box; }
.docseeker-setting-action > * + * { margin-top: 8px; }
.docseeker-text-block { white-space: pre-wrap; -webkit-user-select: text; user-select: text; }
.docseeker-setting-action pre { margin: 0; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
.docseeker-setting-action pre:empty { display: none; }
.docseeker-action { width: auto; min-height: var(--docseeker-hit); min-width: var(--docseeker-hit); }
.docseeker-action:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-action[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.docseeker-log { width: 100%; box-sizing: border-box; max-height: 240px; overflow: auto; overflow-wrap: anywhere; padding: 4px; border: 1px solid var(--b3-border-color); }
.docseeker-log:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1 1 auto; min-height: 0; -webkit-overflow-scrolling: touch; }
.docseeker-floating-body--fullscreen .docseeker-list { overscroll-behavior: contain; }
.docseeker-doc { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--b3-border-color); }
.docseeker-doc > * { min-width: 0; }
.docseeker-doc > .docseeker-cards, .docseeker-doc > .docseeker-more-actions, .docseeker-doc > .docseeker-doc-fullpath { flex: 1 1 100%; }
.docseeker-doc-heading { flex: 0 1 auto; margin: 0; font-size: inherit; font-weight: normal; line-height: 1.25; }
.docseeker-doc-title { font-size: 14px; font-weight: bold; overflow-wrap: anywhere; }
.docseeker-doc-count { margin-left: 2px; font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-doc-path { flex: 1 1 0; font-size: 12px; line-height: 1.25; color: var(--b3-theme-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.docseeker-doc-path[hidden] { display: none; }
.docseeker-doc-path-text { direction: ltr; unicode-bidi: bidi-override; }
.docseeker-more-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.docseeker-more, .docseeker-less { min-height: var(--docseeker-hit-compact); padding: 0 8px; font-size: 12px; }
.docseeker-more[hidden], .docseeker-less[hidden] { display: none; }
.docseeker-index-settings[hidden] { display: none; }
.docseeker-truncated { align-self: center; font-size: 12px; }
.docseeker-truncated[hidden] { display: none; }
.docseeker-more:focus-visible, .docseeker-less:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-cards { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.docseeker-card { display: flex; flex-direction: column; align-items: center; gap: 0; padding: 2px; min-height: var(--docseeker-hit); min-width: var(--docseeker-hit); cursor: pointer; background: transparent; color: inherit; border: 1px solid transparent; border-radius: var(--b3-border-radius, 4px); }
.docseeker-card:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; border-color: var(--b3-theme-primary); }
.docseeker-thumb { position: relative; width: var(--docseeker-thumb-width); aspect-ratio: 3 / 4; overflow: hidden; background: #fff; border: 1px solid var(--b3-border-color); }
.docseeker-thumb canvas, .docseeker-thumb img { display: block; width: 100%; height: 100%; object-fit: fill; }
.docseeker-thumb-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; text-align: center; font-size: 12px; color: #444; }
.docseeker-thumb mark, .docseeker-highlight { background: rgba(255, 220, 0, 0.4); }
.docseeker-list--flat { display: flex; flex-wrap: wrap; gap: 8px; }
.docseeker-flat-item { min-width: 0; }
.docseeker-flat-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.docseeker-flat-footer[hidden], .docseeker-flat-more[hidden] { display: none; }
.docseeker-flat-more { min-height: var(--docseeker-hit-compact); min-width: var(--docseeker-hit); padding: 0 8px; font-size: 12px; }
.docseeker-flat-more:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-card--flat { max-width: calc(var(--docseeker-thumb-width) + 16px); /* vignette + padding 2 x 2px + bord 2 x 1px, arrondi */ }
.docseeker-card-title { max-width: 100%; font-size: 12px; font-weight: bold; text-align: center; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.docseeker-card-page { font-size: 12px; line-height: 1.2; color: var(--b3-theme-on-surface); }
.docseeker-settings-section { padding: 8px 16px; color: var(--b3-theme-on-background); }
.docseeker-settings-title { font-weight: bold; }
.docseeker-viewer { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 8px; gap: 8px; color: var(--b3-theme-on-background); background: var(--b3-theme-background); }
.docseeker-viewer-stage { flex: 1 1 auto; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; background: var(--b3-theme-surface); border: 1px solid var(--b3-border-color); }
.docseeker-viewer-page { position: relative; width: 100%; }
.docseeker-viewer-image { display: block; width: 100%; height: 100%; object-fit: fill; }
.docseeker-viewer-page .docseeker-highlight { mix-blend-mode: multiply; }
.docseeker-viewer-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px; }
.docseeker-viewer-message, .docseeker-viewer-note { padding: 8px; font-size: 14px; text-align: center; overflow-wrap: anywhere; color: var(--b3-theme-on-surface); }
.docseeker-viewer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.docseeker-viewer-label { flex: 1 1 auto; text-align: center; font-size: 14px; color: var(--b3-theme-on-background); }
.docseeker-viewer-button { min-height: 48px; min-width: 48px; box-sizing: border-box; padding: 0 16px; font: inherit; cursor: pointer; color: var(--b3-theme-on-background); background: var(--b3-theme-surface); border: 1px solid var(--b3-border-color); border-radius: var(--b3-border-radius, 4px); }
.docseeker-viewer-button:disabled { opacity: 0.5; cursor: default; }
.docseeker-viewer-button:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-viewer-close { width: 100%; }
.b3-dialog__container.docseeker-fullscreen { align-self: flex-start; /* .b3-dialog centre ses enfants : sans cela, clavier iOS ouvert, la moitié haute passe dessous */ box-sizing: border-box; height: 100vh; height: 100dvh; height: var(--docseeker-vvh, 100dvh); max-height: 100vh; max-height: 100dvh; max-height: var(--docseeker-vvh, 100dvh); transform: translateY(var(--docseeker-vv-top, 0px)); padding-top: env(safe-area-inset-top, 0px); padding-right: env(safe-area-inset-right, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); padding-left: env(safe-area-inset-left, 0px); }
.b3-dialog__container.docseeker-fullscreen[data-docseeker-keyboard] { padding-bottom: 0; /* clavier ouvert (posé par trackVisualViewport) : la zone sûre du bas est sous le clavier */ }
.b3-dialog__container.docseeker-fullscreen[data-docseeker-keyboard] .docseeker-floating-bar { display: none; }
.docseeker-floating-body--fullscreen { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.docseeker-floating-body--fullscreen > .docseeker-search { flex: 1 1 auto; min-height: 0; height: auto; }
.docseeker-floating-bar { flex: none; padding: 8px 0 0; background: var(--b3-theme-background); border-top: 1px solid var(--b3-border-color); }
.docseeker-floating-close { width: 100%; min-height: 48px; box-sizing: border-box; font: inherit; cursor: pointer; color: var(--b3-theme-on-background); background: var(--b3-theme-surface); border: 1px solid var(--b3-border-color); border-radius: var(--b3-border-radius, 4px); }
.docseeker-floating-close:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-doc-fullpath { display: none; }
.docseeker-doc-fullpath[hidden] { display: none; }
.docseeker-card, .docseeker-icons .block__icon, .docseeker-more, .docseeker-less, .docseeker-action, .docseeker-open-settings, .docseeker-index-settings, .docseeker-flat-more, .docseeker-viewer-button, .docseeker-floating-close, .docseeker-search-box .docseeker-history-icon, .docseeker-search-box .docseeker-clear { touch-action: manipulation; }
@media (hover: hover) {
  .docseeker-search-box .docseeker-history-icon:hover, .docseeker-search-box .docseeker-clear:hover { color: var(--b3-theme-on-background); }
  .docseeker-card:hover { border-color: var(--b3-theme-primary); }
}
.docseeker-search-box .docseeker-history-icon:active, .docseeker-search-box .docseeker-clear:active { color: var(--b3-theme-on-background); }
.docseeker-card:active { border-color: var(--b3-theme-primary); }
@media (pointer: coarse) {
  :root { --docseeker-hit: 44px; --docseeker-hit-compact: 44px; }
  /* 16px minimum : en dessous, iOS zoome la page au focus d'un champ. */
  .docseeker-search input[type="search"], .docseeker-filter-field input, .docseeker-floating-body input, .b3-dialog input[data-dialog-input], .docseeker-settings-section input[type="text"], .docseeker-settings-section input[type="number"] { font-size: 16px; }
  .docseeker-settings-section input[type="text"], .docseeker-settings-section input[type="number"], .docseeker-settings-section select { min-height: var(--docseeker-hit); font-size: 16px; }
  /* Case à cocher : c'est son <label> qui offre la cible (agrandir l'input déformerait le contrôle natif). */
  .docseeker-search label:has(> input[type="checkbox"]), .docseeker-filter-field label:has(> input[type="checkbox"]), .docseeker-settings-section label:has(> input[type="checkbox"]) { display: inline-flex; align-items: center; gap: 8px; min-height: var(--docseeker-hit); }
  .docseeker-icons .search__rmpath { box-sizing: border-box; min-width: var(--docseeker-hit); min-height: var(--docseeker-hit); padding: calc((var(--docseeker-hit) - 16px) / 2); }
  .docseeker-search .search__header .b3-chip, .docseeker-search .search__header button { min-height: var(--docseeker-hit); box-sizing: border-box; }
  .docseeker-dialog .b3-dialog__action .b3-button { min-height: var(--docseeker-hit); }
  .docseeker-doc-path { display: none; }
  .docseeker-doc-fullpath { display: block; font-size: 12px; color: var(--b3-theme-on-surface); overflow-wrap: anywhere; }
  .docseeker-doc-fullpath[hidden] { display: none; }
}
/* mobile-compact */
.docseeker-floating-body--fullscreen { padding: 8px; }
.docseeker-floating-body--fullscreen .docseeker-toolbar { flex-wrap: nowrap; gap: 0; }
.docseeker-floating-body--fullscreen .docseeker-icons { flex: 1 1 auto; flex-wrap: nowrap; justify-content: space-between; }
.docseeker-floating-body--fullscreen .docseeker-icons .block__icon { flex: 1 1 0; min-width: 0; }
.docseeker-floating-body--fullscreen .docseeker-count { display: none; }
.docseeker-floating-body--fullscreen .docseeker-search .search__header { gap: 4px 8px; }
.docseeker-floating-body--fullscreen .docseeker-search .search__header .b3-chips { flex: 1 0 100%; }
.docseeker-floating-body--fullscreen .docseeker-search .search__header .fn__space, .docseeker-floating-body--fullscreen .docseeker-search .search__header .fn__flex-1 { display: none; }
.docseeker-floating-body--fullscreen .docseeker-search .search__header button[data-type] { position: relative; flex: 1 1 0; min-width: 0; min-height: 30px; margin: 0; padding: 4px 8px; font-size: 13px; line-height: 1.2; box-sizing: border-box; }
.docseeker-floating-body--fullscreen .docseeker-search .search__header button[data-type]::after { content: ""; position: absolute; top: -7px; bottom: -7px; left: -4px; right: -4px; }
.docseeker-floating-body--fullscreen .docseeker-cards, .docseeker-floating-body--fullscreen .docseeker-list--flat { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; margin-top: 4px; }
.docseeker-floating-body--fullscreen .docseeker-card, .docseeker-floating-body--fullscreen .docseeker-card--flat { width: 100%; max-width: none; min-width: 0; box-sizing: border-box; padding: 2px; }
.docseeker-floating-body--fullscreen .docseeker-thumb { width: 100%; }
.docseeker-floating-body--fullscreen .docseeker-doc { padding: 6px 0; }
.docseeker-floating-body--fullscreen .docseeker-doc-title { font-size: 16px; font-weight: bold; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; }
.docseeker-floating-body--fullscreen .docseeker-doc-fullpath { display: none; }
/* /mobile-compact */
@media (forced-colors: active) {
  .docseeker-highlight { background: transparent; outline: 2px solid Highlight; outline-offset: -2px; }
  .docseeker-card:focus-visible { outline-color: Highlight; }
  .docseeker-viewer-button:focus-visible, .docseeker-floating-close:focus-visible { outline-color: Highlight; }
  .docseeker-floating-close, .docseeker-viewer-button { border-color: ButtonText; }
  .docseeker-viewer-button:disabled { opacity: 1; color: GrayText; border-color: GrayText; }
  .docseeker-filter-field input:focus-visible, .docseeker-filter-reset:focus-visible, .docseeker-reset-filters:focus-visible { outline-color: Highlight; }
  .docseeker-filter-field [aria-invalid="true"] { border-color: Mark; box-shadow: none; outline: 2px solid Mark; }
  .docseeker-filter-reset[aria-disabled="true"] { opacity: 1; color: GrayText; border-color: GrayText; }
  .docseeker-icons .block__icon:focus-visible { outline-color: Highlight; }
  .docseeker-icons .block__icon[aria-disabled="true"] { opacity: 1; color: GrayText; }
  .docseeker-search-box .docseeker-history-icon:focus-visible, .docseeker-search-box .docseeker-clear:focus-visible { outline-color: Highlight; }
}
`;

export function ensureSearchStyle(doc: Document = document): void {
  if (doc.getElementById(SEARCH_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SEARCH_STYLE_ID;
  style.textContent = SEARCH_CSS;
  doc.head.appendChild(style);
}
