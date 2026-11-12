/**
 * Preview derivatives for the in-browser viewers (see packages/shared/src/viewers.ts):
 * queued on upload (or lazily when a viewer asks), built one at a time by the job queue.
 * Text extracted on the way feeds search and the "Sor" assistant (version_texts).
 */
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { splitExtension, viewerFor, type CadCheck, type PreviewKind, type PreviewMeta, type PreviewStatus } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, versionPreviews, versionTexts } from "../db/schema.js";
import type { JobQueue, JobRow } from "../jobs/queue.js";
import type { Storage } from "../core/platform/storage.js";
import { extractPdfText } from "../docintel/extract.js";
import { ConverterTimeoutError, ConverterUnavailableError, type Converters } from "./converters.js";
import { officeText } from "./office-text.js";
import type { DxfStats } from "./preview-worker.js";
import { SCENE_VERSION as SCENE_FORMAT, type SceneBuildInput, type SceneBuildResult } from "./scene-worker.js";
import type { OfficePdf } from "../office/service.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Job errors are stored with the preview and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export const PREVIEW_JOB = "version_preview";
/** Characters of text kept per version for search. */
export const TEXT_MAX = 200_000;
/** PDF pages read for search text. */
const PDF_TEXT_PAGES = 200;

type PreviewRow = typeof versionPreviews.$inferSelect;

async function setPreview(
  db: Db,
  versionId: string,
  kind: PreviewKind,
  set: { status: PreviewStatus; storageKey?: string | null; error?: string | null; meta?: PreviewMeta },
): Promise<void> {
  const values = { ...set, updatedAt: new Date() };
  await db
    .insert(versionPreviews)
    .values({ versionId, kind, ...values })
    .onConflictDoUpdate({ target: [versionPreviews.versionId, versionPreviews.kind], set: values });
}

export async function previewsOf(db: Db, versionId: string): Promise<PreviewRow[]> {
  return db.select().from(versionPreviews).where(eq(versionPreviews.versionId, versionId));
}

/** Queues one preview (status "pending"); a preview already pending or processing is left alone. */
export async function queuePreview(db: Db, jobs: JobQueue, versionId: string, kind: PreviewKind): Promise<void> {
  const [row] = await db
    .select({ status: versionPreviews.status })
    .from(versionPreviews)
    .where(and(eq(versionPreviews.versionId, versionId), eq(versionPreviews.kind, kind)));
  if (row && (row.status === "pending" || row.status === "processing")) return;
  await setPreview(db, versionId, kind, { status: "pending", error: null });
  await jobs.enqueue(PREVIEW_JOB, { versionId, kind });
}

/** Upload hook: queues the derivatives the file's viewer needs. */
export async function queuePreviewsFor(db: Db, jobs: JobQueue, versionId: string, fileName: string): Promise<void> {
  for (const kind of viewerFor(fileName).previews) await queuePreview(db, jobs, versionId, kind);
}

export async function saveText(db: Db, versionId: string, projectId: string, source: string, raw: string, truncated = false) {
  const clean = raw.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const content = clean.slice(0, TEXT_MAX);
  const values = { projectId, source, content, truncated: truncated || clean.length > TEXT_MAX, updatedAt: new Date() };
  if (!content) {
    await db.delete(versionTexts).where(eq(versionTexts.versionId, versionId));
    return 0;
  }
  await db
    .insert(versionTexts)
    .values({ versionId, ...values })
    .onConflictDoUpdate({ target: versionTexts.versionId, set: values });
  return content.length;
}

