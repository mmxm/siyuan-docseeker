/** CSS de l'onglet de recherche (variables de thème SiYuan uniquement). */
export const SEARCH_STYLE_ID = "docseeker-search-style";

export const SEARCH_CSS = `
.docseeker-search { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 8px; gap: 8px; color: var(--b3-theme-on-background); background: var(--b3-theme-background); }
.docseeker-search input[type="search"] { width: 100%; box-sizing: border-box; }
.docseeker-status { font-size: 12px; color: var(--b3-theme-on-surface); min-height: 1.4em; }
.docseeker-status--error { color: var(--b3-theme-error); }
.docseeker-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1 1 auto; }
.docseeker-doc { padding: 8px 0; border-bottom: 1px solid var(--b3-border-color); }
.docseeker-doc-title { font-weight: bold; overflow-wrap: anywhere; }
.docseeker-doc-count { margin-left: 6px; font-size: 12px; color: var(--b3-theme-on-surface); }
.docseeker-doc-path { font-size: 11px; color: var(--b3-theme-on-surface); overflow-wrap: anywhere; }
.docseeker-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.docseeker-card { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; cursor: pointer; background: transparent; color: inherit; border: 1px solid transparent; border-radius: var(--b3-border-radius, 4px); }
.docseeker-card:hover, .docseeker-card:focus-visible { border-color: var(--b3-theme-primary); outline: none; }
.docseeker-thumb { position: relative; width: 120px; aspect-ratio: 3 / 4; overflow: hidden; background: #fff; border: 1px solid var(--b3-border-color); }
.docseeker-thumb canvas, .docseeker-thumb img { display: block; width: 100%; height: 100%; object-fit: contain; }
.docseeker-thumb mark, .docseeker-highlight { background: rgba(255, 220, 0, 0.4); }
.docseeker-card-page { font-size: 11px; color: var(--b3-theme-on-surface); }
`;

export function ensureSearchStyle(doc: Document = document): void {
  if (doc.getElementById(SEARCH_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SEARCH_STYLE_ID;
  style.textContent = SEARCH_CSS;
  doc.head.appendChild(style);
}
