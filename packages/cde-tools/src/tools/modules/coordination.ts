import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, day, type Any } from "../../format/common.js";

const CLASH_OPEN = (counts: Record<string, number> | undefined) => (counts?.new ?? 0) + (counts?.active ?? 0);

export function registerCoordinationTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// ---- Coordination ------------------------------------------------------------------------

tool(
  "cde_clash_tests_list",
  "Clash tests (model set, type, tolerance), last run and clash counts by status (open = new + active).",
  { projectId: pid },
  async (a) =>
    (await call<Any[]>("GET", `/projects/${a.projectId}/clash-tests`)).map((t) =>
      clean({
        id: t.id,
        name: t.name,
        modelSet: t.modelSetName,
        type: t.type,
        toleranceMm: t.toleranceMm,
        open: CLASH_OPEN(t.counts),
        counts: t.counts,
        lastRun: t.lastRun ? clean({ status: t.lastRun.status, at: day(t.lastRun.finishedAt ?? t.lastRun.createdAt), clashes: t.lastRun.stats?.clashes }) : null,
      }),
    ),
);

tool(
  "cde_clash_results",
  "Results of a clash test: counts by status, counts by IFC class pair and the largest clash groups (assigned company, linked issue).",
  { projectId: pid, testId: id("Clash test id"), topGroups: z.number().int().min(1).max(50).default(10) },
  async (a) => {
    const r = await call<Any>("GET", `/projects/${a.projectId}/clash-tests/${a.testId}/results`);
    const pairs = (r.byClassPair as Any[])
      .map((p) => ({ pair: p.pair, open: CLASH_OPEN(p.counts), counts: p.counts }))
      .sort((x, y) => y.open - x.open)
      .slice(0, 15);
    const groups = (r.groups as Any[])
      .map((g) => clean({ id: g.id, title: g.title, open: CLASH_OPEN(g.counts), counts: g.counts, company: g.assignedCompanyName, issue: g.issueNumber ? `#${g.issueNumber}` : null }))
      .sort((x: Any, y: Any) => y.open - x.open);
    return clean({
      test: r.test?.name,
      counts: r.test?.counts,
      open: CLASH_OPEN(r.test?.counts),
      clashCount: (r.clashes ?? []).length,
      byClassPair: pairs,
      groupCount: groups.length,
      topGroups: groups.slice(0, a.topGroups),
    });
  },
);
}
