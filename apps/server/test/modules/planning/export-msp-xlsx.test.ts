import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { addDays } from "@sitekeep/shared";
import { basisSummary } from "@sitekeephq/sitekeep-ee-planning/shared/basis.js";
import { type ActivityDto, type DependencyDto } from "@sitekeephq/sitekeep-ee-planning/shared/schedule.js";
import { type ActivityLocationDto } from "@sitekeephq/sitekeep-ee-planning/shared/linear.js";
import { writeTimelinerCsv } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/csv.js";
import { DEFAULT_EXPORT_CALENDAR, type ExportModel } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/model.js";
import { MSP_FIELD_NUMBER1, MSP_FIELD_NUMBER2, MSP_FIELD_TEXT1, workingDaysBetween, writeMspdi } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/mspdi.js";
import { writeScheduleXlsx } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/xlsx.js";
import { parseUpload } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/import.js";
import { parseMspdi } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/mspdi.js";
import { writeXer } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/xer.js";
import { parseXer } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/xer.js";
import { parseCsv } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/table.js";
import { readXlsx } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/xlsx.js";

const WBS_NAME = "Köprü İmalatı ğüşıöç";
const TRICKY = 'Kazık, "Ø80" imalatı & <test>';

function activity(p: Partial<ActivityDto> & Pick<ActivityDto, "id" | "code" | "name">): ActivityDto {
  return {
    scheduleId: "s",
    externalId: null,
    wbsPath: null,
    durationDays: null,
    critical: false,
    milestone: false,
    summary: false,
    resource: null,
    parentId: null,
    outlineLevel: 1,
    sortIndex: 0,
    finishVarianceDays: null,
    start: null,
    finish: null,
    baselineStart: null,
    baselineFinish: null,
    actualStart: null,
    actualFinish: null,
    percentComplete: 0,
    ...p,
  };
}

