# BCF import and export (.bcfzip)

Date: 11.10.2026. First step of the OpenCDE plan (see `docs/archive/research/OPENCDE_ARASTIRMA.md` §3, §7). Issues are
exported and imported as BCF files. BCF API 3.0 will use the same mapping layer.

## Where

- **Works → Issues**: "Import BCF" and "Export as BCF" buttons. If rows are selected in the table, only the selected
  issues are exported; with no selection, the issues in the list (filter) are exported.
- **Issue detail**: "Export as BCF" (single issue). For an issue with more than one viewpoint, the viewpoints are
  listed as thumbnails. Each one opens in the Model Viewer (`?issue=…&vp=<GUID>`).
- **MCP**: `cde_bcf_export` (read) and `cde_bcf_import` (write; preview first, then `commit: true`).

## Supported versions

| Version | Export | Import |
|---|---|---|
| BCF 2.1 | Default. The most compatible option: Navisworks, Revit add-ins, BIMcollab ZOOM, Solibri | Yes |
| BCF 3.0 | Optional. With `extensions.xml` | Yes |
| BCF 2.0 | No | Yes (read as 2.1) |

The file layout follows buildingSMART BCF-XML: `bcf.version`, `project.bcfp`, `extensions.xml` (3.0),
`<sorun GUID>/markup.bcf`, `<sorun GUID>/viewpoint.bcfv` and `snapshot.png|jpg` (first viewpoint),
`<sorun GUID>/<görünüm GUID>.bcfv` and `.png|jpg` (other viewpoints). (`sorun` = issue, `görünüm` = viewpoint.)

## Field mapping

| SiteKeep | BCF | Note |
|---|---|---|
| `issues.guid` | Topic `Guid` | Same as `id` for an issue created here. For an imported issue, the GUID from the file (lower case) |
| `number` | `ServerAssignedId` (3.0) | |
| `title`, `description` | `Title`, `Description` | Title at most 300, description at most 10 000 characters |
| `status` | `TopicStatus` | Export: Open, In Progress, Resolved (In Review), Closed. Import: suggested mapping, can be changed in the wizard |
| `type` | `TopicType` | "Issue" is written if empty |
| `priority` | `Priority` | Low, Normal, High, Critical |
| `labels`, `stage`, `referenceLinks` | `Labels`, `Stage`, `ReferenceLinks` | |
| `assigneeUserId` | `AssignedTo` (email) | An unmatched email is stored and written back on export |
| `createdBy`, `createdAt` | `CreationAuthor`, `CreationDate` | Unmatched author: the importing person + the email from the file is stored |
| `updatedAt`, `modifiedBy` | `ModifiedDate`, `ModifiedAuthor` | |
| `dueDate` (day) | `DueDate` | Export: the day at noon UTC. Import: the day in the file |
| the viewpoint's models | Header `File` | `Reference` = model version ID, `IfcProject` = IfcProject GlobalId |
| `issue_comments` | `Comment` | GUID, author, date, viewpoint link (`Viewpoint Guid`) |
| `issues.viewpoint` + `issue_viewpoints` | `Viewpoints` | The first is the primary viewpoint. Viewpoints are immutable and added by GUID |
| `issue_related_topics` | `RelatedTopic` | Stored by GUID; the related issue may not exist yet |
| `importedFrom` | — | Source, version, file name, unmatched values, document references |

### Viewpoint (VisualizationInfo)

| SiteKeep (scene) | BCF (IFC world) |
|---|---|
| `camera.position`, `target − position` | `CameraViewPoint`, `CameraDirection` |
| `camera.up` | `CameraUpVector` (for older viewpoints, an up vector without roll is calculated) |
| `camera.fov`, `camera.aspect` | `FieldOfView`, `AspectRatio` (3.0) |
| `camera.viewToWorldScale` | Orthographic `ViewToWorldScale` |
| `selection` | `Selection` (IfcGuid) |
| `visibility` | `Visibility` (`DefaultVisibility` + `Exceptions`, `ViewSetupHints`) |
| `coloring` | `Coloring` (`RRGGBB` / `AARRGGBB`) |
| `sections.planes` | `ClippingPlanes` (direction is reversed: BCF shows the hidden half) |
| `sections.box` | 6 clipping planes. On import, 6 axis-aligned planes become a box again |
| `measurements`, issue point (pin) | `Lines` (point = a line with the same start and end) |
| `snapshot` | `snapshot.png` / `.jpg` |

## Coordinates

