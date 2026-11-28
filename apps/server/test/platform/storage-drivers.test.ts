/**
 * Every storage driver through the same interface (docs/onprem/object-storage.md): local disk, S3 (a
 * throwaway S3 server in Docker, or TEST_S3_ENDPOINT; skipped without either), Google Cloud Storage (only
 * with TEST_GCS_BUCKET, under a fresh ci-test/<random>/ prefix), and the object driver on an in-memory bucket.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectStorage, readAllStored } from "../../src/core/platform/object-storage.js";
import { StorageCache } from "../../src/core/platform/storage-cache.js";
import { LocalStorage, StorageNotLocalError, withLocalCopies, type Storage } from "../../src/core/platform/storage.js";
import { gcsEmulatorAvailable, gcsTarget, gcsTestBucket, MemoryBackend, startFakeGcs, s3Backend, tryStartS3 } from "../helpers/object-store.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A stream of `size` pseudo-random bytes made on the fly (never held in memory as a whole). */
function bigStream(size: number, seed = 7): { stream: Readable; sha256: Promise<string> } {
  const h = createHash("sha256");
  let left = size;
  let n = seed;
  let resolve!: (s: string) => void;
  const sha256 = new Promise<string>((r) => (resolve = r));
  const stream = new Readable({
    read() {
      if (left === 0) {
        resolve(h.digest("hex"));
        this.push(null);
        return;
      }
      const len = Math.min(left, 256 * 1024);
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i += 4) b.writeUInt32LE((n = (n * 1103515245 + 12345) >>> 0), Math.min(i, len - 4));
      h.update(b);
      left -= len;
      this.push(b);
    },
  });
  return { stream, sha256 };
}

async function hashOf(s: Readable): Promise<{ size: number; sha256: string }> {
  const h = createHash("sha256");
  let size = 0;
  for await (const c of s) {
    h.update(c as Buffer);
    size += (c as Buffer).length;
  }
  return { size, sha256: h.digest("hex") };
}

interface Driver {
  storage: Storage;
  scratch: string;
  cleanup(): Promise<void>;
}

function suite(name: string, enabled: boolean, make: () => Promise<Driver>) {
  describe.skipIf(!enabled)(`storage driver: ${name}`, () => {
    let d: Driver;
    beforeAll(async () => {
      d = await make();
    }, 120_000);
    afterAll(async () => {
      await d?.cleanup();
    }, 120_000);

    it("passes the start-up check and answers ping", async () => {
      await d.storage.check();
      expect((await d.storage.ping()).ok).toBe(true);
      expect(d.storage.info().driver).toBe(d.storage.driver);
    });

    it("stores bytes and a stream, with size and sha256", async () => {
      const bytes = Buffer.from("Zemin etüdü – rapor v1");
      const a = await d.storage.putBytes(bytes, "projects/p1/files");
      expect(a).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
      expect(a.key).toMatch(/^projects\/p1\/files\/[0-9a-f-]{36}$/);
      expect(await readAllStored(d.storage, a.key)).toEqual(bytes);
      expect(await d.storage.size(a.key)).toBe(bytes.length);
      expect(await d.storage.exists(a.key)).toBe(true);
      const empty = await d.storage.putBytes(new Uint8Array(0), "projects/p1/files");
      expect(empty.size).toBe(0);
      expect((await readAllStored(d.storage, empty.key)).length).toBe(0);
    });

    it("reads byte ranges (start, middle, last byte, whole)", async () => {
      const bytes = randomBytes(300_000);
      const o = await d.storage.putBytes(bytes, "projects/p1/files");
      const range = async (start: number, end: number) => {
        const chunks: Buffer[] = [];
        for await (const c of d.storage.get(o.key, { start, end })) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
      };
      expect(await range(0, 9)).toEqual(bytes.subarray(0, 10));
      expect(await range(123_456, 200_000)).toEqual(bytes.subarray(123_456, 200_001));
      expect(await range(bytes.length - 1, bytes.length - 1)).toEqual(bytes.subarray(-1));
      expect(await range(0, bytes.length - 1)).toEqual(bytes);
    });

    it("uploads a large stream in parts and reads it back unchanged", async () => {
      const size = 23 * 1024 * 1024 + 12_345;
      const src = bigStream(size);
      const o = await d.storage.put(src.stream, "projects/p1/files");
      const expected = await src.sha256;
      expect(o).toMatchObject({ size, sha256: expected });
      expect(await d.storage.size(o.key)).toBe(size);
      expect(await hashOf(d.storage.get(o.key))).toEqual({ size, sha256: expected });
      // A range across a part boundary (parts are 5 MiB on the test S3).
      const chunks: Buffer[] = [];
      for await (const c of d.storage.get(o.key, { start: 5 * 1024 * 1024 - 10, end: 5 * 1024 * 1024 + 9 })) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).length).toBe(20);
      await d.storage.remove(o.key);
    }, 180_000);

    it("a failing upload stream leaves no object behind", async () => {
      const before: string[] = [];
      for await (const e of d.storage.list("projects/broken")) before.push(e.key);
      let sent = 0;
      const failing = new Readable({
        read() {
          if (sent > 12 * 1024 * 1024) return this.destroy(new Error("client went away"));
          sent += 1024 * 1024;
          this.push(Buffer.alloc(1024 * 1024, 1));
        },
      });
      await expect(d.storage.put(failing, "projects/broken")).rejects.toThrow();
      const after: string[] = [];
      for await (const e of d.storage.list("projects/broken")) after.push(e.key);
      expect(after).toEqual(before);
    }, 120_000);

    it("missing objects: ENOENT on read, size and local copy; remove is quiet", async () => {
      const key = "projects/p1/files/00000000-0000-0000-0000-000000000000";
      expect(await d.storage.exists(key)).toBe(false);
      await expect(d.storage.size(key)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readAllStored(d.storage, key)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(d.storage.acquireLocal(key)).rejects.toMatchObject({ code: "ENOENT" });
      await d.storage.remove(key);
      expect(() => d.storage.get("../etc/passwd")).toThrow(/Invalid storage key/);
    });

    it("lists by prefix", async () => {
      const a = await d.storage.putBytes(Buffer.from("a"), "projects/list-x/files");
      const b = await d.storage.putBytes(Buffer.from("bb"), "projects/list-x/previews");
      await d.storage.putBytes(Buffer.from("c"), "projects/list-y/files");
      const got: Record<string, number> = {};
      for await (const e of d.storage.list("projects/list-x")) got[e.key] = e.size;
      expect(got).toEqual({ [a.key]: 1, [b.key]: 2 });
    });

    it("gives workers a local path and cleans temporary copies up, also on error", async () => {
      const bytes = randomBytes(50_000);
      const o = await d.storage.putBytes(bytes, "projects/p1/files");
      let seen = "";
      const n = await d.storage.withLocalCopy(o.key, async (p) => {
        seen = p;
        expect(readFileSync(p)).toEqual(bytes);
        return 42;
      });
      expect(n).toBe(42);
      let failedAt = "";
      await expect(
        d.storage.withLocalCopy(o.key, async (p) => {
          failedAt = p;
          throw new Error("worker crashed");
        }),
      ).rejects.toThrow("worker crashed");
      if (d.storage.driver === "local") {
        // The stored file itself: no copy, nothing removed.
        expect(seen).toBe(d.storage.localPath(o.key));
        expect(existsSync(failedAt)).toBe(true);
      } else if (d.storage.info().cache) {
        // A cached object is handed out from the cache (pinned while in use); no temporary copy.
        expect(seen).toBe(failedAt);
        expect(seen.startsWith(path.dirname(d.scratch))).toBe(true);
        expect(readdirSync(d.scratch)).toEqual([]);
      } else {
        expect(() => d.storage.localPath(o.key)).toThrow(StorageNotLocalError);
        expect(existsSync(seen)).toBe(false);
        expect(existsSync(failedAt)).toBe(false);
        expect(readdirSync(d.scratch)).toEqual([]);
      }
      const two = await d.storage.putBytes(Buffer.from("zwei"), "projects/p1/files");
      await withLocalCopies(d.storage, [o.key, two.key], async ([p1, p2]) => {
        expect(readFileSync(p2!).toString()).toBe("zwei");
        expect(readFileSync(p1!).length).toBe(50_000);
      });
      if (d.storage.driver !== "local") expect(readdirSync(d.scratch)).toEqual([]);
    });

    it("removes objects", async () => {
      const o = await d.storage.putBytes(Buffer.from("weg"), "projects/p1/files");
      await d.storage.remove(o.key);
      expect(await d.storage.exists(o.key)).toBe(false);
    });
  });
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "sk-storage-"));

