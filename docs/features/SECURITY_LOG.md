# Security log, security alerts and the auditor

One screen for the installation's security events, alerts when something looks wrong, and a
read-only auditor role. Community ([map](../MAP.md#2-community-or-enterprise)). Issue #85: G-7, G-8,
G-10.

Code: `apps/server/src/audit/security-log.ts` (what counts as a security event, filters),
`security-alerts.ts` (rules, scanner, daily chain check, e-mail), `security-log-routes.ts` (API),
`core/security/system-roles.ts` (the auditor); screen
`apps/web/src/features/admin/pages/AdminSecurityLog.tsx`; types in
`packages/shared/src/platform/security-log.ts`; table `security_alert`, column `users.is_auditor` and
the indexes `audit_action_idx`, `audit_personal_ip_idx` (migration `0056_security_log`).

## Security log (G-7)

**Administration → Security Log** (system administrators and [auditors](#auditor-g-10)). The security
log is not a second log: it reads the one [audit log](AUDIT_LOG.md), across every project and the
rows written outside a project (sign-ins, users, settings, external connections), and shows the
security events, newest first.

| Type | Actions |
|---|---|
| Sign-in | `auth.login`, `auth.oidc_login`, `auth.login_failed`, `auth.locked`, `auth.locks_cleared`, `auth.sessions_ended`, `auth.password_changed` |
| Two-factor authentication | `auth.two_factor_*` |
| Users | `user.created`, `user.updated` (name, company, disabled, rights), `user.anonymised`, `user.email_changed`, `user.data_exported`, `user.data_export_downloaded`, `audit.personal_erased`, `invitation.accepted` |
| Permissions and roles | `member.*`, `role.*`, `role_package.applied`, `folder.permissions_set`, `folder.owner_team_set`, `invitation.created` / `resent` / `revoked`, and `user.created` / `user.updated` that set System Administrator or Auditor rights (`details.isAdmin`, `details.isAuditor`) |
| Settings | `auth.security_settings`, `auth.google_settings`, `auth.oidc_provider_*`, `settings.*` (privacy, MCP, office…), `invitation.settings`, `security.alert_settings`, `license.installed` / `removed`, `cde.settings_updated`, `project.modules_updated` |
| External connections | `privacy.kill_switch_on`, `privacy.kill_switch_off`, `privacy.connection_updated` |
| Access keys and OAuth | `auth.token_created`, `oauth.authorize`, `oauth.consent_granted` / `denied`, `oauth.revoked`, `oauth.client_*`, `oauth.code_reused`, `oauth.refresh_reused` (not every token issue or refresh) |
| Logs and retention | `audit.*` (exports, re-seal, truncation, personal data expiry and erasure), `privacy.disposals_exported`, `retention.completed`, `trash.auto_purged`, `project.closed` / `reopened` / `deleted` |
| Security alerts | `security.alert_raised`, `security.alert_acknowledged`, `security.alert_dismissed` |

Filters: **type** (empty = every security event), **person** (rows by the person *or* about them:
`user_id`, or `target_type = user` and `target_id`), **from / to** (dates, `to` includes the day),
**IP address** (exact, or the beginning of one such as `10.0.4.`; matched in `audit_personal`, and in
the row itself for rows chained before 0049). Pages of 50 with **Load More**.

The **All Events** switch shows the whole audit log of every project and of the system instead
(`GET /admin/audit`, with a project filter): this is how an auditor reads a project's log without
being a member. The **Chain Check** (`audit:verify`) is at the top of the tab.

The client IP address and the browser are shown while they are kept ([personal
data](AUDIT_LOG.md#personal-data); Privacy Centre → Retention, default 12 months), then **deleted
(retention)** or **deleted (erased)**. A row about a user names the user.

**CSV:** **Download CSV** downloads every row of the same filters (`GET /admin/security-log.csv`):
the audit log's columns ([API](AUDIT_LOG.md#api)) including IP address and user agent, or "deleted
(retention)" when they are gone; column names in the reader's language. The download is itself
recorded as `audit.exported` with `details.log: "security"` and the filters.

## Alerts (G-8)

A scanner reads the audit rows written since its last run (every minute, and whenever the
Administration page lists the alerts) and applies the rules below; a daily job walks the hash chain.
A rule that fires raises an alert: a card at the top of the **Administration** page, and the chained
row **`security.alert_raised`** (`target_type: security_alert`, `details`: the rule, the counts,
`auditId` of the row that raised it, `subjectUserId`).

| Rule | Fires when | Default |
|---|---|---|
| Many failed sign-ins for one account | failed sign-ins (`auth.login_failed`) of one account (the user, else the hash of the address typed) within the window reach the threshold | 10 in 15 minutes |
| Many failed sign-ins | failed sign-ins installation-wide within the window reach the threshold | 50 in 15 minutes |
| Bulk download | files one person downloads within the window reach the threshold (`file.downloaded`; a ZIP counts its files) | 200 files in 60 minutes |
| New system administrator | a user is created with, or given, System Administrator rights | on |
| External connections turned on again | "Turn Off All External Connections" is switched off (`privacy.kill_switch_off`) | on |
| Two-factor requirement turned off | Sign-in Security → two-factor required for "nobody" (`auth.security_settings`, `requireTwoFactor` → `off`) | on |
| Audit chain check failed | the daily `audit:verify` walk finds a break (first run five minutes after start) | on |

Each rule can be switched off and the thresholds changed in **Administration → Sign-in Security →
Security Alerts** (`GET` / `PUT /admin/security-alerts/settings`; ranges: per account 3–1000,
installation-wide 5–100 000, sign-in window 1–1440 minutes, files 10–1 000 000, download window
5–1440 minutes). Every change is written as `security.alert_settings` with the old and new values.

- **No flood:** while an alert of a rule and subject (account, person, "all", "chain") is open,
  further matches count up its `occurrences` and `last_seen_at` instead of raising another. After
  it is handled, the windowed rules wait one window before raising again for the same subject.
- **First run:** the scanner starts with the rows of the last 24 hours, so an upgrade does not
  raise alerts about old history. Its position (an audit row id) is kept in `system_settings`.
- **Acknowledge / Dismiss:** a system administrator acknowledges (seen, being handled) or dismisses
  (false alarm) a card; written as `security.alert_acknowledged` / `security.alert_dismissed` with
  the person. The card goes; **Recent Security Alerts** under the security log keeps the history
  with status and who handled it. **Show Event** opens the security log at the row that raised it.
- **No personal data in an alert:** counts, thresholds and the person's user id; never an IP
  address or an e-mail address. Those stay in the security log while they are kept.

### E-mail

Addresses under **Send Alerts To** (at most 10) get an e-mail for each new alert, in the
installation's default language: the alert's name, its text and the time, nothing else (no names,
addresses or IP addresses). Only when SMTP is configured (`CDE_SMTP_URL`, `CDE_SMTP_FROM`) and the
**Email server (SMTP)** connection is allowed in the Privacy Centre; it goes through the outbound
registry (purpose `eposta`, detail `kind: security_alert`, [privacy](PRIVACY.md#data-flows)). The
settings screen says when e-mail cannot be sent. The recipient addresses are stored in
`system_settings`; the audit row records only how many there are.

### Breach notification (GDPR / KVKK)

An alert is a signal, not a finding. If it turns out to be a personal data breach, the organisation
as data controller must notify:

- **GDPR Art. 33:** the supervisory authority without undue delay and, where feasible, **within 72
  hours** of becoming aware of it (Art. 34: the data subjects when the risk is high);
- **KVKK Art. 12(5):** the Personal Data Protection Board as soon as possible; the Board's decision
  2019/10 sets **72 hours**, and the data subjects within a reasonable time.

The alert's time, the `security.alert_raised` row and who acknowledged it document when the
organisation became aware; the security log CSV and the chain check give the evidence. The same note
is on the alert cards and in the e-mail.

## Auditor (G-10)

A system-level, read-only role: **Administration → Users and Companies → Make Auditor** (or the
**Auditor** box when creating a user), by a system administrator only (`PATCH /users/:id`
`{ isAuditor }`, `POST /users` `{ isAuditor }`). The change is written as `user.updated` /
`user.created` with `details.isAuditor` and appears under *Permissions and roles*.

An auditor:

- **sees** Administration with two tabs: **Security Log** (the security log, every project's audit
  log through *All Events*, the chain check, the alert cards and history) and **Privacy Centre**
  (every section, every control disabled; the outbound log and the disposal record can be
  downloaded);
- **downloads** the CSVs (security log, audit log, outbound log, disposal record), each recorded
  like any other download;
- **cannot change anything:** every write route still requires System Administrator rights (403),
  alerts cannot be acknowledged, settings cannot be saved;
- **gets no project or file access from the role:** project and file routes still need a project
  membership (`projectAccess`), so file contents, previews and downloads stay closed unless the
  person is also a member with those rights. Audit rows name files and folders (metadata), as the
  system administrator's view does.

API routes open to auditors: `GET /admin/security-log`, `/admin/security-log.csv`,
`/admin/security-alerts`, `/admin/security-alerts/settings`, `/admin/audit`, `/admin/audit.csv`,
`/admin/audit/projects`, `/admin/audit/verify`, `/admin/privacy`, `/admin/privacy/status`,
`/admin/privacy/connections`, `/admin/privacy/outbound`, `/admin/privacy/outbound.csv`,
`/admin/privacy/disposals.csv`, and `GET /users` with the administrator's view (every account,
two-factor status). An account can be both administrator and auditor; the auditor flag then adds
nothing.

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /admin/security-log` | administrators, auditors | `{ entries, nextCursor }`; `type`, `userId`, `from`, `to`, `ip`, `id`, `cursor`, `limit` (1–500, default 100) |
| `GET /admin/security-log.csv` | administrators, auditors | The same filters, every row; `lang`; writes `audit.exported` |
| `GET /admin/audit/projects` | administrators, auditors | `[{ id, code, name }]` of every project (the *All Events* filter) |
| `GET /admin/security-alerts` | administrators, auditors | `?status=open` (default) / `acknowledged` / `dismissed` / `all`; scans first |
| `POST /admin/security-alerts/:id/acknowledge`, `/dismiss` | administrators | An open alert; 404 otherwise |
| `GET /admin/security-alerts/settings` | administrators, auditors | Settings and `mail`: `null`, `smtp_not_configured` or `smtp_disabled` |
| `PUT /admin/security-alerts/settings` | administrators | Any of the settings; recipients must be valid addresses |

## Tests

- `apps/server/test/audit/security-log.test.ts`: the security log across the installation (rows
  outside projects, non-security rows left out), type / person / IP / date filters, CSV with the
  client and "deleted (retention)", the export audited; the auditor reads every listed route, gets
  403 on writes and 404 on a project they are not a member of, and granting the role is audited;
  each alert rule, counting up while open, acknowledge / dismiss (administrators only, audited),
  switched-off rules, e-mail only when SMTP is allowed and without personal data, the daily chain
  check.
- e2e `e2e/specs/security-log.spec.ts`: a new administrator raises a card, **Show Event**,
  **Acknowledge**, type filter and CSV; an auditor signs in, sees only the two tabs, reads a
  project's log without membership, the Privacy Centre is read-only and a write is refused.
