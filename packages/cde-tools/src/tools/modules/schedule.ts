import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, cut, day, qs, type Any, type Row } from "../../format/common.js";
import { capList } from "../../format/lists.js";
import { activityRow, previousSchedule, schedulePair } from "../../format/schedule.js";


export function registerScheduleTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// ---- Schedule ----------------------------------------------------------------------------

const scheduleRow = (s: Any): Row =>
  clean({
    id: s.id,
    name: s.name,
    version: s.version,
    baseline: !!s.isBaseline,
    dataDate: s.dataDate,
    start: s.startDate,
    finish: s.finishDate,
    activities: s.activityCount,
    imported: day(s.createdAt),
  });

async function latestScheduleId(projectId: string): Promise<string> {
  const { latest } = schedulePair(await call<Any[]>("GET", `/projects/${projectId}/schedules`));
  if (!latest) throw new Error("Bu projede iş programı yok.");
  return latest.id;
}

tool(
  "cde_schedule_list",
  "Project schedules (iş programı) and their versions: data date, start, finish, activity count, baseline flag.",
  { projectId: pid },
  async (a) => (await call<Any[]>("GET", `/projects/${a.projectId}/schedules`)).map(scheduleRow),
);

tool(
  "cde_schedule_activities",
  "Activities of a schedule (default: the newest). Filters: late (gecikenler at the data date), critical, lookaheadWeeks " +
    "(activities in the next N weeks), wbs prefix, text.",
  {
    projectId: pid,
    scheduleId: id("Schedule id (default: newest)").optional(),
    late: z.boolean().optional(),
    critical: z.boolean().optional(),
    lookaheadWeeks: z.number().int().min(1).max(26).optional(),
    wbs: z.string().max(200).optional(),
    q: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).default(40),
  },
  async (a) => {
    const sid = a.scheduleId ?? (await latestScheduleId(a.projectId));
    let rows: Any[];
    let window: Row | undefined;
    if (a.lookaheadWeeks) {
      const la = await call<Any>("GET", `/projects/${a.projectId}/schedules/${sid}/lookahead${qs({ weeks: a.lookaheadWeeks })}`);
      rows = (la.activities as Any[]).filter((x) => (!a.late || (x.finishVarianceDays ?? 0) > 0) && (!a.critical || x.critical));
      window = { from: la.from, to: la.to };
    } else {
      rows = await call<Any[]>(
        "GET",
        `/projects/${a.projectId}/schedules/${sid}/activities${qs({ late: a.late, critical: a.critical, wbs: a.wbs, q: a.q, summaries: "0" })}`,
      );
    }
    const list = capList(rows.map(activityRow), a.limit);
    return clean({ scheduleId: sid, ...window, total: rows.length, activities: list.items, more: list.more });
  },
);

tool(
  "cde_schedule_compare",
  "Compares two schedule versions (default: newest vs. its baseline or previous version): project finish slip, slipped / improved activities, newly critical, added, removed.",
  { projectId: pid, fromScheduleId: id("Older version").optional(), toScheduleId: id("Newer version").optional() },
  async (a) => {
    let from = a.fromScheduleId;
    let to = a.toScheduleId;
    if (!from || !to) {
      const list = await call<Any[]>("GET", `/projects/${a.projectId}/schedules`);
      const target = to ? list.find((s) => s.id === to) : schedulePair(list).latest;
      to ??= target?.id;
      from ??= target ? previousSchedule(list, target)?.id : undefined;
      if (!to || !from) throw new Error("Karşılaştırılacak ikinci bir iş programı versiyonu yok.");
    }
    const c = await call<Any>("GET", `/projects/${a.projectId}/schedules/compare${qs({ from, to })}`);
    const slip = (s: Any) => clean({ code: s.code, name: s.name, finishSlipDays: s.finishSlipDays, startSlipDays: s.startSlipDays, toFinish: s.toFinish, critical: !!s.toCritical });
    return clean({
      from: clean({ name: c.from.name, version: c.from.version, dataDate: c.from.dataDate, finish: c.from.finishDate }),
      to: clean({ name: c.to.name, version: c.to.version, dataDate: c.to.dataDate, finish: c.to.finishDate }),
      finishSlipDays: c.finishSlipDays,
      counts: { slipped: c.slipped.length, improved: c.improved.length, becameCritical: c.becameCritical.length, added: c.added.length, removed: c.removed.length },
      topSlipped: c.slipped.slice(0, 10).map(slip),
      becameCritical: c.becameCritical.slice(0, 10).map(slip),
      added: c.added.slice(0, 10).map((x: Any) => `${x.code} ${x.name}`),
      removed: c.removed.slice(0, 10).map((x: Any) => `${x.code} ${x.name}`),
    });
  },
);

