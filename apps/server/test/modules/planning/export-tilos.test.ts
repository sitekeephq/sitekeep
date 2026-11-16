/**
 * TILOS XML (LPXF data exchange) writer: structure, time + distance per task, links, WBS,
 * calendar, route profile, escaping and Turkish text.
 */
import { describe, expect, it } from "vitest";
import type { ActivityDto, DependencyDto } from "@7dimensions-project/sitekeep-ee-planning/shared/schedule.js";
import type { ActivityLocationDto } from "@7dimensions-project/sitekeep-ee-planning/shared/linear.js";
import { child, children, childText, findFirst, parseXml, type XmlNode } from "../../../src/core/formats/xml.js";
import type { ExportModel } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/model.js";
import { TILOS_CALENDAR_UID, writeTilosXml } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/tilos.js";

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

function location(code: string, kmStart: number, kmEnd: number, category: ActivityLocationDto["category"] = null): ActivityLocationDto {
  return {
    seriesId: "series",
    activityCode: code,
    kmStart,
    kmEnd,
    locationId: null,
    category,
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
    activity("w1", { code: "WBS-KPR", wbsPath: "KPR", name: TR, summary: true, start: "2027-03-01", finish: "2027-03-26" }),
    activity("w2", { code: "WBS-TBL", wbsPath: "KPR.TBL", name: "Tabliye", summary: true, parentId: "w1", outlineLevel: 2 }),
    activity("a1", {
      code: "A1000", name: "Kazık imalatı", parentId: "w1", outlineLevel: 2,
      start: "2027-03-01", finish: "2027-03-05", percentComplete: 100, durationDays: 5,
    }),
    activity("a2", {
      code: "A1010", name: "Toprak işleri & dolgu", parentId: "w1", outlineLevel: 2,
      start: "2027-03-08", finish: "2027-03-19", percentComplete: 40,
    }),
    activity("a3", {
      code: "A1020", name: `${TR} <döküm>`, parentId: "w2", outlineLevel: 3,
      start: "2027-03-15", finish: "2027-03-26", durationDays: 10,
    }),
    activity("m1", { code: "M100", name: "Köprü tamam", parentId: "w1", outlineLevel: 2, milestone: true, start: "2027-03-26", finish: "2027-03-26", durationDays: 0 }),
  ];
  const dependencies: DependencyDto[] = [
    { id: "d1", predId: "a1", succId: "a2", type: "FS", lagDays: 0 },
    { id: "d2", predId: "a2", succId: "a3", type: "SS", lagDays: 3 },
    { id: "d3", predId: "a3", succId: "m1", type: "FF", lagDays: 0 },
    { id: "d4", predId: "w2", succId: "m1", type: "FS", lagDays: 0 }, // from a WBS node: dropped
  ];
  return {
    projectCode: "KPR-01",
    projectName: "Çanakkale Köprüsü",
    schedule: { id: "s1", name: "İş Programı", version: 3, dataDate: "2027-03-10", startDate: "2027-03-01", finishDate: "2027-03-26" },
    activities,
    dependencies,
    locations: new Map([
      ["A1000", location("A1000", 12.3, 12.45, "bridge")],
      ["A1010", location("A1010", 10, 15.5, "earthworks")],
      ["A1020", location("A1020", 12.345, 12.8)],
    ]),
    calendar: { name: "Standart 5 gün", hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: ["2027-03-18"] },
    structures: [{ label: "BR-01 Köprü", type: "bridge", kmStart: 12.3, kmEnd: 12.8 }],
    exportedAt: "2026-11-08T10:30:00.000Z",
  };
}

/** Strict well-formedness check: one root, properly nested tags, no stray "<" or "&". */
function assertWellFormed(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  const body = xml.replace(/<\?[^?]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack: string[] = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let mt = re.exec(body); mt; mt = re.exec(body)) {
    const between = body.slice(last, mt.index);
    expect(between).not.toMatch(/[<>]/);
    expect(between).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i);
    last = re.lastIndex;
    const [, close, name, , selfClose] = mt;
    if (close) {
      expect(stack.pop()).toBe(name);
    } else if (!selfClose) {
      if (stack.length === 0) roots++;
      stack.push(name!);
    } else if (stack.length === 0) roots++;
  }
  expect(body.slice(last).trim()).toBe("");
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}

const text = (n: XmlNode | undefined, name: string) => childText(n, name);

