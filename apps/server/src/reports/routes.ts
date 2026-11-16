/**
 * Report datasets (Community): the catalog of datasets the caller may use, queries over them with
 * the caller's permissions, change stamps for live refresh and the fixed per-dataset lists with
 * CSV export (docs/features/REPORTS.md). Saved dashboards, templates and the AI builder are the
 * Platform module's (docs/modules/platform.md); it adds its part of the catalog through the
 * `platform.reports` capability and serves its own /reports/:id routes.
 */
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  REPORT_MAX_ROWS,
  REPORT_MODULES,
  reportModuleEnabled,
  reportQueryDatasets,
  type ReportCatalogDto,
  type ReportDataResult,
  type ReportModuleDto,
  type ReportScalar,
  type ReportStampDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { projectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { notFound } from "../core/platform/http.js";
import { projectModules } from "../projects/modules.js";
import { labelFor, msg, requestLanguage, tFor } from "../i18n/index.js";
import { capability } from "../sdk/capabilities.js";
import { CSV_BOM, csvLine } from "../docintel/export.js";
import "./all.js";
import { REPORT_TIME_ZONE, createReportContext, reportDatasets } from "./datasets.js";
import { runQueries } from "./run.js";
import { normalizeQueryRefs, queryRefsSchema } from "./spec.js";
import { readStamp } from "./stamp.js";
import { enabledDatasets } from "./enabled.js";

const queriesInput = z.preprocess(normalizeQueryRefs, queryRefsSchema);

export async function reportRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /**
   * Datasets the caller may use and the module families with their datasets. With the Platform
   * module: also its templates (only those whose datasets the caller may use), example prompts and
   * whether the AI builder is available; without it those are empty.
   */
  api.get<{ Params: { pid: string } }>("/projects/:pid/reports/catalog", async (req): Promise<ReportCatalogDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const lang = requestLanguage(req);
    // Datasets and templates of modules that are off in this project are left out.
    const datasets = enabledDatasets(a, lang);
    const usable = new Set(datasets.map((d) => d.name));
    const builder = await capability("platform.reports")?.catalog(deps, a, lang);
    const modules: ReportModuleDto[] = REPORT_MODULES.map((m) => ({
      key: m,
      label: labelFor(lang, "reportModule", m),
      datasets: datasets.filter((d) => d.module === m).map((d) => d.name),
      examples: builder?.examples[m] ?? [],
    })).filter((m) => m.datasets.length);
    return {
      aiAvailable: builder?.aiAvailable ?? false,
      datasets,
      templates: (builder?.templates ?? []).filter(
        (t) => reportModuleEnabled(projectModules(a.project), t.module) && t.queries.every((q) => usable.has(q.spec.dataset)),
      ),
      examplePrompts: builder?.examplePrompts ?? [],
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
    const stamp = await readStamp(db, a.project.id, reportDatasets.sourcesOf(reportQueryDatasets(body.queries)), { timeZone: REPORT_TIME_ZONE });
    const r = await runQueries(ctx, body.queries, { strict: body.strict, lang });
    return { ...r, generatedAt: ctx.now.toISOString(), stamp: stamp.stamp };
  });

  /**
   * Change stamp of the data behind the given datasets (comma-separated). Cheap: one indexed read,
   * no dataset is loaded.
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

  /**
   * Fixed list of one dataset as CSV: every field (localised headers and value labels), the rows the
   * caller may see, at most REPORT_MAX_ROWS. Datasets that need a scope (one IFC model) have no list.
   */
  api.get<{ Params: { pid: string; name: string } }>("/projects/:pid/reports/datasets/:name/csv", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const lang = requestLanguage(req);
    const def = enabledDatasets(a, lang).find((d) => d.name === req.params.name);
    if (!def || def.scoped) throw notFound(msg("reports:entities.dataset"));
    const ctx = createReportContext(db, a, { lang });
    const fields = def.fields.map((f) => f.name);
    const r = await runQueries(ctx, [{ id: "rows", spec: { dataset: def.name, limit: REPORT_MAX_ROWS } }], { strict: true, lang });
    const t = tFor(lang);
    const cell = (v: ReportScalar | undefined, values?: Record<string, string>): string | number => {
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? t("reports:lists.yes") : t("reports:lists.no");
      if (typeof v === "number") return v;
      return values?.[v] ?? v;
    };
    const lines = function* () {
      yield CSV_BOM + csvLine(def.fields.map((f) => f.label));
      for (const row of r.results.rows ?? []) yield csvLine(def.fields.map((f, i) => cell(row[fields[i]!], f.values)));
    };
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "report.exported",
      targetType: "dataset",
      details: { dataset: def.name, rows: r.results.rows?.length ?? 0 },
    });
    const file = `${a.project.code}-${def.name}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]/g, "_");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    reply.header("Cache-Control", "no-store");
    return reply.send(Readable.from(lines()));
  });
}
