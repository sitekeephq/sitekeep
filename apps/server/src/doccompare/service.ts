/**
 * Document comparison runner. The text diff and the AI summary run in-process and in the
 * background (not on the single-threaded job queue, so a slow local model or a large PDF never
 * holds up IFC conversions). Results are cached per (from, to) version pair in doc_comparisons.
 * A run that was cut by a restart is detected (status "running" but not running here) and redone.
 */
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  docCompareKind,
  splitExtension,
  type DocCompareResult,
  type SummaryBullet,
} from "@sitekeep/shared";
import { resolveProvider, type AiProvider } from "../ai/provider.js";
import { PROMPT_CAPTURED } from "../ai/override.js";
import type { Db } from "../db/index.js";
import { docComparisons, fileVersions, files, reviewFiles, reviews, workflowInstances } from "../db/schema.js";
import { analyzeAntet } from "../docintel/antet.js";
import { extractPdfText } from "../docintel/extract.js";
import { detectRevision } from "../docintel/revision.js";
import type { Storage } from "../core/platform/storage.js";
import { HttpError } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

/** Text of an error in a language (HttpError messages translated, others as they are). */
export function errorText(err: unknown, lang: string = DEFAULT_LANGUAGE): string {
  if (err instanceof HttpError && err.msg) return render(lang, err.msg);
  return err instanceof Error ? err.message : String(err);
}
import { summarize } from "./ai.js";
import { docxUnits, readCsv, readWorkbook, textUnits } from "./office.js";
import {
  antetChanges,
  antetRegion,
  compareFlags,
  diffUnits,
  diffWorkbooks,
  groupByPage,
  latestRevisionRow,
  markAntet,
  pdfUnits,
  totals,
  type TextUnit,
} from "./text-diff.js";

export type ComparisonRow = typeof docComparisons.$inferSelect;
type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;

export interface Side {
  file: FileRow;
  version: VersionRow;
}

/** PDF pages read per side. */
export const MAX_PDF_PAGES = 300;
const MAX_OFFICE_BYTES = 60 * 1024 * 1024;

export class DocCompareService {
  private readonly textRuns = new Map<string, Promise<void>>();
  private readonly aiRuns = new Map<string, { chars: number; startedAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly log: (msg: string, extra?: unknown) => void = () => {},
  ) {}

  /** The cached comparison of a pair, created (and started) when missing or stale. */
  async ensure(projectId: string, from: Side, to: Side, userId: string, rebuild = false): Promise<ComparisonRow> {
    const [existing] = await this.db
      .select()
      .from(docComparisons)
      .where(and(eq(docComparisons.fromVersionId, from.version.id), eq(docComparisons.toVersionId, to.version.id)));
    let row = existing;
    if (!row) {
      [row] = await this.db
        .insert(docComparisons)
        .values({ projectId, fromVersionId: from.version.id, toVersionId: to.version.id, createdBy: userId })
        .onConflictDoNothing()
        .returning();
      if (!row) return this.ensure(projectId, from, to, userId, false);
      this.startText(row.id, from, to);
      return row;
    }
    const stale = row.status === "running" && !this.textRuns.has(row.id);
    if (rebuild || stale) {
      const reset = rebuild
        ? { status: "running" as const, error: null, result: null, regions: null, regionsAt: null, aiStatus: "none" as const, aiBullets: null, aiError: null }
        : { status: "running" as const, error: null };
      [row] = await this.db.update(docComparisons).set({ ...reset, updatedAt: new Date() }).where(eq(docComparisons.id, row.id)).returning();
      this.startText(row!.id, from, to);
    }
    return row!;
  }

  async get(id: string): Promise<ComparisonRow | undefined> {
    const [row] = await this.db.select().from(docComparisons).where(eq(docComparisons.id, id));
    return row;
  }

  /** Waits (at most `ms`) for a running text diff. */
  async waitText(id: string, ms: number): Promise<void> {
    const run = this.textRuns.get(id);
    if (!run) return;
    await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  }

  /** Waits (at most `ms`) for a running AI summary (tests, MCP). */
  async waitAi(id: string, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.aiRuns.has(id) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  }

  isTextRunning(id: string): boolean {
    return this.textRuns.has(id);
  }

  aiProgress(id: string): { chars: number; seconds: number } | null {
    const r = this.aiRuns.get(id);
    return r ? { chars: r.chars, seconds: Math.round((Date.now() - r.startedAt) / 1000) } : null;
  }

