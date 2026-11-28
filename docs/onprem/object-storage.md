# Object storage (S3, MinIO, R2, Google Cloud Storage)

SiteKeep keeps project files (originals, converted viewer models, previews, exports) on the **local disk** by
default: `DATA_DIR/storage`. It can keep them in a **bucket** instead. The database always stays on the local
disk (or the PostgreSQL server), as do the read cache and temporary work files.

| Driver | `CDE_STORAGE` | For | Credentials |
|---|---|---|---|
| Local disk | `local` (default) | single server, small and medium installations | none |
| S3-compatible | `s3` | MinIO (on premises), AWS S3, Cloudflare R2, other S3 APIs; Google Cloud Storage through its S3 interoperability API (HMAC keys) | access key + secret, or the AWS default chain (instance role) |
| Google Cloud Storage | `gcs` | our hosted server, any installation on Google Cloud | Application Default Credentials: the VM's service account, `GOOGLE_APPLICATION_CREDENTIALS`, or `gcloud auth application-default login`. No keys in SiteKeep's configuration |

## When to use it

- The data disk keeps filling with project files (models and drawings grow quickly; derivatives add about a
  third) and growing the disk is not wanted.
- Several terabytes, or storage the customer's IT already runs and backs up (MinIO, a NAS with an S3 gateway).
- Not needed for a small on-premises installation: a larger or separate disk mounted at `CDE_DATA` is simpler.

## How it works

- Files are written once under a new key (`projects/<id>/files/<uuid>`) and never changed in place, so the keys
  in the database are the same on every driver. Moving between drivers copies the files; the database does not change.
- Uploads stream to the bucket: up to the part size in one request, larger files in parts (S3 multipart,
  16 MiB × 4 at a time by default; GCS resumable upload). A file is never held in memory as a whole.
- Downloads, the PDF viewer, media seeking and viewer models are streamed from the bucket; HTTP ranges become
  ranged reads of the object. Every download still goes through SiteKeep's permission checks: the browser never
  sees the bucket, its address or a signed link.
- Workers that need a file on disk (IFC conversion, previews, office conversion, DWG, sheets and OCR, IDS checks,
  document and drawing comparison, project import, Revit through the Connect module) get a **local copy** under
  `DATA_DIR/tmp/storage`, removed when the work ends, also when it fails (the folder is emptied at start). With the
  local driver they get the stored file itself (no copy).
- A **read cache** on the data disk (`DATA_DIR/cache/storage`) keeps recently used objects (viewer models,
  previews, PDFs, worker inputs): least recently used files go first, a file in use is never removed, a download is
  checked against the object's size before it is used, and several readers of one file share one download.
- At start the server writes, reads, lists and deletes a small probe object (`<prefix>.sitekeep-probe/…`). If
  the bucket is misconfigured or does not answer, **the server does not start** and says why; it never falls back
  to the local disk silently.

## Settings

In the server's environment (`/opt/sitekeep/config/app.env` in the installation bundle, `app.env` on our hosted
server, the `app` service's `environment` in Docker Compose).

| Variable | Default | Meaning |
|---|---|---|
| `CDE_STORAGE` | `local` | `local`, `s3` or `gcs` |
| `CDE_S3_BUCKET` | — | s3: bucket (required) |
| `CDE_S3_ENDPOINT` | — (AWS) | s3: `http(s)://host[:port]`, e.g. `http://minio:9000`, `https://<account>.r2.cloudflarestorage.com`, `https://storage.googleapis.com` (GCS with HMAC) |
| `CDE_S3_REGION` | `us-east-1` | s3: region (`auto` for R2 and GCS) |
| `CDE_S3_ACCESS_KEY_ID` / `CDE_S3_SECRET_ACCESS_KEY` | — | s3: both or neither; neither uses the AWS default chain (environment, instance role) |
| `CDE_S3_FORCE_PATH_STYLE` | `1` with an endpoint, else `0` | s3: path-style addresses (MinIO) |
| `CDE_S3_PREFIX` / `CDE_GCS_PREFIX` | — | key prefix inside the bucket, e.g. `sitekeep` (one bucket, several installations) |
| `CDE_S3_PART_SIZE_MB` | `16` | s3: multipart part size, 5–512 |
| `CDE_S3_UPLOAD_CONCURRENCY` | `4` | s3: parts uploaded at the same time, 1–16 (memory ≈ part size × (this + 1) per upload) |
| `CDE_GCS_BUCKET` | — | gcs: bucket (required), with or without `gs://` |
| `CDE_GCS_PROJECT` | — | gcs: project id, when ADC cannot tell it |
| `CDE_STORAGE_CACHE_GB` | `2` | read cache size; `0` turns it off |
| `CDE_STORAGE_CACHE_DIR` | `DATA_DIR/cache/storage` | read cache folder |

