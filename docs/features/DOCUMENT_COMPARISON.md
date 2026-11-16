# Document comparison (Compare revisions)

Puts two versions of a document side by side. Shows what changed with a visual comparison, a text diff and an AI summary.
Drawings (DWG, DXF) are compared per layer and IFC models per GlobalId (FP-1, see [Drawings and models](#drawings-and-models-dwg-dxf-ifc)).
Version comparison is part of SiteKeep Community; it needs no Enterprise module.

## Where to open it

- **File drawer:** the "⇄ Compare with Previous Revision" button. Each row in the version history has a "Compare" link.
- **PDF viewer:** "⇄ Compare with Previous Revision" in the left panel.
- **Review page:** the "⇄" next to the version badge in the file table.
- Address: `/p/<proje>/compare?to=<versiyon>` compares with the previous version. `from=` selects another version or file.
- The old and new versions can be chosen on the page. "⇄" swaps them. "With Another File…" makes another file from the same folder the old side.

## Supported types

| Type | Visual | Text diff |
|---|---|---|
| PDF (drawing sheet — pafta, report) | Yes | Line/cell diff page by page, title block (antet) diff |
| XLSX | No | Worksheet, row and cell diff |
| CSV / TSV | No | Row and cell diff |
| DOCX | No | Paragraph diff |
| TXT / MD | No | Line diff |
| DWG / DXF | Layer opened in the CAD viewer | Entities per layer: added, removed, changed (layer, geometry, text, style); layer properties |
| IFC | Colours in the 3D viewer | Elements per GlobalId: added, removed, changed (attributes, properties, quantities, type, placement, geometry); by class and storey |

Both files must be of the same type (DWG and DXF count as one type).

## Visual comparison (PDF)

- Pages are rendered in the browser with pdf.js. The pixel diff is calculated in a Web Worker. The server is not loaded.
- **Overlay:** content in the old version but not in the new one is red, newly added content is blue, unchanged content is grey.
- **Side by Side:** two pages that scroll together. On narrow screens they are stacked vertically.
- **Slider:** the new page sits on top of the old one; the slider moves the boundary.
- 1-pixel shifts and anti-aliasing do not count as differences.
- If the paper size changed but the aspect ratio stayed the same, the old page is scaled to the new size.
- **Align (← ↑ ↓ →):** shifts the old page by 1 pt. Regions are recalculated for that page.
- **Changed Regions (n):** differing pixels are clustered, and each cluster is a box. Clicking one in the list zooms the page to that region.
- Regions are calculated on first opening and stored on the server. Later openings are fast.
- Visual analysis covers at most the first 60 pages.

## Text diff

- The server uses docintel's PDF text reader (at most 300 pages).
- The whole document is compared in one pass. Text that moved to the next page does not count as a difference.
- Similar lines are paired as "changed" and the word diff is shown: `KOLON S12 40x60 → 50x60`.
- Changes inside the title block (title block region) are marked with the "(antet)" (title block) label.
- **Title Block Changes** table: revision, date, drawing number, scale, sheet name and the last row of the revision table.
- A scanned PDF has no text layer. The screen shows "No text layer; visual comparison only."

## Checks

- **Same revision but changed content:** warning "the revision cloud/table may not have been updated".
- **Revision changed but no changes outside the title block:** warning.
- **Revision raised but table not updated:** warning.
- Notices for **revision went backwards**, **page count changed** and **the two files are identical**.
- For a content change, both the text diff and the visual regions (those outside the title block) count.

## Change summary (AI)

- **Only the diff summary** is sent to the model: changed lines, title block differences, region counts per page and the checks. The document is not sent.
- The summary is short bullet points in Turkish. Each point comes with its page; clicking it goes to that page and the related region.
- Warning points are shown in orange.
- The summary is written in the background. With a local model this can take 30–60 s; progress is shown and the page stays usable meanwhile.
- The summary starts automatically once the visual regions are ready. "Rewrite" requests a new summary.
- The result is stored per version pair.
- If AI is turned off or there is no provider, a rule-based summary is shown together with the reason.
- The administrator's AI policy (off / local only / external allowed) is applied as is.

## Actions

- **Save as Markup:** the changed regions are drawn on the new version as revision clouds. They are saved as a draft.
- **Create Issue (⚑):** from a region or a summary point. For a region, a cloud markup is opened and linked to the issue.
- **Report (PDF):** summary, checks, title block table, text diffs and small images of the changed pages.
- **Add summary to review:** if the new version is in an ongoing review, the summary is added to the review timeline as a note.

## Drawings and models (DWG, DXF, IFC)

The same page (`/p/<proje>/compare?from=&to=`) compares two versions of a drawing or a model. The
comparison runs as a background job on the job queue (`version_compare`) and is cached per version
pair in `doc_comparisons`, like the document comparison. "↻" rebuilds it. The page polls while the
job runs.

**Before the comparison.** Each side is prepared first, by the jobs that already exist:

- DWG / DXF: the DXF the CAD viewer reads (preview `dxf`; a DWG is converted by LibreDWG `dwg2dxf`).
  Without `dwg2dxf` a DWG comparison fails with the same hint as the viewer. Binary DXF is not supported.
- IFC: the element index (`ifc_index`, written with the viewer conversion). An index written before
  shape fingerprints existed is rebuilt once; if that is not possible the comparison runs without
  geometry and says so.

When a side is not ready the job queues its preparation and queues itself again behind it.

**DWG / DXF.** The entities of the ENTITIES section (model and paper space) are compared. Each entity
gets four fingerprints: layer, geometry (coordinates, sizes, flags; an INSERT includes the contents of
its block, a POLYLINE its vertices), text (TEXT, MTEXT, attributes, dimension text) and style (colour,
linetype, lineweight, transparency …). Handles, owners and reactors are left out and numbers are
rounded to 1e-6, so re-saving an unchanged drawing shows no differences.

- Entities are paired **by handle** when most entities have one and the handles still point at the
  same things. A changed entity then shows what changed: `Katman WALL → DOOR`, `Metin KOLON S12 40x60
  → 50x60`, `Renk 256 → 1`, or "Geometri".
- When the drawing was re-created (new handles) or the writer left handles out, entities are paired
  **by fingerprint**: equal ones first, then those equal but for the layer, the text or the style. A
  moved entity then shows as removed + added. The page says which pairing was used.
- **Per layer:** entity counts in the old and new drawing, counts per entity type, added / removed /
  changed entities and changed layer properties (colour, linetype, lineweight, frozen, off, locked,
  plot). Layers that exist only on one side are "added" / "removed".
- **Viewer:** "Katmanı Göster" opens the new version in the CAD viewer with only that layer on
  (`?layer=NAME`). The CAD viewer draws a prebuilt scene and cannot highlight single entities, so the
  entities themselves are listed, not highlighted.
- The list keeps the first 200,000 differences of a huge drawing; the counts are always complete.

**IFC.** Elements are matched by GlobalId in the two element indexes. An element is changed when its
attributes, placement, type, property or quantity sets, or its shape changed. The shape fingerprint
covers the element's representation tree with references replaced by what they point at, so a
re-export with new express ids is not a change. Each change is put in a category: attributes (name,
class, storey, material, IFC attributes), properties, quantities (`Qto_*`, `BaseQuantities`), type,
placement, geometry. The page shows the counts by class and by storey, and the list shows each
property change as old → new.

- **Viewer:** "Modelde Göster" opens the 3D viewer's comparison (`/viewer?v=<to>&cmp=<from>,<to>`):
  added elements green, changed orange, removed red (with the old version loaded as a ghost). "Göster"
  on a row selects that element. The 3D comparison uses the same GlobalId diff, shape changes included.

**Filters and export.** The list is filtered by change (added, removed, changed), layer or class,
entity type or storey, what changed (aspect or category) and a search over names, ids and values.
"⬇ Excel" and "⬇ CSV" export the filtered list; the Excel file also has a summary sheet per layer, or
per class and per storey.

**Summary and audit.** The side panel shows a rule-based summary (totals, the layers or classes with
the most changes). There is no AI summary and no PDF report for drawings and models. Starting a run
writes `doc_compare.run` to the audit log and each export writes `doc_compare.export`.

**Access.** Both versions must be visible to the caller (folder permissions and the task-team WIP
rule, see [task teams](TASK_TEAMS.md)); otherwise every endpoint answers 404.

## Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /projects/:pid/doc-compare?from=&to=[&rebuild=1][&wait=ms]` | Returns the comparison; starts it if it does not exist |
| `GET /projects/:pid/doc-compare/:cid[?wait=ms]` | Status, result, summary progress |
| `PUT /projects/:pid/doc-compare/:cid/regions` | Stores the regions found by the browser |
| `POST /projects/:pid/doc-compare/:cid/summary {force?}` | Starts the AI summary |
| `POST /projects/:pid/doc-compare/:cid/report {thumbnails}` | Report PDF |
| `POST /projects/:pid/doc-compare/:cid/review-note {reviewId}` | Adds the summary to a review as a note |
| `GET /projects/:pid/doc-compare/:cid/differences?kind=&group=&subgroup=&aspect=&q=&offset=&limit=` | DWG / IFC: one page of the differences (limit ≤ 500) |
| `GET /projects/:pid/doc-compare/:cid/export?format=csv\|xlsx[&kind=…]` | DWG / IFC: the filtered differences as CSV or Excel |

- Table: `doc_comparisons` (migration `0017_doc_compare`). One row per pair. For DWG / IFC the row
  holds the summary (`result.cad` / `result.model`); the full list of differences is a gzip JSON file
  in storage (`projects/<id>/comparisons/`), removed when the comparison is rebuilt.
- Permission to see both versions is required. Users without it get 404.
- The report endpoint is open to read-only access keys.

## MCP / Ask

- Tool: `cde_document_compare` (read-only).
- Input: `projectId` + `fromVersionId` + `toVersionId`, or just `fileId` (current ↔ previous).
- Output: sample text diffs per page, title block differences, checks, the AI summary if available, otherwise the rule-based summary.
- The "Ask" assistant uses this tool for questions such as "ne değişti, karşılaştır, fark" (what changed, compare, difference).

## Deferred

- Text diff with OCR for scanned PDFs.
- Recognising revision clouds in the drawing and a "change outside the cloud" check.
- Automatic alignment (image registration); for now there is manual alignment.
- Matching pages by title when the page order changes.
- Reading the title block of each page separately in multi-sheet sets (currently the first page).
- Highlighting single DWG entities in the CAD viewer (the prebuilt scene has no entity identity).
- DWG blocks compared definition by definition (today a changed block shows through its INSERTs).
