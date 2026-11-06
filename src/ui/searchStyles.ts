/** CSS de l'onglet de recherche (variables de thème SiYuan uniquement). */
export const SEARCH_STYLE_ID = "docseeker-search-style";

export const SEARCH_CSS = `
.docseeker-search { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 8px; gap: 8px; color: var(--b3-theme-on-background); background: var(--b3-theme-background); }
.docseeker-search input[type="search"] { width: 100%; box-sizing: border-box; min-height: 32px; }
.docseeker-search input[type="search"]:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-status { font-size: 12px; color: var(--b3-theme-on-surface); min-height: 1.4em; }
.docseeker-alert { font-size: 12px; color: var(--b3-theme-error); }
.docseeker-alert:empty { display: none; }
.docseeker-message { font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-message:empty { display: none; }
.docseeker-actions:empty { display: none; }
.docseeker-open-settings { min-height: 32px; min-width: 32px; }
.docseeker-open-settings:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-setting-action { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; width: 100%; }
.docseeker-setting-action pre { margin: 0; max-width: 100%; overflow-wrap: anywhere; }
.docseeker-setting-action pre:empty { display: none; }
.docseeker-action { min-height: 32px; min-width: 32px; }
.docseeker-action:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-action[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.docseeker-log { max-height: 240px; overflow: auto; overflow-wrap: anywhere; padding: 4px; border: 1px solid var(--b3-border-color); }
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
.docseeker-truncated { align-self: center; font-size: 12px; }
.docseeker-truncated[hidden] { display: none; }
.docseeker-more:focus-visible, .docseeker-less:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.docseeker-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.docseeker-card { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; min-height: 32px; min-width: 32px; cursor: pointer; background: transparent; color: inherit; border: 1px solid transparent; border-radius: var(--b3-border-radius, 4px); }
.docseeker-card:hover { border-color: var(--b3-theme-primary); }
.docseeker-card:focus-visible { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; border-color: var(--b3-theme-primary); }
.docseeker-thumb { position: relative; width: 120px; aspect-ratio: 3 / 4; overflow: hidden; background: #fff; border: 1px solid var(--b3-border-color); }
.docseeker-thumb canvas, .docseeker-thumb img { display: block; width: 100%; height: 100%; object-fit: fill; }
.docseeker-thumb-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; text-align: center; font-size: 12px; color: #444; }
.docseeker-thumb mark, .docseeker-highlight { background: rgba(255, 220, 0, 0.4); }
.docseeker-card-page { font-size: 12px; color: var(--b3-theme-on-surface); }
@media (forced-colors: active) {
  .docseeker-highlight { background: transparent; outline: 2px solid Highlight; outline-offset: -2px; }
  .docseeker-card:focus-visible { outline-color: Highlight; }
}
`;

export function ensureSearchStyle(doc: Document = document): void {
  if (doc.getElementById(SEARCH_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SEARCH_STYLE_ID;
  style.textContent = SEARCH_CSS;
  doc.head.appendChild(style);
}
