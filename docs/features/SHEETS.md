# Drawing sheets (FP-2)

SiteKeep Community splits drawings into **sheets** (Turkish: *Paftalar*) and groups them into
**sheet sets** that are published as numbered issues, like the Sheets tool of Autodesk Forma
document management (parity principle: editions and modules §3.5,
development repository only). Everything here is Community: no module and no AI is needed.

## Model

| Concept | Where it lives | Notes |
|---|---|---|
| **Sheet** | `drawing_sheets` (one row per page of a drawing version) | A page of a PDF version; a DWG or DXF version is one sheet. Number, title, discipline, revision and date are read from the page's title block; `file_id`, `version_id`, `page`, `page_count` point at the drawing |
| **Sheet number key** | `drawing_sheets.number_key` (`sheetKey(number)`: upper-cased, spaces removed) | Links the same sheet across versions and files: the history of a sheet and the members of a set are found by it |
| **Revision** | the version's ISO 19650 revision code (`file_versions.revision_code`), else the revision read on the page | Shown and exported as one value ([codes](CDE_STATES.md#codes)) |
| **Suitability, state** | the version's suitability code; the folder's CDE state and the file's status flag (returned, superseded, withdrawn) | Read live, not copied into the sheet |
| **Sheet set** | `sheet_sets` (name unique per project, case-insensitive), members in `sheet_set_items` | A member is a sheet number key: the set always shows the latest sheet with that number the reader can see (newest upload, not superseded or withdrawn) |
| **Issue** (published set) | `sheet_set_publications` (`issue` 1, 2, 3 … per set) | A snapshot: the exact version, page, number, title and revision of every sheet when it was published. Later versions do not change it |
| **Settings** | `drawing_sheet_settings` (one row per project) | Which folders are scanned: folder states (default **Shared** and **Published**) and chosen folders with their subfolders; the **title-block template** (`title_block`) and the project's **OCR switch** (`ocr`, default on) |
| **How a sheet was read** | `drawing_sheets.read_by` (`text`, `ocr`, null), `ocr_confidence` (0..1), `from_template` | Shown on the sheet; OCR values are marked for checking |

Migration `0044_sheets.sql` adds the five tables (PostgreSQL and PGlite); `0048_sheets_ocr.sql` adds the
template, the OCR switch and the three columns above.

## Extraction

A background job (`sheets_extract`, `apps/server/src/sheets/service.ts`) runs for every new PDF,
DWG or DXF version: uploads, new versions, OpenCDE and module uploads (`afterVersionAdded`) and
approved review copies (`copyApprovedFiles`, so documents published through the review workflow
get their sheets). The job does nothing when the file's folder is outside the settings.

1. **PDF**: the text layer of every page (up to 500 pages) is read with pdf.js in a worker thread
   (`docintel/extract.ts`). A page without a text layer (a scan) is read by [OCR](#ocr) in its title
   block. Then each field (number, title, revision, discipline, date) is taken from:
   1. the project's [title-block template](#title-block-template) for the page's orientation, when it
      maps the field and finds a value (`sheets/titleblock.ts`);
   2. the rule-based reader of document intelligence (`docintel/antet.ts`: labels such as *Pafta No*,
      *Sheet No*, *Drawing No*, *Pafta Adı*, *Title*, *Rev*, *Disiplin*, *Tarih*) inside the
      template's rectangle;
   3. the same reader on the whole page (the only step without a template).

   A page where nothing is read (a scan with OCR off) is numbered as below.
2. **Numbering** (`numberSheets`, `packages/shared/src/documents/sheets.ts`): a page keeps the number
   read in its title block (sheet number, else drawing number, else document number). A
   single-sheet file without one takes the file's document code ([document codes](DOCUMENT_CODES.md)),
   else its name without extension. The pages of a multi-page file without one take
   `<code or name>-01`, `-02` … A number repeated inside one file gets `(2)`, `(3)` … so every page
   stays its own sheet.
3. **Discipline**: the title block, else the role / discipline field of the name parsed with the
   folder's naming standard (`Rol`, `Role`, `Disiplin`, `Discipline`), else a discipline attribute.
4. **Title**: the title block; a single-sheet file without one takes the file description.
5. **DWG / DXF**: one sheet, numbered and named from the code, the name and the description.

**Manual edit**: number, title and discipline of a sheet can be corrected (edit permission on the
folder). An edited sheet is marked and reading the drawing again keeps those three values; the
revision and date are always read again. Audit `sheet.updated` (before and after).

Project administrators can read every drawing in scope again (**Read Again**, `POST /sheets/rescan`),
for example after changing the settings or the template; a folder editor can read one version again,
also outside the settings (`POST /versions/:vid/sheets/extract`). Reading again keeps the manual edits
above.

### Title-block template

When the automatic reader gets a project's title block wrong (unusual labels, a number printed
elsewhere on the sheet), a project administrator draws the title block once: open a PDF sheet on the
Sheets page → **Title-Block Template** (*Antet Şablonu*).

