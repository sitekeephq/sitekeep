# Personal data inventory

Where SiteKeep stores personal data, why, for how long and how it is deleted or pseudonymised: the
technical basis for the organisation's processing inventory ("kişisel veri envanteri" under KVKK and
the VERBİS registration, the records of processing under GDPR Art. 30). Fill your own purposes and
periods into [records of processing](RECORDS_OF_PROCESSING.md).

The organisation running SiteKeep is the **data controller**; SiteKeep is the software it runs on its own
server. Nothing below leaves the server unless an administrator enables an integration (AI, e-mail,
sign-in, Autodesk; [optional integrations](SUBPROCESSORS.md)).

Settings named here are in **Administration → Privacy Centre** (Retention, Settings) and
**Administration → Sign-in Security**; the daily retention job and the disposal record are described in
[data subject rights and retention](../features/DATA_SUBJECT_RIGHTS.md#retention). "Anonymise" in the
tables below means **Erase and pseudonymise user**
([erase and pseudonymise](../features/DATA_SUBJECT_RIGHTS.md#erase-and-pseudonymise-user)): identifying
data of one account is erased and its history pseudonymised. This supports GDPR Art. 17 / KVKK m.7; it
is not anonymisation. Pseudonymised records remain personal data and are kept only under an Art. 17(3)
exception / KVKK m.5(2) condition, then deleted at the end of the retention period.

Columns are those of `apps/server/src/db/schema*.ts` (core) and of the module's own migrations
(**module** rows). Columns that only point to a user (`created_by`, `uploaded_by`, `assignee_user_id`,
`author_id`, …) are personal data too: they say who did what. After erasure and pseudonymisation they point to the
pseudonymised account.

## Accounts and access

| Table / columns | Personal data | Purpose | Retention (setting) | Deletion / pseudonymisation |
|---|---|---|---|---|
| `users`: `email`, `name`, `password_hash`, `company_id`, `is_admin`, `is_auditor`, `disabled`, `pending`, `prefs`, `created_at` | Identity, e-mail address, password hash (scrypt), employer, rights (system administrator, read-only [auditor](../features/SECURITY_LOG.md#auditor-g-10)), preferences (language, display settings). Accounts signed in with Google or [OpenID Connect](../features/OIDC_SIGN_IN.md) get their e-mail and name from the provider's claims | User accounts, sign-in, showing who did what | Life of the account | Anonymise: name → "Deleted user #…", e-mail → `deleted-<id>@anonymised.invalid`, hash replaced, account disabled, `prefs` emptied. Disabling the account restricts processing. Name, company and e-mail are corrected in Administration → Users |
| `companies`: `name`, `address`, `email` | Company contact data; a person's data when the company is a sole trader or the address is personal | Sender and recipient of official letters, project companies | Until edited | Edited or removed in Administration → Companies; not touched by anonymise |
| `project_members`, `member_roles`, `delivery_team_leads` | Who belongs to which project, company, roles and task team | Access control (ISO 19650 task teams) | While a member | Removed with the membership; kept (under the pseudonym) on anonymise |
| `tokens`: `user_id`, `kind`, `name`, `created_at`, `last_used_at`, `expires_at`, `scope`, `project_ids` | Sessions, API keys and OAuth access tokens of a person (only the SHA-256 of the token; no IP address or user agent) | Authentication | Sessions: absolute and idle limits (Sign-in Security, default 14 days / 12 hours); API keys: their own expiry | Expired ones deleted daily (disposal categories `sessions`, `api_tokens`, `oauth_tokens`); deleted on anonymise and by "sign out everywhere" |
| `user_two_factor`: `secret`, `recovery_codes`, `enabled_at`, `last_step` | TOTP secret (AES-256-GCM with the installation key), hashes of recovery codes | Two-factor authentication | While two-factor is on | Deleted when turned off or reset, and on anonymise |
| `invitations`: `email`, `user_id`, `invited_by`, `language`, `created_at`, `expires_at`, `accepted_at`, `mailed_at` | Invited address, inviter | Inviting people without an account | Not accepted and expired or revoked more than 30 days ago: deleted daily (`invitations`); accepted ones kept | Anonymise revokes open ones and replaces the address |
| `oauth_consents`, `oauth_codes`, `oauth_refresh_tokens`: `user_id`, scopes, dates; `oauth_clients.created_by` | Which OpenCDE application a person approved | OAuth authorisation | Codes ≤ 60 s, refresh tokens until expiry | Expired codes and refresh tokens deleted daily; all deleted on anonymise |
| `privacy_notice_acceptances`: `user_id`, `version`, `accepted_at`, `via` | That the person ticked "I have read the privacy notice" | Evidence that the person was informed ([privacy notice](../features/PRIVACY_NOTICE.md)) | Life of the account | Kept under the pseudonym on anonymise; in the personal data export |
| `system_settings.updated_by`, `project_ai_settings.updated_by` | Who changed a setting | Accountability | Until the next change | Overwritten by the next change |
| `system_settings` key `auth.oidc.providers` | None about users: issuer, client id, client secret (AES-256-GCM), claim names, allowed domains, the administrator group name. At sign-in the provider's ID token is read for the e-mail, name and groups claims; only e-mail and name are kept (in `users`), groups only decide the administrator right and are not stored | [OpenID Connect sign-in](../features/OIDC_SIGN_IN.md) | Until changed | Removed with the provider |
| `system_settings` key `security.alerts` | E-mail addresses under **Send Alerts To** (at most 10) | Sending [security alerts](../features/SECURITY_LOG.md#alerts-g-8) | Until changed | Edited in Administration → Sign-in Security → Security Alerts; the audit row records only how many there are |

## Logs

| Table / columns | Personal data | Purpose | Retention (setting) | Deletion / pseudonymisation |
|---|---|---|---|---|
| `audit_log`: `user_id`, `action`, `target_type`, `target_id`, `details`, `at`, `personal_hash` | Who did what and when (sign-ins, views, downloads, changes, permissions). `details` may name people in free form (e.g. a name change) | ISO 19650 audit trail, security investigations, evidence ([audit log](../features/AUDIT_LOG.md)) | Life of the installation; **Audit Log Retention** (Privacy Centre → Retention, 1–50 years, default unlimited) | Truncation with a verifiable checkpoint. Append-only: anonymise keeps the rows under the user id (pseudonym); free-form names in older `details` are not rewritten |
| `audit_personal`: `ip`, `user_agent`, `email`, `user_id`, `at` | Client IP address, browser user agent, e-mail address an event names (failed sign-in, invitation) | Who acted from where; sign-in security | **Audit Log Personal Data Retention** (months, default 12, 1–120) | Deleted daily after the period (`audit_personal`); `eraseAuditPersonal` on anonymise. The chained row keeps only a keyed hash (pseudonymised while the installation key exists) |
| `audit_log.ip`, `audit_log.user_agent` | IP address and user agent of rows chained between migrations 0043 and 0049 | As above | Not covered by retention until re-sealed | `npm run audit:reseal` moves them to `audit_personal` ([re-seal](../features/AUDIT_LOG.md#re-seal)) |
| `audit_reseal`, `audit_truncation`: `user_id` | The administrator who ran the operation | Chain integrity | Life of the installation | — |
| `outbound_log`: `user_id`, `project_id`, `host`, `purpose`, `at`, `details` (counts only, never content) | Which person caused a call to an external server | Transfer evidence, [outbound log](../features/PRIVACY.md#outbound-connection-log) | **Outbound log retention** (days, default 90, 1–3 650) | Deleted daily (`outbound_log`); anonymise removes the user id |
| `security_alert`: `rule`, `subject_key` (`user:<id>` or `email:<hash>`), `user_id`, `details` (counts and thresholds only), `audit_id`, `handled_by`, timestamps | Which account a security alert is about and who handled it; never an IP address or an e-mail address | Security alerts, breach detection ([security log](../features/SECURITY_LOG.md#alerts-g-8)) | No automatic deletion | `user_id` and `handled_by` are cleared if the user row is deleted; kept under the pseudonym on anonymise. The IP addresses and e-mails behind an alert are in `audit_personal` and follow its retention |
| `disposal_log` | None: categories, counts, dates | KVKK periodic destruction record (kept at least three years, Deletion Regulation Art. 7) | Life of the installation: the application never deletes these rows | — |
| Sign-in failure counters (memory only) | E-mail address typed and client IP with the time of each failure | Failed-attempt limits ([sign-in security](../features/SIGN_IN_SECURITY.md)) | The window (default 15 minutes); never written to disk | Gone at the end of the window or on restart; **Lift All Locks** |
| Server request log (stdout: `docker compose logs`, `sitekeep logs`) | Method, path, host and client IP address of each request; tokens, OAuth secrets and conversion tickets are removed from paths (`redactUrl`, `apps/server/src/app/build-app.ts`) | Operation, troubleshooting | The operator's log rotation (Docker log driver) | The operator's: set a rotation that matches the audit personal data period |

## Project content

| Table / columns | Personal data | Purpose | Retention (setting) | Deletion / pseudonymisation |
|---|---|---|---|---|
| `files`, `file_versions`: `created_by`, `uploaded_by`, `codes_set_by`, `comment`, `description`; stored contents (`storage_key` in the file store) | Who uploaded what; **file contents** may hold any personal data (drawings with names, photos, scanned documents). **Photos keep their EXIF metadata**, including the GPS position if the camera wrote one: SiteKeep stores files byte for byte | Document control (ISO 19650) | Until deleted; recycle bin: **Recycle Bin Auto-purge** (off, 30, 90, 180 or 365 days) | Permanent delete (system administrator) or auto-purge removes rows and stored contents. Anonymise does not change files |
| `version_texts.content`, `version_previews` | Text extracted from documents for search; preview images | Search and previews | With the version | Deleted with the version |
| `folders.created_by`, `folder_grants` (`subject_id` of a user) | Who created a folder; personal permissions | Access control | Until changed | Removed with the folder or grant |
| `issues`: `created_by`, `assignee_user_id`, `modified_by`, `title`, `description`, `imported_from`; `issue_comments`: `author_id`, `body`, `modified_by`, **`imported_author`**; `issue_viewpoints.created_by` and snapshot images | Who raised, was assigned and commented; free text; for imported BCF comments the original author's e-mail when it matched no member | Coordination (BCF) | Until deleted or the project is deleted | Anonymise clears `imported_author` equal to the person's addresses; free text is not changed. BCF snapshots are rebuilt on import without EXIF, XMP and comments (`apps/server/src/bcf/image.ts`) |
| `works`: `created_by`, `assignee_user_id`, `title`, `fields`, `data`, `delivery`; `work_events`: `user_id`, `message`; `work_receipts.received_by`; `work_revisions`: `comment`, `created_by` | Correspondence: **letter recipient name, postal address and e-mail, CC addresses, signer name and title** (`works.data.letter`); meeting attendees and minutes; RFI and submittal text; who received a letter | Works: correspondence, RFIs, submittals, meetings ([Works](../features/WORKS.md), [correspondence](../features/CORRESPONDENCE.md)) | Until deleted or the project is deleted | Free text and letter data are not changed by anonymise: the controller edits or deletes such records |
| `reviews`, `workflow_instances`, `workflow_actions` (`user_id`, `comment`), `review_marks` (`comment`) | Who reviewed and approved, with comments | Review and approval workflows | Until the project is deleted | Kept under the pseudonym |
| `file_markups.author_id`, `model_markups.author_id`, `model_markup_comments` (`author_id`, `body`) | Markup author and comments | Markup | Until deleted | Kept under the pseudonym; free text unchanged |
| `notifications`: `user_id`, `title`, `body`, `link` | Notifications for one person | In-app notifications | No automatic deletion | Deleted on anonymise |
| `saved_views.owner_id`, `today_summaries` (`user_id`, `bullets`) | A person's saved filters; the AI summary of their Today page (AI module feature, table in the core) | Personal views | Until replaced or deleted | Removed when the person or the project is removed from the database (cascade); not cleared by anonymise |
| `jobs.payload` (kind `personal_data_export`) and the ZIP under `exports/personal/` | A person's complete export | Access and portability requests | 7 days (`PERSONAL_EXPORT_KEEP_DAYS`) | Deleted daily (`personal_exports`) and at once on anonymise |
| `closeout_archives.requested_by`, `sheet_sets`, `drawing_sheets.edited_by` and other `*_by` columns | Who did something | Accountability | With the record | Kept under the pseudonym |

## Optional modules (Enterprise)

Present only when the module is installed. Each module keeps its tables in its own migrations.

| Module | Table / columns | Personal data | Purpose | Retention | Deletion / pseudonymisation |
|---|---|---|---|---|---|
| **Field** | `forms`: `created_by`, `submitted_by`, `closed_by`, `values` | Who filled and approved a form; answers (names, free text) | Inspection and quality forms | Until the form or project is deleted | Not changed by anonymise; the controller edits or deletes the form |
| **Field** | `form_attachments`: `kind`, `file_name`, `created_by`, stored file | **Photos and signatures** of form items. Photos are stored as uploaded: **EXIF metadata, including the GPS position the phone may write, is kept**. The browser is never given location access (`Permissions-Policy: geolocation=()`), so SiteKeep itself collects no location; the "location" item of a form is a pick from the project's location tree | Evidence for a form | With the form | Deleted with the form; the controller removes photos that must not be kept. Strip EXIF on the phone (most camera apps have a "location tags" switch) where the position is not needed |
| **AI** | `ai_tasks`: `requested_by`, `claimed_by_user`, `input`, `result`, `expires_at` | The prompt and answer of a queued AI task (may quote project text) | AI task queue for external clients | Until `expires_at` | The task's expiry; the module's own rules ([AI](../modules/ai.md)) |
| **AI** | `user_ai_credentials`: `user_id`, `provider`, `api_key_enc`, `model` | A person's own AI provider key (encrypted) | Personal Claude / Cursor key | Until the person removes it | Removed by the person |
| **Connect** | ACC sync records and `external_documents` metadata | User names, e-mail addresses, companies, issues, forms, reviews, RFIs and submittals brought in from Autodesk ACC | Sync with Autodesk | Like records created in SiteKeep | Deleted with the project or the connection ([privacy](../features/PRIVACY.md#storage-and-deletion-of-autodesk-data)) |
| **Connect** | `wopi_tokens` (`user_id`, `expires_at`), `wopi_locks` (`user_id`) | Who has a document open in the office editor | Browser editing (WOPI) | Short-lived (expiry) | Expire |
| **Manage, Cost, Coordinate, Planning, Platform** | `*_by` columns of their records; meeting and RFI data live in the core `works` table | Who did what | With the record | Kept under the pseudonym |

## Special category data

SiteKeep has no field for special category data (KVKK m.6, GDPR Art. 9), but project content can hold
it: health and safety forms (accident and incident reports, health information), photos of people,
signatures, and documents uploaded by members. Where it does, the controller needs a condition of
KVKK m.6 / GDPR Art. 9(2) and the additional measures of the Board's decision 2018/10 (for example
restricted access, encryption of the disks, logging; SiteKeep supplies folder permissions, task teams
and the audit log, the disk encryption is the operator's). Keep such records in folders with narrow
permissions, and do not send them to cloud AI providers ([masking](MASKING.md) does not catch health
information).

## Not stored

- No telemetry, usage statistics or update checks ([privacy](../features/PRIVACY.md#principle)).
- No IP address or user agent with a session (`tokens`); the IP address is in the audit log's personal part and the server request log only.
- No content of external calls in the outbound log (no prompts, answers, file names).
- No location from the browser (`Permissions-Policy: geolocation=()`).
- Only strictly necessary cookies (ePrivacy Directive Art. 5(3)); no consent banner is needed: the
  session and the short sign-in step cookies (`cde_session`, `cde_2fa`, `cde_google_state`,
  `cde_invitation`, `cde_privacy_notice`, the sealed OpenID Connect flow cookie); no third-party
  cookies or trackers (strict CSP: no scripts, fonts or images from other sites).

## What deletion does not reach

These are the controller's decision and work ([erase and pseudonymise](../features/DATA_SUBJECT_RIGHTS.md#erase-and-pseudonymise-user)):

- personal data inside **free text**: comments, letters, descriptions, form answers, minutes;
- personal data inside **file contents**, including photo EXIF and location;
- older audit `details` that name a person in free form;
- **backups**: a deletion reaches the next backups, not those taken earlier. Set backup retention
  (`CDE_BACKUP_KEEP`, [installation bundle](../onprem/installation-bundle.md)) to match your retention
  policy and record it.
