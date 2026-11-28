/**
 * Version comparison of DWG / DXF drawings and IFC models (FP-1, docs/features/DOCUMENT_COMPARISON.md).
 *
 * Runs as a background job on the job queue ("version_compare"), one row per version pair in
 * doc_comparisons (the same cache as the document comparison). The job needs each side prepared
 * first: the DXF the CAD viewer reads (preview "dxf", LibreDWG for DWG) or the IFC element index.
 * When one is missing it queues that job and queues itself again behind it. The summary goes into
 * the comparison row, the full list of differences into a gzip JSON file in storage.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  docCompareKind,
  ifcClassLabel,
  type CadCompareSummary,
  type DocCompareKind,
  type DocCompareResult,
  type ModelCompareSummary,
  type SummaryBullet,
  type VersionDiffChange,
  type VersionDiffRow,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { docComparisons, fileVersions, files, jobs as jobsTable, versionIndexes, versionPreviews } from "../db/schema.js";
import type { JobQueue, JobRow } from "../jobs/queue.js";
import { loadIndexFile } from "../jobs/version-index.js";
import { withLocalCopies, type Storage } from "../core/platform/storage.js";
import { ModelIndex } from "../model/model-index.js";
import { ensureIndexJob, ensureUpgradeJob } from "../model/service.js";
import { PREVIEW_JOB, queuePreview } from "../previews/service.js";
import { DWG2DXF_HINT } from "../previews/converters.js";
import { DEFAULT_LANGUAGE, tFor, type MsgKey } from "../i18n/index.js";
import { BINARY_DXF, type CadCompareInput } from "./cad-worker.js";
import { diffModels } from "./model-compare.js";

export const VERSION_COMPARE_JOB = "version_compare";
/** Times the job queues itself behind the preparation of a side before it gives up. */
const MAX_WAITS = 30;

type VersionCompareKind = Extract<DocCompareKind, "dwg" | "ifc">;
type VersionRow = typeof fileVersions.$inferSelect;
type FileRow = typeof files.$inferSelect;
type ComparisonRow = typeof docComparisons.$inferSelect;

export function isVersionCompareKind(kind: DocCompareKind | null | undefined): kind is VersionCompareKind {
  return kind === "dwg" || kind === "ifc";
}

interface Compared {
  cad?: CadCompareSummary;
  model?: ModelCompareSummary;
  rows: VersionDiffRow[];
}

/** Not ready yet: a side is being prepared (DXF conversion, IFC index). */
const WAIT = Symbol("wait");

/** Job errors are stored with the comparison and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

function workerFile(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `cad-worker${path.extname(here)}`);
}

/** Runs the DWG comparison in a worker thread (cad-worker.ts). */
export function runCadCompare(input: Omit<CadCompareInput, "task">, timeoutMs = 15 * 60_000): Promise<CadCompareSummary> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile(), { workerData: { task: "cad-compare", ...input }, resourceLimits: { maxOldGenerationSizeMb: 6144 } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(t("doccompare:versionDiff.errors.timeout")))), timeoutMs);
    worker.on("message", (m: { type: string; result?: CadCompareSummary; message?: string }) => {
      if (m.type === "done") finish(() => resolve(m.result!));
      else if (m.type === "error")
        finish(() => reject(new Error(m.message === BINARY_DXF ? t("doccompare:versionDiff.errors.binaryDxf") : m.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(t("doccompare:versionDiff.errors.workerExit", { code })))));
  });
}

