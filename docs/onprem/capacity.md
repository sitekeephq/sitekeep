# Capacity and Load Testing (Administration screen)

SiteKeep is installed on the customer's server with an **exe / installer package**. The
customer does not wait for us to answer "how many people can this server carry": the
installation **measures itself, reports and states what is missing.**

Location: **Administration → System Status** (`/projects/:id/sistem-durumu`, `isAdmin` only).
The **Capacity** card, **Run Live Test**, **Capacity Guide**, **Reports**.

This document covers three things:

1. **What exists today** (§1–§8): the screen, the architecture, the sample test engine. It works, with sample data.
2. **Moving to real measurement** (§9): engines that measure for real, replacing the sample engine.
3. **Exe structure** (§10): the contents of the installer package, services, setup wizard,
   updates and how this feature goes into the package.

Related: [Monitoring](monitoring.md) (the other cards on the same screen), [Backups](backups.md),
`load/k6/` (our lab tests), the archived
stress test plan §3.

> The hardware figures are **an initial recommendation, not measured.** The screen shows
> "Estimated Table". Once measured on reference machines (§9.6), `CAPACITY_MEASURED_AT` is
> set and the label goes away.

---

## 1. Status (25.10.2026)

| Part | Status |
|---|---|
| Capacity table and rules (`packages/shared/src/platform/capacity.ts`) | **done**, unit tested |
| Capacity card: hardware, user count, list of gaps | **done**, real data (sample machine in development) |
| Limit warning in the New User dialog | **done** |
| Run Live Test: Quick Check + Full Load Test, live charts, Stop | **done**, the screen is real; **measurement is a sample** (`DemoEngine`) |
| Capacity Guide (customer-facing document) | **done** |
| Report: HTML (print → PDF) and 7D package (JSON) | **done** |
| Real Quick Check (`QuickCheckEngine`) | not yet, §9.2 |
| Real load engine (`LoadTestEngine`) | not yet, §9.3 |
| Persistent report history (`capacity_runs` table) | not yet, §9.4; tests are in memory and are lost on restart |
| Exe | not yet, §10 |

[monitoring.md](monitoring.md) §6 says "no k6 in production". This rule stays: k6 does not
run on the customer's server. The exe ships **our own small, guarded test engine**; k6 stays
in our lab and validates that engine (§9.6).

---

## 2. Terms

| Term | What | Source |
|---|---|---|
| **Registered user** | an account that is not disabled | `users.disabled = false` |
| **Active user** | signed in within the last 30 days | `tokens` (kind `session`), `coalesce(last_used_at, created_at)` |
| **Concurrent user** | sends requests in the same minute | load test |

The tier table is written in terms of **registered users** (the customer knows this number).
Assumption: at peak time **15%** of registered users are concurrent (`CAPACITY_CONCURRENCY`).
The load test measures the **concurrent** number; it is converted to registered users with
this ratio (`registeredFromConcurrent`).

---

## 3. Capacity table

Single source: `CAPACITY_TIERS`. The screen, warnings, report and this table use the same
figures. `packages/shared/test/capacity.test.ts` checks that this table matches the constant:
whoever changes a figure changes both together.

### 3.1 Tiers (estimated)

| Tier | Registered users | Concurrent (≈15%) | vCPU | RAM | Data disk (SSD) | Database |
|---|---|---|---|---|---|---|
| Trial | ≤ 10 | 2 | 2 | 8 GB | 100 GB | same machine |
| Small | ≤ 50 | 8 | 4 | 16 GB | 500 GB | same machine |
| Medium | ≤ 200 | 30 | 8 | 32 GB | 1–2 TB | same machine, separate disk recommended |
| Large | ≤ 500 | 75 | 16 | 64 GB | 2–4 TB | separate disk; separate server recommended |
| Enterprise | > 500 | 75+ | — | — | — | preliminary study: separate database server, object storage |

Common requirements (`capacityCommonRequirements()`): 64-bit operating system; network at least
100 Mbit/s (1 Gbit/s for large IFC files); SSD data disk; separate backup target; dedicated
cores on a virtual machine (not shared "burst", e.g. GCP `e2`).

### 3.2 What does not depend on users

Disk grows with **model volume**, not with the number of users:

