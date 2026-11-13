# SiteKeep — Installation (Linux)

This package installs SiteKeep on a company server. It contains everything needed (the application, PostgreSQL,
an HTTPS proxy); no internet access is required during installation.

## Requirements

- 64-bit Linux (Ubuntu 22.04/24.04, Debian 12, RHEL/Rocky/Alma 9 recommended)
- Docker Engine 24+ and the Compose plugin (`docker compose`)
- Administrator (root / sudo) privileges
- Hardware, by number of users:

| Users | vCPU | RAM | Data disk |
|---|---|---|---|
| ≤ 10 | 2 | 8 GB | 100 GB |
| ≤ 50 | 4 | 16 GB | 500 GB |
| ≤ 200 | 8 | 32 GB | 1–2 TB |
| ≤ 500 | 16 | 64 GB | 2–4 TB |

Disk usage grows with the volume of uploaded models and drawings, not with the number of users
(roughly: uploaded files × 1.6).

## Installation

```bash
tar -xzf sitekeep-<version>-linux-amd64.tar.gz
cd sitekeep-<version>-linux-amd64
sha256sum -c SHA256SUMS        # package integrity
sudo ./install.sh
```

The wizard asks, in order: the estimated number of users, the server address, the HTTPS type, the first administrator's
email and password, the language, and the time of the nightly backup. At the end it shows the address and (if one was generated) the administrator
password once.

Unattended installation: `cp answers.env.example answers.env`, edit it, then `sudo ./install.sh --answers answers.env`.
An answers file under its old name `cevap.env` is still accepted when `answers.env` is missing.

### HTTPS types

| Type | When |
|---|---|
| `internal` (default) | internal network. The installer generates the certificate; distribute the root certificate `/opt/sitekeep/config/sitekeep-root-ca.crt` to clients (via GPO; installations from earlier bundles have it as `sitekeep-kok-sertifika.crt`) and the browser warning goes away. |
| `files` | the organisation's own certificate (PEM; certificate including chain + private key). |
| `auto` | public domain name and internet: a Let's Encrypt certificate is obtained and renewed automatically (ports 80 and 443 must be reachable from outside). |
| `off` | HTTP only. Not recommended. |

## Where things are

| Path | Contents |
|---|---|
| `/opt/sitekeep/` | management files (`compose.yml`, `.env`, `bin/sitekeep`) |
| `/opt/sitekeep/config/app.env` | application settings; contains secrets, readable by root only |
| `/var/lib/sitekeep/pgdata` | database |
| `/var/lib/sitekeep/app` | uploaded files and model derivatives |
| `/var/lib/sitekeep/backups` | backups |

The data directory can be placed on a separate disk: set `CDE_DATA=/data/sitekeep` before installing.

## Administration

```bash
sitekeep status                    # services, health, last backup, disk
sitekeep logs app                  # logs
sudo sitekeep backup               # back up now
sitekeep backups                   # list backups
sudo sitekeep restore 20270115-023000
sudo sitekeep upgrade /path/sitekeep-<new version>-linux-amd64
sudo sitekeep stop | start | restart
sudo sitekeep uninstall            # data is kept; deleted with --purge
```

A **backup** is taken every night at the time chosen during installation: the database (verified dump), the files
(incremental against the previous backup) and the settings. The last 14 backups are kept. Copy the backup directory regularly
**off the server** (NAS, backup server); a backup on the same disk does not protect against disk failure.

An **upgrade** first takes a backup, then starts the new version; if it does not come up healthy within 3 minutes, it automatically
rolls back to the old version and the pre-upgrade database.

## Troubleshooting

| Symptom | Check |
|---|---|
| Installation says "Port 443 is in use" | another web server runs on the same server; set a different port, e.g. `CDE_HTTPS_PORT=8443` |
| Browser certificate warning | with the `internal` type, distribute the root certificate to clients |
| Page does not open | `sitekeep status`, `sitekeep logs proxy`, port 443 in the firewall |
| For support | the output of `sitekeep status` and the last lines of `sitekeep logs app` |
