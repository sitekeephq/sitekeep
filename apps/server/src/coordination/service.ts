/**
 * Model coordination services: model set resolution, clash and IDS jobs (worker threads run
 * through the JobQueue), result persistence with stable clash ids, and the statistics summary.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  splitExtension,
  type IdsSpecResult,
  type ModelSetItem,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import {
  fileVersions,
  files,
  idsReports,
} from "../db/schema.js";
import { wasmDir, type JobQueue, type JobRow } from "../jobs/queue.js";
import type { Storage } from "../core/platform/storage.js";
import { IdsParseError, parseIds } from "./ids.js";
import { DEFAULT_LANGUAGE, render, tFor } from "../i18n/index.js";

/** Job errors are stored with the run (text column): written in the installation's language. */
const tStored = tFor(DEFAULT_LANGUAGE);

type FileRow = typeof files.$inferSelect;

type VersionRow = typeof fileVersions.$inferSelect;

export function isIfc(name: string) {
  return splitExtension(name).extension.toLowerCase() === "ifc";
}

export interface ResolvedItem {
  item: ModelSetItem;
  file: FileRow | null;
  version: VersionRow | null;
}

/** Files and versions a model set points to now (latest or pinned). */
export async function resolveItems(db: Db, projectId: string, items: ModelSetItem[]): Promise<ResolvedItem[]> {
  const ids = [...new Set(items.map((i) => i.fileId))];
  const fileRows = ids.length
    ? await db
        .select()
        .from(files)
        .where(and(inArray(files.id, ids), eq(files.projectId, projectId), isNull(files.deletedAt)))
    : [];
  const versionRows = ids.length ? await db.select().from(fileVersions).where(inArray(fileVersions.fileId, ids)) : [];
  return items.map((item) => {
    const file = fileRows.find((f) => f.id === item.fileId) ?? null;
    const version = file
      ? (versionRows.find((v) =>
          item.versionId ? v.id === item.versionId && v.fileId === file.id : v.fileId === file.id && v.version === file.currentVersion,
        ) ?? null)
      : null;
    return { item, file, version };
  });
}

/** A worker file of apps/server/src/jobs (src or dist, same extension as the caller). */
export function workerFile(name: string): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "..", "jobs", `${name}${path.extname(here)}`);
}

/** Runs a worker of apps/server/src/jobs (by file name) with a time limit; modules use it through the SDK. */
export function runWorker<T>(name: string, data: unknown, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile(name), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new Error(timeoutMessage)));
    }, timeoutMs + 5000);
    worker.on("message", (msg: { type: string; message?: string }) => {
      if (msg.type === "done") finish(() => resolve(msg as T));
      else if (msg.type === "error") finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(tStored("coordination:jobs.workerExit", { code })))));
  });
}

const MAX_FAILURES = 500;

async function readText(storage: Storage, key: string, max = 20 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of storage.get(key)) {
    size += (c as Buffer).length;
    if (size > max) throw new Error(tStored("coordination:jobs.idsTooLarge"));
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runIdsJob(db: Db, storage: Storage, job: JobRow) {
  const reportId = String(job.payload.reportId);
  const [report] = await db.select().from(idsReports).where(eq(idsReports.id, reportId));
  if (!report) throw new Error(tStored("coordination:jobs.idsReportNotFound", { id: reportId }));
  await db.update(idsReports).set({ status: "running", error: null }).where(eq(idsReports.id, reportId));
  try {
    const [idsV] = await db.select().from(fileVersions).where(eq(fileVersions.id, report.idsVersionId));
    const [ifcV] = await db.select().from(fileVersions).where(eq(fileVersions.id, report.ifcVersionId));
    if (!idsV || !ifcV) throw new Error(tStored("coordination:errors.versionNotFound"));
    let doc;
    try {
      doc = parseIds(await readText(storage, idsV.storageKey));
    } catch (e) {
      if (e instanceof IdsParseError) throw new Error(tStored("coordination:jobs.idsUnreadable", { detail: render(DEFAULT_LANGUAGE, e.msg) }));
      throw e;
    }
    const timeoutMs = envNumber("IDS_TIMEOUT_MS", 15 * 60_000);
    const res = await runWorker<{ schema: string; elementsChecked: number; results: IdsSpecResult[] }>(
      "ids-worker",
      { wasmDir: wasmDir(), path: storage.localPath(ifcV.storageKey), specs: doc.specs, maxFailures: MAX_FAILURES },
      timeoutMs,
      tStored("coordination:jobs.idsTimeout"),
    );
    const totals = {
      specs: res.results.length,
      passed: res.results.filter((r) => r.status === "pass").length,
      failed: res.results.filter((r) => r.status === "fail").length,
      skipped: res.results.filter((r) => r.status === "skipped").length,
      elementsChecked: res.elementsChecked,
    };
    await db
      .update(idsReports)
      .set({ status: "done", title: doc.title, specs: res.results, totals, finishedAt: new Date() })
      .where(eq(idsReports.id, reportId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(idsReports)
      .set({ status: "failed", error: message.slice(0, 1000), finishedAt: new Date() })
      .where(eq(idsReports.id, reportId));
    throw err;
  }
}

export function registerIdsJob(db: Db, storage: Storage, queue: JobQueue) {
  queue.register("ids_check", (job) => runIdsJob(db, storage, job));
}

/** A positive number from the environment, else the fallback. */
export function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
