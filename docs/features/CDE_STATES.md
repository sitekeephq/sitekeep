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
| **Task team** | `project_roles.kind = 'task_team'` (+ `company_id`, `code`, `is_lead`); `folders.owner_team_id` | A kind of project role, one per company; a person may belong to several teams. A WIP folder can be owned by one team |
| **Audit trail** | `audit_log` (+ `prev_hash`, `hash`, `ip`, `user_agent`; indexes by project/action, target, user) | Hash chain, view events and CSV export are added by the audit work; IP and user agent are documented in [privacy](PRIVACY.md) when they are recorded |

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

## Where the rules run

Every write path calls the guards in `apps/server/src/cde/guards.ts` once, and the view routes
call the events in `apps/server/src/cde/events.ts`:

| Guard / event | Called from |
|---|---|
| `checkUpload` | `addVersion` (`apps/server/src/files/new-version.ts`: upload route, OpenCDE completion, modules), manual copy (`modules/documents/files.ts`), approved review copy (`workflow/review-finalization.ts`), OpenCDE upload page (`opencde/pages.ts`) |
| `checkMove` | moving a file (`PATCH /projects/:pid/files/:id`) |
| `checkCodes` | `addVersion` (codes from `AddVersionOptions.codes`), approved review copy (codes carried from the source version) |
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
| Suitability and revision codes per version | planned |
| Unique document codes | planned |
| Task teams and WIP visibility | planned |
| Audit trail: view events, hash chain, CSV | planned |
