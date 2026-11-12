/**
 * Document revision comparison ("Revizyon karşılaştır"):
 *   GET  /projects/:pid/doc-compare?from=&to=[&rebuild=1][&wait=ms]   cached comparison of two versions (started when missing)
 *   GET  /projects/:pid/doc-compare/:cid[?wait=ms]                    poll (text diff, AI summary progress)
 *   PUT  /projects/:pid/doc-compare/:cid/regions                      change regions from the browser's pixel diff
 *   POST /projects/:pid/doc-compare/:cid/summary {force?}             start the AI "Değişiklik özeti" (async)
 *   POST /projects/:pid/doc-compare/:cid/report {thumbnails}          comparison report (PDF)
 *   POST /projects/:pid/doc-compare/:cid/review-note {reviewId}       summary as a note on a running review
 *
 * The model only ever receives the compact difference description (see doccompare/ai.ts).
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, type DocCompareDto, type DocCompareResult, type PageRegions, type SummaryBullet } from "@sitekeep/shared";
import type { ResolvedDeps } from "../../app/deps.js";
import { isUuid, type AuthUser } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { docComparisons, workflowActions } from "../../db/schema.js";
import { HttpError, badRequest, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage, tFor } from "../../i18n/index.js";
import { PROMPT_LANGUAGE, linkBullets } from "../../doccompare/ai.js";
import { comparisonReportPdf } from "../../doccompare/report.js";
import { DocCompareService, comparisonKind, comparisonNote, providerOrNote, runningReviewsOf, type ComparisonRow, type Side } from "../../doccompare/service.js";
import { compareFlags, deterministicSummary, localizeAntetChanges } from "../../doccompare/text-diff.js";
import { loadInstance } from "../../workflow/reviews.js";
import { loadVersion, requireView } from "../../modules/documents/files.js";
import { loadVisibleReview } from "../../workflow/review-access.js";

const nbox = z.object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) });
const regionsSchema = z.object({
  pages: z
    .array(
      z.object({
        page: z.number().int().min(1).max(100_000),
        only: z.enum(["A", "B"]).optional(),
        regions: z
          .array(z.object({ box: nbox, kind: z.enum(["added", "removed", "changed"]), pixels: z.number().int().min(0).max(1e9) }))
          .max(300),
      }),
    )
    .max(2000),
});
const reportSchema = z.object({
  thumbnails: z
    .array(
      z.object({
        page: z.number().int().min(1).max(100_000),
        image: z
          .string()
          .max(2_500_000)
          .refine((s) => /^data:image\/(png|jpeg);base64,/.test(s), "image bir PNG/JPEG data URL olmalı"), // i18n-ok: zod detail (the client sends rendered images)
      }),
    )
    .max(16)
    .default([]),
});

type Loaded = { a: Awaited<ReturnType<typeof loadVersion>>["a"]; from: Side; to: Side; toTree: Awaited<ReturnType<typeof loadVersion>>["tree"] };

export async function docCompareRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, secretKey } = deps;
  const service = new DocCompareService(db, storage, (m, x) => api.log.warn({ x }, m));

  /** Both versions, each checked for view rights. */
  async function loadPair(pid: string, from: string, to: string, user: AuthUser): Promise<Loaded> {
    const a = await loadVersion(db, pid, from, user);
    requireView(a.tree, a.a, a.file);
    const b = await loadVersion(db, pid, to, user);
    requireView(b.tree, b.a, b.file);
    return { a: b.a, from: { file: a.file, version: a.version }, to: { file: b.file, version: b.version }, toTree: b.tree };
  }

  async function loadComparison(pid: string, cid: string, user: AuthUser): Promise<{ row: ComparisonRow } & Loaded> {
    if (!isUuid(cid)) throw notFound(msg("doccompare:entities.comparison"));
    const row = await service.get(cid);
    if (!row || row.projectId !== pid) throw notFound(msg("doccompare:entities.comparison"));
    return { row, ...(await loadPair(pid, row.fromVersionId, row.toVersionId, user)) };
  }

  async function wait(id: string, ms: number | undefined) {
    const t = Math.min(Math.max(Number(ms) || 0, 0), 60_000);
    if (!t) return;
    const end = Date.now() + t;
    await service.waitText(id, t);
    await service.waitAi(id, Math.max(0, end - Date.now()));
  }

  async function toDto(row: ComparisonRow, l: Loaded, lang: string): Promise<DocCompareDto> {
    const t = tFor(lang);
    const { provider, note } = await providerOrNote(db, secretKey, l.a.project.id, lang);
    const stored = row.result as DocCompareResult | null;
    // Texts written by the comparison run are shown in the reader's language.
    const result = stored ? { ...stored, note: comparisonNote(stored, lang), antet: localizeAntetChanges(stored.antet, lang) } : null;
    const regions = (row.regions as PageRegions[] | null) ?? null;
    const flags = result ? compareFlags(result, regions, lang) : [];
    const summary: SummaryBullet[] = result ? deterministicSummary(result, regions, flags, lang) : [];
    const progress = service.aiProgress(row.id);
    let aiStatus = row.aiStatus;
    let aiError = row.aiError;
    if (aiStatus === "running" && !service.isAiRunning(row.id)) {
      aiStatus = "failed";
      aiError = t("doccompare:ai.interrupted");
    }
    const reviews = [];
    for (const r of await runningReviewsOf(db, l.a.project.id, l.to.version.id)) {
      try {
        await loadVisibleReview(db, l.a, r.reviewId);
        reviews.push(r);
      } catch {
        /* not visible to the caller */
      }
    }
    return {
      id: row.id,
      projectId: row.projectId,
      from: { versionId: l.from.version.id, fileId: l.from.file.id, fileName: l.from.file.name, version: l.from.version.version, revision: result?.revisionA ?? null },
      to: { versionId: l.to.version.id, fileId: l.to.file.id, fileName: l.to.file.name, version: l.to.version.version, revision: result?.revisionB ?? null },
      status: row.status,
      error: row.error,
      result,
      regions,
      flags,
      summary,
      ai: {
        available: !!provider,
        note: provider ? (provider.external ? t("doccompare:ai.externalProvider", { name: provider.name }) : null) : note,
        status: aiStatus,
        bullets: result && row.aiBullets ? linkBullets(row.aiBullets, result, regions) : [],
        model: row.aiModel,
        error: aiError,
        progress: progress
          ? progress.chars
            ? t("doccompare:ai.writing", { chars: progress.chars, seconds: progress.seconds })
            : t("doccompare:ai.thinking", { seconds: progress.seconds })
          : null,
        startedAt: row.aiStartedAt?.toISOString() ?? null,
        finishedAt: row.aiFinishedAt?.toISOString() ?? null,
      },
      activeReviews: reviews,
      canMarkup: can(l.toTree.permission(l.a.principal, l.to.file.folderId).level, "markup"),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  api.get<{ Params: { pid: string }; Querystring: { from?: string; to?: string; rebuild?: string; wait?: string } }>(
    "/projects/:pid/doc-compare",
    async (req) => {
      const { from, to } = req.query;
      if (!isUuid(from) || !isUuid(to)) throw badRequest(msg("doccompare:errors.versionIdsRequired"));
      if (from === to) throw badRequest(msg("doccompare:errors.sameVersion"));
      const l = await loadPair(req.params.pid, from, to, req.user!);
      const { error } = comparisonKind(l.from.file.name, l.to.file.name);
      if (error) throw badRequest(error);
      const row = await service.ensure(l.a.project.id, l.from, l.to, l.a.user.id, req.query.rebuild === "1");
      await wait(row.id, Number(req.query.wait));
      return toDto((await service.get(row.id))!, l, requestLanguage(req));
    },
  );

  api.get<{ Params: { pid: string; cid: string }; Querystring: { wait?: string } }>("/projects/:pid/doc-compare/:cid", async (req) => {
    const l = await loadComparison(req.params.pid, req.params.cid, req.user!);
    if (l.row.status === "running" && !service.isTextRunning(l.row.id)) await service.ensure(l.a.project.id, l.from, l.to, l.a.user.id);
    await wait(l.row.id, Number(req.query.wait));
    return toDto((await service.get(l.row.id))!, l, requestLanguage(req));
  });

  api.put<{ Params: { pid: string; cid: string } }>("/projects/:pid/doc-compare/:cid/regions", async (req) => {
    const l = await loadComparison(req.params.pid, req.params.cid, req.user!);
    const body = regionsSchema.parse(req.body);
    const pages = body.pages.filter((p) => p.regions.length || p.only).sort((x, y) => x.page - y.page);
    const [row] = await db
      .update(docComparisons)
      .set({ regions: pages, regionsAt: new Date(), updatedAt: new Date() })
      .where(eq(docComparisons.id, l.row.id))
      .returning();
    return toDto(row!, l, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; cid: string } }>("/projects/:pid/doc-compare/:cid/summary", async (req) => {
    const l = await loadComparison(req.params.pid, req.params.cid, req.user!);
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    if (l.row.status !== "done" || !l.row.result) throw new HttpError(409, "not_ready", msg("doccompare:errors.textNotReady"));
    const { provider, note } = await providerOrNote(db, secretKey, l.a.project.id, requestLanguage(req));
    if (!provider) throw new HttpError(409, "ai_unavailable", note ?? msg("doccompare:errors.aiUnavailable"));
    const cached = l.row.aiStatus === "done" && !body.force;
    if (!cached && !service.isAiRunning(l.row.id)) {
      const id = l.row.id;
      const started = service.startAi(l.row, provider, async () => {
        const fresh = (await service.get(id))!;
        const result = fresh.result as DocCompareResult;
        const regions = (fresh.regions as PageRegions[] | null) ?? null;
        return {
          fileA: l.from.file.name,
          fileB: l.to.file.name,
          versionA: l.from.version.version,
          versionB: l.to.version.version,
          result,
          regions,
          flags: compareFlags(result, regions, PROMPT_LANGUAGE),
        };
      });
      if (started)
        await audit(db, {
          projectId: l.a.project.id,
          userId: l.a.user.id,
          action: "doc_compare.ai_summary",
          targetType: "file",
          targetId: l.to.file.id,
          details: { comparisonId: id, from: l.from.version.version, to: l.to.version.version, model: provider.model, external: provider.external },
        });
      // Let the run mark itself as running before answering.
      await new Promise((r) => setImmediate(r));
    }
    return toDto((await service.get(l.row.id))!, l, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; cid: string } }>("/projects/:pid/doc-compare/:cid/report", async (req, reply) => {
    const l = await loadComparison(req.params.pid, req.params.cid, req.user!);
    if (l.row.status !== "done" || !l.row.result) throw new HttpError(409, "not_ready", msg("doccompare:errors.notReady"));
    const body = reportSchema.parse(req.body ?? {});
    const lang = requestLanguage(req);
    const dto = await toDto(l.row, l, lang);
    const aiUsed = dto.ai.status === "done" && dto.ai.bullets.length > 0;
    const pdf = await comparisonReportPdf({
      projectCode: l.a.project.code,
      projectName: l.a.project.name,
      fileA: l.from.file.name,
      fileB: l.to.file.name,
      versionA: l.from.version.version,
      versionB: l.to.version.version,
      result: dto.result!,
      regions: dto.regions,
      flags: dto.flags,
      summary: aiUsed ? dto.ai.bullets : dto.summary,
      ai: { used: aiUsed, model: dto.ai.model, note: dto.ai.available ? null : dto.ai.note },
      thumbnails: body.thumbnails.map((t) => ({
        page: t.page,
        png: t.image.startsWith("data:image/png"),
        bytes: new Uint8Array(Buffer.from(t.image.slice(t.image.indexOf(",") + 1), "base64")),
      })),
      preparedBy: l.a.user.name,
      date: new Date(),
      lang,
    });
    await audit(db, {
      projectId: l.a.project.id,
      userId: l.a.user.id,
      action: "doc_compare.report",
      targetType: "file",
      targetId: l.to.file.id,
      details: { comparisonId: l.row.id, from: l.from.version.version, to: l.to.version.version },
    });
    const base = l.to.file.name.replace(/\.[^.]+$/, "");
    const name = `${base}_V${l.from.version.version}-V${l.to.version.version}_${tFor(lang)("doccompare:report.fileSuffix")}.pdf`;
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(Buffer.from(pdf));
  });

  api.post<{ Params: { pid: string; cid: string } }>("/projects/:pid/doc-compare/:cid/review-note", async (req) => {
    const l = await loadComparison(req.params.pid, req.params.cid, req.user!);
    const body = z.object({ reviewId: z.string().uuid() }).parse(req.body);
    const running = await runningReviewsOf(db, l.a.project.id, l.to.version.id);
    const review = running.find((r) => r.reviewId === body.reviewId);
    if (!review) throw badRequest(msg("doccompare:errors.notInReview"));
    await loadVisibleReview(db, l.a, review.reviewId);
    const lang = requestLanguage(req);
    const t = tFor(lang);
    const dto = await toDto(l.row, l, lang);
    const aiUsed = dto.ai.status === "done" && dto.ai.bullets.length > 0;
    const bullets = aiUsed ? dto.ai.bullets : dto.summary;
    const comment = [
      t(aiUsed ? "doccompare:reviewNote.titleAi" : "doccompare:reviewNote.title", {
        file: l.to.file.name,
        from: l.from.version.version,
        to: l.to.version.version,
      }),
      ...bullets.map((b) => `• ${b.page ? `[s.${b.page}] ` : ""}${b.text}`),
    ]
      .join("\n")
      .slice(0, 5000);
    const instance = await loadInstance(db, review.reviewId);
    const [action] = await db
      .insert(workflowActions)
      .values({
        instanceId: instance.id,
        stepIndex: instance.stepIndex,
        kind: "note",
        userId: l.a.user.id,
        comment,
        details: { comparisonId: l.row.id, fromVersionId: l.from.version.id, toVersionId: l.to.version.id },
      })
      .returning();
    await audit(db, {
      projectId: l.a.project.id,
      userId: l.a.user.id,
      action: "doc_compare.review_note",
      targetType: "review",
      targetId: review.reviewId,
      details: { comparisonId: l.row.id, number: review.number },
    });
    return { ok: true, actionId: action!.id };
  });

}
