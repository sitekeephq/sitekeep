import type { ReportTemplateDto } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { localizeTemplates } from "./template-text.js";

/**
 * Ready-made dashboards per module (no AI needed). Each one is also the AI prompt's example for its
 * module family, so keep them short and conventional: a title, a .kpis row, .card elements in a .grid.
 */
export const MODULE_TEMPLATE_SOURCES: ReportTemplateDto[] = [
  {
    id: "correspondence-status",
    module: "correspondence",
    name: "[[correspondenceStatus.name]]",
    description: "[[correspondenceStatus.description]]",
    queries: [
      { id: "totals", spec: { dataset: "correspondence", groupBy: ["direction", "isOpen"], metrics: [{ op: "count" }] } },
      {
        id: "awaiting",
        spec: {
          dataset: "correspondence",
          filters: [{ field: "awaitingReply", op: "eq", value: true }],
          fields: ["number", "title", "counterparty", "ballInCourt", "letterDate", "dueDate", "daysOpen", "overdue"],
          sort: [{ field: "daysOpen", dir: "desc" }],
          limit: 200,
        },
      },
      { id: "overdue", spec: { dataset: "correspondence", filters: [{ field: "overdue", op: "eq", value: true }], metrics: [{ op: "count" }] } },
      {
        id: "byCompany",
        spec: {
          dataset: "correspondence",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          groupBy: ["counterparty", "direction"],
          metrics: [{ op: "count" }],
        },
      },
      {
        id: "monthly",
        spec: {
          dataset: "correspondence",
          filters: [{ field: "letterDate", op: "gte", value: "-12m" }],
          groupBy: [{ field: "letterDate", bucket: "month" }, "direction"],
          metrics: [{ op: "count" }],
        },
      },
    ],
    html: `<h1>[[text.correspondenceStatus]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-await"></div><div id="k-overdue"></div><div id="k-total"></div></div>
<div class="grid">
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="monthly"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="awaiting"></div></div>
<script>
CDE.onData(function (d) {
  var open = CDE.sum(d.totals.filter(function (r) { return r.isOpen; }));
  CDE.kpi("#k-open", { label: "[[text.openLetters]]", value: open });
  CDE.kpi("#k-await", { label: "[[text.awaitingReply]]", value: d.awaiting.length, tone: d.awaiting.length ? "warn" : "ok" });
  CDE.kpi("#k-overdue", { label: "[[text.overdue]]", value: CDE.sum(d.overdue), tone: CDE.sum(d.overdue) ? "danger" : "ok" });
  CDE.kpi("#k-total", { label: "[[text.totalLetters]]", value: CDE.sum(d.totals) });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.openLettersByCompany]]", x: "counterparty", y: "count", series: "direction", stacked: true, horizontal: true });
  CDE.bar("#monthly", d.monthly, { title: "[[text.monthlyInOut]]", x: "letterDate", y: "count", series: "direction" });
  CDE.table("#awaiting", d.awaiting, { title: "[[text.lettersAwaitingReply]]", empty: "[[text.noLettersAwaitingReply]]", columns: [
    { field: "number", label: "[[text.number]]" }, { field: "title", label: "[[text.subject]]" }, { field: "counterparty", label: "[[text.counterparty]]" },
    { field: "ballInCourt", label: "[[text.ballInCourt]]" }, { field: "letterDate", label: "[[text.date]]", format: "date" },
    { field: "dueDate", label: "[[text.dueDate]]", format: "date" }, { field: "daysOpen", label: "[[text.daysOpen]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "rfi-log",
    module: "rfi",
    name: "[[rfiLog.name]]",
    description: "[[rfiLog.description]]",
    queries: [
      { id: "totals", spec: { dataset: "rfis", groupBy: ["isOpen"], metrics: [{ op: "count" }] } },
      {
        id: "byBic",
        spec: { dataset: "rfis", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["ballInCourt"], metrics: [{ op: "count" }] },
      },
      { id: "byDiscipline", spec: { dataset: "rfis", groupBy: ["discipline", "isOpen"], metrics: [{ op: "count" }] } },
      {
        id: "answerTime",
        spec: {
          dataset: "rfis",
          filters: [{ field: "answered", op: "eq", value: true }],
          metrics: [{ op: "avg", field: "daysOpen", as: "avgDays" }, { op: "count" }],
        },
      },
      {
        id: "open",
        spec: {
          dataset: "rfis",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          fields: ["number", "title", "discipline", "ballInCourt", "daysOpen", "dueDate", "overdue"],
          sort: [{ field: "daysOpen", dir: "desc" }],
          limit: 200,
        },
      },
    ],
    html: `<h1>[[text.rfis]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-overdue"></div><div id="k-avg"></div><div id="k-max"></div></div>
<div class="grid">
  <div class="card"><div id="by-bic"></div></div>
  <div class="card"><div id="by-discipline"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="open"></div></div>
<script>
CDE.onData(function (d) {
  var overdue = d.open.filter(function (r) { return r.overdue; }).length;
  var avg = d.answerTime[0] ? d.answerTime[0].avgDays : null;
  CDE.kpi("#k-open", { label: "[[text.openRfi]]", value: CDE.sum(d.totals.filter(function (r) { return r.isOpen; })) });
  CDE.kpi("#k-overdue", { label: "[[text.overdue]]", value: overdue, tone: overdue ? "danger" : "ok" });
  CDE.kpi("#k-avg", { label: "[[text.averageResponseDays]]", value: avg });
  CDE.kpi("#k-max", { label: "[[text.longestOpenDays]]", value: d.open.length ? d.open[0].daysOpen : 0 });
  CDE.bar("#by-bic", d.byBic, { title: "[[text.openRfisByBallInCourt]]", x: "ballInCourt", y: "count", horizontal: true });
  CDE.bar("#by-discipline", d.byDiscipline, { title: "[[text.byDiscipline]]", x: "discipline", y: "count", series: "isOpen", stacked: true, horizontal: true,
    seriesLabels: { "true": "[[text.open]]", "false": "[[text.closed]]" } });
  CDE.table("#open", d.open, { title: "[[text.openRfis]]", empty: "[[text.noOpenRfis]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "title", label: "[[text.subject]]" }, { field: "discipline", label: "[[text.discipline]]" },
    { field: "ballInCourt", label: "[[text.ballInCourt]]" }, { field: "daysOpen", label: "[[text.daysOpen]]", format: "number" },
    { field: "dueDate", label: "[[text.dueDate]]", format: "date" } ] });
});
</script>`,
  },
  {
    id: "submittal-register",
    module: "submittals",
    name: "[[submittalRegister.name]]",
    description: "[[submittalRegister.description]]",
    queries: [
      { id: "totals", spec: { dataset: "submittals", groupBy: ["isOpen"], metrics: [{ op: "count" }] } },
      {
        id: "byOutcome",
        spec: { dataset: "submittals", filters: [{ field: "decided", op: "eq", value: true }], groupBy: ["outcome"], metrics: [{ op: "count" }] },
      },
      { id: "byRev", spec: { dataset: "submittals", groupBy: ["rev"], metrics: [{ op: "count" }], sort: [{ field: "rev", dir: "asc" }] } },
      { id: "byKind", spec: { dataset: "submittals", groupBy: ["kind", "isOpen"], metrics: [{ op: "count" }] } },
      { id: "reviewTime", spec: { dataset: "submittals", filters: [{ field: "decided", op: "eq", value: true }], metrics: [{ op: "avg", field: "reviewDays", as: "avgDays" }] } },
      {
        id: "late",
        spec: {
          dataset: "submittals",
          filters: [{ field: "overdue", op: "eq", value: true }],
          fields: ["number", "title", "sectionCode", "rev", "statusLabel", "ballInCourt", "dueDate", "daysOverdue"],
          sort: [{ field: "daysOverdue", dir: "desc" }],
          limit: 200,
        },
      },
    ],
    html: `<h1>[[text.submittalRegister]]</h1>
<div class="kpis"><div id="k-total"></div><div id="k-open"></div><div id="k-late"></div><div id="k-avg"></div></div>
<div class="grid">
  <div class="card"><div id="by-outcome"></div></div>
  <div class="card"><div id="by-rev"></div></div>
  <div class="card"><div id="by-kind"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="late"></div></div>
<script>
CDE.onData(function (d) {
  CDE.kpi("#k-total", { label: "[[text.submittalItems]]", value: CDE.sum(d.totals) });
  CDE.kpi("#k-open", { label: "[[text.open]]", value: CDE.sum(d.totals.filter(function (r) { return r.isOpen; })) });
  CDE.kpi("#k-late", { label: "[[text.overdue]]", value: d.late.length, tone: d.late.length ? "danger" : "ok" });
  CDE.kpi("#k-avg", { label: "[[text.averageReviewDays]]", value: d.reviewTime[0] ? d.reviewTime[0].avgDays : null });
  CDE.pie("#by-outcome", d.byOutcome, { title: "[[text.outcomeBreakdown]]", label: "outcome", value: "count",
    colors: { approved: "var(--ok)", approved_with_comments: "var(--c3)", reviewed: "var(--c1)", revise_resubmit: "var(--warn)", rejected: "var(--danger)" } });
  CDE.bar("#by-rev", d.byRev, { title: "[[text.itemsByRevision]]", x: "rev", y: "count", xFormat: function (v) { return "Rev " + v; } });
  CDE.bar("#by-kind", d.byKind, { title: "[[text.byKind]]", x: "kind", y: "count", series: "isOpen", stacked: true, horizontal: true,
    seriesLabels: { "true": "[[text.open]]", "false": "[[text.closed]]" } });
  CDE.table("#late", d.late, { title: "[[text.overdueItemsList]]", empty: "[[text.noOverdueItems]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "title", label: "[[text.title]]" }, { field: "sectionCode", label: "[[text.section]]" },
    { field: "rev", label: "Rev", format: "number" }, { field: "statusLabel", label: "[[text.status]]" }, { field: "ballInCourt", label: "[[text.ballInCourt]]" },
    { field: "dueDate", label: "[[text.dueDate]]", format: "date" }, { field: "daysOverdue", label: "[[text.delayDays]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "meetings-actions",
    module: "meetings",
    name: "[[meetingsActions.name]]",
    description: "[[meetingsActions.description]]",
    queries: [
      {
        id: "openActions",
        spec: {
          dataset: "actions",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          fields: ["number", "title", "responsibleCompany", "assignee", "meeting", "dueDate", "overdue", "daysOverdue"],
          sort: [{ field: "dueDate", dir: "asc" }],
          limit: 300,
        },
      },
      {
        id: "byCompany",
        spec: {
          dataset: "actions",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          groupBy: ["responsibleCompany", "overdue"],
          metrics: [{ op: "count" }],
        },
      },
      {
        id: "meetings",
        spec: {
          dataset: "meetings",
          fields: ["number", "title", "kind", "date", "presentCount", "actionCount", "openActionCount"],
          sort: [{ field: "date", dir: "desc" }],
          limit: 10,
        },
      },
      {
        id: "monthly",
        spec: { dataset: "meetings", filters: [{ field: "date", op: "gte", value: "-6m" }], groupBy: [{ field: "date", bucket: "month" }], metrics: [{ op: "count" }] },
      },
    ],
    html: `<h1>[[text.meetingsActions]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-late"></div><div id="k-meetings"></div></div>
<div class="grid">
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="monthly"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="actions"></div></div>
<div class="card" style="margin-top:16px"><div id="meetings"></div></div>
<script>
CDE.onData(function (d) {
  var late = d.openActions.filter(function (r) { return r.overdue; }).length;
  CDE.kpi("#k-open", { label: "[[text.openAction]]", value: d.openActions.length, tone: d.openActions.length ? "warn" : "ok" });
  CDE.kpi("#k-late", { label: "[[text.overdueAction]]", value: late, tone: late ? "danger" : "ok" });
  CDE.kpi("#k-meetings", { label: "[[text.meetingsLast6Months]]", value: CDE.sum(d.monthly) });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.openActionsByCompany]]", x: "responsibleCompany", y: "count", series: "overdue", stacked: true, horizontal: true,
    seriesLabels: { "true": "[[text.overdue]]", "false": "[[text.onTime]]" }, colors: { "true": "var(--danger)", "false": "var(--c1)" } });
  CDE.bar("#monthly", d.monthly, { title: "[[text.monthlyMeetings]]", x: "date", y: "count" });
  CDE.table("#actions", d.openActions, { title: "[[text.openActions]]", empty: "[[text.noOpenActions]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "title", label: "[[text.action]]" }, { field: "responsibleCompany", label: "[[text.responsibleCompany]]" },
    { field: "assignee", label: "[[text.responsible]]" }, { field: "meeting", label: "[[text.meeting]]" }, { field: "dueDate", label: "[[text.dueDate]]", format: "date" },
    { field: "daysOverdue", label: "[[text.delayDays]]", format: "number" } ] });
  CDE.table("#meetings", d.meetings, { title: "[[text.recentMeetings]]", empty: "[[text.noMeetings]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "title", label: "[[text.meeting]]" }, { field: "kind", label: "[[text.kind]]" },
    { field: "date", label: "[[text.date]]", format: "date" }, { field: "presentCount", label: "[[text.attendees]]", format: "number" },
    { field: "actionCount", label: "[[text.action]]", format: "number" }, { field: "openActionCount", label: "[[text.openAction]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "reviews-steps",
    module: "reviews",
    name: "[[reviewsSteps.name]]",
    description: "[[reviewsSteps.description]]",
    queries: [
      { id: "status", spec: { dataset: "reviews", groupBy: ["status"], metrics: [{ op: "count" }] } },
      {
        id: "running",
        spec: {
          dataset: "reviews",
          filters: [{ field: "isOpen", op: "eq", value: true }],
          fields: ["number", "name", "currentStep", "stepDueAt", "daysInStep", "overdue", "fileCount"],
          sort: [{ field: "daysInStep", dir: "desc" }],
          limit: 200,
        },
      },
      {
        id: "stepAvg",
        spec: {
          dataset: "workflow_steps",
          filters: [{ field: "subjectType", op: "eq", value: "review" }],
          groupBy: ["stepName"],
          metrics: [{ op: "avg", field: "days", as: "avgDays" }, { op: "count" }],
          sort: [{ field: "avgDays", dir: "desc" }],
          limit: 15,
        },
      },
      {
        id: "byCompany",
        spec: {
          dataset: "workflow_steps",
          groupBy: ["responsibleCompany"],
          metrics: [{ op: "sum", field: "days", as: "totalDays" }, { op: "avg", field: "days", as: "avgDays" }],
          sort: [{ field: "totalDays", dir: "desc" }],
          limit: 15,
        },
      },
      { id: "lateSteps", spec: { dataset: "workflow_steps", filters: [{ field: "late", op: "eq", value: true }], metrics: [{ op: "count" }] } },
    ],
    html: `<h1>[[text.reviews]]</h1>
<div class="kpis"><div id="k-running"></div><div id="k-overdue"></div><div id="k-late"></div></div>
<div class="grid">
  <div class="card"><div id="status"></div></div>
  <div class="card"><div id="step-avg"></div></div>
  <div class="card"><div id="by-company"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="running"></div></div>
<script>
CDE.onData(function (d) {
  var overdue = d.running.filter(function (r) { return r.overdue; }).length;
  CDE.kpi("#k-running", { label: "[[text.runningReview]]", value: d.running.length });
  CDE.kpi("#k-overdue", { label: "[[text.stepOverdue]]", value: overdue, tone: overdue ? "danger" : "ok" });
  CDE.kpi("#k-late", { label: "[[text.lateSteps]]", value: CDE.sum(d.lateSteps), tone: "warn" });
  CDE.pie("#status", d.status, { title: "[[text.reviewsByStatus]]", label: "status", value: "count",
    colors: { running: "var(--c1)", completed: "var(--ok)", cancelled: "var(--c8)" } });
  CDE.bar("#step-avg", d.stepAvg, { title: "[[text.averageStepDays]]", x: "stepName", y: "avgDays", horizontal: true });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.waitingByCompany]]", x: "responsibleCompany", y: "totalDays", horizontal: true });
  CDE.table("#running", d.running, { title: "[[text.runningReviews]]", empty: "[[text.noRunningReviews]]", columns: [
    { field: "number", label: "[[text.no]]" }, { field: "name", label: "[[text.review]]" }, { field: "currentStep", label: "[[text.step]]" },
    { field: "stepDueAt", label: "[[text.stepDue]]", format: "date" }, { field: "daysInStep", label: "[[text.daysInStep]]", format: "number" },
    { field: "fileCount", label: "[[text.file]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "forms-failures",
    module: "forms",
    name: "[[formsFailures.name]]",
    description: "[[formsFailures.description]]",
    queries: [
      { id: "totals", spec: { dataset: "forms", groupBy: ["isOpen"], metrics: [{ op: "count" }, { op: "sum", field: "failedCount", as: "failed" }] } },
      {
        id: "byLocation",
        spec: {
          dataset: "forms",
          groupBy: ["locationTop"],
          metrics: [{ op: "sum", field: "failedCount", as: "failed" }, { op: "count" }],
          sort: [{ field: "failed", dir: "desc" }],
          limit: 20,
        },
      },
      {
        id: "byTemplate",
        spec: {
          dataset: "forms",
          groupBy: ["template"],
          metrics: [{ op: "count" }, { op: "sum", field: "failedCount", as: "failed" }],
          limit: 20,
        },
      },
      {
        id: "weekly",
        spec: { dataset: "forms", filters: [{ field: "formDate", op: "gte", value: "-12w" }], groupBy: [{ field: "formDate", bucket: "week" }], metrics: [{ op: "count" }] },
      },
      {
        id: "failing",
        spec: {
          dataset: "forms",
          filters: [
            { field: "hasFailures", op: "eq", value: true },
            { field: "isOpen", op: "eq", value: true },
          ],
          fields: ["number", "template", "location", "formDate", "failedCount", "status"],
          sort: [{ field: "failedCount", dir: "desc" }],
          limit: 100,
        },
      },
    ],
    html: `<h1>[[text.forms]]</h1>
<div class="kpis"><div id="k-forms"></div><div id="k-open"></div><div id="k-failed"></div><div id="k-failing"></div></div>
<div class="grid">
  <div class="card"><div id="by-location"></div></div>
  <div class="card"><div id="by-template"></div></div>
  <div class="card"><div id="weekly"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="failing"></div></div>
<script>
CDE.onData(function (d) {
  CDE.kpi("#k-forms", { label: "[[text.form]]", value: CDE.sum(d.totals) });
  CDE.kpi("#k-open", { label: "[[text.openForms]]", value: CDE.sum(d.totals.filter(function (r) { return r.isOpen; })) });
  CDE.kpi("#k-failed", { label: "[[text.failedItems]]", value: CDE.sum(d.totals, "failed"), tone: CDE.sum(d.totals, "failed") ? "warn" : "ok" });
  CDE.kpi("#k-failing", { label: "[[text.openFormsWithFailures]]", value: d.failing.length, tone: d.failing.length ? "danger" : "ok" });
  CDE.bar("#by-location", d.byLocation, { title: "[[text.failedItemsByLocation]]", x: "locationTop", y: "failed", horizontal: true });
  CDE.bar("#by-template", d.byTemplate, { title: "[[text.byTemplate]]", x: "template", y: ["count", "failed"], horizontal: true,
    seriesLabels: { count: "[[text.form]]", failed: "[[text.failedItems]]" } });
  CDE.line("#weekly", d.weekly, { title: "[[text.weeklyForms]]", x: "formDate", y: "count", area: true });
  CDE.table("#failing", d.failing, { title: "[[text.openFormsWithFailedItems]]", empty: "[[text.noOpenFormsWithFailedItems]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "template", label: "[[text.template]]" }, { field: "location", label: "[[text.location]]" },
    { field: "formDate", label: "[[text.date]]", format: "date" }, { field: "failedCount", label: "[[text.failed]]", format: "number" }, { field: "status", label: "[[text.status]]" } ] });
});
</script>`,
  },
  {
    id: "schedule-progress",
    module: "schedule",
    name: "[[scheduleProgress.name]]",
    description: "[[scheduleProgress.description]]",
    queries: [
      { id: "status", spec: { dataset: "schedule_activities", filters: [{ field: "summary", op: "eq", value: false }], groupBy: ["status"], metrics: [{ op: "count" }] } },
      {
        id: "progress",
        spec: {
          dataset: "schedule_activities",
          filters: [{ field: "summary", op: "eq", value: false }],
          metrics: [{ op: "avg", field: "percentComplete", as: "avgPct" }, { op: "count" }],
        },
      },
      {
        id: "criticalLate",
        spec: {
          dataset: "schedule_activities",
          filters: [
            { field: "summary", op: "eq", value: false },
            { field: "critical", op: "eq", value: true },
            { field: "late", op: "eq", value: true },
          ],
          fields: ["code", "name", "wbsTop", "finish", "baselineFinish", "finishVarianceDays", "percentComplete"],
          sort: [{ field: "finishVarianceDays", dir: "desc" }],
          limit: 50,
        },
      },
      {
        id: "lateByWbs",
        spec: {
          dataset: "schedule_activities",
          filters: [
            { field: "summary", op: "eq", value: false },
            { field: "late", op: "eq", value: true },
          ],
          groupBy: ["wbsTop"],
          metrics: [{ op: "count" }],
          limit: 15,
        },
      },
      { id: "planned", spec: { dataset: "schedule_activities", filters: [{ field: "summary", op: "eq", value: false }], groupBy: [{ field: "baselineFinish", bucket: "month" }], metrics: [{ op: "count" }] } },
      { id: "forecast", spec: { dataset: "schedule_activities", filters: [{ field: "summary", op: "eq", value: false }], groupBy: [{ field: "finish", bucket: "month" }], metrics: [{ op: "count" }] } },
      { id: "actual", spec: { dataset: "schedule_activities", filters: [{ field: "summary", op: "eq", value: false }], groupBy: [{ field: "actualFinish", bucket: "month" }], metrics: [{ op: "count" }] } },
    ],
    html: `<h1>[[text.schedule]]</h1>
<div class="kpis"><div id="k-count"></div><div id="k-late"></div><div id="k-critical"></div><div id="k-pct"></div></div>
<div class="grid">
  <div class="card"><div id="status"></div></div>
  <div class="card"><div id="by-wbs"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="scurve"></div></div>
<div class="card" style="margin-top:16px"><div id="critical"></div></div>
<script>
CDE.onData(function (d) {
  var total = d.progress[0] ? d.progress[0].count : 0;
  var late = CDE.sum(d.status.filter(function (r) { return r.status === "late"; }));
  CDE.kpi("#k-count", { label: "[[text.activity]]", value: total });
  CDE.kpi("#k-late", { label: "[[text.lateActivity]]", value: late, tone: late ? "danger" : "ok" });
  CDE.kpi("#k-critical", { label: "[[text.lateCriticalActivity]]", value: d.criticalLate.length, tone: d.criticalLate.length ? "danger" : "ok" });
  CDE.kpi("#k-pct", { label: "[[text.averageCompletion]]", value: d.progress[0] && d.progress[0].avgPct !== null ? d.progress[0].avgPct / 100 : null, format: "percent" });
  CDE.pie("#status", d.status, { title: "[[text.activityStatuses]]", label: "status", value: "count",
    colors: { complete: "var(--ok)", in_progress: "var(--c1)", not_started: "var(--c8)", late: "var(--danger)" } });
  CDE.bar("#by-wbs", d.lateByWbs, { title: "[[text.lateActivitiesByWbs]]", x: "wbsTop", y: "count", horizontal: true });
  // [[text.sCurveComment]]
  var months = {}, keys = [];
  function add(rows, field, col) {
    rows.forEach(function (r) {
      var m = r[field];
      if (!m) return;
      if (!months[m]) { months[m] = { month: m, planned: 0, forecast: 0, actual: 0 }; keys.push(m); }
      months[m][col] += r.count;
    });
  }
  add(d.planned, "baselineFinish", "planned");
  add(d.forecast, "finish", "forecast");
  add(d.actual, "actualFinish", "actual");
  keys.sort();
  var acc = { planned: 0, forecast: 0, actual: 0 }, curve = [];
  keys.forEach(function (k) {
    var m = months[k];
    acc.planned += m.planned; acc.forecast += m.forecast; acc.actual += m.actual;
    curve.push({ month: k, planned: total ? (100 * acc.planned) / total : 0, forecast: total ? (100 * acc.forecast) / total : 0, actual: total ? (100 * acc.actual) / total : 0 });
  });
  CDE.line("#scurve", curve, { title: "[[text.sCurve]]", x: "month", y: ["planned", "forecast", "actual"],
    seriesLabels: { planned: "[[text.baseline]]", forecast: "[[text.currentPlan]]", actual: "[[text.actual]]" } });
  CDE.table("#critical", d.criticalLate, { title: "[[text.lateCriticalActivities]]", empty: "[[text.noLateCriticalActivities]]", columns: [
    { field: "code", label: "[[text.code]]" }, { field: "name", label: "[[text.activity]]" }, { field: "wbsTop", label: "[[text.wbs]]" },
    { field: "baselineFinish", label: "[[text.baselineFinish]]", format: "date" }, { field: "finish", label: "[[text.finish]]", format: "date" },
    { field: "finishVarianceDays", label: "[[text.varianceDays]]", format: "number" }, { field: "percentComplete", label: "%", format: "number" } ] });
});
</script>`,
  },
  {
    id: "cost-5d",
    module: "schedule",
    name: "[[cost5d.name]]",
    description: "[[cost5d.description]]",
    queries: [
      { id: "total", spec: { dataset: "model_costs", metrics: [{ op: "sum", field: "amount", as: "amount" }, { op: "count" }] } },
      { id: "byCategory", spec: { dataset: "model_costs", groupBy: ["category"], metrics: [{ op: "sum", field: "amount", as: "amount" }], sort: [{ field: "amount", dir: "desc" }], limit: 15 } },
      { id: "byStorey", spec: { dataset: "model_costs", groupBy: ["storey"], metrics: [{ op: "sum", field: "amount", as: "amount" }], sort: [{ field: "amount", dir: "desc" }], limit: 30 } },
      {
        id: "topItems",
        spec: {
          dataset: "model_costs",
          groupBy: ["item", "unit"],
          metrics: [{ op: "sum", field: "quantity", as: "quantity" }, { op: "sum", field: "amount", as: "amount" }],
          sort: [{ field: "amount", dir: "desc" }],
          limit: 10,
        },
      },
      { id: "missing", spec: { dataset: "model_costs", filters: [{ field: "missingQuantity", op: "eq", value: true }], metrics: [{ op: "count" }] } },
      { id: "cashflow", spec: { dataset: "cost_cashflow", fields: ["date", "planned", "forecast", "actual"], sort: [{ field: "date" }], limit: 2000 } },
    ],
    html: `<h1>[[text.cost5d]]</h1>
<div class="kpis"><div id="k-total"></div><div id="k-lines"></div><div id="k-missing"></div><div id="k-planned"></div></div>
<div class="grid">
  <div class="card"><div id="by-category"></div></div>
  <div class="card"><div id="by-storey"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="scurve"></div></div>
<div class="card" style="margin-top:16px"><div id="items"></div></div>
<script>
CDE.onData(function (d) {
  var t = d.total[0] || { amount: 0, count: 0 };
  var missing = d.missing[0] ? d.missing[0].count : 0;
  var flow = d.cashflow || [];
  var today = String(CDE.generatedAt).slice(0, 10), planned = 0;
  flow.forEach(function (p) { if (p.date <= today) planned = p.planned; });
  CDE.kpi("#k-total", { label: "[[text.totalCost]]", value: t.amount });
  CDE.kpi("#k-lines", { label: "[[text.costLines]]", value: t.count });
  CDE.kpi("#k-missing", { label: "[[text.linesMissingQuantity]]", value: missing, tone: missing ? "danger" : "ok" });
  CDE.kpi("#k-planned", { label: "[[text.plannedToDate]]", value: planned });
  CDE.bar("#by-category", d.byCategory, { title: "[[text.costByCategory]]", x: "category", y: "amount", horizontal: true });
  CDE.bar("#by-storey", d.byStorey, { title: "[[text.costByStorey]]", x: "storey", y: "amount", horizontal: true });
  CDE.line("#scurve", flow, { title: "[[text.cashflowCumulative]]", x: "date", y: ["planned", "forecast", "actual"],
    seriesLabels: { planned: "[[text.planned]]", forecast: "[[text.forecast]]", actual: "[[text.actual]]" } });
  CDE.table("#items", d.topItems, { title: "[[text.top10Items]]", empty: "[[text.noCostLines]]", columns: [
    { field: "item", label: "[[text.item]]" }, { field: "unit", label: "[[text.unit]]" }, { field: "quantity", label: "[[text.quantity]]", format: "number" },
    { field: "amount", label: "[[text.amount]]", format: "number" } ] });
});
</script>`,
  },
  {
    id: "clash-overview",
    module: "coordination",
    name: "[[clashOverview.name]]",
    description: "[[clashOverview.description]]",
    queries: [
      { id: "status", spec: { dataset: "clash_results", groupBy: ["status"], metrics: [{ op: "count" }] } },
      {
        id: "pairs",
        spec: { dataset: "clash_results", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["classPair"], metrics: [{ op: "count" }], limit: 15 },
      },
      {
        id: "byCompany",
        spec: { dataset: "clash_results", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["assignedCompany"], metrics: [{ op: "count" }] },
      },
      { id: "byTest", spec: { dataset: "clash_results", groupBy: ["test", "status"], metrics: [{ op: "count" }] } },
      {
        id: "byStorey",
        spec: { dataset: "clash_results", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["storey"], metrics: [{ op: "count" }], limit: 20 },
      },
    ],
    html: `<h1>[[text.clashes]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-resolved"></div><div id="k-approved"></div></div>
<div class="grid">
  <div class="card"><div id="pairs"></div></div>
  <div class="card"><div id="by-company"></div></div>
  <div class="card"><div id="by-test"></div></div>
  <div class="card"><div id="by-storey"></div></div>
</div>
<script>
CDE.onData(function (d) {
  function n(code) { var r = CDE.find(d.status, "status", code); return r ? r.count : 0; }
  CDE.kpi("#k-open", { label: "[[text.openClashes]]", value: n("new") + n("active"), tone: n("new") + n("active") ? "danger" : "ok" });
  CDE.kpi("#k-resolved", { label: "[[text.resolved]]", value: n("resolved"), tone: "ok" });
  CDE.kpi("#k-approved", { label: "[[text.approvedNotClash]]", value: n("approved") });
  CDE.bar("#pairs", d.pairs, { title: "[[text.openClashesByClassPair]]", x: "classPair", y: "count", horizontal: true });
  CDE.bar("#by-company", d.byCompany, { title: "[[text.openClashesByCompany]]", x: "assignedCompany", y: "count", horizontal: true });
  CDE.bar("#by-test", d.byTest, { title: "[[text.statusByTest]]", x: "test", y: "count", series: "status", stacked: true, horizontal: true,
    colors: { new: "var(--danger)", active: "var(--warn)", resolved: "var(--ok)", approved: "var(--c8)" } });
  CDE.bar("#by-storey", d.byStorey, { title: "[[text.openClashesByStorey]]", x: "storey", y: "count", horizontal: true });
});
</script>`,
  },
  {
    id: "doc-compare",
    module: "doccompare",
    name: "[[docCompare.name]]",
    description: "[[docCompare.description]]",
    queries: [
      {
        id: "list",
        spec: {
          dataset: "doc_comparisons",
          fields: ["file", "fromVersion", "toVersion", "fromRevision", "toRevision", "pagesChanged", "antetChanges", "warningCount", "warnings", "createdAt"],
          sort: [{ field: "createdAt", dir: "desc" }],
          limit: 100,
        },
      },
      {
        id: "summary",
        spec: {
          dataset: "doc_comparisons",
          metrics: [
            { op: "count" },
            { op: "sum", field: "warningCount", as: "warnings" },
            { op: "sum", field: "antetChanges", as: "antet" },
            { op: "sum", field: "pagesChanged", as: "pages" },
          ],
        },
      },
      { id: "warned", spec: { dataset: "doc_comparisons", groupBy: ["hasWarnings"], metrics: [{ op: "count" }] } },
      { id: "monthly", spec: { dataset: "doc_comparisons", filters: [{ field: "createdAt", op: "gte", value: "-6m" }], groupBy: [{ field: "createdAt", bucket: "month" }], metrics: [{ op: "count" }] } },
    ],
    html: `<h1>[[text.docComparisons]]</h1>
<div class="kpis"><div id="k-count"></div><div id="k-warn"></div><div id="k-antet"></div><div id="k-pages"></div></div>
<div class="grid">
  <div class="card"><div id="warned"></div></div>
  <div class="card"><div id="monthly"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="list"></div></div>
<script>
CDE.onData(function (d) {
  var s = d.summary[0] || {};
  CDE.kpi("#k-count", { label: "[[text.comparisons]]", value: s.count || 0 });
  CDE.kpi("#k-warn", { label: "[[text.revisionWarnings]]", value: s.warnings || 0, tone: s.warnings ? "warn" : "ok" });
  CDE.kpi("#k-antet", { label: "[[text.titleBlockChanges]]", value: s.antet || 0 });
  CDE.kpi("#k-pages", { label: "[[text.changedPages]]", value: s.pages || 0 });
  CDE.pie("#warned", d.warned, { title: "[[text.comparisonsWithWarnings]]", label: "hasWarnings", value: "count", colors: { "true": "var(--warn)", "false": "var(--ok)" } });
  CDE.bar("#monthly", d.monthly, { title: "[[text.monthlyComparisons]]", x: "createdAt", y: "count" });
  CDE.table("#list", d.list, { title: "[[text.recentComparisons]]", empty: "[[text.noComparisons]]", columns: [
    { field: "file", label: "[[text.file]]" }, { field: "fromVersion", label: "[[text.oldVersion]]", format: "number" }, { field: "toVersion", label: "[[text.newVersion]]", format: "number" },
    { field: "fromRevision", label: "[[text.oldRevision]]" }, { field: "toRevision", label: "[[text.newRevision]]" }, { field: "pagesChanged", label: "[[text.changedPages]]", format: "number" },
    { field: "antetChanges", label: "[[text.titleBlock]]", format: "number" }, { field: "warnings", label: "[[text.warnings]]" }, { field: "createdAt", label: "[[text.date]]", format: "date" } ] });
});
</script>`,
  },
  {
    id: "works-overview",
    module: "works",
    name: "[[worksOverview.name]]",
    description: "[[worksOverview.description]]",
    queries: [
      { id: "byCategory", spec: { dataset: "works", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["category"], metrics: [{ op: "count" }] } },
      {
        id: "byBic",
        spec: { dataset: "works", filters: [{ field: "isOpen", op: "eq", value: true }], groupBy: ["ballInCourt", "category"], metrics: [{ op: "count" }] },
      },
      {
        id: "overdue",
        spec: {
          dataset: "works",
          filters: [{ field: "overdue", op: "eq", value: true }],
          fields: ["number", "title", "category", "ballInCourt", "dueDate", "daysOverdue"],
          sort: [{ field: "daysOverdue", dir: "desc" }],
          limit: 200,
        },
      },
    ],
    html: `<h1>[[text.openWork]]</h1>
<div class="kpis"><div id="k-open"></div><div id="k-late"></div></div>
<div class="grid">
  <div class="card"><div id="by-category"></div></div>
  <div class="card"><div id="by-bic"></div></div>
</div>
<div class="card" style="margin-top:16px"><div id="overdue"></div></div>
<script>
CDE.onData(function (d) {
  CDE.kpi("#k-open", { label: "[[text.openWorkItems]]", value: CDE.sum(d.byCategory) });
  CDE.kpi("#k-late", { label: "[[text.overdue]]", value: d.overdue.length, tone: d.overdue.length ? "danger" : "ok" });
  CDE.pie("#by-category", d.byCategory, { title: "[[text.byCategory]]", label: "category", value: "count" });
  CDE.bar("#by-bic", d.byBic, { title: "[[text.byBallInCourt]]", x: "ballInCourt", y: "count", series: "category", stacked: true, horizontal: true });
  CDE.table("#overdue", d.overdue, { title: "[[text.overdueWork]]", empty: "[[text.noOverdueWork]]", columns: [
    { field: "number", label: "[[text.numberShort]]" }, { field: "title", label: "[[text.title]]" }, { field: "category", label: "[[text.category]]" },
    { field: "ballInCourt", label: "[[text.ballInCourt]]" }, { field: "dueDate", label: "[[text.dueDate]]", format: "date" },
    { field: "daysOverdue", label: "[[text.delayDays]]", format: "number" } ] });
});
</script>`,
  },
];

/** The module templates in the installation's language (see reportTemplates() for a reader's). */
export const MODULE_TEMPLATES: ReportTemplateDto[] = localizeTemplates(MODULE_TEMPLATE_SOURCES, DEFAULT_LANGUAGE);