function pdfPagesText(out: Awaited<ReturnType<typeof extractPdfText>>): string {
  return out.pages
    .map((p) => {
      // Items in reading order: by baseline, then x.
      const items = [...p.items].filter((i) => i.s.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
      let text = "";
      let lastY: number | null = null;
      for (const it of items) {
        if (lastY !== null && Math.abs(it.y - lastY) > Math.max(2, it.h * 0.5)) text += "\n";
        else if (text && !text.endsWith(" ")) text += " ";
        text += it.s;
        lastY = it.y;
      }
      return text;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------

function workerPath(name: "preview-worker" | "scene-worker" = "preview-worker"): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `${name}${path.extname(here)}`);
}

export interface SheetWorkerResult {
  sheets: string[];
  truncated: boolean;
  text: string;
  textTruncated: boolean;
}

export interface DxfWorkerResult {
  encoding: string;
  binary: boolean;
  text: string;
  truncated: boolean;
  stats: DxfStats;
  /** Values joined by the repair pass. */
  repairs: number;
  /** The repaired DXF was written to outputPath (else the input is fine as it is). */
  repaired: boolean;
}

export function runPreviewWorker(
  data: { task: "sheet"; inputPath: string; extension: string; outputPath: string },
  timeoutMs?: number,
): Promise<SheetWorkerResult>;
export function runPreviewWorker(data: { task: "dxf"; inputPath: string; outputPath?: string }, timeoutMs?: number): Promise<DxfWorkerResult>;
export function runPreviewWorker(data: Record<string, unknown>, timeoutMs = 300_000): Promise<unknown> {
  return runWorker(workerPath(), data, timeoutMs);
}

/** Builds the 2D scene(s) of a DXF in a worker thread (scene-worker.ts); `onPhase` follows the build. */
export function runSceneWorker(data: Omit<SceneBuildInput, "task">, onPhase?: (phase: "parse" | "build" | "compress") => void, timeoutMs = 900_000): Promise<SceneBuildResult> {
  return runWorker(workerPath("scene-worker"), { task: "scene", ...data }, timeoutMs, onPhase, 6144) as Promise<SceneBuildResult>;
}

function runWorker(file: string, data: Record<string, unknown>, timeoutMs: number, onPhase?: (phase: never) => void, heapMb = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(t("previews:jobs.timeout")))), timeoutMs);
    worker.on("message", (msg: { type: string; result?: unknown; message?: string; phase?: never }) => {
      if (msg.type === "progress") onPhase?.(msg.phase!);
      else if (msg.type === "done") finish(() => resolve(msg.result));
      else if (msg.type === "error") finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(t("previews:jobs.workerExit", { code })))));
  });
}

// ---------------------------------------------------------------------------------------------

