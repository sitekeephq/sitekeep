# Viewers (DWG, documents, spreadsheets, presentations…)

Files open inside the system without downloading. Everything runs on the server and in the browser; no internet connection is needed.
All components are open source and redistributable.

**Office files need no extra software on the server.** Word, OpenDocument text, PowerPoint and Excel
files are shown in the browser with open-source libraries. If the server has a **converter** (optional add-on),
two things are added: a PDF with the exact page layout, and previews of legacy binary formats (.doc, .rtf, .ppt, .pps, .odp).

## How it works

- The file list, the file drawer and search results have an **Open** button.
- A single registry decides which viewer opens: `packages/shared/src/viewers.ts`.
- PDFs open in the PDF viewer (`/p/:pid/view/:vid`), IFC files in the model viewer. These have not changed.
  The **2D Take-off** link in the PDF viewer opens the same page with scale and measurement tools ([2D Take-off](2D_TAKEOFF.md)).
- Everything else opens on the `/p/:pid/open/:vid` page. A file without a preview shows a "No Preview — Download" card.
- For some formats the server generates a **preview** after upload (job queue, one job at a time).
  States: `pending`, `processing`, `ready`, `failed`, `unavailable` (tool not installed).
- For office files only the **text** is read after upload (no converter needed). If a converter exists, a PDF is made afterwards as well.
- Previews of older versions are queued the first time they are opened.
- The "view" permission is enough to view. The download permission is not required.

## Supported formats

| Type | Extensions | In the browser (no extra software) | With a converter (optional) | Text indexed for search |
|---|---|---|---|---|
| PDF | pdf | PDF viewer (markup) | — | first 200 pages |
| Word | docx, docm, dotx | Document viewer (docx-preview): pages | "Open in Page Layout (PDF)", markup | from XML |
| OpenDocument text | odt, ott | Simple view: headings, paragraphs, lists, tables, images | "Open in Page Layout (PDF)" | from XML |
| Legacy document | doc, rtf | "Converter Needed for Preview" + download | PDF viewer | from the PDF (converter only) |
| PowerPoint | pptx, pptm, ppsx | Slide viewer (pptx-renderer) | slides from the PDF if available | slides + notes |
| Legacy presentation | ppt, pps, odp | "Converter Needed for Preview" + download | Slide viewer (PDF) | from the PDF (converter only) |
| Spreadsheet | xlsx, xlsm, xlsb, xls, ods, csv, tsv | Spreadsheet viewer (SheetJS, JSON on the server) | "Open in Page Layout (PDF)" | cell values |
| Drawing | dwg, dxf | DWG/DXF viewer | DWG: LibreDWG → DXF | TEXT, MTEXT, attributes, leaders |
| Image | png, jpg, jpeg, gif, webp, bmp, svg, avif | Zoom/pan | — | — |
| Text | txt, log, json, xml, ini, cfg, conf, yaml, yml, ifcxml, bcf, sql | Text with line numbers | — | yes |
| Markdown | md, markdown | Markdown (the component used in Ask) | — | yes |
| Video / audio | mp4, m4v, webm, ogv, mov / mp3, wav, ogg, oga, m4a, aac, flac | HTML5 player | — | — |
| E-mail | eml | Headers, plain-text body, attachment names | — | yes |
| IFC | ifc | Model viewer: walk, plan, section, measure (section below) | — | — |

Other extensions (rvt, nwd, msg, tiff…): "No Preview — Download".

"Open in Page Layout (PDF)" appears only if the PDF is ready or the server has a converter.
Without a converter this button never appears; the file still opens in the browser.

### IFC model viewer

IFC models open in the Model → Viewer tab (`/p/:pid/viewer`). The view runs entirely in the browser with That Open
Components/Fragments and three.js; no internet connection is needed. On desktop, the view cube with orbit, walk and plan
modes, plus the section, measure, visibility, X-Ray and PNG snapshot tools, are in the bar on the right. On phones **Models**,
**Fit** and **Ask the Model** stay at the top; the other tools move to the **⋯ More** menu.

Shortcuts:

| Key | Function |
|---|---|
| `1` / `2` / `3` | Orbit / Walk / Plan |
| `W A S D` or arrow keys | Walk; `Shift` run, `Q`/`E` down/up |
| Double-click | In Orbit/Plan mode, drop to that point and start walking |
| `F` | Fit |
| `K` / `B` | Section plane / section box |
| `M` | Measure length |
| `H` / `I` / `U` | Hide selection / show selection only / show all |
| `X` / `G` | X-Ray / take PNG snapshot |
| `Enter` | Finish area measurement |
| `Esc` | Close help, the active tool or walking, in that order |
| `?` | Shortcuts |