```
required data disk ≈ (uploaded files) × 1.6   // Fragments + preview derivatives
                    + database + 30% free space
```

| Extra load | Effect | What is needed |
|---|---|---|
| Large IFC (300 MB+) conversion | one core and 4–8 GB RAM busy for minutes | +4 GB headroom from the Medium tier up |
| Office editing (ONLYOFFICE / Collabora) | separate process with its own RAM | separate machine recommended; +8 GB on the same machine |
| AI (local model) | depends on the GPU | reported separately; not part of this table |

### 3.3 How to operate it (written for the customer in the Guide)

- Run the capacity test **at first installation**, **when the hardware changes** and **after a
  major version upgrade**. A test older than 90 days shows yellow.
- Plan hardware when the number of users reaches 90% of the tier limit; once the limit is
  exceeded the warning turns red.
- Run the Full Load Test **outside working hours**; the Quick Check is always safe.
- Extend the disk before it passes 80%.

---

## 4. Warnings

A single pure function: `evaluateCapacity({ hardware, counts, lastRun })`. The card, the report
and the end of a test call the same function. The user check is also exported separately as
`usersFinding` (the New User dialog calls it with the "count after adding").

| Check (`key`) | Yellow (`warn`) | Red (`danger`) | Action text (example) |
|---|---|---|---|
| `users` registered / hardware tier | 90% of the limit | limit exceeded, or hardware below the smallest tier | "Large tier: at least 16 vCPU, 64 GB RAM." |
| `memory` RAM / required tier | below, ≥ 75% of it | below 75% | "Increase RAM to at least 32 GB." |
| `cpu` vCPU / required tier | below | below half | "Increase the processor to at least 8 vCPU." |
| `disk` free space on data disk | < 20% | < 5% | "Enlarge the data disk or clean up derivatives under Maintenance." |
| `test` last capacity test | none / older than 90 days | — | "Measure with Run Live Test." |
| `measured` measured registered / active | measured < active × 1.2 | measured < active | "The measured capacity is not enough for the active users." |

The operating system reports slightly less than the installed RAM (16 GB → ~15.6 GB); the
comparison leaves a 10% margin. Inside Docker, `os.totalmem()` shows the host machine; the
server reads the cgroup v2 limit (`/sys/fs/cgroup/memory.max`, `cpu.max`) and takes the smaller value.

**New User.** If the addition would exceed the limit, a yellow/red banner appears at the top of
the dialog: "With this addition 212 users · server sized for 200 users. Limit exceeded. Large
tier: …". It **does not block** (decision §11-1).

**Live server example.** sitekeep.ornek.com is an `e2-medium` (2 vCPU, 4 GB): the card shows
red, because the smallest tier requires 8 GB. This is the correct result.

---

## 5. Screen

Code: `apps/web/src/features/admin/pages/AdminCapacity.tsx`; System Status
(`AdminStatus.tsx`) places `<CapacityCard />` below the Resources card.

| Part | What it shows |
|---|---|
| **Capacity card** | colour, "Sample Data" / "Estimated Table" labels, the server's tier, registered / active counts, last test; below it the list of gaps (topic · status · what to do) |
| **Run Live Test** | mode selection (Quick Check / Full Load Test). The Full Load Test requires the "I Am Outside Working Hours" confirmation; it cannot be selected if disabled in the installation |
| While the Quick Check runs | progress bar, stage, 6 measurement rows filling in one by one |
| While the Full Load Test runs | 4 live charts (p95 response time + limit line, virtual users, requests/s, processor + limit), step table, **Stop** |
| When the test ends | result ("~30 concurrent · ~200 registered"), stop reason, gaps, **Download Report**, **Download 7D Package**, **New Test** |
| **Capacity Guide** | tier table (this server green, required but unmet yellow), common requirements, disk calculation, operating rules, meaning of the warnings |
| **Reports** | list of tests and report download |

Charts are library-free SVG (`LineChart`); the main bundle does not grow. On phones, tables
become cards (`phone-cards`) and charts are a single column.

Even if the dialog is closed, the test continues on the server; the card shows "Watch Test" and
the dialog resumes where it left off.

---

## 6. Architecture

