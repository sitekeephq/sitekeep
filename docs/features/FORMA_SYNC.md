# Forma file sync

Bringing **records, folders and files** from Forma / Autodesk ACC into the CDE (and writing published content
back). Working today: **record** sync (issues, reviews, forms, RFIs (bilgi talebi),
submittals, locations, users and companies) and **manual file import**. Automatic file
runs from folder mappings (phase 2) and outbound writing are not available yet.

Design (archive, not a contract):
Backup and Forma Sync §2.
This page is the only place for Autodesk in a project; Project Settings has no Autodesk tab
(`?sekme=autodesk` and `?sekme=forma-esitleme` redirect here). Secrets are not written down.

---

## Today

Path: project menu **Administration → Forma Sync** (`/projects/:id/forma-esitleme`,
project administrators; the API enforces the same rule).

| Part | What | Real? |
|---|---|---|
| ACC Project | pick an ACC project from the list → Connect with Autodesk; when connected: name, account, automatic sync (every 30 min, stop/start), Change | yes |
| Bring | **Bring All** (all record types) · **Bring Selected** (chosen record types, with ACC/CDE counts; or files from Autodesk Docs) | yes |
| Transfer | record sync step by step (per type ✓ / fetching / waiting, record count, percentage, **Cancel**) and files (queued / downloading percentage and MB / processing / new / new version / already up to date / cancelled / error, **Cancel**) | yes |

Nothing is brought in on connecting, and automatic sync starts turned off; Bring All or
bringing selected types brings those types and turns automatic sync on. Bringing
individual records does not.

A CDE project has a single ACC project: the most recently signed-in one (`authorized_at`). When
Change connects to another project, automatic sync of the earlier ones stops; records and
files already brought in stay where they are.
| Administration (system) → Forma Sync | sample mapping screen | no; fixed sample (`admin/forma-sync.ts`) |

### How Bring from Autodesk works

1. `GET /projects/:pid/integrations/autodesk/:cid/docs?folder=<urn>`: Data Management with the
   connection's own token (`topFolders`, `folders/:id/contents`). If the hub is not in the
   connection, it is found on first opening and saved. Each file has `imported`:
   which CDE file it was previously brought into, and with which Autodesk version.
2. `POST …/:cid/imports` `{ targetFolderId, files[] }`: upload permission, the folder
   gate and the naming standard are checked immediately; files that fail are returned as
   `rejected`. Each accepted file becomes a separate `autodesk_file_import` job.
3. Job: the version is re-read from Data Management → OSS `signeds3download` →
   streamed from the signed S3 URL into `storage.put` (not buffered in memory) → `addVersion` →
   `afterVersionAdded` (IFC → Fragments, preview, title block (antet), audit log
   `via: "autodesk"`).
4. Item ↔ CDE file in `external_entity_links` (`kind: "document"`,
   `nativeType: "file"`, `metadata.versionNumber`). If the same item is brought again,
   a version is added to its own CDE file (even if it has been moved/renamed);
   the same or an older version is skipped as "already up to date".
5. Privacy: all calls go through `outboundFetch` (`entegrasyon:autodesk`);
   the S3 download is logged under the same connection and stops when it is turned off.

6. Progress: downloaded bytes are counted during the process (`bytesReceived`, only on the
   "downloading" row). On restart, an interrupted transfer starts over
   (the queue job runs again; on startup, transfers whose job was lost
   are returned to the queue by `resumeInterruptedImports`).

### Cancel

- Record sync (`POST …/:cid/sync/cancel`): if queued, it never starts; if running, it stops
  before the next type, and what has been read is stored but processed into the project tabs on the next full
  run. Steps are tracked with `GET …/:cid/progress`.
- File (`POST …/imports/:id/cancel`): if queued, it does not start; while downloading, the download is aborted and
  nothing is stored. It cannot be cancelled once the download has finished (processing).

### Record types (Bring Selected)

`GET …/:cid/records`: for each type, whether it is selected, how many records were in ACC at the last sync
(`null` = never read), and how many linked records are in the CDE. `POST …/:cid/records { kinds }`:
the selection is written to the connection (`autodesk_connections.sync_kinds`, `null` = all) and
a sync is queued immediately; scheduled runs also read only the selected types.
Types: issue, review, form, RFI, submittal, location, user
(together with companies). One way: ACC → CDE.