Shortcuts do not work while a text field or dialog is open. In walk mode, clicking the canvas locks mouse look; `Esc` releases it.
On phones the joystick at the bottom left walks, and dragging the screen changes the view direction.

- **Walk:** eye height is 1.7 m above the floor. A downward ray follows the floor; tables/railings higher than 0.5 m do not count as floor.
  If there is no floor below, the height is kept. A forward ray stops forward movement at walls closer than 0.35 m; sideways and backward
  movement continue. Speed is 0.5–6 m/s.
- **Plan:** orthographic top view. Storeys come from the model index, or from the IFC `IfcBuildingStorey` data if needed.
  A horizontal section is placed 1.2 m above the selected storey, and at least 5 cm below the storey above. With several models, storeys come from the first model.
- **Section:** with `K` on, double-clicking a face creates a movable plane; several planes can be switched on and off.
  `B` creates a selection box with a 25 cm margin if there is a selection, otherwise a box around the whole model. Section fill can be turned off for heavy models.
- **Measure:** length with two clicks, angle with three; area is completed with a double-click or `Enter`. Volume is calculated from the selected elements.
  Snapping to points, edges and faces is available; results are shown in m, m², ° and m³ in Turkish number format.
- **Visibility:** hide/isolate/show all work on the selection. X-Ray makes unselected elements 12% opaque.
  The properties panel shows the IFC class, storey, GlobalId and copyable property values.

Sections and measurements are saved to issue viewpoints and model set views. They are restored when the view opens; if the saved
view has none, the current sections and measurements are cleared. Section planes are stored in scene coordinates, measurements as
points/values (for volume, a GUID list/value); this is compatible with older records.

**Curves.** Circles and arcs in IFC are split into straight segments during conversion (web-ifc `CIRCLE_SEGMENTS`).
**48 segments** are used per full circle; the chord sags inward by at most 0.25% of the radius (≈ 9 mm at r = 4 m).
Until 24.10.2026 the web-ifc default was 12: round canopies, kiosks and similar structures looked like angular
polygons, and elements behind them that Revit had already segmented (e.g. a red frame) stuck out through the middle of the
straight segments. A model converted before that date is reconverted in the background the first time it is opened; meanwhile
the old version stays open and the new one arrives on the next opening (if the conversion fails, the old version stays and it is
not retried). The value is changed on the server with `CDE_IFC_CIRCLE_SEGMENTS` (12–128);
the triangle count of curved elements is proportional to it (≈ 4× at 48 compared with 12).

IFC viewer limitations:

- Section fill depends on the Fragments `getSection` result; if unsupported only lines remain, and on error only the cut.
- With several unaligned models, the section line of the second model may be offset.
- PNG snapshots include measurement lines drawn on the canvas, but not the HTML measurement labels.
- Storeys without an elevation cannot be selected in Plan mode; the IFC elevation unit is guessed as metres/millimetres from the model height.
- Walk collision uses a single forward ray; it may miss grazing contact at wide angles and the top of low doors.
- On phones the section plane relies on a double tap. Volume may be approximate for non-closed geometry.

### Viewer features

- **Word (docx):** page size and margins, headers/footers, tables, images, footnotes, embedded fonts.
  Zoom (−/+, percent), **Fit** (window width), page count, **Search in document** (Ctrl+F; insensitive to Turkish İ/ı,
  all matches highlighted, navigate with Enter/↑↓). On phones the page opens fitted to the screen.
- **OpenDocument text (odt):** a small reader of our own (`apps/web/src/viewers/office/odf.ts`).
  Bold/italic/underline/colour, links (http/https/mailto only), lists, tables (merged cells), embedded images.
  Not the page layout but a "Simple View". Search and zoom are the same.
- **Presentation (pptx):** thumbnail strip, next/previous, arrow keys (←/→, PageUp/PageDown, Home/End), **Presentation Mode** (F; exit with Esc),
  speaker notes (from the text preview on the server; no converter needed). Slides are drawn in the browser: text formatting,
  bullets, images, shapes, groups, tables, charts, backgrounds and theme colours. If the converter's PDF exists it is
  shown first (exact); switch with "Browser View". "Mark Up" opens the PDF with the markup tools.
- **Spreadsheet:** sheet tabs, hidden sheets dimmed, frozen header row/column, "Freeze First Row", column widths,
  merged cells, Turkish numbers/dates (1.234,50 · 15.03.2026 · also the dd.mm.yyyy format), search in sheet, full value of the selected cell.
  Rows and columns are virtualised: 50 000+ rows scroll smoothly. Formulas are not calculated; the last value stored in the file is shown.
  Reading is done on the server with SheetJS; LibreOffice is not needed.
