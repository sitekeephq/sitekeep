/**
 * Object storage around the drivers: the read cache (LRU, size limit, pins, concurrent fills, checks), the
 * configuration and start-up check (bad settings and an unreachable store stop the start), the migration of
 * the local disk to a bucket (dry run, verify, resume, prune) and the bucket copies for backups.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectStorage, readAllStored } from "../../src/core/platform/object-storage.js";
import { StorageCache } from "../../src/core/platform/storage-cache.js";
import { openStorage, storageFromEnv, StorageConfigError } from "../../src/core/platform/storage-config.js";
import { migrateToObjectStorage, pruneLocal, pullObjects, pushObjects, readManifest } from "../../src/core/platform/storage-migrate.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { redactSecrets } from "../../src/core/platform/error-ring.js";
import { MemoryBackend, tryStartS3 } from "../helpers/object-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sk-objstore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KB = 1024;

function cached(maxBytes: number, maxEntry?: number) {
  const backend = new MemoryBackend();
  const cache = new StorageCache(path.join(dir, "cache"), maxBytes, maxEntry);
  const storage = new ObjectStorage(backend, { workDir: path.join(dir, "tmp"), cache });
  return { backend, cache, storage };
}

describe("read cache", () => {
  it("serves the second read from the disk and evicts the least recently used", async () => {
    const { backend, cache, storage } = cached(250 * KB, 100 * KB);
    await storage.init();
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push((await storage.putBytes(randomBytes(100 * KB), "p/previews")).key);
    // A read, then its cache fill committed.
    const read = async (k: string) => {
      await readAllStored(storage, k);
      await cache.settled(k);
    };
    await read(keys[0]!);
    await read(keys[0]!);
    expect(backend.calls.read).toBe(1);
    expect(cache.status()).toMatchObject({ entries: 1, usedBytes: 100 * KB, hits: 1, misses: 1 });
    await read(keys[1]!);
    await read(keys[0]!); // key 0 is now the most recent
    await read(keys[2]!); // over 250 KB: key 1 goes
    expect(cache.status()).toMatchObject({ entries: 2, usedBytes: 200 * KB });
    const reads = backend.calls.read;
    await read(keys[0]!);
    expect(backend.calls.read).toBe(reads);
    await read(keys[1]!);
    expect(backend.calls.read).toBe(reads + 1);
    // Ranges come from the cache when it holds the object (once the first reader's fill is committed).
    await cache.settled(keys[1]!);
    const r = Buffer.concat(await storage.get(keys[1]!, { start: 10, end: 19 }).toArray());
    expect(r).toEqual(backend.objects.get(keys[1]!)!.subarray(10, 20));
    expect(backend.calls.read).toBe(reads + 1);
  });

  it("does not cache objects over the entry limit, and ranges of uncached objects go to the bucket", async () => {
    const { backend, cache, storage } = cached(1024 * KB, 64 * KB);
    await storage.init();
    const big = await storage.putBytes(randomBytes(200 * KB), "p/files");
    await readAllStored(storage, big.key);
    await readAllStored(storage, big.key);
    expect(backend.calls.read).toBe(2);
    expect(cache.status().entries).toBe(0);
    const small = await storage.putBytes(randomBytes(10 * KB), "p/files");
    await storage.get(small.key, { start: 0, end: 9 }).toArray();
    expect(cache.status().entries).toBe(0);
  });

  it("downloads once for many concurrent readers", async () => {
    const { backend, storage } = cached(10 * 1024 * KB);
    await storage.init();
    backend.latencyMs = 30;
    const o = await storage.putBytes(randomBytes(300 * KB), "p/previews");
    const bodies = await Promise.all(Array.from({ length: 12 }, () => readAllStored(storage, o.key)));
    for (const b of bodies) expect(b.equals(backend.objects.get(o.key)!)).toBe(true);
    expect(backend.calls.read).toBe(1);
    const copies = await Promise.all(Array.from({ length: 5 }, () => storage.withLocalCopy(o.key, async (p) => readFileSync(p).length)));
    expect(copies).toEqual(Array(5).fill(300 * KB));
    expect(backend.calls.read).toBe(1);
  });

  it("never evicts an entry in use; it goes when released", async () => {
    const { cache, storage } = cached(150 * KB, 100 * KB);
    await storage.init();
    const a = await storage.putBytes(randomBytes(100 * KB), "p/x");
    const b = await storage.putBytes(randomBytes(100 * KB), "p/x");
    const held = await storage.acquireLocal(a.key);
    await readAllStored(storage, b.key); // over the limit, but a is pinned
    expect(existsSync(held.path)).toBe(true);
    expect(readFileSync(held.path).length).toBe(100 * KB);
    await held.release();
    await readAllStored(storage, b.key);
    const c = await storage.putBytes(randomBytes(10 * KB), "p/x");
    await readAllStored(storage, c.key);
    expect(cache.status().usedBytes).toBeLessThanOrEqual(150 * KB);
  });

  it("rejects a broken download and caches nothing", async () => {
    const { backend, cache, storage } = cached(1024 * KB);
    await storage.init();
    const o = await storage.putBytes(randomBytes(100 * KB), "p/x");
    backend.failReads.add(o.key);
    await expect(readAllStored(storage, o.key)).rejects.toThrow();
    expect(cache.status().entries).toBe(0);
    expect(readdirSync(path.join(dir, "cache")).flatMap((d) => readdirSync(path.join(dir, "cache", d)))).toEqual([]);
    expect((await readAllStored(storage, o.key)).length).toBe(100 * KB);
  });

  it("streams the first read while filling; a reader that goes away early leaves nothing", async () => {
    const { backend, cache, storage } = cached(10 * 1024 * KB);
    await storage.init();
    const o = await storage.putBytes(randomBytes(1024 * KB), "p/x");
    const s = storage.get(o.key);
    await new Promise<void>((resolve) => s.once("data", () => resolve()));
    s.destroy();
    await cache.settled(o.key);
    expect(cache.status().entries).toBe(0);
    const files = readdirSync(path.join(dir, "cache")).flatMap((d) => readdirSync(path.join(dir, "cache", d)));
    expect(files).toEqual([]);
    expect((await readAllStored(storage, o.key)).equals(backend.objects.get(o.key)!)).toBe(true);
    await cache.settled(o.key);
    expect(cache.status().entries).toBe(1);
  });

  it("checks size and sha256 of a fill", async () => {
    const cache = new StorageCache(path.join(dir, "c2"), 1024 * KB);
    await cache.init();
    const body = Buffer.from("hello cache");
    const { Readable } = await import("node:stream");
    await expect(cache.fill("k1", { size: body.length + 1 }, async () => Readable.from([body]))).rejects.toThrow(/size/);
    await expect(cache.fill("k2", { size: body.length, sha256: "0".repeat(64) }, async () => Readable.from([body]))).rejects.toThrow(/sha256/);
    const ok = await cache.fill("k3", { size: body.length, sha256: createHash("sha256").update(body).digest("hex") }, async () => Readable.from([body]));
    expect(readFileSync(ok!.path).toString()).toBe("hello cache");
    ok!.release();
  });

  it("keeps entries across a restart, drops unfinished fills, and forgets removed objects", async () => {
    const { storage } = cached(1024 * KB);
    await storage.init();
    const o = await storage.putBytes(randomBytes(20 * KB), "p/x");
    await readAllStored(storage, o.key);
    await storage.cache!.settled(o.key);
    const sub = readdirSync(path.join(dir, "cache"))[0]!;
    writeFileSync(path.join(dir, "cache", sub, "leftover.part"), "x");
    const again = new StorageCache(path.join(dir, "cache"), 1024 * KB);
    await again.init();
    expect(again.status()).toMatchObject({ entries: 1, usedBytes: 20 * KB });
    expect(existsSync(path.join(dir, "cache", sub, "leftover.part"))).toBe(false);
    await storage.remove(o.key);
    expect(storage.cache!.status().entries).toBe(0);
  });

  it("is off with CDE_STORAGE_CACHE_GB=0", () => {
    const s = storageFromEnv(dir, { CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_STORAGE_CACHE_GB: "0" });
    expect(s.info().cache).toBeNull();
    const on = storageFromEnv(dir, { CDE_STORAGE: "s3", CDE_S3_BUCKET: "b" });
    expect(on.info().cache).toMatchObject({ enabled: true, maxBytes: 2 * 1024 ** 3 });
  });
});

describe("configuration and start-up", () => {
  it("defaults to the local disk", () => {
    const s = storageFromEnv(dir, {});
    expect(s).toBeInstanceOf(LocalStorage);
    expect(s.info().location).toBe(path.join(dir, "storage"));
  });

  it.each([
    [{ CDE_STORAGE: "ftp" }, /expected local, s3 or gcs/],
    [{ CDE_STORAGE: "s3" }, /CDE_S3_BUCKET/],
    [{ CDE_STORAGE: "gcs" }, /CDE_GCS_BUCKET/],
    [{ CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_S3_ENDPOINT: "minio:9000" }, /not a URL|http/],
    [{ CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_S3_ENDPOINT: "http://user:pw@minio:9000" }, /must not carry credentials/],
    [{ CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_S3_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE12" }, /both/],
    [{ CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_S3_PART_SIZE_MB: "1" }, /CDE_S3_PART_SIZE_MB/],
    [{ CDE_STORAGE: "s3", CDE_S3_BUCKET: "b", CDE_S3_FORCE_PATH_STYLE: "maybe" }, /CDE_S3_FORCE_PATH_STYLE/],
  ])("refuses %o", (env, message) => {
    expect(() => storageFromEnv(dir, env)).toThrow(StorageConfigError);
    expect(() => storageFromEnv(dir, env)).toThrow(message);
  });

  it("stops the start when the bucket does not answer, without leaking the secret", async () => {
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const err = await openStorage(dir, {
      CDE_STORAGE: "s3",
      CDE_S3_BUCKET: "sitekeep",
      CDE_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      CDE_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      CDE_S3_SECRET_ACCESS_KEY: secret,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Object storage s3:\/\/sitekeep\/ is not usable \(write failed\)/);
    expect(err?.message).not.toContain(secret);
    expect(err?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
  }, 120_000);

  it("redacts object storage credentials in logged text", () => {
    const text = redactSecrets(
      "GET /b/k?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261128&X-Amz-Signature=abcdef0123456789abcdef Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261128/us-east-1/s3/aws4_request, Signature=0123456789abcdef0123456789abcdef CDE_S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI GOOG1EXAMPLEEXAMPLEEXAMPLE",
    );
    expect(text).not.toMatch(/AKIAIOSFODNN7EXAMPLE|abcdef0123456789abcdef|wJalrXUtnFEMI|GOOG1EXAMPLEEXAMPLE/);
  });
});

const s3 = await tryStartS3();
describe.skipIf(!s3)("start-up against a real S3 server", () => {
  afterAll(() => s3?.stop());

  it("opens with good settings and refuses a wrong secret", async () => {
    if (!s3) return;
    const env = {
      CDE_STORAGE: "s3",
      CDE_S3_ENDPOINT: s3.settings.endpoint!,
      CDE_S3_BUCKET: s3.settings.bucket,
      CDE_S3_ACCESS_KEY_ID: s3.settings.accessKeyId ?? "",
      CDE_S3_SECRET_ACCESS_KEY: s3.settings.secretAccessKey ?? "",
      CDE_S3_PREFIX: "startup",
    };
    const ok = await openStorage(dir, env, { server: true });
    expect(ok.info()).toMatchObject({ driver: "s3", bucket: s3.settings.bucket, prefix: "startup/" });
    if (s3.settings.secretAccessKey) {
      const wrong = "not-the-secret-0123456789";
      const err = await openStorage(dir, { ...env, CDE_S3_SECRET_ACCESS_KEY: wrong }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not usable/);
      expect((err as Error).message).not.toContain(wrong);
    }
    // (A missing bucket is not tested here: SeaweedFS creates buckets on the first write.)
  }, 120_000);
});

describe("migration of the local disk", () => {
  function setup() {
    const source = new LocalStorage(path.join(dir, "storage"));
    const backend = new MemoryBackend();
    const target = new ObjectStorage(backend, { prefix: "app", workDir: path.join(dir, "tmp") });
    const manifestPath = path.join(dir, "storage-migration.jsonl");
    return { source, backend, target, manifestPath };
  }
  async function seed(source: LocalStorage, n: number) {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) keys.push((await source.putBytes(randomBytes(1000 + i), `projects/p${i % 2}/files`)).key);
    mkdirSync(path.join(source.root, "projects/p0/files"), { recursive: true });
    writeFileSync(path.join(source.root, "projects/p0/files/unfinished.part"), "x");
    return keys;
  }

  it("dry run copies nothing; the run copies and verifies everything; a second run does nothing", async () => {
    const { source, backend, target, manifestPath } = setup();
    const keys = await seed(source, 6);
    const dry = await migrateToObjectStorage({ source, target, manifestPath, dryRun: true });
    expect(dry).toMatchObject({ files: 6, wouldCopy: 6, copied: 0, failed: [] });
    expect(backend.objects.size).toBe(0);
    expect(existsSync(manifestPath)).toBe(false);

    const run = await migrateToObjectStorage({ source, target, manifestPath });
    expect(run).toMatchObject({ files: 6, copied: 6, failed: [] });
    for (const k of keys) expect(backend.objects.get(`app/${k}`)).toEqual(readFileSync(source.localPath(k)));
    expect((await readManifest(manifestPath)).size).toBe(6);
    // Local files stay.
    for (const k of keys) expect(existsSync(source.localPath(k))).toBe(true);

    const reads = backend.calls.read;
    const again = await migrateToObjectStorage({ source, target, manifestPath });
    expect(again).toMatchObject({ copied: 0, alreadyThere: 6 });
    expect(backend.calls.read).toBe(reads);
  });

  it("resumes: copies only what is missing, verifies what was copied before the manifest", async () => {
    const { source, backend, target, manifestPath } = setup();
    const keys = await seed(source, 5);
    // An earlier run copied key 0 and died before writing the manifest; key 1 is recorded.
    await target.putAt(keys[0]!, (await import("node:fs")).createReadStream(source.localPath(keys[0]!)));
    await migrateToObjectStorage({ source: new LocalStorage(source.root), target, manifestPath });
    backend.objects.delete(`app/${keys[2]}`); // lost in the bucket since
    const puts = backend.calls.putSmall;
    const r = await migrateToObjectStorage({ source, target, manifestPath });
    expect(r).toMatchObject({ copied: 1, alreadyThere: 4, failed: [] });
    expect(backend.calls.putSmall).toBe(puts + 1);
  });

  it("reports a different object already in the bucket and keeps going", async () => {
    const { source, backend, target, manifestPath } = setup();
    const keys = await seed(source, 3);
    const local = readFileSync(source.localPath(keys[1]!));
    backend.objects.set(`app/${keys[1]}`, Buffer.alloc(local.length, 0)); // same size, other bytes
    const r = await migrateToObjectStorage({ source, target, manifestPath });
    expect(r.copied).toBe(2);
    expect(r.failed).toEqual([{ key: keys[1], error: expect.stringMatching(/differs/) }]);
    expect((await readManifest(manifestPath)).has(keys[1]!)).toBe(false);
  });

  it("prune-local removes only verified files the bucket still has", async () => {
    const { source, backend, target, manifestPath } = setup();
    const keys = await seed(source, 4);
    await migrateToObjectStorage({ source, target, manifestPath });
    const late = (await source.putBytes(Buffer.from("written after the migration"), "projects/p0/files")).key;
    backend.objects.delete(`app/${keys[3]}`);
    const dry = await pruneLocal({ source, target, manifestPath, dryRun: true });
    expect(dry).toMatchObject({ removed: 3, kept: 1, notInManifest: 1 });
    for (const k of keys) expect(existsSync(source.localPath(k))).toBe(true);
    await pruneLocal({ source, target, manifestPath });
    expect(keys.map((k) => existsSync(source.localPath(k)))).toEqual([false, false, false, true]);
    expect(existsSync(source.localPath(late))).toBe(true);
  });

  it("pull copies the bucket for a backup (hard links to the previous one) and push restores it", async () => {
    const { source, backend, target, manifestPath } = setup();
    const keys = await seed(source, 4);
    await migrateToObjectStorage({ source, target, manifestPath });
    const b1 = path.join(dir, "backup1");
    expect(await pullObjects({ target, dir: b1 })).toMatchObject({ objects: 4, downloaded: 4, failed: 0 });
    const b2 = path.join(dir, "backup2");
    const reads = backend.calls.read;
    expect(await pullObjects({ target, dir: b2, linkDest: b1 })).toMatchObject({ linked: 4, downloaded: 0 });
    expect(backend.calls.read).toBe(reads);
    for (const k of keys) expect(readFileSync(path.join(b2, k))).toEqual(readFileSync(source.localPath(k)));
    backend.objects.clear();
    expect(await pushObjects({ target, dir: b2 })).toMatchObject({ files: 4, uploaded: 4, failed: 0 });
    for (const k of keys) expect(backend.objects.get(`app/${k}`)).toEqual(readFileSync(source.localPath(k)));
  });
});