The secret is never shown on a screen, written to the log or sent to the browser; error texts are redacted.
Administration → System Status shows the driver, the bucket, whether it answers (with the time of one small
request) and the cache use. The Privacy Centre summary names the bucket as where files are kept.

**Privacy.** A bucket the operator configures as the primary store is where SiteKeep keeps its data, like the
database server: it is not an "external connection" in the Privacy Centre sense, it is not in the External
Connections list and **Turn Off All External Connections** does not stop it (SiteKeep cannot work without its
files). It is the operator's processor (the cloud provider, or their own MinIO), named in the privacy statement and
the data processing records. Choose the bucket's region with that in mind.

## Google Cloud Storage (our hosted server)

Our organisation does not allow service account keys (`constraints/iam.disableServiceAccountKeyCreation`), so
the hosted server uses the native driver with the VM's own service account.

1. **Bucket** (same region as the VM): uniform bucket-level access, **public access
   prevention on**, Object Versioning on, soft delete (default 7 days) kept. No ACLs, no public members.
2. **Permission**: the VM's service account (`<vm-service-account>`) gets
   `roles/storage.objectAdmin` **on the bucket only**:
   `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:<vm-service-account> --role=roles/storage.objectAdmin`
3. **VM access scope**: the VM must allow Storage writes. The default scope set is read-only for Storage. Check:
   `gcloud compute instances describe <vm> --zone <zone> --format='value(serviceAccounts[].scopes)'`.
   It must contain `devstorage.read_write` or `cloud-platform`. Changing it needs the VM stopped:
   `gcloud compute instances set-service-account <vm> --zone <zone> --service-account <vm-service-account> --scopes cloud-platform` (or the existing scopes plus `storage-rw`).
4. **Check from the container** before switching (no change to the running app):
   `docker run --rm -e CDE_STORAGE=gcs -e CDE_GCS_BUCKET=<bucket> -e CDE_GCS_PREFIX=app -v 7d-cde-data:/data <new image> node apps/server/dist/scripts/storage.js check`
5. Settings in `app.env`:

   ```
   CDE_STORAGE=gcs
   CDE_GCS_BUCKET=<bucket>
   CDE_GCS_PREFIX=app
   CDE_STORAGE_CACHE_GB=3
   ```

Same region as the VM: no egress charges, latency of a few milliseconds. On a laptop, `gcloud auth
application-default login` is enough for the tools and tests.

**GCS with HMAC keys** (where the organisation allows them): `CDE_STORAGE=s3`, `CDE_S3_ENDPOINT=https://storage.googleapis.com`,
`CDE_S3_REGION=auto`, an HMAC key of a service account that has `roles/storage.objectAdmin` on the bucket. The
native driver is preferred.

## MinIO (on premises) and other S3 stores

1. A bucket for SiteKeep, **private** (no anonymous policy: `mc anonymous get <alias>/sitekeep` must say
   `none`), versioning on if the customer wants undelete.
2. A user or service account with a policy limited to that bucket:

   ```json
   { "Version": "2012-10-17", "Statement": [
     { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::sitekeep"] },
     { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], "Resource": ["arn:aws:s3:::sitekeep/*"] } ] }
   ```

