import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { IfcSummary } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, jobs } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { saveVersionIndex } from "./version-index.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Job errors are stored and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (job: JobRow) => Promise<void>;
type Handler = JobHandler;
/**
 * Called after an IFC version's element index was written (ok) or could not be built (not ok), by
 * any path: upload, WOPI, AEC Pilot, developer upload, index backfill.
 */
export type IndexListener = (versionId: string, ok: boolean, error?: string) => Promise<void>;

/**
 * Straight pieces per full circle in viewer derivatives (web-ifc CIRCLE_SEGMENTS). web-ifc's 12
 * drew round eaves as polygons whose flat sides sank up to 4 % of the radius inside the true
 * circle, so pre-faceted members behind them showed through. 48 keeps that under 0,25 %
 * (≈ 9 mm at r = 4 m); curved elements get ~4× the triangles. CDE_IFC_CIRCLE_SEGMENTS overrides.
 */
export const DEFAULT_CIRCLE_SEGMENTS = 48;

/**
 * Version of the conversion itself, for fixes that need old derivatives rebuilt:
 *   1 = CIRCLE_SEGMENTS setting (48), 2 = consistent winding of closed meshes (ifc-worker.ts).
 */
export const GEOMETRY_REVISION = 2;

/** Revision a derivative was built with (missing = 1, or older when circleSegments is missing too). */
export function derivativeRevision(summary: IfcSummary | null | undefined): number {
  return summary?.geometry?.revision ?? (summary?.geometry ? 1 : 0);
}

/** Segments a derivative was built with (missing = before the setting existed, web-ifc's 12). */
export function derivativeCircleSegments(summary: IfcSummary | null | undefined): number {
  return summary?.geometry?.circleSegments ?? 12;
}

export interface JobQueueOptions {
  pollMs?: number;
  /** Max time for one IFC conversion. */
  timeoutMs?: number;
  /** web-ifc CIRCLE_SEGMENTS for viewer derivatives (default DEFAULT_CIRCLE_SEGMENTS). */
  circleSegments?: number;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * A small database-backed job queue (one job at a time). Jobs survive restarts: anything
 * left "running" after a crash is queued again on start.
 */
export class JobQueue {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  private readonly handlers = new Map<string, Handler>();
  private readonly indexListeners: IndexListener[] = [];

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly opts: JobQueueOptions = {},
  ) {
    this.handlers.set("ifc_to_frag", (job) => this.ifcToFrag(job));
    this.handlers.set("ifc_index", (job) => this.ifcIndex(job));
  }

  /** Curve tessellation new derivatives are built with. */
  get circleSegments(): number {
    return this.opts.circleSegments ?? DEFAULT_CIRCLE_SEGMENTS;
  }

  /** Called after a version's element index was saved (e.g. 4D link rules follow new versions). */
  onIndexSaved(fn: (versionId: string) => Promise<void>): void {
    this.onIndexed(async (versionId, ok) => {
      if (ok) await fn(versionId);
    });
  }

