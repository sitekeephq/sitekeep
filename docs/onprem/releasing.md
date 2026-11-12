# Cutting a release (manually)

Cutting a SiteKeep release by hand and uploading it to the Odoo site. Automated path (GitHub Actions, `v*` tag):
[installation-bundle.md](installation-bundle.md) §8; both produce the same bundle.

## What is produced

```text
~/SiteKeep-surumler/sitekeep-1.0.0/
├── sitekeep-community-1.0.0-linux-amd64.tar.gz (+ .sha256)    public download
├── sitekeep-enterprise-1.0.0-linux-amd64.tar.gz (+ .sha256)   customer portal only
├── sitekeep-1.0.0-sbom.cdx.json                               dependency list (CycloneDX)
├── SURUM-NOTLARI.md                                           installation and update commands
└── SHA256SUMS
```

Modules are not separate files: the Enterprise bundle carries all seven modules, and the **licence file** issued
after the sale decides which ones the customer can use (lisanslama.md, opening section).

## Steps

1. `main` is up to date and CI or local tests are green (`git pull`).
2. Cut the release (Node 22, Docker, `gh auth login` or `NODE_AUTH_TOKEN`):

   ```bash
   deploy/release.sh --version 1.0.0 --tag
   ```

   In order: is the working tree clean → type check and unit tests → Community bundle → Enterprise bundle
   (both are checked to make sure the image carries no source or map files, and that Community contains no private module)
   → SBOM, release notes, `SHA256SUMS` → local `v1.0.0` tag. Duration: about 40–60 minutes on Linux amd64 including tests (in CI a single bundle took 29 minutes).

   | Option | What it does |
   |---|---|
   | `--smoke` | Installs and tests each bundle on an empty Linux server (Docker in Docker): installation, version and licence check, HTTPS, login, upload, backup / restore, update, rollback, uninstall. Recommended for the first releases. |
   | `--push-images` | Also pushes the two images to ghcr.io (for [Docker Compose](docker-compose.md) installations; run `docker login ghcr.io` first). |
   | `--skip-tests` | Skips the tests (if you have just run them). |
   | `--out <folder>` | Output folder (default `~/SiteKeep-surumler`). |
   | `--platform` | Default `linux/amd64` (customer servers). |

3. Upload to the Odoo site: the Community bundle and its `.sha256` to the public download page, the Enterprise bundle
   to the customer portal (licensed customers only). The release notes are in `SURUM-NOTLARI.md`.
4. Push the tag: `git push origin v1.0.0`.
5. Update the public repository and publish the Community release there as well:

   ```bash
   tools/public-sync.sh "SiteKeep 1.0.0" --push        # internal export + scan, single commit, github.com/sitekeephq/sitekeep
   docker tag sitekeep:1.0.0 ghcr.io/sitekeephq/sitekeep:1.0.0 && docker push ghcr.io/sitekeephq/sitekeep:1.0.0
   gh release create v1.0.0 -R sitekeephq/sitekeep --title "SiteKeep Community 1.0.0" -F ~/SiteKeep-surumler/sitekeep-1.0.0/SURUM-NOTLARI.md \
     ~/SiteKeep-surumler/sitekeep-1.0.0/sitekeep-community-1.0.0-linux-amd64.tar.gz*
   ```

   The Enterprise bundle never goes into the public repository. `tools/public-sync.sh` stops if the scan finds traces of internal information
   (`tools/public-export.markers`, allowed exceptions in `tools/public-export.allow`).

**Where to build:** customer servers are amd64. An Apple silicon Mac builds the amd64 image under emulation,
and building the DWG tool takes a long time (on the order of hours). The fast path is a Linux amd64 machine, for example a temporary
Google Cloud machine:

```bash
gcloud compute instances create sitekeep-build --zone=us-central1-c --machine-type=e2-standard-8 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=100GB
# on the machine: Docker, Node 22, gh; clone the repository and run deploy/release.sh; download the bundles and delete the machine
gcloud compute instances delete sitekeep-build --zone=us-central1-c
```

## After the sale: licence

The customer sends the installation ID from Administration → Licence; issue the licence and send it to the customer:

```bash
node tools/license/issue.mjs --key ~/.sitekeep/license-signing-2026-11.pem --kid 2026-11 \
  --customer "Poyraz İnşaat A.Ş." --customer-id odoo-1187 --installation inst_… \
  --modules cost,planning --seats 50 --from 2026-12-01 --until 2027-11-30 --out poyraz-2026.json
```

The customer uploads the file on the same screen; the modules are enabled. For a renewal, run the same command with new dates.