```
 browser (AdminCapacity.tsx)
   │  GET  /admin/capacity            card
   │  POST /admin/capacity/runs       start ───────────────┐
   │  GET  /admin/capacity/runs/:id   poll once a second   │
   ▼                                                       ▼
 capacity/routes.ts ── snapshot.ts (hardware, counts)   runs.ts  CapacityRuns
        │                                                  │  single test, Stop (AbortSignal),
        │                                                  │  last 20 tests (in memory)
        └── evaluateCapacity (shared) ◄── on finish ───────┤
                                                           ▼
                                                 CapacityEngine (engine.ts)
                                                  ├─ DemoEngine          today
                                                  ├─ QuickCheckEngine    §9.2
                                                  └─ LoadTestEngine      §9.3
```

| File | Role |
|---|---|
| `packages/shared/src/platform/capacity.ts` | table, limits, `evaluateCapacity`, `usersFinding`, DTOs |
| `apps/server/src/admin/capacity/snapshot.ts` | `readHardware` (os + cgroup + disk), `readCounts`; sample machine in development |
| `apps/server/src/admin/capacity/engine.ts` | `CapacityEngine` interface, `pause` |
| `apps/server/src/admin/capacity/demo-engine.ts` | sample engine: a plausible curve based on the server's real hardware, sends no requests |
| `apps/server/src/admin/capacity/runs.ts` | `CapacityRuns`: start, one at a time (409), cancel, history |
| `apps/server/src/admin/capacity/report.ts` | HTML report (single file, SVG charts) and 7D JSON package |
| `apps/server/src/admin/capacity/routes.ts` | endpoints, authorization, audit record (`capacity.run`) |

### 6.1 API (`isAdmin` only)

| Endpoint | What |
|---|---|
| `GET /admin/capacity` | `AdminCapacityDto`: hardware, counts, colour, required / hardware tier, gaps, last and running test |
| `GET /admin/capacity/runs` | history, newest first (per-second points excluded) |
| `POST /admin/capacity/runs` `{ mode: "quick" \| "load" }` | starts; 409 if one is running; `load` returns 400 when `CAPACITY_LOAD_TEST=0` |
| `GET /admin/capacity/runs/:id` | a single test with all points; the screen polls once a second |
| `POST /admin/capacity/runs/:id/cancel` | Stop |
| `GET /admin/capacity/runs/:id/report?format=html\|json` | downloads the report; 400 while the test is running |

Why polling and not SSE: it needs no configuration behind nginx/IIS, a small JSON once a second
is enough, and it can be tested with `app.inject`. No more than 1800 points (30 min) are kept.

### 6.2 Engine interface

```ts
interface CapacityEngine {
  readonly demo: boolean;                          // true → "sample data" everywhere
  run(ctx: CapacityEngineContext): Promise<{ status: "passed" | "limited"; result }>;
}
interface CapacityEngineContext {
  mode: "quick" | "load";
  hardware: CapacityHardware;
  signal: AbortSignal;                             // Stop
  setStage(stage: string, progress: number): void;
  setCheck(check: CapacityCheck): void;            // Quick Check row
  sample(s: CapacitySample): void;                 // per-second point (chart)
  step(s: CapacityStep): void;                     // step summary (table)
}
```

The engine only measures and reports; storage, the single-test rule, cancellation and
`evaluateCapacity` at the end live in `CapacityRuns`. Whoever writes a real engine does not touch these files.

### 6.3 Settings

| Variable | Default | What |
|---|---|---|
| `CAPACITY_LOAD_TEST` | on | `0`: the Full Load Test is disabled in this installation |
| `CAPACITY_DEMO_TICK_MS` | 250 | how many ms one "second" lasts in the sample engine (e2e 25, unit test 1) |
| `STATUS_DEMO` | on in development | the card shows a sample machine (8 vCPU, 32 GB, 164 users); `0` in production |

### 6.4 Report and privacy

The report contains **no** project names, file names, personal names / e-mail addresses, IPs or
secrets; only numbers. The 7D package additionally removes the disk path and who started the
test. The administrator downloads the package and sends it themselves; the installation sends
nothing to 7D ([monitoring.md](monitoring.md) §1).

---

## 7. Tests

