import { AiError, resolveProvider } from "../ai/provider.js";
import { overrideProvider } from "../ai/override.js";
import type { ReportLlm } from "../reports/llm.js";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  REPORT_HTML_MAX_BYTES,
  REPORT_MODULES,
  REPORT_SHARING,
  byteLength,
  reportQueryDatasets,
  type DashboardDto,
  type DashboardSummaryDto,
  type DashboardVersionDto,
  type ReportCatalogDto,
  type ReportDataResult,
  type ReportDraft,
  type ReportGenerateResult,
  type ReportModuleDto,
  type ReportQueryRef,
  type ReportRepairResult,
  type ReportStampDto,
  reportModuleEnabled,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { isUuid, projectAccess, userNames, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { dashboardVersions, dashboards, projectMembers, users } from "../db/schema.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { projectModules, requireModule } from "../projects/modules.js";
import { labelFor, msg, render, requestLanguage, tFor } from "../i18n/index.js";
import "../reports/all.js";
import { REPORT_TIME_ZONE, createReportContext, reportDatasets, type ReportContext } from "../reports/datasets.js";
import { extractJson, stripThinking } from "../reports/llm.js";
import { PROMPT_LANGUAGE, planMessages, repairMessage, repairQueryMessages } from "../reports/prompt.js";
import { queryProblems, runQueries } from "../reports/run.js";
import { parseDraft } from "../reports/draft.js";
import { htmlSchema, normalizeQueryRefs, querySpecSchema, queryRefsSchema, zodMessages } from "../reports/spec.js";
import { applyFieldMap, missingFields } from "../reports/repair.js";
import { readStamp } from "../reports/stamp.js";
import { blankDashboardHtml, examplePrompts, moduleExamplePrompts, reportTemplates } from "../reports/templates.js";

type DashboardRow = typeof dashboards.$inferSelect;

const sharingSchema = z.enum(REPORT_SHARING);
const nameSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(2000).nullable().optional();
const queriesInput = z.preprocess(normalizeQueryRefs, queryRefsSchema);

const htmlTooLarge = () => new HttpError(413, "too_large", msg("reports:errors.htmlTooLarge", { kb: REPORT_HTML_MAX_BYTES / 1024 }));

export async function reportRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /**
   * The report builder's model: an explicitly configured one (AI_* env) or the project's
   * provider from the admin settings, which applies the system mode (off / local only /
   * external) and the project policy.
   */
  async function llmFor(projectId: string): Promise<ReportLlm | null> {
    // AI task queue / developer evaluation: resolveProvider returns the replaced model (after the
    // AI policy checks) for this one in-process call, even when AI_* env configures a builder.
    if (deps.reportLlm && !overrideProvider()) return deps.reportLlm;
    if (!deps.secretKey) return null;
    try {
      const provider = await resolveProvider(db, deps.secretKey, projectId);
      return {
        complete: async (messages) =>
          (await provider.chat(messages, { maxTokens: 8000, timeoutMs: 15 * 60_000, json: true })).text,
      };
    } catch (err) {
      if (err instanceof AiError) return null;
      throw err;
    }
  }

  /**
   * Datasets the caller may use, built-in templates (only those whose datasets the caller may use),
   * module families with their datasets and example prompts, and whether the AI builder is available.
   */
  api.get<{ Params: { pid: string } }>("/projects/:pid/reports/catalog", async (req): Promise<ReportCatalogDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const lang = requestLanguage(req);
    // Datasets and templates of modules that are off in this project are left out.
    const datasets = enabledDatasets(a, lang);
    const usable = new Set(datasets.map((d) => d.name));
    const examples = moduleExamplePrompts(lang);
    const modules: ReportModuleDto[] = REPORT_MODULES.map((m) => ({
      key: m,
      label: labelFor(lang, "reportModule", m),
      datasets: datasets.filter((d) => d.module === m).map((d) => d.name),
      examples: examples[m],
    })).filter((m) => m.datasets.length);
    return {
      aiAvailable: !!(await llmFor(a.project.id)),
      datasets,
      templates: reportTemplates(lang).filter(
        (t) => reportModuleEnabled(projectModules(a.project), t.module) && t.queries.every((q) => usable.has(q.spec.dataset)),
      ),
      examplePrompts: examplePrompts(lang),
      modules,
      labelDatasets: reportDatasets.describe({ access: a }, lang).filter((d) => !usable.has(d.name)),
    };
  });

  /** Ad-hoc queries, executed with the caller's permissions. */
  api.post<{ Params: { pid: string } }>("/projects/:pid/reports/query", async (req): Promise<ReportDataResult> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ queries: queriesInput, strict: z.boolean().default(true) }).parse(req.body);
    const lang = requestLanguage(req);
    const ctx = createReportContext(db, a, { lang });
    const stamp = await stampOf(a.project.id, body.queries);
    const r = await runQueries(ctx, body.queries, { strict: body.strict, lang });
    return { ...r, generatedAt: ctx.now.toISOString(), stamp: stamp.stamp };
  });

  /**
   * Change stamp of the data behind the given datasets (comma-separated), for drafts that are not
   * saved yet. Cheap: one indexed read, no dataset is loaded.
   */
  api.get<{ Params: { pid: string }; Querystring: { datasets?: string } }>(
    "/projects/:pid/reports/stamp",
    async (req): Promise<ReportStampDto> => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const names = (req.query.datasets ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 40);
      return readStamp(db, a.project.id, reportDatasets.sourcesOf(names), { timeZone: REPORT_TIME_ZONE });
    },
  );

  // ---- Dashboards ----------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/reports", async (req): Promise<DashboardSummaryDto[]> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await db
      .select()
      .from(dashboards)
      .where(eq(dashboards.projectId, a.project.id))
      .orderBy(desc(dashboards.updatedAt));
    const companies = await memberCompanies(db, a.project.id);
    const visible = rows.filter((d) => canView(d, a, companies));
    const names = await userNames(db, visible.map((d) => d.ownerId));
    return visible.map((d) => toSummary(d, a, names));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/reports", async (req): Promise<DashboardDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "reports");
    const body = z
      .object({
        name: nameSchema.optional(),
        description: descriptionSchema,
        queries: queriesInput.optional(),
        html: z.string().optional(),
        sharing: sharingSchema.default("private"),
        templateId: z.string().max(60).optional(),
      })
      .parse(req.body);
    const lang = requestLanguage(req);
    const template = body.templateId ? reportTemplates(lang).find((t) => t.id === body.templateId) : undefined;
    if (body.templateId && !template) throw notFound(msg("reports:entities.template"));
    const draft = {
      name: body.name ?? template?.name ?? tFor(lang)("reports:defaults.dashboardName"),
      description: body.description ?? template?.description ?? null,
      queries: body.queries ?? template?.queries ?? [],
      html: body.html ?? template?.html ?? blankDashboardHtml(lang),
    };
    checkContent(draft.html, draft.queries, a, lang);
    const row = await db.transaction(async (tx) => {
      const [d] = await tx
        .insert(dashboards)
        .values({ projectId: a.project.id, ownerId: a.user.id, ...draft, sharing: body.sharing })
        .returning();
      await tx.insert(dashboardVersions).values(versionValues(d!, a.user.id));
      return d!;
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "report.created",
      targetType: "dashboard",
      targetId: row.id,
      details: { name: row.name, sharing: row.sharing, templateId: template?.id, htmlBytes: byteLength(row.html) },
    });
    return toDto(row, a, new Map([[a.user.id, a.user.name]]));
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/reports/:id", async (req): Promise<DashboardDto> => {
    const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
    return toDto(d, a, await userNames(db, [d.ownerId]));
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/reports/:id", async (req): Promise<DashboardDto> => {
    const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
    requireEdit(d, a);
    const body = z
      .object({
        name: nameSchema.optional(),
        description: descriptionSchema,
        queries: queriesInput.optional(),
        html: z.string().optional(),
        sharing: sharingSchema.optional(),
        /** Optimistic concurrency: the version the editor started from. */
        baseVersion: z.number().int().positive().optional(),
      })
      .parse(req.body);
    if (body.baseVersion !== undefined && body.baseVersion !== d.version)
      throw new HttpError(409, "conflict", msg("reports:errors.changedMeanwhile"));
    if (body.sharing && body.sharing !== d.sharing && d.ownerId !== a.user.id)
      throw forbidden(msg("reports:errors.sharingOwnerOnly"));
    const next = {
      name: body.name ?? d.name,
      description: body.description !== undefined ? body.description : d.description,
      queries: body.queries ?? d.queries,
      html: body.html ?? d.html,
      sharing: body.sharing ?? d.sharing,
    };
    checkContent(next.html, next.queries, a, requestLanguage(req));
    const row = await saveVersion(d, next, a.user.id);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "report.updated",
      targetType: "dashboard",
      targetId: d.id,
      details: {
        version: row.version,
        changed: Object.keys(body).filter((k) => k !== "baseVersion"),
        htmlBytes: byteLength(row.html),
      },
    });
    return toDto(row, a, await userNames(db, [row.ownerId]));
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/reports/:id", async (req) => {
    const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
    requireEdit(d, a);
    await db.delete(dashboards).where(eq(dashboards.id, d.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "report.deleted",
      targetType: "dashboard",
      targetId: d.id,
      details: { name: d.name },
    });
    return { ok: true };
  });

  api.get<{ Params: { pid: string; id: string } }>(
    "/projects/:pid/reports/:id/versions",
    async (req): Promise<DashboardVersionDto[]> => {
      const { d } = await loadVisible(req.params.pid, req.params.id, req.user!);
      const rows = await db
        .select()
        .from(dashboardVersions)
        .where(eq(dashboardVersions.dashboardId, d.id))
        .orderBy(desc(dashboardVersions.version));
      const names = await userNames(db, rows.map((r) => r.createdBy));
      return rows.map((r) => toVersionDto(r, names, false));
    },
  );

  api.get<{ Params: { pid: string; id: string; v: string } }>(
    "/projects/:pid/reports/:id/versions/:v",
    async (req): Promise<DashboardVersionDto> => {
      const { d } = await loadVisible(req.params.pid, req.params.id, req.user!);
      const r = await loadVersion(d.id, req.params.v);
      return toVersionDto(r, await userNames(db, [r.createdBy]), true);
    },
  );

  api.post<{ Params: { pid: string; id: string; v: string } }>(
    "/projects/:pid/reports/:id/versions/:v/restore",
    async (req): Promise<DashboardDto> => {
      const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
      requireEdit(d, a);
      const r = await loadVersion(d.id, req.params.v);
      const row = await saveVersion(
        d,
        { name: r.name, description: r.description, queries: r.queries, html: r.html, sharing: d.sharing },
        a.user.id,
      );
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "report.restored",
        targetType: "dashboard",
        targetId: d.id,
        details: { from: r.version, version: row.version },
      });
      return toDto(row, a, await userNames(db, [row.ownerId]));
    },
  );

  /**
   * Runs the dashboard's queries as the VIEWER: shared dashboards show each viewer only their data.
   * Always current data (and the newest file / schedule / model versions), never a snapshot. The
   * stamp is read BEFORE the queries run, so a write during the run triggers one more refresh.
   * Saved queries are validated against the current dataset registry: a query whose field was
   * renamed or removed comes back with errorKinds[id] = "invalid" and a Turkish message.
   */
  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/reports/:id/data", async (req): Promise<ReportDataResult> => {
    const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
    const lang = requestLanguage(req);
    const ctx = createReportContext(db, a, { lang });
    const stamp = await stampOf(a.project.id, d.queries);
    const r = await runQueries(ctx, d.queries, { lang });
    return { ...r, generatedAt: ctx.now.toISOString(), stamp: stamp.stamp };
  });

  /**
   * Live refresh: the open dashboard polls this (every ~25 s while visible) and re-runs its queries
   * only when the stamp differs from the one its data came with.
   */
  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/reports/:id/stamp", async (req): Promise<ReportStampDto> => {
    const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
    return stampOf(a.project.id, d.queries);
  });

  /**
   * "Yapay zekâ ile onar": asks the model to fix ONE saved query that no longer fits its dataset.
   * Only the query, its error and the dataset's fields are sent. Nothing is saved; the editor
   * applies the returned spec with a normal update.
   */
  api.post<{ Params: { pid: string; id: string } }>(
    "/projects/:pid/reports/:id/repair",
    async (req): Promise<ReportRepairResult> => {
      const { a, d } = await loadVisible(req.params.pid, req.params.id, req.user!);
      requireEdit(d, a);
      const lang = requestLanguage(req);
      const body = z.object({ queryId: z.string().min(1).max(60) }).parse(req.body);
      const q = d.queries.find((x) => x.id === body.queryId);
      if (!q) throw notFound(msg("reports:entities.query"));
      // Everything below goes to the model: dataset catalog and problems in PROMPT_LANGUAGE.
      const def = reportDatasets.describe({ access: a }, PROMPT_LANGUAGE).find((x) => x.name === q.spec.dataset);
      if (!def) throw badRequest(msg("reports:errors.datasetGone", { dataset: q.spec.dataset }));
      const problem = queryProblems([q], { access: a }, undefined, PROMPT_LANGUAGE)[0];
      if (!problem) throw badRequest(msg("reports:errors.nothingToRepair"));
      const llm = await llmFor(a.project.id);
      if (!llm) throw new HttpError(503, "ai_unavailable", msg("reports:errors.aiNotConfigured"));
      const source = reportDatasets.get(q.spec.dataset)!;
      const messages = repairQueryMessages(def, q.id, q.spec, problem.messages.join(" "), missingFields(q.spec, source));
      let errors: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        let text: string;
        try {
          text = await llm.complete(messages);
        } catch (err) {
          throw new HttpError(502, "ai_failed", msg("reports:errors.aiNoAnswer", { error: errorText(err, lang).slice(0, 350) }));
        }
        let raw: unknown;
        try {
          raw = extractJson(text);
        } catch (e) {
          errors = [(e as Error).message];
          messages.push({ role: "assistant", content: stripThinking(text).slice(0, 20_000) }, repairMessage(errors));
          continue;
        }
        const obj = (raw && typeof raw === "object" ? raw : {}) as { spec?: unknown; replace?: unknown; note?: unknown };
        // Preferred: a field mapping applied to the saved query (intent, output names, sort and
        // limit stay as saved). Otherwise a whole spec, with the saved limit kept.
        const replace = obj.replace && typeof obj.replace === "object" && !Array.isArray(obj.replace) ? (obj.replace as Record<string, unknown>) : null;
        const map = replace
          ? Object.fromEntries(
              Object.entries(replace)
                .filter(([, v]) => v === null || typeof v === "string")
                .map(([k, v]) => [k, typeof v === "string" && v.trim() && v.trim() !== "null" ? v.trim() : null]),
            )
          : null;
        const candidate = map
          ? applyFieldMap(q.spec, map)
          : obj.spec && typeof obj.spec === "object"
            ? { ...(obj.spec as object), dataset: q.spec.dataset, limit: q.spec.limit }
            : obj.spec;
        const parsed = querySpecSchema.safeParse(candidate);
        errors = parsed.success
          ? (queryProblems([{ id: q.id, spec: parsed.data }], { access: a }, undefined, PROMPT_LANGUAGE)[0]?.messages ?? [])
          : zodMessages(parsed.error, "spec.");
        if (parsed.success && !errors.length) {
          await audit(db, {
            projectId: a.project.id,
            userId: a.user.id,
            action: "report.repaired",
            targetType: "dashboard",
            targetId: d.id,
            details: { queryId: q.id, attempts: attempt },
          });
          return { queryId: q.id, spec: parsed.data, note: typeof obj.note === "string" ? obj.note.slice(0, 300) : "" };
        }
        messages.push({ role: "assistant", content: stripThinking(text).slice(0, 20_000) }, repairMessage(errors));
      }
      throw new HttpError(422, "ai_invalid", msg("reports:errors.aiRepairFailed"), { errors });
    },
  );

  // ---- AI builder ----------------------------------------------------------------------

  /**
   * Asks the model for {name, description, queries, html}; invalid answers are sent back
   * once with the problems. Queries run as the caller for the preview. Nothing is saved.
   */
  api.post<{ Params: { pid: string } }>("/projects/:pid/reports/generate", async (req): Promise<ReportGenerateResult> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "reports");
    const llm = await llmFor(a.project.id);
    if (!llm) throw new HttpError(503, "ai_unavailable", msg("reports:errors.aiNotConfigured"));
    const lang = requestLanguage(req);
    const body = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        dashboardId: z.string().optional(),
        current: z
          .object({
            name: z.string().max(200),
            description: z.string().max(2000).nullable().optional(),
            queries: queriesInput,
            html: htmlSchema,
          })
          .optional(),
        /** Module the builder was opened from: its datasets go to the prompt (see reports/router.ts). */
        module: z.enum(REPORT_MODULES).optional(),
        /** Datasets to describe in any case. */
        datasets: z.array(z.string().max(60)).max(10).optional(),
      })
      .parse(req.body);
    let current: ReportDraft | undefined = body.current;
    if (!current && body.dashboardId) {
      const { d } = await loadVisible(req.params.pid, body.dashboardId, req.user!);
      current = { name: d.name, description: d.description, queries: d.queries, html: d.html };
    }
    const ctx = createReportContext(db, a, { lang });
    const plan = planMessages(enabledDatasets(a, PROMPT_LANGUAGE), a.project, body.prompt, current, {
      module: body.module,
      datasets: body.datasets,
    });
    const messages = plan.messages;
    req.log.info({ datasets: plan.datasets, matched: plan.matched, systemTokens: plan.systemTokens }, "report prompt");

    let attempts = 0;
    let errors: string[] = [];
    while (attempts < 2) {
      attempts++;
      let text: string;
      try {
        text = await llm.complete(messages);
      } catch (err) {
        req.log.warn({ err }, "report LLM call failed");
        await auditGenerate(a, body, attempts, false, !!current);
        throw new HttpError(502, "ai_failed", msg("reports:errors.aiNoAnswer", { error: errorText(err, lang).slice(0, 350) }));
      }
      const parsed = parseDraft(text, ctx, lang);
      if ("draft" in parsed) {
        const stamp = await stampOf(a.project.id, parsed.draft.queries);
        const r = await runQueries(ctx, parsed.draft.queries, { lang });
        await auditGenerate(a, body, attempts, true, !!current);
        return { draft: parsed.draft, attempts, ...r, generatedAt: ctx.now.toISOString(), stamp: stamp.stamp };
      }
      errors = parsed.errors;
      messages.push({ role: "assistant", content: stripThinking(text).slice(0, 60_000) }, repairMessage(errors));
    }
    await auditGenerate(a, body, attempts, false, !!current);
    throw new HttpError(422, "ai_invalid", msg("reports:errors.aiInvalidDashboard"), {
      errors,
    });
  });

  async function auditGenerate(
    a: ProjectAccess,
    body: { prompt: string; dashboardId?: string },
    attempts: number,
    ok: boolean,
    edit: boolean,
  ) {
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "report.generated",
      targetType: "dashboard",
      targetId: body.dashboardId,
      details: { promptLength: body.prompt.length, attempts, ok, mode: edit ? "edit" : "new" },
    });
  }

  // ---- Helpers -------------------------------------------------------------------------

  /** Datasets the caller may use whose module is on in the project, described in `lang`. */
  function enabledDatasets(a: ProjectAccess, lang: string) {
    const modules = projectModules(a.project);
    return reportDatasets.describe({ access: a }, lang).filter((d) => reportModuleEnabled(modules, d.module));
  }

  /** Change stamp of the data behind some queries. */
  function stampOf(projectId: string, queries: ReportQueryRef[]) {
    return readStamp(db, projectId, reportDatasets.sourcesOf(reportQueryDatasets(queries)), { timeZone: REPORT_TIME_ZONE });
  }

  async function loadVisible(pid: string, id: string, user: NonNullable<import("fastify").FastifyRequest["user"]>) {
    const a = await projectAccess(db, pid, user);
    if (!isUuid(id)) throw notFound(msg("reports:entities.dashboard"));
    const [d] = await db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.projectId, a.project.id)));
    if (!d || !canView(d, a, await memberCompanies(db, a.project.id))) throw notFound(msg("reports:entities.dashboard"));
    return { a, d };
  }

  async function loadVersion(dashboardId: string, v: string) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw notFound(msg("reports:entities.version"));
    const [r] = await db
      .select()
      .from(dashboardVersions)
      .where(and(eq(dashboardVersions.dashboardId, dashboardId), eq(dashboardVersions.version, n)));
    if (!r) throw notFound(msg("reports:entities.version"));
    return r;
  }

  async function saveVersion(
    d: DashboardRow,
    next: Pick<DashboardRow, "name" | "description" | "queries" | "html" | "sharing">,
    userId: string,
  ): Promise<DashboardRow> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(dashboards)
        .set({ ...next, version: d.version + 1, updatedAt: new Date() })
        .where(and(eq(dashboards.id, d.id), eq(dashboards.version, d.version)))
        .returning();
      if (!row) throw new HttpError(409, "conflict", msg("reports:errors.changedMeanwhile"));
      await tx.insert(dashboardVersions).values(versionValues(row, userId));
      return row;
    });
  }
}


