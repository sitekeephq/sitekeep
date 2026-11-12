import { WORK_CATEGORIES } from "@sitekeep/shared";
import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, cut, day, qs, type Any, type Row } from "../../format/common.js";
import { capList } from "../../format/lists.js";
import { workRow } from "../../format/works.js";

function stepRow(step: Any): Row { return clean({ step: step.name, state: step.state, assignees: step.assignees, due: day(step.dueAt), overdue: !!step.overdue, result: step.result?.label, answers: (step.answers ?? []).slice(0, 6).map((answer: Any) => clean({ by: answer.userName, answer: answer.label, comment: cut(answer.comment, 200), response: cut(answer.response, 400), at: day(answer.at) })) }); }

export function registerWorksTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const companyNames = async (): Promise<Map<string, string>> =>
    call<Any[]>("GET", "/companies")
      .then((rows) => new Map(rows.map((company) => [company.id as string, company.name as string])))
      .catch(() => new Map<string, string>());
// ---- Works -----------------------------------------------------------------------------

tool(
  "cde_work_types_list",
  "Work types of a project (key, name, category, custom fields with required flag and options, statuses). Use before cde_work_create.",
  { projectId: pid },
  async (a) =>
    (await call<Any[]>("GET", `/projects/${a.projectId}/work-types`)).map((t) =>
      clean({
        key: t.key,
        name: t.name,
        category: t.category,
        fields: (t.fields ?? []).map((f: Any) => clean({ key: f.key, label: f.label, type: f.type, required: !!f.required, options: f.options })),
        statuses: (t.statuses ?? []).map((s: Any) => s.key),
      }),
    ),
);

