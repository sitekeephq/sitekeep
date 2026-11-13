# Installation bundle (on-prem, Linux)

The installation we sell: the customer's IT unpacks a single bundle on their server, runs `sudo ./install.sh` and finally
opens the CDE in the browser. Code, database, HTTPS and nightly backup are set up automatically; no internet
is required. The Windows exe will carry the same content later ([capacity.md](capacity.md) §10); licensing is
separate work (lisanslama.md).

Status (02.11.2026): the first release **`v1.0.0-rc1`** (pre-release) was built in CI and
attached to a GitHub Release:
`sitekeep-1.0.0-rc1-linux-amd64.tar.gz` (413 MB) + `.sha256`. The release workflow takes 29 minutes; the amd64
smoke test (2 vCPU / 8 GB runner) passed from installation to uninstall. The smoke test had earlier caught a bug where
an update never switched to the new image (Compose preferred the shell environment over `.env`);
it was fixed, and the test now also checks the running image. A trial on a real customer-like
server (Ubuntu VM) is next (§7).

---

## 0. Delivery to the customer

**Two editions (12.11.2026, release plan B-3).** The same bundle is built in two editions (`build-bundle.sh --edition`;
the release workflow builds and tests both):

| Bundle | Contents | Licence |
|---|---|---|
| `sitekeep-community-…` | Core only; Enterprise module packages do not go into the image (the bundle build checks this) | Not required; never restricted |
| `sitekeep-enterprise-…` | Core + seven Enterprise modules | The licence uploaded in Administration → Licence enables the modules (lisanslama.md); without a licence it runs like Community |

The image carries the edition `SITEKEEP_EDITION` and the build date `SITEKEEP_BUILD_DATE` (for the licence's end-of-updates
check). The Enterprise bundle is delivered to the customer through a download link in the Odoo customer portal (release plan
C-3); no per-customer registry access is needed. Our own production server is built without an edition
(all modules enabled, no licence check).

**What is delivered:** a single file `sitekeep-<edition>-<version>-linux-amd64.tar.gz` (`community` or `enterprise`, see below) (≈ 400 MB) and its `.sha256`;
via a download link or, for an organisation without internet access, via USB / file share. The source repository
is not delivered. The bundle contains only the installation scripts, a Turkish README and pre-built images (minified application,
PostgreSQL, Caddy).

**Where the bundle lives:** not in the repository (400 MB; `dist-bundle/` is outside git). CI builds it from the release tag and
attaches it to a GitHub Release (§8). Since the repository is private, that page is visible only to our team; today the bundle is
passed to the customer by hand, the right channel is a time-limited download link and later the product website (§8.3).

**What the customer's IT does:**