function location(code: string, kmStart: number, kmEnd: number): ActivityLocationDto {
  return {
    seriesId: "series",
    activityCode: code,
    kmStart,
    kmEnd,
    locationId: null,
    category: "bridge",
    source: "manual",
    rule: null,
    detail: null,
    confidence: null,
    model: null,
    updatedBy: null,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function model(): ExportModel {
  const activities: ActivityDto[] = [
    activity({ id: "w1", code: "W1", name: WBS_NAME, summary: true, wbsPath: "1", start: "2026-01-05", finish: "2026-01-23", durationDays: 15, percentComplete: 10 }),
    activity({
      id: "a10",
      code: "A10",
      name: TRICKY,
      parentId: "w1",
      outlineLevel: 2,
      wbsPath: "1.1",
      start: "2026-01-05",
      finish: "2026-01-09",
      durationDays: 5,
      baselineStart: "2026-01-05",
      baselineFinish: "2026-01-08",
      actualStart: "2026-01-05",
      percentComplete: 40,
      critical: true,
    }),
    activity({ id: "a20", code: "A20", name: "Kolon betonu", parentId: "w1", outlineLevel: 2, wbsPath: "1.2", start: "2026-01-12", finish: "2026-01-16", durationDays: 5, critical: true }),
    activity({ id: "a30", code: "A30", name: "Tabliye", parentId: "w1", outlineLevel: 2, wbsPath: "1.3", start: "2026-01-14", finish: "2026-01-20", durationDays: 5 }),
    activity({ id: "m40", code: "M40", name: "Köprü tamamlandı", parentId: "w1", outlineLevel: 2, wbsPath: "1.4", start: "2026-01-23", finish: "2026-01-23", durationDays: 0, milestone: true }),
  ];
  const dependencies: DependencyDto[] = [
    { id: "d1", predId: "a10", succId: "a20", type: "FS", lagDays: 0 },
    { id: "d2", predId: "a20", succId: "a30", type: "SS", lagDays: 2 },
    { id: "d3", predId: "a30", succId: "m40", type: "FS", lagDays: 0 },
  ];
  return {
    projectCode: "PRJ",
    projectName: "Demo Proje",
    schedule: { id: "s", name: "İş Programı R1", version: 1, dataDate: "2026-01-07", startDate: "2026-01-05", finishDate: "2026-01-23" },
    activities,
    dependencies,
    locations: new Map([["A20", location("A20", 12.345, 12.9)]]),
    calendar: { ...DEFAULT_EXPORT_CALENDAR, holidays: ["2026-01-01"] },
    basis: new Map([["A10", basisSummary({ quantity: 40, unit: "m", ratePerDay: 8, crews: null, shiftsPerDay: null, hoursPerShift: null, note: null })]]),
    exportedAt: "2026-02-01T10:00:00.000Z",
  };
}

const identity = (key: string) => key;

describe("schedule exporters", () => {
  it("writes MSPDI that parses back with the importer", () => {
    const m = model();
    const file = writeMspdi(m);
    expect(file.extension).toBe("xml");
    const xml = file.data.toString("utf8");
    expect(xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
    expect(xml).toContain("<MinutesPerDay>480</MinutesPerDay>");
    expect(xml).toContain("<StatusDate>2026-01-07T08:00:00</StatusDate>");
    expect(xml).toContain("Kazık, &quot;Ø80&quot; imalatı &amp; &lt;test&gt;");
    expect(xml).toContain("<FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime>");
    expect(xml).toContain("<FromDate>2026-01-01T00:00:00</FromDate>");
    expect(xml).toContain(`<FieldID>${MSP_FIELD_TEXT1}</FieldID><FieldName>Text1</FieldName>`);
    expect(xml).toContain(`<ExtendedAttribute><FieldID>${MSP_FIELD_NUMBER1}</FieldID><Value>12.345</Value></ExtendedAttribute>`);
    expect(xml).toContain(`<ExtendedAttribute><FieldID>${MSP_FIELD_NUMBER2}</FieldID><Value>12.9</Value></ExtendedAttribute>`);
    // Activity codes in Text1, in task order.
    const codes = [...xml.matchAll(new RegExp(`<FieldID>${MSP_FIELD_TEXT1}</FieldID><Value>([^<]*)</Value>`, "g"))].map((x) => x[1]);
    expect(codes).toEqual(["W1", "A10", "A20", "A30", "M40"]);
    // The only leaf without predecessors (A10) has an actual start, so nothing is pinned.
    expect(xml).not.toContain("<ConstraintType>4</ConstraintType>");

    const parsed = parseMspdi(xml);
    expect(parsed.name).toBe("İş Programı R1");
    expect(parsed.dataDate).toBe("2026-01-07");
    expect(parsed.activities.map((a) => a.name)).toEqual(m.activities.map((a) => a.name));
    const byName = new Map(parsed.activities.map((a) => [a.name, a]));
    for (const src of m.activities) {
      const a = byName.get(src.name)!;
      expect(a.start, src.code).toBe(src.start);
      expect(a.finish, src.code).toBe(src.finish);
      expect(a.summary, src.code).toBe(src.summary);
      expect(a.milestone, src.code).toBe(src.milestone);
      expect(a.wbsPath, src.code).toBe(src.wbsPath);
      expect(a.critical, src.code).toBe(src.critical);
      expect(a.percentComplete, src.code).toBe(src.percentComplete);
      if (!src.summary) expect(a.durationDays, src.code).toBe(src.durationDays);
    }
    const wbs = byName.get(WBS_NAME)!;
    expect(parsed.activities.filter((a) => !a.summary).every((a) => a.parentKey === wbs.key)).toBe(true);
    const a10 = byName.get(TRICKY)!;
    expect(a10.baselineStart).toBe("2026-01-05");
    expect(a10.baselineFinish).toBe("2026-01-08");
    expect(a10.actualStart).toBe("2026-01-05");
    expect(a10.actualFinish).toBeNull();
    expect(byName.get("Kolon betonu")!.baselineStart).toBeNull();

    const nameOf = new Map(parsed.activities.map((a) => [a.key, a.name]));
    const deps = parsed.dependencies.map((d) => [nameOf.get(d.predKey), nameOf.get(d.succKey), d.type, d.lagDays]);
    expect(deps).toEqual([
      [TRICKY, "Kolon betonu", "FS", 0],
      ["Kolon betonu", "Tabliye", "SS", 2],
      ["Tabliye", "Köprü tamamlandı", "FS", 0],
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("pins leaf tasks without predecessors or actuals with Start No Earlier Than", () => {
    const m = model();
    m.activities = m.activities.map((a) => (a.code === "A10" ? { ...a, actualStart: null, percentComplete: 0 } : a));
    const xml = writeMspdi(m).data.toString("utf8");
    expect(xml).toMatch(/<ConstraintType>4<\/ConstraintType>\s*<CalendarUID>1<\/CalendarUID>\s*<ConstraintDate>2026-01-05T08:00:00<\/ConstraintDate>/);
    // every task runs on the programme calendar
    expect((xml.match(/<CalendarUID>1<\/CalendarUID>/g) ?? []).length).toBeGreaterThan(m.activities.length - 1);
    expect(xml.match(/<ConstraintType>4<\/ConstraintType>/g)).toHaveLength(1);
  });

  it("round-trips resources, assignments and code types through MS Project XML and XER", () => {
    const m = model();
    const leaf = m.activities.find((a) => !a.summary && !a.milestone && a.start && a.finish && addDays(a.start, 2) <= a.finish)!;
    // the crane works from the second day of the activity to its end
    const craneStart = addDays(leaf.start!, 1);
    m.resources = [
      { code: "CRW-1", name: "Fill Crew (persons)", kind: "labor", unit: "persons", unitCost: 0, maxPerDay: 20 },
      { code: "EQ-1", name: "CAT 336 (no.)", kind: "equipment", unit: "no.", unitCost: 0, maxPerDay: 4 },
    ];
    m.assignments = [
      { activityCode: leaf.code, resourceCode: "CRW-1", quantityPerDay: 12 },
      { activityCode: leaf.code, resourceCode: "EQ-1", quantityPerDay: 2 / 3, startDate: craneStart, finishDate: leaf.finish },
    ];
    m.activities = m.activities.map((a) => (a.code === leaf.code ? { ...a, levelOfEffort: true } : a));
    m.codeTypes = [{ name: "DISCIPLINE", scope: "project", maxLength: null, values: [{ value: "EWK", description: "Earthworks", parent: null, color: null }] }];
    m.activities = m.activities.map((a) => (a.code === leaf.code ? { ...a, activityCodes: { DISCIPLINE: "EWK" } } : a));

    const xml = writeMspdi(m).data.toString("utf8");
    // resource calendars based on the programme calendar, tasks on the programme calendar
    expect(xml).toMatch(/<Calendar><UID>2<\/UID><Name>Fill Crew \(persons\)<\/Name><IsBaseCalendar>0<\/IsBaseCalendar><IsBaselineCalendar>0<\/IsBaselineCalendar><BaseCalendarUID>1<\/BaseCalendarUID><\/Calendar>/);
    expect(xml).toContain("<Group>Equipment</Group>");
    // project start at midnight (MS Project reads tasks starting at the project start as milestones)
    expect(xml).toMatch(/<StartDate>\d{4}-\d{2}-\d{2}T00:00:00<\/StartDate>/);
    // work = duration × units as written, so MS Project keeps the duration
    const crew = /<Units>12<\/Units><Work>PT(\d+)H(\d+)M(\d+)S<\/Work>/.exec(xml)!;
    const secs = (x: RegExpExecArray) => +x[1]! * 3600 + +x[2]! * 60 + +x[3]!;
    const hpd = m.calendar.hoursPerDay;
    expect(Math.abs(secs(crew) / 12 - workingDaysBetween(leaf.start!, leaf.finish!, m.calendar) * hpd * 3600)).toBeLessThan(1);
    // the crane's own dates: over the whole task in MS Project, with its total quantity
    const leafDays = workingDaysBetween(leaf.start!, leaf.finish!, m.calendar), craneDays = workingDaysBetween(craneStart, leaf.finish!, m.calendar);
    const craneUnits = Math.ceil((((2 / 3) * craneDays) / leafDays) * 1e6) / 1e6;
    const crane = new RegExp(`<Units>${craneUnits}</Units><Work>PT(\\d+)H(\\d+)M(\\d+)S</Work>`).exec(xml)!;
    expect(Math.abs(secs(crane) / 3600 - (2 / 3) * craneDays * hpd)).toBeLessThan(0.01);
    // never longer than the task: work ÷ units ≤ the task's working time
    expect(secs(crane) / craneUnits).toBeLessThanOrEqual(leafDays * hpd * 3600);
    expect(xml).toContain("<FieldName>Text2</FieldName><Alias>DISCIPLINE</Alias><ValueList><Value><ID>1</ID><Value>EWK</Value><Description>Earthworks</Description></Value></ValueList>");
    const xer = writeXer(m).data.toString("utf8");
    expect(xer).toContain("	TT_LOE	");
    expect(parseXer(xer).activities.find((a) => a.code === leaf.code)?.levelOfEffort).toBe(true);
    // XER keeps the crane's own dates; MS Project XML the whole task with the same total
    const dates = (p: ReturnType<typeof parseXer>) => p.resourceAssignments!.map((a) => [a.quantityPerDay, a.startDate, a.finishDate]).sort((x, y) => +x[0]! - +y[0]!);
    expect(dates(parseXer(xer))).toEqual([[0.667, craneStart, leaf.finish], [12, leaf.start, leaf.finish]]);
    expect(dates(parseMspdi(xml))).toEqual([[Math.round(craneUnits * 1000) / 1000, leaf.start, leaf.finish], [12, leaf.start, leaf.finish]]);
    for (const p of [parseMspdi(xml), parseXer(xer)]) {
      expect(p.resources?.map((r) => [r.code, r.kind, r.unit])).toEqual([["CRW-1", "labor", "persons"], ["EQ-1", "equipment", "no."]]);
      const disc = p.activityCodes?.types.find((t) => t.name === "DISCIPLINE");
      expect(disc?.values.map((v) => [v.value, v.description])).toEqual([["EWK", "Earthworks"]]);
    }
  });

  it("writes an Excel workbook that reads back through the table importer", () => {
    const m = model();
    const file = writeScheduleXlsx(m, identity);
    expect(file.extension).toBe("xlsx");
    expect(XLSX.read(file.data, { type: "buffer" }).SheetNames).toEqual(["schedule_export.sheets.program", "schedule_export.sheets.dependen"]);

    const { rows, warnings } = readXlsx(file.data);
    expect(warnings).toEqual([]);
    expect(rows[0]).toEqual(
      [
        "code",
        "name",
        "wbs",
        "start",
        "finish",
        "duration",
        "percentComplete",
        "baselineStart",
        "baselineFinish",
        "actualStart",
        "actualFinish",
        "critical",
        "kmStart",
        "kmEnd",
        "predecessors",
        "basis",
      ].map((k) => `schedule:export.columns.${k}`),
    );
    expect(rows.slice(1).map((r) => r[0])).toEqual(["W1", "A10", "A20", "A30", "M40"]);
    expect(rows[1]!.slice(0, 7)).toEqual(["W1", WBS_NAME, "1", "2026-01-05", "2026-01-23", "15", "10"]);
    expect(rows[2]!.slice(0, 12)).toEqual(["A10", TRICKY, "1.1", "2026-01-05", "2026-01-09", "5", "40", "2026-01-05", "2026-01-08", "2026-01-05", "", "TRUE"]);
    expect(rows[3]!.slice(12, 15)).toEqual(["12.345", "12.9", "A10"]);
    expect(rows[4]![14]).toBe("A20SS+2");
    expect(rows[2]![15]).toBe("40 m ÷ (8 m/d × 1 crew) = 5 d");
    expect(rows[5]!.slice(3, 6)).toEqual(["2026-01-23", "2026-01-23", "0"]);

    const mapping = { code: 0, name: 1, wbs: 2, start: 3, finish: 4, duration: 5, percent: 6, baselineStart: 7, baselineFinish: 8, actualStart: 9, actualFinish: 10, critical: 11, predecessors: 14 };
    const { sourceType, parsed } = parseUpload("program.xlsx", file.data, mapping);
    expect(sourceType).toBe("xlsx");
    const byCode = new Map(parsed.activities.map((a) => [a.code, a]));
    const a10 = byCode.get("A10")!;
    expect([a10.name, a10.start, a10.finish, a10.baselineStart, a10.baselineFinish, a10.actualStart, a10.percentComplete, a10.critical]).toEqual([
      TRICKY,
      "2026-01-05",
      "2026-01-09",
      "2026-01-05",
      "2026-01-08",
      "2026-01-05",
      40,
      true,
    ]);
    expect(byCode.get("M40")!.milestone).toBe(true);
    const codeOf = new Map(parsed.activities.map((a) => [a.key, a.code]));
    expect(parsed.dependencies.map((d) => [codeOf.get(d.predKey), codeOf.get(d.succKey), d.type, d.lagDays])).toEqual([
      ["A10", "A20", "FS", 0],
      ["A20", "A30", "SS", 2],
      ["A30", "M40", "FS", 0],
    ]);

    const deps = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(file.data, { type: "buffer" }).Sheets["schedule_export.sheets.dependen"]!, { header: 1 });
    expect(deps.slice(1)).toEqual([
      ["A10", TRICKY, "A20", "Kolon betonu", "FS", 0],
      ["A20", "Kolon betonu", "A30", "Tabliye", "SS", 2],
      ["A30", "Tabliye", "M40", "Köprü tamamlandı", "FS", 0],
    ]);
  });

  it("uses headers the importer recognises when translated to English", () => {
    const en: Record<string, string> = {
      code: "Activity ID",
      name: "Activity Name",
      wbs: "WBS",
      start: "Start",
      finish: "Finish",
      duration: "Duration",
      percentComplete: "% Complete",
      baselineStart: "Baseline Start",
      baselineFinish: "Baseline Finish",
      actualStart: "Actual Start",
      actualFinish: "Actual Finish",
      critical: "Critical",
      kmStart: "Start km",
      kmEnd: "End km",
      predecessors: "Predecessors",
    };
    const t = (key: string) => en[key.replace("schedule:export.columns.", "")] ?? key.split(".").pop()!;
    const { mapping, parsed } = parseUpload("program.xlsx", writeScheduleXlsx(model(), t).data);
    expect(mapping).toMatchObject({ code: 0, name: 1, wbs: 2, start: 3, finish: 4, duration: 5, percent: 6, baselineStart: 7, baselineFinish: 8, actualStart: 9, actualFinish: 10, critical: 11, predecessors: 14 });
    expect(parsed.dependencies).toHaveLength(3);
  });

  it("writes a TimeLiner / Synchro CSV with BOM, RFC 4180 quoting and leaf rows only", () => {
    const file = writeTimelinerCsv(model());
    expect(file.extension).toBe("csv");
    expect([...file.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = file.data.toString("utf8").slice(1);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Task Name,Display ID,Planned Start,Planned End,Actual Start,Actual End,Task Type,Parent,Start Chainage,End Chainage,Duration Basis");
    expect(lines[1]).toBe('"Kazık, ""Ø80"" imalatı & <test>",A10,2026-01-05,2026-01-09,2026-01-05,,Construct,1,,,40 m ÷ (8 m/d × 1 crew) = 5 d');
    expect(lines[2]).toBe("Kolon betonu,A20,2026-01-12,2026-01-16,,,Construct,1,12.345,12.9,");
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(6);
    expect(text).not.toContain(WBS_NAME);

    const table = parseCsv(text);
    expect(table.rows.map((r) => r[1])).toEqual(["A10", "A20", "A30", "M40"]);
    expect(table.rows[0]![0]).toBe(TRICKY);
    expect(table.rows[3]!.slice(2, 4)).toEqual(["2026-01-23", "2026-01-23"]);
  });

  it("uses summary names as Parent when the WBS has no path", () => {
    const m = model();
    m.activities = m.activities.map((a) => (a.summary ? { ...a, wbsPath: null } : a));
    const lines = writeTimelinerCsv(m).data.toString("utf8").split("\r\n");
    expect(lines[2]).toContain(`,Construct,${WBS_NAME},`);
  });
});
