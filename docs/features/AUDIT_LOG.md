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
| `details` | JSON with the specifics (names, versions, from/to folders, changed fields). An e-mail address is not kept here: `emailHash` takes its place ([personal data](#personal-data)) |
| `personal_hash` | Keyed hash of the row's [personal data](#personal-data) (IP address, user agent, e-mail), which is kept in `audit_personal`; empty when the row has none |
| `ip`, `user_agent` | Only on rows chained before migration 0049 that have not been [re-sealed](#re-seal); newer rows keep the client in `audit_personal` |
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
| `audit.personal_split` | Migration 0049 moved the personal data of the rows from before the chain; `details`: `legacyRowsMoved`, `chainedRowsWithPersonalData` (rows still to be [re-sealed](#re-seal)) |
| `audit.personal_expired` | The daily job deleted personal data past its retention period; `details`: `deleted`, `before`, `retentionMonths` |
| `audit.personal_erased` | One person's personal audit data was erased (`target_id`: the user); `details.deleted` |
| `audit.resealed` | A [re-seal](#re-seal): the checkpoint the re-written segment ends in |
| `auth.login_failed` | A failed sign-in: `details.emailHash` (the address itself in `audit_personal`), `user_id` when the address belongs to an account |

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
  `[id, project_id, user_id, action, target_type, target_id, details, at (UTC, microseconds), ip, user_agent]`,
  with `personal_hash` appended when the row has one (since 0049; rows without one hash exactly as
  before) (`audit_log_canonical`, `audit_log_hash`). A writer cannot choose the id, `prev_hash` or `hash`. The id
  column has no default any more: with the trigger disabled an insert fails.
- Because the lock is held until commit, writers are serialised and id order is chain order. A
  transaction that writes an audit row holds the lock until it ends, so keep such transactions short.
- **Update / delete / truncate triggers** `audit_log_immutable`, `audit_log_no_truncate`: refuse every
  change (`audit_log is append-only`). Nothing in SiteKeep updates or deletes audit rows: projects are
  archived, not deleted; the recycle bin purges files and folders, not their log; the table has no
  foreign keys to other tables, so removing a user or a project never cascades into it. (Since 0049
  `audit_personal` references it, so a plain `TRUNCATE` is refused by that key, and
  `TRUNCATE … CASCADE` by the trigger.) The report refresh triggers
  that fired on update and delete of `audit_log` (0020_report_stamps) were dropped; the insert one stays.
- Rows written before 0043 keep `hash = null` ("legacy rows"); the genesis row `audit.chain_started`
  opens the chain after them.

Someone with database owner rights can still disable triggers. The chain makes that visible: the
check below recomputes every hash. To protect against a rewrite of the whole tail of the chain, record
the head hash (shown by the check) somewhere outside the server from time to time, e.g. in the backup
log or a signed e-mail.

## Personal data

An append-only log cannot honour a retention period or an erasure request if personal data is part
of the chained rows. Since migration `0049_audit_personal` the personal part of a row is kept apart
from the chain (P1-5, issue #85):

- **`audit_personal`** (one row per audit row that has personal data, keyed by `audit_id`): the
  client's IP address and user agent, and an e-mail address the event names (lower case). It is not
  chained and has no update path; its rows are deleted, never changed. `user_id` is the person of
  the audit row.
- **What counts as personal:** the request's IP address and user agent, and a string `email` at the
  top level of `details` (failed sign-ins, invitations, …). `audit()` moves them; modules calling
  it through the SDK get the same treatment.
- **The chained row keeps** `personal_hash` = HMAC-SHA256 of `["v1", ip, user_agent, email]`, and
  `details.emailHash` = HMAC-SHA256 of the address in place of the address. The key is derived
  (HKDF-SHA256, info `sitekeep.audit.personal.v1`) from the installation's secret key
  (`CDE_SECRET_KEY` or `DATA_DIR/secret.key`), so it is stored and backed up like the other secrets
  and nobody without it can test guesses (an unsalted hash of an IPv4 address would be reversible).
  The same address always gives the same `emailHash`, so repeated failed sign-ins for one address
  stay visible after the address itself is deleted.
- **`auth.login_failed`** writes the hash, never the address; `user_id` is set when the address
  belongs to an account.
- **The chain check** still covers everything that stays: a personal record must belong to a row
  with `personal_hash` and, with the installation's key, hash to it (`personal_mismatch` otherwise).
  A deleted personal record is not a break.
- **Retention:** Administration → Privacy Centre → Settings → **Audit Log Personal Data Retention
  (months)**, default 12, 1 to 120 (`auditPersonalRetentionMonths` in `PUT /admin/privacy/settings`).
  A daily job (`apps/server/src/audit/personal.ts`, first run a minute after start) deletes the
  personal records of rows older than that, in batches, and writes `audit.personal_expired` with the
  count. The rows stay and the chain still verifies.
- **Erasure of one person:** `eraseAuditPersonal(db, { userId, email? })` deletes the personal
  records of rows the person wrote and of rows naming their address, and writes
  `audit.personal_erased`. Their rows stay under their user id, a pseudonym once the account is
  anonymised (the "anonymise user" request, P1-2, will call it).
- **Reading:** the screens and the CSV show the IP address and user agent from `audit_personal`
  while they are kept, and an administrator sees the e-mail address merged into `details`. After
  deletion they show **deleted (retention)** (the row is older than the retention period) or
  **deleted (erased)**.

### Rows written before 0049

Two kinds of rows already held personal data when 0049 ran, and they are treated differently on
purpose:

- **Rows from before the chain** (written before 0043, `hash` null, below the genesis row) are covered
  by no hash. The migration moves their IP address, user agent and e-mail to `audit_personal`
  (5 000 rows per batch, the immutable trigger switched off inside the migration only) and records
  the count in the chained row `audit.personal_split`. Nothing that could show tampering changes.
  Without the key in SQL these rows get no `emailHash`; they had no chain to anchor one anyway.
- **Rows chained between 0043 and 0049** keep their IP address and user agent (and e-mail) in the
  chained content. The migration does **not** touch them: rewriting them would change their hashes
  and every hash after them, and an upgrade that silently rewrites the chain is indistinguishable
  from tampering for anyone holding an earlier head hash. `audit.personal_split` records how many
  such rows there are (`chainedRowsWithPersonalData`). Until an administrator re-seals the chain they
  are not covered by retention or erasure, and the screens show their values from the row.

### Re-seal

A re-seal moves the personal values out of those chained rows as one deliberate, audited
maintenance operation:

```bash
npm run audit:reseal -w @sitekeep/server     # development
node dist/scripts/audit-reseal.js            # in the server image; stop the server first with PGlite
```

It needs `DATABASE_URL` or `DATA_DIR`, and the secret key. In one transaction that locks the log
(readers carry on, writers wait):

1. the whole chain must verify, else nothing happens;
2. every chained row from the first one with personal values up to the head is archived with its
   old `prev_hash` and `hash` (`audit_reseal_hash`) and the archive's digest is computed
   (sha256 over `id:old_prev_hash:old_hash\n` lines);
3. the personal values move to `audit_personal` (`personal_hash` and `emailHash` take their place)
   and those rows get new `prev_hash` / `hash` values, recomputed by the database's own
   `audit_log_hash` in id order;
4. `audit_reseal` records the first row, the old head (id and hash), the new head hash, the counts
   and the digest, and the chained row **`audit.resealed`** records the same: it is the checkpoint
   the re-written segment ends in;
5. the chain must verify again, else everything is rolled back.

Why this keeps tamper evidence honest: the re-seal itself is in the chain, with the old head hash;
a head hash recorded outside the server before the re-seal is still found in `audit_reseal_hash`
(indexed by hash), next to the row it belonged to; the archive tables are append-only (triggers)
and `audit:verify` checks that each re-seal's archive still gives the digest its checkpoint row
recorded (`reseal_archive_mismatch` otherwise). What a re-seal cannot prove afterwards is that a
re-written row's other fields were unchanged by it: step 1 proves the chain was intact just before,
and the operation is done by the database itself in one transaction, but whoever can run it has
database owner rights anyway. Record the old and new head hashes the script prints outside the
server. A second run with nothing left to move does nothing.

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
| `personal_mismatch` | The row's personal record does not match its `personal_hash` (or the row has none): the IP address, user agent or e-mail was changed or attached later |
| `reseal_archive_mismatch` | An `audit.resealed` row's archive of old hashes no longer gives the digest it recorded |

Result: `{ ok, checked, legacyRows, head: { id, hash, at }, personalChecked, broken: { id, reason } | null }`.
`personalChecked` is the number of personal records compared with their hash; `null` when the check
ran without the installation's key (the CLI reads `CDE_SECRET_KEY` or `DATA_DIR/secret.key` when
present and never creates one).

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
  **Download CSV**, the client's IP address (user agent on hover; "deleted (retention)" / "deleted (erased)"
  once its personal part is gone), and the chain check for system
  administrators (`apps/web/src/features/project-settings/pages/ProjectAuditLog.tsx`).
- **File drawer → Audit History**: the file's rows, loaded when opened
  (`apps/web/src/features/documents/components/cde/FileHistoryPanel.tsx`, through the CDE slot
  `FileCdePanel`).

## Privacy

The IP address and the browser's user agent are personal data. They are stored for every row written
during a request (decision D-9) to show who acted from where, outside the chain in `audit_personal`,
and deleted after the retention period (default 12 months) or on erasure of the person, while the
rows themselves are never deleted ([personal data](#personal-data)). Only project and system
administrators see them. See [Privacy](PRIVACY.md#audit-log-ip-address-and-user-agent).

## Tests

- `apps/server/test/audit/audit-log.test.ts` — chain and genesis row, forged hash ignored, update /
  delete / truncate refused, tamper detection (changed, removed, unchained row), upgrade with legacy
  rows, concurrent writers, IP and user agent on rows, view deduplication, `file.moved` and
  `cde.transition`, downloads / deletes / restores / permission changes, filters and cursor pages, CSV,
  file history, permissions, system log and chain check (PGlite).
- `apps/server/test/audit/audit-personal.test.ts` — personal data outside the chain: new rows write
  `audit_personal` and `personal_hash`, failed sign-ins keep `emailHash` (and the account when known),
  a changed personal record is found, erasure of one person, retention setting and its bounds, the
  retention job (count recorded, chain verifies, "deleted (retention)" in the API and CSV), migration
  0049 on a database with 6 001 rows from before the chain and chained rows with a client, the
  re-seal (archive, checkpoint, changed archive found) and a re-seal refused on a broken chain.
- `apps/server/test/cde/migration.test.ts` — the table is append-only after the migrations.
- `apps/server/test/cde/iso19650-acceptance.test.ts` — the events of a whole ISO template project
  (review, transition, superseded, returned, withdrawn) and a tampered row found through the API.
- `apps/web/test/documents/audit-labels.test.ts` — row texts and query.
- e2e `e2e/specs/audit-log.spec.ts` — file history, Audit Log tab with filter, CSV download, chain check;
  the personal data retention setting in the Privacy Centre; `e2e/specs/administration-settings.spec.ts` (tab).

The same SQL was checked on PostgreSQL 15 with 200 concurrent writers and interleaved transactions.
Migration 0049 and the re-seal were checked on PostgreSQL 15 with 12 000 rows from before the chain and
3 000 chained rows with a client (migration 2.4 s, re-seal 1 s with 30 writers waiting on it; the chain
verified after the migration, the re-seal, the retention job and an erasure).