  private startText(id: string, from: Side, to: Side) {
    if (this.textRuns.has(id)) return;
    const run = (async () => {
      try {
        const result = await computeComparison(this.storage, from, to);
        await this.db
          .update(docComparisons)
          .set({ status: "done", result, error: null, updatedAt: new Date() })
          .where(eq(docComparisons.id, id));
      } catch (err) {
        const message = errorText(err);
        this.log(`doc compare ${id} failed`, message);
        await this.db
          .update(docComparisons)
          .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(docComparisons.id, id));
      } finally {
        this.textRuns.delete(id);
      }
    })();
    this.textRuns.set(id, run);
  }

  /** Starts the AI summary (no-op when one is running). Returns false when already running. */
  startAi(row: ComparisonRow, provider: AiProvider, input: () => Promise<Parameters<typeof summarize>[1]>, onDone?: (ok: boolean, bullets: SummaryBullet[]) => Promise<void>): boolean {
    if (this.aiRuns.has(row.id)) return false;
    const state = { chars: 0, startedAt: Date.now() };
    this.aiRuns.set(row.id, state);
    void (async () => {
      try {
        await this.db
          .update(docComparisons)
          .set({ aiStatus: "running", aiError: null, aiStartedAt: new Date(), aiFinishedAt: null, updatedAt: new Date() })
          .where(eq(docComparisons.id, row.id));
        const bullets = await summarize(provider, await input(), { onText: (t) => (state.chars = t.length) });
        await this.db
          .update(docComparisons)
          .set({ aiStatus: "done", aiBullets: bullets, aiModel: provider.model, aiError: null, aiFinishedAt: new Date(), updatedAt: new Date() })
          .where(eq(docComparisons.id, row.id));
        await onDone?.(true, bullets);
      } catch (err) {
        if ((err as { code?: string }).code === PROMPT_CAPTURED) {
          // Only the prompt was taken (AI task queue / developer dry run): keep the earlier summary.
          await this.db
            .update(docComparisons)
            .set({ aiStatus: row.aiStatus, aiBullets: row.aiBullets, aiModel: row.aiModel, aiError: row.aiError, aiStartedAt: row.aiStartedAt, aiFinishedAt: row.aiFinishedAt })
            .where(eq(docComparisons.id, row.id));
          return;
        }
        const message = errorText(err);
        await this.db
          .update(docComparisons)
          .set({ aiStatus: "failed", aiError: message.slice(0, 500), aiFinishedAt: new Date(), updatedAt: new Date() })
          .where(eq(docComparisons.id, row.id));
        await onDone?.(false, []).catch(() => {});
      } finally {
        this.aiRuns.delete(row.id);
      }
    })();
    return true;
  }

  isAiRunning(id: string): boolean {
    return this.aiRuns.has(id);
  }
}

/** Language model for a project, or why there is none. */
export async function providerOrNote(
  db: Db,
  secretKey: Buffer,
  projectId: string,
  lang: string = DEFAULT_LANGUAGE,
): Promise<{ provider: AiProvider | null; note: string | null }> {
  try {
    return { provider: await resolveProvider(db, secretKey, projectId), note: null };
  } catch (e) {
    return { provider: null, note: errorText(e, lang) };
  }
}

/** Kind of a comparison, or an error message for unsupported / mixed files. */
export function comparisonKind(nameA: string, nameB: string): { kind: ReturnType<typeof docCompareKind>; error?: Msg } {
  const ea = splitExtension(nameA).extension.toLowerCase();
  const eb = splitExtension(nameB).extension.toLowerCase();
  const ka = docCompareKind(ea);
  const kb = docCompareKind(eb);
  if (ea === "ifc" || eb === "ifc") return { kind: null, error: msg("doccompare:errors.ifcInViewer") };
  if (!ka || !kb) return { kind: null, error: msg("doccompare:errors.unsupportedType", { extension: !ka ? ea : eb }) };
  if (ka !== kb) return { kind: null, error: msg("doccompare:errors.mixedTypes") };
  return { kind: ka };
}

/** Note of a stored result in a language (pages read only partly, no text layer). */
export function comparisonNote(result: DocCompareResult, lang: string = DEFAULT_LANGUAGE): string | undefined {
  if (result.kind !== "pdf") return result.note;
  if (!result.hasText) return render(lang, msg("doccompare:notes.noText"));
  if (Math.max(result.pageCountA, result.pageCountB) > MAX_PDF_PAGES) return render(lang, msg("doccompare:notes.pagesLimited", { pages: MAX_PDF_PAGES }));
  return result.note;
}

async function bytesOf(storage: Storage, v: VersionRow): Promise<Buffer> {
  if (v.size > MAX_OFFICE_BYTES)
    throw new Error(
      render(DEFAULT_LANGUAGE, msg("doccompare:errors.fileTooLarge", { mb: Math.round(v.size / 1024 / 1024), limit: MAX_OFFICE_BYTES / 1024 / 1024 })),
    );
  return readFile(storage.localPath(v.storageKey));
}

