/**
 * Phone / tablet view of the İşler hub lists: at the same width as the hamburger project nav
 * (≤ 900px) the tables of İşler, Sorunlar, İncelemeler and Formlar render as cards. These helpers
 * turn a list row into the card's content; components/RecordCards.tsx draws it.
 */
import type { WorkSummaryDto } from "@sitekeep/shared";
import { i18n } from "../../i18n";
import { formatDay } from "../../shared/api/api";

/** Narrow screens: lists switch from tables to cards (same breakpoint as the hamburger nav). */
export const PHONE_QUERY = "(max-width: 900px)";
/** Narrow layout: project sidenav is a hamburger and the document tree is hidden. */
export const NARROW_QUERY = "(max-width: 900px)";

export interface RecordCardChip {
  label: string;
  /** Badge tone: warn, danger, info, ok or "" (neutral). */
  tone: string;
}

export interface RecordCardData {
  id: string;
  /** Record number, shown small and monospace. */
  number: string;
  title: string;
  /** Second line (type, counterpart company…); empty parts are left out. */
  meta: (string | null | undefined)[];
  status: { label: string; tone: string };
  /** Due date; red when overdue. */
  due?: { text: string; overdue: boolean } | null;
  chips?: RecordCardChip[];
}

export interface RecordCardGroup {
  key: string;
  /** Group header (empty when the list is not grouped). */
  label: string;
  rows: RecordCardData[];
}

/** Today as YYYY-MM-DD in local time. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Due date of an open record (YYYY-MM-DD or ISO): overdue when the day is before today. */
export function dueOf(date: string | null | undefined, closed: boolean, today = localToday()): RecordCardData["due"] {
  if (!date) return null;
  const day = date.slice(0, 10);
  return { text: formatDay(day), overdue: !closed && day < today };
}

/** The other party of a work: the sender of an incoming one, otherwise the recipients. */
export function workCounterpart(
  w: Pick<WorkSummaryDto, "fromCompanyId" | "toCompanyIds">,
  incoming: boolean,
  companyNames: Map<string, string>,
): string | null {
  if (incoming) return (w.fromCompanyId && companyNames.get(w.fromCompanyId)) || null;
  const names = w.toCompanyIds.map((c) => companyNames.get(c)).filter((x): x is string => !!x);
  return names.length ? names.join(", ") : null;
}

/** Card of a work in the İşler list: number, title, type, status, counterpart, due date, "Cevap Bekleniyor". */
export function workCard(w: WorkSummaryDto, opts: { incoming: boolean; companyNames: Map<string, string> }): RecordCardData {
  return {
    id: w.id,
    number: w.number,
    title: w.title,
    meta: [w.typeName, workCounterpart(w, opts.incoming, opts.companyNames)],
    status: { label: w.statusLabel, tone: w.statusTone },
    due: w.dueDate ? { text: formatDay(w.dueDate), overdue: w.overdue } : null,
    chips: w.replyRequired && !w.closed ? [{ label: i18n.t("works:list.badges.replyAwaited"), tone: "warn" }] : [],
  };
}
