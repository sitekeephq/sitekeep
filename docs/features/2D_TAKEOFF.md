# 2D Take-off

Length, area and count quantity take-off (metraj) from PDF and DWG/DXF drawings. A PDF page is calibrated with a
two-point reference line; for DWG/DXF the scale comes from the drawing unit. Measurements are grouped, group totals
are calculated, and measurements can optionally be linked to a unit price (5D cost item), priced, and exported to Excel.
Principle: points are stored in the drawing's own unit, and the quantity is recalculated from the page scale on every
read. If the scale is corrected, every measurement on that page is corrected automatically.

## Where to Open It

- **PDF viewer** → **2D Take-off** (with the open page).
- **Quantities** page → **2D Drawing** tab (`/projects/:pid/quantities?mode=2d`): the current versions of the PDF, DWG
  and DXF drawings you can see, with group totals. **Measure** for PDF, **Measure In CAD Viewer** for DWG/DXF.
- Direct address: `/projects/:pid/takeoff/:versionId`.
- **CAD viewer** (DWG/DXF) → **Add To Take-off** in the measurement result list.

## Measuring on a PDF

1. **Scale:** click both ends of a line of known length (a dimension line, a grid spacing) and enter the real length
   in metres (`5` or `2,5`). The page scale is stored as "1 unit = x m"; the reference line is shown as a dashed blue
   line. Each page has its own scale. If the scale is deleted, lengths and areas on that page become "unscaled".
2. **Length:** click the points; finish with Enter, a double-click or **Finish** (open polyline).
3. **Area:** click the corners; close with Enter, a double-click or **Finish**. If **Deduct Area (Opening)** is
   checked, the area counts as negative in its group (window, door, shaft).
4. **Count:** click each item you count; Enter or **Finish** saves them as a single measurement (number of points = count).

- **Group** (previous groups are suggested), **Item** (5D unit price; when the Schedule module is enabled) and
  **Colour** in the toolbar apply to new measurements.
- Esc cancels the drawing, a second Esc releases the tool; Backspace removes the last point; PageUp/PageDown turn pages.
- While drawing, the live value appears in the hint bar. If the page has no scale, a "No Scale" warning appears; the
  measurement is still saved and its quantity is calculated once the scale is set.
- On a phone you measure by tapping; the side panel opens from the bottom with the **Take-off (n)** button.

## Measuring on DWG/DXF

**Add To Take-off** appears on the CAD viewer's **Length**, **Chain Length** and **Area** results
(if you have markup permission on the folder). Points are saved in real drawing coordinates; the file's unit
(`$INSUNITS`) or the drawing unit chosen by the user is written to page 1 as the scale, with the "Drawing Units" method.
The drawing unit does not override a scale set by calibration. Changing the drawing unit while the page has measurements returns 409
(so that the meaning of existing measurements does not change); the measurements must be deleted first. DWG/DXF measurements are listed,
edited, deleted and exported to Excel on the 2D Take-off page; they are displayed on the drawing in the CAD viewer.

## Totals, Unit Price Items and Amounts

- Group totals are calculated by group name and kind (length m, area m², count); deducted areas count as negative.
  Unscaled measurements are not included in totals and are flagged as "n unscaled".
- A measurement can be linked to a cost item. If the item's unit matches the measurement's unit (m, m², count), amount =
  quantity × unit price; otherwise the link remains, no amount is calculated, and a warning appears on the selected
  measurement card.
- **Export To Excel:** `Take-off Summary` (group, kind, unit, measurement count, quantity, unscaled,
  amount) and `Measurements` (page, group, description, kind, quantity, unit, unit price item (poz), amount,
  measured by) sheets.

## Permissions

| Action | Required |
|---|---|
| View measurements and totals, Excel | Permission to view the file |
| Set / delete the scale, add measurements | Markup on the folder (`view_download_markup` or higher) |
| Change / delete a measurement | The person who took the measurement, or a project administrator (with markup permission) |

Scale changes, added and deleted measurements are written to the audit log (`takeoff.scale_set`, `takeoff.scale_removed`,
`takeoff.item_added`, `takeoff.item_removed`).

## Data and API

- Tables (`drizzle/0046_takeoff.sql`, `src/db/schema-takeoff.ts`):
  - `takeoff_scales`: one scale per version + page (`metres_per_unit`, `method` = `calibration` | `drawing_units`,
    calibration line and its real length).
  - `takeoff_items`: version, page, kind, points (in drawing units), description, group, deduct, colour, cost item, measured by.
- Calculation in `packages/shared/src/quantities/takeoff.ts`: polyline length, shoelace area, calibration scale,
  quantity (3 decimals), group totals. The server and the UI use the same functions.

| Endpoint | Purpose |
|---|---|
| `GET /projects/:pid/takeoff` | Current versions of visible PDF/DWG/DXF drawings and group totals |
| `GET /projects/:pid/versions/:vid/takeoff` | Scales, measurements (quantity, amount), group totals, `canEdit` |
| `PUT /projects/:pid/versions/:vid/takeoff/scales/:page` | `{ points: [[x,y],[x,y]], realLength }` or `{ metresPerUnit }` |
| `DELETE /projects/:pid/versions/:vid/takeoff/scales/:page` | Deletes the page scale |
| `POST /projects/:pid/versions/:vid/takeoff/items` | `{ page, kind, points, label?, group?, deduct?, color?, costItemId?, drawingUnits? }` |
| `PATCH /projects/:pid/takeoff/items/:id` | `label`, `group`, `deduct`, `color`, `costItemId` |
| `DELETE /projects/:pid/takeoff/items/:id` | Deletes the measurement |
| `GET /projects/:pid/versions/:vid/takeoff/export` | Excel (`<dosya>-V<n>-2b-metraj.xlsx`) |

Limits: at most 5000 points per measurement; a length needs at least 2 points, an area at least 3; 400 for non-PDF files (IFC etc.).

## Tests

- `packages/shared/test/takeoff.test.ts`: length, area (independent of winding direction), calibration, deducted area, grouping.
- `apps/server/test/quantities/takeoff-api.test.ts`: unscaled count/length, calibration and audit log, area +
  opening + amount, unit price item with a different unit, point validation, author/administrator permission, CAD drawing unit (does not override calibration),
  drawing list, Excel.
- `e2e/specs/takeoff.spec.ts` (desktop): opening from the PDF viewer, calibration, area + unit price item, opening, length, count,
  editing, deleting (confirmation dialog), Excel, **Add To Take-off** from the CAD viewer, 2D list on the Quantities page.
- `e2e/specs/mobile-takeoff.spec.ts` (iPhone): calibration and area by tapping, bottom panel, card view of the 2D list.
- `e2e/specs/mobile-smoke.spec.ts`: `quantities?mode=2d` horizontal scrolling and tab state.

## Not Yet Available

- Snapping on PDF (to line endpoints) and automatic length from vector lines.
- Displaying DWG/DXF measurements on the drawing in the 2D Take-off page (they are visible in the CAD viewer for the session).
- Carrying measurements over to a new version (each version has its own quantity take-off).