- **DWG/DXF:** pan/zoom, **Fit** (the main body of the drawing; distant stray objects excluded) and **Show All**,
  layer list (search, on/off, **Turn All On / Turn All Off**), "Model Space Only", dark/light background, measurement tools
  and **Info** (below: "DWG/DXF measurement and inspection"). Noto Sans is embedded for Turkish characters. A separately loaded
  lazy chunk; parsing happens in a web worker. For old DXF files the code page (`$DWGCODEPAGE`, e.g. ANSI_1254) is read on the server.
  The server prepares the **2D scene** of each drawing once; if it is ready the browser opens it without parsing the DXF at all
  (see [Large drawings: 2D scene](#large-drawings-2d-scene)). Civil 3D drawings and unreadable DWGs are explained with a card instead of an empty canvas.
- **Image:** zoom with the wheel/two fingers, pan by dragging, Fit, 1:1.
- **E-mail:** the HTML body is not executed; it is converted to plain text.

### Print / Save as PDF

The Word, ODT, presentation and spreadsheet views have a **Print / PDF** button. The browser's print dialog opens;
choose "Save as PDF". The application is hidden and only the document is printed.

- Word: each page on its own sheet of paper, in the document's own page size (A4; landscape sections landscape).
- ODT: A4, 20 mm margins.
- Presentation: one slide per page, in the slide size (16:9 or 4:3). Charts are printed once they have finished drawing.
  If the converter's PDF is open, that PDF opens in a new tab and is printed from there.
- Spreadsheet: "This Sheet" or "All Sheets"; A4, narrow tables portrait, wide tables landscape and scaled to the page width.
  Each sheet starts on a new sheet of paper. At most 5 000 rows per sheet.

The dialog states clearly that the page layout is **approximate**. For an exact PDF the administrator can enable a converter on the server.

### DWG/DXF measurement and inspection

Code: `apps/web/src/viewers/cad/` (UI `CadMeasure.tsx`; pure TS modules `geometry.ts`, `units.ts`, `measure.ts`,
`snap-index.ts`, `scene-geometry.ts`, `bounds.ts`, `cad-phone.ts`). Tests: `apps/web/test/cad-*.test.ts` (synthetic data).

- **Tools** (one active): **Length** (two points, with ΔX/ΔY), **Chain Length** (multi-segment; ends with a double-click, Enter or
  **Finish**), **Area** (polygon: area + perimeter), **Angle** (arm end → vertex → arm end, 0–180°), **Coordinate** (real
  drawing coordinate) and **Info** (layer and type of the line nearest to the click: Line, Polyline, Arc, Circle, Point).
  Esc cancels the measurement being drawn first, then the tool; Backspace deletes the last point. Dragging pans even while measuring.
- **Results list:** top right (bottom on phones); each row can be deleted, **Clear Measurements**, **Copy to Clipboard** (plain text; also works
  on http addresses without the Clipboard API). Measurements are kept in real drawing coordinates; they survive reloading with
  "Model Space Only". If the user has markup permission in the folder, **Add To Take-off** on Length, Chain Length and Area rows
  saves the measurement to the 2D quantity take-off (metraj) in drawing units ([2D Take-off](2D_TAKEOFF.md)).
- **Coordinates:** for precision, dxf-viewer shifts the geometry to an origin; this point is added back to the displayed
  coordinate (UTM-like values such as 423000 / 4550700 appear correctly). Length and area are not affected by the shift; area is
  calculated relative to the first vertex to avoid precision loss at large coordinates. In the 2D scene prepared by the server, the
  origin is the centre of the drawing's robust body (`robustBounds`, `packages/shared/src/cad-bounds.ts`); a stray object at 0,0
  cannot reduce UTM geometry to float32 resolution (≈ 0.5 m).
- **Snap** (on/off, remembered in the browser): **Endpoint**, **Midpoint**, **Centre** (circle/arc), **Nearest** (nearest point
  on a line); a small marker and its name appear at the cursor. The source is the loaded scene itself (vertex/index buffers per
  batch, block instances with their transforms), not the DXF; it works whoever produced the scene. Because circles and arcs are
  segmented in the scene, they are recognised again from runs of equal-length segments turning by a constant angle (centre + arc
  midpoint; inner vertices do not count as endpoints). The index is built when a tool is first opened: a uniform grid for world
  geometry, and for each block geometry a local grid + a grid of instance boxes. 600 000 segments: build < 1 s, queries under a
  millisecond. Hidden layers are not snapped to. On phones the touch tolerance is wider.
- **Units:** `$INSUNITS` / `$MEASUREMENT` come from the server's drawing check (the `meta.cad` field of the `dxf` preview; no extra
  download); for older previews without this field they are read from the DXF header (only the start of the file is streamed, so a large file is not downloaded twice).
  The display default is metres, in Turkish format ("12,34 m", "56,70 m²", "45,0°"); the **Display Unit** selection offers mm / cm / m. The "Drawing Unit:
  mm" label shows the detected unit; if the file has no unit, metres are assumed and stated, and this can be changed manually
  with the **Drawing Unit** selection (mm, cm, m, inch, foot).
- **Fit:** robust bounds from the vertices in the scene (`bounds.ts`). On each axis the sorted values are split into clusters at
  gaps wider than 1% of the range; the cluster with the most points is the core. The core grows into a neighbouring cluster if the
  gap is at most twice the size of the larger of the two. X and Y are repeated in turn on the remaining points until nothing changes. This way
  paper space (layout) at 0,0, mirrored blocks at −y and the odd object at absurd coordinates do not shrink a UTM drawing to a dot;
  separate elevations, sections, the legend and the title block (antet) on the same drawing sheet (pafta) stay together. A cluster
  group that is left out is not cut if its weight is close to the core's (two equal drawings). The first opening also uses this view. **Show All** shows the real full bounds.
- **Background:** dark/light; colour 7 (white/black) is visible on both (colour corrected for the background). Measurement layer colours are also
  chosen according to the background.
- **Phone (≤ 700px):** Fit and Layers stay in the bar; Show All, the tools, Snap, Background, Model Space Only,
  Copy to Clipboard and Clear move to the "⋯ More" menu. Measuring is done by tapping; a double tap or **Finish** ends a chain.
- **Not done:** no *drawing sheets* (layout tabs): separating paper space objects by layout would require changing the upload path (scene
  generation) or dxf-viewer. No *Save as Issue*: the file preview page has no way yet to create an issue or
  markup from the view. No object counts in layers: they cannot be read cheaply from the scene.

## Large drawings: 2D scene

A large DWG can turn into a DXF of more than 150 MB with LibreDWG (hundreds of thousands of LINEs inside blocks). Parsing this text in
the browser is slow, needs gigabytes of memory and does not work at all on phones. So the server does the work that dxf-viewer
does in the browser **once** itself and stores the result:

1. **DXF** (`dxf` preview): DWG → DXF (LibreDWG) or the uploaded DXF. Then **repair** and the **drawing check** (below).
2. **2D scene** (`scene` preview): queued automatically once the DXF is ready. A worker thread
   (`apps/server/src/previews/scene-worker.ts`) reads the DXF with dxf-viewer's own parser and builds the `DxfScene`
   with the same fonts as the browser (Noto Sans latin + latin-ext). The result is a single binary file, gzipped,
   stored next to the other previews (`projects/<project>/previews/`); it is tied to the version, so a new version means a new scene.
   No database migration is needed (`version_previews` row, `kind = "scene"`). For drawings converted earlier, the scene is queued on first opening.
3. **Browser** (`apps/web/src/viewers/cad/scene-loader.ts`): if the scene is ready, a fake worker is passed to dxf-viewer's
   `workerFactory` option. This worker answers DxfWorker's message protocol (LOAD → PROGRESS → LOAD response, DESTROY) with the
   downloaded scene. The viewer receives exactly the scene object it would have built itself; dxf-viewer is neither patched nor forked.
   Tools such as measurement and snapping read the same scene.

**Scene file** (`7DSCENE1`): 8-byte magic word, 4-byte JSON length, JSON (format version; drawing header:
`$INSUNITS`, `$MEASUREMENT`, `$EXTMIN/$EXTMAX`, `$ACADVER`; scene: batches, coloured layers, origin, bounds;
buffer locations), then the 8-byte-aligned `vertices` (Float32), `indices` (Uint16), `transforms` (Float32) buffers.
The buffers are written **byte-shuffled** (first all first bytes, then all second bytes…); this way gzip compresses floating-point
data roughly twice as well. The browser decompresses gzip natively (`Content-Encoding: gzip`) and reverses the shuffle.

**Origin:** dxf-viewer takes the first vertex it encounters as the origin; if there is a stray object at 0,0, geometry with UTM
coordinates drops to ≈ 0.25–0.5 m resolution in float32. Before building the scene, the server computes robust bounds
(`robustBounds`, the function Fit uses) from the vertex/centre/insertion points of top-level objects and places the origin at the
centre of that box (in a 2.1 MB survey drawing sheet, x ≈ 389 500, y ≈ 4 546 415 instead of 0,0).

**Model Space Only:** if the drawing contains paper space objects, the server builds a second scene too (`?space=model`); otherwise
both views are the same and a single scene is used.

**What the viewer does** (`apps/web/src/viewers/cad/CadGate.tsx`):

| State | Shown |
|---|---|
| Scene ready | The scene is downloaded ("Downloading …%"); the DXF is not parsed. |
| Scene in preparation, DXF ≤ 60 MB | The DXF is parsed in the browser as before (not reloaded when the scene is finished). |
| Scene in preparation, DXF > 60 MB, computer | "Preparing: Reading the drawing / Building the scene / Packing…" card; **Open Raw DXF** opens it without waiting. |
| Scene in preparation, DXF > 60 MB, phone | Same card, no button to open the DXF; it opens automatically when the scene is finished. |
| Scene could not be built, DXF > 60 MB, phone | "Too large to open on a phone" card, **Try Again**, **Download**. |
| Civil 3D | "Civil 3D Drawing" card: "This drawing contains Civil 3D objects (alignments, corridors, surfaces). The open-source converter cannot read these objects. Save it in Civil 3D with 'Export to AutoCAD' (EXPORTTOAUTOCAD) and upload it again; for a 3D model, export it as IFC 4.3." Below it the counts of objects, Civil 3D classes and converter errors, **Download**. |
| No objects (conversion failed) | "Drawing Could Not Be Read" card. |
| Partial conversion | The drawing opens; a small warning in the corner ("… could not read some objects (N errors)" or "Civil 3D objects cannot be shown"). |

**Drawing check** (`cadCheck`, the `meta.cad` field of the `dxf` preview): the `ERROR` lines written by dwg2dxf (counted over the whole
stderr), the `AECC_*` classes in the DXF's CLASSES section, object counts in the ENTITIES section (model + paper) and inside
blocks, `$INSUNITS` and `$EXTMIN/$EXTMAX`. AECC class present and at most 5 objects → `civil3d`; no objects at all →
`empty`; objects present but 100 or more converter errors (a few dozen harmless errors are normal) or an AECC class → `partial`; otherwise `ok`. No scene is built for `civil3d` and `empty`.

**Repair** (`DxfPairRepair`, `repairDxfFile`): the DXF is read line by line as a stream (latin1; bytes stay unchanged). If a line that should be a group
code is not an integer, or is an integer but the following value does not match that code's type (text where a number is
expected), the line is a continuation of the previous value: in MTEXT text (codes 1 and 3) it is appended with `\P` (paragraph), elsewhere with a space.
The number of joined lines is in `meta.repairs`. Fast path: if the check (which already reads every DXF line by line) finds all code lines to be
integers, the repair does not run at all; an uploaded DXF is stored as is (`original: true`), a converted DXF without being rewritten.
Both the raw DXF path and the 2D scene work from the repaired DXF. Measured on LibreDWG 0.13 output: 107 joins in a 12 MB DXF, 1 in 17 MB, 98 in
171 MB; after repair all three are read by dxf-viewer's parser, and the objects counted by the parser match those of the 0.14 output
(10 179 / 21 084 / 541 top-level, 20 509 / 2 892 / 581 825 inside blocks). 0.14 output needs no repair.

