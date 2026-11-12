# Parameter Change (Change Request)

Date: 11.10.2026. User decision: "Update the model through parameter changes", step 1.

## What it does

- Changes the information parameters (property sets, Pset) of IFC elements inside the CDE.
- The result is a new version of the same file. Geometry does not change.
- Geometry changes are step 2: they are made in Revit, with AEC Pilot.
- Both steps use the same "Change Request" record. Only the "apply" side differs.

## Where

- Model → **Parameter Changes** tab (`/p/:pid/param-changes`).
- **✎ Parameter Changes** button in the IFC file's drawer (that file via `?file=`).
- "+ New" → **Parameter Change**.
- If the Coordinate module is off, no new request can be opened. Existing requests can be read.

## How a request is created

There are three ways. All give the same preview.

1. **From Selection:** GlobalId list + property + new value.
2. **From Query:** an "Ask the Model" query (class, storey, condition) + a "set" rule.
   Example: doors with FireRating = EI30 → FireRating = EI60.
3. **From a Sentence:** "EI30 olan kapıları EI60 yap" ("make the EI30 doors EI60").
   - The AI only writes the `{query, set}` JSON.
   - The JSON is validated with zod, then checked against the model's dictionary.
   - A class, storey or property that is not in the model is rejected ("invented property").
   - If the new value is not in the sentence, the request is rejected. The condition value must be in the sentence or in the model.
   - Without a model, "Run with My Own AI" sends it to the connected client (task type `param_change`).

The preview shows:

- Old → new value per element.
- Counts per class and storey.
- A property missing from the model: **to be added**.
- Elements that already have the same value (skipped).
- Elements whose value sits on the type, and the type's elements outside the selection.

Property and set names match regardless of case and Turkish characters.
If no set is given, the set in which the property exists in the model is used.
A new property needs a set name. Quantities (Qto) cannot be changed.

## Statuses

Draft → Awaiting Approval → Approved → Applying → Applied.
Other end states: Rejected, Cancelled.
For step 2: **To Apply in Revit**.
Warning status: **Values Lost** (the request is reopened).

## Approval

- Project setting: "Parameter Changes Require Approval". Default: on.
- Approver: the project manager or the configured approver role.
- To be applied, a request must be approved.
- If approval is off, the project manager can apply a draft directly.
- Submitting for approval notifies the approvers. Approval and rejection are notified to the creator.

## Owner of the value

- **Also Applied in Revit:** the value must also go into the design model.
- **CDE Only:** information that is not in the model is added in the CDE (enrichment).
- Default: "CDE Only" if only new properties are added; "Also Applied in Revit" in every other case.

## Apply (New Version)

- Runs in the job queue, in a separate worker (web-ifc).
- The value is written to the element's IfcPropertySet / IfcPropertySingleValue record.
- The existing IFC type is kept (IfcLabel, IfcIdentifier, IfcReal, IfcBoolean…).
- If the property is missing, it is added. If the set is missing, the set and an IfcRelDefinesByProperties are created (IFC2X3 and IFC4).
- A set shared by several elements is copied first. Other elements do not change.
- If the value is on the type: the default is "Write to Instance" (the instance overrides the type).
  If "Change on Type" is chosen, all elements of the type change; the preview lists them.
- Geometry, placement, quantities and GlobalIds do not change. web-ifc rewrites the rest of the file.
- The new version is saved with `addVersion`: the same rules as an upload
  (permission, approval gate, naming; attributes are carried over unchanged).
- Description: "Parameter Change: <title> (<n> elements)".
- The normal pipeline runs: Fragments conversion and element index.
- When the index is ready, the values are read from the new version's index.
  If all are present, the request becomes **Applied**; a result is written per row.
- If the file has a newer version, applying stops: **Move to Current Version** is needed.

## Automatic check of later versions

Each time a new version of the file is indexed (upload, WOPI, AEC Pilot, developer upload), the requests are checked:

- **Applied:** if the values are missing → **Values Lost**, the request is reopened, the lost rows are marked.
  The creator and the project managers are notified: "Previous parameter change is missing in this version: <title> (n elements)".
  A warning badge appears next to the version in the file drawer and in the list.
- **Values Lost:** if the values come back → **Applied** again.
- **To Apply in Revit:** if all values arrive → **Applied** (verified from Revit).
- The same version is checked only once for the same request (`param_change_checks`).
- The "Verify" button runs the same check manually on the chosen version.

## MCP tools

- `cde_change_requests_list`, `cde_change_request_get`: read.
- `cde_change_request_create`: draft (write token). `preview: true` only previews.
- `cde_change_request_verify`: checks the next version (write token).
- `cde_change_request_apply`: write token + project manager or approver + approved request.

## REST

`/api/v1/projects/:pid/param-changes`:
`GET /` (list), `POST /preview`, `POST /ai-plan`, `POST /` (draft), `GET /:id`, `PATCH /:id`,
`POST /:id/submit | approve | reject | cancel | apply | authoring | verify | rebase`,
`GET|PUT /settings`. File summary: `GET /projects/:pid/files/:fid/param-change-status`.

## Connecting to the viewer

The panel is a separate component (`apps/web/src/components/ParamChangePanel.tsx`):

```tsx
<ParamChangePanel modelVersionId={versionId} selection={seciliGlobalIdler} onPreview={(guids) => vurgula(guids)} />
```

- If `selection` is given, the "From Selection" way opens by default.
- `onPreview` provides the GlobalIds of the elements that will change (for highlighting).
- On save, the request page opens (can be changed with `onCreated`).

## Limitations

- A request has at most 5000 changes. The preview shows the first 500 rows.
- Only single-value and enumerated properties. Bounded, list and table values do not change.
- Attributes (Name, Tag, ObjectType) and quantities do not change.
- Set lists in IFC4 (IfcPropertySetDefinitionSet) are not read.
- web-ifc rewrites the file; the header and ordering format may change.

## Step 2 plan (Revit)

1. The request is approved and set to "To Apply in Revit".
2. AEC Pilot reads the rows with `cde_change_request_get` and writes the parameters in Revit.
3. The IFC is exported again and uploaded as a new version of the same file.
4. The automatic check (or `cde_change_request_verify`) sets the request to "Applied".
5. Geometry changes will be tracked with the same record; only the apply side will be Revit.
