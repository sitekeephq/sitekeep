import path from "node:path";
import { ObjectStorage } from "./object-storage.js";
import { StorageCache } from "./storage-cache.js";
import { GcsBackend } from "./storage-gcs.js";
import { S3Backend } from "./storage-s3.js";
import { LocalStorage, type Storage } from "./storage.js";

/**
 * Storage from the environment (docs/onprem/object-storage.md):
 *   CDE_STORAGE                 local (default) | s3 | gcs
 *   CDE_S3_BUCKET               s3: bucket (required)
 *   CDE_S3_ENDPOINT             s3: http(s)://host[:port] for MinIO, R2 and others; empty for AWS S3
 *   CDE_S3_REGION               s3: default us-east-1 (R2: auto)
 *   CDE_S3_ACCESS_KEY_ID / CDE_S3_SECRET_ACCESS_KEY
 *                               s3: both or neither (neither: the AWS default chain, e.g. an instance role)
 *   CDE_S3_FORCE_PATH_STYLE     s3: 1/0; default 1 with CDE_S3_ENDPOINT (MinIO), else 0
 *   CDE_S3_PART_SIZE_MB         s3: multipart part size, 5–512 (default 16)
 *   CDE_S3_UPLOAD_CONCURRENCY   s3: parts at the same time, 1–16 (default 4)
 *   CDE_GCS_BUCKET              gcs: bucket (required); credentials: Application Default Credentials
 *   CDE_GCS_PROJECT             gcs: optional project id
 *   CDE_S3_PREFIX / CDE_GCS_PREFIX   optional key prefix inside the bucket, e.g. "sitekeep"
 *   CDE_STORAGE_CACHE_GB        local read cache of object storage (default 2; 0 turns it off)
 *   CDE_STORAGE_CACHE_DIR       default DATA_DIR/cache/storage
 */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

function num(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new StorageConfigError(`${name}=${raw}: expected a number from ${min} to ${max}.`);
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new StorageConfigError(`${name}=${raw}: expected 1 or 0.`);
}

function cacheFromEnv(env: NodeJS.ProcessEnv, dataDir: string): StorageCache | null {
  const gb = num(env, "CDE_STORAGE_CACHE_GB", 2, 0, 10_000);
  if (gb === 0) return null;
  return new StorageCache(path.resolve(env.CDE_STORAGE_CACHE_DIR?.trim() || path.join(dataDir, "cache", "storage")), Math.floor(gb * 1024 ** 3));
}

/** Builds the storage the environment asks for; nothing is contacted yet (openStorage does that). */
export function storageFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env, opts: { cache?: boolean; server?: boolean } = {}): Storage {
  const driver = (env.CDE_STORAGE?.trim() || "local").toLowerCase();
  // The server's temporary copies; a tool run next to it uses its own directory.
  const workDir = path.join(dataDir, "tmp", opts.server ? "storage" : `storage-tool-${process.pid}`);
  const cache = opts.cache === false ? null : cacheFromEnv(env, dataDir);
  if (driver === "local") return new LocalStorage(path.join(dataDir, "storage"));
  if (driver === "s3") {
    const bucket = env.CDE_S3_BUCKET?.trim();
    if (!bucket) throw new StorageConfigError("CDE_STORAGE=s3 needs CDE_S3_BUCKET.");
    const endpoint = env.CDE_S3_ENDPOINT?.trim() || undefined;
    if (endpoint) {
      let u: URL;
      try {
        u = new URL(endpoint);
      } catch {
        throw new StorageConfigError("CDE_S3_ENDPOINT is not a URL (expected http(s)://host[:port]).");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new StorageConfigError("CDE_S3_ENDPOINT must start with http:// or https://.");
      if (u.username || u.password) throw new StorageConfigError("CDE_S3_ENDPOINT must not carry credentials; use CDE_S3_ACCESS_KEY_ID / CDE_S3_SECRET_ACCESS_KEY.");
    }
    const accessKeyId = env.CDE_S3_ACCESS_KEY_ID?.trim() || undefined;
    const secretAccessKey = env.CDE_S3_SECRET_ACCESS_KEY?.trim() || undefined;
    if (!!accessKeyId !== !!secretAccessKey) throw new StorageConfigError("Set both CDE_S3_ACCESS_KEY_ID and CDE_S3_SECRET_ACCESS_KEY, or neither.");
    const backend = new S3Backend({
      endpoint,
      region: env.CDE_S3_REGION?.trim() || "us-east-1",
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: flag(env, "CDE_S3_FORCE_PATH_STYLE", !!endpoint),
      partSize: num(env, "CDE_S3_PART_SIZE_MB", 16, 5, 512) * 1024 * 1024,
      concurrency: num(env, "CDE_S3_UPLOAD_CONCURRENCY", 4, 1, 16),
    });
    return new ObjectStorage(backend, { prefix: env.CDE_S3_PREFIX, workDir, cache, partSize: num(env, "CDE_S3_PART_SIZE_MB", 16, 5, 512) * 1024 * 1024 });
  }
  if (driver === "gcs") {
    const bucket = env.CDE_GCS_BUCKET?.trim().replace(/^gs:\/\//, "").replace(/\/+$/, "");
    if (!bucket) throw new StorageConfigError("CDE_STORAGE=gcs needs CDE_GCS_BUCKET.");
    const backend = new GcsBackend({ bucket, projectId: env.CDE_GCS_PROJECT?.trim() || undefined });
    return new ObjectStorage(backend, { prefix: env.CDE_GCS_PREFIX, workDir, cache });
  }
  throw new StorageConfigError(`CDE_STORAGE=${driver}: expected local, s3 or gcs.`);
}

/**
 * The storage, ready: temporary copies cleared, cache loaded, and the store written, read, listed and
 * deleted once. Object storage that does not answer stops the start (no fallback to the local disk).
 */
export async function openStorage(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { cache?: boolean; server?: boolean } = {},
): Promise<Storage> {
  const storage = storageFromEnv(dataDir, env, opts);
  if (storage instanceof ObjectStorage) await storage.init({ clearScratch: opts.server === true });
  await storage.check();
  return storage;
}

/** One line for the start log; never credentials. */
export function describeStorage(storage: Storage): string {
  const i = storage.info();
  const cache = i.cache ? `, cache ${(i.cache.maxBytes / 1024 ** 3).toFixed(1)} GB` : storage.driver === "local" ? "" : ", no cache";
  return `${i.driver} ${i.location}${i.endpoint ? ` (${i.endpoint})` : ""}${cache}`;
}
