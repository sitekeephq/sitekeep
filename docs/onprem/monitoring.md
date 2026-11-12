# Monitoring (Administration screen)

Licensed SiteKeep is offered to the customer as **automatic backup + a monitoring screen in Administration**.
Grafana, Prometheus or server SSH are not given to the customer. The screen comes with the exe;
the administrator views it in the browser.

Backup job scheduling and history: [Backups](backups.md).
Our GCP inventory: Production environment. Secrets are not written down.

`GET /api/v1/health` stays shallow for the public. `cde_dev_health` is disabled in production.

---

## Today (sample screen, 22.10.2026)

A **System Status** sample is in place to show the team. No Grafana / SSH; the cards
and the modal are in the CDE. The engine (the real backup job, sample retention, the job list) is not
connected yet.

Path: project menu **Administration → System Status** (`/projects/:id/sistem-durumu`,
`isAdmin` only) and **Administration (system) → System Status**.

| In place | What | Real? |
|---|---|---|
| `GET /api/v1/admin/status` | health, disk `statfs`, memory, `jobs` count, kill switch | yes; `STATUS_DEMO=0` in production |
| `STATUS_DEMO=1` (development) | 16 GB / 500 GB, PostgreSQL 17, nightly backup at 02:00, queue 3/1/47 | no; to hide the Mac's disk |
| Cards | Health, Resources, Job Queue, Automatic Backup, Maintenance, Recent Errors, External Connections | yes (shell) |
| 24-hour line | CPU, memory, disk, pending jobs | no; fixed sample series |
| View Jobs | IFC → Fragments, preview, clash, nightly backup | no; not connected to the `jobs` table |
| View Copies / Delete / Back Up Now | backup list, latest copy locked | no; no job is written, no file is deleted |
| Clean Up Derivatives | preview + Fragments | no; has a confirmation box, does not delete |
| Recent Errors | masked rows | no; `error-ring` not connected |
| Confirmation modal | no Chrome `localhost says` | yes (`ConfirmDialog`) |

Code: `apps/server/src/admin/status.ts`, `apps/web/src/features/admin/pages/AdminStatus.tsx`,
`apps/web/src/app/navigation.ts`. In development, `apps/server/.env.development` →
`STATUS_DEMO=1`.

---

## Going live (monitoring)

The product contract is §1–§6 below. To connect the sample shell to real data:

1. **`STATUS_DEMO=0` in production.** Disk, memory and queue counts are those of that machine.
   The sample overlay may remain in development.
2. **Sample table.** CPU / memory / disk / queue length, last N days, small rows.
   The 24-hour (and later 7-day) line comes from here. Not project files.
3. **`GET /admin/status/jobs`.** The `jobs` table: type (IFC → Fragments, preview,
   clash, backup), target name, status, duration. The modal reads this endpoint. Requeue a failed
   job.
4. **Recent errors.** The existing `error-ring` (secrets masked). No raw pino / syslog.
5. **Licence and database.** Expiry date, `pgdata` size, last migration.
6. **External connection summary.** Kill switch (exists), outbound calls in the last 24 hours, Autodesk
   scheduler, whether the office converter is up.
7. **Alert.** A threshold (disk 80% / backup 25 hours…) colours the top bar. Optional
   administrator email — whom to notify is set in consulting.
8. **Maintenance.** Actually delete derivatives (preview, Fragments). Uploaded files,
   the database and the Recovery Package are not touched.

The backup job itself: [Backups](backups.md) → Going live.

---

## 1. What we sell

| Layer | Who | What |
|---|---|---|
| **Product** | included in the licence | Administration → **System Status**: health, resources, queue, backup jobs, external connections, alerts. |
| **Consulting** | 7D, optional | Thresholds, who gets emails, a "green screen" at first installation, annual review. |

Monitoring data stays on-prem. No metrics go to 7D. On the SaaS we host,
the same screen is there; in the background Prometheus is optional, and the customer does not see it.

---

## 2. Who sees it

Only the **installation administrator** (`isAdmin`). Project members, contractors and anyone who does not
enter "Administration" do not see this tab.

Kept hidden: file contents, correspondence, IFC, lists of personal names/emails, API
keys, `CDE_SECRET_KEY`. Secrets are already masked in recent errors; the same applies on
the screen.

Path: **Administration → System Status** (new tab; next to Users, AI, Office,
OAuth, Privacy). `?tab=status`.

---

## 3. Screen layout

At the top, a single **status** line: Green / Yellow / Red + "last check: … ago".

| Colour | When |
|---|---|
| Green | Application and database are up, last backup on time, queue draining, disk below threshold |
| Yellow | Backup late, queue building up, disk at 80%, external connections off (kill switch), no converter |
| Red | No database, backup older than 2 days or last job failed, disk at 95%, process just crashed |

