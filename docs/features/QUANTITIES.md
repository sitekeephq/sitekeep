# Quantity Inventory

Element-level quantity take-off (metraj) of an IFC model, and the quantity difference between two versions of the same model. Quantities are read from the model;
AI does no calculation, and the same model always gives the same numbers.

## Where to Open It

- **Planning and Analysis → Quantities**.
- Address format: `/projects/<proje>/quantities?v=<versiyon>&from=<eski versiyon>&g=class,storey`.
  - Without `v`, the current version of the first IFC model opens.
  - If `from` is given, the difference view opens.
  - `g` is the grouping.

## Screen

- **Model / Version / Compare** selectors. "Compare With V<n>" selects the previous version.
- **Group By:** Class, Storey, Type, Material (up to three together). Storeys are sorted bottom to top, the others alphabetically.
  Elements without a value fall into the "No storey", "No type", "No material" group.
- **Totals:** element count, net volume, net area, openings, length and the number of elements without quantities.
- **Group table:** count, net volume (m³), gross area, openings, net area (m²), length (m), weight (kg).
  - Expanding a row shows the group's elements and the property each value was read from (e.g. `Qto_WallBaseQuantities.NetSideArea`).
  - For an element with openings, the Openings cell shows the number of openings ("2 Openings"), unmeasurable openings, and "Model: … m²" if the
    model's own gross − net value differs. Hovering shows the door / window names.
- The note below the totals says where the openings come from (geometry or gross − net) and counts openings that differ or could not
  be measured.
  - "Show in Model" selects the group's elements in the viewer (first 300).
- **Difference view:**
  - Totals old → new and the difference.
  - Changed groups: the largest change on top. The numbers of added / removed / changed elements and the measurement differences are shown.
  - Changed elements: added, removed or with changed quantities. A removed element opens in the old version.
- **Export to Excel:**
  - Inventory: "Quantity Summary" and "Elements" sheets. The Elements sheet has GlobalId, the opening count, the model's own
    opening area and the source property.
  - Difference: "Quantity Difference" and "Changed Elements" sheets; old / new / difference for each measurement.

## How Quantities Are Read

The source is IFC's base quantity sets: `Qto_*` (IFC4) and `BaseQuantities` (IFC2x3, Revit).

| Measurement | Quantity read |
| --- | --- |
| Net / gross volume | `NetVolume`, `GrossVolume`; if neither exists, `Volume` |
| Net / gross area | For walls `NetSideArea` / `GrossSideArea`; for slabs etc. `NetArea` / `GrossArea`; otherwise `NetFootprintArea` / `GrossFootprintArea`; if none exists, `Area` (net) |
| Openings | openings measured from geometry (below); for an element without openings, gross area − net area (if both exist) |
| Length | `Length` |
| Weight | `NetWeight`, otherwise `GrossWeight`, otherwise `Weight` |

- Volume, area and length missing from the base quantity set are read from Revit's `Dimensions` set.
- Length, area and volume written as numbers are converted to metres using the model's unit (`IfcUnitAssignment`: mm, cm, ft …).
  Values with the unit written in the text ("3,5 m") are read as they are.
- Spaces (IfcSpace) and opening elements (IfcOpeningElement) are not counted.
- The difference is found by GlobalId. Differences smaller than 0.0005 do not count as a change.
- An element that moved to another group (its storey, type or material changed) counts as changed.

## Openings

Door, window and shaft openings are measured from the model's geometry; whether the exporter deducted them from the net area is not considered.

- For each `IfcRelVoidsElement`, the index records the opening (`IfcOpeningElement`), the door / window filling it
  (`IfcRelFillsElement`) and the body geometry.
- Geometry read: `IfcExtrudedAreaSolid` (directly, inside an `IfcMappedItem`, or the first operand of an
  `IfcBooleanClippingResult`). Profiles: rectangle, rounded rectangle, circle, ellipse, and closed profiles drawn with
  `IfcPolyline` / `IfcIndexedPolyCurve` (inner voids are deducted). Others count as "not measurable" and are not deducted.