function checkContent(html: string, queries: ReportQueryRef[], a: ProjectAccess, lang: string) {
  if (byteLength(html) > REPORT_HTML_MAX_BYTES) throw htmlTooLarge();
  const problems = queryProblems(queries, { access: a }, undefined, lang);
  if (problems.length) {
    const p = problems[0]!;
    throw badRequest(msg("reports:errors.invalidQuery", { id: p.id, problems: p.messages.join(" ") }), problems);
  }
}

/** Company each member represents in the project. */
async function memberCompanies(db: Db, projectId: string): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ userId: projectMembers.userId, companyId: projectMembers.companyId, userCompany: users.companyId })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  return new Map(rows.map((r) => [r.userId, r.companyId ?? r.userCompany]));
}

export function canView(d: DashboardRow, a: ProjectAccess, companies: Map<string, string | null>): boolean {
  if (d.ownerId === a.user.id) return true;
  switch (d.sharing) {
    case "project":
      return true;
    case "admins":
      return a.isProjectAdmin;
    case "company": {
      const owner = companies.get(d.ownerId);
      return !!owner && owner === a.principal.companyId;
    }
    default:
      return false;
  }
}

function canEdit(d: DashboardRow, a: ProjectAccess): boolean {
  return d.ownerId === a.user.id || a.isProjectAdmin;
}

