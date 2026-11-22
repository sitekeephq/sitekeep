# Data subject rights and retention

What SiteKeep offers when a person asks about their data (GDPR Art. 15–21, KVKK m.11, LGPD Art. 18 and
similar laws), and how long data is kept (GDPR Art. 5(1)(e), KVKK m.7 and the destruction regulation).
All of it is part of SiteKeep Community. Issue #85 (P1-1 … P1-4, retention).

The organisation running SiteKeep is the data controller. SiteKeep gives it the tools; deciding on a
request, and on what free text and file contents hold, stays with the controller. Requests are answered
within 30 days (KVKK m.13(2)); an erasure request under KVKK is concluded within 30 days as well
(Regulation on the Deletion, Destruction or Anonymisation of Personal Data, Art. 12).

| Right | Where | Audit |
|---|---|---|
| Access and portability | Administration → Users → **Personal Data** → **Prepare Export**; My account → **My data** | `user.data_exported`, `user.data_export_downloaded` |
| Rectification | Administration → Users (name, company); **Personal Data** → **Change E-mail** | `user.updated`, `user.email_changed` |
| Erasure | **Personal Data** → **Erase and pseudonymise user** | `user.anonymised`, `audit.personal_erased` |
| Restriction | Disable the account | `user.updated` |
| Storage limitation | Administration → Privacy Centre → **Retention** | `retention.completed`, disposal record |

## Export

`POST /api/v1/admin/users/:id/data-exports` `{ includeFiles? }` (system administrators) queues a job
(kind `personal_data_export`, the job queue of `apps/server/src/jobs/queue.ts`); one export per person
at a time. The ZIP is stored under `exports/personal/` and listed by
`GET /admin/users/:id/data-exports` with its state; `GET /admin/data-exports/:eid/download` serves it.
A person can request the same export of their own data: `POST /api/v1/me/data-exports`,
`GET /me/data-exports`, `GET /me/data-exports/:eid/download` (My account → My data). Exports are
deleted, with their ZIP, 7 days after they were built (`PERSONAL_EXPORT_KEEP_DAYS`), and at once when
the person is erased and pseudonymised.

Every section is in the ZIP twice, `json/<section>.json` and `csv/<section>.csv` (`;`, UTF-8 with BOM),
plus a `README.txt`:

| Section | Content |
|---|---|
| `profile` | The `users` row: id, e-mail, name, flags, company, created, preferences (keys that look like secrets left out). Never the password hash |
| `company` | The person's company |
| `memberships` | Projects (code, name), project company, project administrator, roles, task teams |
| `issues` | Issues the person wrote, is assigned to or last edited (`relation`), with title and description |
| `issue_comments` | Comments they wrote |
| `works`, `work_events`, `work_receipts` | Works (RFIs, correspondence, submittals, meetings …) they created or are assigned to, their timeline entries and receipt confirmations |
| `reviews`, `review_steps` | Reviews they started; their workflow actions (step, outcome, comment) |
| `invitations` | Invitations of the account |
| `audit_log` | Rows they wrote and rows whose personal part names them (e.g. failed sign-ins), with IP address, user agent and e-mail while kept |
| `outbound_log` | Outbound connection log rows of the person |
| `access_keys`, `oauth_consents` | Sessions, API keys and OAuth tokens (kind, name, scope, dates; never their values or hashes), approved OAuth applications |
| `privacy_notice` | Versions of the [privacy notice](PRIVACY_NOTICE.md) the person accepted, when and how |
| `files` | File versions they uploaded (project, name, version, size, SHA-256, time) |

With **Include the contents of uploaded files**, the versions' contents are added under `files/`
(at most 2 000 files and 2 GB; the list in `files.csv` is always complete). Text the person wrote
inside other people's records (letters, form answers) is reachable from the listed records; it is not
copied separately.

## E-mail correction

`PUT /api/v1/admin/users/:id/email` `{ email }` (system administrators): the address is normalised to
lower case and must not be used by another account (`409`). Open invitations of the account follow the
new address. The person's sessions end; they sign in again with the new address. The audit row
`user.email_changed` keeps the new address in its personal part (`details.emailHash` in the chain)
and the old one only as `previousEmailHash`.

**Google-linked accounts:** Google sign-in finds the account by the verified address
([Google sign-in](GOOGLE_SIGN_IN.md)). After a correction the account signs in with the Google account
of the new address; the old Google account no longer reaches it (and, with the domain allowlist on,
would create a new account only if its domain is allowed).

<a id="anonymise"></a>

## Erase and pseudonymise user

`POST /api/v1/admin/users/:id/anonymise` `{ confirmEmail }` (system administrators). Irreversible.
The screen asks twice: a warning, then the account's address typed by hand; the server checks that the
typed address is the account's. Nobody erases their own account this way.

**Erasure, not anonymisation.** This supports GDPR Art. 17 / KVKK m.7: identifying data is erased and
history pseudonymised. The records that stay (audit rows, documents, reviews) point to a pseudonym and
the audit chain keeps keyed hashes: they **remain personal data** (GDPR Art. 4(5), Recital 26) and are
kept only under an Art. 17(3) exception / KVKK m.5(2) condition (for example a legal obligation or the
establishment, exercise or defence of legal claims), then deleted at the end of the retention period
(audit log retention, project deletion). Record that basis and period in your
[records of processing](../compliance/RECORDS_OF_PROCESSING.md). The API path and audit action keep
their historical name (`anonymise`, `user.anonymised`).

