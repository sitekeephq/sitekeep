import type { WorkSummaryDto } from "@sitekeep/shared";

export function WorkStatusBadge({ w }: { w: Pick<WorkSummaryDto, "statusLabel" | "statusTone"> }) {
  return <span className={`badge ${w.statusTone}`}>{w.statusLabel}</span>;
}

export function dueClass(w: Pick<WorkSummaryDto, "overdue" | "closed">) {
  return w.overdue ? " error" : " muted";
}
