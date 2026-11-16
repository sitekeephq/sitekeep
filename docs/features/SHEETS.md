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
| **Settings** | `drawing_sheet_settings` (one row per project) | Which folders are scanned: folder states (default **Shared** and **Published**) and chosen folders with their subfolders |

Migration `0044_sheets.sql` adds the five tables (PostgreSQL and PGlite).

## Extraction

A background job (`sheets_extract`, `apps/server/src/sheets/service.ts`) runs for every new PDF,
DWG or DXF version: uploads, new versions, OpenCDE and module uploads (`afterVersionAdded`) and
approved review copies (`copyApprovedFiles`, so documents published through the review workflow
get their sheets). The job does nothing when the file's folder is outside the settings.

1. **PDF**: the text layer of every page (up to 500 pages) is read with pdf.js in a worker thread
   (`docintel/extract.ts`), and the title block of each page with the rule-based reader of
   document intelligence (`docintel/antet.ts`: labels such as *Pafta No*, *Sheet No*, *Drawing No*,
   *Pafta Adı*, *Title*, *Rev*, *Disiplin*, *Tarih*). No OCR: a scanned page has no title-block
   values and is numbered as below.
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
for example after changing the settings; a folder editor can read one version again, also outside
the settings (`POST /versions/:vid/sheets/extract`).

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
| Settings, read every drawing again | Project administrators |

Items of a set whose sheets the reader cannot see are left out and counted (`hidden`); a published
issue shows the reader only the sheets of files they can see. The ZIP download applies the download
rules of the bulk download (files with view but no download right are listed in `_eksikler.txt`).

Audit: `sheet_set.created`, `sheet_set.updated`, `sheet_set.deleted`, `sheet_set.items_added`,
`sheet_set.items_removed`, `sheet_set.published` (issue, note, sheets with revision and version),
`sheet_set.downloaded`, `sheet.updated`, `sheet.settings_updated`, `sheet.rescanned`
([audit log](AUDIT_LOG.md)).

## API

All under `/api/v1/projects/:pid`; DTOs in `packages/shared/src/documents/sheets.ts`; routes in
`apps/server/src/sheets/routes.ts`.

| Method | Path | Notes |
|---|---|---|
| GET | `/sheets` | `q` (number, title, file, discipline), `discipline`, `revision`, `state` (`wip`, `shared`, `published`, `archived`, `none`), `setId`, `folderId`, `all=1` (every version, not only current ones), `limit`, `offset`. Returns the sheets, the total and the filter values |
| GET | `/sheets/export?format=csv\|xlsx` | Sheet list ("pafta listesi") of the same filters: No., Sheet Number, Title, Discipline, Revision, Suitability, Date, Status, File, Page; in the reader's language |
| GET | `/sheets/:sid` | Sheet, its history (same number key across versions and files, newest first), the sets that contain it, `canEdit` |
| PATCH | `/sheets/:sid` | `{ number?, title?, discipline? }` |
| POST | `/sheets/rescan` | Project administrators; `{ queued }` |
| GET | `/versions/:vid/sheets` | Sheets of one version, `inScope`, `canEdit` |
| POST | `/versions/:vid/sheets/extract` | Read one version again |
| GET, PUT | `/sheet-settings` | `{ states, folderIds }`; PUT for project administrators |
| GET, POST | `/sheet-sets` | List; create `{ name, description?, sheetIds? }` |
| GET, PATCH, DELETE | `/sheet-sets/:setId` | Set with items, hidden count and issues; `{ name?, description? }` |
| POST | `/sheet-sets/:setId/items` | `{ sheetIds }`: adds their numbers |
| POST | `/sheet-sets/:setId/items/remove` | `{ keys }` (number keys) |
| POST | `/sheet-sets/:setId/publish` | `{ note? }`: the next issue |
| GET | `/sheet-sets/:setId/issues/:issue` | A published issue |
| GET | `/sheet-sets/:setId/export?format=csv\|xlsx[&issue=n]` | Sheet list of the set now, or of an issue: `<project>-<set>-issue-03.xlsx` |
| GET | `/sheet-sets/:setId/zip[?issue=n]` | The drawing files of the set (each version once, `name (V2).pdf`) |

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
  the sheet's page: `/view/:versionId?page=n`; DWG/DXF in their viewer), edit, history.

Project Settings → CDE → **Sheets**: the states and folders that are scanned.

## Tests

- Unit and API: `apps/server/test/documents/sheets.test.ts` (numbering, extraction from multi-page
  PDF fixtures, settings and rescan, folder permissions and the task-team WIP rule, manual edit kept
  on re-extraction, set snapshot across a new version, set permissions, CSV / XLSX / ZIP exports).
- End to end: `e2e/specs/sheets.spec.ts` (core: with and without modules): a three-page PDF in a
  Shared folder → sheets with thumbnails → list view → open at the page → set from the selection →
  publish issue 01 → sheet list export.

## Not yet

- OCR for scanned drawings and a per-project title-block template (region definition).
- Writing the title-block values back to the version's metadata (ISO-2 fields) with the user's
  approval.
- Sheet-level markup and comparison: see [document comparison](DOCUMENT_COMPARISON.md) and the PDF
  viewer's markups.
