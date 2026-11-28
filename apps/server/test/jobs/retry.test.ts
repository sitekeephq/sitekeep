import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { jobs } from "../../src/db/schema.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { JOB_RETRY_BACKOFF_MS } from "../../src/jobs/errors.js";

let dataDir: string;
let handle: DbHandle;
let queue: JobQueue;
let runs: number;
let failWith: () => unknown;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-retry-"));
  handle = await openDb("memory://");
  queue = new JobQueue(handle.db, new LocalStorage(path.join(dataDir, "storage")));
  // autodesk_sync is a repeatable kind, project_import is not.
  for (const kind of ["autodesk_sync", "project_import"])
    queue.register(kind, failing);
});
const failing = async (job: { payload: Record<string, unknown> }) => {
  runs++;
  throw job.payload.permanent ? new Error("Invalid IFC file") : failWith();
};
afterAll(async () => {
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  runs = 0;
  await handle.db.delete(jobs);
});

const row = async (id: string) => (await handle.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const net = () => new TypeError("fetch failed");

describe("automatic retry", () => {
  it("queues a transient failure again with a backoff, and does not run it before then", async () => {
    failWith = net;
    const id = await queue.enqueue("autodesk_sync", { connectionId: "c" });
    const before = Date.now();
    await queue.drain();
    const r = await row(id);
    expect(runs).toBe(1);
    expect(r.status).toBe("queued");
    expect(r.attempts).toBe(1);
    expect(r.error).toBe("fetch failed");
    expect(r.finishedAt).toBeNull();
    expect(r.runAfter!.getTime()).toBeGreaterThanOrEqual(before + JOB_RETRY_BACKOFF_MS[0]! - 50);
    await queue.drain(); // still waiting
    expect(runs).toBe(1);
  });

  it("stops after 3 runs and then fails for good, with 5 minutes before the last", async () => {
    failWith = net;
    const id = await queue.enqueue("autodesk_sync", { connectionId: "c" });
    await queue.drain();
    for (const wait of [JOB_RETRY_BACKOFF_MS[1]!]) {
      await handle.db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
      const t0 = Date.now();
      await queue.drain();
      expect((await row(id)).runAfter!.getTime()).toBeGreaterThanOrEqual(t0 + wait - 50);
    }
    await handle.db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    await queue.drain();
    const r = await row(id);
    expect(runs).toBe(3);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(3);
    expect(r.finishedAt).not.toBeNull();
  });

  it("a retry that succeeds ends done", async () => {
    let n = 0;
    failWith = net;
    queue.register("autodesk_sync", async () => {
      runs++;
      if (++n === 1) throw net();
    });
    const id = await queue.enqueue("autodesk_sync", { connectionId: "c" });
    await queue.drain();
    await handle.db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    await queue.drain();
    expect((await row(id)).status).toBe("done");
    expect(runs).toBe(2);
    queue.register("autodesk_sync", failing);
  });

  it("fails a permanent error at once, and never retries a kind that is not repeatable", async () => {
    failWith = net;
    const a = await queue.enqueue("autodesk_sync", { permanent: true });
    const b = await queue.enqueue("project_import", {});
    await queue.drain();
    expect(await row(a)).toMatchObject({ status: "failed", attempts: 1, error: "Invalid IFC file" });
    expect(await row(b)).toMatchObject({ status: "failed", attempts: 1 });
    expect(runs).toBe(2);
  });

  it("survives a restart: a waiting retry stays waiting, a job that was running is queued again", async () => {
    failWith = net;
    const waiting = await queue.enqueue("autodesk_sync", {});
    await queue.drain();
    const [crashed] = await handle.db.insert(jobs).values({ kind: "autodesk_sync", payload: {}, status: "running", attempts: 1 }).returning();
    const fresh = new JobQueue(handle.db, new LocalStorage(path.join(dataDir, "storage")));
    await fresh.start(); // queues it again, then runs it (the handler of `queue` is not registered on `fresh`: unknown kind)
    fresh.stop();
    const w = await row(waiting);
    expect(w.status).toBe("queued");
    expect(w.runAfter!.getTime()).toBeGreaterThan(Date.now());
    // It was claimed again (attempts 2) after being queued again.
    expect((await row(crashed!.id)).attempts).toBe(2);
  });

  it("requeueFailed makes a failed job new (attempts reset), and only a failed one", async () => {
    failWith = () => new Error("bad");
    const id = await queue.enqueue("autodesk_sync", {});
    await queue.drain();
    expect(await queue.requeueFailed(id)).toBe(true);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, error: null, finishedAt: null });
    expect(await queue.requeueFailed(id)).toBe(false);
  });
});