Individual records: in Bring Selected, a type is opened with "Show records".
`GET …/:cid/records/:kind?refresh=1` reads the type fully from ACC at that moment (stores it without processing
it into the project tabs) and lists: name, ACC number, status, updated in ACC, deleted
in ACC, CDE counterpart ("Open in CDE"), all flat fields provided by ACC (Details).
`POST …/:cid/records/bring { records: [{ kind, externalId }] }` immediately processes only the selected records into
the project tabs (`projectAutodeskRecords`); if the type is not in automatic sync, these
records are not updated later. 409 while a sync is running.

ACC endpoints (tested with a real account on 02.11.2026): companies
`hq/v1/accounts/{hesap}/projects/{proje}/companies` (account = hub ID, without
`b.`), submittals `submittals/v2`, review and form page size at most 50.
Issues, reviews, forms and submittals require a user token (401/403 with an
app token).

Code: `integrations/autodesk/documents.ts` (Data Management + OSS),
`integrations/autodesk/file-import.ts` (queue, job, list),
`integrations/autodesk/routes.ts`, web `features/admin/pages/ProjectFormaSync.tsx`.
Test: `apps/server/test/integrations/autodesk-files.test.ts`.

Limits: cloud-shared Revit models (C4R) carry no stored content
and appear as "Not Downloadable". RVT arrives as is; 3D only for IFC. Jobs run one after another in a single
queue; a large download holds up IFC conversions.

---

### Setup (once)

1. **APS application** (aps.autodesk.com → My Apps). Both types work:
   - "Desktop, Mobile, Single-Page App": PKCE only, no secret.
   - "Traditional Web App": PKCE + secret; `AUTODESK_CLIENT_SECRET` is set, and token
     requests use Basic authentication.
2. The **callback** must be registered in the application exactly:
   `https://<sunucu>/api/v1/integrations/autodesk/callback` (local:
   `http://localhost:5173/api/v1/integrations/autodesk/callback`).
3. **ACC Custom Integration.** The account administrator adds the Client ID under ACC → Account Admin → Custom
   Integrations. On an account where it is not added, sign-in works but the project
   returns 403. Check: `GET /project/v1/hubs` with the app token must
   list the account.
4. **Server:** `AUTODESK_CLIENT_ID`, `AUTODESK_CALLBACK_URL`, and if needed
   `AUTODESK_CLIENT_SECRET` (in production `app.env` + `FORCE=1` deploy).
5. **Connect:** Forma Sync → ACC Project → pick the ACC project from the list → Connect with
   Autodesk. The list comes with the application's own token (`GET …/autodesk/catalog`, only for an
   application with a secret); with no secret or an empty list, the IDs are entered manually. On return,
   Forma Sync opens and says "connected" / "cancelled". Nothing comes in
   on its own; records are requested with Bring.

Status (02.11.2026): production and local use the **7D CDE** application (its registered name at Autodesk) in our APS account
(Traditional Web App); callbacks are `sitekeep.ornek.com` and `localhost:5173`.
The application has been added to the **7Dimensions** account (18 projects). For a project in another account, the same Client ID
is added to that account's Custom Integrations.

---

## Next step: automatic file run (phase 2)

Product contract: archive §2. To wire up the engine:

1. **Data Management API.** Hub, project, folder, item, version;
   scanning by `lastModifiedTime`. Scope `data:read` inbound; `data:write` / `data:create`
   if there is an outbound rule.
2. **Signed S3 streaming.** `signeds3download` / `signeds3upload`. Large IFC files
   are not buffered in memory; resume where it left off. A timeout at 100 MB+ was seen
   in Forma MCP.
3. **Mapping record.** (Forma project + folder) ↔ (CDE project + folder) + direction +
   filter (type, name, approval, subfolder). No two directions on the same pair.
4. **Job.** `jobs` type e.g. `forma-sync`. New file → CDE upload service
   (`via: forma-sync`). New version. On rename, `external_entity_links`.
   What is deleted in Forma stays in the CDE, marked "deleted at source".
5. **Outbound.** Published only. Goes out to the Autodesk cloud; explicit consent + Privacy
   Centre (`entegrasyon:autodesk`).
6. **Endpoints.** `GET /admin/forma-sync` drops the sample and reads real mappings and
   `integration_sync_runs`. `POST …/run` = Sync Now. Adding/deleting a
   mapping becomes persistent.
7. **forma-mcp is not embedded.** The logic moves to the Node APS client. MCP can remain only as an
   assistant tool (`cde_forma_sync_status` / `_run`).

Record sync is not part of this work; it stays as is.

---

## 1. Two layers (kept separate)

| Layer | Today | This screen |
|---|---|---|
| **Record** | Issue, review, RFI, form, member | Summary badge |
| **File** | Manual import (Bring from Autodesk); no mapping run | Bring modal + Recently Transferred |