  /** Adds a job kind (feature modules register their handlers, e.g. "clash_test"). */
  register(kind: string, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  /** Runs after every element index (e.g. parameter change re-checks). Errors are logged, never fail the job. */
  onIndexed(listener: IndexListener): void {
    this.indexListeners.push(listener);
  }

  private async indexed(versionId: string, ok: boolean, error?: string): Promise<void> {
    for (const fn of this.indexListeners) {
      try {
        await fn(versionId, ok, error);
      } catch (err) {
        this.opts.log?.(`index listener for ${versionId} failed`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Queues a job and returns its id. */
  async enqueue(kind: string, payload: Record<string, unknown>): Promise<string> {
    const [row] = await this.db.insert(jobs).values({ kind, payload }).returning({ id: jobs.id });
    if (!this.stopped) setImmediate(() => void this.tick());
    return row!.id;
  }

  async start(): Promise<void> {
    await this.db.update(jobs).set({ status: "queued" }).where(eq(jobs.status, "running"));
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 2000);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs queued jobs until none are left (used by tests and the CLI). */
  async drain(): Promise<void> {
    while (await this.runNext()) {
      /* keep going */
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && (await this.runNext())) {
        /* keep going */
      }
    } finally {
      this.busy = false;
    }
  }

  private async runNext(): Promise<boolean> {
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .orderBy(asc(jobs.createdAt))
      .limit(1);
    if (!job) return false;
    const claimed = await this.db
      .update(jobs)
      .set({ status: "running", startedAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
      .returning();
    if (!claimed.length) return true;
    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`Unknown job kind ${job.kind}`);
      await handler(claimed[0]!);
      await this.db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`job ${job.kind} ${job.id} failed`, message);
      await this.db
        .update(jobs)
        .set({ status: "failed", error: message, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
    }
    return true;
  }

  /**
   * IFC → Fragments. `upgrade: true` rebuilds a ready derivative (new tessellation) without taking
   * the model offline: the old file is served until the new one replaces it, and stays when the
   * rebuild fails. Only the geometry changes, so the element index and its listeners are left alone.
   */
  private async ifcToFrag(job: JobRow): Promise<void> {
    const versionId = String(job.payload.versionId);
    const upgrade = job.payload.upgrade === true;
    const [row] = await this.db
      .select({ v: fileVersions, projectId: files.projectId })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(eq(fileVersions.id, versionId));
    if (!row) throw new Error(`Version ${versionId} not found`);
    const inPlace = upgrade && row.v.derivativeStatus === "ready" && !!row.v.derivativeKey;
    if (!inPlace) {
      await this.db
        .update(fileVersions)
        .set({ derivativeStatus: "processing", derivativeError: null })
        .where(eq(fileVersions.id, versionId));
    }
    const tmp = path.join(os.tmpdir(), `7dcde-${randomUUID()}.frag`);
    // The comparison index is written next to the fragments output.
    const tmpIndex = `${tmp}.index.json`;
    const circleSegments = this.circleSegments;
    try {
      const { summary, index } = await runIfcWorker(
        this.storage.localPath(row.v.storageKey),
        tmp,
        this.opts.timeoutMs,
        inPlace ? undefined : tmpIndex,
        circleSegments,
      );
      const stored = await this.storage.put(createReadStream(tmp), `projects/${row.projectId}/derivatives`);
      let indexed: { ok: boolean; error?: string } = { ok: false, error: t("jobs:queue.indexNotCreated") };
      if (index && "elementCount" in index) {
        await saveVersionIndex(this.db, this.storage, versionId, row.projectId, tmpIndex, index.elementCount);
        indexed = { ok: true };
      } else if (index) {
        this.opts.log?.(`comparison index of ${versionId} failed`, index.error);
        indexed = { ok: false, error: index.error };
      }
      // Keeps what only later steps add to the summary (the BCF scene offset of the same import).
      const keep = inPlace && row.v.ifcSummary?.sceneOffset ? { sceneOffset: row.v.ifcSummary.sceneOffset } : {};
      await this.db
        .update(fileVersions)
        .set({ derivativeStatus: "ready", derivativeKey: stored.key, ifcSummary: { ...summary, ...keep, geometry: { circleSegments, revision: GEOMETRY_REVISION } } })
        .where(eq(fileVersions.id, versionId));
      if (inPlace && row.v.derivativeKey && row.v.derivativeKey !== stored.key) await this.dropDerivative(row.v.derivativeKey, versionId);
      if (!inPlace) await this.indexed(versionId, indexed.ok, indexed.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!inPlace) {
        await this.db
          .update(fileVersions)
          .set({ derivativeStatus: "failed", derivativeError: message.slice(0, 1000) })
          .where(eq(fileVersions.id, versionId));
        await this.indexed(versionId, false, message);
      }
      throw err;
    } finally {
      await rm(tmp, { force: true });
      await rm(tmpIndex, { force: true });
    }
  }

  /**
   * Removes a replaced derivative unless another version still points at it (a finished review
   * gives its output version the source version's derivative).
   */
  private async dropDerivative(key: string, versionId: string): Promise<void> {
    const [shared] = await this.db.select({ id: fileVersions.id }).from(fileVersions).where(eq(fileVersions.derivativeKey, key)).limit(1);
    if (shared) return;
    await this.storage.remove(key).catch((err: unknown) => this.opts.log?.(`old derivative of ${versionId} not removed`, err));
  }

  /** Builds only the comparison index of an IFC version (backfill for older versions). */
  private async ifcIndex(job: JobRow): Promise<void> {
    const versionId = String(job.payload.versionId);
    const [row] = await this.db
      .select({ v: fileVersions, projectId: files.projectId })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(eq(fileVersions.id, versionId));
    if (!row) throw new Error(`Version ${versionId} not found`);
    const tmpIndex = path.join(os.tmpdir(), `7dcde-${randomUUID()}.index.json`);
    try {
      const { index } = await runIfcWorker(this.storage.localPath(row.v.storageKey), null, this.opts.timeoutMs, tmpIndex);
      if (!index || "error" in index) throw new Error(index?.error ?? t("jobs:queue.indexFailed"));
      await saveVersionIndex(this.db, this.storage, versionId, row.projectId, tmpIndex, index.elementCount);
      await this.indexed(versionId, true);
    } finally {
      await rm(tmpIndex, { force: true });
    }
  }
}

const require = createRequire(import.meta.url);

export function wasmDir(): string {
  return path.dirname(require.resolve("web-ifc")) + path.sep;
}

function workerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `ifc-worker${path.extname(here)}`);
}

export interface IfcWorkerResult {
  summary: IfcSummary;
  /** Present when an index path was given. */
  index: { elementCount: number } | { error: string } | null;
}

/**
 * Runs the IFC worker: summary always, Fragments conversion when `outputPath` is set and the
 * comparison element index when `indexPath` is set.
 */
export function runIfcWorker(
  inputPath: string,
  outputPath: string | null,
  timeoutMs = 60 * 60_000,
  indexPath?: string,
  circleSegments = DEFAULT_CIRCLE_SEGMENTS,
): Promise<IfcWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath(), {
      workerData: { inputPath, outputPath: outputPath ?? undefined, indexPath, wasmDir: wasmDir(), circleSegments },
      resourceLimits: { maxOldGenerationSizeMb: 8192 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(t("jobs:queue.ifcTimeout")));
    }, timeoutMs);
    worker.on("message", (msg: { type: string; summary?: IfcSummary; index?: IfcWorkerResult["index"]; message?: string }) => {
      if (msg.type === "done") {
        clearTimeout(timer);
        resolve({ summary: msg.summary!, index: msg.index ?? null });
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(t("jobs:queue.ifcExit", { code })));
    });
  });
}