Cards below it. Clicking a card opens its history / job list.

### 3.1 Health

- Application process: up, uptime, version, licence expiry.
- Database: connected / cannot connect, Postgres 17, last migration (applied / expected).
- HTTP: the last internal `/api/v1/health` (the load balancer and the exe service check also use it).

### 3.2 Resources (server)

The machine the installation runs on. The exe reads these; a separate agent is not required.

| Metric | What for |
|---|---|
| CPU % | Shows IFC conversion and section-cut lag |
| Memory (used / total) | On a 4 GB machine the red threshold is kept low |
| Disk (CDE data + backup target separately) | When full, uploads and backups break |
| Database size | `pgdata` growth |

Chart: last 24 hours and last 7 days. The numbers are about the machine, not project content.

### 3.3 Job queue

The `jobs` table in the CDE (IFC → Fragments, preview, clash, backup…).

- Pending / running / failed / finished in the last 24 hours.
- Breakdown by type (`ifc_to_frag`, `backup`, `preview`…).
- The longest-waiting job, the latest error (message masked).
- "Is the queue draining": is the pending count rising or falling over the last hour.

Clicking a single job row shows: type, time queued, duration, result. This is the CDE's
counterpart of the Dkron history.

### 3.4 Automatic backup (same screen)

The [Backups](backups.md) job is shown here; it does not go to a second panel.

- Last successful backup: date, duration, size, target (NAS / SFTP / S3…, no secrets).
- Next scheduled (cron: every night at 02:00).
- Last 14 jobs: status, retry.
- "Back Up Now" (a `backup` job in the queue).
- If older than 2 days or the last job is red, the top status turns red.
- Copy list: date, application version, size, duration. The latest copy cannot be deleted;
  only the system administrator deletes old copies (retention policy).

Details (adding targets, retention, Recovery Package) are on the **Administration → Backup**
subpage; System Status summarises.

### 3.5 Maintenance (not wiping the server)

Deleting what can be regenerated: previews, Fragments, old finished job rows,
backups past their retention period. **Uploaded files, the database and the Recovery Package
are not deleted from here.** There is no "Clean up server" button.

### 3.6 Recent errors

`error-ring` (secrets masked). Not a raw syslog / pino dump. Clicking the card shows
the latest rows. Project files and correspondence are not opened.

### 3.7 External connections and office

A summary of the Privacy Centre: whether the kill switch is on, the number of blocked /
allowed outbound calls in the last 24 hours, whether the Autodesk scheduler has stopped, whether the office converter
(ONLYOFFICE / Collabora / Gotenberg) is up. No content; counts and status only.

### 3.8 Alerts

| Alert | Yellow | Red |
|---|---|---|
| Backup missing / old | over 25 hours | over 48 hours or last job failed |
| Disk | 80% | 95% |
| Memory | 85% (sustained) | process OOM / restart |
| Queue | growing for 15 min | not draining for 2 hours, failures piling up |
| Database | slow response | cannot connect |
| Licence | 30 days left | expired |

Alert: a card on the screen + administrator email (optional). Who receives it
is set up in consulting.

---

## 4. Technical (how it is done)

A separate Prometheus is not mandatory for the customer.

1. **Health endpoint** — the existing `/api/v1/health` gets deeper (db ping, disk, last backup)
   but the public response stays shallow (`ok` / `degraded`). Details only in the admin API.
2. **Scheduler** — a periodic round like Autodesk / reminders: take a resource sample and,
   if a backup is due, write `backup` to `jobs`.
3. **Retention** — samples for the last N days (CPU, memory, disk, queue length) in a small
   table. Not project files.
4. **Admin API** — `GET /admin/status` for the cards; `GET /admin/status/jobs`;
   `POST /admin/backup/run`.
5. **Exe service** — if the Windows/Linux service goes down, the screen does not open; host
   supervision (restart the service) is part of the installation.

Optional (our SaaS or a large customer): also expose the same numbers as Prometheus
`/metrics`. The screen is still the CDE.

`cde_dev_health` stays disabled in production. The administrator screen is its masked,
customer-ready form: no table row counts and no test projects.

---

## 5. Consulting

1. Thresholds (a 4 GB VM ≠ a 32 GB server).
2. Alert email / chat.
3. First day: green screen + the first nightly backup showing on the card the next day.
4. Once a year: a red-scenario drill (switching off the backup target without filling the disk
   and showing that the alert fires).

---

## 6. Deliberate limits

- This screen is not APM (no user click map).
- k6 / stress testing is separate; no k6 against production. The protected capacity test on the customer server
  and user count warnings: [Capacity](capacity.md).
- Administration does not open on a site (şantiye) tablet; monitoring belongs to the desktop administrator.
