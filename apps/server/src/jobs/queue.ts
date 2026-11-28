import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { splitExtension, type IfcSummary } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, jobs } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { saveVersionIndex } from "./version-index.js";
import { converterVersion, modelFormatFor } from "../files/model-formats.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import { formatJobError, retryDecision } from "./errors.js";

/** Job errors are stored and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);
const errorTexts = { ifcReader: t("jobs:queue.ifcReaderError"), unknown: t("jobs:queue.unknownError") };

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
 *   1 = CIRCLE_SEGMENTS setting (48), 2 = consistent winding of closed meshes, 3 = colours for unstyled elements (ifc-worker.ts).
 */
export const GEOMETRY_REVISION = 3;

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
        this.opts.log?.(`index listener for ${versionId} failed`, formatJobError(err, errorTexts).detail);
      }
    }
  }

  /** Queues a job and returns its id. */
  async enqueue(kind: string, payload: Record<string, unknown>): Promise<string> {
    const [row] = await this.db.insert(jobs).values({ kind, payload }).returning({ id: jobs.id });
    if (!this.stopped) setImmediate(() => void this.tick());
    return row!.id;
  }

  /** Puts a failed job back in the queue as new (the administrators' "Retry"). False when it is not failed (any more). */
  async requeueFailed(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "queued", attempts: 0, error: null, startedAt: null, finishedAt: null, runAfter: null })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "failed")))
      .returning({ id: jobs.id });
    if (rows.length && !this.stopped) setImmediate(() => void this.tick());
    return rows.length > 0;
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
      // A job waiting for its retry (runAfter) is skipped until then.
      .where(and(eq(jobs.status, "queued"), or(isNull(jobs.runAfter), lte(jobs.runAfter, new Date()))))
      // Jobs queued in bulk at start-up (payload.background: model backfill and reconversion after a
      // converter update) wait while anything a person started is queued: a new upload does not sit
      // behind hundreds of reconversions (#158). Within each group, oldest first.
      .orderBy(sql`coalesce((${jobs.payload}->>'background')::boolean, false)`, asc(jobs.createdAt))
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
      // The job keeps a readable message; the technical detail goes to the server log.
      const { message, detail } = formatJobError(err, errorTexts);
      const decision = retryDecision(job.kind, claimed[0]!.attempts, err);
      if (decision.retry) {
        // A transient failure (network, 429/502/503/504): queued again after the backoff, the error stays visible meanwhile.
        this.opts.log?.(`job ${job.kind} ${job.id} failed (attempt ${claimed[0]!.attempts}), retrying in ${Math.round(decision.delayMs / 1000)} s`, detail);
        await this.db
          .update(jobs)
          .set({ status: "queued", error: message, runAfter: new Date(Date.now() + decision.delayMs) })
          .where(eq(jobs.id, job.id));
      } else {
        this.opts.log?.(`job ${job.kind} ${job.id} failed`, detail);
        await this.db
          .update(jobs)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(jobs.id, job.id));
      }
    }
    return true;
  }

  /**
   * IFC → Fragments. `upgrade: true` rebuilds a ready derivative (new tessellation) without taking
   * the model offline: the old file is served until the new one replaces it, and stays when the
   * rebuild fails. Only the geometry changes, so the element index and its listeners are left alone.
   *
   * `reconvert: true` (a model a module converts, e.g. .rvt) converts the stored file again instead of
   * reading the kept IFC (a new converter version, "Convert again"): in place like `upgrade` when the version
   * has a model, and the element index is rebuilt too, since the elements may differ.
   */
  private async ifcToFrag(job: JobRow): Promise<void> {
    const versionId = String(job.payload.versionId);
    const reconvert = job.payload.reconvert === true;
    const upgrade = job.payload.upgrade === true || reconvert;
    const [row] = await this.db
      .select({ v: fileVersions, projectId: files.projectId, name: files.name })
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
    let input: IfcInput | null = null;
    try {
      input = await this.ifcInput(row.v, row.name, { fresh: reconvert });
      const withIndex = !inPlace || reconvert;
      const { summary, index } = await runIfcWorker(
        input.path,
        tmp,
        this.opts.timeoutMs,
        withIndex ? tmpIndex : undefined,
        circleSegments,
      );
      const stored = await this.storage.put(createReadStream(tmp), `projects/${row.projectId}/derivatives`);
      // A freshly converted model keeps its IFC (download, later rebuilds read it instead of converting).
      const keptIfc = input.converted ? (await this.storage.put(createReadStream(input.path), `projects/${row.projectId}/derivatives`)).key : null;
      let indexed: { ok: boolean; error?: string } = { ok: false, error: t("jobs:queue.indexNotCreated") };
      if (index && "elementCount" in index) {
        await saveVersionIndex(this.db, this.storage, versionId, row.projectId, tmpIndex, index.elementCount);
        indexed = { ok: true };
      } else if (index) {
        this.opts.log?.(`comparison index of ${versionId} failed`, index.error);
        indexed = { ok: false, error: formatJobError(index.error, errorTexts).message };
      }
      // Keeps what only later steps add to the summary (the BCF scene offset of the same import).
      const keep = inPlace && row.v.ifcSummary?.sceneOffset ? { sceneOffset: row.v.ifcSummary.sceneOffset } : {};
      await this.db
        .update(fileVersions)
        .set({
          derivativeStatus: "ready",
          derivativeKey: stored.key,
          ifcSummary: { ...summary, ...keep, geometry: { circleSegments, revision: GEOMETRY_REVISION }, ...(input.source && { source: input.source }) },
          ...(keptIfc && { ifcKey: keptIfc, converter: input.source?.tool ?? row.v.converter }),
        })
        .where(eq(fileVersions.id, versionId));
      if (inPlace && row.v.derivativeKey && row.v.derivativeKey !== stored.key) await this.dropDerivative(row.v.derivativeKey, versionId);
      if (keptIfc && row.v.ifcKey && row.v.ifcKey !== keptIfc) await this.dropDerivative(row.v.ifcKey, versionId);
      if (withIndex) await this.indexed(versionId, indexed.ok, indexed.error);
    } catch (err) {
      const { message } = formatJobError(err, errorTexts);
      // A conversion by a module records the converter it failed with: retried once per converter version.
      const converter = await converterVersion(modelFormatFor(row.name));
      if (retryDecision(job.kind, job.attempts, err).retry) {
        // Run again after the backoff (runNext): the version stays "processing" and the index listeners wait for the final result.
      } else if (!inPlace) {
        await this.db
          .update(fileVersions)
          .set({ derivativeStatus: "failed", derivativeError: message.slice(0, 1000), ...(converter && { converter }) })
          .where(eq(fileVersions.id, versionId));
        await this.indexed(versionId, false, message);
      } else if (converter && reconvert) {
        // The model built before stays; the new converter is not tried again on its own.
        await this.db.update(fileVersions).set({ converter }).where(eq(fileVersions.id, versionId));
      }
      throw err;
    } finally {
      await input?.cleanup();
      await rm(tmp, { force: true });
      await rm(tmpIndex, { force: true });
    }
  }

  /**
   * The IFC file of a version: the stored file itself, or for a format a module converts (Connect: Revit
   * .rvt, files/model-formats.ts) the IFC kept from its last conversion, else (or with `fresh`) a temporary
   * IFC the module writes, removed by `cleanup`.
   */
  private async ifcInput(v: typeof fileVersions.$inferSelect, fileName: string, opts: { fresh?: boolean } = {}): Promise<IfcInput> {
    // Local disk: the stored file itself; object storage: a temporary copy, removed by cleanup.
    const ext = splitExtension(fileName).extension.toLowerCase();
    if (ext === "ifc") {
      const copy = await this.storage.acquireLocal(v.storageKey);
      return { path: copy.path, cleanup: () => copy.release() };
    }
    if (v.ifcKey && !opts.fresh && (await this.storage.exists(v.ifcKey).catch(() => false))) {
      const copy = await this.storage.acquireLocal(v.ifcKey);
      return { path: copy.path, source: v.ifcSummary?.source, cleanup: () => copy.release() };
    }
    const format = modelFormatFor(fileName);
    if (!format) throw new Error(t("jobs:queue.noModelConverter", { ext: ext || fileName }));
    const out = path.join(os.tmpdir(), `7dcde-${randomUUID()}.ifc`);
    const cleanup = async () => {
      await rm(out, { force: true });
    };
    try {
      const source = await this.storage.withLocalCopy(v.storageKey, (stored) =>
        format.toIfc(stored, out, { timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS }),
      );
      return { path: out, source, converted: true, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  /**
   * Removes a replaced derivative unless another version still points at it (a finished review
   * gives its output version the source version's derivative).
   */
  private async dropDerivative(key: string, versionId: string): Promise<void> {
    const [shared] = await this.db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(or(eq(fileVersions.derivativeKey, key), eq(fileVersions.ifcKey, key)))
      .limit(1);
    if (shared) return;
    await this.storage.remove(key).catch((err: unknown) => this.opts.log?.(`old derivative of ${versionId} not removed`, err));
  }

  /** Builds only the comparison index of an IFC version (backfill for older versions). */
  private async ifcIndex(job: JobRow): Promise<void> {
    const versionId = String(job.payload.versionId);
    const [row] = await this.db
      .select({ v: fileVersions, projectId: files.projectId, name: files.name })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(eq(fileVersions.id, versionId));
    if (!row) throw new Error(`Version ${versionId} not found`);
    const tmpIndex = path.join(os.tmpdir(), `7dcde-${randomUUID()}.index.json`);
    let input: IfcInput | null = null;
    try {
      input = await this.ifcInput(row.v, row.name);
      const { index } = await runIfcWorker(input.path, null, this.opts.timeoutMs, tmpIndex);
      if (!index || "error" in index) throw new Error(index?.error ?? t("jobs:queue.indexFailed"));
      await saveVersionIndex(this.db, this.storage, versionId, row.projectId, tmpIndex, index.elementCount);
      await this.indexed(versionId, true);
    } finally {
      await input?.cleanup();
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

/** The IFC a job reads: the stored file or a converted temporary one (JobQueue.ifcInput). */
interface IfcInput {
  path: string;
  /** Set when a module converted the file from another format. */
  source?: IfcSummary["source"];
  /** Converted by this job (not the kept IFC): worth keeping. */
  converted?: boolean;
  cleanup(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;

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
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