tool(
  "cde_works_list",
  "Lists works (RFI, submittal, meeting, action, letter, transmittal…): number, title, status, ball-in-court companies, due date. " +
    "Filters: category, type key, status, open, overdue, mine (assigned to or created by me), text.",
  {
    projectId: pid,
      category: z.enum(WORK_CATEGORIES).optional(),
    type: z.string().max(200).optional().describe("Work type key(s), comma separated"),
    status: z.string().max(200).optional().describe("Status key(s), comma separated"),
    open: z.boolean().optional().describe("Only works that are not closed"),
    overdue: z.boolean().optional(),
    mine: z.boolean().optional(),
    q: z.string().max(200).optional().describe("Text in number, title or fields"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async (a) => {
    const rows = await call<Any[]>(
      "GET",
      `/projects/${a.projectId}/works${qs({ category: a.category, type: a.type, status: a.status, open: a.open, due: a.overdue ? "overdue" : undefined, mine: a.mine, q: a.q, limit: 2000 })}`,
    );
    // Ball in court: workflow step assignees for RFIs / submittals, addressees for other open works.
    const bic = new Map<string, string[]>();
    const cats = new Set(rows.map((w) => w.category));
    const [rfis, subs, companies] = await Promise.all([
      cats.has("rfi") ? call<Any[]>("GET", `/projects/${a.projectId}/rfis/log`).catch(() => []) : [],
      cats.has("submittal") || cats.has("submittal_package")
        ? call<Any[]>("GET", `/projects/${a.projectId}/submittals/register`).catch(() => [])
        : [],
      companyNames(),
    ]);
    for (const r of [...rfis, ...subs]) bic.set(r.id, r.ballInCourt ?? []);
    const list = capList(
      rows.map((w) =>
        workRow(w, w.closed ? undefined : (bic.get(w.id) ?? (w.toCompanyIds ?? []).map((c: string) => companies.get(c) ?? c))),
      ),
      a.limit,
    );
    return clean({
      total: rows.length,
      overdue: rows.filter((w) => w.overdue).length,
      works: list.items,
      more: list.more,
    });
  },
);

tool(
  "cde_work_get",
  "Work details: fields, parties, links (files, other works), timeline summary, RFI/submittal workflow chain " +
    "(steps, answers, ball in court, official response), package items or meeting minutes.",
  { projectId: pid, workId: wid },
  async (a) => {
    const w = await call<Any>("GET", `/projects/${a.projectId}/works/${a.workId}`);
    const names: Record<string, string> = w.names ?? {};
    const n = (x: string | null | undefined) => (x ? (names[x] ?? x) : null);
    const b = w.build;
    const events: Any[] = w.events ?? [];
    const links = capList(
      (w.links ?? []).map((l: Any) =>
        clean({ kind: l.kind, role: l.role, label: l.target?.label, v: l.target?.version, revision: l.target?.revision, status: l.target?.status, missing: !!l.target?.missing }),
      ),
      20,
    );
    const meeting = b?.meeting;
    return clean({
      ...workRow(w),
      category: w.category,
      from: n(w.fromCompanyId),
      to: (w.toCompanyIds ?? []).map(n),
      cc: (w.ccCompanyIds ?? []).map(n),
      assignee: n(w.assigneeUserId),
      createdBy: w.createdByName,
      created: day(w.createdAt),
      sent: day(w.sentAt),
      fields: Object.fromEntries(Object.entries(w.fields ?? {}).map(([k, v]) => [k, typeof v === "string" ? cut(v, 300) : v])),
      links: links.items,
      moreLinks: links.more,
      referencedBy: (w.backlinks ?? []).slice(0, 10).map((l: Any) => l.target?.label),
      letter: w.letter
        ? clean({
            languages: (w.letter.data?.secondaryLanguage ? [w.letter.data.language, w.letter.data.secondaryLanguage] : [w.letter.data?.language]).filter(Boolean),
            layout: w.letter.data?.secondaryLanguage ? w.letter.data.layout : undefined,
            recipient: w.letter.data?.recipient?.name || undefined,
            recipientEmail: w.letter.data?.recipient?.email || undefined,
            cc: w.letter.data?.ccEmails,
            signer: w.letter.data?.signer?.name || undefined,
            mailSent: !!w.letter.data?.mailSentAt,
            mailSentAt: day(w.letter.data?.mailSentAt),
            threadCount: w.letter.threadCount,
          })
        : undefined,
      timeline: {
        events: events.length,
        last: events
          .slice(-10)
          .map((e) => clean({ at: day(e.at), kind: e.kind, by: e.userName, text: cut(e.message, 200) })),
      },
      ...(b && {
        workflow: clean({
          rev: b.rev,
          ballInCourt: b.ballInCourt,
          status: b.workflow?.status,
          template: b.workflow?.templateName,
          steps: (b.workflow?.steps ?? []).map(stepRow),
          canAct: !!b.workflow?.canAct,
          options: b.workflow?.canAct ? (b.workflow.options ?? []).map((o: Any) => `${o.code}: ${o.label}`) : undefined,
          needsResponse: !!b.workflow?.needsResponse,
          officialResponse: cut(b.officialResponse, 1000),
          revisions: (b.revisions ?? []).length > 1 ? b.revisions.map((r: Any) => clean({ rev: r.rev, status: r.status, outcome: r.outcomeLabel, decided: day(r.decidedAt) })) : undefined,
        }),
        items: (b.children ?? []).length ? capList(b.children.map((c: Any) => workRow(c)), 30).items : undefined,
        parent: b.parent ? workRow(b.parent) : undefined,
        meeting: meeting
          ? clean({
              attendees: (meeting.attendees ?? []).length,
              agenda: (meeting.agenda ?? []).slice(0, 20).map((x: Any) => x.text),
              minutes: (meeting.minutes?.items ?? []).slice(0, 50).map((i: Any) =>
                clean({ id: i.id, konu: i.konu, karar: cut(i.karar, 300), sorumlu: n(i.sorumluUserId) ?? n(i.sorumluCompanyId), termin: i.termin, action: !!i.actionWorkId }),
              ),
              notes: cut(meeting.minutes?.notes, 500),
              carried: (b.carried ?? []).length ? b.carried.slice(0, 20).map((c: Any) => workRow(c)) : undefined,
            })
          : undefined,
      }),
    });
  },
);

tool(
  "cde_work_thread",
  "Correspondence thread (yazışma zinciri) of a work: every letter connected through \"ilgi\" references in both directions " +
    "(replies, letters citing it, earlier letters), oldest first, with what each one refers to. count excludes the work itself.",
  { projectId: pid, workId: wid },
  async (a) => {
    const rows = await call<Any[]>("GET", `/projects/${a.projectId}/works/${a.workId}/thread`);
    const numberOf = new Map(rows.map((r) => [r.id as string, r.number as string]));
    return {
      count: rows.filter((r) => r.id !== a.workId).length,
      works: rows.map((r) =>
        clean({
          ...workRow(r),
          ...(r.id === a.workId && { self: true }),
          date: day(r.sentAt ?? r.createdAt),
          refersTo: (r.refs ?? []).map((x: string) => numberOf.get(x) ?? x),
        }),
      ),
    };
  },
);

const registerFilters = {
  open: z.boolean().optional().describe("Only open rows"),
  overdue: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
};
const filterRows = (rows: Any[], a: { open?: boolean; overdue?: boolean }) =>
  rows.filter((r) => (!a.open || !r.closed) && (!a.overdue || r.overdue));

tool(
  "cde_rfi_log",
  "RFI log: number, title, status, discipline, priority, from/to, ball in court, due, days open, answer date and response.",
  { projectId: pid, ...registerFilters },
  async (a) => {
    const rows = await call<Any[]>("GET", `/projects/${a.projectId}/rfis/log`);
    const list = capList(
      filterRows(rows, a).map((r) =>
        clean({
          id: r.id,
          number: r.number,
          title: r.title,
          status: r.statusLabel,
          discipline: r.discipline,
          priority: r.priority,
          from: r.from,
          to: r.to,
          ballInCourt: r.closed ? undefined : r.ballInCourt,
          due: r.dueDate,
          overdue: !!r.overdue,
          daysOpen: r.daysOpen,
          answered: day(r.answeredAt),
          costImpact: r.costImpact,
          scheduleImpact: r.scheduleImpact,
          response: cut(r.response, 300),
        }),
      ),
      a.limit,
    );
    return clean({
      total: rows.length,
      open: rows.filter((r) => !r.closed).length,
      overdue: rows.filter((r) => r.overdue).length,
      rfis: list.items,
      more: list.more,
    });
  },
);

tool(
  "cde_submittal_register",
  "Submittal register: item number, title, status, spec section, kind, package, revision, due, ball in court and outcome.",
  { projectId: pid, ...registerFilters },
  async (a) => {
    const rows = await call<Any[]>("GET", `/projects/${a.projectId}/submittals/register`);
    const list = capList(
      filterRows(rows, a).map((r) =>
        clean({
          id: r.id,
          number: r.number,
          title: r.title,
          status: r.statusLabel,
          section: [r.sectionCode, r.sectionTitle].filter(Boolean).join(" ") || null,
          kind: r.kindLabel ?? r.kind,
          discipline: r.discipline,
          package: r.packageNumber,
          rev: r.rev,
          due: r.dueDate,
          overdue: !!r.overdue,
          ballInCourt: r.closed ? undefined : r.ballInCourt,
          submitted: day(r.submittedAt),
          outcome: r.outcomeLabel,
        }),
      ),
      a.limit,
    );
    return clean({
      total: rows.length,
      open: rows.filter((r) => !r.closed).length,
      overdue: rows.filter((r) => r.overdue).length,
      submittals: list.items,
      more: list.more,
    });
  },
);

tool(
  "cde_today",
  "My tasks across projects: works assigned to me, letters awaiting my reply, transmittals to confirm, due soon, overdue, and review steps waiting for me.",
  {},
  async () => {
    const t = await call<Any>("GET", "/me/today");
    const rows = (list: Any[]) =>
      list.slice(0, 10).map((w) => ({ projectId: w.projectId, project: w.projectCode, ...workRow(w) }));
    return clean({
      counts: t.counts,
      assigned: rows(t.assigned ?? []),
      awaitingReply: rows(t.awaitingReply ?? []),
      toReceive: rows(t.toReceive ?? []),
      dueSoon: rows(t.dueSoon ?? []),
      overdue: rows(t.overdue ?? []),
      tasks: (t.tasks ?? []).slice(0, 15).map((k: Any) =>
        clean({ projectId: k.projectId, project: k.projectCode, kind: k.kind, subjectId: k.subjectId, code: k.code ?? `#${k.number}`, name: k.name, step: k.stepName, due: day(k.stepDueAt), overdue: !!k.overdue }),
      ),
    });
  },
);

tool(
  "cde_project_today",
  "The project's \"Bugün\" page for the caller: today's summary (the AI summary when a fresh one is ready, else the automatic one), " +
    "counts, what waits for me (steps, assigned works, actions, replies, receipts, forms, issues), overdue, due soon and recent changes.",
  { projectId: pid },
  async (a) => {
    // ai=0: reading over MCP never starts a summary run of the caller's model.
    const t = await call<Any>("GET", `/projects/${a.projectId}/today?ai=0`);
    const row = (r: Any) =>
      clean({ id: r.id, kind: r.kind, number: r.number, title: cut(r.title, 120), type: r.typeLabel, status: r.statusLabel, due: day(r.dueDate), overdue: !!r.overdue, note: r.note, from: r.party });
    const list = (rows: Any[] = [], n = 10) => {
      const c = capList(rows, n);
      return clean({ items: c.items.map(row), more: c.more });
    };
    const s = t.summary ?? {};
    const ai = s.ai?.fresh ? s.ai : null;
    return clean({
      summary: clean({
        source: ai ? "ai" : "auto",
        generatedAt: ai?.generatedAt,
        model: ai?.model,
        bullets: ((ai ? ai.bullets : s.auto) ?? []).map((b: Any) => b.text),
      }),
      counts: t.counts,
      mine: Object.fromEntries(Object.entries((t.mine ?? {}) as Record<string, Any[]>).filter(([, v]) => v.length).map(([k, v]) => [k, list(v)])),
      overdue: list(t.overdue),
      upcoming: list(t.upcoming),
      upcomingDays: t.upcomingDays,
      changes: (t.changes ?? []).slice(0, 3).map((d: Any) => ({
        day: d.day,
        changes: d.changes.slice(0, 8).map((c: Any) => clean({ who: c.userName, what: c.text, items: c.items.map((i: Any) => i.label) })),
      })),
    });
  },
);
}