| Test | What it checks |
|---|---|
| `packages/shared/test/capacity.test.ts` | tier selection, RAM margin, every warning row and boundary value, ratio, **document table = constant** |
| `apps/server/test/platform/admin-capacity.test.ts` | authorization, real hardware / counts (disabled accounts not counted), Quick Check 6 measurements, load test stopping at the first limit step and result calculation, single test (409), Stop, `CAPACITY_LOAD_TEST=0`, HTML + JSON report (no disk path) |
| `e2e/specs/capacity.spec.ts` | card → Guide → Quick Check → Full Load Test (confirmation, live chart, limit) → report download → last test on the card |
| `e2e/specs/mobile-capacity.spec.ts` | on a phone: card, Guide (no horizontal scrolling), Quick Check |

---

## 8. Limitations (today)

- The measurement is a **sample**. The screen, the report and the package say so; it is
  enough for a sales demo, but cannot be presented to a customer as "measured".
- Tests are in memory; the history is lost when the server restarts (the Reports dialog
  says so).
- The overall colour at the top of System Status does not yet include capacity (the card
  has its own colour). §9.5.

---

## 9. Moving to real measurement

Order: Quick Check → persistent storage → load engine → lab. Each step can go to production
on its own; when the engine changes, the screen and the API do not.

### 9.1 Engine selection

`routes.ts` currently has `new DemoEngine(...)`. Target:

```ts
const engine = process.env.CAPACITY_ENGINE === "demo" || capacityDemoOn()
  ? new DemoEngine(...)
  : new CompositeEngine({ quick: new QuickCheckEngine(deps), load: new LoadTestEngine(deps) });
```

For sales demos `CAPACITY_ENGINE=demo` stays.

### 9.2 QuickCheckEngine (1–2 min, safe in production)

Each measurement fills one row via `setCheck`. It does not touch project data; it deletes
everything it writes inside `finally`.

| Measurement | How | Threshold (proposed) |
|---|---|---|
| Hardware | `readHardware` + `hardwareTier` | red if no tier |
| Processor | a 3 s `crypto.createHash("sha256")` loop per core with `worker_threads`; single and total score | yellow below 60% of the reference (burst / weak core) |
| Disk | write 256 MB `capacity-<id>.bin` to the data folder, `fsync`, read, delete; 100 × 4 KB `fsync` latency | write < 100 MB/s yellow, < 30 red; fsync p95 > 10 ms yellow |
| Database | 200 × `select 1`; write 100 rows to a temporary table and roll back (transaction rollback) | p95 > 10 ms yellow, > 50 ms red |
| IFC conversion | convert the bundled `capacity-sample.ifc` (≈20 MB, our sample building) with `runIfcWorker`, delete the output | duration 2× the reference → yellow |
| Memory headroom | free RAM − (tier RAM × 0.6) | < 4 GB yellow, < 2 GB red |

Reference values come from the lab (§9.6) and are written to the `CAPACITY_REFERENCE` constant.

### 9.3 LoadTestEngine (10–20 min, maintenance window)

**Separate process.** `child_process.fork("capacity-runner.js")`. If the load-generating code ran
on the same event loop as the main server, it would distort the result. The runner sends
requests to the server via `http://127.0.0.1:<PORT>` (bypassing TLS / proxy: the application
itself is measured; the network is reported separately). Per-second points pass between runner
and engine via `process.send`.

**Client.** Node 22's `fetch` + `undici.Agent({ connections: N })`. Each virtual user:
request → wait (0.5–2 s "think time") → request. Latencies go into per-second buckets;
p50/p95/p99 come from a sorted array (at most a few thousand values per second).

**Scenario mix** (same as k6 `cde.js`, so the results are comparable):

| Scenario | Share | Request |
|---|---|---|
| Folder browsing, search, session | 80% | `GET /projects/:id/folders/:f/contents`, `GET /search`, `GET /auth/me` |
| Model opening | 10% | `GET /versions/:v/model` (Fragments download) |
| Small upload | 5% | 256 KB file, into a test folder |
| Form / review / report | 5% | list endpoints |
| Background | continuous | 1 IFC conversion in the queue |

