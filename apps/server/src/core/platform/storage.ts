import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

/** Inclusive byte range, as in an HTTP Range header (`bytes=start-end`). */
export interface ByteRange {
  start: number;
  end: number;
}

/** A file on the server's disk holding a stored object, for workers that need a path. */
export interface LocalCopy {
  readonly path: string;
  /** Removes a temporary copy (object storage) or does nothing (local disk). Call it once, also on error. */
  release(): Promise<void>;
}

export interface StorageEntry {
  key: string;
  size: number;
}

export type StorageDriverName = "local" | "s3" | "gcs";

export interface StorageCacheStatus {
  enabled: boolean;
  maxBytes: number;
  usedBytes: number;
  entries: number;
  hits: number;
  misses: number;
}

/** What Administration → System Status shows; never credentials. */
export interface StorageInfo {
  driver: StorageDriverName;
  /** Local root, `s3://bucket/prefix` or `gs://bucket/prefix`. */
  location: string;
  bucket?: string;
  prefix?: string;
  /** S3: the endpoint host (no credentials, no path). */
  endpoint?: string;
  region?: string;
  cache: StorageCacheStatus | null;
}

export interface StoragePing {
  ok: boolean;
  ms: number;
  error?: string;
}

/** A stored object was asked for a local path although the storage is not the local disk. */
export class StorageNotLocalError extends Error {
  constructor(driver: StorageDriverName) {
    super(`Storage driver "${driver}" has no local paths: use storage.withLocalCopy(key, fn) or storage.acquireLocal(key).`);
    this.name = "StorageNotLocalError";
  }
}

/** An error like the one fs gives for a missing file (callers check `code === "ENOENT"`). */
export function notFoundError(key: string): NodeJS.ErrnoException {
  const err = new Error(`Stored object not found: ${key}`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Storage keys are relative paths made of plain segments ("projects/<id>/files/<uuid>"). */
export function assertKey(key: string): void {
  if (!key || key.length > 1024 || key.startsWith("/") || key.includes("\\") || key.includes("\0"))
    throw new Error("Invalid storage key");
  for (const seg of key.split("/")) if (!seg || seg === "." || seg === "..") throw new Error("Invalid storage key");
}

/**
 * Content storage (docs/onprem/object-storage.md). Drivers: the local disk (default) and object storage
 * (S3-compatible: AWS S3, MinIO, Cloudflare R2; Google Cloud Storage natively). Keys are written once and
 * never overwritten (put makes a new key), so a cached copy never goes stale.
 */
export interface Storage {
  readonly driver: StorageDriverName;
  /** A directory on the server's disk for temporary work files (local: the storage root). */
  readonly scratchDir: string;
  put(stream: Readable, prefix: string): Promise<StoredObject>;
  putBytes(bytes: Uint8Array, prefix: string): Promise<StoredObject>;
  /** The object as a stream; with `range` only those bytes (inclusive, as HTTP ranges). */
  get(key: string, range?: ByteRange): Readable;
  size(key: string): Promise<number>;
  exists(key: string): Promise<boolean>;
  /**
   * Absolute path of the stored file (local driver only; object storage throws StorageNotLocalError).
   * @deprecated use withLocalCopy / acquireLocal, which work with every driver.
   */
  localPath(key: string): string;
  /** A local file with the object's bytes; the caller must release() it. Local driver: the real path, no copy. */
  acquireLocal(key: string): Promise<LocalCopy>;
  /** Runs fn with a local path of the object; a temporary copy is removed afterwards, also on error. */
  withLocalCopy<T>(key: string, fn: (path: string) => Promise<T>): Promise<T>;
  remove(key: string): Promise<void>;
  /** Objects under a key prefix ("projects/<id>" lists that folder). */
  list(prefix: string): AsyncIterable<StorageEntry>;
  info(): StorageInfo;
  /** Cheap reachability check for the status page. */
  ping(): Promise<StoragePing>;
  /** Startup check: the store can be written, read, listed and deleted. Throws with a clear message. */
  check(): Promise<void>;
}

/** Runs fn with a local copy of every key (in order); all copies are released afterwards. */
export async function withLocalCopies<T>(storage: Storage, keys: string[], fn: (paths: string[]) => Promise<T>): Promise<T> {
  const copies: LocalCopy[] = [];
  try {
    for (const k of keys) copies.push(await storage.acquireLocal(k));
    return await fn(copies.map((c) => c.path));
  } finally {
    await Promise.all(copies.map((c) => c.release().catch(() => {})));
  }
}

/** sha256 and size of what passes through. */
export function meter(): { stream: Transform; result: () => { size: number; sha256: string } } {
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  return { stream, result: () => ({ size, sha256: hash.digest("hex") }) };
}

export class LocalStorage implements Storage {
  readonly driver = "local" as const;
  constructor(readonly root: string) {}

  get scratchDir(): string {
    return this.root;
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(stream: Readable, prefix: string): Promise<StoredObject> {
    const key = `${prefix}/${randomUUID()}`;
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const m = meter();
    try {
      await pipeline(stream, m.stream, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { key, ...m.result() };
  }

  async putBytes(bytes: Uint8Array, prefix: string): Promise<StoredObject> {
    const { Readable } = await import("node:stream");
    return this.put(Readable.from([Buffer.from(bytes)]), prefix);
  }

  get(key: string, range?: ByteRange): Readable {
    return createReadStream(this.resolve(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async size(key: string): Promise<number> {
    return (await stat(this.resolve(key))).size;
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.resolve(key)).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  localPath(key: string): string {
    return this.resolve(key);
  }

  async acquireLocal(key: string): Promise<LocalCopy> {
    const p = this.resolve(key);
    await stat(p);
    return { path: p, release: async () => {} };
  }

  async withLocalCopy<T>(key: string, fn: (path: string) => Promise<T>): Promise<T> {
    return fn(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async *list(prefix: string): AsyncIterable<StorageEntry> {
    const clean = prefix.replace(/\/+$/, "");
    const start = clean ? this.resolve(clean) : path.resolve(this.root);
    const s = await stat(start).catch(() => null);
    if (!s) return;
    if (s.isFile()) {
      if (!start.endsWith(".part")) yield { key: clean, size: s.size };
      return;
    }
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop()!;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => (a.name < b.name ? 1 : -1));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && !e.name.endsWith(".part")) {
          const st = await stat(full).catch(() => null);
          if (st) yield { key: path.relative(this.root, full).split(path.sep).join("/"), size: st.size };
        }
      }
    }
  }

  info(): StorageInfo {
    return { driver: "local", location: this.root, cache: null };
  }

  async ping(): Promise<StoragePing> {
    const t0 = Date.now();
    try {
      await access(this.root, fsConstants.W_OK);
      return { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, fsConstants.W_OK);
  }
}