**Why not That Open Fragments?** Fragments is a format made for **3D BIM meshes** from IFC (meshes, element IDs, properties);
the IFC viewer uses it. A 2D drawing has no meshes: it has lines, text triangles, block instances and
layer colours. Their natural format is dxf-viewer's own scene. The 2D scene is the 2D counterpart of Fragments:
a derivative produced once on the server, tied to the version, compressed and loaded directly.

**Measurements** (ARM laptop, Node 24, worker thread; LibreDWG 0.14 output; real project drawings were measured locally only):

| DWG | DXF | Check (no repair needed) | Parse | Scene build | Packing + gzip | Scene (raw → gzip) | Model only |
|---|---|---|---|---|---|---|---|
| 22.6 MB, AC1021 (≈ 580 000 LINEs inside blocks) | 173 MB | 3.1 s | 4.5 s | 1.6 s | 2.3 s (two scenes) | 34.2 → 17.2 MB | 29.2 → 15.1 MB |
| 2.1 MB, AC1027 (UTM, metres) | 17.4 MB | 0.2 s | 0.3 s | 0.4 s | 0.6 s (two scenes) | 32.9 → 11.3 MB | 2.2 → 0.9 MB |
| 1.6 MB, AC1032 | 12.1 MB | 0.1 s | 0.3 s | 0.5 s | 0.2 s | 9.6 → 4.2 MB | — (no paper space) |
| 6.4 MB Civil 3D, AC1024 | 0.15 MB, ENTITIES empty | < 0.1 s | — | — | — | Civil 3D card | — |

