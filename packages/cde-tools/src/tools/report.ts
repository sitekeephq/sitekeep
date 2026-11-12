/**
 * cde_* tools for report dashboards: the dataset catalog (every module: works, correspondence, RFIs,
 * submittals, meetings, reviews, workflow steps, forms, locations, schedule, clashes, comparisons,
 * spec registers…), saved dashboards / templates and running one. Queries always run with the
 * caller's permissions on current data; nothing is saved.
 */
import { z } from "zod";
import type { CdeCall } from "../core/types.js";
import type { ToolAdder } from "../core/define.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Row = Record<string, unknown>;

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Best name match: exact, then all words of the query contained in the name. */
export function matchByName<T extends { name: string }>(items: T[], query: string): T | undefined {
  const q = fold(query).replace(/\b(rapor(u|unu|lari|larini)?|panel(i|ini)?|pano(su|yu)?|goster|getir|ac)\b/g, " ").trim();
  if (!q) return undefined;
  const exact = items.find((x) => fold(x.name) === q);
  if (exact) return exact;
  const words = q.split(/\s+/).map((w) => w.replace(/(lari|leri|lar|ler|si|su|i|u|in|un|nin|nun)$/, "")).filter((w) => w.length >= 3);
  if (!words.length) return undefined;
  return items.find((x) => words.every((w) => fold(x.name).includes(w)));
}

/** Compact result: up to `maxRows` rows per query. */
function compactResults(results: Record<string, Row[]>, errors: Record<string, string>, maxRows: number): Row {
  const out: Row = {};
  for (const [id, rows] of Object.entries(results)) {
    out[id] = errors[id]
      ? { error: errors[id] }
      : rows.length > maxRows
        ? { rows: rows.slice(0, maxRows), more: rows.length - maxRows }
        : { rows };
  }
  return out;
}

