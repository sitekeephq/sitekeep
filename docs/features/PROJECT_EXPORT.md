# Full project export and restore

Your data is never locked in: a project administrator can take the whole project out of SiteKeep as one
ZIP package in open formats (JSON, CSV, BCF 3.0 and the files themselves), and a system administrator
can restore that package as a new project in another SiteKeep installation, for example to move between
two installations. The format is described below so that an import into another CDE can be written.
Part of SiteKeep Community. It shares its building blocks with the
[close-out archive](CLOSEOUT_ARCHIVE.md) (ISO 19650-2 §5.8.1): the versions and their paths, the
per-version metadata (codes, state, approvals, supersession links), the job queue, the streaming into
the storage and the limits.

## Exporting

Project Settings → **Export** (project administrators):

1. The page shows the scope of your export and how many files, versions and bytes it would hold.
2. **Create Export**. The export is built in the background (job queue); the row shows the progress.
   When it is ready you get a notification (the bell), with a link back to the page.
3. **Download** the ZIP. The link works for the download period (the close-out setting
   `CDE_CLOSEOUT_RETENTION_DAYS`, default 14 days); then the ZIP is deleted and the row says
   **Expired**. **Delete File** removes it earlier.

Only one export per project is built at a time. A closed (read-only) project can still be exported.

### What the export holds (permissions)