3. Settings:

   ```
   CDE_STORAGE=s3
   CDE_S3_ENDPOINT=http://minio:9000
   CDE_S3_BUCKET=sitekeep
   CDE_S3_ACCESS_KEY_ID=...
   CDE_S3_SECRET_ACCESS_KEY=...
   ```

   AWS S3: no endpoint, `CDE_S3_REGION=<region>`, credentials or an instance role. Cloudflare R2:
   `CDE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `CDE_S3_REGION=auto`, `CDE_S3_FORCE_PATH_STYLE=0`.

**Docker Compose example.** The customer usually has MinIO already; for a self-contained server a MinIO (or
another S3 server) service can sit next to the app. MinIO no longer publishes community images, so use the
image the customer builds or trusts; the S3 server only has to be reachable from the `app` service:

```yaml
services:
  minio:
    image: ${MINIO_IMAGE}            # e.g. the customer's MinIO build
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes: [minio-data:/data]
    restart: unless-stopped
    # no published ports: only the app reaches it; publish 9001 on 127.0.0.1 for the console if needed
  app:
    environment:
      CDE_STORAGE: s3
      CDE_S3_ENDPOINT: http://minio:9000
      CDE_S3_BUCKET: sitekeep
      CDE_S3_ACCESS_KEY_ID: ${CDE_S3_ACCESS_KEY_ID}
      CDE_S3_SECRET_ACCESS_KEY: ${CDE_S3_SECRET_ACCESS_KEY}
    depends_on: [minio]
volumes:
  minio-data:
```

A MinIO on the same disk saves nothing; it pays off on another machine or storage system.

## Moving existing files (migration)

The `storage` tool copies `DATA_DIR/storage` to the bucket the environment configures. Keys stay the same. It
never deletes anything unless asked with a separate command.

```
# in the image (the hosted server: docker exec 7d-cde-app …; the bundle: sudo sitekeep storage [--to=s3|gcs] …)
node apps/server/dist/scripts/storage.js check                 # the bucket answers: write/read/list/delete probe
node apps/server/dist/scripts/storage.js migrate --dry-run     # how many files / GB would be copied
node apps/server/dist/scripts/storage.js migrate               # copy + verify (size and sha256 read back)
node apps/server/dist/scripts/storage.js prune-local --dry-run # what prune-local would delete
node apps/server/dist/scripts/storage.js prune-local --yes     # delete local copies that are verified in the bucket
```

- `migrate` writes every verified key to `DATA_DIR/storage-migration.jsonl`. It can be stopped and run again at
  any time: it continues with what is missing (resumable, idempotent). An object already in the bucket with the
  same size is verified, not copied again; a different object under the same key is reported, never overwritten.
  `--verify=size` skips reading back (faster, size only); `--concurrency=N` (default 4).
- The tool needs the bucket's variables **in its own environment** while the server still runs on the local disk:
  `docker exec -e CDE_STORAGE=gcs -e CDE_GCS_BUCKET=… 7d-cde-app node …`, or, with the bucket variables already in
  `app.env` and `CDE_STORAGE` still `local`, `--to=gcs` (`sudo sitekeep storage --to=s3 migrate` in the bundle).
- `prune-local` deletes only files that the manifest records as verified **and** that the bucket still has with
  the same size. Run it after the server has worked on the bucket for a while and the bucket has its backup
  (versioning, soft delete); until then the local copy is the way back.

**Procedure** (downtime: the second `migrate` only, usually minutes):

1. Bucket, permission, check (above). Take a database dump.
2. `migrate --dry-run`, then `migrate` while the server keeps running on the local disk (the bulk).
3. Stop the app. `migrate` again: copies what was uploaded meanwhile. It must end with no failures.
4. Set `CDE_STORAGE` and its variables, start the app. The log says `File storage: gcs gs://…`; System Status shows the bucket.
5. Open a few old and new files, a model and a drawing preview; upload a file.
6. Later: `prune-local --dry-run`, `prune-local --yes`.