- Drag a rectangle around the title block on the page. The editor zooms to it.
- For each field (Sheet Number, Title, Revision, Discipline, Date) either draw an **area** around its
  value (the text inside is taken; a label printed in it, "REV P02", "Pafta No: A-101", is dropped) or
  type the **label keyword** printed next to it ("DWG REF", "Issue"): the value is the rest of that
  cell, the cell to its right or the line(s) below, inside the title block. An area is tried first.
- **Test on This Sheet** shows what the template reads before saving
  (`POST /sheets/:sid/template-preview`; a scanned page is read by OCR for the test).
- **Save and Read Again** saves the template and reads every drawing in scope again.

Coordinates are page-relative (0..1, top-left, page rotation applied), so one template fits every
paper size of an orientation. A project has one template for **landscape** and one for **portrait**
sheets (the editor edits the one of the sheet it is opened on); a page whose orientation has none is
read automatically. Fields the template does not map, or does not find, fall back to the automatic
reader (steps 2 and 3 above). Saved in the sheet settings (`titleBlock`), audited as
`sheet.settings_updated`. Project Settings → CDE → Sheets shows whether a template exists and removes
it.

### OCR

Scanned sheets (PDF pages without any text) get their title block read with OCR, fully offline:

- **Engine**: [tesseract.js](https://github.com/naptha/tesseract.js) 7 (Apache-2.0): the Tesseract
  engine compiled to WebAssembly, run in its own worker thread in the server process. Chosen over a
  `tesseract` binary in the image: it is an npm dependency like the rest of the server, so tests,
  development machines, the Docker image and the installation bundle run the same OCR with no system
  package, and the image grows by about 31 MB (the WebAssembly builds for CPUs with and without SIMD
  ~20 MB, the English and Turkish models 5 MB, JavaScript) instead of the 107 MB (63 Debian packages)
  of `tesseract-ocr` with its language packages on the same base image. WebAssembly is slower than the
  native binary, which does not matter for the small area that is read: the bottom-right quarter of
  an A3 scan at 300 dpi is recognised in about 0.3 s, about 2.5 s with starting the engine and
  rendering (measured in the image, arm64).
- **Language data**: English and Turkish (`eng`, `tur`, tessdata "best_int" LSTM models) from the npm
  packages `@tesseract.js-data/eng` and `@tesseract.js-data/tur`, installed with the server by
  `npm ci`. The engine is given a local folder (`langPath`) and its cache is off: nothing is
  downloaded or written at run time, and no outbound connection exists for OCR (`privacy/outbound.ts`
  has none). The Dockerfile removes the legacy models and the browser builds and stops when a model is
  missing.
- **What is read**: only the title block: the template's rectangle for the page's orientation, else
  the bottom-right quarter of the page. pdf.js renders that rectangle alone (`sheets/ocr-render-worker.ts`,
  worker thread with @napi-rs/canvas) at 300 dpi (`SITEKEEP_SHEETS_OCR_DPI`), lowered to stay under
  16 megapixels; scan images above 300 megapixels are not decoded. The words become positioned text
  like a text layer, so the template and the automatic reader work on them unchanged. In short words
  with digits, O and I/l next to a digit become 0 and 1 ("PO3" → "P03").
- **Limits**: inside the `sheets_extract` job of the job queue; pages are rendered four at a time in a
  worker thread with a 1 GB heap limit and a 3-minute limit, each page has 60 seconds of OCR; at most
  100 scanned pages of a drawing are read (`SITEKEEP_SHEETS_OCR_MAX_PAGES`). A page that fails or runs
  out of time stops the OCR of that drawing; pages read so far keep their values, the others are
  numbered automatically.
- **Switches**: the project's switch (Project Settings → CDE → Sheets, **Read Scanned Drawings with
  OCR**, default on), the installation's switch (Administration → Privacy, system administrators,
  `GET`/`PUT /admin/sheets-ocr`, audit `settings.sheets_ocr_updated`, default on) and
  `SITEKEEP_SHEETS_OCR=off` on the server, which wins over both.