**Test data.** At the start of the test: system project `CAPACITY` (hidden: not shown in lists,
search or licence counts) and user `capacity@localhost` (disabled account; only the runner's
short-lived API token). The project is set up once with `capacity-sample.ifc` and 200 small
files, then reused. At the end of the test the uploaded files and job rows are deleted; at
startup an interrupted test (`status = running`) is set to `cancelled` and cleaned up.

**Steps.** 5 → 10 → 15 → 20 → 30 → 40 → 50 → 75 → 100 → … each 60–90 s; the first 20 s are
warm-up and not measured. Upper bound: 2× the concurrent number of the hardware tier.

**Stop rules** (`CAPACITY_LIMITS`; if any one holds, the test stops at that step, capacity =
last passed step):

- p95 > 500 ms, p99 > 1.5 s, errors > 0.1%;
- processor > 90% (30 s) or free RAM < 10%;
- **real traffic:** a Fastify `onRequest` hook counts requests that do not carry the test header
  (`x-cde-capacity: <run id>`); if the threshold is exceeded in the last 2 min the test stops
  ("Real users are working");
- Stop.

**Resource sampling.** Once a second the engine reads processor % from the `os.cpus()` delta,
free RAM and event loop delay (`perf_hooks.monitorEventLoopDelay`). The same sampler also fills
the `cpu: null` field in System Status.

### 9.4 Persistent storage

`capacity_runs` table (drizzle + migration):

| Column | Type |
|---|---|
| `id` | uuid |
| `mode`, `status` | text |
| `demo` | boolean |
| `started_at`, `finished_at` | timestamptz |
| `started_by` | uuid → users |
| `app_version` | text |
| `hardware`, `checks`, `steps`, `result`, `findings` | jsonb |
| `samples` | jsonb (at most 1800 points; ~150 KB) |

The `Map` inside `CapacityRuns` is moved behind a `CapacityRunStore` interface
(`get/list/save`) with memory and database implementations. Live points of a running test stay
in memory and are written when it finishes. Retention: last 50 tests.

### 9.5 Integrations

- System Status top colour: `adminStatus` also takes the card's `level` into account.
- E-mail: to administrators when the card turns red (existing SMTP); a weekly summary.
- Scheduled Quick Check: once a month, at night, `capacity_check` in the `jobs` queue.
- Notification: a red finding can also be assigned to the administrator as a task in "My Tasks".

### 9.6 Lab (7D)

1. A dedicated-core VM for each tier (e.g. GCP `n2-standard-2/4/8/16`), PostgreSQL, realistic
   volume (with the demo generator; no customer data).
2. `load/k6/cde.js` → `load` + `stress`: breaking point.
3. The built-in Full Load Test on the same machine: the result must deviate from k6 by at most
   20%; if it deviates, the runner is fixed.
4. Measured figures go into `CAPACITY_TIERS` and §3.1 (the test requires both together), the
   date into `CAPACITY_MEASURED_AT`; Quick Check references into `CAPACITY_REFERENCE`.
5. Repeat before every major release; the result goes into the release notes.

---

## 10. Exe structure

Goal: the customer's IT **runs a single file**, completes the wizard and opens the CDE in a
browser. No Docker, Node or PostgreSQL knowledge required. The same package is also used for
updates.

### 10.1 Choice

| Option | Pro | Con | Recommendation |
|---|---|---|---|
| **Windows: native services** (Node + PostgreSQL binaries + Windows service) | familiar to the customer's IT; no Docker | Windows-specific paths, service management is on us | **main path** ("exe") |
| Linux: `.deb` / `.rpm` + systemd | same architecture, less friction | public sector / enterprises in Türkiye mostly run Windows Server | second package, same contents |
| Docker package (`docker save` images + compose) | identical to today's production setup | requires Docker knowledge at the customer | Linux only, for customers who ask |

The following is for Windows; on Linux a service = a systemd unit, directories are `/opt`, `/var/lib`.

### 10.2 Package contents

