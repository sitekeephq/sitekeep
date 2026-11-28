/**
 * Object stores for the storage tests (test/platform/storage-*.test.ts):
 *
 *   S3: an existing S3-compatible server from TEST_S3_ENDPOINT (+ TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID,
 *       TEST_S3_SECRET_ACCESS_KEY, TEST_S3_REGION), else a throwaway container started with Docker
 *       (TEST_S3_IMAGE, default chrislusf/seaweedfs: MinIO no longer publishes community images). The
 *       container and its volume are removed afterwards. Without Docker (or TEST_S3=0) the S3 tests skip.
 *   GCS: a real bucket only when TEST_GCS_BUCKET names one the Application Default Credentials can write;
 *       everything goes under a fresh prefix ci-test/<random>/ that is deleted afterwards. Without it, the GCS
 *       driver runs against fake-gcs-server in Docker (TEST_GCS_EMULATOR=0 skips that).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Backend, type S3Settings } from "../../src/core/platform/storage-s3.js";
import { GcsBackend } from "../../src/core/platform/storage-gcs.js";
import { Storage as GcsClient } from "@google-cloud/storage";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import type { ObjectBackend } from "../../src/core/platform/object-storage.js";
import { notFoundError, type ByteRange } from "../../src/core/platform/storage.js";

export interface S3TestServer {
  settings: S3Settings;
  stop(): void;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** True when an S3 server can be had (env or Docker); decided once, before the suites are declared. */
export const s3TestAvailable = process.env.TEST_S3 !== "0" && (!!process.env.TEST_S3_ENDPOINT || dockerAvailable());

export const gcsEmulatorAvailable = process.env.TEST_GCS_EMULATOR !== "0" && dockerAvailable();

/** fake-gcs-server (the JSON API with resumable uploads) in a throwaway container; removed by stop(). */
export async function startFakeGcs(): Promise<{ backend: GcsBackend; stop(): void }> {
  const port = await freePort();
  const name = `sitekeep-gcs-test-${randomBytes(4).toString("hex")}`;
  const url = `http://127.0.0.1:${port}`;
  execFileSync(
    "docker",
    ["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:4443`, process.env.TEST_GCS_IMAGE || "fsouza/fake-gcs-server:latest", "-scheme", "http", "-port", "4443", "-external-url", url, "-public-host", `127.0.0.1:${port}`],
    { stdio: "pipe" },
  );
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "pipe" });
    } catch {
      // already gone
    }
  };
  // The emulator ignores credentials; a fixed token keeps the library from looking for real ones.
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: "emulator", expiry_date: Date.now() + 24 * 3600_000 });
  const authClient = new GoogleAuth({ authClient: oauth, projectId: "sitekeep-test" });
  const client = new GcsClient({ apiEndpoint: url, projectId: "sitekeep-test", authClient });
  try {
    const until = Date.now() + 60_000;
    for (;;) {
      try {
        await client.createBucket("sitekeep-test");
        break;
      } catch (err) {
        if ((err as { code?: number }).code === 409) break;
        if (Date.now() > until) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    stop();
    throw err;
  }
  return { backend: new GcsBackend({ bucket: "sitekeep-test" }, client), stop };
}

export const gcsTestBucket = process.env.TEST_GCS_BUCKET?.replace(/^gs:\/\//, "").replace(/\/+$/, "") || null;

const base = (s: Partial<S3Settings>): S3Settings => ({
  region: "us-east-1",
  bucket: "sitekeep-test",
  forcePathStyle: true,
  partSize: 5 * 1024 * 1024,
  concurrency: 3,
  ...s,
});

export async function startS3(): Promise<S3TestServer> {
  if (process.env.TEST_S3_ENDPOINT) {
    const settings = base({
      endpoint: process.env.TEST_S3_ENDPOINT,
      region: process.env.TEST_S3_REGION || "us-east-1",
      bucket: process.env.TEST_S3_BUCKET || "sitekeep-test",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY,
    });
    await ensureBucket(settings);
    return { settings, stop: () => {} };
  }
  const accessKeyId = `sk${randomBytes(6).toString("hex")}`;
  const secretAccessKey = randomBytes(18).toString("hex");
  const confDir = mkdtempSync(path.join(os.tmpdir(), "sk-s3-"));
  writeFileSync(
    path.join(confDir, "s3.json"),
    JSON.stringify({ identities: [{ name: "sitekeep", credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] }),
  );
  const port = await freePort();
  const name = `sitekeep-s3-test-${randomBytes(4).toString("hex")}`;
  const image = process.env.TEST_S3_IMAGE || "chrislusf/seaweedfs:latest";
  execFileSync(
    "docker",
    ["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:8333`, "-v", `${confDir}:/etc/sk:ro`, image, "server", "-s3", "-s3.config=/etc/sk/s3.json", "-dir=/data"],
    { stdio: "pipe" },
  );
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "pipe" });
    } catch {
      // already gone
    }
    rmSync(confDir, { recursive: true, force: true });
  };
  const settings = base({ endpoint: `http://127.0.0.1:${port}`, accessKeyId, secretAccessKey });
  try {
    const until = Date.now() + 120_000;
    for (;;) {
      try {
        await ensureBucket(settings);
        break;
      } catch (err) {
        if (Date.now() > until) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    let logs = "";
    try {
      logs = execFileSync("docker", ["logs", "--tail", "30", name], { stdio: "pipe" }).toString();
    } catch {
      // no logs
    }
    stop();
    throw new Error(`S3 test server did not start: ${(err as Error).message}\n${logs}`);
  }
  return { settings, stop };
}

/**
 * The S3 test server, or null (with a warning) when it cannot be had: no Docker, TEST_S3=0, or the container
 * did not come up. The S3 suites then skip instead of failing on the machine's environment.
 */
export async function tryStartS3(): Promise<S3TestServer | null> {
  if (!s3TestAvailable) return null;
  try {
    return await startS3();
  } catch (err) {
    console.warn(`S3 storage tests skipped: ${(err as Error).message}`);
    return null;
  }
}

async function ensureBucket(s: S3Settings): Promise<void> {
  const c = new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: true,
    ...(s.accessKeyId && { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey! } }),
  });
  try {
    await c.send(new CreateBucketCommand({ Bucket: s.bucket }));
  } catch (err) {
    const n = (err as { name?: string }).name;
    if (n !== "BucketAlreadyOwnedByYou" && n !== "BucketAlreadyExists") throw err;
  } finally {
    c.destroy();
  }
}

