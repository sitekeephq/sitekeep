import { describe, expect, it } from "vitest";
import { xerCalendar } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/xer.js";
import { parseMspdi } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/mspdi.js";
import { writeMspdi } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/mspdi.js";

const day = (d: number, work: boolean) => `(0||${d}()(${work ? "(0||0(s|08:00|f|17:00)())" : ""}))`;

describe("calendars on import", () => {
  it("reads P6 work days and holidays from clndr_data", () => {
    const data = `(0||CalendarData()((0||DaysOfWeek()(${day(1, false)}${[2, 3, 4, 5, 6].map((d) => day(d, true)).join("")}${day(7, true)}))(0||VIEW(ShowTotal|N)())(0||Exceptions()((0||0(d|46388)())(0||1(d|46389)((0||0(s|08:00|f|12:00)()))))))`;
    const c = xerCalendar({ clndr_name: "6 Gün", clndr_data: data, day_hr_cnt: "8", week_hr_cnt: "48" });
    expect(c.workDays).toEqual([1, 2, 3, 4, 5, 6]);
    // 46388 = 2027-01-01 (holiday); 46389 has work periods, so it is not a holiday
    expect(c.holidays).toEqual(["2027-01-01"]);
    expect(c.hoursPerDay).toBe(8);
  });

  it("falls back to weekly hours when DaysOfWeek is missing", () => {
    expect(xerCalendar({ clndr_name: "x", clndr_data: "", day_hr_cnt: "8", week_hr_cnt: "56" }).workDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("reads the MS Project calendar written by the exporter", () => {
    const xml = writeMspdi({
      projectCode: "P",
      projectName: "P",
      schedule: { id: "s", name: "S", version: 1, dataDate: "2027-01-04", startDate: "2027-01-04", finishDate: "2027-01-08" },
      activities: [
        { id: "a", scheduleId: "s", code: "A1", externalId: null, wbsPath: null, name: "İş", start: "2027-01-04", finish: "2027-01-08", baselineStart: null, baselineFinish: null, actualStart: null, actualFinish: null, percentComplete: 0, durationDays: 5, critical: false, milestone: false, summary: false, resource: null, parentId: null, outlineLevel: 1, sortIndex: 0, finishVarianceDays: null },
      ],
      dependencies: [],
      locations: new Map(),
      calendar: { name: "5 gün", hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: ["2027-01-06"] },
      exportedAt: "2027-01-01T00:00:00Z",
    }).data.toString("utf8");
    const p = parseMspdi(xml);
    expect(p.calendar).toMatchObject({ workDays: [1, 2, 3, 4, 5], hoursPerDay: 8 });
    expect(p.calendar!.holidays).toContain("2027-01-06");
    expect(p.activities[0]!.code).toBe("A1");
  });
});