| Who | Scope (`manifest.json` `scope`) | Holds |
|---|---|---|
| System administrator | `full` | Everything: every folder and file (also every task team's WIP), every review and transmittal, the whole audit log of the project |
| Project administrator | `visible` | What the person can see: files in the folders they can view (folder permissions and the [task team WIP rule](TASK_TEAMS.md)); the folders that lead to them; reviews only with the reviewed files in the export; transmittals they can see (as in Works); the audit log as their screen shows it (rows about a hidden WIP keep no names) |

Members, roles, task teams and the permissions of the exported folders are in both. All issues are in
both (every member reads the issue list); a BCF header file names a model only when the model is in a
folder the person can see. A `full` export can be downloaded or deleted only by a system administrator.
Members who are not project administrators cannot export.

## Format

Schema `sitekeep.project-export/1` (`PROJECT_EXPORT_SCHEMA` in
`packages/shared/src/documents/project-export.ts`, where the TypeScript types of every part live). The
schema string changes when a field changes meaning or is removed; new fields can be added within a
version, so readers ignore fields they do not know. All times are ISO 8601 in UTC. Ids are the source
installation's UUIDs; they link the parts to each other. People are given as `{ id, email, name }`: the
e-mail is the key a restore matches them by.

```
manifest.json            schema, project, who exported it, scope, counts, the parts, the checksum list
SHA256SUMS               SHA-256 of every other entry (sha256sum -c format)
README.txt               what the package is (in the exporter's language)
project.json             project: code, name, description, settings, CDE settings, naming standards
folders.json             folder tree: states, naming standard, owning task team, permissions
files.json               every file with all its versions and their metadata
files/<folders>/<name>   the bytes of every version in the folder structure
members.json             companies, members, roles and task teams
reviews.json             reviews, their workflow and steps, the reviewed versions and every reviewer's mark
transmittals.json        transmittals with their linked versions, events and receipts
supersessions.json       ISO 19650 supersession links between versions (ISO-12)
issues/issues-0001.bcfzip  the issues as BCF 3.0, 500 per package
audit/audit-log.csv      the project's audit log, as the audit log CSV download (without IP addresses and user agents)
audit/audit-log.json     the same rows as a JSON array
```

### manifest.json

| Field | Meaning |
|---|---|
| `schema` | `sitekeep.project-export/1` |
| `generatedAt`, `generator` | When, and the SiteKeep version |
| `project` | `id`, `code`, `name` in the source |
| `exportedBy` | The person (`id`, `email`, `name`) |
| `scope` | `full` or `visible` (above) |
| `counts` | `folders`, `files`, `versions`, `bytes`, `issues`, `reviews`, `transmittals`, `members`, `roles`, `auditRows`, `problems` (versions missing from the storage or not matching their stored SHA-256) |
| `contents` | Paths of the parts (`project`, `folders`, `files`, `members`, `reviews`, `transmittals`, `supersessions`, `issues` (a list), `auditCsv`, `auditJson`) |
| `checksums` | `{ path, size, sha256 }` of every entry except `manifest.json` and `SHA256SUMS` |

`SHA256SUMS` lists every entry except itself, including `manifest.json`; so the manifest is covered by
it, and every other entry by both. Check a package with `sha256sum -c SHA256SUMS`
(macOS: `shasum -a 256 -c SHA256SUMS`).

### folders.json

`{ "folders": [...] }`, parents before children. Per folder: `id`, `parentId` (null for the project
root), `path` (from the root, root = `""`), `name`, `description`, `state` (its own CDE state: `wip`,
`shared`, `published`, `archived` or null), `cdeState` (the effective one: own or nearest ancestor's),
`stateLabel`, `namingStandardId` (in project.json), `ownerTeamId` (a task team in members.json),
`requireApprovedReview`, `createdAt` and `grants`: `{ subjectType: "user" | "company" | "role",
subjectId, level }` (subjects in members.json; levels `none`, `view`, `view_download`, `view_download_markup`, `upload_only`, `edit`, `manage`).

### files.json

`{ "files": [...] }`. Per file: `id`, `folderId`, `folderPath`, `name`, `description`, `attributes`
(name → value), `documentCode` ([document codes](DOCUMENT_CODES.md)), `containerId` (the information
container; review copies of one document share it), `cdeState`, `cdeStatus` (`superseded`,
`returned`, `withdrawn` or null), `currentVersion`, `createdBy`, `createdAt` and `versions`, oldest first.

Each version has the fields of the close-out manifest entry ([close-out archive](CLOSEOUT_ARCHIVE.md#contents)):
`path` (its bytes in the ZIP), `fileId`, `versionId`, `version`, `latest`, `name`, `folderPath`,
`documentCode`, `containerId`, `revision`, `suitability`, `cdeState`, `cdeStatus`, `size`, `sha256` (stored
at upload), `integrity` (`ok`: the bytes in the ZIP hash to it; `mismatch`; `missing`: not in the ZIP),
`uploadedBy` (name), `uploadedAt`, `approvals`, `supersededBy`, `supersedes`, `naming`; and in addition
`uploadedByEmail`, `comment`, `codesSetByEmail`, `codesSetAt`.

The current version keeps the file's name in `files/`, older ones are named `name (V2).ext`, and two
names that differ only in case get ` (2)`.

### members.json

`companies`: `{ id, name, code }`. `members`: `{ userId, email, name, companyId, isProjectAdmin,
roleIds, addedAt }`. `roles`: `{ id, name, description, color, kind: "role" | "task_team", companyId,
code, isLead }` (a task team stands for a company and has a short code).

### reviews.json, transmittals.json, supersessions.json

`reviews`: `id`, `number`, `code`, `name`, `note`, `targetFolderId`, `createdBy`, `createdAt`,
`workflow` (`name`, `status`, `stepIndex`, the step definitions, `startedBy`, `completedAt` and
`actions`: step, kind, person, outcome, comment, time) and `files`: per reviewed version `versionId`,
`path`, `finalStatus`, `finalLabel`, `decidedAt`, `stepResults`, `stepCodes`, the approved copy
(`copiedVersionId`, `copiedPath`) and `marks` (step, person, outcome, custom code, comment, time).

`transmittals`: `id`, `type`, `number`, `title`, `status`, `fields`, `from`, `to`, `cc` (companies),
`assignee`, `dueDate`, `replyRequired`, `delivery`, `createdBy`, `createdAt`, `sentAt`, `closedAt`,
`links` (`kind`: `file_version`, `review`, `issue`, `work`; `targetId`; `role`; `path` of a linked
version in the ZIP), `events` and `receipts`.

`supersessions`: `{ versionId, supersededVersionId, reviewId, createdAt }`: `versionId` replaced
`supersededVersionId` ([supersession](CDE_STATES.md#supersession-iso-12)); only pairs whose both
versions are in the export.

### Issues (BCF 3.0)

`issues/issues-NNNN.bcfzip` are ordinary BCF 3.0 packages, as **Export as BCF** writes them
([BCF](BCF.md)): topics with comments, viewpoints and snapshots, `ServerAssignedId` = the issue number.
A header file's `Reference` is the `versionId` of the model version in files.json.

### Reading it from another CDE

1. Check `SHA256SUMS` and the `schema`.
2. Create the folder tree from folders.json (parents come first), map `state` to your CDE states.
3. For each file in files.json, create the document and add `versions` in order from their `path`;
   carry `documentCode`, `revision`, `suitability`, the attributes and `containerId` (one document per
   container).
4. Import `issues/*.bcfzip` with any BCF 3.0 importer; resolve `Reference` through the `versionId`s.
5. Match people by e-mail (members.json, `uploadedByEmail`, the BCF authors).

## Restore

Projects → **Restore Project** (system administrators: the restore creates a project). Choose the
package, the project code of the new project (and optionally a name; empty keeps the package's) and
**Upload and Restore**. The upload is streamed into the storage under `DATA_DIR`; the restore then runs
in the job queue, and a notification says when it is done. The dialog follows its progress and shows
the report.

1. **Verify** (nothing is written yet): `SHA256SUMS` must name every entry and nothing more,
   `manifest.json` must match it and agree with its own checksum list, the schema must be
   `sitekeep.project-export/1`, and every entry is hashed (streamed) and compared. A changed, damaged,
   missing or added entry refuses the whole package ("Checksum mismatch: … Nothing was restored").
   Entry names are checked as for BCF uploads (no absolute or `..` paths, no links).
2. **Import** into a **new** project; nothing existing is changed, and a code in use is refused (409).
   Every id is new.

| Restored | How |
|---|---|
| Project | Code (given), name, description, project settings; the CDE settings (WIP rule, code scheme, suitability codes, revision rules, archive folder, container standard). Transition enforcement is left off: the transition table and workflow templates are not in the package (the report says so when the source enforced it) |
| Folders | Tree, states, state labels, naming standards, owning task team, "approved reviews only" |
| Members | Matched **by e-mail** (case-insensitive) to existing accounts here, with project administrator flag, company and roles. People without an account are **not created**: they are listed in the report (`unknownUsers`); add them and give them their roles. The person restoring becomes a project administrator |
| Companies | Matched by code, then by name; unknown ones are listed (`unknownCompanies`) and the membership keeps the person's own company |
| Roles and task teams | All of them |
| Folder permissions | For matched people, companies and roles; the others are counted (`skippedGrants`) |
| Files and versions | Every version with its bytes (re-hashed as stored), number, codes (revision, suitability, who set them and when), uploader (when matched), time, comment, attributes, document code (registered for the new project), container, CDE status |
| Supersession links | Between restored versions |
| Issues | Through the BCF import: fields, comments, viewpoints, snapshots, the model links remapped to the restored versions, authors and assignees matched by e-mail among the members |

Not restored, but kept in the package as records: reviews and their approval steps, transmittals and the
audit log (the new project's audit log starts with the restore, `project.imported`; a hash-chained log
cannot be replayed). Issue numbers are given anew in the order of the source numbers. Viewer
derivatives, previews and search text are rebuilt in the background as after an upload.

The package is deleted from the storage when the restore is done. A restore that fails after the project
was created leaves that project deleted (archived: hidden, its code free again).

## Large projects

The export ZIP is streamed into the storage (`storage/exports/<project>/…`) entry by entry, every entry
hashed as it is written; files in already compressed formats are stored, the rest deflated. Only the
metadata parts are built in memory; issues are packed 500 per BCF file. The restore reads the package
with random access (entry by entry) and streams every version into the storage. Progress is written
about once a second. The job queue runs one job at a time.

Limits: the close-out ones (`CDE_CLOSEOUT_MAX_GB` largest export, `CDE_CLOSEOUT_MIN_FREE_GB` free disk
reserve, `CDE_CLOSEOUT_RETENTION_DAYS` download period; [close-out limits](CLOSEOUT_ARCHIVE.md#limits)).
The size and disk checks run when the export is asked for and again when the job starts. The upload of
a package follows the installation's upload limit; a metadata part above 512 MB is refused.

## Audit

| Action | When |
|---|---|
| `project.exported` | An export finished. Details: scope, counts, ZIP size and SHA-256, schema. Written for the person who asked |
| `project.export_downloaded` | The ZIP was downloaded (size, SHA-256, scope) |
| `project.export_deleted` | The ZIP was deleted before its download period ended |
| `project.imported` | A restore created the project (on the new project). Details: the source (project, schema, scope, time, generator), counts, unknown people and companies, skipped permissions, the package's name, size and SHA-256 |

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /projects/:pid/exports` | Project administrators | Scope, the last 20 exports, limits, the estimate |
| `POST /projects/:pid/exports` | Project administrators | Queues an export; 409 while one is being built, 400 over the limit or without disk space |
| `GET /projects/:pid/exports/:id` | Project administrators | One export with its progress |
| `GET /projects/:pid/exports/:id/download` | Project administrators (`full`: system administrators) | The ZIP; 410 after the download period |
| `DELETE /projects/:pid/exports/:id` | Project administrators (`full`: system administrators) | Deletes the ZIP now |
| `GET /project-imports` | System administrators | The last 20 restores |
| `POST /project-imports` | System administrators | Multipart: `file` (the package), `code`, `name` (optional); queues the restore; 409 when the code is in use |
| `GET /project-imports/:id` | System administrators | One restore: phase (`verify`, `import`), progress, the report, the new project |

Data: `project_exports`, `project_imports` (migration `0059_project_export`). Code:
`apps/server/src/portability/` (`collect.ts` what goes in, `export.ts` the export job, `import.ts`
verification and restore, `zip.ts` the hashed ZIP writer, `routes.ts`), the shared planning in
`apps/server/src/closeout/collect.ts`; screens `apps/web/src/features/project-settings/pages/ProjectExport.tsx`
and `apps/web/src/features/projects/components/RestoreProjectDialog.tsx`.

## Tests

- `apps/server/test/portability/project-export.test.ts` — a project administrator's export (only what
  they can see: a task team's WIP under the team-only rule is left out; SHA256SUMS and the manifest's
  checksum list match every entry; files.json with all versions, codes, document code and integrity;
  folders with permissions; members, roles and task teams; the BCF 3.0 issues; the audit log as CSV and
  JSON without IP addresses), `project.exported` and the notification, a system administrator's export
  (everything; not downloadable by a project administrator), deleting; the restore into a second
  installation (files, versions, bytes and codes, document code, folders with states and owning team,
  WIP rule, members by e-mail, unknown people reported and not created, skipped permissions, the issue,
  `project.imported`), only system administrators, a code in use refused, a tampered file and an
  unlisted entry refused before anything is written.
- e2e `e2e/specs/project-export.spec.ts` — the Export tab: scope and estimate, the export built in the
  background, the download and its contents, the notification; Restore Project with the downloaded ZIP
  and opening the new project.
