# CDE states (ISO 19650)

SiteKeep runs a project's information as an ISO 19650 common data environment (CDE). This page
describes the data model behind the four states, the project settings that control them, and what
is switched on today. Compliance mapping: [ISO 19650 conformance](../compliance/ISO19650.md).

## ISO 19650 in SiteKeep

ISO 19650 asks a CDE to keep information in containers that move from work in progress to shared,
published and archived, each with a unique identifier, a suitability and a revision, with controlled
access and a record of who moved what and when (ISO 19650-1 §12, ISO 19650-2 §5.1.7). SiteKeep
Community does this with folder states and information containers (this page), suitability and
revision codes per version ([codes](#codes)), a transition table enforced on every write path
([transitions](#transitions)), unique document codes ([document codes](DOCUMENT_CODES.md)), task-team
WIP ([task teams](TASK_TEAMS.md)) and a hash-chained audit log ([audit log](AUDIT_LOG.md)). The rules
are per project: existing projects keep working as before until an administrator switches them on, and
projects created from the ISO 19650 templates (**ISO 19650 Temel** / ISO 19650 Basic and the
construction templates, [project templates](PROJECT_TEMPLATES.md)) start with them on. The clause-by-clause
mapping, the steps to switch the rules on and the conformance test pack (`npm run test:iso`) are in
[ISO 19650 conformance](../compliance/ISO19650.md).

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
| `enforce_transitions` | `false` | Off: the transition table is stored, nothing is enforced. Existing projects stay off; new projects from the ISO 19650 template start on. On: [transitions](#transitions) |
| `code_scheme` | `iso_uk_na` | Code profile (`iso_uk_na`, `legacy_r`, `custom`) |
| `suitability_codes`, `revision_rules` | null | Custom profile only |
| `archive_folder_id` | null | Root of the archive; superseded publications go to the same path below it |
| `container_standard_id` | null | Naming standard that gives the document code to files in folders without a standard of their own (**Document Code Standard**, [document codes](DOCUMENT_CODES.md)) |
| `wip_policy` | `grants` | `grants`: folder permissions as set; `team_only`: a team's WIP folder is visible to its team only |
| `admin_sees_wip` | `true` | Project administrators see every team's WIP |

Transitions are rows of `cde_transitions (project_id, from_state, to_state, mode, workflow_template_id,
require_reason)`; `from_state` null is a direct upload. Modes: `direct`, `review` (an approved review,
optionally of a given workflow template), `auto` (done by the system), `forbidden`. A pair without a
row is forbidden while enforcement is on; a project that enforces the rules with an **empty** table uses
the ISO 19650 default (`DEFAULT_CDE_TRANSITIONS`: the D-7 table below with any approved review). One row
per (project, from, to); the uniqueness counts null as one value.

The ISO 19650 template (`apps/server/templates/iso19650-temel.json`) sets `enforceTransitions: true`,
`codeScheme: "iso_uk_na"`, `wipPolicy: "team_only"`, `adminSeesWip: true`, the archive folder
`04-ARCHIVED (Arşiv)` and this table. Its Shared and Published folders also carry the naming standard
"ISO 19650 Kodlama" and the folder review gate (`gate`), so a direct upload there is refused by the gate
first. It sets `container_standard_id` to that standard (`containerStandard`), so document codes are
unique from WIP on ([document codes](DOCUMENT_CODES.md)), and one task team per party (`taskTeams`).
The construction templates (`iso19650-yapim-tr`, `iso19650-yapim-en`) set the same rules with their own
workflows: WIP → Shared through any approved review (three workflows share), Shared → Published through
"Approval: Consultant + Designer → Client acceptance → Publish", the archive folder `40-ARCHIVED`, and the
contractor's team as the lead.

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

**Project Settings → CDE** (advanced tab) shows the settings; project administrators edit the codes,
the task teams and, in **State Transitions**, the enforcement switch, the archive folder and the
transition table (`CdeTransitionsEditor.tsx`; "Use ISO 19650 Defaults" fills the D-7 table).

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
root; `containerStandard` names a naming standard of the template (the Document Code Standard);
`taskTeams` lists the slots that get a task team, with the lead (`[{ "slot": "yuklenici", "lead": true }]`).
The template check refuses unknown workflows, naming standards and slots, and duplicate transitions.
The other keys of a template: [project templates](PROJECT_TEMPLATES.md).

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
| Approved review copy | Not enforced: carries the source version's codes unchanged. Enforced: the codes of the target state ([transitions](#transitions)) |
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

## Transitions

ISO 19650-1 §12.2–12.5, ISO 19650-2 §5.1.7(d), §5.6.3, §5.7: information changes state only through a
check, review and authorisation. The rules live in `apps/server/src/cde/transitions.ts` and apply **only
when the project enforces them** (`enforce_transitions`, D-8). With enforcement off every path behaves as
before ISO-1 (the folder review gate of the folder settings still applies).

| Path | Enforced behaviour |
|---|---|
| Upload, new version, manual copy, OpenCDE upload, module `addVersion` (`checkUpload`) | A direct write into a folder is allowed only when the transition (upload → the folder's state) is `direct`. Otherwise 403 naming the way in, e.g. "Files cannot be written directly into Published: … they arrive from Shared through the review workflow "Publication"". A folder without a state is not affected |
| `assertDirectWriteAllowed`, `folderGate` (SDK, unchanged signatures) | The same rule: a state that is not written directly is gated (`GateInfo.message` carries the reason; the folder settings, the OpenCDE upload page and WOPI show it) |
| Move (`PATCH /files/:id`, `checkMove`) | The transition (from state → to state) must be `direct`: `review` → 403 naming the workflow, `auto` → 403 (done by the system), `forbidden` or no row → 403. A move inside one state is no transition. Leaving the CDE (into a folder without a state) is allowed from WIP only. `requireReason` asks for `reason` |
| Review start (`prepareReview`, preview and start) | For each file, the transition (source state → target state) must be `review` (or `direct`) and, when the table names a workflow template, the review must use it; otherwise the start is refused and the preview lists the problem. The suitability chosen for the copies must fit the target state |
| Approved review copy (`copyApprovedFiles`) | The copy keeps the document's container; its version gets the suitability chosen at the start (stored in the start action, `targetSuitability`; else the source's when it fits, else the state's first: S1, A1) and the next revision (`nextRevision` over the container's revisions: P01.03 → P01, → C01 …). Audit `cde.transition` (mode `review`). A new approved version clears a `withdrawn` / `superseded` flag on the target file |
| Archive on publication (D-10, `cde/archive.ts`) | Before a new version is published, each current publication of the same container (a file in a Published folder without a status flag) is copied into the archive folder (`archive_folder_id`) at the same path it has below its Published folder (`ensureFolderPath`): same storage key, no byte copy, same codes. The archive copy is flagged `superseded` (a later superseded publication of the same document becomes a new version of it); a publication in another place than the new one is flagged `superseded` too. Audit `cde.superseded` and `cde.transition` (published → archived, mode `auto`) |
| Rejection (D-2, `cde/rejection.ts`, `afterEvaluate`) | A file sent back (`rejected`, `revise_resubmit`; stopped in a stop stage or decided so at the end): its WIP original (the file itself when it is in WIP, else the container's files in WIP) is flagged `returned`, the current version's suitability goes back to S0 (ISO profiles), and the members of the task team owning its WIP folder are notified (`cde.returned`; the uploader when no team owns it). A Shared copy refused for publication is flagged `withdrawn`. Audit `cde.returned`, `cde.withdrawn`, `cde.transition` (shared → wip, mode `auto`). Nothing is moved. A new version of the WIP file clears `returned` |
| Project administrators | No silent bypass: the routes above refuse them like anyone. `POST /api/v1/projects/:pid/files/:id/transition { toFolderId, reason }` moves a file whatever the table says (naming standard and document code still apply); project administrators only, reason required; audit `cde.override` (`what: "transition"`), `file.moved`, `cde.transition` with the reason |

Enterprise modules call `addVersion`, `assertDirectWriteAllowed` and `folderGate`, so they follow the same
rules without changes: under enforcement a Connect import into Shared or Published is refused (import into
WIP and review), WOPI editing a Published document is refused, Field / Manage writes into Shared or
Published are refused. This is intended ([modules](../modules/README.md#iso-19650-enforcement)).

Web: **Send to Shared** / **Publish** in the documents toolbar (selected files of a WIP / Shared
folder) and in the file drawer open the review dialog with the workflow and the target folder of the
transition table; the dialog shows the transition, the suitability of the copies (enforced projects)
and the proposed revision per file. Badges **Returned**, **Superseded**, **Withdrawn** beside the codes
in the list and in the file drawer; the administrator override in the file drawer (folder and reason).

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
| `recordTransition` | move to another folder, approved review copy, archive on publication, rejection (shared → wip), administrator override |

The SDK functions keep their signatures (`addVersion`, `assertDirectWriteAllowed`, `FolderTree`);
`AddVersionOptions` gained the optional `source` and `codes`, so modules get the rules without changes.

Re-running the data backfill (containers along review copy chains, settings rows; also part of
migration 0042): `DATABASE_URL=… npx tsx apps/server/src/scripts/cde-backfill.ts [batchSize]`.

## Status

| Part | Status |
|---|---|
| Data model, settings, template block, seams (this page) | done; no behaviour change |
| Transitions enforced, archive on publication, returned / withdrawn on rejection ([transitions](#transitions)) | done |
| Suitability and revision codes per version ([codes](#codes)) | done |
| Unique document codes ([details](DOCUMENT_CODES.md)) | done |
| Task teams and WIP visibility ([task teams](TASK_TEAMS.md)) | done |
| Audit trail: view events, hash chain, CSV ([details](AUDIT_LOG.md)) | done |
| Conformance pack: clause map, tagged tests, acceptance scenario ([ISO 19650 conformance](../compliance/ISO19650.md)) | done |