suite("local", true, async () => {
  const dir = tmp();
  return { storage: new LocalStorage(path.join(dir, "storage")), scratch: dir, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

suite("object storage on an in-memory bucket", true, async () => {
  const dir = tmp();
  const s = new ObjectStorage(new MemoryBackend(), { workDir: path.join(dir, "tmp"), partSize: 5 * 1024 * 1024 });
  await s.init({ clearScratch: true });
  return { storage: s, scratch: path.join(dir, "tmp"), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

const s3 = await tryStartS3();
suite("s3 (S3-compatible server)", !!s3, async () => {
  if (!s3) throw new Error("no S3 server");
  const dir = tmp();
  const s = new ObjectStorage(s3Backend(s3.settings), { prefix: `t-${randomBytes(4).toString("hex")}`, workDir: path.join(dir, "tmp"), partSize: s3.settings.partSize });
  await s.init({ clearScratch: true });
  return {
    storage: s,
    scratch: path.join(dir, "tmp"),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

suite("s3 with the read cache", !!s3, async () => {
  if (!s3) throw new Error("no S3 server");
  const dir = tmp();
  const cache = new StorageCache(path.join(dir, "cache"), 64 * 1024 * 1024);
  const s = new ObjectStorage(s3Backend(s3.settings), {
    prefix: `c-${randomBytes(4).toString("hex")}`,
    workDir: path.join(dir, "tmp"),
    partSize: s3.settings.partSize,
    cache,
  });
  await s.init({ clearScratch: true });
  return { storage: s, scratch: path.join(dir, "tmp"), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

let fakeGcs: Awaited<ReturnType<typeof startFakeGcs>> | null = null;
suite("gcs (fake-gcs-server)", gcsEmulatorAvailable, async () => {
  fakeGcs = await startFakeGcs();
  const dir = tmp();
  const s = new ObjectStorage(fakeGcs.backend, { prefix: "app", workDir: path.join(dir, "tmp") });
  await s.init({ clearScratch: true });
  return { storage: s, scratch: path.join(dir, "tmp"), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

suite("gcs (TEST_GCS_BUCKET)", !!gcsTestBucket, async () => {
  const dir = tmp();
  const t = gcsTarget();
  const s = new ObjectStorage(t.backend, { prefix: t.prefix, workDir: path.join(dir, "tmp") });
  await s.init({ clearScratch: true });
  return {
    storage: s,
    scratch: path.join(dir, "tmp"),
    cleanup: async () => {
      await t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

afterAll(() => {
  s3?.stop();
  fakeGcs?.stop();
});
