# Backups (licensed product)

Licensed SiteKeep will be delivered to the customer server as an **exe / installation bundle**. Backup
is part of that bundle. The customer is not expected to run `docker compose exec`. The choice of cloud
is free; the technique is the same.

The package offered to the team: **automatic backup + monitoring in Administration**. Monitoring screen:
[Monitoring](monitoring.md).

Secrets are not written in this document.

Future screen/restic details (archive, not a contract):
Backups and Forma Sync.
Our GCP inventory: Production environment.

---

## Today (sample screen, 22.10.2026)

What the team is shown is the backup card and the copy list on **Administration → System Status**.
The schedule "every night at 02:00", "Back Up Now", deleting an old copy —
all of it is a shell. There is no `backup` job type; no dump / archive / target is written.

| In place | What | Real? |
|---|---|---|
| System Status card | last backup, next night, number of copies | no; `STATUS_DEMO` date |
| View Copies | 7 nights, version, size, duration; latest copy locked | no; in-memory list |
| Back Up Now | looks as if it was queued | no; no row in `jobs` |
| Delete old copy | confirmation modal | no; no file |
| Clean Up Derivatives | not a backup; previews / Fragments | no; does not delete |
| Internal compose dump (§4) | manual `pg_dump` for our Docker | yes; not the customer path |

Monitoring shell: [Monitoring](monitoring.md) → Today.

---

## Going live (backup)

The product contract is §1–§3 below. To connect the engine:

1. **`jobs` type `backup`.** Order: `pg_dump` (or PGlite copy) → file
   archive → Recovery Package (key, licence). If any is missing, the job fails.
   Derivatives (previews, Fragments) are optional; excluded by default.
2. **Scheduler.** A periodic round like Autodesk / reminders. Cron: every night at
   02:00 (configurable). When due, write `backup` to the queue. No separate Dkron
   installation; the customer screen is still the CDE.
3. **Target.** Second disk, NAS, SFTP, S3-compatible (MinIO/AWS/R2), GCS, Azure.
   GCP is not mandatory. Secrets in Privacy / settings; not on the screen.
4. **Endpoints.** `POST /admin/backup/run` = Back Up Now. Copy list (date,
   application version, size, duration, target name). `DELETE` an old copy; **the latest copy
   cannot be deleted.** Retention (e.g. 14 days local, 90 days off-site).
5. **Status colour.** Yellow if the last successful backup is older than 25 hours, red at 48 hours or
   if the last job failed. The System Status card reads this endpoint; `STATUS_DEMO`
   is off in production.
6. **Restore.** New machine: exe + Recovery Package + backup. Single-file
   restore later. A **test restore** record once a year (a backup that has never been restored
   is not a backup).
7. **Administration → Backup** (details). Add a target, retention, who holds the Recovery Package.
   System Status only summarises.

Consulting stays the same: choosing the target, 3-2-1, seeing the first restore on another
machine. Data is not moved to 7D.

---

## 1. What we sell

Two layers. They do not mix.

| Layer | Who | What |
|---|---|---|
| **Product** | included in the licence | Scheduled backup (Dkron-style), target, alerts, Recovery Package, restore. From Administration. |
| **Consulting** | 7D team, optional | Choosing the target, 3-2-1, retention period, an annual test restore, disaster drill. |

Consulting does not mean "move your data to 7D". If the licence is on-prem, the backup stays **on the
customer side**. 7D also uses the same backup engine in its own installation
(validation / reference). The SaaS we host is a separate contract.

If the customer wants backups in the 7D cloud, that is separate work: KVKK (Turkish data protection law), cross-border transfer, a
"Backup" connection in the Privacy Centre. This is not the default path.

---

## 2. Backup in an installation delivered as an exe

The installation bundle brings up the application, the database and the file directory. The backup
module comes with the same bundle; it is not a separate collection of scripts.

The three parts that are backed up (if one is missing, the installation will not start):

| Part | What |
|---|---|
| Database | projects, users, records, permissions |
| File store | uploaded IFC/PDF and, optionally, derivatives |
| Recovery Package | licence, encryption key, admin recovery. Next to the backup file, locked |

**Order:** database first, then files. Extra (orphan) files are harmless.

The model shown to the customer is **not a manual dump** but a Dkron-like **scheduled job**:

- cron expression (every night at 02:00, every Sunday…);
- "Run now";
- history (started / finished / duration / size / error);
- retry on a failed job;
- alert on a backup older than 2 days or a broken one.

Technically, yes: automatic backups are taken on the server. The CDE already has a database queue
(`jobs`) and a scheduler (Autodesk sync, reminders). `backup` becomes a job
type: first `pg_dump`, then the file archive, then writing to the target. As long as the process stays
up, it runs on its own every night; after a restart, a job left in the queue continues.

A separate Dkron installation is not required. The same behaviour is built into the product and ships with the exe.
If you like, Dkron (or host cron) can trigger the same job in our own hosting as well —
the customer screen is still CDE Administration, not an external cron panel.

What the product must manage:

- Target: second disk, NAS, SFTP, S3-compatible (MinIO/AWS/R2), GCS, Azure. GCP is not mandatory.
- Schedule and retention (e.g. 14 days local, 90 days off-site).
- Job history, "Back Up Now", alert on a failed backup or one older than 2 days.
- Single-file restore; full restore (exe + Recovery Package + backup onto a new machine).
- At least one **test restore** record per year. A backup that has never been restored is not a backup.

Derivatives (previews, Fragments) are optional; if they are excluded, the customer is told how long
regenerating them takes after a restore.

3-2-1: 3 copies, 2 media, 1 copy outside the machine and, if possible, outside the building. A second folder
on the same disk does not count as a backup.

---

## 3. Consulting (for the team / customer)

The product provides the button. Policy and drills are requested from 7D:

1. Choosing the target (NAS, SFTP or the company's MinIO).
2. Retention, and who will hold the Recovery Package.
3. Seeing together that the first backup opens **on another machine**.
4. Annual drill: new server + exe + backup → one project, one file.

Sell this as part of the installation, not as a "how to back up" training.

---

## 4. Internal installation (without the exe)

Until the product engine is ready, the same three parts apply to our own compose installation.
This section is not a customer deliverable; it covers development and the current Docker installation.

```bash
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U cde cde | gzip > "backups/cde-$STAMP.sql.gz"
docker run --rm \
  -v "$(docker volume ls -q | grep cdedata):/data:ro" \
  -v "$PWD/backups:/out" \
  alpine tar czf "/out/cdedata-$STAMP.tgz" -C /data .
```

`.env` / the key separately and encrypted. One copy outside the machine. Test: on an empty
machine, bring up only `db`, load the dump, unpack `cdedata`, then `up -d`.
No `docker compose down -v` in production.

---

## 5. A backup that will not open

| Symptom | Common cause |
|---|---|
| Cannot log in / token cannot be decoded | The Recovery Package (key) does not match the one in the backup |
| Project exists, file returns 404 | only the database was backed up |
| Licence / exe does not start | the backup was restored onto a different product or an older major version |
