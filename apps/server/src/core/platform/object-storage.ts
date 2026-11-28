import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageCache } from "./storage-cache.js";
import {
  assertKey,
  meter,
  notFoundError,
  StorageNotLocalError,
  type ByteRange,
  type LocalCopy,
  type Storage,
  type StorageDriverName,
  type StorageEntry,
  type StorageInfo,
  type StoragePing,
  type StoredObject,
} from "./storage.js";

/**
 * One bucket API (S3-compatible or Google Cloud Storage). Names are full object names (prefix included).
 * `read` resolves once the response started, and rejects with code ENOENT for a missing object.
 */
export interface ObjectBackend {
  readonly kind: Exclude<StorageDriverName, "local">;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region?: string;
  /** One request, for objects up to the part size. */
  putSmall(name: string, body: Buffer): Promise<void>;
  /** Streaming upload of an object of unknown size (multipart / resumable); aborts what it started on error. */
  putStream(name: string, body: Readable): Promise<void>;
  read(name: string, range?: ByteRange): Promise<Readable>;
  head(name: string): Promise<{ size: number } | null>;
  delete(name: string): Promise<void>;
  list(prefix: string): AsyncIterable<{ name: string; size: number }>;
  /** Cheapest authenticated request (list with one result). */
  ping(): Promise<void>;
  /** Removes credentials and signatures from an error message. */
  describeError(err: unknown): string;
}

export interface ObjectStorageOptions {
  prefix?: string;
  /** Directory for temporary local copies (DATA_DIR/tmp/storage); emptied at start. */
  workDir: string;
  cache?: StorageCache | null;
  /** Objects up to this size are uploaded in one request; larger ones stream in parts (default 16 MiB). */
  partSize?: number;
}

/** Storage on a bucket: streaming uploads, ranged reads, local copies for workers, optional read cache. */
export class ObjectStorage implements Storage {
  readonly driver: Exclude<StorageDriverName, "local">;
  readonly prefix: string;
  readonly scratchDir: string;
  readonly cache: StorageCache | null;
  private readonly partSize: number;
  /** Keys a reader is opening for the cache (others wait instead of downloading too). */
  private readonly opening = new Map<string, Promise<void>>();

  constructor(
    readonly backend: ObjectBackend,
    opts: ObjectStorageOptions,
  ) {
    this.driver = backend.kind;
    const p = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (p) assertKey(p);
    this.prefix = p ? `${p}/` : "";
    this.scratchDir = opts.workDir;
    this.cache = opts.cache ?? null;
    this.partSize = opts.partSize ?? 16 * 1024 * 1024;
  }

  /**
   * Loads the cache; the server (clearScratch) also empties the temporary copies an earlier run left.
   * A command line tool next to the running server must not clear them.
   */
  async init(opts: { clearScratch?: boolean } = {}): Promise<void> {
    if (opts.clearScratch) {
      await rm(this.scratchDir, { recursive: true, force: true });
      await mkdir(this.scratchDir, { recursive: true });
    }
    await this.cache?.init();
  }

  private name(key: string): string {
    assertKey(key);
    return this.prefix + key;
  }

  async put(stream: Readable, prefix: string): Promise<StoredObject> {
    return this.putAt(`${prefix}/${randomUUID()}`, stream);
  }

  /** Writes the object under this exact key (the migration keeps the local keys). */
  async putAt(key: string, stream: Readable): Promise<StoredObject> {
    const name = this.name(key);
    const hash = createHash("sha256");
    let size = 0;
    const src = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
    const take = async (): Promise<Buffer | null> => {
      const r = await src.next();
      if (r.done) return null;
      const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
      hash.update(b);
      size += b.length;
      return b;
    };
    try {
      const head: Buffer[] = [];
      let headBytes = 0;
      let ended = false;
      while (headBytes < this.partSize) {
        const b = await take();
        if (!b) {
          ended = true;
          break;
        }
        head.push(b);
        headBytes += b.length;
      }
      if (ended) await this.backend.putSmall(name, Buffer.concat(head));
      else {
        async function* rest() {
          yield* head;
          for (let b = await take(); b; b = await take()) yield b;
        }
        await this.backend.putStream(name, Readable.from(rest(), { objectMode: false }));
      }
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return { key, size, sha256: hash.digest("hex") };
  }

  async putBytes(bytes: Uint8Array, prefix: string): Promise<StoredObject> {
    return this.put(Readable.from([Buffer.from(bytes)]), prefix);
  }

  get(key: string, range?: ByteRange): Readable {
    assertKey(key);
    const out = new PassThrough();
    this.open(key, range).then(
      (src) => {
        if (out.destroyed) {
          src.destroy();
          return;
        }
        pipeline(src, out).catch(() => {});
      },
      (err: unknown) => out.destroy(err as Error),
    );
    return out;
  }

  /** From the cache when it holds the object; a whole small object is cached first; else the bucket. */
  private async open(key: string, range?: ByteRange): Promise<Readable> {
    const name = this.name(key);
    const fromCache = (h: { path: string; release(): void }) => {
      const s = createReadStream(h.path, range ? { start: range.start, end: range.end } : undefined);
      s.once("close", () => h.release());
      return s;
    };
    if (this.cache) {
      const hit = this.cache.acquire(key);
      if (hit) return fromCache(hit);
      if (!range) {
        // Another reader is opening or filling it: wait, then read the local copy.
        const opening = this.opening.get(key);
        if (opening || this.cache.busy(key)) {
          await opening;
          await this.cache.settled(key);
          const again = this.cache.acquire(key, { count: false });
          if (again) {
            this.cache.countWaitedHit();
            return fromCache(again);
          }
        }
        let opened!: () => void;
        this.opening.set(key, new Promise<void>((r) => (opened = r)));
        try {
          const meta = await this.backend.head(name);
          if (!meta) throw notFoundError(key);
          // The first reader gets the bytes as they arrive while they are written to the cache.
          if (this.cache.fits(meta.size)) return this.cache.tee(key, meta, await this.backend.read(name));
        } finally {
          this.opening.delete(key);
          opened();
        }
      }
    }
    return this.backend.read(name, range);
  }

  async size(key: string): Promise<number> {
    const meta = await this.backend.head(this.name(key));
    if (!meta) throw notFoundError(key);
    return meta.size;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.backend.head(this.name(key))) !== null;
  }