- Face area of the opening: of the profile's two sides and the extrusion depth, the shortest dimension closest to the element
  thickness (not shorter than 90% of the thickness) is taken as the "pass-through" direction; the area of the remaining two dimensions
  is deducted. This way, both an opening drawn on the wall face that cuts through the wall and a window opening Revit draws in plan and
  extrudes upwards are measured correctly.
- The thickness comes from the `Width` / `Thickness` quantity, otherwise from gross volume / gross area. The deducted area cannot exceed the gross area.

| Present in the model | Result |
| --- | --- |
| Gross area | net = gross − geometric openings |
| Net area only (e.g. Revit `Dimensions.Area`) | gross = net + geometric openings |
| Gross volume, no net volume | net volume = gross volume − opening area × thickness |
| Net volume | stays as is |

- The model's own gross − net value is stored as "Model: … m²"; if it differs from the measured openings by more than 0.01 m², the element
  counts as "differing".
- In the source column, values based on geometry are shown as "Gross − Geometric Openings", "Net + Geometric Openings" and so on.
- An index written before openings were read is rebuilt once on first opening (409, "being rebuilt with opening
  measurements"). If it cannot be rebuilt, the page opens with gross − net and the note says so.
- When two versions are compared, openings from geometry are deducted only if both indexes have them; otherwise both are
  calculated with gross − net. A reprocessed version does not show false differences.
- Suggest Items and 5D cost rules continue to use the exported value of the properties.

## Ask / MCP

`cde_quantity_inventory`:

- The project and version (or part of the file name) are given; grouping is optional.
- `compareWithPrevious` gives the difference from the previous version, `compareFromVersionId` the difference from the chosen version.
- The Ask assistant selects this tool for the words "metraj", "m³", "hacim", "net alan", "boşluk" (quantity take-off, m³, volume, net area, opening).
- The inventory response includes an `openings` summary: source (`geometry` / `model`), elements with openings, openings, unmeasurable
  openings and the number of differing elements.

## API

| Endpoint | What it does |
| --- | --- |
| `GET /projects/:pid/versions/:vid/quantities?groupBy=` | Totals and groups |
| `GET …/quantities/elements?groupBy=&group=&limit=` | Elements of a group (or the whole model), at most 5000 |
| `GET …/quantities/diff?from=&groupBy=` | Difference `from` → `vid`; at most 2000 changed elements |
| `GET …/quantities/export?groupBy=&from=` | Excel |

## Permissions

- Anyone who can see the model's folder can read. For others, the endpoints return 404.
- There is no write access.

## Limits

- **No measurement from geometry.** An element without quantities is counted only by number, and a "Without Quantities" warning appears.
  Export from Revit with "Export base quantities" turned on.
- **Opening geometry is read only from extrusions.** Openings drawn as B-rep, CSG or sweeps count as "not measurable"
  and are not deducted. For an inclined opening (not perpendicular to the wall), the face area is calculated from the profile and the slope is not corrected.
- Openings are deducted for one face of the wall (`GrossSideArea` is one face). A niche that does not fully pierce the wall also counts as an opening.
- The weight unit is not converted (kg is assumed).
- For indexes in the old format, the index is rebuilt on first opening (409); the page refreshes on its own.

## Suggest Items

For planners, the Quantities page has a **Suggest Items** button. It suggests unit prices (poz) for the element groups of the selected version; confirmed ones
become cost rules. Details: [POZ_SUGGEST.md](POZ_SUGGEST.md).

## 2D Drawing

The **2D Drawing** tab of the Quantities page lists PDF and DWG/DXF drawings with their group totals. A PDF page is calibrated and
length, area (with openings deducted) and count are measured; DWG/DXF measurements come from the CAD viewer with **Add To Take-off**.
Details: [2D_TAKEOFF.md](2D_TAKEOFF.md).

## Approval and Transfer to Progress Payments

The project administrator turns the 3D inventory, or a drawing's 2D totals, into a numbered approval with **Approve Quantities**
(**Approvals** tab). The groups in the approval are bound to items on the contract's **Quantity Bindings** tab, and the progress payment (hakediş)
is filled with **Fill From Approved Quantities**. Details: [QUANTITY_APPROVAL.md](QUANTITY_APPROVAL.md).
