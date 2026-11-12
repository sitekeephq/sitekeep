import { clean, type Any, type Row } from "./common.js";
export function schedulePair(list: Any[]): { latest: Any | null; previous: Any | null } {
  if (!list.length) return { latest: null, previous: null };
  const latest = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]!;
  return { latest, previous: previousSchedule(list, latest) };
}
export function previousSchedule(list: Any[], schedule: Any): Any | null {
  const series = list.filter((item) => item.seriesId === schedule.seriesId && item.id !== schedule.id);
  return series.find((item) => item.isBaseline) ?? series.filter((item) => item.version < schedule.version).sort((a, b) => b.version - a.version)[0] ?? null;
}
export function activityRow(activity: Any): Row {
  return clean({ code: activity.code, name: activity.name, wbs: activity.wbsPath, start: activity.start, finish: activity.finish, pct: activity.percentComplete, critical: !!activity.critical, milestone: !!activity.milestone, varianceDays: activity.finishVarianceDays || undefined });
}