function requireEdit(d: DashboardRow, a: ProjectAccess) {
  if (!canEdit(d, a)) throw forbidden(msg("reports:errors.editOwnerOrAdmin"));
}

function versionValues(d: DashboardRow, userId: string) {
  return {
    dashboardId: d.id,
    version: d.version,
    name: d.name,
    description: d.description,
    queries: d.queries,
    html: d.html,
    sharing: d.sharing,
    createdBy: userId,
  };
}

function toSummary(d: DashboardRow, a: ProjectAccess, names: Map<string, string>): DashboardSummaryDto {
  return {
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    ownerId: d.ownerId,
    ownerName: names.get(d.ownerId),
    sharing: d.sharing,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    isMine: d.ownerId === a.user.id,
    canEdit: canEdit(d, a),
  };
}

function toDto(d: DashboardRow, a: ProjectAccess, names: Map<string, string>): DashboardDto {
  return { ...toSummary(d, a, names), queries: d.queries, html: d.html };
}

function toVersionDto(
  r: typeof dashboardVersions.$inferSelect,
  names: Map<string, string>,
  full: boolean,
): DashboardVersionDto {
  return {
    version: r.version,
    name: r.name,
    description: r.description,
    sharing: r.sharing,
    createdBy: r.createdBy,
    createdByName: r.createdBy ? names.get(r.createdBy) : undefined,
    createdAt: r.createdAt.toISOString(),
    ...(full ? { queries: r.queries, html: r.html } : {}),
  };
}

/** Text of an error in a language (HttpError messages translated, others as they are). */
function errorText(err: unknown, lang: string): string {
  if (err instanceof HttpError && err.msg) return render(lang, err.msg);
  return err instanceof Error ? err.message : String(err);
}