export interface PreviewDeps {
  db: Db;
  storage: Storage;
  /** DWG → DXF (LibreDWG). */
  converters: Converters;
  /** Office → PDF through the configured converter (ONLYOFFICE, Collabora, Gotenberg, local soffice). */
  office: OfficePdf;
  /** Lets a preview queue a follow-up one (office text, then the page-layout PDF when a converter is configured). */
  jobs?: JobQueue;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * The server can make PDFs of office files: the admin configured a converter (Yönetim → Office
 * entegrasyonu: ONLYOFFICE, Collabora, Gotenberg or local soffice). Office files are viewed in
 * the browser without it; the PDF only adds the exact page layout.
 */
export function officePdfAvailable(office: OfficePdf): Promise<boolean> {
  return office.canConvert();
}

/** Queues the office PDF unless it exists or is being built (a converter installed later builds the missing ones). */
async function queuePdfIfMissing(db: Db, jobs: JobQueue, versionId: string): Promise<void> {
  const [row] = await db
    .select({ status: versionPreviews.status })
    .from(versionPreviews)
    .where(and(eq(versionPreviews.versionId, versionId), eq(versionPreviews.kind, "pdf")));
  if (!row || row.status === "unavailable") await queuePreview(db, jobs, versionId, "pdf");
}

/** Job handler: builds one preview of one version. */
export async function runPreviewJob(deps: PreviewDeps, job: JobRow): Promise<void> {
  const { db } = deps;
  const versionId = String(job.payload.versionId);
  const kind = String(job.payload.kind) as PreviewKind;
  const [row] = await db
    .select({ v: fileVersions, f: files })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(fileVersions.id, versionId));
  if (!row) return; // version deleted meanwhile
  const [prev] = await db
    .select({ storageKey: versionPreviews.storageKey, attempts: versionPreviews.attempts, meta: versionPreviews.meta })
    .from(versionPreviews)
    .where(and(eq(versionPreviews.versionId, versionId), eq(versionPreviews.kind, kind)));
  await db
    .insert(versionPreviews)
    .values({ versionId, kind, status: "processing", attempts: 1 })
    .onConflictDoUpdate({
      target: [versionPreviews.versionId, versionPreviews.kind],
      set: { status: "processing", error: null, attempts: (prev?.attempts ?? 0) + 1, updatedAt: new Date() },
    });
  const ext = splitExtension(row.f.name).extension.toLowerCase();
  const input = deps.storage.localPath(row.v.storageKey);
  const ctx = { ...deps, versionId, projectId: row.f.projectId, ext, input };
  try {
    const result = await BUILDERS[kind](ctx);
    await setPreview(db, versionId, kind, { status: "ready", storageKey: result.storageKey ?? null, meta: result.meta, error: null });
    if (prev?.storageKey && prev.storageKey !== result.storageKey) await deps.storage.remove(prev.storageKey).catch(() => undefined);
    const oldModel = prev?.meta?.sceneModelKey;
    if (oldModel && oldModel !== result.meta.sceneModelKey) await deps.storage.remove(oldModel).catch(() => undefined);
    // The 2D scene is built from the DXF, so it follows it (a rebuilt DXF rebuilds the scene).
    if (kind === "dxf" && deps.jobs && sceneWanted(result.meta)) {
      await queuePreview(db, deps.jobs, versionId, "scene").catch((e: unknown) => deps.log?.(`preview scene of ${versionId} not queued`, e instanceof Error ? e.message : e));
    }
  } catch (err) {
    if (err instanceof ConverterUnavailableError) {
      // Not an error of the file: the admin installs the converter, then the viewer retries.
      await setPreview(db, versionId, kind, { status: "unavailable", error: err.hint });
      return;
    }
    const message = err instanceof ConverterTimeoutError ? err.message : err instanceof Error ? err.message : String(err);
    await setPreview(db, versionId, kind, { status: "failed", error: message.slice(0, 1000) });
    throw err;
  }
}

/**
 * dwg2dxf error lines from which a drawing with entities is shown with a warning. Some dozen
 * errors are common and harmless (e.g. 32 × "Invalid ATTRIB.keep_duplicate_records" with 0.14);
 * hundreds mean objects were lost (402 on a 0.13 conversion whose MTEXTs were misread).
 */
export const CAD_PARTIAL_ERRORS = 100;
/** At most this many entities with Civil 3D classes: nothing but Civil 3D objects. */
const CIVIL3D_MAX_ENTITIES = 5;

/** The drawing check behind the viewer's Civil 3D / empty cards and the partial-conversion warning. */
export function cadCheck(stats: DxfStats, converterErrors: number): CadCheck {
  const shown = stats.entities;
  let status: CadCheck["status"] = "ok";
  if (stats.aeccClasses > 0 && shown <= CIVIL3D_MAX_ENTITIES) status = "civil3d";
  else if (shown === 0) status = "empty";
  else if (converterErrors >= CAD_PARTIAL_ERRORS || stats.aeccClasses > 0) status = "partial";
  return { status, converterErrors, ...stats };
}

/** A scene is built for drawings that show something. */
export function sceneWanted(meta: PreviewMeta): boolean {
  return !meta.cad || meta.cad.status === "ok" || meta.cad.status === "partial";
}

interface BuildContext extends PreviewDeps {
  versionId: string;
  projectId: string;
  ext: string;
  input: string;
}

type Builder = (c: BuildContext) => Promise<{ storageKey?: string; meta: PreviewMeta }>;

