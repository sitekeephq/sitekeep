import { describe, expect, it } from "vitest";
import type { ActivityDto, DependencyDto } from "@7dimensions-project/sitekeep-ee-planning/shared/schedule.js";
import type { ActivityLocationDto } from "@7dimensions-project/sitekeep-ee-planning/shared/linear.js";
import { decodeText } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/import.js";
import { parseXer, readXerTables } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/xer.js";
import { children, childText, findFirst, parseXml } from "../../../src/core/formats/xml.js";
import type { ExportModel } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/model.js";
import { writeXer } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/xer.js";
import { writeP6Xml } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/p6xml.js";

const TR = "Köprü İmalatı ğüşıöç";

function activity(id: string, over: Partial<ActivityDto>): ActivityDto {
  return {
    id,
    scheduleId: "s1",
    code: id,
    externalId: null,
    wbsPath: null,
    name: id,
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
    ...over,
  };
}

function location(code: string, kmStart: number, kmEnd: number): ActivityLocationDto {
  return {
    seriesId: "series",
    activityCode: code,
    kmStart,
    kmEnd,
    locationId: null,
    category: null,
    source: "manual",
    rule: null,
    detail: null,
    confidence: null,
    model: null,
    updatedBy: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as ActivityLocationDto;
}

function model(): ExportModel {
  const activities: ActivityDto[] = [
    activity("w1", { code: "WBS-KPR", wbsPath: "KPR", name: TR, summary: true, start: "2026-03-02", finish: "2026-03-20" }),
    activity("w2", { code: "WBS-KPR.TBL", wbsPath: "KPR.TBL", name: "Tabliye", summary: true, parentId: "w1", outlineLevel: 2 }),
    activity("a1", {
      code: "A1000", name: "Kazık\timalatı", wbsPath: "KPR", parentId: "w1", outlineLevel: 2,
      start: "2026-03-02", finish: "2026-03-06", actualStart: "2026-03-02", actualFinish: "2026-03-06", percentComplete: 100, durationDays: 5,
    }),
    activity("a2", {
      code: "A1010", name: "Başlık betonu", wbsPath: "KPR", parentId: "w1", outlineLevel: 2,
      start: "2026-03-09", finish: "2026-03-13", actualStart: "2026-03-09", percentComplete: 40, durationDays: 5, critical: true,
    }),
    activity("a3", {
      code: "A1020", name: "Tabliye <döküm> & bakım", wbsPath: "KPR.TBL", parentId: "w2", outlineLevel: 3,
      start: "2026-03-12", finish: "2026-03-20", critical: true, // no duration: 6 working days from the dates (18 Mar is a holiday)
    }),
    activity("m1", { code: "M100", name: "Köprü tamam", wbsPath: "KPR", parentId: "w1", outlineLevel: 2, milestone: true, start: "2026-03-20", finish: "2026-03-20", durationDays: 0 }),
  ];
  const dependencies: DependencyDto[] = [
    { id: "d1", predId: "a1", succId: "a2", type: "FS", lagDays: 0 },
    { id: "d2", predId: "a2", succId: "a3", type: "SS", lagDays: 2.5 },
    { id: "d3", predId: "a3", succId: "m1", type: "FF", lagDays: 0 },
    { id: "d4", predId: "w2", succId: "m1", type: "FS", lagDays: 0 }, // to a WBS node: dropped
  ];
  return {
    projectCode: "KPR-01",
    projectName: "Çanakkale Köprüsü",
    schedule: { id: "s1", name: "İş Programı", version: 3, dataDate: "2026-03-11", startDate: "2026-03-02", finishDate: "2026-03-20" },
    activities,
    dependencies,
    locations: new Map([["A1020", location("A1020", 12.345, 12.8)]]),
    calendar: { name: "Standart 5 gün", hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: ["2026-03-18"] },
    exportedAt: "2026-11-08T10:30:00.000Z",
  };
}

describe("P6 XER export", () => {
  const file = writeXer(model());
  const text = file.data.toString("utf8");

  it("writes a CRLF, UTF-8 XER with header, tables and end marker", () => {
    expect(file.extension).toBe("xer");
    expect(text.startsWith("ERMHDR\t")).toBe(true);
    expect(text.trimEnd().endsWith("%E")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const tables = readXerTables(text);
    expect([...tables.keys()]).toEqual(["CURRTYPE", "PROJECT", "CALENDAR", "PROJWBS", "TASK", "TASKPRED", "UDFTYPE", "UDFVALUE"]);
    // Every row has as many values as the table has fields.
    let fields = 0;
    for (const line of text.split("\r\n")) {
      if (line.startsWith("%F")) fields = line.split("\t").length;
      if (line.startsWith("%R")) expect(line.split("\t").length).toBe(fields);
    }
    expect(decodeText(file.data)).toBe(text);
    expect(text).toContain(TR);
  });

  it("round-trips through parseXer", () => {
    const p = parseXer(decodeText(file.data));
    expect(p.name).toBe("KPR-01");
    expect(p.dataDate).toBe("2026-03-11");
    const by = new Map(p.activities.map((a) => [a.code, a]));
    expect([...by.keys()].sort()).toEqual(["A1000", "A1010", "A1020", "M100", "WBS-KPR", "WBS-KPR.TBL"]);
    expect(by.get("WBS-KPR")).toMatchObject({ name: TR, summary: true, wbsPath: "KPR" });
    expect(by.get("WBS-KPR.TBL")).toMatchObject({ name: "Tabliye", summary: true, wbsPath: "KPR.TBL" });
    expect(by.get("A1000")).toMatchObject({
      name: "Kazık imalatı", wbsPath: "KPR", start: "2026-03-02", finish: "2026-03-06",
      actualStart: "2026-03-02", actualFinish: "2026-03-06", percentComplete: 100, durationDays: 5, critical: false,
    });
    expect(by.get("A1010")).toMatchObject({ name: "Başlık betonu", start: "2026-03-09", finish: "2026-03-13", actualStart: "2026-03-09", actualFinish: null, percentComplete: 40, critical: true });
    expect(by.get("A1020")).toMatchObject({ name: "Tabliye <döküm> & bakım", wbsPath: "KPR.TBL", start: "2026-03-12", finish: "2026-03-20", durationDays: 6, critical: true });
    expect(by.get("M100")).toMatchObject({ milestone: true, start: "2026-03-20", finish: "2026-03-20", durationDays: 0 });
    const keyCode = new Map(p.activities.map((a) => [a.key, a.code]));
    expect(p.dependencies.map((d) => `${keyCode.get(d.predKey)}>${keyCode.get(d.succKey)}:${d.type}:${d.lagDays}`)).toEqual([
      "A1000>A1010:FS:0",
      "A1010>A1020:SS:2.5",
      "A1020>M100:FF:0",
    ]);
  });

  it("writes P6 fields: status, types, hours, calendar and km UDFs", () => {
    const t = readXerTables(text);
    const tasks = new Map(t.get("TASK")!.map((r) => [r.task_code!, r]));
    expect(tasks.get("A1000")).toMatchObject({ status_code: "TK_Complete", task_type: "TT_Task", target_drtn_hr_cnt: "40", remain_drtn_hr_cnt: "0", act_end_date: "2026-03-06 17:00" });
    expect(tasks.get("A1010")).toMatchObject({ status_code: "TK_Active", remain_drtn_hr_cnt: "24", driving_path_flag: "Y", target_start_date: "2026-03-09 08:00", act_end_date: "" });
    expect(tasks.get("A1020")).toMatchObject({ status_code: "TK_NotStart", target_drtn_hr_cnt: "48", total_float_hr_cnt: "" }); // 18 Mar is a holiday
    expect(tasks.get("M100")).toMatchObject({ task_type: "TT_FinMile", target_start_date: "2026-03-20 17:00", target_end_date: "2026-03-20 17:00" });
    const wbs = t.get("PROJWBS")!;
    expect(wbs[0]).toMatchObject({ proj_node_flag: "Y", wbs_short_name: "KPR-01", wbs_name: "Çanakkale Köprüsü", parent_wbs_id: "" });
    const kpr = wbs.find((w) => w.wbs_short_name === "KPR")!;
    expect(wbs.find((w) => w.wbs_short_name === "TBL")!.parent_wbs_id).toBe(kpr.wbs_id);
    expect(tasks.get("A1020")!.wbs_id).toBe(wbs.find((w) => w.wbs_short_name === "TBL")!.wbs_id);
    expect(t.get("TASKPRED")!.map((r) => `${r.pred_type}:${r.lag_hr_cnt}`)).toEqual(["PR_FS:0", "PR_SS:20", "PR_FF:0"]);
    const cal = t.get("CALENDAR")![0]!;
    expect(cal).toMatchObject({ clndr_name: "Standart 5 gün", day_hr_cnt: "8", week_hr_cnt: "40" });
    expect(cal.clndr_data).toContain("(0||2()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))");
    expect(cal.clndr_data).toContain("(0||1()())"); // Sunday off
    expect(cal.clndr_data).toContain("(d|46099)"); // 2026-03-18
    expect(t.get("UDFTYPE")!.map((u) => `${u.udf_type_label}:${u.logical_data_type}:${u.table_name}`)).toEqual([
      "Start Chainage (km):FT_FLOAT_2_DECIMALS:TASK",
      "End Chainage (km):FT_FLOAT_2_DECIMALS:TASK",
    ]);
    const udf = t.get("UDFVALUE")!;
    expect(udf.map((u) => [u.udf_type_id, u.fk_id, u.udf_number])).toEqual([
      ["1", tasks.get("A1020")!.task_id, "12.345"],
      ["2", tasks.get("A1020")!.task_id, "12.8"],
    ]);
  });
});

describe("P6 XML export", () => {
  const file = writeP6Xml(model());
  const text = file.data.toString("utf8");
  const root = parseXml(text);
  const doc = findFirst(root, "APIBusinessObjects")!;
  const project = children(doc, "Project")[0]!;

  it("writes the PMXML root, calendar and project", () => {
    expect(file.extension).toBe("xml");
    expect(text).toContain(`<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V8.3/API/BusinessObjects"`);
    const cal = children(doc, "Calendar")[0]!;
    expect(childText(cal, "Name")).toBe("Standart 5 gün");
    expect(childText(cal, "HoursPerDay")).toBe("8");
    const days = children(findFirst(cal, "StandardWorkWeek")!, "StandardWorkHours");
    expect(days.map((d) => `${childText(d, "DayOfWeek")}:${children(d, "WorkTime").length}`)).toEqual([
      "Sunday:0", "Monday:2", "Tuesday:2", "Wednesday:2", "Thursday:2", "Friday:2", "Saturday:0",
    ]);
    expect(childText(findFirst(cal, "HolidayOrException")!, "Date")).toBe("2026-03-18T00:00:00");
    expect(childText(project, "Id")).toBe("KPR-01");
    expect(childText(project, "Name")).toBe("Çanakkale Köprüsü");
    expect(childText(project, "DataDate")).toBe("2026-03-11T08:00:00");
    expect(childText(project, "PlannedStartDate")).toBe("2026-03-02T08:00:00");
  });

  it("writes WBS, activities, relationships and km UDFs", () => {
    const wbs = children(project, "WBS");
    expect(wbs.map((w) => `${childText(w, "Code")}:${childText(w, "Name")}`)).toEqual([`KPR:${TR}`, "TBL:Tabliye"]);
    expect(childText(wbs[1], "ParentObjectId")).toBe(childText(wbs[0], "ObjectId"));
    expect(childText(wbs[0], "ParentObjectId")).toBe("");

    const acts = new Map(children(project, "Activity").map((a) => [childText(a, "Id"), a]));
    expect([...acts.keys()]).toEqual(["A1000", "A1010", "A1020", "M100"]);
    const a1 = acts.get("A1000")!;
    expect(childText(a1, "Name")).toBe("Kazık imalatı");
    expect(childText(a1, "Status")).toBe("Completed");
    expect(childText(a1, "ActualFinishDate")).toBe("2026-03-06T17:00:00");
    expect(childText(a1, "PlannedDuration")).toBe("40");
    expect(childText(a1, "WBSObjectId")).toBe(childText(wbs[0], "ObjectId"));
    const a3 = acts.get("A1020")!;
    expect(childText(a3, "Name")).toBe("Tabliye <döküm> & bakım");
    expect(text).toContain("Tabliye &lt;döküm&gt; &amp; bakım");
    expect(childText(a3, "Type")).toBe("Task Dependent");
    expect(childText(a3, "PlannedStartDate")).toBe("2026-03-12T08:00:00");
    expect(childText(a3, "PlannedFinishDate")).toBe("2026-03-20T17:00:00");
    expect(childText(a3, "CalendarObjectId")).toBe(childText(children(doc, "Calendar")[0], "ObjectId"));
    expect(childText(a3, "WBSObjectId")).toBe(childText(wbs[1], "ObjectId"));
    expect(childText(acts.get("A1010"), "PhysicalPercentComplete")).toBe("40");
    expect(childText(acts.get("A1010"), "Status")).toBe("In Progress");
    expect(childText(acts.get("M100"), "Type")).toBe("Finish Milestone");

    const udfTypes = new Map(children(doc, "UDFType").map((u) => [childText(u, "ObjectId"), childText(u, "Title")]));
    const udfs = children(a3, "UDF").map((u) => `${udfTypes.get(childText(u, "TypeObjectId"))}=${childText(u, "Value")}`);
    expect(udfs).toEqual(["Start Chainage (km)=12.345", "End Chainage (km)=12.8"]);
    expect(children(a1, "UDF")).toHaveLength(0);

    const idOf = new Map([...acts].map(([code, a]) => [childText(a, "ObjectId"), code]));
    expect(
      children(project, "Relationship").map(
        (r) => `${idOf.get(childText(r, "PredecessorActivityObjectId"))}>${idOf.get(childText(r, "SuccessorActivityObjectId"))}:${childText(r, "Type")}:${childText(r, "Lag")}`,
      ),
    ).toEqual(["A1000>A1010:Finish to Start:0", "A1010>A1020:Start to Start:20", "A1020>M100:Finish to Finish:0"]);
  });
});
