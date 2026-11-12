## SiteKeep {{VERSION}}

commit `{{COMMIT}}`

| Edition | Installation package (Linux, {{ARCH}}) | Image |
|---|---|---|
| **SiteKeep Community** (AGPL-3.0, no licence required) | `sitekeep-community-{{VERSION}}-linux-{{ARCH}}.tar.gz` | `ghcr.io/sitekeephq/sitekeep:{{VERSION}}` |
| **SiteKeep Enterprise** (modules unlocked by licence) | `sitekeep-enterprise-{{VERSION}}-linux-{{ARCH}}.tar.gz` | `ghcr.io/sitekeephq/sitekeep-enterprise:{{VERSION}}` |

Each package comes with a `.sha256`; dependency list (SBOM, CycloneDX): `sitekeep-{{VERSION}}-sbom.cdx.json`.
This page is for internal distribution (private repository). The Enterprise package is delivered to customers through the Odoo customer portal
(docs/onprem/installation-bundle.md, release plan C-3); the Community package and image are public once the repository is opened.

### Team: download

```bash
gh release download v{{VERSION}} -R sitekeephq/sitekeep -p 'sitekeep-*-{{VERSION}}-linux-{{ARCH}}.tar.gz*'
shasum -a 256 -c sitekeep-*-{{VERSION}}-linux-{{ARCH}}.tar.gz.sha256
```

### Customer IT: new installation (package)

```bash
tar -xzf sitekeep-<community|enterprise>-{{VERSION}}-linux-{{ARCH}}.tar.gz && cd sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}
sha256sum -c SHA256SUMS
sudo ./install.sh
```

### Customer IT: upgrade (package)

```bash
tar -xzf sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}.tar.gz
sudo sitekeep upgrade ./sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}
```

The upgrade first takes a backup; if the new version does not come up healthy within 3 minutes, it automatically rolls back to the old version and the
pre-upgrade database.

### Docker Compose

Set `SITEKEEP_VERSION={{VERSION}}` in `.env`, then run `docker compose pull && docker compose up -d`
(docs/onprem/docker-compose.md).

Both packages passed an installation smoke test on a clean Linux server in CI (installation, version and licence
check, HTTPS, login, upload, backup/restore, upgrade, rollback, uninstall).