DWG → DXF (dwg2dxf) is separate from these: ≈ 17 s for the largest drawing. If the check finds a non-integer line among the code lines,
repair runs (LibreDWG 0.13 output: + 5.3 s for 171 MB, + 0.3–0.5 s for 12–17 MB); 0.14 output does not need it. The browser downloads 17 MB instead of 173 MB of text and parses
nothing. The DXF itself would be ≈ 14 MB with gzip, but parsing it in the browser takes seconds and gigabytes of memory.
Without byte shuffling, the scene of the same 2.1 MB drawing was 21.0 MB with gzip (now 11.3 MB). Because the scene carries text as
triangles, it can be larger than the DXF for text-heavy drawings.

## AI hook

- Preview jobs write the file's text to the `version_texts` table (at most 200 000 characters per version).
- For office files this job is the `text` preview: the text of docx/docm/dotx, pptx/pptm/ppsx (slides + notes), odt/ott/odp
  is read from the XML parts. **No converter needed.** Notes are also written to the preview's `meta.notes` field (slide viewer).
- Project search (`GET /projects/:pid/search?q=`) now also searches the **content** of the current version. The result returns a short `snippet`.
- The `cde_search_files` tool of the "Ask" assistant uses the same search; it sees the matching part in the `match` field.
- Text of legacy binary formats (.doc, .ppt, .rtf) is read from the PDF, and only if a converter exists.
- Test: `apps/server/test/viewers.test.ts` → "works without any converter…" (docx/pptx/odt search and notes without a converter).