const tmpFile = (suffix: string) => path.join(os.tmpdir(), `7dcde-prev-${randomUUID()}${suffix}`);

const BUILDERS: Record<PreviewKind, Builder> = {
  /** Office → PDF (optional, configured converter: page layout). OOXML/ODF text is read first as well. */
  async pdf(c) {
    const meta: PreviewMeta = {};
    const textFirst = officeText(await readFile(c.input), c.ext);
    if (textFirst) {
      meta.textChars = await saveText(c.db, c.versionId, c.projectId, "office", textFirst.text);
      if (textFirst.notes?.some(Boolean)) meta.notes = textFirst.notes;
    }
    const out = tmpFile(".pdf");
    try {
      await c.office.officeToPdf(c.input, c.ext, out);
      try {
        const parsed = await extractPdfText({ filePath: out }, { maxPages: textFirst ? 1 : PDF_TEXT_PAGES, timeoutMs: 180_000 });
        meta.pageCount = parsed.pageCount;
        // Binary formats (.doc, .ppt, .rtf) and spreadsheets: text from the PDF.
        if (!textFirst && viewerFor(`x.${c.ext}`).kind !== "sheet") {
          meta.textChars = await saveText(c.db, c.versionId, c.projectId, "office", pdfPagesText(parsed));
        }
      } catch (err) {
        c.log?.(`preview pdf text of ${c.versionId} failed`, err instanceof Error ? err.message : err);
      }
      const stored = await c.storage.put(createReadStream(out), `projects/${c.projectId}/previews`);
      return { storageKey: stored.key, meta };
    } finally {
      await rm(out, { force: true });
    }
  },

  async sheet(c) {
    const out = tmpFile(".json.gz");
    try {
      const r = await runPreviewWorker({ task: "sheet", inputPath: c.input, extension: c.ext, outputPath: out });
      const textChars = await saveText(c.db, c.versionId, c.projectId, "sheet", r.text, r.textTruncated);
      const stored = await c.storage.put(createReadStream(out), `projects/${c.projectId}/previews`);
      return { storageKey: stored.key, meta: { sheets: r.sheets, truncated: r.truncated, textChars } };
    } finally {
      await rm(out, { force: true });
    }
  },

  /**
   * DWG → DXF (LibreDWG); a DXF is read as is. Both go through the repair pass (values broken
   * over lines) and the drawing check (Civil 3D objects, empty conversions). Text entities go to
   * search. A DXF upload is kept as the original unless it needed repairs.
   */
  async dxf(c) {
    const converted = c.ext === "dxf" ? null : tmpFile(".dxf");
    const repaired = tmpFile(".dxf");
    try {
      const errors = converted ? (await c.converters.dwgToDxf(c.input, converted)).errors : 0;
      const info = await runPreviewWorker({ task: "dxf", inputPath: converted ?? c.input, outputPath: repaired });
      const textChars = await saveText(c.db, c.versionId, c.projectId, "cad", info.text, info.truncated);
      // Binary DXF is not scanned: no counts to judge it by.
      const cad = info.binary ? undefined : cadCheck(info.stats, errors);
      if (info.repairs) {
        c.log?.(`preview dxf of ${c.versionId}: ${info.repairs} broken DXF lines joined (LibreDWG 0.14+ writes clean DXF)`);
      }
      const meta: PreviewMeta = { encoding: info.encoding, textChars, repairs: info.repairs, ...(cad && { cad }) };
      if (!converted && !info.repaired) return { meta: { ...meta, original: true, dxfBytes: (await stat(c.input)).size } };
      const dxfPath = info.repaired ? repaired : converted!;
      meta.dxfBytes = (await stat(dxfPath)).size;
      const stored = await c.storage.put(createReadStream(dxfPath), `projects/${c.projectId}/previews`);
      return { storageKey: stored.key, meta };
    } finally {
      await rm(repaired, { force: true });
      if (converted) await rm(converted, { force: true });
    }
  },

  /** The prebuilt 2D scene (dxf-viewer's scene, built once here instead of in every browser). */
  async scene(c) {
    const [dxf] = await c.db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, c.versionId), eq(versionPreviews.kind, "dxf")));
    if (!dxf || dxf.status !== "ready") throw new Error(t("previews:jobs.dxfFirst"));
    if (!sceneWanted(dxf.meta)) throw new Error(t("previews:jobs.nothingToShow"));
    const input = dxf.storageKey ? c.storage.localPath(dxf.storageKey) : c.input;
    const out = tmpFile(".scene.gz");
    const modelOut = tmpFile(".model.scene.gz");
    try {
      // Phase updates for the viewer's "Hazırlanıyor" card; all written before the result.
      let phases = Promise.resolve();
      const r = await runSceneWorker({ inputPath: input, encoding: dxf.meta.encoding ?? "utf-8", outputPath: out, modelOutputPath: modelOut }, (phase) => {
        phases = phases.then(() => setPreview(c.db, c.versionId, "scene", { status: "processing", meta: { phase } })).catch(() => undefined);
      });
      await phases;
      const stored = await c.storage.put(createReadStream(out), `projects/${c.projectId}/previews`);
      const model = r.model ? await c.storage.put(createReadStream(modelOut), `projects/${c.projectId}/previews`) : null;
      const meta: PreviewMeta = {
        scene: { bytes: r.bytes, gzBytes: r.gzBytes, model: r.model, batches: r.batches, layers: r.layers, timings: r.timings, format: SCENE_FORMAT },
      };
      if (model) meta.sceneModelKey = model.key;
      c.log?.(`preview scene of ${c.versionId}: ${r.gzBytes} B gzip, ${JSON.stringify(r.timings)} ms`);
      return { storageKey: stored.key, meta };
    } finally {
      await rm(out, { force: true });
      await rm(modelOut, { force: true });
    }
  },

  /** Text only: PDF pages, office XML (+ speaker notes), plain text, Markdown, e-mail. */
  async text(c) {
    const kind = viewerFor(`x.${c.ext}`).kind;
    if (kind === "document" || kind === "slides") {
      // Read from the XML parts: no converter needed. Binary formats (.doc, .ppt, .rtf) get their text from the PDF.
      const meta: PreviewMeta = {};
      const office = officeText(await readFile(c.input), c.ext);
      if (office) {
        meta.textChars = await saveText(c.db, c.versionId, c.projectId, "office", office.text);
        if (office.notes?.some(Boolean)) meta.notes = office.notes;
      }
      if (c.jobs && (await officePdfAvailable(c.office))) await queuePdfIfMissing(c.db, c.jobs, c.versionId);
      return { meta };
    }
    if (c.ext === "pdf") {
      const parsed = await extractPdfText({ filePath: c.input }, { maxPages: PDF_TEXT_PAGES, timeoutMs: 300_000 });
      const textChars = await saveText(c.db, c.versionId, c.projectId, "pdf", pdfPagesText(parsed), parsed.pageCount > PDF_TEXT_PAGES);
      return { meta: { pageCount: parsed.pageCount, textChars } };
    }
    const buf = await readFile(c.input);
    const slice = buf.subarray(0, TEXT_MAX * 4);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      text = new TextDecoder("windows-1254").decode(slice);
    }
    if (c.ext === "eml") text = text.replace(/^[A-Za-z0-9+/=]{60,}$/gm, ""); // drop base64 attachment bodies
    const textChars = await saveText(c.db, c.versionId, c.projectId, "text", text, buf.length > slice.length);
    return { meta: { textChars } };
  },
};

export function registerPreviewJobs(jobs: JobQueue, deps: PreviewDeps): void {
  const withJobs = { ...deps, jobs: deps.jobs ?? jobs };
  jobs.register(PREVIEW_JOB, (job) => runPreviewJob(withJobs, job));
}
