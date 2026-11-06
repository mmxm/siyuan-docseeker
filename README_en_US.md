# DocSeeker for SiYuan

Full-text search inside the PDFs of your SiYuan workspace. Results are shown as thumbnails of the page, with the matched words highlighted. A click opens the PDF in SiYuan's built-in viewer, on the right page, centred on the matched area.

[Version française](README.md)

## What the plugin does

- **Full-text search** in the PDFs of the `data/assets` folder (sub-folders included).
- **Highlighted thumbnails**: for each matching page, an extract of the page cropped around the area that contains the most words of the query, with the words highlighted.
- **Opens on the right page**: a click opens the PDF in SiYuan's viewer, on the matching page, centred on the area, with a highlight overlay. This also works when the PDF is already open.
- **Ranking by word proximity**: for a query of several words, pages where the words are close together (on the same line) move up. The ranking stays close to that of DocSeeker, the original application, but is not identical to it.
- **Expandable pages**: each document first shows a few pages. "and N other pages" reveals 10 more at each click (200 pages at most per document).

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

- Indexing is **automatic** (configurable in the plugin settings): a few seconds after startup, when the window regains focus (at most once every 30 seconds), then every 5, 15 or 60 minutes. Added or modified PDFs are indexed, deleted PDFs are removed from the index, unchanged PDFs are not read again. It waits while you type or scroll. **Reindex** forces an immediate check.
- A PDF that fails (corrupt, empty) is retried at increasing intervals; the search tab reports failures and unreadable folders, and the details are in the settings log.
- If indexing stops early (for example when SiYuan is closed), the next run resumes where it stopped.
- **Indicative duration**: about 191 s for 44 PDFs, measured with Node on a local disk. In the browser it takes longer. These figures are given for information only.
- **Index size**: about 3 KB per indexed page.

## Usage

- **Several words**: all the words must appear on the same page. "severite bpco" only returns the pages that contain both words.
- **Prefix on the last word**: `diab` finds "diabète", "diabétique", and so on. Only the last word is treated this way.
- **Accents and case are ignored**: "diabete" finds "Diabète". Punctuation is ignored too.
- Results are grouped by document. A click on a thumbnail opens the PDF on the matching page.
- Once the proximity ranking has been computed, the status reads "Ranking refined by word proximity".
- The interface is in French only.

## Known limitations

- **Target: the SiYuan webapp on a computer**, tested with SiYuan 3.8.9. Mobile is not supported. The desktop application is declared in the manifest but has not been tested.
- **PDFs without text are skipped**: a scanned PDF (an image with no text layer) is not indexed and is reported in the tab. There is no OCR.
- **No substring search**: search works on whole words, with a prefix on the last word only. "pco" does not find "BPCO".
- **Ranking close to DocSeeker, not identical**: font size is not taken into account (neither in the ranking nor in the sorting of occurrences). Quoted phrases are not supported.
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