## Components and licences

| Component | Version | Licence | Where | Note |
|---|---|---|---|---|
| docx-preview | 0.4.1 | Apache-2.0 | web (lazy) | Word viewer. Embedded HTML (altChunk) disabled; `javascript:` links are removed. |
| @aiden0z/pptx-renderer | 1.3.0 | Apache-2.0 | web (lazy) | PowerPoint viewer. Used unmodified. Contains an unmodified `mtx-decompressor` (MPL-2.0, file-based; decompresses embedded fonts); the licence text is in the package. |
| Apache ECharts (+ ZRender) | 6.1 | Apache-2.0 (ZRender: BSD-3-Clause) | web (lazy) | Chart rendering for pptx-renderer. |
| JSZip | 3.10.1 | MIT (choice of MIT or GPL-3.0; MIT chosen) | web (lazy) | Reading docx/odt/pptx ZIPs. Already present (@thatopen). |
| SheetJS Community Edition (`xlsx`) | 0.20.3 | Apache-2.0 | server | `xlsx` 0.18.5 on npm is old and has known vulnerabilities. The official package is installed from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (this address is in package-lock). |
| dxf-viewer | 1.0.49 | MPL-2.0 | web (lazy) | Used unmodified. MPL is file-based; it does not affect our own code. |
| That Open Components (`@thatopen/components`, `@thatopen/components-front`, `@thatopen/fragments`) | 3.4 | MIT | web | Model viewer. The That Open text on the canvas is turned off with the official `showLogo = false` setting; attribution is in My Account → About and in the viewer's Shortcuts dialog: "The viewer runs on That Open Company's open source components (MIT)." |
| three.js | 0.186 | MIT | web | Already present (IFC). |
| opentype.js | 1.3.x | MIT | web | dxf-viewer dependency. |
| Noto Sans (`@fontsource/noto-sans`) | 5.x | OFL-1.1 | web | latin + latin-ext WOFF; DXF text. |
| pdf.js (`pdfjs-dist`) | 6.3 | Apache-2.0 | web | Already present; the slide viewer uses it too. |
| ONLYOFFICE Docs / Collabora Online / Gotenberg | — | AGPL-3.0 / MPL-2.0 / MIT | separate service, **optional** | Converter add-on (compose profile). See OFFICE_INTEGRATION.md. Not needed for viewing. |
| LibreOffice (soffice) | 7.x+ | MPL-2.0 | server, separate process, **optional** | Last-resort local converter; not in the Docker image. Not needed for viewing. |
| LibreDWG `dwg2dxf` | 0.14 | GPL-3.0-or-later | server, separate process | See the note below. 0.14 or later required. |

