# CDE states (ISO 19650)

SiteKeep runs a project's information as an ISO 19650 common data environment (CDE). This page
describes the data model behind the four states, the project settings that control them, and what
is switched on today. Compliance mapping: [ISO 19650 conformance](../compliance/ISO19650.md).

## Model

| Concept | Where it lives | Notes |
|---|---|---|
| **State** (WIP / Shared / Published / Archived) | `folders.state`; a folder without one inherits its nearest ancestor's (`cdeStateOf`, `apps/server/src/cde/state.ts`) | Turkish labels: Çalışma / Paylaşılan / Yayınlanan / Arşivlenen ([terminology](../product/TERMINOLOGY.md)) |
| **Information container** (the document) | `files.container_id` | A new file starts its own container (database trigger `files_container_default`: `container_id = id`). An approved review copy joins the container of its source, so the WIP original, its Shared copy and its Published copy are one document. A manual "Copy to" is a new document. Moves and renames keep the container |
| **Document code** | `files.document_code`, register `document_codes (project_id, code_norm) → container_id` | Unique per project: one code belongs to one container. Only names that follow the project's naming standard get a code; the same code with another extension is a rendition of the same document |
| **Suitability and revision codes** | `file_versions.suitability_code`, `revision_code`, `codes_set_by`, `codes_set_at` | Per version. Profiles: `iso_uk_na` (S0, S1–S4, A1…, B1…, CR; P01.01 → P01 → C01), `legacy_r` (R00), `custom` |
| **Status flag** | `files.cde_status`: `returned`, `superseded`, `withdrawn` | Beside the state: a rejected WIP original is *returned*, its Shared copy *withdrawn*; a publication replaced by a newer one is *superseded*. Nothing is moved physically |
| **Task team** | `project_roles.kind = 'task_team'` (+ `company_id`, `code`, `is_lead`); `folders.owner_team_id` | A kind of project role, one per company; a person may belong to several teams. A WIP folder can be owned by one team ([task teams](TASK_TEAMS.md)) |
| **Audit trail** | `audit_log` (+ `prev_hash`, `hash`, `ip`, `user_agent`; indexes by project/action, target, user) | Append-only and hash-chained (migration 0043); `file.viewed`, `file.moved`, `cde.transition`; IP and user agent ([privacy](PRIVACY.md#audit-log-ip-address-and-user-agent)). See [audit log](AUDIT_LOG.md) |

## Project settings

One row per project in `project_cde_settings` (a project without a row uses the defaults):

| Setting | Default | Meaning |
|---|---|---|
| `enforce_transitions` | `false` | Off: the transition table is stored, nothing is enforced. Existing projects stay off; new projects from the ISO 19650 template start on |
| `code_scheme` | `iso_uk_na` | Code profile (`iso_uk_na`, `legacy_r`, `custom`) |
| `suitability_codes`, `revision_rules` | null | Custom profile only |
| `archive_folder_id` | null | Root of the archive; superseded publications go to the same path below it |
| `container_standard_id` | null | Naming standard that defines the document code |
| `wip_policy` | `grants` | `grants`: folder permissions as set; `team_only`: a team's WIP folder is visible to its team only |
| `admin_sees_wip` | `true` | Project administrators see every team's WIP |

Transitions are rows of `cde_transitions (project_id, from_state, to_state, mode, workflow_template_id,
require_reason)`; `from_state` null is a direct upload. Modes: `direct`, `review` (an approved review,
optionally of a given workflow template), `auto` (done by the system), `forbidden`. A pair without a
row is forbidden while enforcement is on. One row per (project, from, to); the uniqueness counts null as
one value.

The ISO 19650 template (`apps/server/templates/iso19650-temel.json`) sets:

| From | To | Mode |
|---|---|---|
| (upload) | WIP | direct |
| WIP | Shared | review: "Ekip İçi Kontrol" |
| Shared | WIP | automatic (on rejection) |
| Shared | Published | review: "Tasarımcı → Müşavir → İdare" |
| Published | Archived | automatic (on a newer publication) |

### API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/cde/settings` | project members | `CdeSettingsDto` (`packages/shared/src/documents/cde.ts`) |
| PUT | `/api/v1/projects/:pid/cde/settings` | project administrators | Any subset of the fields; `transitions` replaces the table. Validated (states, modes, duplicates, references inside the project). Audit: `cde.settings_updated` |

The web app shows the settings read-only under **Project Settings → CDE** (advanced tab).

### Project templates

A template may carry a `"cde"` block, applied when a project is created from it and written by
"export as template" when the project's settings differ from the defaults:

```json
"cde": {
  "codeScheme": "iso_uk_na",
  "enforceTransitions": true,
  "wipPolicy": "grants",
  "adminSeesWip": true,
  "archiveFolder": "04-ARCHIVED (Arşiv)",
  "transitions": [{ "from": null, "to": "wip", "mode": "direct" }, { "from": "wip", "to": "shared", "mode": "review", "workflow": "Ekip İçi Kontrol" }]
}
```

`workflow` names a workflow of the same template; `archiveFolder` is a folder path from the project
root. The template check refuses unknown workflows and duplicate transitions.

## Codes

Every version carries a **suitability** (status) code and a **revision** code (ISO 19650-2 §5.1.7,
UK National Annex): `file_versions.suitability_code`, `revision_code`, with who set them and when
(`codes_set_by`, `codes_set_at`). The rules are pure functions in
`packages/shared/src/documents/cde-codes.ts`, shared by the server and the web app.

### Profiles

The project's `code_scheme` picks the profile; `suitability_codes` (a list of `{ code, description,
states }`) replaces the built-in suitability list in any profile (an entry without states is allowed
everywhere).

| State | `iso_uk_na` (default) suitability | `iso_uk_na` revision | `legacy_r` |
|---|---|---|---|
| WIP | S0 | P01.01, P01.02 … | R00, R01 … in every state; every suitability code in every state |
| Shared | S1, S2, S3, S4 | P01, P02 … | |
| Published | A1…An, B1…Bn, CR | C01, C02 … | |
| Archived | any of the above (what the publication had) | any of the above | |
| (folder without a state) | any code of the profile | any form of the profile | |

`custom` uses the ISO revisions with the project's own suitability list. S5–S7 are not used.

Input is normalised: `s2` → `S2`, `S2 · For information` → `S2`, `A` / `B` (OpenCDE and older
attribute values) → `A1` / `B1`, `p1.2` → `P01.02`, `Rev 3` / `r3` → `R03`.

Revision sequence (`nextRevision`): P01.01 → P01.02 in WIP; WIP → Shared P01.03 → P01, or the next
free P0n when P01 was shared already; Shared → Shared P01 → P02; → Published C01, then C02 …; back
to WIP from P0n or C0n starts the next preliminary revision (P02.01); Archived keeps the revision.
Legacy: R00 for a new document, R00 → R01 for a new version, a state change keeps the revision.

### Where the codes are checked

| Path | Behaviour |
|---|---|
| `addVersion` (upload route, OpenCDE completion, modules) | `checkCodes` → `apps/server/src/cde/codes.ts`. Codes given (`AddVersionOptions.codes`, the upload fields `suitabilityCode` / `revisionCode`) are normalised and checked against the profile in the folder's state (`cdeStateOf`). A code that does not fit is refused with 400 and the allowed codes **only when the project enforces the rules** (`enforce_transitions`, D-8). Otherwise it is stored as given (normalised) and returned as a non-blocking `warnings` entry (`field`, `kind`, `value`, `state`, `allowed`, `message`) on the upload result, so existing projects and clients (AEC Pilot sending S2/C01 into WIP) keep working. A code equal to the previous version's is not checked again (existing data is grandfathered) |
| Legacy attributes | Uploads, OpenCDE and modules that still write the free attributes `Uygunluk Kodu`, `Uygunluk` or a revision attribute (`Revizyon`, `Rev`, `Revision` …) get them as codes: any code of the profile when the project does not enforce the rules (with a warning when it does not fit the state), only codes that fit the state when it does. Other values stay attributes only and never refuse the upload. Attributes are never removed |
| Enforcement on (`enforce_transitions`) | A version stored without codes in a folder with a state gets them: the previous suitability when it still fits, else the state's default (WIP: S0); the next revision of the sequence |
| Approved review copy | Carries the source version's codes unchanged (system work); the transition work decides what a copy becomes |
| OpenCDE upload page | The revision and suitability fields are checked against the target folder's state before any byte is sent: refused when the project enforces the rules, else returned as `warnings` beside `redirectTo`; `document_version_metadata` returns the version's codes as `Revizyon` / `Uygunluk` |

### API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/folders/:fid/cde/codes` | members who see the folder | `CdeFolderCodesDto`: scheme, own suitability list, enforcement, the folder's state |
| PATCH | `/api/v1/projects/:pid/versions/:vid/codes` | WIP (or no state): folder editors and the uploader; Shared / Published / Archived: project administrators with a `reason` | `{ suitabilityCode?, revisionCode?, reason? }`, null clears. A code that does not fit: 400 when the project enforces the rules, else stored and returned with `warnings`. Audit `file.codes_changed`; outside WIP also `cde.override` |
| GET | `/api/v1/projects/:pid/cde/codes/unmapped` | project administrators | Older attribute values that are not codes of the profile (first 500) |

The code scheme is changed with `PUT /cde/settings` (`codeScheme`, `suitabilityCodes`).

### Web

Suitability and revision chips beside the version in the documents list, under the title of the file
drawer and per version in the version history; a **Codes** block in the file drawer with the editor
(the rules are checked while typing: an error when the project enforces them, else a warning); code
inputs in the upload dialog (WIP: S0 and the proposed revision filled in; the same error or warning,
and the server's warnings on the result); **Project Settings → CDE → Revision and Suitability Codes**: scheme, the codes
each state allows, the values the migration could not convert. The ISO 19650 template no longer
defines the free attributes "Revizyon" and "Uygunluk Kodu"; projects created earlier keep them.

### Live-data migration

`migrateLegacyCodes` (`apps/server/src/cde/codes-migration.ts`) runs at server start (after the
database migrations) and from `apps/server/src/scripts/cde-backfill.ts`. Idempotent and batched:

1. For the current version of each file without codes, the attribute values are read
   (`Uygunluk Kodu`, else `Uygunluk`; the first revision attribute).
2. Code scheme per project, chosen once (audit `cde.codes_migrated` is the marker): a project with
   any R revision (`R01`, `Rev 2`) gets `legacy_r`, others keep `iso_uk_na`. A project whose scheme is
   not the default, or whose CDE settings were saved by a person (`cde.settings_updated`), keeps it.
3. Values that are codes of the profile (in any state) are copied, normalised, into the version;
   `codes_set_at` is set, `codes_set_by` stays empty. A version whose codes were set is never
   touched again.
4. Values that are not codes stay in the attributes and are reported: audit
   `cde.migration_unmapped` (written again only when the list changes) and the unmapped endpoint /
   settings list.

## Where the rules run

Every write path calls the guards in `apps/server/src/cde/guards.ts` once, and the view routes
call the events in `apps/server/src/cde/events.ts`:

| Guard / event | Called from |
|---|---|
| `checkUpload` | `addVersion` (`apps/server/src/files/new-version.ts`: upload route, OpenCDE completion, modules), manual copy (`modules/documents/files.ts`), approved review copy (`workflow/review-finalization.ts`), OpenCDE upload page (`opencde/pages.ts`) |
| `checkMove` | moving a file (`PATCH /projects/:pid/files/:id`) |
| `checkCodes` | `addVersion` (codes from `AddVersionOptions.codes` or the legacy attributes), approved review copy (codes carried from the source version); rules in `apps/server/src/cde/codes.ts` |
| `checkDocumentCode` | `addVersion`, manual copy, rename / move, approved review copy |
| `recordView` | preview, PDF and media routes (`previews/routes.ts`), model route (`files.ts`) |
| `recordTransition` | move to another folder, approved review copy |

The SDK functions keep their signatures (`addVersion`, `assertDirectWriteAllowed`, `FolderTree`);
`AddVersionOptions` gained the optional `source` and `codes`, so modules get the rules without changes.

Re-running the data backfill (containers along review copy chains, settings rows; also part of
migration 0042): `DATABASE_URL=… npx tsx apps/server/src/scripts/cde-backfill.ts [batchSize]`.

## Status

| Part | Status |
|---|---|
| Data model, settings, template block, seams (this page) | done; no behaviour change |
| Transitions enforced, archive on publication, returned / withdrawn on rejection | planned |
| Suitability and revision codes per version ([codes](#codes)) | done |
| Unique document codes ([details](DOCUMENT_CODES.md)) | done |
| Task teams and WIP visibility ([task teams](TASK_TEAMS.md)) | done |
| Audit trail: view events, hash chain, CSV ([details](AUDIT_LOG.md)) | done |
