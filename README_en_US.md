# DocSeeker for SiYuan

Full-text search inside the PDFs of your SiYuan workspace. Results are shown as thumbnails of the page, with the matched words highlighted. A click opens the PDF in SiYuan's built-in viewer, on the right page, centred on the matched area.

[Version française](README.md)

## What the plugin does

- **Full-text search** in the PDFs of the `data/assets` folder (sub-folders included).
- **Highlighted thumbnails**: for each matching page, an extract of the page cropped around the area that contains the most words of the query, with the words highlighted.
- **Opens on the right page**: a click opens the PDF in SiYuan's viewer, on the matching page, centred on the area, with a highlight overlay. This also works when the PDF is already open.
- **Ranking by word proximity and font size**: for a query of several words, pages where the words are close together (on the same line) move up. Passages set in large type (headings) move up too, including for a single-word query. The ranking stays close to that of DocSeeker, the original application, but is not identical to it.
- **Expandable pages**: each document first shows a few pages. "and N other pages" reveals 10 more at each click (200 pages at most per document).
- **Filters, sorting and keyboard**: filter by folder, name, number of pages or date; sort and group the results; navigate with the keyboard; reuse a previous search from the history.
- **Floating window or tab**: the search opens in a tab (by default) or in a floating window, as chosen in the plugin settings.

## Installation

Requirements: SiYuan 3.8.0 or later, used in the **desktop web browser** (webapp), including with Docker. The plugin does not work on mobile.

### From the SiYuan Marketplace

Once the plugin is published in the Marketplace: in SiYuan, open the **Marketplace** menu, the **Plugins** tab, search for "DocSeeker", then click **Install**.

### From a zip file

1. Download `package.zip` from the releases page of the repository: https://github.com/mmxm/siyuan-docseeker/releases
2. Extract its contents into the `data/plugins/siyuan-docseeker/` folder of your SiYuan workspace. The folder must contain `index.js` and `plugin.json` directly, not inside another sub-folder.

### Manual copy

Copy into `data/plugins/siyuan-docseeker/`: `index.js`, `plugin.json`, the `i18n/` folder, `README.md`, `README_en_US.md` and `icon.png`.

On macOS, with SiYuan installed in its default location: `~/SiYuan/data/plugins/siyuan-docseeker/`.

### SiYuan in Docker

The folder mounted in the container (for example `-v /host/path:/siyuan/workspace`) contains the `data/` folder. Put the plugin in `/host/path/data/plugins/siyuan-docseeker/`. There is no need to rebuild or restart the container.

### Enabling or reloading the plugin

After an installation or an update: **Marketplace** menu, **Downloaded** tab, **Plugins** section. Disable DocSeeker, then enable it again. There is no need to restart SiYuan; reloading the page is not enough.

## First indexing

PDFs must be indexed before you can search them.