```
7D-CDE-Setup-1.4.0.exe            (Inno Setup, signed)
└─ C:\Program Files\SiteKeep\        ← application (changes on update)
   ├─ node\node.exe                 Node 22 LTS, pinned version
   ├─ app\server\                   apps/server/dist + production node_modules
   ├─ app\web\                      apps/web/dist (WEB_DIST)
   ├─ app\mcp\                      optional
   ├─ app\assets\                   web-ifc .wasm, fragments-worker.mjs, capacity-sample.ifc
   ├─ pgsql\                        PostgreSQL 17 Windows binaries (EDB zip)
   ├─ winsw\                        WinSW (service wrapper) + service XMLs
   ├─ tools\sitekeep.exe              admin command (Node SEA): backup, restore, capacity, doctor
   └─ capacity-tiers.json           build-time copy of CAPACITY_TIERS (pre-install check)

└─ C:\ProgramData\SiteKeep\          ← data (kept on update and uninstall)
   ├─ config\app.env                settings (equivalent of today's /opt/sitekeep/app.env)
   ├─ config\secret.key             CDE_SECRET_KEY (SYSTEM + Administrators only)
   ├─ pgdata\                       database
   ├─ storage\                      uploaded files, derivatives (DATA_DIR)
   ├─ backups\                      local backup (target also NAS/SFTP/S3)
   ├─ logs\                         application and service logs (rotated)
   └─ license\license.json          signed licence file
```

Why `node.exe` + files (not a single SEA binary): the IFC worker with `worker_threads`, `.wasm`
and native modules inside `node_modules` cause problems in a single file; a folder layout also
makes debugging easier. A single file is used only for the small admin command.

### 10.3 Services

| Service | What | Dependency | On failure |
|---|---|---|---|
| `7dcde-db` | PostgreSQL via `pg_ctl`, `127.0.0.1:55432` (closed to the outside) | — | WinSW restarts it after 10 s |
| `7dcde-app` | `node.exe app\server\index.js`, reads `app.env` | `7dcde-db` | same; if it crashes 3 times in a row, event log + System Status red |
| `7dcde-office` (optional) | ONLYOFFICE Document Server for Windows | — | separate machine recommended |

HTTPS: the application listens on `127.0.0.1:8080`; in front of it is either the customer's IIS /
reverse proxy or the bundled Caddy (`7dcde-proxy`, certificate file or internal CA).
The wizard opens only port 443 in Windows Firewall.

### 10.4 Setup wizard

