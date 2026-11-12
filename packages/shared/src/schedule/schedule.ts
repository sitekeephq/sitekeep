/**
 * İş programı (project schedule): DTOs and the status rules shared by the server (filters,
 * lookahead, AI facts) and the web app (Gantt filters, 4D colouring in the viewer).
 * Dates are ISO calendar dates ("YYYY-MM-DD"); slips and variances are calendar days.
 */
export type ScheduleSourceType = "mspdi" | "xer" | "csv" | "xlsx";

export type ActivityStatus = "not_started" | "in_progress" | "complete" | "late";

export const SCHEDULE_SOURCE_LABELS_TR: Record<ScheduleSourceType, string> = {
  mspdi: "MS Project XML",
  xer: "Primavera P6 XER",
  csv: "CSV",
  xlsx: "Excel",
};

/** Fields the status rules need; ActivityDto and the 4D element rows both carry them. */
export interface ActivityDates {
  start: string | null;
  finish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
}

export interface ActivityDto extends ActivityDates {
  id: string;
  scheduleId: string;
  /** Activity code in the source (Kod / Activity ID / WBS-less UID); stable across versions. */
  code: string;
  /** Unique id in the source file (MSPDI UID, XER task_id, CSV row). */
  externalId: string | null;
  wbsPath: string | null;
  name: string;
  durationDays: number | null;
  critical: boolean;
  milestone: boolean;
  /** WBS summary row (MS Project summary task, P6 WBS node or CSV WBS group). */
  summary: boolean;
  resource: string | null;
  parentId: string | null;
  outlineLevel: number;
  sortIndex: number;
  /** finish − baselineFinish in days (positive = later than baseline). */
  finishVarianceDays: number | null;
  linkCount?: number;
  /** Distinct IFC elements linked to the activity (4D). */
  elementCount?: number;
}

// ---------------------------------------------------------------------------------------------
// Date helpers (UTC calendar days, no time zones involved).

const DAY = 86_400_000;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(s: string): number {
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
}

export function addDays(date: string, days: number): string {
  return isoDate(new Date(parseIsoDate(date) + Math.round(days) * DAY));
}

/** b − a in calendar days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseIsoDate(b) - parseIsoDate(a)) / DAY);
}

export function todayIso(): string {
  return isoDate(new Date());
}

// ---------------------------------------------------------------------------------------------
// Status rules

/**
 * Status of an activity on `date`, given the programme's data date `ref`.
 * - On or before the data date actual progress counts: complete when it actually finished,
 *   in progress when it actually started, late when it should have finished (baseline, else
 *   current plan) or started by then but did not.
 * - After the data date the current plan is simulated: complete once its planned finish has
 *   passed, in progress between start and finish, late when the baseline expected it finished.
 */
export function activityStatusAt(a: ActivityDates, date: string, ref: string): ActivityStatus {
  const pct = a.percentComplete ?? 0;
  const done = a.actualFinish ? a.actualFinish <= date : pct >= 100 && !!a.finish && a.finish <= date;
  if (done) return "complete";
  if (date <= ref) {
    const started = a.actualStart ? a.actualStart <= date : pct > 0 && (!a.start || a.start <= date);
    const planFinish = a.baselineFinish ?? a.finish;
    const planStart = a.baselineStart ?? a.start;
    if ((planFinish && planFinish < date) || (!started && planStart && planStart < date)) return "late";
    return started ? "in_progress" : "not_started";
  }
  if (pct >= 100) return "complete";
  if (a.finish && a.finish <= date) return "complete";
  if (a.baselineFinish && a.baselineFinish < date) return "late";
  if (a.start && a.start <= date) return "in_progress";
  return "not_started";
}
