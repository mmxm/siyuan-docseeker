/** CSS de l'onglet de recherche (variables de thème SiYuan uniquement). */
export const SEARCH_STYLE_ID = "docseeker-search-style";

export const SEARCH_CSS = `
.docseeker-search { --docseeker-thumb-width: 120px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 8px; gap: 8px; color: var(--b3-theme-on-background); background: var(--b3-theme-background); }
.docseeker-search input[type="search"] { width: 100%; box-sizing: border-box; min-height: 32px; }
.docseeker-search input[type="search"]:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-search-box { position: relative; display: flex; align-items: stretch; min-width: 0; }
.docseeker-search-box input[type="search"] { flex: 1 1 auto; min-width: 0; padding-left: 44px; padding-right: 32px; }
.docseeker-search input[type="search"]::-webkit-search-cancel-button { display: none; -webkit-appearance: none; }
.docseeker-search-box .docseeker-history-icon, .docseeker-search-box .docseeker-clear { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; padding: 0; margin: 0; background: transparent; border: 0; border-radius: var(--b3-border-radius, 4px); color: var(--b3-theme-on-surface); cursor: pointer; }
.docseeker-search-box .docseeker-history-icon { left: 0; min-width: 44px; gap: 2px; }
.docseeker-search-box .docseeker-clear { right: 0; }
.docseeker-search-box .docseeker-history-icon:hover, .docseeker-search-box .docseeker-clear:hover { color: var(--b3-theme-on-background); }
.docseeker-search-box .docseeker-history-icon:focus-visible, .docseeker-search-box .docseeker-clear:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-search-box .docseeker-clear[hidden] { display: none; }
.docseeker-search-box .docseeker-clear svg { position: static; }
.docseeker-search-box svg { height: 16px; width: 16px; flex: none; }
.docseeker-search-box .search__arrowdown { height: 12px; width: 12px; }
.docseeker-icons { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; min-width: 0; min-height: 32px; padding: 0; box-sizing: border-box; }
.docseeker-icons .block__icon { display: flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; box-sizing: border-box; margin: 0; padding: 4px; background: transparent; border: 0; color: var(--b3-theme-on-surface); cursor: pointer; font: inherit; }
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
.docseeker-filter-field input { width: 100%; box-sizing: border-box; min-height: 32px; }
.docseeker-floating-body { box-sizing: border-box; padding: 8px 16px 16px; }
.docseeker-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.docseeker-filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 8px; padding: 4px 0 8px; align-items: end; }
.docseeker-filter-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.docseeker-filter-field label { font-size: 12px; color: var(--b3-theme-on-surface); overflow-wrap: anywhere; }

.docseeker-filter-field input:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-field [aria-invalid="true"] { border-color: var(--b3-theme-error); box-shadow: 0 0 0 1px var(--b3-theme-error); }
.docseeker-filter-error { margin: 0; font-size: 12px; color: var(--b3-theme-error); overflow-wrap: anywhere; }
.docseeker-filter-error[hidden] { display: none; }
.docseeker-search .search__header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; min-width: 0; }
.docseeker-search .search__header .b3-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.docseeker-search .search__header .b3-chips.fn__none { display: none; }
.docseeker-search .search__header .b3-chip { max-width: 100%; overflow-wrap: anywhere; }
.docseeker-search .search__header .b3-chip:focus-visible, .docseeker-search .search__header button:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-actions { display: flex; align-items: flex-end; }
.docseeker-filter-reset, .docseeker-reset-filters { min-height: 32px; min-width: 32px; }
.docseeker-filter-reset:focus-visible, .docseeker-reset-filters:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-filter-reset[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.docseeker-reset-filters[hidden] { display: none; }
.docseeker-status { font-size: 12px; color: var(--b3-theme-on-surface); min-height: 1.4em; }
.docseeker-index-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.docseeker-index-activity:empty { display: none; }
.docseeker-index-activity { font-size: 12px; color: var(--b3-theme-on-surface); min-height: 1.4em; white-space: normal; overflow-wrap: anywhere; }
.docseeker-index-count { font-size: 12px; color: var(--b3-theme-on-surface); opacity: 0.8; }
.docseeker-index-settings { min-height: 32px; min-width: 32px; }
.docseeker-alert { font-size: 12px; color: var(--b3-theme-error); }
.docseeker-alert:empty { display: none; }
.docseeker-message { font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-message:empty { display: none; }
.docseeker-actions:empty { display: none; }
.docseeker-open-settings { min-height: 32px; min-width: 32px; }
.docseeker-open-settings:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.config-item:has(.docseeker-setting-action) .b3-label__text { word-break: normal; overflow-wrap: break-word; }
.docseeker-setting-action { width: 100%; box-sizing: border-box; }
.docseeker-setting-action > * + * { margin-top: 8px; }
.docseeker-setting-action pre { margin: 0; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
.docseeker-setting-action pre:empty { display: none; }
.docseeker-action { width: auto; min-height: 32px; min-width: 32px; }
.docseeker-action:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-action[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.docseeker-log { width: 100%; box-sizing: border-box; max-height: 240px; overflow: auto; overflow-wrap: anywhere; padding: 4px; border: 1px solid var(--b3-border-color); }
.docseeker-log:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1 1 auto; }
.docseeker-doc { padding: 8px 0; border-bottom: 1px solid var(--b3-border-color); }
.docseeker-doc-heading { margin: 0; font-size: inherit; font-weight: normal; }
.docseeker-doc-title { font-weight: bold; overflow-wrap: anywhere; }
.docseeker-doc-count { margin-left: 2px; font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-doc-path { font-size: 12px; color: var(--b3-theme-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.docseeker-doc-path[hidden] { display: none; }
.docseeker-doc-path-text { direction: ltr; unicode-bidi: bidi-override; }
.docseeker-more-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.docseeker-more, .docseeker-less { min-height: 32px; font-size: 12px; }
.docseeker-more[hidden], .docseeker-less[hidden] { display: none; }
.docseeker-index-settings[hidden] { display: none; }
.docseeker-truncated { align-self: center; font-size: 12px; }
.docseeker-truncated[hidden] { display: none; }
.docseeker-more:focus-visible, .docseeker-less:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.docseeker-card { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; min-height: 32px; min-width: 32px; cursor: pointer; background: transparent; color: inherit; border: 1px solid transparent; border-radius: var(--b3-border-radius, 4px); }
.docseeker-card:hover { border-color: var(--b3-theme-primary); }
.docseeker-card:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; border-color: var(--b3-theme-primary); }
.docseeker-thumb { position: relative; width: var(--docseeker-thumb-width); aspect-ratio: 3 / 4; overflow: hidden; background: #fff; border: 1px solid var(--b3-border-color); }
.docseeker-thumb canvas, .docseeker-thumb img { display: block; width: 100%; height: 100%; object-fit: fill; }
.docseeker-thumb-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; text-align: center; font-size: 12px; color: #444; }
.docseeker-thumb mark, .docseeker-highlight { background: rgba(255, 220, 0, 0.4); }
.docseeker-list--flat { display: flex; flex-wrap: wrap; gap: 8px; }
.docseeker-flat-item { min-width: 0; }
.docseeker-flat-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.docseeker-flat-footer[hidden], .docseeker-flat-more[hidden] { display: none; }
.docseeker-flat-more { min-height: 32px; min-width: 32px; font-size: 12px; }
.docseeker-flat-more:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-card--flat { max-width: calc(var(--docseeker-thumb-width) + 16px); /* vignette + padding 2 x 4px + bord 2 x 1px, arrondi */ }
.docseeker-card-title { max-width: 100%; font-size: 12px; font-weight: bold; text-align: center; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.docseeker-card-page { font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-settings-section { padding: 8px 16px; color: var(--b3-theme-on-background); }
.docseeker-settings-title { font-weight: bold; }
@media (forced-colors: active) {
  .docseeker-highlight { background: transparent; outline: 2px solid Highlight; outline-offset: -2px; }
  .docseeker-card:focus-visible { outline-color: Highlight; }
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