| Step | What |
|---|---|
| 1. Server | Linux (Ubuntu / Debian / RHEL) + Docker; if Docker is missing, the wizard shows how to install it, and installs it if the server has internet |
| 2. Installation | copy the file, `tar -xzf`, `sha256sum -c SHA256SUMS`, `sudo ./install.sh`; the wizard asks for the address, HTTPS type and first administrator email, and finishes in a few minutes |
| 3. Network | `cde.sirket.local` → server IP in internal DNS; 443 on the firewall |
| 4. Use | staff open `https://cde.sirket.local` in the browser; the administrator creates users on the screen |
| 5. Afterwards | nightly backup is automatic (copying it off the server is IT's job); we send new releases as a bundle, `sudo sitekeep upgrade <directory>`, which rolls back on its own if unhealthy |

The customer does not deal with Node, PostgreSQL or code. Someone with root on the server can open the image and see the minified JS;
they do not see readable source (§2).

---

## 1. Bundle

```
sitekeep-<community|enterprise>-<version>-linux-amd64.tar.gz
└─ sitekeep-<community|enterprise>-<version>-linux-amd64/
   ├─ install.sh            installation wizard (asks questions, or unattended with --answers)
   ├─ sitekeep                management command (becomes /usr/local/bin/sitekeep on install)
   ├─ compose.yml           PostgreSQL + SiteKeep + Caddy
   ├─ answers.env.example   sample for unattended installation (an old cevap.env is still read)
   ├─ README.md             installation and administration for the customer's IT
   ├─ VERSION, ARCH, SHA256SUMS
   └─ images/images.tar.gz  sitekeep:<version>, postgres:17, caddy:2 (docker save)
```

The only thing needed on the customer server is **Docker Engine + the Compose plugin**. If Docker is missing, the wizard
shows how to install it; on a server with internet it installs it itself with `CDE_INSTALL_DOCKER=1`.

Build (on our side, with a `read:packages` token; the viewer package is private):

```bash
NODE_AUTH_TOKEN=… deploy/onprem/build-bundle.sh --version 1.0.0 --platform linux/amd64
```

Output in `dist-bundle/`. The script stops if it finds source files (`.ts`, `.map`) in the image. Release bundles
are built in CI, not by hand (§8); a manual build is for testing only.

## 2. Code protection

The server code in the image ships **minified** (`tools/harden-dist.mjs`, inside the Dockerfile):
comments, whitespace and local names are removed; `.map` and `.d.ts` are deleted; developer demo/load
scripts (`seed-*`, `assign-ui-load`) do not go into the image. The web build is already minified and has no maps.
12 MB of readable code → 3.4 MB of single-line files. Files stay in place because the IFC/clash
workers, migrations and assets are loaded by path; the e2e suite (54 tests) passes with the minified
build.

Limit: because Node.js runs on the customer server, the code cannot be encrypted; minification removes
readability but does not provide confidentiality. The real protection is the signed licence and the contract
(lisanslama.md §10). Anything stronger (V8 bytecode) would be a separate decision.

## 3. Installation wizard (`install.sh`)

1. **Pre-checks:** root, Linux, architecture (bundle amd64/arm64), Docker and Compose, existing installation
   (suggests `sitekeep upgrade` if there is one), CPU / memory / disk for the number of users
   ([capacity.md](capacity.md) §4 tiers; warns if short, does not block), whether 80/443 are free.
2. **Questions:** server address, HTTPS type, first administrator (a password is generated if left empty), language, backup time
   and count. Anything already in the answers file / environment is not asked.
3. **Images:** `docker load` (from the bundle; `pull_policy: never`, the server downloads nothing).
4. **Configuration:** `/opt/sitekeep/.env` (compose) and `config/app.env` (application), both 0600.
   Randomly generated: database password, `CDE_SECRET_KEY` (encryption key for secrets),
   installation ID (`config/installation.id`, the licence will be bound to it later). Caddyfile.
5. **Start:** `docker compose up -d`, waits up to 3 minutes for health; once the first administrator is created,
   `ADMIN_PASSWORD` is removed from the file. HTTPS through the proxy is tested.
6. **Nightly backup:** systemd timer (`sitekeep-backup.timer`), otherwise cron.

| HTTPS type | Caddy | Note |
|---|---|---|
| `internal` (default) | `tls internal` | internal network; root certificate `config/sitekeep-root-ca.crt` (`sitekeep-kok-sertifika.crt` on installations from earlier bundles), pushed to clients via GPO |
| `files` | `tls /certs/cert.pem /certs/key.pem` | the organisation's certificate |
| `auto` | Let's Encrypt | public domain name, 80/443 open to the outside |
| `off` | `:80` | HTTP only, `SECURE_COOKIES=0` |

The application listens only on the internal Docker network (it publishes no ports); only Caddy is exposed.
With `CDE_TRUST_PROXY=1`, the client IP (login attempt limit, logs) and the HTTPS information are read
from the proxy.

## 4. Management command (`sitekeep`)

| Command | What |
|---|---|
| `status` | services, health, version, installation ID, last backup, disk |
| `logs [app\|db\|proxy]` | logs |
| `start` / `stop` / `restart` | |
| `backup` | `pg_dump -Fc` (+ verification with `pg_restore --list`), files (incremental with hard links to the previous backup if rsync is available, otherwise a full copy), settings; retention `CDE_BACKUP_KEEP` |
| `backups` | list |
| `restore <backup>` | first backs up the current state, then restores the database and files |
| `upgrade <bundle directory>` | backup → load image → start (migrations at startup) → health; if not healthy within 3 min, returns to the old version and the pre-update database |
| `uninstall [--purge]` | removes the services; data and settings remain, `--purge` deletes them |

The backup stays on the same disk; the README tells the customer to copy it off the server. Remote targets
(SFTP / S3 / NAS) will come with the engine in [backups.md](backups.md).

## 5. Smoke test

```bash
deploy/onprem/smoke-test.sh dist-bundle/sitekeep-<community|enterprise>-<version>-linux-<arch>.tar.gz
```

It starts an empty Linux "server" (docker:dind) and walks the customer IT's path: checksum →
unattended installation → HTTPS health → permissions on secrets, root certificate, no source in the image →
login → project + file upload → backup → delete the file → restore (the file comes back) →
update (data intact) → an update to a broken release is rolled back automatically → uninstall (data
remains). dind is Alpine: no systemd (the timer falls back to cron), no rsync (the backup is a full copy).
A real server trial on Ubuntu / RHEL is done separately.

The server's architecture comes from the bundle. On an Apple silicon Mac the amd64 bundle runs under emulation; there
container-in-container (dind) does not start (`runc … broken pipe`), so the amd64 smoke test
runs only in CI (real amd64). On the Mac, a full test runs with the arm64 bundle, and a single-layer
startup check (health, login, `dwg2dxf`) for the amd64 image.

## 6. S3 / MinIO

Not needed for an on-premises installation: files are under `CDE_DATA/app`, and a separate disk or NAS can be
mounted if desired. An object storage driver can be added if the customer asks; the code reads the file as a local path in 14 places
(IFC, preview, clash, document comparison workers), which would need a temporary download layer
(KALANLAR.md §1).

## 7. To do

In order of priority. The Linux bundle (`v1.0.0-rc1`) is ready end to end; these come before and after the first customer.

| # | Task | Why / scope | Status |
|---|---|---|---|
| 1 | **Real server trial** | The tests are simulations (dind on Mac, runner in CI). One real installation on a clean Ubuntu 24.04 amd64 VM (separate from production): wizard with questions, `internal` and `auto` HTTPS, systemd backup timer, incremental backup with rsync, services coming back after a server reboot, rc1 → rc2 with `upgrade`. Required before the first customer. | Waiting for VM |
| 2 | **Licence step** | `installation.id` is ready. Model: perpetual + trial from the product website (e.g. 14 days) and weekly / monthly subscription, with Odoo plans as in AEC Pilot (lisanslama.md §12a). Code: a key / licence file step in the wizard, Administration → Licence, read-only state (Phases 1–2, 5). | Waiting for Worker / Odoo access |
| 3 | **Getting backups off the server** | Today the backup is on the same disk; protecting against disk failure is up to the customer's IT. After `sitekeep backup`, a copy to a NAS / SFTP / S3 target, retention and a test restore ([backups.md](backups.md)). | none |
| 4 | **Customer download channel** | Today the team downloads from the GitHub Release and passes it on by hand. Next: GCS time-limited link, then a customer portal on the product website (§8.3). | design ready |
| 5 | **Windows exe** | Second bundle, same application code. A `windows-latest` job in the release workflow: portable Node, PostgreSQL / Caddy / LibreDWG Windows binaries, WinSW services, Inno Setup wizard, `sitekeep.exe` (Node SEA), silent-install smoke test, code signing (Azure Artifact Signing). Cannot be built on a Mac: Inno Setup is Windows-only, and `@napi-rs/canvas` and `@cursor/sdk` need Windows binaries. ≈ 2–3 weeks ([capacity.md](capacity.md) §10). | none |
| 6 | **Office editing** (optional) | ONLYOFFICE / Collabora are not in the bundle; a profile in `compose.yml` and an "office editing" question in the wizard. | none |
| 7 | **arm64 bundle** (optional) | For customers who want an ARM server; a second platform in the workflow. | none |
| 8 | **Stronger code protection** (optional) | V8 bytecode if minification is not enough; compatibility work with the Node version and the workers (§2). | decision |
| 9 | **Zero-touch installation: missing wizard steps** | Decision (09.11.2026): the team does not handle installations, and requests outside the wizard are paid (pricing document §3.3). To add to the wizard: SMTP (with a test email), off-server backup target (with a test write; together with #3), SSO/LDAP in Enterprise (with a connection test), summary and confirmation screen. The licence step is in #2. | none |
| 10 | **Self smoke test and installation report** | At the end of the installation, a short check on the customer server (health, login, file upload/download, IFC preview, backup) and a PDF installation report; optionally sent to 7Dimensions. | none |
| 11 | **First-run wizard (web)** | On the administrator's first login: organisation details, user invitation / CSV / LDAP import, first project template (ISO 19650 UK NA, ÇŞB 2026 (Turkish ministry standard), blank) with automatic setup of project code, task teams, folders, naming and approval workflow, quick capacity check. | none |
| 12 | **Automatic provisioning for hosting** | Form on the product website → answers file → server provisioning (Hetzner API) → `install.sh --answers` → first-run data. No manual intervention. | none |

---|---|
| Customer download channel | GCS time-limited link, then the product website (§8.3) |
| Real server trial | clean Ubuntu 24.04 VM (amd64): wizard, `auto` and `internal` HTTPS, backup timer |
| Office (ONLYOFFICE / Collabora) | not in the bundle; can be added as an optional profile |
| Remote backup target | with the backup engine |
| Licence | `installation.id` is ready; the licence file step comes with the licensing work |
| Windows exe | same content, [capacity.md](capacity.md) §10 |

---

## 8. Distribution

### 8.1 Cutting a release (today)

Manually (without GitHub Actions): releasing.md, `deploy/release.sh`. Automated:

`.github/workflows/release.yml`. A release is tagged from `main` after green CI:

```bash
git tag -a v1.0.0 -m "SiteKeep 1.0.0" && git push origin v1.0.0
```

The workflow (12.11.2026, release plan B-5) has two jobs:

1. **`bundle`**, for the two editions in turn (`community`, `enterprise`): `npm ci` → build, type check, unit
   tests → `build-bundle.sh --edition <edition> --platform linux/amd64` → `smoke-test.sh` (on an empty Linux server, from
   installation to uninstall; including the version and licence check, §5) → GitHub Release `v1.0.0`:
   `sitekeep-community-1.0.0-linux-amd64.tar.gz`, `sitekeep-enterprise-1.0.0-linux-amd64.tar.gz`, their `.sha256` files
   and `sitekeep-1.0.0-sbom.cdx.json` (dependency list). The page text comes from `deploy/onprem/release-notes.md`,
   followed by the automatic changelog.
2. **`images`**, once both bundles pass the smoke test: `ghcr.io/sitekeephq/sitekeep:1.0.0` and
   `sitekeep-enterprise:1.0.0` (plus `:latest` for the latest release) to the GitHub registry ([Docker Compose](docker-compose.md)).

A version with a hyphen (`1.0.0-rc1`) is marked as a pre-release and does not get `:latest`. If the smoke test fails,
no release is created and no image is published.

Trial run without a tag: Actions → Release → *Run workflow* → version (e.g. `1.0.0-rc2`). Same build and
tests; no release is created, and the bundle stays as a workflow artifact for one week.

Since the viewer package (`@7dimensions-project/bim-viewer`) is in the same organisation, the workflow reads it
with `GITHUB_TOKEN` (`packages: read`); no separate secret is needed.

### 8.2 How the team gets the bundle

```bash
gh release download v1.0.0 -R sitekeephq/sitekeep -p 'sitekeep-*-1.0.0-linux-amd64.tar.gz*'
shasum -a 256 -c sitekeep-*-1.0.0-linux-amd64.tar.gz.sha256
```

Today delivery to the customer is manual: sharing from the company Google Drive only with the customer's IT email,
or USB for an organisation without internet access. The SHA-256 value is provided separately (email / delivery note); the customer
verifies it with `sha256sum -c`.

### 8.3 The right customer channel (later)

The GitHub Release is an internal channel: the repository is private, there are no customer accounts, and there is no record of who downloaded which release.
The target, in two steps:

**1. GCS time-limited link.** Small infrastructure, ready for sales:

| Part | What |
|---|---|
| Bucket | private `gs://sitekeep-releases` (not public), one `v1.0.0/` folder per release |
| CI | the release workflow also uploads the bundle to the bucket; identity via GitHub OIDC → Workload Identity Federation (no key file in the repository) |
| Sharing | `deploy/onprem/share-release.sh v1.0.0 "Müşteri A.Ş."` (customer name): generates a signed, unguessable link valid for 7 days and records who it was given to |
| Record | release × customer × date (linked to Odoo with the licensing work, lisanslama.md §6.2) |
| Cost | storage ≈ 400 MB per release; download traffic once per customer |

**2. Product website.** A customer portal on the website to be launched for SiteKeep: the customer logs in with their own account,
sees the releases their licence covers and downloads them (the links are still signed from GCS in the background).
Release notes, installation document and SHA-256 on the same page. A customer whose support period has ended does not see
releases published after that period (lisanslama.md §5.4). The release workflow does not change; only the
publish step also notifies the website.