1. **Pre-check** (before installing): the Inno Setup script reads cores, RAM, free space on the
   target disk and the operating system against `capacity-tiers.json`. It asks for the expected
   number of users; if the machine falls short, a **warning page** ("200 users need 32 GB RAM,
   this server has 16 GB"): *Install anyway* / *Cancel*. It does not block the installation.
2. Directory selection (a separate drive for the data disk is recommended: `D:\SiteKeep Data`).
3. Address and certificate: domain name, certificate file or "internal network, self-signed".
4. First administrator account (e-mail, temporary password; changed at first sign-in).
5. Licence file.
6. Backup target (can be changed later).
7. Installation: files → `initdb` (random DB password into `app.env`) → generate `secret.key`
   → register and start the services → wait for `GET /api/v1/health` (at most 2 min).
8. **First Quick Check:** the wizard runs `sitekeep.exe capacity --quick --report
   "%ProgramData%\SiteKeep\reports\ilk-kurulum.html"`, shows the result on the last page
   (green/yellow/red + gaps) and offers an "Open Report" button. The same test appears under
   System Status → Capacity → Reports.
9. Finish → `https://<address>` opens in the browser.

### 10.5 Admin command (`sitekeep.exe`)

For IT without a browser and for support; it connects to the server's local API via `127.0.0.1`
with an **installation token** (local only, `config\local.token`, readable by SYSTEM).

| Command | What |
|---|---|
| `sitekeep status` | services, health, version, licence |
| `sitekeep capacity --quick [--report file.html]` | Quick Check; exit code 0 green / 1 yellow / 2 red |
| `sitekeep capacity --load --yes` | Full Load Test (in the maintenance window) |
| `sitekeep backup now` / `restore <file>` | [backups.md](backups.md) |
| `sitekeep doctor` | support bundle: logs (masked), capacity report JSON, settings (secrets excluded) |

Endpoint: `POST /api/v1/admin/capacity/runs` is the same endpoint; the command stands in for
the administrator only with the local token. This way the wizard, the command and the screen
use one engine.

### 10.6 Updates

A new version of the same exe:

1. Version check (old → new; warning if a major version is skipped).
2. `sitekeep backup now` (database + `secret.key`; files stay in place).
3. `7dcde-app` stops → `Program Files` is replaced → the service starts → migrations are
   applied at startup (current behaviour) → health is awaited.
4. If health does not come within 2 min, **roll back**: the old application folder
   (`Program Files\SiteKeep\.previous`) is restored and the database is restored from the
   backup (the same logic as today's `deploy.sh --rollback`).
5. Capacity: on a major version the wizard runs the Quick Check again; the card marks the test
   yellow with a "version changed" note.

Uninstalling **does not delete** `ProgramData`; it asks for a separate "also delete data" confirmation.

### 10.7 Build pipeline (CI)

GitHub Actions, `windows-latest`:

1. `npm ci`, `npm run build`, `npm test`.
2. Production dependencies with `npm prune --omit=dev`; worker + wasm with
   `scripts/copy-assets.mjs`.
3. Pinned-version downloads with SHA256 verification: Node 22 Windows zip,
   PostgreSQL 17 EDB binaries, WinSW, (optional) Caddy.
4. Write `capacity-tiers.json` from `@sitekeep/shared`.
5. `sitekeep.exe`: Node SEA (`node --experimental-sea-config`).
6. Inno Setup (`iscc sitekeep.iss`) → `7D-CDE-Setup-<version>.exe`.
7. Signing: `signtool` + EV code signing certificate (so no SmartScreen warning appears).
8. **Smoke test** on the same runner: silent install (`/VERYSILENT /SUPPRESSMSGBOXES`
   + answer file) → health → `sitekeep capacity --quick` → uninstall.
9. Upload to a GitHub Release with the version tag; for Linux the same steps on `ubuntu-latest`
   + `fpm` produce a `.deb`.

### 10.8 Code changes for Windows

| Topic | Today | For the exe |
|---|---|---|
| Disk reading | `statfs` | also works on Windows (Node 22); the drive root is passed |
| cgroup | Linux | the files do not exist on Windows; the code already ignores them |
| Paths | places that assume POSIX | `path.join` sweep, long path (`\\?\`) test |
| Database | `postgres:17` in Docker | native `pg_ctl`; `DATABASE_URL` unchanged |
| Office | Docker profiles | ONLYOFFICE for Windows, or off |
| Backup | `pg_dump` in the container | bundled `pgsql\bin\pg_dump.exe` |
| Service signal | `SIGTERM` | WinSW stop → `SIGINT`/`process.on("message")`; graceful shutdown test |

### 10.9 How this feature goes into the package (summary)

| Where | Capacity |
|---|---|
| Before installation | hardware warning from `capacity-tiers.json` (§10.4-1) |
| End of installation | first Quick Check + report (§10.4-8) |
| Daily | System Status card, New User warning |
| Monthly | scheduled Quick Check, e-mail if red (§9.5) |
| Maintenance window | Full Load Test (from the screen or `sitekeep capacity --load`) |
| Support | last capacity report in the `sitekeep doctor` bundle |

---

## 11. Open decisions

1. **When the user limit is exceeded**, warning only (as today), or a licence-bound **block**?
   Will the licence have a seat count?
2. Is the **concurrency ratio** 15%? Should it be adjustable by customer type (site / office)?
3. **Full Load Test in production**: fully disabled outside the maintenance window?
4. **Sending to 7D**: only the manually downloaded package (recommended), or also an approved
   automatic upload under a support contract?
5. **Exe target**: Windows Server (recommended main path), Linux or both?
6. **Certificate**: is the default the bundled Caddy, or the customer's IIS / proxy?

---

## 12. Roadmap

| Phase | Work | Status |
|---|---|---|
| 1 | Screen, table, rules, warnings, sample engine, report, tests | **done** (this release) |
| 2 | `QuickCheckEngine` + `cpu` sampler + `capacity_runs` | 1–2 weeks |
| 3 | `LoadTestEngine` (runner process, test project, real-traffic guard) | 2–3 weeks |
| 4 | Lab: reference VMs, k6 comparison, update the table with measured figures | 1–2 weeks (parallel with 2–3) |
| 5 | E-mail, scheduled check, top colour | 1 week |
| 6 | Exe: package, services, wizard, `sitekeep.exe`, CI, signing | 3–5 weeks |