1. Click the search icon in the top bar ("Open the search in PDFs").
2. Open the plugin settings (DocSeeker's gear in **Marketplace > Downloaded > Plugins**, or the **Open settings** button in the search tab), then click **Reindex**.
3. Wait until it finishes. While indexing, the status reads "Index being built" and results are partial.

Things to know:

- Indexing is **automatic** (configurable in the plugin settings): a few seconds after startup, when the window regains focus (at most once every 30 seconds), then every 5, 15 or 60 minutes. Added or modified PDFs are indexed, deleted PDFs are removed from the index, unchanged PDFs are not read again (except once, after an update of the index format, see below). It waits while you type or scroll. **Reindex** forces an immediate check.
- **Index format update**: indexes created by the previous version of the plugin are updated automatically, once, PDF by PDF (the status reads "Updating the index"). During the update, search still works with the old index. On a large library, this update can take a long time: its duration has not been measured.
- A PDF that fails (corrupt, empty) is retried at increasing intervals; the search tab reports failures and unreadable folders, and the details are in the settings log.
- If indexing stops early (for example when SiYuan is closed), the next run resumes where it stopped.
- **Indicative duration**: about 191 s for 44 PDFs, measured with Node on a local disk. In the browser it takes longer. These figures are given for information only.
- **Index size**: about 3 KB per indexed page.

## Usage

- **Several words**: all the words must appear on the same page. "severite bpco" only returns the pages that contain both words.
- **Prefix on the last word**: `diab` finds "diabète", "diabétique", and so on. Only the last word is treated this way.
- **Accents and case are ignored**: "diabete" finds "Diabète". Punctuation is ignored too.
- Results are grouped by document (this can be changed, see "Sorting and grouping"). A click on a thumbnail opens the PDF on the matching page.
- Once the proximity and font-size ranking has been computed, the status reads "Ranking refined by word proximity and font size". When the sort is not by relevance, it reads "Pages ranked by proximity and font size".
- The interface is in French only. In the sections below, each French label is followed by its English translation in parentheses.

### Filtering results

The **Filtres** (Filters) button of the toolbar opens a dialogue with:

- the **folder**, chosen from the list (menu of the **Spécifier le chemin** / Specify path button), with or without its sub-folders (**Inclure les documents enfants** / Include child documents button, active only when a folder is chosen);
- the **document name**: part of the title is enough, case and accents are ignored;
- the **number of pages**: at least and at most;
- the **modification date**: PDF modified after a given date.

**Confirmer** (Confirm) applies the filters, **Annuler** (Cancel) ignores them, **Réinitialiser les filtres** (Reset filters) clears them. Filters do not restrict the search: they hide documents from the results. They are not kept from one session to the next.

### Sorting and grouping

**Plus** (More) menu of the toolbar:

- **Tri** (Sort): "Pertinence" (relevance, default order) or "ASC de pertinence" (reverse relevance), modification date (ascending or descending), name (ascending or descending), path (ascending), matching pages (descending).
- **Groupe** (Group): group by document (default) or no grouping. Without grouping, pages are listed flat, 60 at a time, with "Afficher plus" (Show more). The **Élargir** (Expand) and **Réduire** (Collapse) buttons only apply when results are grouped.

Changing the sort does not run the search again. The sort and the grouping are remembered.

### Keyboard

In the search field:

- **Enter** runs the search (typing does not start it);
- **Escape** clears the field;
- **↓** goes to the first thumbnail;
- **Alt+↓** opens the search history.

In the results:

- **↑** and **↓** go to the thumbnail above or below; **←** and **→** to the previous or next one;
- **Home** and **End** go to the first or last thumbnail;
- **Page Up** and **Page Down** go to the previous or next document;
- **Enter** opens the PDF on the page of the thumbnail;
- **Ctrl+Enter** (**⌘+Enter** on Mac), **Alt+Enter** or **Alt+click** opens the PDF **on the right**, in a side panel;
- **Escape** returns to the search field without clearing it;
- **Shift+Enter** does nothing.

### History

The icon on the right of the field, or **Alt+↓**, shows the last 20 searches. A click runs the search again. **Supprimer tout l'historique** (Clear all history) empties the list. The history is kept in the plugin settings.

### Floating window or tab

The **Ouverture de la recherche** (Search opens in) setting of the plugin chooses where the search opens:

- **Onglet** (Tab, default): a search tab, as in previous versions;
- **Fenêtre flottante** (Floating window): a window the same size as SiYuan's search. Opening a PDF closes it. When reopened, it runs the last search again with its options. The **Ouvrir dans un nouvel onglet** (Open in a new tab) button moves the search to a tab. **Escape** first closes an open menu, then clears the field, then closes the window if the field is empty.

The top-bar icon follows this setting. The commands below open either one, whatever the setting.

### Commands and shortcuts

The plugin provides four commands:

- **Rechercher dans les PDF** (Search in PDFs): opens the search according to the "Ouverture de la recherche" setting;
- **Rechercher dans les PDF (fenêtre flottante)** and **Rechercher dans les PDF (onglet)**;
- **Aller au champ de recherche PDF** (Go to the PDF search field): puts the focus in the floating window if it is open, otherwise in the field of the last visible search tab, or opens a tab.

No command has a shortcut by default. To assign one, open SiYuan's settings, go to the **Raccourci** (Shortcut) tab, find DocSeeker's commands and add a shortcut. The shortcut is chosen in SiYuan, not in the plugin.

## Known limitations

- **Target: the SiYuan webapp on a computer**, tested with SiYuan 3.8.9. Mobile is not supported. The desktop application is declared in the manifest but has not been tested.
- **Filters, sorting, keyboard, history and floating window** have been tried in the SiYuan 3.8.9 webapp, on a test workspace. They are not yet validated in the desktop application. The dark theme, the 320 px width, and the highlight in the panel opened on the right have not been checked yet. On macOS, **Alt+↓** may be captured by the system before it reaches the plugin.
- **PDFs without text are skipped**: a scanned PDF (an image with no text layer) is not indexed and is reported in the tab. There is no OCR.
- **No substring search**: search works on whole words, with a prefix on the last word only. "pco" does not find "BPCO".
- **Ranking close to DocSeeker, not identical**: font size is approximated by the height of the words as PDF.js reports it. On 3 PDFs only, this height turned out to be about 6 to 12% larger than the one PyMuPDF gives (PyMuPDF is the extraction engine of DocSeeker); this gap is not corrected. Only the 5 best pages of each document are measured for the ranking. Quoted phrases are not supported.
- **Previous version of the plugin**: version 0.2.0 cannot read the updated indexes. Do not use both versions on the same SiYuan folder.
- **Scope**: only PDFs in `data/assets` are indexed, not SiYuan documents.

## Privacy

Everything runs locally. DocSeeker reads your PDFs and its indexes only through the API of your own SiYuan kernel, and uses the PDF.js engine bundled with SiYuan. It sends nothing to the Internet, needs no account and collects no statistics. The indexes are files in `data/storage/petal/siyuan-docseeker/idx/`, so they are included in backups of your `data/` folder.

## Development

```bash
npm install
npm test                      # unit tests (Vitest)
npm run typecheck             # strict TypeScript: src, then tests
npm run package               # builds dist/index.js, then package.zip
npm run release:check         # checks a release without publishing anything
```

Test bench (real SiYuan UI, never touching `~/SiYuan`): a throwaway kernel on port 6807 with the plugin and test PDFs.

```bash
npm run build && npm run sandbox -- start      # optional --dir D, --port P, --pdfs N (8 PDFs by default); open the printed URL
npm run build && npm run sandbox -- install    # reinstalls the bundle, then F5 in the browser
npm run sandbox -- status | stop | reset       # reset only deletes the folder marked .docseeker-sandbox
```

Default folder: `$TMPDIR/docseeker-sandbox`. Ports 6806 and 55165 and any path inside `~/SiYuan` or an existing workspace are refused. `DOCSEEKER_KERNEL` overrides the kernel binary.

Measurements and tools (read-only on the data, except `gen:ranking-fixture`):

```bash
npm run measure:memory        # memory of decoded indexes; COPIES=20 extrapolates to a large corpus
npm run measure:multiword     # multi-word queries on real indexes; DSX_DIR=folder with the .dsx files
npm run measure:corpus        # indexing then queries on a PDF corpus; CORPUS_DIR, PDFJS_DIR, CORPUS_LIMIT
npm run gen:ranking-fixture   # regenerates tests/fixtures/docseeker-ranking.json with DocSeeker's Rust engine
```

- `DSX_DIR` defaults to `~/SiYuan/data/storage/petal/siyuan-docseeker/idx`.
- `PDFJS_DIR` defaults to the `stage/protyle/js/pdf` folder of SiYuan installed in `/Applications`.
- `gen:ranking-fixture` requires `DOCSEEKER_RUST_DIR` (the `backend-rust` folder of DocSeeker) and `cargo`. The Rust repository is never modified.

To publish a version: `npm run release:check` prints the manual commands to run afterwards. The script publishes nothing itself.

Project documents (in French): `CAHIER_DES_CHARGES.md` (the what), `PLAN_IMPLEMENTATION.md` (the how), `AVANCEMENT.md` (the status), `CHANGELOG.md` (the versions).
