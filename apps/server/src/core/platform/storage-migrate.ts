import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, link, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { hashStored, type ObjectStorage } from "./object-storage.js";
import { assertKey, type LocalStorage } from "./storage.js";

/**
 * Moving the files of the local disk to object storage (docs/onprem/object-storage.md → Migration), and the
 * copies `sitekeep backup` / `restore` make of a bucket. Keys stay the same, so the database needs no change.
 *
 * migrate: copies every local file the bucket does not have yet, checks size (and sha256 by reading it back),
 * records each verified key in a manifest (DATA_DIR/storage-migration.jsonl). A second run only does what is
 * missing (resumable, idempotent). Local files are never removed here: prune does that, separately.
 */
export interface MigrateOptions {
  source: LocalStorage;
  target: ObjectStorage;
  manifestPath: string;
  dryRun?: boolean;
  /** sha256 (default): reads every copied object back; size: compares sizes only. */
  verify?: "sha256" | "size";
  concurrency?: number;
  log?: (line: string) => void;
}

export interface MigrateReport {
  files: number;
  bytes: number;
  copied: number;
  copiedBytes: number;
  alreadyThere: number;
  /** Dry run: what would be copied. */
  wouldCopy: number;
  wouldCopyBytes: number;
  failed: { key: string; error: string }[];
}

interface ManifestRow {
  key: string;
  size: number;
  sha256: string;
}

export async function readManifest(file: string): Promise<Map<string, ManifestRow>> {
  const rows = new Map<string, ManifestRow>();
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ManifestRow;
      if (r.key && typeof r.size === "number") rows.set(r.key, r);
    } catch {
      // a line cut by a crash; the key is checked again
    }
  }
  return rows;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest("hex");
}

async function pool<T>(items: AsyncIterable<T>, concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const running = new Set<Promise<void>>();
  for await (const item of items) {
    const p = fn(item).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= concurrency) await Promise.race(running);
  }
  await Promise.all(running);
}

export async function migrateToObjectStorage(o: MigrateOptions): Promise<MigrateReport> {
  const log = o.log ?? (() => {});
  const verify = o.verify ?? "sha256";
  const done = await readManifest(o.manifestPath);
  const report: MigrateReport = { files: 0, bytes: 0, copied: 0, copiedBytes: 0, alreadyThere: 0, wouldCopy: 0, wouldCopyBytes: 0, failed: [] };
  if (!o.dryRun) await mkdir(path.dirname(o.manifestPath), { recursive: true });
  await pool(o.source.list(""), o.concurrency ?? 4, async (e) => {
    report.files++;
    report.bytes += e.size;
    try {
      const there = await o.target.backend.head(o.target.prefix + e.key);
      const known = done.get(e.key);
      if (known && known.size === e.size && there?.size === e.size) {
        report.alreadyThere++;
        return;
      }
      if (there && there.size !== e.size) throw new Error(`the bucket already has a different object (${there.size} bytes, local ${e.size})`);
      const localSum = await sha256File(o.source.localPath(e.key));
      if (there) {
        // Copied before the manifest line was written: verify it, then record it.
        if (verify === "sha256" && (await hashStored(o.target, e.key)).sha256 !== localSum) throw new Error("the bucket's copy differs (sha256)");
        if (!o.dryRun) await appendFile(o.manifestPath, JSON.stringify({ key: e.key, size: e.size, sha256: localSum }) + "\n");
        report.alreadyThere++;
        return;
      }
      if (o.dryRun) {
        report.wouldCopy++;
        report.wouldCopyBytes += e.size;
        return;
      }
      const put = await o.target.putAt(e.key, createReadStream(o.source.localPath(e.key)));
      if (put.size !== e.size || put.sha256 !== localSum) throw new Error("the file changed while it was copied");
      const head = await o.target.backend.head(o.target.prefix + e.key);
      if (head?.size !== e.size) throw new Error(`size in the bucket ${head?.size ?? "missing"} != ${e.size}`);
      if (verify === "sha256" && (await hashStored(o.target, e.key)).sha256 !== localSum) throw new Error("read-back sha256 differs");
      await appendFile(o.manifestPath, JSON.stringify({ key: e.key, size: e.size, sha256: localSum }) + "\n");
      report.copied++;
      report.copiedBytes += e.size;
      if (report.copied % 200 === 0) log(`  ${report.copied} copied (${(report.copiedBytes / 1024 ** 3).toFixed(2)} GB)…`);
    } catch (err) {
      report.failed.push({ key: e.key, error: o.target.backend.describeError(err) });
      log(`  FAILED ${e.key}: ${o.target.backend.describeError(err)}`);
    }
  });
  return report;
}