- **Checking**: a sheet read by OCR shows **Read by OCR – check (87 %)** (*OCR ile okundu – kontrol
  edin*) on its card, in the list and in the sheet dialog: the mean word confidence; red below 75 %.
  The mark goes when a person edits the sheet.

## Permissions

Sheets follow the documents list (`FolderTree`): a sheet is listed only when the reader can view its
file (view right on the folder, or the uploader on an upload-only folder), including the task-team
WIP rule ([task teams](TASK_TEAMS.md)). A sheet the reader cannot see answers 404.

| Action | Who |
|---|---|
| List, search, open, export the list | Project members (their visible sheets) |
| Edit a sheet's number, title, discipline | Edit right on the folder |
| Create a set | Project members (only sheets they can see can be added) |
| Rename, delete, add / remove sheets, publish | The set's creator and project administrators |
| Settings (title-block template, OCR switch included), test a template, read every drawing again | Project administrators |
| The installation's OCR switch | System administrators |

Items of a set whose sheets the reader cannot see are left out and counted (`hidden`); a published
issue shows the reader only the sheets of files they can see. The ZIP download applies the download
rules of the bulk download (files with view but no download right are listed in `_eksikler.txt`).

Audit: `sheet_set.created`, `sheet_set.updated`, `sheet_set.deleted`, `sheet_set.items_added`,
`sheet_set.items_removed`, `sheet_set.published` (issue, note, sheets with revision and version),
`sheet_set.downloaded`, `sheet.updated`, `sheet.settings_updated`, `sheet.rescanned`,
`settings.sheets_ocr_updated` (installation switch) ([audit log](AUDIT_LOG.md)).

## API

All under `/api/v1/projects/:pid`; DTOs in `packages/shared/src/documents/sheets.ts`; routes in
`apps/server/src/sheets/routes.ts`.

| Method | Path | Notes |
|---|---|---|
| GET | `/sheets` | `q` (number, title, file, discipline), `discipline`, `revision`, `state` (`wip`, `shared`, `published`, `archived`, `none`), `setId`, `folderId`, `all=1` (every version, not only current ones), `limit`, `offset`. Returns the sheets, the total and the filter values |
| GET | `/sheets/export?format=csv\|xlsx` | Sheet list ("pafta listesi") of the same filters: No., Sheet Number, Title, Discipline, Revision, Suitability, Date, Status, File, Page; in the reader's language |
| GET | `/sheets/:sid` | Sheet (with `readBy`, `ocrConfidence`, `fromTemplate`), its history (same number key across versions and files, newest first), the sets that contain it, `canEdit`, `canManage` (project administrator: template) |
| PATCH | `/sheets/:sid` | `{ number?, title?, discipline? }` |
| POST | `/sheets/:sid/template-preview` | Project administrators; `{ titleBlock }`: what the template reads on this PDF sheet (not saved) |
| POST | `/sheets/rescan` | Project administrators; `{ queued }` |
| GET | `/versions/:vid/sheets` | Sheets of one version, `inScope`, `canEdit` |
| POST | `/versions/:vid/sheets/extract` | Read one version again |
| GET, PUT | `/sheet-settings` | `{ states, folderIds, titleBlock, ocr }` and `ocrInstance` (read only); PUT (any of the four) for project administrators. `titleBlock`: `{ landscape, portrait }`, each null or `{ box, fields: [{ key, box?, label? }] }` with page-relative boxes `{ x0, y0, x1, y1 }` |
| GET, POST | `/sheet-sets` | List; create `{ name, description?, sheetIds? }` |
| GET, PATCH, DELETE | `/sheet-sets/:setId` | Set with items, hidden count and issues; `{ name?, description? }` |
| POST | `/sheet-sets/:setId/items` | `{ sheetIds }`: adds their numbers |
| POST | `/sheet-sets/:setId/items/remove` | `{ keys }` (number keys) |
| POST | `/sheet-sets/:setId/publish` | `{ note? }`: the next issue |
| GET | `/sheet-sets/:setId/issues/:issue` | A published issue |
| GET | `/sheet-sets/:setId/export?format=csv\|xlsx[&issue=n]` | Sheet list of the set now, or of an issue: `<project>-<set>-issue-03.xlsx` |
| GET | `/sheet-sets/:setId/zip[?issue=n]` | The drawing files of the set (each version once, `name (V2).pdf`) |

