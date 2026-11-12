# Installing with Docker Compose

Installing SiteKeep with `docker compose` on any server that has Docker. For organisations without internet access and for the single-file
installation wizard: [installation bundle](installation-bundle.md). Both use the same image.

| What | How |
|---|---|
| **SiteKeep Community** | Default image `ghcr.io/sitekeephq/sitekeep`. No licence required, no restrictions (AGPL-3.0). |
| **SiteKeep Enterprise** | `SITEKEEP_IMAGE=ghcr.io/sitekeephq/sitekeep-enterprise`. Access to the image comes with a licence; the modules are enabled by the licence uploaded in Administration → Licence (lisanslama.md). |

The images are published by the release workflow with every release ([installation-bundle.md](installation-bundle.md) §8, release plan B-5).
Until the repository is opened, the Community image is private too; until then, [build from source](#building-from-source).

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

## Updating

```bash
# .env: SITEKEEP_VERSION=1.1.0
docker compose pull && docker compose up -d
```

Database migrations run automatically at startup. Take a backup before updating.

## Backup

```bash
docker compose exec db pg_dump -U cde cde | gzip > yedek-$(date +%F).sql.gz
docker run --rm -v sitekeep_cdedata:/data -v "$PWD":/yedek alpine tar -czf /yedek/dosyalar-$(date +%F).tar.gz -C /data .
```

The volume name starts with the Compose project name (the folder name; `docker volume ls`). The database and the files are only meaningful
together. The installation bundle handles the nightly backup and restore itself ([backups.md](backups.md)).

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
