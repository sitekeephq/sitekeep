# Close-out archive

At project close-out ISO 19650-2 §5.8.1 asks the appointing party to archive the project information
model: the information containers that were published and the record of how they got there. SiteKeep
builds this as one ZIP package, with a metadata manifest, the project's audit log and the result of the
audit chain check, and can then close the project so that nothing changes any more. Part of SiteKeep
Community ([ISO 19650 conformance](../compliance/ISO19650.md#related-iso-19650-2-clauses)).

## Using it

Project Settings → **Close-out** (project administrators):

1. Choose what goes in: **Published and Archived** information (always), **Include Shared Information**
   (optional), and **Current Version of Each File** or **All Versions**.
2. Optionally tick **Close the Project (Read-Only) When the Archive Is Complete**.
3. **Create Close-out Archive**. The archive is built in the background (job queue); the row shows how many
   files are done and a progress bar. Only one archive per project is built at a time.
4. When it is **Ready**, **Download** it. The link works for the download period (default 14 days,
   [limits](#limits)); then the ZIP is deleted and the row says **Expired**. **Delete File** removes it
   earlier.

The page shows beforehand how many files, versions and bytes each choice would hold, and the size limit
when one is set.

## Contents

```
README.txt                what the package is, when and by whom it was made, the audit head hash
manifest.json             one entry per version (schema sitekeep.closeout-manifest/1)
manifest.csv              the same as a table, one row per version
audit/audit-log.csv       the project's audit log up to the head the chain check saw
audit/audit-verify.json   the audit chain check at the time of the archive
files/<folders>/<file>    the files in the project's folder structure
SHA256SUMS                SHA-256 of every other file in the package
```

**Which files.** Every file (not in the trash) in a folder whose CDE state is Published or Archived, and
Shared when asked; the state is the folder's own or its nearest ancestor's
([CDE states](CDE_STATES.md)). The archive is built for the project, not for one person: folder
permissions do not filter it (only project administrators can make and download it). Task-team WIP is
never included. With **All Versions**, the current version keeps the file's name and older ones are
named `name (V2).ext`; two names that differ only in case get ` (2)`.

**manifest.json** (`CloseoutManifestEntry` in `packages/shared/src/documents/closeout.ts`), per version:

| Field | Meaning |
|---|---|
| `path` | Path inside the ZIP |
| `fileId`, `versionId`, `version`, `latest` | The file and version in SiteKeep |
| `name`, `folderPath` | File name and folder path |
| `documentCode`, `containerId` | Unique document code and information container ([document codes](DOCUMENT_CODES.md)) |
| `revision`, `suitability` | Codes of the version ([codes](CDE_STATES.md#codes)) |
| `cdeState`, `cdeStatus` | State of the folder; `superseded`, `returned` or `withdrawn` when the file carries it |
| `size`, `sha256` | Size and the SHA-256 stored when the version was uploaded |
| `integrity` | `ok`: the bytes put in the ZIP hash to the stored SHA-256; `mismatch`; `missing`: not in the storage, so not in the ZIP |
| `uploadedBy`, `uploadedAt` | Who uploaded the version and when (UTC) |
| `approvals` | Reviews of the version: the review that took this version in (`role: reviewed`) and the review whose approved copy it is (`role: result`), with the workflow, the outcome, the decision date and every reviewer's mark (step, person, outcome, time, comment) |
| `supersededBy`, `supersedes` | ISO-12 links (`cde_supersessions`, [supersession](CDE_STATES.md#supersession-iso-12)), with the other version's path in the ZIP when it is included |
| `naming` | The file name checked against the folder's naming standard: standard, `ok`, errors; `null` when no standard applies |

The top of manifest.json holds the schema, the time, the SiteKeep version, the project, the person, the
options, the counts and the audit chain result. manifest.csv has the same rows (`;` separated, UTF-8 with
BOM; column names and README.txt in the language of the person who asked for the archive).

**Audit log.** The chain check (`verifyAuditChain`, as `npm run audit:verify`) runs when the archive is
built; its result is in `audit/audit-verify.json`, in manifest.json, in README.txt and on the row of the
archive. `audit/audit-log.csv` holds the project's rows up to that head, in the columns of the audit log
CSV without the IP address and user agent: those are personal data with their own retention period
([audit log](AUDIT_LOG.md#personal-data)), and an archive is kept for many years. Rows about another
task team's WIP are withheld as in the screen of the person who asked. Keep the head hash outside
SiteKeep: any later change, removal or insertion of an audit row up to it makes the chain check fail.

**Checking a package.** `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`) checks every
file; the `integrity` column says whether each file matched the hash stored at upload. The SHA-256 of the
ZIP itself is shown on the row of the archive and recorded in the audit log.

## Large projects

The ZIP is streamed straight into the storage under `DATA_DIR` (`storage/closeout/<project>/…`), file by
file; nothing is held whole in memory except the manifest. Every file is hashed as it is written. Files
in already compressed formats are stored, the rest deflated. Progress (files and bytes done) is written
about once a second. The job queue runs one job at a time, so other background work (model conversions,
previews) waits while a large archive is built. A job interrupted by a restart starts again.

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `CDE_CLOSEOUT_MAX_GB` | no limit | Largest archive (sum of the files in it); a larger one is refused |
| `CDE_CLOSEOUT_RETENTION_DAYS` | 14 (1–365) | Days a finished archive can be downloaded; then the ZIP is deleted (hourly clean-up, and when the page or the link is opened) |
| `CDE_CLOSEOUT_MIN_FREE_GB` | 2 | Free disk space to keep: an archive is refused when the disk holding the storage has less than its size + 5 % + this |

The size and disk checks run when the archive is asked for and again when the job starts.

## Closing the project

A closed project is read-only: files and folders can be viewed, opened in the viewers and downloaded
(also as a bulk ZIP); nobody can upload, create, rename, move, delete, review or change settings. A
banner says so on every page of the project. Ways to close it:

- **Close the Project (Read-Only) When the Archive Is Complete** when creating the archive: the project
  is closed only if the archive has no missing or changed files;
- **Close Project** on the Close-out tab, after at least one complete archive.

Only a **system administrator** can reopen it (**Reopen Project**, with an optional reason). Closing and
reopening are in the audit log.

How it is enforced (`apps/server/src/closeout/closed.ts`): every write request (not GET / HEAD) to an
`/api/v1` route with a project is refused with `403 project_closed`, except the routes that only read
(the read-only POSTs of API tokens, bulk download, previews), the close-out archive itself, reopening,
and members and invitations (people who need to read the archived project). The CDE upload and move
guards (`checkUpload`, `checkMove` in `apps/server/src/cde/guards.ts`) refuse as well, so the paths
outside `/api/v1/projects/:pid` — the OpenCDE Documents API and Enterprise modules through the SDK — do
too. Someone outside the project still gets 404.

Projects already have an `archived` flag: it means *deleted* (hidden, code freed), not read-only, so the
closed state is separate (`projects.closed_at`, `closed_by`).

## Audit

| Action | When |
|---|---|
| `project.closeout_archive_created` | An archive finished. Details: options, versions, bytes, ZIP size and SHA-256, problems, the audit head (id, hash) and whether the chain was intact. Written for the person who asked |
| `project.closeout_archive_downloaded` | The ZIP was downloaded (size, SHA-256) |
| `project.closeout_archive_deleted` | The ZIP was deleted before its download period ended |
| `project.closed` | The project was closed (details: the archive) |
| `project.reopened` | A system administrator reopened it (details: when it was closed, the reason) |

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /projects/:pid/closeout` | Project administrators | Closed state, the last 20 archives, limits, the estimate per option |
| `POST /projects/:pid/closeout/archives` | Project administrators | `{ includeShared, versions: "latest" \| "all", closeProject }`; queues the job; 409 while one is being built, 400 when there is nothing to archive, over the limit or without disk space |
| `GET /projects/:pid/closeout/archives/:id` | Project administrators | One archive with its progress |
| `GET /projects/:pid/closeout/archives/:id/download` | Project administrators | The ZIP; 410 after the download period |
| `DELETE /projects/:pid/closeout/archives/:id` | Project administrators | Deletes the ZIP now |
| `POST /projects/:pid/close` | Project administrators | Closes the project after a complete archive |
| `POST /projects/:pid/reopen` | System administrators | `{ reason? }`; reopens it |

`GET /projects/:pid` carries `closedAt`. Data: `closeout_archives` (migration `0052_closeout_archive`),
`projects.closed_at` / `closed_by`. Code: `apps/server/src/closeout/` (`collect.ts` what goes in and the
manifest metadata, `build.ts` the job and the clean-up, `closed.ts` the read-only rule, `routes.ts`),
screen `apps/web/src/features/project-settings/pages/CloseoutArchive.tsx`.

## Tests

- `apps/server/test/closeout/closeout-archive.test.ts` — package contents (files of Published and
  Archived in their folders, manifest fields: codes, state, SHA-256, approvals with the approver,
  supersession links both ways with paths, naming check; manifest.csv; the audit CSV without IP
  addresses, ending at the chain head; README; SHA256SUMS matches every file; the ZIP's SHA-256), audit
  rows, Shared and all versions, size limit and disk space, expiry (410), a missing file listed as a
  problem and the project left open; closing on completion, refused writes on the API and in the CDE
  guard (OpenCDE path), viewing and downloading still allowed, reopening by system administrators only,
  closing from the button, no disclosure to people outside the project.
- e2e `e2e/specs/closeout-archive.spec.ts` — the Close-out tab: estimate, building in the background,
  download and its contents, the closed banner, a refused upload, reopening with a reason, the audit rows.