export function registerReportTools(tool: ToolAdder, call: CdeCall): void {
  const pid = z.string().uuid().describe("Project id (from cde_projects_list).");

  tool(
    "cde_report_datasets",
    "Report datasets the caller may query, one per module (works, correspondence, rfis, submittals, meetings, actions, transmittals, reviews, " +
      "review_files, workflow_steps, forms, locations, schedule_activities, clash_results, doc_comparisons, spec_registers, files, versions, issues, models…). " +
      "Without `dataset`: names, modules and descriptions. With `dataset`: its fields (name, type, Turkish label, value codes).",
    { projectId: pid, dataset: z.string().optional().describe("Dataset name for its field list."), module: z.string().optional().describe("Only this module family.") },
    async (a) => {
      const cat = await call<Any>("GET", `/projects/${a.projectId}/reports/catalog`);
      const list = (cat.datasets as Any[]).filter((d) => !a.module || d.module === a.module);
      if (a.dataset) {
        const d = list.find((x) => x.name === a.dataset);
        if (!d) return { error: `'${a.dataset}' diye bir veri kümesi yok.`, datasets: list.map((x) => x.name) };
        return {
          name: d.name,
          label: d.label,
          description: d.description,
          fields: d.fields.map((f: Any) => ({ name: f.name, type: f.type, label: f.label, ...(f.values && { values: Object.keys(f.values) }) })),
        };
      }
      return list.map((d) => ({ name: d.name, module: d.module, label: d.label, description: d.description, fields: d.fields.length }));
    },
  );

  tool(
    "cde_reports_list",
    "Saved report dashboards the caller sees (own and shared) and built-in report templates per module (e.g. 'Yazışma Durumu', 'Bilgi Talepleri', 'Teknik Onay Listesi').",
    { projectId: pid },
    async (a) => {
      const [saved, cat] = await Promise.all([
        call<Any[]>("GET", `/projects/${a.projectId}/reports`),
        call<Any>("GET", `/projects/${a.projectId}/reports/catalog`),
      ]);
      return {
        saved: saved.map((d) => ({ id: d.id, name: d.name, description: d.description, owner: d.ownerName, sharing: d.sharing, updated: String(d.updatedAt).slice(0, 10) })),
        templates: (cat.templates as Any[]).map((t) => ({ id: t.id, name: t.name, module: t.module, description: t.description })),
      };
    },
  );

  tool(
    "cde_report_run",
    "Runs a report on current data with the caller's permissions and returns its query results (rows capped). " +
      "Give reportId (saved dashboard), template (built-in template id), or `name` (a saved dashboard or template name, e.g. 'Yazışma Durumu', 'yazışma raporu'). " +
      "Or give `queries` (ad-hoc report queries: [{id, spec: {dataset, filters, groupBy, metrics, fields, sort, limit}}]).",
    {
      projectId: pid,
      reportId: z.string().uuid().optional().describe("Saved dashboard id (cde_reports_list)."),
      template: z.string().optional().describe("Built-in template id (cde_reports_list), e.g. correspondence-status."),
      name: z.string().optional().describe("Part of a saved dashboard's or template's name."),
      queries: z.array(z.object({ id: z.string(), spec: z.record(z.string(), z.unknown()) })).max(20).optional(),
      maxRows: z.number().int().min(1).max(500).default(25).describe("Rows per query in the answer."),
    },
    async (a) => {
      const base = `/projects/${a.projectId}/reports`;
      if (a.queries?.length) {
        const r = await call<Any>("POST", `${base}/query`, { queries: a.queries, strict: false });
        return { results: compactResults(r.results, r.errors ?? {}, a.maxRows), generatedAt: r.generatedAt };
      }
      let saved: Any | undefined;
      let template: Any | undefined;
      if (a.reportId) saved = { id: a.reportId };
      else {
        const [list, cat] = await Promise.all([call<Any[]>("GET", base), call<Any>("GET", `${base}/catalog`)]);
        if (a.template) template = (cat.templates as Any[]).find((t) => t.id === a.template) ?? matchByName(cat.templates as Any[], a.template);
        else if (a.name) {
          saved = matchByName(list, a.name);
          if (!saved) template = matchByName(cat.templates as Any[], a.name) ?? matchByModule(cat.templates as Any[], a.name);
        }
        if (!saved && !template)
          return {
            error: "Rapor bulunamadı. Kayıtlı panellerden veya şablonlardan birini seçin.",
            saved: list.map((d) => d.name),
            templates: (cat.templates as Any[]).map((t) => t.name),
          };
      }
      if (saved) {
        const [d, r] = await Promise.all([call<Any>("GET", `${base}/${saved.id}`), call<Any>("GET", `${base}/${saved.id}/data`)]);
        return {
          report: { id: d.id, name: d.name, description: d.description, saved: true, link: projectPath(a.projectId, `reports/${d.id}`) },
          results: compactResults(r.results, r.errors ?? {}, a.maxRows),
          generatedAt: r.generatedAt,
        };
      }
      const r = await call<Any>("POST", `${base}/query`, { queries: template.queries, strict: false });
      return {
        report: { id: template.id, name: template.name, description: template.description, template: true, link: projectPath(a.projectId, `reports?template=${template.id}`) },
        results: compactResults(r.results, r.errors ?? {}, a.maxRows),
        generatedAt: r.generatedAt,
      };
    },
  );
}

/** "yazışma raporu" → the template of the module whose name matches (Yazışmalar → correspondence). */
function matchByModule(templates: Any[], query: string): Any | undefined {
  const q = fold(query);
  const MODULE_WORDS: [RegExp, string][] = [
    [/yazisma|yazi/, "correspondence"],
    [/bilgi talep|rfi/, "rfi"],
    [/teknik onay|submittal/, "submittals"],
    [/toplanti|eylem|aksiyon/, "meetings"],
    [/incele|review/, "reviews"],
    [/form/, "forms"],
    [/is program|takvim|faaliyet/, "schedule"],
    [/cakisma|clash|koordinasyon/, "coordination"],
    [/karsilastir/, "doccompare"],
    [/sorun|issue/, "issues"],
    [/\bisler|\bis\b/, "works"],
    [/dosya|dokuman|yukleme/, "documents"],
    [/model|ifc/, "models"],
  ];
  for (const [re, module] of MODULE_WORDS) if (re.test(q)) return templates.find((t) => t.module === module);
  return undefined;
}
