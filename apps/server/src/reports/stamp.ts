/**
 * Data change stamps for live report refresh.
 *
 * Statement-level triggers (migration 0020_report_stamps) bump a counter per project and scope on
 * every INSERT / UPDATE / DELETE of the tables behind the report datasets, whatever wrote the rows:
 * REST routes, MCP tools, background jobs (IFC conversion, clash runs), imports. Reads never write
 * it. A dataset lists the scopes it reads (`sources`); the stamp of a dashboard is the counters of
 * its datasets' scopes plus today's date (overdue / days-open values change at midnight).
 *
 * The browser polls the stamp (a single indexed read) and re-runs the queries only when it changed.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { reportChangeStamps } from "../db/schema.js";
import { dayKey } from "./engine.js";

/** Table groups with their own counter (see the trigger list in the migration). */
export const STAMP_SCOPES = [
  "files", // files, file_versions, folders, folder_grants
  "issues",
  "activity", // audit_log
  "members", // project_members
  "works", // works, work_types, work_revisions, work_receipts
  "workflow", // workflow_instances, workflow_actions
  "reviews", // reviews, review_files
  "forms", // forms, form_templates
  "locations", // locations, location_links
  "schedule", // schedules, schedule_activities, schedule_link_rules, activity_links
  "cost", // cost_items, cost_rules (5D)
  "coordination", // model_sets, clash_tests, clashes, clash_groups, clash_runs
  "doccompare", // doc_comparisons
  "docintel", // spec_registers, doc_extractions
] as const;
export type StampScope = (typeof STAMP_SCOPES)[number];

export interface StampValue {
  stamp: string;
  changedAt: string | null;
}

/**
 * Stamp of the given scopes: "<scope>:<counter>,…|<YYYY-MM-DD>". Scopes without writes yet count 0.
 * The day part makes date-dependent values (overdue, days open) refresh after midnight.
 */
export async function readStamp(
  db: Db,
  projectId: string,
  scopes: Iterable<StampScope>,
  o: { now?: Date; timeZone?: string } = {},
): Promise<StampValue> {
  const list = [...new Set(scopes)].sort();
  const rows = list.length
    ? await db
        .select()
        .from(reportChangeStamps)
        .where(and(eq(reportChangeStamps.projectId, projectId), inArray(reportChangeStamps.scope, list)))
    : [];
  const by = new Map(rows.map((r) => [r.scope, r]));
  const day = dayKey(o.now ?? new Date(), o.timeZone ?? "Europe/Istanbul");
  let changed: Date | null = null;
  for (const r of rows) if (!changed || r.changedAt > changed) changed = r.changedAt;
  return {
    stamp: `${list.map((s) => `${s}:${by.get(s)?.counter ?? 0}`).join(",")}|${day}`,
    changedAt: changed ? changed.toISOString() : null,
  };
}