And, outside the project: `GET`, `PUT /api/v1/admin/sheets-ocr` (`{ enabled }`; system administrators):
the installation's OCR switch, with `disabledByEnv`, the languages and the resolution.

## Web

**Sheets** (*Paftalar*) in the project menu, after Documents (`/projects/:pid/sheets`,
`apps/web/src/features/sheets`):

- a grid of sheet cards with thumbnails (the page rendered in the browser with pdf.js from the
  version's PDF, the same file the PDF viewer opens; two at a time, when the card scrolls into view)
  or a list, with search and filters for discipline, revision and state;
- the sheet sets panel: all sheets or one set; a new set (empty or from the selected sheets), add the
  selection to a set, remove it from the set, rename, delete;
- the set header: **Publish Set** (dialog with the sheets and a note), the issues with their Excel,
  CSV and ZIP downloads;
- **Sheet List (Excel)** and **CSV** for the current filters;
- the sheet dialog (`/sheets/:sheetId`): preview, details, **Open in Viewer** (the PDF viewer at
  the sheet's page: `/view/:versionId?page=n`; DWG/DXF in their viewer), edit, history, where the
  sheet was read from, and for project administrators **Title-Block Template**
  (`TitleBlockEditor.tsx`: the page rendered with pdf.js, rectangles drawn with the pointer);
- **Read by OCR – check** on sheets read by OCR (`OcrBadge.tsx`).

Project Settings → CDE → **Sheets**: the states and folders that are scanned, whether a title-block
template exists (and removing it), the project's OCR switch. Administration → Privacy: the
installation's OCR switch (`AdminSheetsOcr.tsx`).

## Tests

- Unit and API: `apps/server/test/documents/sheets.test.ts` (numbering, extraction from multi-page
  PDF fixtures, settings and rescan, folder permissions and the task-team WIP rule, manual edit kept
  on re-extraction, set snapshot across a new version, set permissions, CSV / XLSX / ZIP exports;
  title-block templates: normalisation, region mapping by area and label keyword, template first and
  automatic reading as fallback, OCR words to text items; API with scanned PDFs made in the test
  (text drawn into an image with @napi-rs/canvas, the image put on a page with pdf-lib, about 30 KB):
  OCR of a scan, template preview, save, Read Again with a manual edit kept, OCR inside the
  template's rectangle, the project and installation switches).
- End to end: `e2e/specs/sheets.spec.ts` (core: with and without modules): a three-page PDF in a
  Shared folder → sheets with thumbnails → list view → open at the page → set from the selection →
  publish issue 01 → sheet list export. `e2e/specs/sheets-ocr.spec.ts` (core): a scanned sheet shows
  the values read by OCR with the check mark; the title-block template drawn on a sheet the automatic
  reader gets wrong, tested, saved and read again → the right number, title and revision.

## Not yet

- OCR of whole pages (only the title block is read) and of DWG/DXF title blocks.
- Writing the title-block values back to the version's metadata (ISO-2 fields) with the user's
  approval.
- Sheet-level markup and comparison: see [document comparison](DOCUMENT_COMPARISON.md) and the PDF
  viewer's markups.
