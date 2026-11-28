import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { meter, type StorageCacheStatus } from "./storage.js";

interface Entry {
  size: number;
  pins: number;
}

export interface CacheHandle {
  path: string;
  size: number;
  release(): void;
}

/**
 * Bounded read cache of object storage on the server's disk (CDE_STORAGE_CACHE_GB): hot files (viewer
 * fragments, previews, PDFs, worker inputs) are read from disk instead of the bucket. Least recently used
 * entries go first; an entry in use (pinned) is never removed. Objects are immutable (a key is written
 * once), so an entry is valid until the object is removed. A fill is verified against the object's size
 * (and sha256 when the store knows it) before it is used; concurrent fills of one key share one download.
 */
export class StorageCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private used = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    readonly dir: string,
    readonly maxBytes: number,
    readonly maxEntryBytes = Math.min(Math.floor(maxBytes / 8), 512 * 1024 ** 2),
  ) {}

  /** Loads what an earlier run left (oldest first by mtime), drops unfinished fills, trims to the limit. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const found: { id: string; size: number; mtime: number }[] = [];
    for (const sub of await readdir(this.dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const subDir = path.join(this.dir, sub.name);
      for (const f of await readdir(subDir)) {
        const full = path.join(subDir, f);
        if (!/^[0-9a-f]{40}$/.test(f)) {
          await rm(full, { force: true, recursive: true });
          continue;
        }
        const s = await stat(full).catch(() => null);
        if (s?.isFile()) found.push({ id: f, size: s.size, mtime: s.mtimeMs });
      }
    }
    found.sort((a, b) => a.mtime - b.mtime);
    for (const f of found) {
      this.entries.set(f.id, { size: f.size, pins: 0 });
      this.used += f.size;
    }
    this.evict();
  }

  static id(key: string): string {
    return createHash("sha1").update(key).digest("hex");
  }

  private file(id: string): string {
    return path.join(this.dir, id.slice(0, 2), id);
  }

  fits(size: number): boolean {
    return size <= this.maxEntryBytes && size <= this.maxBytes;
  }

  /** A pinned hit (most recently used now) or null. */
  acquire(key: string, opts: { count?: boolean } = {}): CacheHandle | null {
    const id = StorageCache.id(key);
    const e = this.entries.get(id);
    const count = opts.count !== false;
    if (!e) {
      if (count) this.misses++;
      return null;
    }
    if (count) this.hits++;
    this.entries.delete(id);
    this.entries.set(id, e);
    e.pins++;
    const file = this.file(id);
    const now = new Date();
    utimes(file, now, now).catch(() => {});
    let released = false;
    return {
      path: file,
      size: e.size,
      release: () => {
        if (released) return;
        released = true;
        e.pins--;
        if (e.pins === 0 && !this.entries.has(id)) rm(file, { force: true }).catch(() => {});
        else if (e.pins === 0) this.evict();
      },
    };
  }

  /**
   * Downloads the object into the cache (once, however many callers ask at the same time) and returns a
   * pinned handle; null when it did not stay (all space pinned) so the caller reads the store directly.
   */
  async fill(key: string, expected: { size: number; sha256?: string }, open: () => Promise<Readable>): Promise<CacheHandle | null> {
    const id = StorageCache.id(key);
    if (!this.entries.has(id)) {
      let p = this.inflight.get(id);
      if (!p) {
        p = this.download(id, expected, open).finally(() => this.inflight.delete(id));
        this.inflight.set(id, p);
      }
      await p;
    }
    const e = this.entries.get(id);
    if (!e) return null;
    return this.acquire(key, { count: false });
  }

  /** A reader counted as a miss got the file after waiting for another reader's fill. */
  countWaitedHit(): void {
    this.misses--;
    this.hits++;
  }

  busy(key: string): boolean {
    return this.inflight.has(StorageCache.id(key));
  }

  /** A fill of this key is running (a reader may wait for it instead of downloading again). */
  async settled(key: string): Promise<void> {
    await this.inflight.get(StorageCache.id(key))?.catch(() => {});
  }

  /**
   * Streams `body` to the caller and into the cache at the same time (the first reader does not wait for the
   * whole download). The entry is kept only when the whole object arrived with the expected size; a reader
   * that goes away early, or a broken download, leaves nothing behind.
   */
  tee(key: string, expected: { size: number; sha256?: string }, body: Readable): Readable {
    const id = StorageCache.id(key);
    const out = new PassThrough();
    if (this.inflight.has(id) || this.entries.has(id)) {
      body.pipe(out);
      body.once("error", (e) => out.destroy(e));
      return out;
    }
    const file = this.file(id);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `${id}.${randomUUID()}.part`);
    const ws = createWriteStream(tmp);
    const hash = createHash("sha256");
    let size = 0;
    let done = false;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    }).finally(() => this.inflight.delete(id));
    p.catch(() => {});
    this.inflight.set(id, p);
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      body.destroy();
      ws.destroy();
      // The unfinished file goes before the reader hears of the error.
      rm(tmp, { force: true }).finally(() => {
        if (!out.destroyed) out.destroy(err);
        reject(err);
      });
    };
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
      const a = ws.write(chunk);
      const b = out.write(chunk);
      if (a && b) return;
      body.pause();
      let waiting = (a ? 0 : 1) + (b ? 0 : 1);
      const go = () => {
        if (--waiting === 0) body.resume();
      };
      if (!a) ws.once("drain", go);
      if (!b) out.once("drain", go);
    });
    body.once("end", () => {
      out.end();
      ws.end();
    });
    body.once("error", fail);
    ws.once("error", fail);
    out.once("close", () => {
      if (!out.writableFinished) fail(new Error("reader went away"));
    });
    ws.once("finish", () => {
      if (done) return;
      const sha = hash.digest("hex");
      if (size !== expected.size || (expected.sha256 && sha !== expected.sha256)) return fail(new Error(`cache fill: size ${size} != ${expected.size} or sha256 mismatch`));
      rename(tmp, file).then(
        () => {
          done = true;
          const old = this.entries.get(id);
          if (old) this.used -= old.size;
          this.entries.set(id, { size, pins: 0 });
          this.used += size;
          this.evict(id);
          resolve();
        },
        (e: Error) => fail(e),
      );
    });
    return out;
  }

  private async download(id: string, expected: { size: number; sha256?: string }, open: () => Promise<Readable>): Promise<void> {
    const file = this.file(id);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `${id}.${randomUUID()}.part`);
    const m = meter();
    try {
      await pipeline(await open(), m.stream, createWriteStream(tmp));
      const got = m.result();
      if (got.size !== expected.size) throw new Error(`cache fill: size ${got.size} != ${expected.size}`);
      if (expected.sha256 && got.sha256 !== expected.sha256) throw new Error("cache fill: sha256 mismatch");
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const old = this.entries.get(id);
    if (old) this.used -= old.size;
    this.entries.set(id, { size: expected.size, pins: 0 });
    this.used += expected.size;
    this.evict(id);
  }

  /** Removes least recently used, unpinned entries until the cache is under its limit. */
  private evict(keep?: string): void {
    if (this.used <= this.maxBytes) return;
    for (const [id, e] of this.entries) {
      if (this.used <= this.maxBytes) break;
      if (e.pins > 0 || id === keep) continue;
      this.entries.delete(id);
      this.used -= e.size;
      rm(this.file(id), { force: true }).catch(() => {});
    }
  }

  /** The object was removed: its entry goes (a reader holding it keeps its open file). */
  drop(key: string): void {
    const id = StorageCache.id(key);
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.used -= e.size;
    if (e.pins === 0) rm(this.file(id), { force: true }).catch(() => {});
  }

  status(): StorageCacheStatus {
    return { enabled: true, maxBytes: this.maxBytes, usedBytes: this.used, entries: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