- BCF: IFC world coordinates, metres, Z up.
- Viewer: three.js, Y up. When the Fragments model is imported, web-ifc shifts it with `COORDINATE_TO_ORIGIN`.
- Transformation: scene = (x, z, −y) + offset. Reverse: IFC = (X, −Z, Y) − offset. Directions are only rotated.
- The offset is that of the first model (the first aligned model in the model set). New viewpoints store it as `sceneOffset`.
- For older viewpoints, the offset is read on the server from the model's viewer file and cached. If it cannot be read, a
  warning is shown.
- An imported viewpoint is stored with `sceneOffset: [0, 0, 0]`. The viewer moves it to its own offset when opening it.
- IfcMapConversion (map coordinates) is not applied. BCF does not apply it either.
- BCF has no target point. In an imported camera, the orbit centre is 10 m ahead in the view direction.

The transformation lives in one place, `packages/shared/src/bcf.ts`. The server, the web app and MCP use the same code.

## Import

1. Select the file. The server returns a preview: each issue is **New**, **To Be Updated**, **No Change** or
   **Conflict**.
2. Mapping: statuses, types, priorities, people (email → project member or "Unmatched"), models (suggested by file name,
   IfcProject GUID or version ID).
3. Import. Result: the number of new, updated, unchanged and kept issues; the number of comments and viewpoints added.

Rules:

- Matching is by GUID. Importing the same file a second time does not create copies.
- Comments and viewpoints are only added (by GUID). They are never deleted or overwritten.
- If the file has changed since the last import and the issue has not changed here, the fields are updated.
- If both sides have changed, it is a **conflict**: by default the values here are kept. "Apply Values from the File"
  can be chosen in the wizard.
- Only the creator, the assignee or a project administrator can change the fields of an existing issue. An import by
  other members only adds new comments and viewpoints.
- If the Issues module is disabled, import is refused (403). Export still works because it is a read operation.
- A read-only access key can export and preview, but cannot import.

## Security and limits

| Limit | Value |
|---|---|
| .bcfzip size | 100 MB |
| Number of files in the ZIP | 5 000 |
| Single extracted file / total | 20 MB / 300 MB |
| Compression ratio (for files over 1 MB) | at most 200 |
| Issues per file | 2 000 (also on export) |
| XML file | 8 MB |
| Image | 5 MB, at most 8000 pixels per side |

- The ZIP is only extracted in memory. File names containing an absolute path, `..`, a backslash or a symbolic link are rejected (zip-slip).
- DOCTYPE or ENTITY declarations in XML are rejected (XXE, entity bomb).
- The image type is detected from the content, not the file name. PNG chunks are checked with CRC and the image data is decompressed.
  PNG and JPEG are rewritten with only the required chunks: text, Exif, XMP and comments are dropped.
- Bitmaps and BIM snippets (BimSnippet) are not supported; a warning is shown.
- Camera roll cannot be applied in the viewer. For a straight-down view, the up direction is kept.
- BCF 2.1 limits the field of view to 45–60°. Values outside are clamped to this range and a warning is shown.

## Endpoints

| Method | Path | Note |
|---|---|---|
| GET | `/api/v1/projects/:pid/bcf/export?version=2.1&ids=…&status=…&snapshots=0` | Downloads a .bcfzip |
| POST | `/api/v1/projects/:pid/bcf/export` | JSON: file name, download link, base64 if small |
| POST | `/api/v1/projects/:pid/bcf/import/preview` | multipart `file` or JSON `{fileName, data}` |
| POST | `/api/v1/projects/:pid/bcf/import` | same + `mapping` |
| GET | `/api/v1/projects/:pid/issues/:iid/viewpoints` | all viewpoints of the issue |

Schema: `0029_bcfzip` (issues: `guid`, `labels`, `stage`, `reference_links`, `modified_by`, `imported_from`;
issue_comments: `guid`, `viewpoint_guid`, `modified_at`, `modified_by`, `imported_author`; new tables
`issue_viewpoints`, `issue_related_topics`).

## What is tested

- Automated tests (`apps/server/test/coordination/bcf.test.ts`, `packages/shared/test/bcf.test.ts`):
  - Exported 2.1 and 3.0 XML is validated against the official buildingSMART XSDs (`test/fixtures/bcf-xsd`).
  - buildingSMART test files (2.1: "One part visible", "user assignment"; 3.0: "Orthogonal camera",
    "Related topics") are imported.
  - Hand-written 2.1 and 3.0 files, re-import, conflict, round trip, malicious ZIPs, permissions,
    module disabled.
- Manual trials with Navisworks, BIMcollab ZOOM, Solibri and Revit add-ins **have not been done yet**. They should be
  tried with the first customer file.
