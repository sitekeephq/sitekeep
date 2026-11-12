# Connect module

SiteKeep Connect contains the enterprise connections:
- record sync with Autodesk Forma / ACC (issues, reviews, forms, RFIs, submittals, locations, users),
- file import through APS,
- editing office files in the browser (WOPI for ONLYOFFICE / Collabora).

Product description: SiteKeep editions and modules §2, §3.2.
Feature documents: [Forma Sync](../features/FORMA_SYNC.md).

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-connect](https://github.com/7Dimensions-Project/sitekeep-connect) (private); local clone `~/Desktop/7dimensions/sitekeep-connect` |
| Package | `@7dimensions-project/sitekeep-ee-connect` (GitHub Packages) |
| Version in this repository | `0.3.2` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.10.0 <1.0.0` |
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

## Where it connects to the core

| Core | How |
|---|---|
| Routes; `/wopi` | `ServerModule.routes`, `rootRoutes` |
| Background jobs | `ServerModule.start` (new): when the server starts, after the job queue; stopped on shutdown |
| File drawer: Edit, lock | web `connect.ui` (`useFileOffice`, `OfficeEditButton`, `OfficeLockNote`) |
| Administration → Forma Sync | `connect.ui.AdminFormaSyncSection`; the tab appears only when installed |
| Project pages `edit/:fileId`, `forma-esitleme` | `WebModule.projectRoutes`; `LEGACY_URLS.module` |
| Field forms | `field.externalForms` |

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
