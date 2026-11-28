# Installing with Docker Compose

Installing SiteKeep with `docker compose` on any server that has Docker. For organisations without internet access and for the single-file
installation wizard: [installation bundle](installation-bundle.md). Both use the same image.

| What | How |
|---|---|
| **SiteKeep Community** | Default image `ghcr.io/sitekeephq/sitekeep`. No licence required, no restrictions (AGPL-3.0). |
| **SiteKeep Enterprise** | `SITEKEEP_IMAGE=ghcr.io/sitekeephq/sitekeep-enterprise`. Access to the image comes with a licence; the modules are enabled by the licence uploaded in Administration → Licence (lisanslama.md). |

The images are published by the release workflow with every release ([installation-bundle.md](installation-bundle.md) §8, release plan B-5).
The Community image is public (`docker pull ghcr.io/sitekeephq/sitekeep`, linux/amd64 and linux/arm64); you can also [build from source](#building-from-source).

## Installation

Requirements: Docker 24+ and Compose v2; hardware depends on the number of users ([capacity.md](capacity.md) §4: trial tier 2 cores, 8 GB; up to 50 users 4 cores, 16 GB).

```bash
git clone https://github.com/sitekeephq/sitekeep.git && cd sitekeep   # or only docker-compose.yml + .env.example
cp .env.example .env        # change ADMIN_EMAIL, ADMIN_PASSWORD, POSTGRES_PASSWORD
docker compose up -d
```

The application opens at `http://server:8080` (`CDE_PORT`). On first startup the administrator account from `.env` is created.
Data lives in two volumes: `pgdata` (database) and `cdedata` (files and model derivatives).

### HTTPS

Put a reverse proxy in front (Caddy, nginx, IIS ARR) and set `SECURE_COOKIES=1` and `CDE_TRUST_PROXY=1` in `.env`.
The installation bundle installs Caddy itself.

### Office services (optional)

Profiles for editing in the browser and Office → PDF: `docker compose --profile onlyoffice up -d`
(or `collabora`, `gotenberg`); the matching block in `.env` ([Office Integration](../features/OFFICE_INTEGRATION.md)).

### macOS and Windows (Docker Desktop)

For trying SiteKeep on a workstation. For a server used by a team, install on Linux
([installation bundle](installation-bundle.md) or the steps above); the installation bundle is Linux only.

| | |
|---|---|
| **macOS** | Docker Desktop 4.x. The image is published for `linux/arm64` and `linux/amd64`, so Apple Silicon runs it natively, without emulation. Tested with the Community image on Apple Silicon: start-up, sign-in, project creation, IFC, PDF and DXF upload, IFC conversion for the model viewer, restart with data kept. |
| **Windows** | Docker Desktop with the **WSL2** backend (Settings → General → "Use the WSL 2 based engine"). Run the commands in PowerShell or a WSL terminal; `cp` becomes `copy .env.example .env` in `cmd`. Keep the folder on the WSL file system (for example `\\wsl$\Ubuntu\home\<user>\sitekeep`) for better file performance; the data itself is in Docker volumes either way. |
| **Memory** | Give Docker Desktop at least 4 GB (Settings → Resources); 8 GB when you open large IFC models. |
| **Port** | If 8080 is taken, set `CDE_PORT=18080` (or another port) in `.env` and open `http://localhost:18080`. |
| **Stopping** | `docker compose stop` keeps the data; `docker compose down -v` deletes it (both volumes). |

## Enterprise

```bash
# .env
SITEKEEP_IMAGE=ghcr.io/sitekeephq/sitekeep-enterprise
SITEKEEP_VERSION=1.0.0
```

```bash
docker login ghcr.io          # with the read access provided by 7Dimensions
docker compose up -d
```

Without a licence, the Enterprise image runs like Community. In Administration → Licence, copy the installation ID and request a licence,
then upload the `license.json` you receive on the same screen; the modules are enabled without a restart (refresh the page;
background jobs start at the next restart).

## Revit models (Enterprise)

With the Connect module, an uploaded Revit `.rvt` opens in the model viewer: the server converts it to IFC with
[rvt-rs](https://github.com/DrunkOnJava/rvt-rs) `rvt-ifc` (Apache-2.0; no Autodesk software, nothing leaves the
server) ([model formats](../features/MODEL_FORMATS.md), [Connect](../modules/connect.md#revit-models)).

- **Image:** the Enterprise image contains a pinned `rvt-ifc` (`/usr/local/bin/rvt-ifc`, licence texts in
  `/usr/share/sitekeep/`). The Community image has no converter: `.rvt` files are stored and versioned as plain files.
- **Check it:** `docker compose exec app rvt-ifc --version` (installation bundle: `docker exec` into the app
  container). The file panel shows the version a model was converted with ("Converted automatically from RVT 2024
  (rvt-rs 0.25.0)").
- **Settings** (in `.env` for compose, `config/app.env` for the installation bundle; restart after a change):

  | Variable | Default | Meaning |
  |---|---|---|
  | `SITEKEEP_RVT_MEMORY_MB` | `2048` | Memory cap of one conversion (address space, MB). A model that needs more fails with a message instead of taking the server's memory. `0` = no cap. |
  | `SITEKEEP_RVT_IFC_PATH` | empty | Another `rvt-ifc` than the image's (a newer rvt-rs mounted into the container). Empty: `/usr/local/bin/rvt-ifc`, then `PATH`. |

- **Memory:** conversions run one at a time, next to the application and the database. On real project files
  (Revit 2027, 1–354 MB) most conversions stayed near 1 GB; the heaviest needed the full 2 GB of the default cap.
  Plan about 2 GB of RAM for the converter on top of the [capacity](capacity.md) figures; raise
  `SITEKEEP_RVT_MEMORY_MB` (e.g. 3072) only when the server has the room and a large model fails with the memory message.
- **Time:** typical files convert in seconds to a minute or two (2–79 s on the files above); one conversion may run
  up to 60 minutes (the model job limit) before it is stopped.
- **Disk:** the converted IFC is kept next to the viewer model (people with download permission can download it
  from the file panel), so each converted version uses roughly its IFC size again in `cdedata`.
- **After an update with a new rvt-rs:** at startup, models converted with the earlier rvt-rs are converted again
  in the background (current versions first; the old model stays open meanwhile) and failed ones are retried once.
  Project administrators can also "Convert again" a single version, or all failed models of a project, from the file panel.

## Updating

```bash
# .env: SITEKEEP_VERSION=1.1.0
docker compose pull && docker compose up -d
```

Database migrations run automatically at startup. Take a backup before updating.

### Knowing about new releases

Administration → System Status can tell administrators when a newer release exists (a notice, and a badge in the top bar). It is
**off by default**, because the server sends nothing out on its own: System Status offers it once ("Check for new versions
automatically?"), and when on, SiteKeep asks GitHub once a day for the latest release number and nothing else (no installation ID,
no counts). **Check for updates** asks once, even while the daily check is off. Both go through the
[Privacy Centre](../features/PRIVACY.md) (connection `updates`; the connection switch and the kill switch stop it).
`SITEKEEP_UPDATE_URL` points the check at an internal mirror in a closed network. To update, follow the two lines above.

## Backup

```bash
docker compose exec db pg_dump -U cde cde | gzip > yedek-$(date +%F).sql.gz
docker run --rm -v sitekeep_cdedata:/data -v "$PWD":/yedek alpine tar -czf /yedek/dosyalar-$(date +%F).tar.gz -C /data .
```

The volume name starts with the Compose project name (the folder name; `docker volume ls`). The database and the files are only meaningful
together. With files on object storage (below) copy the bucket as well:
`docker compose run --rm --no-deps -u 0 -v "$PWD/objects":/backup app node apps/server/dist/scripts/storage.js pull /backup`. The installation bundle handles the nightly backup and restore itself ([backups.md](backups.md)).

## Object storage (optional)

Files can live in a bucket instead of the `cdedata` volume: MinIO, AWS S3, Cloudflare R2 (`CDE_STORAGE=s3`) or
Google Cloud Storage (`CDE_STORAGE=gcs`). Settings, a MinIO service example, migration of existing files and
backups: [Object storage](object-storage.md). The `cdedata` volume stays (read cache, temporary files; the
embedded database when `DATABASE_URL` is not set).

## Encryption at rest

SiteKeep encrypts its secrets (AI provider keys, two-factor secrets, OAuth tokens: AES-256-GCM with
`CDE_SECRET_KEY`). It does **not** encrypt the database or the stored files: anyone who gets the disk,
a disk image or a backup can read them. **Encrypting the disks and the backups is the operator's
responsibility** (GDPR Art. 32, KVKK m.12). Under the Cyber Resilience Act, protecting the
confidentiality of stored data, e.g. by encryption at rest, is one of the essential requirements the
manufacturer addresses in its risk assessment (Regulation (EU) 2024/2847, Annex I Part I(2)(e));
encryption inside the application is planned before 11 December 2027.

- **Disks:** put the Docker data directory (`/var/lib/docker`, which holds the `pgdata` and `cdedata`
  volumes; or the directories you bind-mount instead) on an encrypted volume. Linux: LUKS
  (`cryptsetup luksFormat`, usually chosen at installation: "encrypt the disk" in the Ubuntu / RHEL
  installer). Windows Server running Docker Desktop or a Hyper-V VM: BitLocker on the drive that holds
  the VM disk. Cloud servers: the provider's disk encryption (on by default at most providers; prefer
  customer-managed keys).
- **Backups:** encrypt every copy that leaves the server, for example
  `… | gzip | gpg --symmetric --cipher-algo AES256 -o backup.sql.gz.gpg` or `age -p`, or a tool that
  encrypts by itself (restic, Borg). Keep the passphrase apart from the backups, and test a restore.
- **Keys:** keep `.env` (database password, `CDE_SECRET_KEY`) out of the backups of files and store it
  encrypted, in a second place; without `CDE_SECRET_KEY` a restored database cannot decrypt its secrets.

Record these measures in your [records of processing](../compliance/RECORDS_OF_PROCESSING.md).

## Building from source

```bash
# .env
SITEKEEP_EDITION=community          # or enterprise
NODE_AUTH_TOKEN=…                   # read:packages (private packages: viewer and SDK until they are on npmjs.com; Enterprise modules always)
```

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`WITH_LIBREDWG=0` skips building the DWG preview tool (faster; no DWG preview).
If the edition is left empty, all modules are enabled without a licence check (our own installations only).
