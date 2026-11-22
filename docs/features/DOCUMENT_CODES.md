# Unique document codes (ISO-3)

ISO 19650-1 §12.1 and ISO 19650-2 §5.1.7(a) ask for a unique identifier for every information
container, based on an agreed naming convention. SiteKeep takes it from the project's naming
standards. Part of the [CDE states](CDE_STATES.md) work; clause mapping:
[ISO 19650 alignment](../compliance/ISO19650.md).

## The code of a file

- The code is the part of the file name, without extension, that parses against a naming
  standard: the folder's own (or the nearest ancestor's), otherwise the project's container
  standard (`project_cde_settings.container_standard_id`, Project Settings → CDE → **Document Code
  Standard**). With `allowSuffix`, the free text after the last field is not part of the code; nor
  are fields with `inCode: false` (the Revizyon No of the [ÇŞB 2026 profile](NAMING_CSB_2026.md)), so
  `…_01_000.dwg` and `…_01_001.dwg` are one document. The
  ISO 19650 templates put their standard on Shared and Published and choose it as the document code
  standard (template `cde.containerStandard`), so codes are checked from WIP on; in other projects
  choose it in Project Settings → CDE.
- A name that parses against no standard has no code and is not checked (D-5).
- `files.document_code` keeps the code as written; the register `document_codes` keys it
  upper-cased (`code_norm`) per project.

## Enforcement (D-8)

The refusals below (the code conflict and the rename lock) apply only when the project enforces the ISO rules:
`project_cde_settings.enforce_transitions` (Project Settings → CDE; on for projects from the ISO
template, off for existing projects). When it is off, codes are still derived and registered,
renditions still join their container, and the backfill and the conflicts list work as usual; a
file whose code is held by another document is stored, keeps the code in `files.document_code`,
gets a non-blocking `warning` (same shape as the 409 details) in its upload result, and appears in
the conflicts list.

## Rules (enforcement on)

| Write | Result |
|---|---|
| New file whose code is free | Registered to the new file's container in the same transaction |
| New version of a file | Allowed (same container) |
| Approved review copy | Allowed: the copy joins the source's container |
| Same code, other extension, in a folder where a file of that container sits (rendition, D-6) | Allowed: the new file joins that container |
| Same code anywhere else (upload, OpenCDE, a module's `addVersion`) | Refused: 409 `document_code` with the path of the document that holds the code. The upload route reports it per file (`results[].conflict`; the request answers 400 when no file was stored). A holder in a team's WIP closed to the caller is not named (`existingPath: "…"`) |
| Manual "Copy to" keeping the code | 409: a copy is a new container |
| Rename or move to a code held by another container | 409 |
| Move without a code change | Allowed (same container) |
| Rename of a coded file whose container has a file in a Shared, Published or Archived folder | 403 for members; project administrators may with `reason` in the PATCH body (audit `cde.override`) |

A rename that changes the code frees the old code when no other file of the container uses it.
A code whose container has no file left at all (purged) is free again; files in the trash keep it.

The upload dialog shows the refusal (or, with enforcement off, the warning) on the file's row with
the code and the path of the document that holds it.

## Live data

Codes of existing files are registered first come, first served by `created_at`
(`runDocumentCodeBackfill` in `apps/server/src/cde/document-code.ts`). It runs at server start
after the migrations and from `apps/server/src/scripts/cde-backfill.ts`; it is idempotent and
batched (only live files without a code, in projects that have a naming standard). A standard
assigned to a folder later codes its files at the next run.

Duplicates found this way are not blocked retroactively: such a file keeps taking new versions and
can be moved. `GET /projects/:pid/cde/code-conflicts` (project administrators) lists them, shown
in Project Settings → CDE → Code Conflicts. Renaming the duplicates resolves them.

## Code

- Guard: `checkDocumentCode` (`apps/server/src/cde/guards.ts`) → `checkDocumentCodeImpl`
  (`apps/server/src/cde/document-code.ts`); new containers register after insert with
  `registerNewFileCode` (`addVersion`, manual copy).
- API: `apps/server/src/cde/document-code-routes.ts`.
- Web: `apps/web/src/features/documents/components/DocumentCodeConflictNote.tsx`,
  `apps/web/src/features/project-settings/components/CdeCodeConflicts.tsx`.
- Tests: `apps/server/test/cde/document-code.test.ts`, e2e `documents.spec.ts`
  ("ISO19650-2 5.1.7(a) unique container id"); in an ISO template project, step "refuses a document
  code another container holds (ISO-3)" of `apps/server/test/cde/iso19650-acceptance.test.ts`.
