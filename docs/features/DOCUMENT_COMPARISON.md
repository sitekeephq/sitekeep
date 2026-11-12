# Document comparison (Compare revisions)

Puts two versions of a document side by side. Shows what changed with a visual comparison, a text diff and an AI summary.

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

Both files must be of the same type. IFC models are compared in the model viewer.

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

## Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /projects/:pid/doc-compare?from=&to=[&rebuild=1][&wait=ms]` | Returns the comparison; starts it if it does not exist |
| `GET /projects/:pid/doc-compare/:cid[?wait=ms]` | Status, result, summary progress |
| `PUT /projects/:pid/doc-compare/:cid/regions` | Stores the regions found by the browser |
| `POST /projects/:pid/doc-compare/:cid/summary {force?}` | Starts the AI summary |
| `POST /projects/:pid/doc-compare/:cid/report {thumbnails}` | Report PDF |
| `POST /projects/:pid/doc-compare/:cid/review-note {reviewId}` | Adds the summary to a review as a note |

- Table: `doc_comparisons` (migration `0017_doc_compare`). One row per pair.
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
- DWG/DXF comparison.
