/**
 * cde_dev_time: moves dates of seeded records in a test project so date-dependent screens (Bugün,
 * gecikenler, termin uyarıları, raporlar) can be tested: make a share of open records overdue, or
 * shift every date of the records by N days.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { issues, workflowInstances, works } from "../db/schema.js";
import type { DevContext } from "./context.js";
import { DAY_SEC, setStepDue, setWorkDue, shiftForm, shiftIssue, shiftReview, shiftWork } from "./dates.js";
import { Rng, dayOffset, seedFromTag } from "./random.js";
import { findProject, requireTestProject } from "./registry.js";

const addDays = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return dayOffset(n, new Date(y!, m! - 1, day!, 12));
};

export async function devTime(ctx: DevContext, a: Record<string, unknown>) {
  const p = await findProject(ctx.db, String(a.project));
  const reg = await requireTestProject(ctx.db, p, a.confirm as boolean, "Tarihleri kaydırmak");
  if (a.overdueRatio === undefined && a.shiftDays === undefined) throw new Error("overdueRatio veya shiftDays verin.");
  const seeds = reg.projects[p.id]?.seeds ?? {};
  const tags = a.tag ? [String(a.tag)] : Object.keys(seeds);
  if (a.tag && !seeds[String(a.tag)]) throw new Error(`'${a.tag}' etiketli örnek veri yok.`);
  const ids = (k: string) => [...new Set(tags.flatMap((t) => seeds[t]?.records[k] ?? []))];
  const kinds = new Set((a.kinds as string[] | undefined) ?? ["works", "issues", "reviews", "forms"]);
  const out: Record<string, unknown> = { project: p.code, tags };

  if (typeof a.shiftDays === "number" && a.shiftDays !== 0) {
    const days = a.shiftDays;
    const sec = days * DAY_SEC;
    const moved: Record<string, number> = {};
    if (kinds.has("works"))
      for (const id of ids("works")) {
        await shiftWork(ctx.db, id, sec);
        const [w] = await ctx.db.select({ due: works.dueDate }).from(works).where(eq(works.id, id));
        if (w?.due) await ctx.db.update(works).set({ dueDate: addDays(w.due, days) }).where(eq(works.id, id));
        moved.works = (moved.works ?? 0) + 1;
      }
    if (kinds.has("issues"))
      for (const id of ids("issues")) {
        await shiftIssue(ctx.db, id, sec);
        const [i] = await ctx.db.select({ due: issues.dueDate }).from(issues).where(eq(issues.id, id));
        if (i?.due) await ctx.db.update(issues).set({ dueDate: addDays(i.due, days) }).where(eq(issues.id, id));
        moved.issues = (moved.issues ?? 0) + 1;
      }
    if (kinds.has("reviews")) for (const id of ids("reviews")) (await shiftReview(ctx.db, id, sec), (moved.reviews = (moved.reviews ?? 0) + 1));
    if (kinds.has("forms")) for (const id of ids("forms")) (await shiftForm(ctx.db, id, sec), (moved.forms = (moved.forms ?? 0) + 1));
    out.shifted = { days, ...moved };
  }

  if (typeof a.overdueRatio === "number") {
    const ratio = a.overdueRatio;
    const rng = new Rng(seedFromTag(`${p.code}:time:${Date.now()}`));
    const pick = () => (rng.chance(ratio) ? dayOffset(-rng.int(1, 20)) : dayOffset(rng.int(3, 21)));
    const result: Record<string, { open: number; overdue: number }> = {};
    const today = dayOffset(0);
    if (kinds.has("works") && ids("works").length) {
      const open = await ctx.db
        .select({ id: works.id })
        .from(works)
        .where(and(inArray(works.id, ids("works")), isNull(works.closedAt), ne(works.status, "taslak")));
      let overdue = 0;
      for (const w of open) {
        const d = pick();
        if (d < today) overdue++;
        await setWorkDue(ctx.db, w.id, d);
      }
      result.works = { open: open.length, overdue };
    }
    if (kinds.has("issues") && ids("issues").length) {
      const open = await ctx.db.select({ id: issues.id }).from(issues).where(and(inArray(issues.id, ids("issues")), ne(issues.status, "closed")));
      let overdue = 0;
      for (const i of open) {
        const d = pick();
        if (d < today) overdue++;
        await ctx.db.update(issues).set({ dueDate: d }).where(eq(issues.id, i.id));
      }
      result.issues = { open: open.length, overdue };
    }
    for (const [kind, subject] of [
      ["reviews", "review"],
      ["forms", "form"],
    ] as const) {
      if (!kinds.has(kind) || !ids(kind).length) continue;
      const running = await ctx.db
        .select({ id: workflowInstances.subjectId })
        .from(workflowInstances)
        .where(and(eq(workflowInstances.subjectType, subject), eq(workflowInstances.status, "running"), inArray(workflowInstances.subjectId, ids(kind))));
      let overdue = 0;
      for (const r of running) {
        const d = pick();
        if (d < today) overdue++;
        await setStepDue(ctx.db, subject, r.id, new Date(`${d}T17:00:00`));
      }
      result[kind] = { open: running.length, overdue };
    }
    out.overdue = { ratio, ...result };
  }
  return out;
}