/** The text side of a comparison (no database access). */
export async function computeComparison(storage: Storage, from: Side, to: Side): Promise<DocCompareResult> {
  const { kind, error } = comparisonKind(from.file.name, to.file.name);
  if (!kind) throw new Error(error ? render(DEFAULT_LANGUAGE, error) : undefined);
  const identical = from.version.sha256 === to.version.sha256;
  const base: DocCompareResult = {
    kind,
    hasText: true,
    identical,
    pageCountA: 1,
    pageCountB: 1,
    pages: [],
    totals: { added: 0, removed: 0, changed: 0, pages: 0 },
    antet: [],
    revisionA: null,
    revisionB: null,
    revisionTableA: null,
    revisionTableB: null,
    antetRegion: null,
    contentChanged: false,
  };

  if (kind === "pdf") {
    const opts = { maxPages: MAX_PDF_PAGES, timeoutMs: 300_000 };
    const [outA, outB] = await Promise.all([
      extractPdfText({ filePath: storage.localPath(from.version.storageKey) }, opts),
      extractPdfText({ filePath: storage.localPath(to.version.storageKey) }, opts),
    ]);
    const antetA = analyzeAntet(outA);
    const antetB = analyzeAntet(outB);
    const ua = pdfUnits(outA);
    const ub = pdfUnits(outB);
    const res: DocCompareResult = {
      ...base,
      pageCountA: outA.pageCount,
      pageCountB: outB.pageCount,
      hasText: ua.hasText && ub.hasText,
      revisionA: detectRevision(antetA, from.file.name).value,
      revisionB: detectRevision(antetB, to.file.name).value,
      revisionTableA: latestRevisionRow(antetA),
      revisionTableB: latestRevisionRow(antetB),
      antetRegion: antetRegion(antetB),
    };
    // Shown in the reader's language (comparisonNote); stored in the installation's.
    res.note = comparisonNote(res);
    if (!res.hasText) return res;
    if (identical) return res;
    res.antet = antetChanges(antetA, antetB);
    res.pages = groupByPage(diffUnits(ua.units, ub.units));
    markAntet(res.pages, antetRegion(antetA), res.antetRegion);
    res.totals = totals(res.pages);
    res.contentChanged = res.pages.some((p) => (p.more ?? 0) > 0 || p.changes.some((c) => !c.antet));
    return res;
  }

  if (identical) return base;
  if (kind === "xlsx" || kind === "csv") {
    const read = async (v: VersionRow) =>
      kind === "xlsx" ? readWorkbook(await bytesOf(storage, v)) : [{ name: "CSV", rows: readCsv((await bytesOf(storage, v)).toString("utf8")) }];
    const [a, b] = await Promise.all([read(from.version), read(to.version)]);
    const sheets = diffWorkbooks(a, b);
    const changed = sheets.filter((s) => s.status !== "same");
    return {
      ...base,
      pageCountA: a.length,
      pageCountB: b.length,
      sheets,
      totals: {
        added: changed.reduce((s, x) => s + x.added, 0),
        removed: changed.reduce((s, x) => s + x.removed, 0),
        changed: changed.reduce((s, x) => s + x.changed, 0),
        pages: changed.length,
      },
      contentChanged: changed.length > 0,
    };
  }
  const units = async (v: VersionRow): Promise<TextUnit[]> =>
    kind === "docx" ? docxUnits(await bytesOf(storage, v)) : textUnits((await bytesOf(storage, v)).toString("utf8"));
  const [ua, ub] = await Promise.all([units(from.version), units(to.version)]);
  const pages = groupByPage(diffUnits(ua, ub));
  return { ...base, hasText: ua.length > 0 || ub.length > 0, pages, totals: totals(pages), contentChanged: pages.length > 0 };
}

/** Running reviews that contain the version. */
export async function runningReviewsOf(db: Db, projectId: string, versionId: string) {
  return db
    .select({ reviewId: reviews.id, number: reviews.number, name: reviews.name, code: reviews.code })
    .from(reviewFiles)
    .innerJoin(reviews, eq(reviews.id, reviewFiles.reviewId))
    .innerJoin(workflowInstances, and(eq(workflowInstances.subjectType, "review"), eq(workflowInstances.subjectId, reviews.id)))
    .where(and(eq(reviewFiles.fileVersionId, versionId), eq(reviews.projectId, projectId), inArray(workflowInstances.status, ["running"])));
}

export { compareFlags };