export class VersionCompareRunner {
  private readonly cache = new Map<string, VersionDiffRow[]>();

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly jobs: JobQueue,
    private readonly log: (msg: string, extra?: unknown) => void = () => {},
  ) {}

  register(): void {
    this.jobs.register(VERSION_COMPARE_JOB, (job) => this.run(job));
  }

  /** Queues the comparison (its row is "running"). */
  async start(comparisonId: string): Promise<void> {
    await this.jobs.enqueue(VERSION_COMPARE_JOB, { comparisonId });
  }

  /** A job for the comparison is queued or running. */
  async active(comparisonId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, VERSION_COMPARE_JOB),
          inArray(jobsTable.status, ["queued", "running"]),
          sql`${jobsTable.payload}->>'comparisonId' = ${comparisonId}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The full list of differences of a finished comparison. */
  async rows(row: ComparisonRow): Promise<VersionDiffRow[]> {
    const key = (row.result as DocCompareResult | null)?.detailKey;
    if (!key) return [];
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const chunks: Buffer[] = [];
    for await (const c of this.storage.get(key)) chunks.push(c as Buffer);
    const rows = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")) as VersionDiffRow[];
    this.cache.set(key, rows);
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    return rows;
  }

  /** Drops the stored list of differences (rebuild). */
  async drop(result: DocCompareResult | null): Promise<void> {
    if (!result?.detailKey) return;
    this.cache.delete(result.detailKey);
    await this.storage.remove(result.detailKey).catch(() => undefined);
  }

  private async run(job: JobRow): Promise<void> {
    const id = String(job.payload.comparisonId);
    const waits = Number(job.payload.waits ?? 0);
    const [row] = await this.db.select().from(docComparisons).where(eq(docComparisons.id, id));
    if (!row || row.status !== "running") return;
    const fail = async (message: string) => {
      this.log(`version compare ${id} failed`, message);
      await this.db
        .update(docComparisons)
        .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(docComparisons.id, id));
    };
    try {
      const a = await this.side(row.fromVersionId);
      const b = await this.side(row.toVersionId);
      if (!a || !b) return await fail(t("doccompare:versionDiff.errors.versionGone"));
      const kind = kindOf(b.file.name);
      if (!kind || kindOf(a.file.name) !== kind) return await fail(t("doccompare:errors.mixedTypes"));
      const out = kind === "dwg" ? await this.compareDrawings(a, b) : await this.compareModels(a, b);
      if (out === WAIT) {
        if (waits >= MAX_WAITS) return await fail(t("doccompare:versionDiff.errors.notPrepared"));
        await this.jobs.enqueue(VERSION_COMPARE_JOB, { comparisonId: id, waits: waits + 1 });
        return;
      }
      const stored = await this.storage.putBytes(gzipSync(Buffer.from(JSON.stringify(out.rows))), `projects/${b.file.projectId}/comparisons`);
      const counts = out.cad ?? out.model!;
      const result: DocCompareResult = {
        kind,
        hasText: false,
        identical: a.version.sha256 === b.version.sha256,
        pageCountA: 1,
        pageCountB: 1,
        pages: [],
        totals: { added: counts.added, removed: counts.removed, changed: counts.changed, pages: 0 },
        antet: [],
        revisionA: null,
        revisionB: null,
        revisionTableA: null,
        revisionTableB: null,
        antetRegion: null,
        contentChanged: counts.added + counts.removed + counts.changed > 0,
        ...(out.cad && { cad: out.cad }),
        ...(out.model && { model: out.model }),
        detailKey: stored.key,
      };
      const [done] = await this.db
        .update(docComparisons)
        .set({ status: "done", result, error: null, updatedAt: new Date() })
        .where(and(eq(docComparisons.id, id), eq(docComparisons.status, "running")))
        .returning({ id: docComparisons.id });
      // Rebuilt meanwhile: this result is not the comparison's.
      if (!done) await this.storage.remove(stored.key).catch(() => undefined);
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async side(versionId: string): Promise<{ version: VersionRow; file: FileRow } | null> {
    const [r] = await this.db
      .select({ version: fileVersions, file: files })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(eq(fileVersions.id, versionId));
    return r ?? null;
  }

  /** The DXF of a drawing version (the CAD viewer's preview), or WAIT while it is being made. */
  private async dxfOf(v: VersionRow): Promise<{ key: string; encoding?: string } | typeof WAIT> {
    const [p] = await this.db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, v.id), eq(versionPreviews.kind, "dxf")));
    if (p?.status === "ready") return { key: p.storageKey ?? v.storageKey, encoding: p.meta?.encoding };
    if (p?.status === "unavailable") throw new Error(p.error || DWG2DXF_HINT);
    if (p?.status === "failed") throw new Error(t("doccompare:versionDiff.errors.dxfFailed", { error: p.error ?? "" }));
    if (!p) await queuePreview(this.db, this.jobs, v.id, "dxf");
    else {
      // Pending or processing: make sure a job is on its way (a lost one is queued again).
      const active = await this.db
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.kind, PREVIEW_JOB),
            inArray(jobsTable.status, ["queued", "running"]),
            sql`${jobsTable.payload}->>'versionId' = ${v.id}`,
            sql`${jobsTable.payload}->>'kind' = 'dxf'`,
          ),
        )
        .limit(1);
      if (!active.length) await this.jobs.enqueue(PREVIEW_JOB, { versionId: v.id, kind: "dxf" });
    }
    return WAIT;
  }

  private async compareDrawings(a: { version: VersionRow }, b: { version: VersionRow }): Promise<Compared | typeof WAIT> {
    const da = await this.dxfOf(a.version);
    const db = await this.dxfOf(b.version);
    if (da === WAIT || db === WAIT) return WAIT;
    const out = path.join(os.tmpdir(), `7dcde-cmp-${randomUUID()}.json.gz`);
    try {
      // Local copies of the two DXFs (the stored files themselves on the local disk).
      const cad = await withLocalCopies(this.storage, [da.key, db.key], ([pa, pb]) =>
        runCadCompare({ a: { path: pa!, encoding: da.encoding }, b: { path: pb!, encoding: db.encoding }, outputPath: out }),
      );
      const rows = JSON.parse(gunzipSync(await readFile(out)).toString("utf8")) as VersionDiffRow[];
      return { cad, rows };
    } finally {
      await rm(out, { force: true });
    }
  }

  /** The element index of an IFC version with properties and shapes, or WAIT while it is built. */
  private async indexOf(v: VersionRow): Promise<ModelIndex | typeof WAIT> {
    const [row] = await this.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, v.id));
    if (!row) {
      await ensureIndexJob(this.db, this.jobs, v.id, v.derivativeStatus, false);
      return WAIT;
    }
    const index = ModelIndex.of(await loadIndexFile(this.storage, v.id, row.storageKey));
    // An older index is rebuilt once (properties, shapes); when that is not possible it is used as it is.
    if ((!index.detailed || !index.hasGeometry) && (await ensureUpgradeJob(this.db, this.jobs, v.id, row.createdAt))) return WAIT;
    return index;
  }

  private async compareModels(a: { version: VersionRow }, b: { version: VersionRow }): Promise<Compared | typeof WAIT> {
    const ia = await this.indexOf(a.version);
    const ib = await this.indexOf(b.version);
    if (ia === WAIT || ib === WAIT) return WAIT;
    const { summary, rows } = diffModels(ia, ib);
    return { model: summary, rows };
  }
}

function kindOf(name: string): VersionCompareKind | null {
  // IFC and the model formats modules convert to it (their element index is compared).
  const kind = docCompareKind(name.slice(name.lastIndexOf(".") + 1));
  return isVersionCompareKind(kind) ? kind : null;
}

// ---------------------------------------------------------------------------------------------
// Texts: summary bullets and the CSV / XLSX export
// ---------------------------------------------------------------------------------------------

type T = ReturnType<typeof tFor>;

/** Label of a change name ("@layer" → "Layer"; IFC property names as they are). */
export function changeLabel(prop: string, t: T): string {
  return prop.startsWith("@") ? t(`doccompare:versionDiff.props.${prop.slice(1)}` as MsgKey, { defaultValue: prop.slice(1) }) : prop;
}

export function changeText(c: VersionDiffChange, t: T): string {
  const label = changeLabel(c.prop, t);
  if (c.from === null && c.to === null) return label;
  return `${label}: ${c.from ?? "—"} → ${c.to ?? "—"}`;
}

/** Rule-based summary of a drawing or model comparison. */
export function versionSummary(result: DocCompareResult, lang: string): SummaryBullet[] {
  const t = tFor(lang);
  const out: SummaryBullet[] = [];
  if (result.cad) {
    const c = result.cad;
    out.push({ text: t("doccompare:versionDiff.summary.cadTotals", { added: c.added, removed: c.removed, changed: c.changed, unchanged: c.unchanged }) });
    if (c.matchedBy === "geometry") out.push({ text: t("doccompare:versionDiff.summary.matchedByGeometry"), severity: "warn" });
    for (const l of c.layers.filter((x) => x.status !== "same").slice(0, 8)) {
      if (l.status === "added" || l.status === "removed") {
        out.push({ text: t(`doccompare:versionDiff.summary.layer_${l.status}`, { layer: l.layer, count: l.status === "added" ? l.entitiesB : l.entitiesA }) });
        continue;
      }
      const parts = [
        l.added ? t("doccompare:counts.added", { count: l.added }) : null,
        l.removed ? t("doccompare:counts.removed", { count: l.removed }) : null,
        l.changed ? t("doccompare:counts.changed", { count: l.changed }) : null,
        ...l.props.map((p) => `${t(`doccompare:versionDiff.layerProps.${p.prop}`)} ${p.from ?? "—"} → ${p.to ?? "—"}`),
      ].filter(Boolean);
      out.push({ text: t("doccompare:versionDiff.summary.layerChanged", { layer: l.layer, parts: parts.join(", ") }) });
    }
  }
  if (result.model) {
    const m = result.model;
    out.push({ text: t("doccompare:versionDiff.summary.modelTotals", { added: m.added, removed: m.removed, changed: m.changed, unchanged: m.unchanged }) });
    const classes = Object.entries(m.byClass)
      .filter(([, n]) => n.added + n.removed + n.changed > 0)
      .sort((x, y) => y[1].added + y[1].removed + y[1].changed - (x[1].added + x[1].removed + x[1].changed))
      .slice(0, 8);
    for (const [cls, n] of classes) {
      const parts = [
        n.added ? t("doccompare:counts.added", { count: n.added }) : null,
        n.removed ? t("doccompare:counts.removed", { count: n.removed }) : null,
        n.changed ? t("doccompare:counts.changed", { count: n.changed }) : null,
      ].filter(Boolean);
      out.push({ text: t("doccompare:versionDiff.summary.classChanged", { cls: ifcClassLabel(cls, lang), parts: parts.join(", ") }) });
    }
    if (!m.geometry) out.push({ text: t("doccompare:versionDiff.summary.noGeometry"), severity: "info" });
  }
  return out;
}

/** Columns and rows of the differences export. */
export function exportTable(kind: VersionCompareKind, rows: VersionDiffRow[], lang: string): { columns: string[]; rows: string[][] } {
  const t = tFor(lang);
  const cad = kind === "dwg";
  const columns = [
    t("doccompare:versionDiff.columns.kind"),
    t(cad ? "doccompare:versionDiff.columns.layer" : "doccompare:versionDiff.columns.class"),
    t(cad ? "doccompare:versionDiff.columns.entityType" : "doccompare:versionDiff.columns.storey"),
    t(cad ? "doccompare:versionDiff.columns.handle" : "doccompare:versionDiff.columns.globalId"),
    t(cad ? "doccompare:versionDiff.columns.content" : "doccompare:versionDiff.columns.name"),
    t("doccompare:versionDiff.columns.aspects"),
    t("doccompare:versionDiff.columns.changes"),
  ];
  const aspectLabel = (a: string) =>
    t((cad ? `doccompare:versionDiff.aspects.${a}` : `doccompare:versionDiff.categories.${a}`) as MsgKey, { defaultValue: a });
  return {
    columns,
    rows: rows.map((r) => [
      t(`doccompare:versionDiff.kinds.${r.kind}`),
      cad ? r.group : `${ifcClassLabel(r.group, lang)} (${r.group})`,
      r.subgroup ?? "",
      r.id,
      r.name ?? "",
      r.aspects.map(aspectLabel).join(", "),
      r.changes.map((c) => changeText(c, t)).join("; "),
    ]),
  };
}

/** Summary sheet of the XLSX export: per layer (DWG) or per class and storey (IFC). */
export function exportSummary(result: DocCompareResult, lang: string): { name: string; columns: string[]; rows: (string | number)[][] }[] {
  const t = tFor(lang);
  const counts = [t("doccompare:versionDiff.kinds.added"), t("doccompare:versionDiff.kinds.removed"), t("doccompare:versionDiff.kinds.changed")];
  if (result.cad) {
    return [
      {
        name: t("doccompare:versionDiff.sheets.layers"),
        columns: [
          t("doccompare:versionDiff.columns.layer"),
          t("doccompare:versionDiff.columns.status"),
          t("doccompare:versionDiff.columns.entitiesA"),
          t("doccompare:versionDiff.columns.entitiesB"),
          ...counts,
          t("doccompare:versionDiff.columns.types"),
          t("doccompare:versionDiff.columns.layerProps"),
        ],
        rows: result.cad.layers.map((l) => [
          l.layer,
          t(`doccompare:versionDiff.status.${l.status}`),
          l.entitiesA,
          l.entitiesB,
          l.added,
          l.removed,
          l.changed,
          Object.entries(l.types)
            .map(([type, [x, y]]) => (x === y ? `${type} ${x}` : `${type} ${x} → ${y}`))
            .join(", "),
          l.props.map((p) => `${t(`doccompare:versionDiff.layerProps.${p.prop}`)}: ${p.from ?? "—"} → ${p.to ?? "—"}`).join("; "),
        ]),
      },
    ];
  }
  if (!result.model) return [];
  const m = result.model;
  return [
    {
      name: t("doccompare:versionDiff.sheets.classes"),
      columns: [t("doccompare:versionDiff.columns.class"), "IFC", ...counts, t("doccompare:versionDiff.kinds.unchanged")],
      rows: Object.entries(m.byClass)
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([cls, n]) => [ifcClassLabel(cls, lang), cls, n.added, n.removed, n.changed, n.unchanged]),
    },
    {
      name: t("doccompare:versionDiff.sheets.storeys"),
      columns: [t("doccompare:versionDiff.columns.storey"), ...counts],
      rows: Object.entries(m.byStorey)
        .sort((x, y) => x[0].localeCompare(y[0], "tr"))
        .map(([s, n]) => [s || t("doccompare:versionDiff.noStorey"), n.added, n.removed, n.changed]),
    },
  ];
}