**LibreDWG (GPL) note:** dwg2dxf is a separate program. The server only calls it from the command line
(file in, DXF out); it is not linked as a library. This is an "aggregate"; the SiteKeep code does not become GPL.
Because the Docker image contains the dwg2dxf binary, access to the LibreDWG source must be provided as the GPL requires when the
image is given to a customer: the version in the image is `LIBREDWG_VERSION` (default 0.14), the source is at `https://ftp.gnu.org/gnu/libredwg/`.

**LibreDWG 0.14 or later is required.** 0.13 writes MTEXT/TEXT/attribute values (those with font codes) split across
line breaks; the DXF's code/value line pairs shift and the browser stops with a "Cannot parse group code" error.
The server passes every DXF through a **repair pass** (see the 2D scene section); 0.13 output opens too, but the split text
is joined and 0.13 does not read some objects in some drawings that 0.14 reads. For every conversion that needs repair the server
writes a log note; if `dwg2dxf --version` reports a version number, it also writes a warning on the first conversion for versions older than 0.14 (some builds
print only a git ID; for those only the repair note appears).
If LibreDWG is not wanted, use `--build-arg WITH_LIBREDWG=0`; DWGs then stay in the "no preview tool" state, while DXFs open.

**Not chosen (presentations):** `pptx-preview` says ISC on npm, but its source code is not open; the author's terms forbid
publishing the source, so it is not open source. `@jvmr/pptx-to-html` (MIT) was tried: it uses a single text style per text
box (one bold/coloured bullet colours the whole box). PPTXjs and pptx2html are old and depend on jQuery.

**Not chosen (DWG):** `@mlightcad/libredwg-web` (a WASM build of LibreDWG) would add GPL code to the browser bundle;
it was not chosen to keep the web bundle free of GPL. Commercial DWG SDKs (ODA etc.) are not open source.

## Installation

### Office → PDF converter

Nothing needs to be installed for viewing. The converter is an **optional** add-on: for a PDF with the exact page layout
("Open in Page Layout (PDF)", markup) and previews of legacy .doc/.rtf/.ppt/.pps/.odp files.
The administrator chooses it under **Administration → Office Integration**. Details: [docs/features/OFFICE_INTEGRATION.md](OFFICE_INTEGRATION.md).
If a converter is selected, the PDF of uploaded office files is made automatically; the "Open in Page Layout (PDF)" button then appears.

| Option | How it is called | Note |
|---|---|---|
| Automatic (default) | The editor's server if an editor is configured, otherwise soffice on this server | If neither exists, no PDF is made; files still open in the browser. |
| ONLYOFFICE | ConvertService API, JWT | ONLYOFFICE downloads the file from the CDE via a single-use address. |
| Collabora | `POST /cool/convert-to/pdf` | The CDE server must be allowed with `net.post_allow`. |
| Gotenberg | `POST /forms/libreoffice/convert` | Only converts. MIT licensed. |
| Local soffice | `soffice --headless --convert-to pdf` | Last resort; only if installed on the server. |

- The Docker image has **no LibreOffice**. For conversion, enable one of the compose profiles
  (`--profile onlyoffice`, `--profile collabora` or `--profile gotenberg`).
- Without a converter the PDF is not queued; docx/odt/pptx/xlsx open in the browser. If the converter is unreachable the PDF becomes
  `failed`/`unavailable`; after the administrator connects one, "Open in Page Layout (PDF)" or **Retry PDF** is enough.
- Text search does not depend on the converter: docx/pptx/odt text and presentation notes are read from XML.
- Timeout, maximum file size, number of concurrent conversions and retries are set on the administration page.

### Docker

`docker compose build` only adds LibreDWG to the image (DWG → DXF).

- `--build-arg WITH_LIBREDWG=0`: without LibreDWG.
- `--build-arg LIBREDWG_VERSION=…`: a different LibreDWG version (0.14 or later).

### Windows (development / single server)

1. For office PDFs, either connect a converter service or, as a last resort, install LibreOffice:
   `winget install TheDocumentFoundation.LibreOffice`. `C:\Program Files\LibreOffice\program\soffice.exe` is found automatically.
2. LibreDWG: extract the Windows (win64) package from LibreDWG's GitHub releases page. Set the `dwg2dxf.exe` path with `CDE_DWG2DXF_PATH`.
3. Restart the server. The `viewers: soffice …, dwg2dxf …` line in the log shows the paths found.

### Linux

