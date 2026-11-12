/** A meeting work's attendees, agenda and minutes (works.data), with defaults for missing parts. */
import { emptyMeetingData, type MeetingData } from "@sitekeep/shared";
import type { WorkRow } from "./service.js";

export function meetingDataOf(work: WorkRow): MeetingData {
  const d = work.data as Partial<MeetingData>;
  const base = emptyMeetingData();
  return {
    ...base,
    ...d,
    attendees: Array.isArray(d.attendees) ? d.attendees : [],
    agenda: Array.isArray(d.agenda) ? d.agenda : [],
    minutes: { items: Array.isArray(d.minutes?.items) ? d.minutes!.items : [], notes: d.minutes?.notes ?? null, updatedAt: d.minutes?.updatedAt ?? null },
  };
}