export function s3Backend(settings: S3Settings): S3Backend {
  return new S3Backend(settings);
}

/** A GCS backend on the test bucket and a fresh prefix; `cleanup` deletes everything under it. */
export function gcsTarget(): { backend: GcsBackend; prefix: string; cleanup(): Promise<void> } {
  const backend = new GcsBackend({ bucket: gcsTestBucket! });
  const prefix = `ci-test/${randomBytes(6).toString("hex")}`;
  return {
    backend,
    prefix,
    async cleanup() {
      const names: string[] = [];
      for await (const o of backend.list(`${prefix}/`)) names.push(o.name);
      for (const n of names) if (n.startsWith(`${prefix}/`)) await backend.delete(n);
    },
  };
}

/** An in-memory bucket with counters (fast tests of ObjectStorage, the cache and the migration). */
export class MemoryBackend implements ObjectBackend {
  readonly kind = "s3" as const;
  readonly bucket = "memory";
  readonly objects = new Map<string, Buffer>();
  readonly calls = { putSmall: 0, putStream: 0, read: 0, head: 0, delete: 0, list: 0 };
  /** Delay of every read before its first byte (ms). */
  latencyMs = 0;
  /** Names whose next read fails (simulates a broken download). */
  failReads = new Set<string>();

  async putSmall(name: string, body: Buffer) {
    this.calls.putSmall++;
    this.objects.set(name, Buffer.from(body));
  }
  async putStream(name: string, body: Readable) {
    this.calls.putStream++;
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    this.objects.set(name, Buffer.concat(chunks));
  }
  async read(name: string, range?: ByteRange): Promise<Readable> {
    this.calls.read++;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const b = this.objects.get(name);
    if (!b) throw notFoundError(name);
    if (this.failReads.delete(name)) {
      return new Readable({
        read() {
          this.push(b.subarray(0, Math.floor(b.length / 2)));
          this.destroy(new Error("connection reset"));
        },
      });
    }
    const part = range ? b.subarray(range.start, range.end + 1) : b;
    // Several chunks, like a network response.
    const chunks: Buffer[] = [];
    for (let i = 0; i < part.length; i += 64 * 1024) chunks.push(part.subarray(i, i + 64 * 1024));
    return Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]);
  }
  async head(name: string) {
    this.calls.head++;
    const b = this.objects.get(name);
    return b ? { size: b.length } : null;
  }
  async delete(name: string) {
    this.calls.delete++;
    this.objects.delete(name);
  }
  async *list(prefix: string) {
    this.calls.list++;
    for (const [name, b] of [...this.objects].sort(([a], [c]) => (a < c ? -1 : 1))) if (name.startsWith(prefix)) yield { name, size: b.length };
  }
  async ping() {}
  describeError(err: unknown) {
    return (err as Error)?.message ?? String(err);
  }
}
