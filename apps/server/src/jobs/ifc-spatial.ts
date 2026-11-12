/** Job "ifc_locations": builds / updates location nodes from an IFC version's spatial structure. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { and, eq, isNotNull, max } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { fileVersions, files, jobs, locations } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import type { JobQueue } from "./queue.js";
import type { SpatialNode } from "./ifc-spatial-worker.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Job errors are stored and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export const IFC_LOCATIONS_JOB = "ifc_locations";

export interface IfcLocationsPayload {
  projectId: string;
  versionId: string;
  parentId: string | null;
  userId: string;
  result?: { created: number; updated: number; total: number };
}

const TYPE_TR: Record<string, string> = {
  IfcSite: "Saha",
  IfcBuilding: "Bina",
  IfcBuildingStorey: "Kat",
  IfcSpace: "Mahal",
  IfcFacility: "Tesis",
  IfcRailway: "Tesis",
  IfcRoad: "Tesis",
  IfcBridge: "Tesis",
  IfcMarineFacility: "Tesis",
  IfcTunnel: "Tesis",
  IfcFacilityPart: "Kesim",
  IfcRailwayPart: "Kesim",
  IfcRoadPart: "Kesim",
  IfcBridgePart: "Kesim",
  IfcMarinePart: "Kesim",
  IfcTunnelPart: "Tünel Kesimi", // i18n-ok: location type name stored as project data
};

const CLASS_TR: Record<string, string> = {
  IfcSite: "Saha",
  IfcBuilding: "Bina",
  IfcBuildingStorey: "Kat",
  IfcSpace: "Mahal",
};

export function nodeName(n: SpatialNode): string {
  if (n.ifcClass === "IfcSpace" && n.name && n.longName && n.name !== n.longName) return `${n.name} - ${n.longName}`;
  return n.longName && !n.name ? n.longName : n.name ?? n.longName ?? CLASS_TR[n.ifcClass] ?? n.ifcClass;
}

/** Registers the "ifc_locations" job kind on the queue (called by the location routes). */
export function registerLocationJobs(db: Db, storage: Storage, queue: JobQueue) {
  queue.register(IFC_LOCATIONS_JOB, (job) => runIfcLocationsJob(db, storage, job));
}

export async function runIfcLocationsJob(db: Db, storage: Storage, job: typeof jobs.$inferSelect): Promise<void> {
  const p = job.payload as unknown as IfcLocationsPayload;
  const [row] = await db
    .select({ v: fileVersions, projectId: files.projectId })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(fileVersions.id, p.versionId));
  if (!row || row.projectId !== p.projectId) throw new Error(t("jobs:spatial.versionNotFound"));
  const nodes = await runSpatialWorker(storage.localPath(row.v.storageKey));

  const existing = await db
    .select()
    .from(locations)
    .where(and(eq(locations.projectId, p.projectId), isNotNull(locations.ifcGlobalId)));
  const byGuid = new Map(existing.map((l) => [l.ifcGlobalId!, l]));
  const idByGuid = new Map<string, string>();
  let created = 0;
  let updated = 0;
  // Storeys are ordered by elevation; everything else keeps the file order.
  const order = new Map<SpatialNode, number>();
  nodes.forEach((n, i) => order.set(n, n.elevation !== null && n.ifcClass === "IfcBuildingStorey" ? Math.round(n.elevation * 1000) : i));
  await db.transaction(async (tx) => {
    const [m] = await tx.select({ n: max(locations.sortOrder) }).from(locations).where(eq(locations.projectId, p.projectId));
    const base = (m?.n ?? 0) + 1;
    for (const n of nodes) {
      const name = nodeName(n).slice(0, 200);
      const old = byGuid.get(n.globalId);
      if (old) {
        await tx
          .update(locations)
          .set({ name, ifcClass: n.ifcClass, ifcFileVersionId: p.versionId, updatedAt: new Date() })
          .where(eq(locations.id, old.id));
        idByGuid.set(n.globalId, old.id);
        updated++;
        continue;
      }
      const parentId = n.parentGlobalId ? (idByGuid.get(n.parentGlobalId) ?? p.parentId) : p.parentId;
      const [ins] = await tx
        .insert(locations)
        .values({
          projectId: p.projectId,
          parentId,
          name,
          type: TYPE_TR[n.ifcClass] ?? null,
          sortOrder: n.ifcClass === "IfcBuildingStorey" ? order.get(n)! : base + order.get(n)!,
          ifcFileVersionId: p.versionId,
          ifcGlobalId: n.globalId,
          ifcClass: n.ifcClass,
          createdBy: p.userId,
        })
        .returning({ id: locations.id });
      idByGuid.set(n.globalId, ins!.id);
      created++;
    }
    await tx
      .update(jobs)
      .set({ payload: { ...p, result: { created, updated, total: nodes.length } } as unknown as Record<string, unknown> })
      .where(eq(jobs.id, job.id));
  });
}

const require = createRequire(import.meta.url);

function workerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `ifc-spatial-worker${path.extname(here)}`);
}

export function runSpatialWorker(inputPath: string, timeoutMs = 30 * 60_000): Promise<SpatialNode[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath(), {
      workerData: { inputPath, wasmDir: path.dirname(require.resolve("web-ifc")) + path.sep },
      resourceLimits: { maxOldGenerationSizeMb: 8192 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(t("jobs:spatial.timeout")));
    }, timeoutMs);
    worker.on("message", (msg: { type: string; nodes?: SpatialNode[]; message?: string }) => {
      clearTimeout(timer);
      if (msg.type === "done") resolve(msg.nodes ?? []);
      else reject(new Error(msg.message));
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(t("jobs:spatial.exit", { code })));
    });
  });
}