describe("TILOS XML export", () => {
  const file = writeTilosXml(model());
  const xml = file.data.toString("utf8");
  const root = parseXml(xml);
  const lpxf = child(root, "LPXFData")!;
  const project = findFirst(lpxf, "Project")!;
  const tasks = children(findFirst(project, "Tasks"), "Task");
  const byCode = new Map(tasks.map((t) => [text(t, "UID"), t]));

  it("writes a well-formed UTF-8 LPXF document", () => {
    expect(file.extension).toBe("xml");
    expect(file.contentType).toContain("xml");
    assertWellFormed(xml);
    expect(lpxf).toBeDefined();
    expect(text(child(lpxf, "BusinessCase"), "EventName")).toBe("DeliverData");
    expect(project.children.map((c) => c.name)).toEqual(["ProjectInfo", "Calendars", "ScheduleData", "WBSStructure", "AlignmentData"]);
  });

  it("embeds an exchange profile with TILOS properties and metre distances", () => {
    const profile = child(lpxf, "ExchangeProfile")!;
    const app = findFirst(profile, "App1")!;
    expect(text(app, "Name")).toBe("TILOS");
    expect(text(child(app, "Parameters"), "DistanceUnit")).toBe("m");
    expect(text(child(app, "Parameters"), "RescheduleAfterImport")).toBe("0");
    const types = children(child(profile, "TypeList"), "Type");
    expect(types.map((t) => text(t, "Name"))).toEqual(["ProjectInfo", "Calendars", "WBSStructure", "Tasks", "Links", "Profiles", "ProfileItems"]);
    const taskTags = new Map(
      children(child(types.find((t) => text(t, "Name") === "Tasks"), "Tags"), "Tag").map((t) => [text(t, "Name"), text(child(t, "App1"), "Get")]),
    );
    expect(taskTags.get("Name")).toBe("vName");
    expect(taskTags.get("DistanceStart")).toBe("DistanceStart");
    expect(taskTags.get("Duration")).toBe("Duration_2");
  });

  it("writes project info and the calendar", () => {
    const info = child(project, "ProjectInfo")!;
    expect(text(info, "UID")).toBe("KPR-01");
    expect(text(info, "Name")).toBe("Çanakkale Köprüsü – İş Programı");
    expect(text(info, "StartDate")).toBe("2027-03-01T08:00:00");
    expect(text(info, "EndDate")).toBe("2027-03-26T17:00:00");
    expect(text(info, "ReportDate")).toBe("2027-03-10T08:00:00");
    const cal = findFirst(project, "Calendar")!;
    expect(text(cal, "UID")).toBe(TILOS_CALENDAR_UID);
    expect(text(cal, "Name")).toBe("Standart 5 gün");
    expect(xml).toContain("<!-- work days: Mon Tue Wed Thu Fri; hours per day: 8; holidays: 2027-03-18 -->");
  });

  it("writes the WBS from the summary activities", () => {
    const wbs = children(child(project, "WBSStructure"), "WBS");
    expect(wbs.map((w) => [text(w, "UID"), text(w, "ParentUID"), text(w, "WBSCode"), text(w, "Path"), text(w, "Description")])).toEqual([
      ["WBS-KPR", "", "KPR", "KPR", TR],
      ["WBS-TBL", "WBS-KPR", "TBL", "KPR.TBL", "Tabliye"],
    ]);
  });

  it("writes one task per non-summary activity with dates and distances in metres", () => {
    expect([...byCode.keys()]).toEqual(["A1000", "A1010", "A1020", "M100"]);
    const a1 = byCode.get("A1000")!;
    expect(text(a1, "TaskID")).toBe("A1000");
    expect(text(a1, "DateStart")).toBe("2027-03-01T08:00:00");
    expect(text(a1, "DateEnd")).toBe("2027-03-05T17:00:00");
    expect(text(a1, "Duration")).toBe("5");
    expect(text(a1, "PercentComplete")).toBe("100");
    expect(text(a1, "DistanceStart")).toBe("12300");
    expect(text(a1, "DistanceEnd")).toBe("12450");
    expect(text(a1, "WBSStructure")).toBe("KPR");
    expect(text(a1, "CalendarUID")).toBe(TILOS_CALENDAR_UID);
    expect(text(a1, "Text1")).toBe("Bridge / viaduct");

    const a2 = byCode.get("A1010")!;
    expect(text(a2, "DistanceStart")).toBe("10000");
    expect(text(a2, "DistanceEnd")).toBe("15500");
    // 8–19 March: 10 working days, minus the 18 March holiday.
    expect(text(a2, "Duration")).toBe("9");
    expect(text(a2, "PercentComplete")).toBe("40");

    const a3 = byCode.get("A1020")!;
    expect(text(a3, "Name")).toBe(`${TR} <döküm>`);
    expect(text(a3, "DistanceStart")).toBe("12345");
    expect(text(a3, "DistanceEnd")).toBe("12800");
    expect(text(a3, "WBSStructure")).toBe("KPR.TBL");
    expect(text(a3, "DateStart")).toBe("2027-03-15T08:00:00");
    expect(text(a3, "DateEnd")).toBe("2027-03-26T17:00:00");
  });

  it("writes the milestone as a zero-duration task across the route", () => {
    const m = byCode.get("M100")!;
    expect(text(m, "DateStart")).toBe("2027-03-26T17:00:00");
    expect(text(m, "DateEnd")).toBe("2027-03-26T17:00:00");
    expect(text(m, "Duration")).toBe("0");
    expect(text(m, "DistanceStart")).toBe("10000");
    expect(text(m, "DistanceEnd")).toBe("15500");
  });

  it("writes links with type and lag in days, dropping links to WBS nodes", () => {
    const links = children(findFirst(project, "Links"), "Link");
    expect(links.map((l) => `${text(l, "TaskFromUID")}>${text(l, "TaskToUID")}:${text(l, "LinkType")}:${text(l, "Lag")}${text(l, "LagUnit")}`)).toEqual([
      "A1000>A1010:FS:0d",
      "A1010>A1020:SS:3d",
      "A1020>M100:FF:0d",
    ]);
  });

  it("writes the route range and structures as a distance profile", () => {
    const items = children(findFirst(project, "ProfileItems"), "ProfileItem");
    expect(items.map((p) => [text(p, "Station"), text(p, "Name"), text(p, "Value1")])).toEqual([
      ["10000", "Route start", "0"],
      ["12300", "BR-01 Köprü", "1"],
      ["12800", "BR-01 Köprü end", "0"],
      ["15500", "Route end", "0"],
    ]);
  });

  it("escapes markup characters and keeps Turkish letters intact", () => {
    expect(xml).toContain("<Name>Toprak işleri &amp; dolgu</Name>");
    expect(xml).toContain(`<Name>${TR} &lt;döküm&gt;</Name>`);
    expect(xml).not.toContain("işleri & dolgu");
    expect(xml).toContain(TR);
    expect(xml).toContain("ğüşıöç");
    expect(Buffer.from(xml, "utf8").equals(file.data)).toBe(true);
  });
});