**Rollback**: until `prune-local`, set `CDE_STORAGE=local` (or remove the line) and restart. Files uploaded while
the bucket was in use are only in the bucket: bring them back with `pull` into the local storage folder first
(`storage.js pull /data/storage` with the bucket variables set; it skips files that are already there), then
switch back.

## Read cache sizing

Default 2 GB. Viewer models (Fragments) and previews are read far more often than they are written; the cache
keeps them on the local disk. Rule of thumb: the viewer models and PDFs of the projects people open in a week, at
least twice the largest model. A single object larger than 1/8 of the cache (and over 512 MB) is not cached, it
goes through a temporary copy. The cache is a copy: deleting `DATA_DIR/cache/storage` at any time is safe (stop
the app first). Size and hit counts are on System Status.

## Performance notes

- First byte of a download: one request to the bucket (a few ms in the same region, more over a WAN);
  throughput is the network's. Ranged reads (PDF pages, video seeking) are separate small requests.
- Workers on large files wait for the local copy first (about the file size ÷ network speed). The cache removes
  that for repeated work on the same file.
- Measured on a laptop against an S3 server in Docker Desktop (PR #199), 200 MB file: upload 14–94 MB/s depending
  on part size and concurrency, download 114 MB/s, first byte 23 ms, first byte of a 64 KB range 7 ms; a 12 MB
  viewer model 102 ms without the cache, 7 ms from the cache. The local disk is an order of magnitude faster. On
  GCP in the same region expect roughly 100–300 MB/s per stream; raise `CDE_S3_PART_SIZE_MB` /
  `CDE_S3_UPLOAD_CONCURRENCY` for faster S3 uploads.
- Temporary copies need free space on the data disk for the largest file being worked on at the same time.

## Backups

The safe default: **`sitekeep backup` copies the bucket too**. With `CDE_STORAGE=s3|gcs` the backup runs
`storage.js pull` into `<backup>/objects/` (hard links to the previous backup for objects that did not change, so a
nightly backup only downloads new files) next to the database dump; `sitekeep restore` uploads what the bucket is
missing (`storage.js push`). A backup is complete on every driver.

When the bucket has its own protection (versioning + soft delete or object lock, replication to another region,
the provider's backup) and the data disk is too small for a second copy, set `CDE_BACKUP_OBJECTS=0` (in `/opt/sitekeep/.env`, next to `CDE_BACKUP_KEEP`): the backup then
holds the database and settings only, and **the bucket's versioning is the file backup**. Restoring a point in time
then means restoring the database dump and leaving the bucket as it is (keys are never reused, so old database
states still find their files as long as versioning / soft delete keeps deleted objects; keep it at least as long
as the database backups).

Our hosted server: disk snapshots + nightly database dump (docs/server/server.md §8) as before; the files are
protected by the bucket's Object Versioning and soft delete (keep noncurrent versions ≥ 14 days, the dump retention).

## Security

- Private bucket, public access prevention / no anonymous policy, credentials limited to the one bucket.
- No public or pre-signed URLs: every byte goes through SiteKeep's permission checks (download, viewer, WOPI).
- Encryption at rest: the provider's (GCS, S3 SSE) or MinIO's KMS; in transit: use `https://` endpoints outside
  a private network.
- Credentials: environment only (`app.env`, 0600). Error texts and the error log redact them.

## Troubleshooting

| Message at start | Cause |
|---|---|
| `CDE_STORAGE=s3 needs CDE_S3_BUCKET.` and other `CDE_…` messages | setting missing or malformed |
| `Object storage … is not usable (write failed): AccessDenied` / `HTTP 403` | key or role without write permission; on GCP also the VM scope (above) |
| `… (write failed): … ECONNREFUSED` / timeout | endpoint wrong or not reachable from the container |
| `… (list failed)` | the credentials may write but not list (`s3:ListBucket` / `storage.objects.list`) |
| a worker fails with `Storage driver "gcs" has no local paths` | a module still calls `storage.localPath`; update the module (docs/modules/README.md) |