  localPath(): string {
    throw new StorageNotLocalError(this.driver);
  }

  async acquireLocal(key: string): Promise<LocalCopy> {
    const name = this.name(key);
    if (this.cache) {
      let h = this.cache.acquire(key);
      if (!h) {
        const meta = await this.backend.head(name);
        if (!meta) throw notFoundError(key);
        if (this.cache.fits(meta.size)) h = await this.cache.fill(key, meta, () => this.backend.read(name));
      }
      if (h) {
        const handle = h;
        return { path: handle.path, release: async () => handle.release() };
      }
    }
    const dir = path.join(this.scratchDir, randomUUID());
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, key.split("/").pop()!);
    try {
      await pipeline(await this.backend.read(name), createWriteStream(file));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    let released = false;
    return {
      path: file,
      release: async () => {
        if (released) return;
        released = true;
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  async withLocalCopy<T>(key: string, fn: (path: string) => Promise<T>): Promise<T> {
    const copy = await this.acquireLocal(key);
    try {
      return await fn(copy.path);
    } finally {
      await copy.release();
    }
  }

  async remove(key: string): Promise<void> {
    this.cache?.drop(key);
    await this.backend.delete(this.name(key));
  }

  async *list(prefix: string): AsyncIterable<StorageEntry> {
    const clean = prefix.replace(/^\/+|\/+$/g, "");
    if (clean) assertKey(clean);
    for await (const o of this.backend.list(this.prefix + (clean ? `${clean}/` : ""))) {
      const key = o.name.slice(this.prefix.length);
      if (key) yield { key, size: o.size };
    }
  }

  info(): StorageInfo {
    const scheme = this.driver === "gcs" ? "gs" : "s3";
    return {
      driver: this.driver,
      location: `${scheme}://${this.backend.bucket}/${this.prefix}`,
      bucket: this.backend.bucket,
      prefix: this.prefix,
      ...(this.backend.endpoint && { endpoint: this.backend.endpoint }),
      ...(this.backend.region && { region: this.backend.region }),
      cache: this.cache?.status() ?? null,
    };
  }

  async ping(): Promise<StoragePing> {
    const t0 = Date.now();
    try {
      await this.backend.ping();
      return { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: this.backend.describeError(err) };
    }
  }

  /** Writes, reads, lists and deletes one probe object under `<prefix>.sitekeep-probe/`. */
  async check(): Promise<void> {
    const where = this.info().location;
    const probe = `${this.prefix}.sitekeep-probe/${randomUUID()}`;
    const body = Buffer.from(`sitekeep storage probe ${new Date().toISOString()}`);
    let step = "write";
    try {
      await this.backend.putSmall(probe, body);
      step = "read";
      const chunks: Buffer[] = [];
      for await (const c of await this.backend.read(probe)) chunks.push(c as Buffer);
      if (!Buffer.concat(chunks).equals(body)) throw new Error("read back different bytes");
      step = "list";
      for await (const _ of this.backend.list(this.prefix)) break;
      step = "delete";
      await this.backend.delete(probe);
    } catch (err) {
      throw new Error(`Object storage ${where} is not usable (${step} failed): ${this.backend.describeError(err)}`);
    }
  }
}

/** Reads a whole stored object (small files only). */
export async function readAllStored(storage: Storage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of storage.get(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** sha256 and size of a stored object, by reading it. */
export async function hashStored(storage: Storage, key: string): Promise<{ size: number; sha256: string }> {
  const m = meter();
  m.stream.resume();
  await pipeline(storage.get(key), m.stream);
  return m.result();
}