| Data | Result |
|---|---|
| Name | "Deleted user #<first 8 characters of the id>" (in the installation's language) |
| E-mail | `deleted-<id>@anonymised.invalid`: unique and undeliverable (RFC 2606) |
| Password | The hash is replaced by a value no password matches; the account is disabled and loses administrator rights |
| Sessions, API keys, OAuth tokens, consents, codes, refresh tokens | Deleted |
| Preferences, notifications | Deleted |
| Two-factor secrets | Hook `registerAnonymiseHook` (`apps/server/src/privacy/subject/anonymise.ts`): the 2FA feature registers the deletion of its secrets there |
| Invitations | Open ones revoked; every invitation of the account keeps the invalid address |
| Audit log | `eraseAuditPersonal`: IP address, user agent and e-mail of rows the person wrote and of rows naming their address, including addresses from before an [e-mail correction](#e-mail-correction). The rows stay under the user id |
| Outbound log | The user id is removed from the person's rows |
| BCF imported comments | `imported_author` equal to one of the person's addresses is cleared |
| Personal data exports | Deleted with their ZIP |
| Records the person created (issues, comments, works, reviews, file versions) | Kept, shown under the pseudonym |
| Files | Not changed |

`user.anonymised` records the pseudonym and the counts, never the old name or address.

**Not removed automatically, the controller's responsibility:** personal data in free text (comments,
letters, descriptions, form answers, meeting minutes), in file contents (drawings, photos and their
EXIF location, documents) and in older audit row details that name a person in free form (for example
a name change written by `user.updated` before the erasure). Review and edit or delete such records
where the request requires it.

## Restriction of processing

Disabling the account is the restriction (`PATCH /api/v1/users/:id` `{ disabled: true }`): the person
cannot sign in, and no session, API key or OAuth token of theirs is accepted
(`apps/server/src/app/build-app.ts`); their data is kept unchanged. Enabling the account lifts it. No
separate feature is needed ([privacy](PRIVACY.md#data-subject-rights-and-retention)).

## Retention

Administration → Privacy Centre → **Retention**, saved with `PUT /api/v1/admin/privacy/settings`:

| Setting | Default | Choices | What is deleted |
|---|---|---|---|
| `trashPurgeDays` | off (`null`) | 30, 90, 180, 365 days | Files and folders deleted longer ago than that, for good, with their versions and stored contents (like a system administrator's permanent delete). Items still referenced (e.g. a version in a review) stay and are tried again the next day. Each project gets a `trash.auto_purged` row |
| `auditLogRetentionYears` | unlimited (`null`) | 1–50 years | Audit rows older than that, with a verifiable checkpoint ([retention and truncation](AUDIT_LOG.md#retention-and-truncation)) |
| `logRetentionDays` | 90 | 1–3 650 days | Outbound log rows ([privacy](PRIVACY.md#outbound-connection-log)) |
| `auditPersonalRetentionMonths` | 12 | 1–120 months | IP address, user agent and e-mail of audit rows ([personal data](AUDIT_LOG.md#personal-data)) |

Always, without a setting: expired sessions, API keys and OAuth access tokens, expired OAuth codes and
refresh tokens; invitations not accepted whose expiry or revocation is more than 30 days ago (pending
accounts stay); personal data exports older than 7 days.

The **daily retention job** (`apps/server/src/privacy/retention.ts`, a minute after start, then every
24 hours) runs each step on its own: a failing step is logged and recorded in `failed`, the others
still run. When anything was deleted it writes `retention.completed` to the audit log with the count
per category.

### Disposal record

Every category that deleted something in a run gets a `disposal_log` row (append-only): time, run id,
category, count, the time span of the deleted records (oldest and newest), the rule (e.g.
`trashPurgeDays=90`, `expired`) and the method (deleted from the database, or also from file storage).
Never the records themselves. `GET /api/v1/admin/privacy/disposals.csv` (`from`, `to` as `YYYY-MM-DD`,
`lang`) downloads it; Privacy Centre → Retention → **Download CSV**. It is the basis for the KVKK
periodic destruction record ("periyodik imha kaydı"); the downloads are audited
(`privacy.disposals_exported`).

Periodic destruction must run at intervals of no more than six months (Regulation on the Deletion, Destruction or
Anonymisation of Personal Data, Art. 11); SiteKeep's job runs daily. The record of each destruction
operation must be kept for at least three years (Art. 7): the application never deletes
`disposal_log` rows, so they are kept for the life of the installation. A personal data retention and
destruction policy is mandatory for controllers that must register with VERBİS (Art. 5).

## Code and tests

- Server: `apps/server/src/privacy/subject/` (`export.ts`, `anonymise.ts`, `routes.ts`),
  `apps/server/src/privacy/retention.ts`, `apps/server/src/audit/truncate.ts`,
  `apps/server/src/modules/documents/trash-retention.ts`; tables `audit_truncation` and `disposal_log`
  (migration `0054_retention`).
- Web: `apps/web/src/features/admin/pages/AdminDataSubject.tsx` (Personal Data dialog, export card also
  used by My account), `AdminRetention.tsx` (Privacy Centre → Retention).
- `apps/server/test/audit/data-subject-rights.test.ts`: export content (JSON, CSV, file contents, no
  secrets), self-service export and its access check, e-mail correction (uniqueness, sessions, audit),
  anonymisation (confirmation, pseudonym, removed data, kept history, previous addresses), retention
  settings and bounds, the retention job (bin purge, expired keys, audit and disposal rows, CSV), audit
  log truncation and its verification.
- e2e `e2e/specs/data-subject-rights.spec.ts`: e-mail change, export and download, two-step
  erase and pseudonymise in Administration → Users; Privacy Centre → Retention and the disposal CSV.
