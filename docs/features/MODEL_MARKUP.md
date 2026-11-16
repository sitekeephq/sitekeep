# Model markup (FP-3)

SiteKeep Community lets people mark up **IFC models** in the model viewer (Turkish: *İşaretleme*),
next to the existing PDF markup ([viewers](VIEWERS.md)), like the markup tools of Autodesk Forma
(parity principle: editions and modules §3.5,
development repository only). Everything here is Community: no module is needed.

## What a markup is

| Kind | What it stores |
|---|---|
| **Pin** (*Nokta*) | A point on a model element: the scene point, the element's IFC GlobalId and model version, plus the viewpoint it was placed from |
| **Drawing** (*Çizim*) | Pen, arrow, revision cloud, rectangle and text drawn over the current view, plus the viewpoint (camera) it belongs to |

Every markup also has a title, a colour, a **status** (open / closed), a **visibility** (private:
only the author; project: everyone who can see its models), an author and a **comment thread**.
Measurements, sections, hidden elements and the selection travel inside the viewpoint, exactly as in
issue viewpoints, so a measurement taken with the viewer's Measure tool is part of the markup.

| Column (`model_markups`) | Meaning |
|---|---|
| `file_id`, `version_id` | The model file and version the markup belongs to: the pin's model, or the first model of the view the caller may mark up |
| `version_ids` | Every model version of the view (a federated view has several) |
| `viewpoint` | The BCF issue viewpoint structure (`IssueViewpoint`, [BCF](BCF.md#viewpoint-visualizationinfo)): camera, `sceneOffset`, selection, visibility, sections, measurements and the snapshot with the drawing or pin burnt in |
| `anchor` | Pin: `{ point, globalId, fileVersionId, missing? }`, the point in the viewpoint's frame |
| `shapes` | Drawing, in **view units** (below); the shape types are those of PDF markup |
| `kind`, `title`, `color`, `status`, `visibility`, `author_id` | |
| `issue_id` | The issue created from the markup |
| `carried_from_id` | The markup on an older version this one was carried over from |

Comments live in `model_markup_comments`. Migration `0045_model_markups.sql` adds both tables.

**View units.** A drawing is stored relative to the view, not the model: origin at the centre of the
view, y down, one unit = 1/1000 of the view height (`viewToPx` / `pxToView` in
`packages/shared/src/coordination/model-markup.ts`). The vertical field of view (perspective) and the
visible height (orthographic, BCF `ViewToWorldScale`) fix what the camera shows vertically, so when
the viewpoint is restored in a narrower or wider window the drawing still covers the same part of the model.

## In the viewer

- **✎ Markups** (*✎ İşaretlemeler*) in the viewer's floating bar opens the markups panel on the right;
  on phones it is in **⋯ Diğer** and the panel opens under the model.
  `?markup=<id>` opens a markup directly (the address can be shared or reloaded).
- **📍 Pin Markup**: click (tap) a point of the model, give a title, colour and visibility. The
  pin is drawn as a coloured dot that follows the model.
- **✎ Draw on View**: the view is locked and a toolbar offers Pen, Arrow, Revision Cloud, Rectangle,
  Text, six colours and Undo. **Save** captures the camera and the snapshot (with the drawing).
- The list shows the markups of the loaded models with status, visibility, issue and comment badges.
  Clicking one restores its viewpoint (loading the other models of a federated view if needed) and
  shows the drawing. The drawing belongs to its camera: orbiting, zooming or walking hides it, and
  **Show Viewpoint** brings both back.
- In the detail: the snapshot, comments, **Close Markup / Reopen**, **Share with Project / Make Private**,
  **Delete** and **Create Issue**.

## Versions

A markup belongs to one model version. When a newer version of the file is open, markups of older
versions appear under **From Older Versions** with their version badge; their viewpoint is shown as
the snapshot only. **Carry Over** copies the markup to the open version (`carried_from_id`); the
view's other models stay as they were. A pin finds its element again by **GlobalId** in the newer
version's element index (the one used by [version comparison](DOCUMENT_COMPARISON.md)); when the
element is gone the pin keeps its old point and is flagged (`anchor.missing`, ⚠). A markup already
carried to a version is not listed again for it; carrying it again returns the existing copy.

## Issues and BCF

**Create Issue** makes an issue (the Issues module of the project must be on) whose primary viewpoint
is the markup's viewpoint, including the snapshot with the drawing or pin, and whose pin is the
markup's pin. The issue is therefore exported to BCF with that viewpoint, its snapshot and the pin
(as a point in `Lines`, [BCF](BCF.md)). A markup creates at most one issue (409 afterwards). A
private markup becomes project-visible when an issue is made from it, because the issue shows it to
the project (the same rule as PDF markups and their drafts).

Markups themselves are not BCF topics; only their issues are exported.

## Permissions

| Action | Who |
|---|---|
| See a markup | Project visibility: everyone who can **view** every model version of its view (`FolderTree`, so the [task-team WIP rule](TASK_TEAMS.md) applies). Private: only the author, with the same model rule. Otherwise 404 |
| Create, comment, carry over | **Markup** permission in the folder of the markup's model (the target version's folder when carrying over) |
| Change title, colour, drawing, visibility | The author |
| Close / reopen, delete | The author or a project administrator |
| Create an issue | Anyone who sees the markup |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/projects/:pid/model-markups?versions=a,b` | `{ current, older }` for the given versions; no snapshots |
| POST | `/api/v1/projects/:pid/model-markups` | `{ kind, versionId, title?, color, visibility?, viewpoint, anchor? (pin), shapes? (drawing) }` |
| GET | `/api/v1/projects/:pid/model-markups/:id` | With snapshot, comments, `canEdit`, `canComment` |
| PATCH | `/api/v1/projects/:pid/model-markups/:id` | `{ title?, color?, status?, visibility?, shapes? }` |
| DELETE | `/api/v1/projects/:pid/model-markups/:id` | Comments go with it |
| POST | `/api/v1/projects/:pid/model-markups/:id/comments` | `{ body }` |
| POST | `/api/v1/projects/:pid/model-markups/:id/carry-over` | `{ versionId }` (a newer version of the same file) → `{ markup, existing }` |
| POST | `/api/v1/projects/:pid/model-markups/:id/issue` | `{ title, description?, priority?, type? }` → `{ markup, issue }` |

Audit events (target: the model file, so rows about a file in a closed WIP are withheld like other
file events): `model_markup.created`, `.updated`, `.closed`, `.reopened`, `.deleted`, `.commented`,
`.carried_over`, `.issue_created`, plus `issue.created` for the new issue.

## Code

| Part | Where |
|---|---|
| Types, view units, carry-over helpers | `packages/shared/src/coordination/model-markup.ts` |
| Tables | `apps/server/src/db/schema-model-markup.ts`, `apps/server/drizzle/0045_model_markups.sql` |
| API | `apps/server/src/coordination/routes/model-markups.ts` |
| Viewer | `apps/web/src/features/coordination/model-markup/` (`useModelMarkups` state, `MarkupLayer` pins and drawing on the canvas, `MarkupPanel` list and detail, `snapshot.ts` burns the drawing into the snapshot); wired into `pages/Viewer.tsx`. The viewer package (`@sitekeephq/bim-viewer`) is unchanged: pins are HTML dots projected with the engine's camera |

## Tests

- `apps/server/test/coordination/model-markup.test.ts`: create (validation, folder permission), private
  and project visibility, comments, edit / status rules, older versions and carry-over by GlobalId
  (element kept / missing), issue from a markup and its BCF export, delete, audit events, and the
  task-team WIP rule (ISO19650-2 5.1.7(e)).
- `packages/shared/test/model-markup.test.ts`: view units and carry-over helpers.
- `e2e/specs/model-markup.spec.ts` (core, with and without modules): pin and drawing on the IFC fixture,
  reload restores the drawing with its viewpoint, moving the view hides it, comment and issue.
- `e2e/specs/mobile-model-markup.spec.ts` (iPhone): panel from ⋯ Diğer, pin by tap, reopen from the list.

## Limits

- A federated markup is listed with the model it belongs to (`version_id`); opening only another
  model of its view does not list it.
- Drawings are 2D over one camera; they do not stick to the model when the view moves (they hide).
- No pin drag after saving; delete and place again.
- Markups are not exported to BCF on their own, only through the issue made from them.