// ---- 4D / 5D ---------------------------------------------------------------------------------

tool(
  "cde_4d_state",
  "4D state of a schedule on a date (default: newest schedule at its data date): activities and linked IFC elements by status " +
    "(not_started, in_progress, complete, late) and the active activities with % complete on that date. " +
    "mode: actual (reported progress, default) or planned (baseline dates only).",
  {
    projectId: pid,
    scheduleId: id("Schedule id (default: newest)").optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; default: the data date"),
    mode: z.enum(["actual", "planned"]).default("actual"),
    limit: z.number().int().min(1).max(200).default(40),
  },
  async (a) => {
    const sid = a.scheduleId ?? (await latestScheduleId(a.projectId));
    const s = await call<Any>("GET", `/projects/${a.projectId}/schedules/${sid}/4d-state${qs({ date: a.date, mode: a.mode })}`);
    const list = capList(
      (s.active as Any[]).map((x) =>
        clean({ code: x.code, name: cut(x.name, 120), status: x.status, percent: x.percent, start: day(x.start), finish: day(x.finish), elements: x.elementCount }),
      ),
      a.limit,
    );
    return clean({
      scheduleId: sid,
      date: s.date,
      mode: s.mode,
      dataDate: s.dataDate,
      activities: s.counts,
      elements: s.elementCounts,
      linkedElements: s.linkedElements,
      active: list.items,
      more: list.more,
    });
  },
);

tool(
  "cde_cost_summary",
  "5D cost of the IFC models: unit prices (birim fiyat) × element base quantities by the cost rules. Total, by cost item, category, storey, " +
    "IFC class and schedule activity, plus elements without the base quantity. Default: newest version of every model with cost rules; " +
    "versionId: one model version.",
  {
    projectId: pid,
    versionId: id("IFC file version id (optional)").optional(),
    scheduleId: id("Schedule for the activity split (default: newest)").optional(),
    limit: z.number().int().min(1).max(100).default(15),
  },
  async (a) => {
    const c = await call<Any>("GET", `/projects/${a.projectId}/costs${qs({ versionId: a.versionId, scheduleId: a.scheduleId })}`);
    const top = (list: Any[]) => list.slice(0, a.limit).map((g) => clean({ name: g.label, amount: g.amount, elements: g.count }));
    return clean({
      currency: c.currency,
      total: c.total,
      models: (c.versions as Any[]).map((v) => `${v.fileName} V${v.version}`),
      elements: c.elementCount,
      lines: c.lineCount,
      byItem: (c.byItem as Any[]).slice(0, a.limit).map((i) =>
        clean({ code: i.code, description: cut(i.description, 100), unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice, amount: i.amount }),
      ),
      byCategory: top(c.byCategory),
      byStorey: top(c.byStorey),
      byClass: top(c.byClass),
      byActivity: top(c.byActivity),
      missingQuantities: c.missingCount,
      missingSample: (c.missing as Any[]).slice(0, 10).map((m) => `${m.name ?? m.guid} (${m.cls}, ${m.storey ?? "—"}): ${m.quantity}`),
      warnings: c.warnings,
    });
  },
);
}
