# Connect module

SiteKeep Connect contains the enterprise connections:
- record sync with Autodesk Forma / ACC (issues, reviews, forms, RFIs, submittals, locations, users),
- file import through APS,
- editing office files in the browser (WOPI for ONLYOFFICE / Collabora),
- Revit `.rvt` models in the model viewer, converted on the server without Autodesk (from 0.5.0).

Product description: SiteKeep editions and modules §2, §3.2.
Feature documents: [Forma Sync](../features/FORMA_SYNC.md).

| | |
|---|---|
| Repository | [sitekeephq/sitekeep-connect](https://github.com/sitekeephq/sitekeep-connect) (private); local clone `~/Desktop/7dimensions/sitekeep-connect` |
| Package | `@sitekeephq/sitekeep-ee-connect` (GitHub Packages) |
| Version in this repository | `0.5.1` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@sitekeephq/sitekeep-sdk` `>=0.17.0 <1.0.0` |
| ID | `connect` (`SITEKEEP_MODULES`) |

The history before the move is in this repository. On the server: `apps/server/src/integrations/autodesk`,
`office/{wopi,locks}.ts` and `admin/forma-sync.ts`; on the web: `apps/web/src/features/integrations/{components/OfficeEdit,pages/OfficeEditor}.tsx`
and `features/admin/{pages/AdminFormaSync,pages/ProjectFormaSync,forma-sync}`.

## Boundary

Office: **viewing and conversion are in the core, editing is in Connect.** What stays in the core and why:
- Office settings (Administration → Office Integration: editor and converter addresses, test) are in the core.
- Office → PDF conversion (ONLYOFFICE, Collabora, Gotenberg, local soffice) is in the core; previews depend on it.
- Discovery and proof validation are in the core.
- The `wopi_locks` / `wopi_tokens` tables are in the core; uploading a new version checks the edit lock.

Without Connect, the "Edit" button and the lock note in the file drawer are hidden. The `/edit/:fileId` page
and the `/wopi` endpoints do not exist either.

Autodesk is entirely in the module. This covers connections, external entities and their links, sync runs, file
imports, the scheduler and resuming interrupted imports. The import
writes to the core's records: issues, reviews, work items, locations. Forms are written through the `field.externalForms` capability;
if Field is missing, they are skipped.

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: migrations, routes, `rootRoutes` (`/wopi`), `start` (sync scheduler, interrupted imports), `tables` |
| `server/autodesk/` | APS client, OAuth (PKCE), document browsing, file import, record sync and projection, routes |
| `server/office/` | WOPI host (`/wopi/files/...`), locks, file editor endpoints (`/files/:id/office`, `/office/session`, `/office/lock`) |
| `server/forma-sync.ts` | `GET /admin/forma-sync` (Administration → Forma Sync sample screen) |
| `server/schema-tables.ts` | `autodesk_connections`, `external_entities`, `external_entity_links`, `integration_sync_runs`, `autodesk_file_imports` |
| `web/` | Forma Sync page and Administration section, editor page, "Edit" button, lock note (`connect.ui`) |
| `migrations/0000_connect` | Own journal `drizzle.__drizzle_migrations_connect`; idempotent, from the core's 0031, 0040, 0041 |

## Revit models

From Connect 0.5.0 an uploaded `.rvt` opens in the model viewer like an IFC
([model formats](../features/MODEL_FORMATS.md)). The module lists `rvt` in `modelFormats` / `modelExtensions`; its
converter (`server/model/rvt.ts`) runs [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) `rvt-ifc` (Apache-2.0) as a
separate process, nothing leaves the server:

1. `rvt-ifc <file> -o <temp.ifc> --diagnostics <temp.json>`; the program is found at `SITEKEEP_RVT_IFC_PATH`,
   `/usr/local/bin/rvt-ifc` or on `PATH`. The Docker image installs a pinned release (Dockerfile stage `rvtrs`;
   not in Community images).
2. Placeholder objects without geometry of their own (RPC trees, people: generic objects whose body is only a
   bounding box) keep their element but lose the box, which would otherwise hide the building (`hidden`).
3. The diagnostics give the Revit release, its support level in rvt-rs and the elements drawn as boxes
   (`approximated`); the file panel shows them.
4. Limits (0.5.1): the converter runs under `ulimit -v` (`SITEKEEP_RVT_MEMORY_MB`, default 2048; the app and the
   database share the server); `--allow-partial` opens a model with a part larger than the reader's limits
   (256 MB per stream) marked "incomplete"; an export without any element is refused with a message instead of
   an empty model.

Trial on 56 real project files (18.11.2026, Revit 2027, 1–354 MB): every file converted in 2–79 s,
at most 1.06 GB of memory; structure (columns, beams) and MEP pipes come with real shapes, architecture partly
as boxes; the 354 MB site model opens incomplete; two MEP files give no element (Revit 2027 is "experimental" in
rvt-rs). Stored `.rvt` versions are converted at start-up ([model formats](../features/MODEL_FORMATS.md)).
The module reports the installed `rvt-ifc` version (`ModelFormat.version`, from Connect 0.5.2 / SDK 0.18.0): after an
rvt-rs update the core converts the models again and retries failed ones once; the converted IFC is kept and can be
downloaded from the file panel. On-prem settings: [Revit models](../onprem/docker-compose.md#revit-models-enterprise).
What is still open (clash/IDS/quantities for `.rvt`, Autodesk imports of `.rvt`):
[model formats → open work](../features/MODEL_FORMATS.md#open-work).

Quality by release (trial 18.11.2026 on Autodesk's sample projects): 2023–2027 projects give typed elements with
their saved shapes (92 % on the 2024 advanced sample, 78 % on the 2023 basic one), 2022 and older mostly boxes
("experimental" in the file panel). Typical models
convert in 1–8 seconds with under 0.5 GB of memory. Without the program a version fails with a message that says
how to install it.

What a converted model does: model viewer, "Modele sor" and model queries, version comparison, model markups,
the models report dataset. What still needs an IFC file: model sets (federation, clash), IDS checks, parameter
changes (they write the IFC; the file panel hides the button for `.rvt`), quantities and 4D/5D links.
End-to-end test with the real program: `e2e/specs/revit-model.spec.ts` (`RVT_SAMPLE`, `SITEKEEP_RVT_IFC_PATH`).

## Where it connects to the core

| Core | How |
|---|---|
| Routes; `/wopi` | `ServerModule.routes`, `rootRoutes` |
| Background jobs | `ServerModule.start` (new): when the server starts, after the job queue; stopped on shutdown |
| File drawer: Edit, lock | web `connect.ui` (`useFileOffice`, `OfficeEditButton`, `OfficeLockNote`) |
| Administration → Forma Sync | `connect.ui.AdminFormaSyncSection`; the tab appears only when installed |
| Project pages `edit/:fileId`, `forma-esitleme` | `WebModule.projectRoutes`; `LEGACY_URLS.module` |
| Field forms | `field.externalForms` |
| Model viewer for `.rvt` | `ServerModule.modelFormats`, `WebModule.modelExtensions` (SDK 0.17.0) |
| Privacy Centre → External Connections: `autodesk` | `registerPrivacyConnection` (SDK 0.15.0); older releases are declared by the core (`privacy/legacy-connections.ts`) |

## Tests

| Location | What |
|---|---|
| `sitekeep-connect`: `npm test` | Boundary check, Forma Sync status rules |
| `apps/server/test/modules/connect/` | Autodesk sync and file import, WOPI and Office settings |
| `apps/server/test/platform/admin-status.test.ts` | Forma Sync endpoint with `hasConnect` |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- Office settings and Office → PDF conversion are in the core; `/wopi/convert/:ticket/:name`, from which ONLYOFFICE downloads the source file, also belongs to the core (`office/routes.ts`; before Connect 0.3.2 it was in Connect, and ONLYOFFICE conversion did not work in an install without Connect). Scenario without Connect: `apps/server/test/integrations/office-conversion.test.ts` (settings, Gotenberg, ONLYOFFICE). The WOPI editor belongs to Connect (`wopi.test.ts`).
- Forma Sync types are in the package (`shared/forma-sync.ts`); Autodesk and Office DTOs are in the core. Strings are in the module (`locales/`); the `office` keys for the core's Office settings and conversion are in the core.
- `scripts/import-autodesk.ts` (document snapshot import script) is in the core and does not depend on Autodesk module code.
