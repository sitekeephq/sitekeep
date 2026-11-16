# Audit log

SiteKeep records who did what, when and from where in one append-only, tamper-evident log
(`audit_log`). It is the audit trail ISO 19650 asks of a common data environment
(ISO 19650-1 §12.5, ISO 19650-2 §5.1.7(d); [ISO 19650 conformance](../compliance/ISO19650.md)).
Part of SiteKeep Community. The CDE events it records are described with the [CDE states](CDE_STATES.md);
rows about another task team's WIP are withheld as described in [task teams](TASK_TEAMS.md#query-paths-checked).

## What is recorded

Every write in the core and in the modules goes through one helper, `audit()`
(`apps/server/src/core/platform/audit.ts`, also exported by the SDK). A row holds:

| Column | Meaning |
|---|---|
| `id` | Position in the chain (set by the database) |
| `at` | Time (UTC in exports) |
| `project_id`, `user_id` | Project and person; empty for system rows and background work without a person |
| `action` | What happened, e.g. `file.uploaded`, `folder.permissions_set`, `cde.transition` |
| `target_type`, `target_id` | What it happened to (`file`, `folder`, `role`, `review`, …) |
| `details` | JSON with the specifics (names, versions, from/to folders, changed fields) |
| `ip`, `user_agent` | The client of the request (see [Privacy](#privacy)); empty for background work |
| `prev_hash`, `hash` | The hash chain |

Document events that matter for ISO 19650:

| Action | When |
|---|---|
| `file.uploaded`, `file.version_added` | A file or a new version is stored |
| `file.viewed` | A version is opened in a viewer (preview, PDF, media, model). One row per person, version and 15 minutes (`VIEW_DEDUPE_MS`, `apps/server/src/cde/events.ts`) |
| `file.downloaded`, `file.zip_downloaded` | The original or a ZIP is downloaded (also over OpenCDE) |
| `file.moved` | The file changes folder |
| `cde.transition` | The file changes CDE state: a direct move into a folder of another state, an approved review copy (`mode: review`), an automatic step. Details: `fromState`, `toState`, `mode`, folders, review, reason. A move between two folders of the same state is only `file.moved` |
| `cde.override` | A project administrator went past a CDE rule with a reason: codes outside WIP (`what: "codes"`), a transition (`what: "transition"`, `POST /files/:id/transition`), a team WIP exception |
| `cde.superseded`, `cde.returned`, `cde.withdrawn` | Transitions (ISO-1): a publication archived on a newer one; a WIP document sent back by a review (suitability S0, team notified); a Shared copy refused for publication |
| `file.updated`, `file.deleted`, `file.restored`, `file.purged` | Rename, attributes, description; recycle bin |
| `folder.permissions_set`, `role.*`, `member.*`, `role_package.applied` | Permission changes |
| `invitation.*` (created, resent, accepted, revoked, settings) | [Invitations](INVITATIONS.md) of people without an account |
| `folder.updated`, `folder.settings_updated`, `cde.settings_updated` | Folder and CDE settings |
| `review.*` | Reviews and their decisions |
| `audit.exported` | Someone downloaded the log as CSV (the filters are in `details.query`) |
| `audit.chain_started` | The genesis row written when the chain was switched on (migration 0043) |

The client is taken from the request automatically: an `onRequest` hook (`apps/server/src/app/build-app.ts`)
puts it in an `AsyncLocalStorage` that `audit()` reads, so every row written while a request runs carries
it, including rows written by modules.

## Append-only and hash-chained

Migration `0043_audit_chain` makes the table append-only in the database itself, on PostgreSQL and on the
embedded PGlite alike:

- **Insert trigger** `audit_log_chain` (BEFORE INSERT): takes a transaction-level advisory lock
  (`pg_advisory_xact_lock`), draws the row id from the sequence under that lock, reads the hash of the
  latest chained row as `prev_hash` and sets
  `hash = sha256(prev_hash || '|' || canonical row)`. The canonical row is the JSON array
  `[id, project_id, user_id, action, target_type, target_id, details, at (UTC, microseconds), ip, user_agent]`
  (`audit_log_canonical`, `audit_log_hash`). A writer cannot choose the id, `prev_hash` or `hash`. The id
  column has no default any more: with the trigger disabled an insert fails.
- Because the lock is held until commit, writers are serialised and id order is chain order. A
  transaction that writes an audit row holds the lock until it ends, so keep such transactions short.
- **Update / delete / truncate triggers** `audit_log_immutable`, `audit_log_no_truncate`: refuse every
  change (`audit_log is append-only`). Nothing in SiteKeep updates or deletes audit rows: projects are
  archived, not deleted; the recycle bin purges files and folders, not their log; the table has no
  foreign keys, so removing a user or a project never cascades into it. The report refresh triggers
  that fired on update and delete of `audit_log` (0020_report_stamps) were dropped; the insert one stays.
- Rows written before 0043 keep `hash = null` ("legacy rows"); the genesis row `audit.chain_started`
  opens the chain after them.

Someone with database owner rights can still disable triggers. The chain makes that visible: the
check below recomputes every hash. To protect against a rewrite of the whole tail of the chain, record
the head hash (shown by the check) somewhere outside the server from time to time, e.g. in the backup
log or a signed e-mail.

## Checking the chain

- **API:** `GET /api/v1/admin/audit/verify` (system administrators).
- **Screen:** Project Settings → Audit Log → **Check the Chain** (system administrators).
- **CLI:** `npm run audit:verify -w @sitekeep/server` (development) or `node dist/scripts/audit-verify.js`
  in the server image. Uses `DATABASE_URL`, or `DATA_DIR/db` (PGlite; stop the server first, PGlite opens
  in one process only). Exit code 0 = intact, 2 = broken, 1 = could not run.

The check walks the chain in id order from the genesis row and reports the first row that breaks it:

| Reason | Meaning |
|---|---|
| `missing_hash` | A row after the genesis row has no hash: inserted with the trigger disabled |
| `prev_mismatch` | The row does not point to the previous row's hash: a row before it was removed or reordered |
| `hash_mismatch` | The row's fields do not hash to its stored hash: the row was changed |

Result: `{ ok, checked, legacyRows, head: { id, hash, at }, broken: { id, reason } | null }`.

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /projects/:pid/audit` | Project administrators | One page, newest first: `{ entries, nextCursor }` |
| `GET /projects/:pid/audit.csv` | Project administrators | Every row of the same filters, streamed; writes `audit.exported` |
| `GET /projects/:pid/files/:id/history` | Anyone who may view the file | Rows about the file and its versions; IP and user agent only for project administrators |
| `GET /admin/audit`, `GET /admin/audit.csv` | System administrators | All projects and system rows; extra filter `projectId` |
| `GET /admin/audit/verify` | System administrators | The chain check |
| `GET /projects/:pid/activity` | Project administrators | The older list (still used by the web app and reports) |

Filters (query string): `from`, `to` (a date `YYYY-MM-DD` — `to` includes that whole day — or an ISO time),
`action` (exact, or a prefix ending in `.*` such as `file.*`), `userId`, `targetType`, `targetId`;
paging: `limit` (1–500, default 100) and `cursor` (the `nextCursor` of the previous page).

CSV: `;` separated, UTF-8 with BOM, CRLF, cells that start with `= + - @` prefixed with `'` (the same
helper as the other exports, `apps/server/src/docintel/export.ts`). Columns: number, time (UTC), project,
user, action, target type, target id, target name, IP address, user agent, details (JSON), hash. Column
names follow the reader's language (`lang` in the query, else `Accept-Language`; the web app passes its interface language).

## Screens

- **Project Settings → Audit Log** (advanced settings, project administrators): filters (from, to,
  action or action group, person, a target picked from a row), pages of 50 with **Load More**,
  **Download CSV**, the client's IP address (user agent on hover), and the chain check for system
  administrators (`apps/web/src/features/project-settings/pages/ProjectAuditLog.tsx`).
- **File drawer → Audit History**: the file's rows, loaded when opened
  (`apps/web/src/features/documents/components/cde/FileHistoryPanel.tsx`, through the CDE slot
  `FileCdePanel`).

## Privacy

The IP address and the browser's user agent are personal data. They are stored with every row written
during a request (decision D-9) to show who acted from where, and are never deleted: the log is
append-only and has no retention period. Only project and system administrators see them. See
[Privacy](PRIVACY.md#audit-log-ip-address-and-user-agent).

## Tests

- `apps/server/test/audit/audit-log.test.ts` — chain and genesis row, forged hash ignored, update /
  delete / truncate refused, tamper detection (changed, removed, unchained row), upgrade with legacy
  rows, concurrent writers, IP and user agent on rows, view deduplication, `file.moved` and
  `cde.transition`, downloads / deletes / restores / permission changes, filters and cursor pages, CSV,
  file history, permissions, system log and chain check (PGlite).
- `apps/server/test/cde/migration.test.ts` — the table is append-only after the migrations.
- `apps/server/test/cde/iso19650-acceptance.test.ts` — the events of a whole ISO template project
  (review, transition, superseded, returned, withdrawn) and a tampered row found through the API.
- `apps/web/test/documents/audit-labels.test.ts` — row texts and query.
- e2e `e2e/specs/audit-log.spec.ts` — file history, Audit Log tab with filter, CSV download, chain check;
  `e2e/specs/administration-settings.spec.ts` (tab).

The same SQL was checked on PostgreSQL 15 with 200 concurrent writers and interleaved transactions.
