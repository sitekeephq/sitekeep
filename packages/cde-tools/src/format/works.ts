import { clean, day, type Any, type Row } from "./common.js";

/** Compact work row (list, today, children). */
export function workRow(w: Any, ballInCourt?: string[]): Row {
  return clean({ id: w.id, number: w.number, title: w.title, type: w.typeName, status: w.statusLabel ?? w.status, ...(w.closed && { closed: true }), due: day(w.dueDate), overdue: !!w.overdue, ballInCourt });
}