```sh
# LibreDWG from source (not in the Debian/Ubuntu packages):
curl -fsSL https://ftp.gnu.org/gnu/libredwg/libredwg-0.14.tar.xz | tar -xJ
cd libredwg-0.14 && ./configure --disable-bindings --disable-shared && make -j && sudo make install-strip
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CDE_OFFICE_CONVERTER`, `CDE_OFFICE_CONVERTER_URL` | `auto`, empty | Default converter (the administration page takes precedence). See OFFICE_INTEGRATION.md. |
| `CDE_SOFFICE_PATH` | install paths, then PATH | Last-resort soffice path. If set but the file does not exist, it counts as "no tool". |
| `CDE_DWG2DXF_PATH` | install paths, then PATH | dwg2dxf path. |
| `CDE_CONVERT_TIMEOUT_MS` | 180000 | Default timeout for a single conversion. If exceeded, the preview is `failed`. |

Local soffice and dwg2dxf run in their own temporary folder for each conversion; one conversion runs at a time.
The administrator can also see the status with `GET /api/v1/admin/converters` (`office` field: active converter).

## API

| Endpoint | What it does |
|---|---|
| `GET /projects/:pid/versions/:vid/preview` | Viewer type, preview states (queues missing ones) and `pdfConverter` (whether the server can make office PDFs). |
| `POST /projects/:pid/versions/:vid/preview/:kind` | Request / retry a preview (`pdf`, `sheet`, `dxf`, `scene`, `text`). |
| `GET /projects/:pid/versions/:vid/preview/:kind` | The preview itself (PDF, gzip JSON, DXF, 2D scene, plain text). `scene`: `Content-Encoding: gzip`, `ETag` + `Cache-Control: private, no-cache` (the browser revalidates with 304), `X-Scene-Bytes` (uncompressed size, for progress), `?space=model` model space only. |
| `GET /projects/:pid/versions/:vid/pdf` | PDF for the PDF viewer: the file itself or the PDF of an office file. |
| `GET /projects/:pid/versions/:vid/media` | Image/video/audio/text content and office files drawn in the browser (docx, odt, pptx), with `Range` support. |
| `GET /admin/converters` | Status of the office converter, soffice and dwg2dxf (administrator). |

Database: `version_previews` (version × kind: status, file, error, meta) and `version_texts` (search text).
The IFC `file_versions.derivative_*` fields were not touched. Migration: `apps/server/drizzle/0017_viewers.sql`.

## Limitations

- Spreadsheet: at most 2 million cells, 200 000 rows and 1000 columns per sheet; anything beyond is cut ("cut off at the limit").
  Cell colours, borders, conditional formatting, charts and images are not shown. Formulas are not recalculated.
- Excel's "frozen panes" are not read; there is a "Freeze First Row" button instead.
- Presentation notes are read from pptx only.
- DWG/DXF: only model space and "hide paper space" are available; no selection of individual layouts. Noto Sans instead of SHX fonts.
  DWG support depends on LibreDWG (R2000–R2018 mostly readable; some newer objects may be missing). No text search in binary DXF.
  Measurement and snapping work on the drawn geometry (see below); drawing sheets (layouts) cannot be selected individually.
  Civil 3D objects (alignments, corridors, surfaces…) cannot be read with open-source tools; these drawings are explained with a card.
- Image: TIFF and HEIC do not open in the browser. Video/audio is limited to codecs the browser supports.
- E-mail: .msg is not supported. Attachments do not open; only their names are listed.
- The text viewer shows the first 2 MB / 50 000 lines of a file.
- Word (browser): pages come from the page breaks Word saved and from manual page breaks; the browser does not paginate
  by itself. So the page count is approximate, and a long section spills onto the next sheet when printed. Field codes (page number) show the last
  value stored in the file. Tracked changes and comments are not shown. If a font is not on the computer, a similar one is used.
- ODT (browser): simple view; no page layout, headers/footers, footnotes or text box positioning.
- Presentation (browser): no animations or transitions, video/audio is not played. Non-embedded fonts may look different.
  Word files over 60 MB and presentations over 80 MB ask first with a "Large File" card (browser memory).
- Browser printing is approximate. The exact result is the converter's PDF; that in turn depends on the fonts installed on the server.

## Test

`npm test` needs neither LibreOffice nor LibreDWG: the converters are tested with a fake process (mock)
(success, timeout, no tool, error, Civil 3D). Tests: `apps/server/test/viewers.test.ts`, `apps/server/test/cad-scene.test.ts`
(DXF repair, drawing check, 2D scene: byte-for-byte identical to the scene the browser builds, upload path decision) and `packages/shared/test/viewers.test.ts`.
The drawings in the tests are synthetic (thousands of LINEs inside a block, an empty drawing with AECC classes); no real project drawing goes into the repository.
Web helpers (ODT reader, search in document, print dimensions) are under `apps/web/test/` and run with `npm test` at the root.
