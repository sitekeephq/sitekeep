import type { ReportModule, ReportTemplateDto } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor, type MsgKey } from "../i18n/index.js";
import { fillTokens, localizeTemplates } from "./template-text.js";
import { MODULE_TEMPLATE_SOURCES } from "./templates-modules.js";
// The full catalogue, installed modules included (top-level await): templates are filtered by it.
import { reportDatasets } from "./all.js";

/** Built-in dashboards; they need no AI. Users create their own copy from one. */
const BASE_TEMPLATES: ReportTemplateDto[] = [
  {
    id: "issue-status",
    module: "issues",
    name: "[[issueStatus.name]]",
    description: "[[issueStatus.description]]",
    queries: [
      { id: "totals", spec: { dataset: "issues", groupBy: ["status"], metrics: [{ op: "count" }] } },
      {
        id: "byCompany",
        spec: {
          dataset: "issues",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          groupBy: ["assigneeCompany", "status"],
          metrics: [{ op: "count" }],
        },
      },
      {
        id: "byPriority",
        spec: {
          dataset: "issues",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          groupBy: ["priority"],
          metrics: [{ op: "count" }],
        },
      },
      {
        id: "critical",
        spec: {
          dataset: "issues",
          filters: [
            { field: "isOpen", op: "eq", value: true },
            { field: "priority", op: "in", value: ["high", "critical"] },
          ],
          metrics: [{ op: "count" }],
        },
      },
    ],
    html: `<h1>[[text.issueStatus]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-closed"></div><div id="k-critical"></div></div>
<div class="grid">
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="by-priority"></div></div>
</div>
<p class="muted small" id="stamp"></p>
<script>
CDE.onData(function (d) {
  var open = CDE.sum(d.totals.filter(function (r) { return r.status !== "closed"; }));
  var closed = CDE.sum(d.totals.filter(function (r) { return r.status === "closed"; }));
  CDE.kpi("#k-open", { label: "[[text.openIssue]]", value: open, tone: open ? "warn" : "ok" });
  CDE.kpi("#k-closed", { label: "[[text.closedIssue]]", value: closed, tone: "ok" });
  CDE.kpi("#k-critical", { label: "[[text.highCriticalOpen]]", value: CDE.sum(d.critical), tone: "danger" });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.openIssuesByCompany]]", x: "assigneeCompany", y: "count", series: "status", stacked: true, horizontal: true });
  CDE.pie("#by-priority", d.byPriority, { title: "[[text.byPriorityOpen]]", label: "priority", value: "count",
    colors: { critical: "var(--danger)", high: "var(--c2)", normal: "var(--c1)", low: "var(--c8)" } });
  document.getElementById("stamp").textContent = CDE.project.name + " · " + CDE.fmt.datetime(CDE.generatedAt);
});
</script>`,
  },
  {
    id: "overdue",
    module: "issues",
    name: "[[overdue.name]]",
    description: "[[overdue.description]]",
    queries: [
      {
        id: "overdue",
        spec: {
          dataset: "issues",
          filters: [{ field: "overdue", op: "eq", value: true }],
          fields: ["number", "title", "assignee", "assigneeCompany", "priority", "dueDate", "daysOverdue"],
          sort: [{ field: "daysOverdue", dir: "desc" }],
          limit: 500,
        },
      },
      {
        id: "byCompany",
        spec: {
          dataset: "issues",
          filters: [{ field: "overdue", op: "eq", value: true }],
          groupBy: ["assigneeCompany"],
          metrics: [{ op: "count" }, { op: "avg", field: "daysOverdue", as: "avgDays" }],
        },
      },
      {
        id: "upcoming",
        spec: {
          dataset: "issues",
          filters: [
            { field: "isOpen", op: "eq", value: true },
            { field: "dueDate", op: "between", value: ["today", "+7d"] },
          ],
          metrics: [{ op: "count" }],
        },
      },
    ],
    html: `<h1>[[text.overdueItems]]</h1>
<div class="kpis"><div id="k-overdue"></div><div id="k-upcoming"></div><div id="k-max"></div></div>
<div class="grid">
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="avg-days"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="list"></div></div>
<script>
CDE.onData(function (d) {
  var max = d.overdue.length ? d.overdue[0].daysOverdue : 0;
  CDE.kpi("#k-overdue", { label: "[[text.overdueIssue]]", value: d.overdue.length, tone: d.overdue.length ? "danger" : "ok" });
  CDE.kpi("#k-upcoming", { label: "[[text.dueNext7Days]]", value: CDE.sum(d.upcoming), tone: "warn" });
  CDE.kpi("#k-max", { label: "[[text.longestDelay]]", value: max + "[[text.daysSuffix]]" });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.overdueByCompany]]", x: "assigneeCompany", y: "count", horizontal: true, colors: { count: "var(--danger)" } });
  CDE.bar("#avg-days", d.byCompany, { title: "[[text.averageDelayDays]]", x: "assigneeCompany", y: "avgDays", horizontal: true });
  CDE.table("#list", d.overdue, { title: "[[text.overdueIssues]]", empty: "[[text.noOverdueIssues]]", columns: [
    { field: "number", label: "[[text.no]]" }, { field: "title", label: "[[text.title]]" }, { field: "assignee", label: "[[text.assignee]]" },
    { field: "assigneeCompany", label: "[[text.company]]" }, { field: "priority", label: "[[text.priority]]" },
    { field: "dueDate", label: "[[text.dueDate]]", format: "date" }, { field: "daysOverdue", label: "[[text.delayDays]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "upload-activity",
    module: "documents",
    name: "[[uploadActivity.name]]",
    description: "[[uploadActivity.description]]",
    queries: [
      {
        id: "weekly",
        spec: {
          dataset: "versions",
          filters: [{ field: "uploadedAt", op: "gte", value: "-12w" }],
          groupBy: [{ field: "uploadedAt", bucket: "week" }],
          metrics: [{ op: "count" }, { op: "sum", field: "size", as: "size" }],
        },
      },
      {
        id: "weeklyByCompany",
        spec: {
          dataset: "versions",
          filters: [{ field: "uploadedAt", op: "gte", value: "-12w" }],
          groupBy: [{ field: "uploadedAt", bucket: "week" }, "uploaderCompany"],
          metrics: [{ op: "count" }],
        },
      },
      {
        id: "topUploaders",
        spec: {
          dataset: "versions",
          filters: [{ field: "uploadedAt", op: "gte", value: "-12w" }],
          groupBy: ["uploader"],
          metrics: [{ op: "count" }],
          limit: 10,
        },
      },
    ],
    html: `<h1>[[text.uploadActivity]]</h1>
<p class="muted">[[text.last12Weeks]]</p>
<div class="kpis"><div id="k-count"></div><div id="k-size"></div><div id="k-avg"></div></div>
<div class="grid">
  <div class="card"><div id="weekly"></div></div>
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="top"></div></div>
</div>
<script>
CDE.onData(function (d) {
  var total = CDE.sum(d.weekly);
  CDE.kpi("#k-count", { label: "[[text.uploadsVersions]]", value: total });
  CDE.kpi("#k-size", { label: "[[text.totalSize]]", value: CDE.sum(d.weekly, "size"), format: "bytes" });
  CDE.kpi("#k-avg", { label: "[[text.weeklyAverage]]", value: d.weekly.length ? total / d.weekly.length : 0 });
  CDE.line("#weekly", d.weekly, { title: "[[text.weeklyUploads]]", x: "uploadedAt", y: "count", area: true });
  CDE.bar("#by-company", d.weeklyByCompany, { title: "[[text.byCompanies]]", x: "uploadedAt", y: "count", series: "uploaderCompany", stacked: true });
  CDE.bar("#top", d.topUploaders, { title: "[[text.topUploaders]]", x: "uploader", y: "count", horizontal: true });
});
</script>`,
  },
  {
    id: "model-elements",
    module: "models",
    name: "[[modelElements.name]]",
    description: "[[modelElements.description]]",
    queries: [
      {
        id: "byClass",
        spec: {
          dataset: "models",
          filters: [
            { field: "isLatest", op: "eq", value: true },
            { field: "ifcClass", op: "isNull", value: false },
          ],
          groupBy: ["ifcClass"],
          metrics: [{ op: "sum", field: "classCount", as: "elements" }],
          sort: [{ field: "elements", dir: "desc" }],
          limit: 25,
        },
      },
      {
        id: "byModel",
        spec: {
          dataset: "models",
          filters: [{ field: "isLatest", op: "eq", value: true }],
          groupBy: ["file", "folderPath", "schema"],
          metrics: [
            { op: "max", field: "elementCount", as: "elements" },
            { op: "max", field: "version", as: "version" },
          ],
          sort: [{ field: "elements", dir: "desc" }],
        },
      },
    ],
    html: `<h1>[[text.modelElements]]</h1>
<div class="kpis"><div id="k-models"></div><div id="k-elements"></div><div id="k-classes"></div></div>
<div class="grid">
  <div class="card"><div id="by-class"></div></div>
  <div class="card"><div id="by-model"></div></div>
</div>
<script>
CDE.onData(function (d) {
  CDE.kpi("#k-models", { label: "[[text.modelsCurrentIfc]]", value: d.byModel.length });
  CDE.kpi("#k-elements", { label: "[[text.totalElements]]", value: CDE.sum(d.byModel, "elements") });
  CDE.kpi("#k-classes", { label: "[[text.ifcClass]]", value: d.byClass.length });
  CDE.bar("#by-class", d.byClass, { title: "[[text.elementsByIfcClass]]", x: "ifcClass", y: "elements", horizontal: true });
  CDE.table("#by-model", d.byModel, { title: "[[text.models]]", empty: "[[text.noConvertedIfc]]", columns: [
    { field: "file", label: "[[text.file]]" }, { field: "folderPath", label: "[[text.folder]]" }, { field: "schema", label: "[[text.schema]]" },
    { field: "version", label: "V", format: "number" }, { field: "elements", label: "[[text.elements]]", format: "number" } ] });
});
</script>`,
  },
];

/** A template is offered only when every dataset it reads is installed (module datasets come with their module). */
const installed = (t: ReportTemplateDto) => t.queries.every((q) => reportDatasets.get(q.spec.dataset));

/** Every built-in template (the issue and document ones first, then one or more per module), in a language. */
const cache = new Map<string, ReportTemplateDto[]>();
export function reportTemplates(lang: string): ReportTemplateDto[] {
  let list = cache.get(lang);
  if (!list) cache.set(lang, (list = localizeTemplates([...BASE_TEMPLATES, ...MODULE_TEMPLATE_SOURCES].filter(installed), lang)));
  return list;
}

/** The templates in the installation's language. */
export const REPORT_TEMPLATES: ReportTemplateDto[] = reportTemplates(DEFAULT_LANGUAGE);

const BLANK_DASHBOARD_SOURCE = `<h1>[[text.newDashboard]]</h1>
<div class="card"><div id="tablo"></div></div>
<script>
CDE.onData(function (d) {
  // [[text.blankComment]]
  var first = Object.keys(d)[0];
  if (first) CDE.table("#tablo", d[first], { title: first });
  else document.getElementById("tablo").textContent = "[[text.addQueryHint]]";
});
</script>`;

/** HTML of a new empty dashboard, in a language. */
export function blankDashboardHtml(lang: string): string {
  return fillTokens(BLANK_DASHBOARD_SOURCE, lang);
}

/** Example prompts of the builder (general). */
const EXAMPLE_KEYS: MsgKey[] = [
  "reports:examples.general.openIssuesByCompany",
  "reports:examples.general.uploadsByCompany",
  "reports:examples.general.lettersAwaitingReply",
  "reports:examples.general.openRfisByBallInCourt",
  "reports:examples.general.reviewWaitingByCompany",
  "reports:examples.general.failedFormItemsByLocation",
];

/** Example prompts of the builder opened from a module's "Rapor" shortcut. */
const MODULE_EXAMPLE_KEYS: Record<ReportModule, MsgKey[]> = {
  documents: ["reports:examples.documents.uploadsByCompany", "reports:examples.documents.filesByState"],
  issues: ["reports:examples.issues.openByCompany", "reports:examples.issues.overdueTable"],
  works: ["reports:examples.works.openByCategory", "reports:examples.works.overdueOldestFirst"],
  correspondence: [
    "reports:examples.correspondence.awaitingReply",
    "reports:examples.correspondence.monthlyInOut",
    "reports:examples.correspondence.overdueTable",
  ],
  rfi: ["reports:examples.rfi.openByBallInCourt", "reports:examples.rfi.byDiscipline"],
  submittals: ["reports:examples.submittals.outcomes", "reports:examples.submittals.overdue"],
  meetings: ["reports:examples.meetings.openActionsByCompany", "reports:examples.meetings.overdueActions"],
  transmittals: ["reports:examples.transmittals.byRecipient"],
  reviews: ["reports:examples.reviews.waitingByCompany", "reports:examples.reviews.overdueSteps"],
  forms: ["reports:examples.forms.failedByLocation", "reports:examples.forms.weeklyByTemplate"],
  locations: ["reports:examples.locations.openByLocation"],
  schedule: ["reports:examples.schedule.lateCritical", "reports:examples.schedule.completionByWbs"],
  coordination: ["reports:examples.coordination.byClassPair", "reports:examples.coordination.byCompany"],
  doccompare: ["reports:examples.doccompare.withWarnings", "reports:examples.doccompare.monthly"],
  spec: ["reports:examples.spec.bySection", "reports:examples.spec.byKindDiscipline"],
  models: ["reports:examples.models.elementsByClass"],
  project: ["reports:examples.project.downloadsByUser", "reports:examples.project.membersByCompany"],
};

/** General example prompts, in a language. */
export function examplePrompts(lang: string): string[] {
  const t = tFor(lang);
  return EXAMPLE_KEYS.map((k) => t(k));
}

/** Example prompts per module, in a language. */
export function moduleExamplePrompts(lang: string): Record<ReportModule, string[]> {
  const t = tFor(lang);
  return Object.fromEntries(Object.entries(MODULE_EXAMPLE_KEYS).map(([m, keys]) => [m, keys.map((k) => t(k))])) as Record<ReportModule, string[]>;
}