/**
 * Removes local files that the manifest records as verified and that the bucket still has with the same
 * size. Run only after the server uses the bucket (CDE_STORAGE=s3|gcs) and a backup of the bucket exists.
 */
export async function pruneLocal(o: { source: LocalStorage; target: ObjectStorage; manifestPath: string; dryRun?: boolean; log?: (l: string) => void }) {
  const done = await readManifest(o.manifestPath);
  const r = { removed: 0, removedBytes: 0, kept: 0, notInManifest: 0 };
  for await (const e of o.source.list("")) {
    const known = done.get(e.key);
    if (!known || known.size !== e.size) {
      r.notInManifest++;
      continue;
    }
    const there = await o.target.backend.head(o.target.prefix + e.key);
    if (there?.size !== e.size) {
      r.kept++;
      o.log?.(`  kept ${e.key}: not in the bucket with the same size`);
      continue;
    }
    if (!o.dryRun) await o.source.remove(e.key);
    r.removed++;
    r.removedBytes += e.size;
  }
  return r;
}

/**
 * Copies every object of the bucket into `dir` (backup). Files already in `dir` with the same size are
 * kept; with `linkDest` (the previous backup) an unchanged object is hard-linked instead of downloaded.
 * Keys are immutable, so the same key and size is the same content.
 */
export async function pullObjects(o: { target: ObjectStorage; dir: string; linkDest?: string; concurrency?: number; log?: (l: string) => void }) {
  const r = { objects: 0, bytes: 0, downloaded: 0, linked: 0, kept: 0, failed: 0 };
  await pool(o.target.list(""), o.concurrency ?? 4, async (e) => {
    r.objects++;
    r.bytes += e.size;
    try {
      assertKey(e.key);
      const dest = path.join(o.dir, ...e.key.split("/"));
      if ((await stat(dest).catch(() => null))?.size === e.size) {
        r.kept++;
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      if (o.linkDest) {
        const prev = path.join(o.linkDest, ...e.key.split("/"));
        if ((await stat(prev).catch(() => null))?.size === e.size) {
          await rm(dest, { force: true });
          await link(prev, dest);
          r.linked++;
          return;
        }
      }
      const tmp = `${dest}.part`;
      await pipeline(o.target.get(e.key), createWriteStream(tmp));
      if ((await stat(tmp)).size !== e.size) throw new Error("size differs after download");
      await rename(tmp, dest);
      r.downloaded++;
    } catch (err) {
      r.failed++;
      o.log?.(`  FAILED ${e.key}: ${o.target.backend.describeError(err)}`);
    }
  });
  return r;
}

/** Uploads the files of `dir` (a backup made by pullObjects) that the bucket does not have (restore). */
export async function pushObjects(o: { target: ObjectStorage; dir: string; concurrency?: number; log?: (l: string) => void }) {
  const r = { files: 0, uploaded: 0, alreadyThere: 0, failed: 0 };
  async function* walk(d: string): AsyncIterable<string> {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile() && !e.name.endsWith(".part")) yield full;
    }
  }
  await pool(walk(o.dir), o.concurrency ?? 4, async (file) => {
    r.files++;
    const key = path.relative(o.dir, file).split(path.sep).join("/");
    try {
      assertKey(key);
      const size = (await stat(file)).size;
      const there = await o.target.backend.head(o.target.prefix + key);
      if (there?.size === size) {
        r.alreadyThere++;
        return;
      }
      if (there) await o.target.backend.delete(o.target.prefix + key);
      await o.target.putAt(key, createReadStream(file));
      r.uploaded++;
    } catch (err) {
      r.failed++;
      o.log?.(`  FAILED ${key}: ${o.target.backend.describeError(err)}`);
    }
  });
  return r;
}
