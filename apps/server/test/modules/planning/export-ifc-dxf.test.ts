/** IFC4X3 work schedule and time–distance DXF exporters. */
import { describe, expect, it } from "vitest";
import type { ActivityDto, DependencyDto } from "@sitekeephq/sitekeep-ee-planning/shared/schedule.js";
import type { ActivityLocationDto, LinearCategory } from "@sitekeephq/sitekeep-ee-planning/shared/linear.js";
import type { ExportModel } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/model.js";
import { compressGuid, isoDays, stepReal, stepString, writeIfcSchedule } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/ifc.js";
import { dxfText, nearestAci, writeTimeDistanceDxf } from "@sitekeephq/sitekeep-ee-planning/internal/schedule/export/dxf.js";

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

function location(code: string, kmStart: number, kmEnd: number, category: LinearCategory | null, display: ActivityLocationDto["display"] = null): ActivityLocationDto {
  return {
    seriesId: "series",
    activityCode: code,
    kmStart,
    kmEnd,
    locationId: null,
    category,
    display,
    source: "manual",
    rule: null,
    detail: null,
    confidence: null,
    model: null,
    updatedBy: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function model(): ExportModel {
  const activities: ActivityDto[] = [
    activity("w1", { code: "WBS-HAT", wbsPath: "HAT", name: "Hat İşleri", summary: true, start: "2026-03-02", finish: "2026-06-30" }),
    activity("a1", {
      code: "A1000", name: TR, wbsPath: "HAT", parentId: "w1", outlineLevel: 2, durationDays: 20,
      start: "2026-03-02", finish: "2026-03-27", actualStart: "2026-03-02", percentComplete: 40, critical: true,
    }),
    activity("a2", { code: "A1010", name: "Ray döşeme", wbsPath: "HAT", parentId: "w1", outlineLevel: 2, durationDays: 50, start: "2026-03-30", finish: "2026-06-05" }),
    activity("a3", { code: "A1020", name: "Contractor's drainage", wbsPath: "HAT", parentId: "w1", outlineLevel: 2, durationDays: 10, start: "2026-04-01", finish: "2026-04-14" }),
    activity("m1", { code: "M100", name: "Hat tamam", wbsPath: "HAT", parentId: "w1", outlineLevel: 2, milestone: true, start: "2026-06-30", finish: "2026-06-30", durationDays: 0 }),
  ];
  const dependencies: DependencyDto[] = [
    { id: "d1", predId: "a1", succId: "a2", type: "FS", lagDays: 0 },
    { id: "d2", predId: "a2", succId: "a3", type: "SS", lagDays: 2 },
  ];
  return {
    projectCode: "HAT-01",
    projectName: "Hızlı Tren Hattı",
    schedule: { id: "s1", name: "İş Programı", version: 2, dataDate: "2026-04-15", startDate: "2026-03-02", finishDate: "2026-06-30" },
    activities,
    dependencies,
    locations: new Map([
      ["A1000", location("A1000", 26.47, 26.9, "bridge")],
      ["A1010", location("A1010", 26.47, 40, "track")],
      ["A1020", location("A1020", 30, 30.8, "drainage")],
    ]),
    calendar: { name: "Standart", hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: [] },
    structures: [{ label: "Köprü-1", type: "Köprü", kmStart: 26.47, kmEnd: 26.9 }],
    exportedAt: "2026-11-08T10:30:00.000Z",
  };
}

describe("IFC helpers", () => {
  it("compresses GUIDs with the standard IFC base64 algorithm", () => {
    expect(compressGuid("00000000-0000-0000-0000-000000000000")).toBe("0000000000000000000000");
    expect(compressGuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe("3$$$$$$$$$$$$$$$$$$$$$");
  });
  it("escapes STEP strings and formats reals and durations", () => {
    expect(stepString("O'Brien \\ x")).toBe("'O''Brien \\\\ x'");
    expect(stepString("Köprü")).toBe("'K\\X2\\00F6\\X0\\pr\\X2\\00FC\\X0\\'");
    expect(stepString("ğı")).toBe("'\\X2\\011F0131\\X0\\'");
    expect(stepString(null)).toBe("$");
    expect(stepReal(26470)).toBe("26470.");
    expect(stepReal(0.4)).toBe("0.4");
    expect(isoDays(2)).toBe("P2D");
    expect(isoDays(-1.5)).toBe("-P1.5D");
  });
});

describe("IFC4X3 work schedule export", () => {
  const m = model();
  const file = writeIfcSchedule(m);
  const text = file.data.toString("ascii");
  const rows = text.split("\n").filter((l) => /^#\d+=/.test(l));
  const ofType = (t: string) => rows.filter((r) => r.includes(`=${t}(`));

  it("writes an ISO 10303-21 file with the IFC4X3_ADD2 schema", () => {
    expect(file.extension).toBe("ifc");
    expect(file.contentType).toBe("application/x-step");
    expect(text.startsWith("ISO-10303-21;\nHEADER;\n")).toBe(true);
    expect(text).toContain("FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');");
    expect(text).toContain("FILE_SCHEMA(('IFC4X3_ADD2'));");
    expect(text).toContain("'2026-11-08T10:30:00'");
    expect(text.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });

  it("has project, work plan and work schedule with their relations", () => {
    expect(ofType("IFCPROJECT")).toHaveLength(1);
    expect(ofType("IFCWORKPLAN")).toHaveLength(1);
    const ws = ofType("IFCWORKSCHEDULE");
    expect(ws).toHaveLength(1);
    expect(ws[0]).toContain("'\\X2\\0130015F\\X0\\ Program\\X2\\0131\\X0\\'");
    expect(ws[0]).toContain("'2026-03-02T08:00:00','2026-06-30T17:00:00',.PLANNED.)");
    expect(ofType("IFCRELDECLARES")).toHaveLength(1);
    expect(ofType("IFCRELAGGREGATES")).toHaveLength(1);
  });

  it("writes one IfcTask per activity with Identification and task time", () => {
    const tasks = ofType("IFCTASK");
    expect(tasks).toHaveLength(m.activities.length);
    for (const a of m.activities) expect(tasks.some((t) => t.includes(`'${a.code}'`))).toBe(true);
    const bridge = tasks.find((t) => t.includes("'A1000'"))!;
    expect(bridge).toContain("'STARTED'");
    expect(bridge).toContain(".CONSTRUCTION.)");
    const mile = tasks.find((t) => t.includes("'M100'"))!;
    expect(mile).toContain(",.T.,$,#");
    const times = ofType("IFCTASKTIME");
    expect(times).toHaveLength(m.activities.length);
    expect(times.some((t) => t.includes("'P20D','2026-03-02T08:00:00','2026-03-27T17:00:00'") && t.endsWith(",0.4);"))).toBe(true);
  });

  it("nests WBS children, controls top-level tasks and writes sequences", () => {
    const nests = ofType("IFCRELNESTS");
    expect(nests).toHaveLength(1);
    expect(nests[0]!.split("=")[1]!.match(/#\d+/g)).toHaveLength(1 + 4); // summary + its 4 children
    expect(ofType("IFCRELASSIGNSTOCONTROL")).toHaveLength(1);
    const seq = ofType("IFCRELSEQUENCE");
    expect(seq).toHaveLength(m.dependencies.length);
    expect(seq.filter((s) => s.includes(".FINISH_START."))).toHaveLength(1);
    expect(seq.filter((s) => s.includes(".START_START."))).toHaveLength(1);
    expect(ofType("IFCLAGTIME").some((l) => l.includes("IFCDURATION('P2D'),.WORKTIME.)"))).toBe(true);
  });

  it("attaches the chainage property set in metres", () => {
    const psets = ofType("IFCPROPERTYSET");
    expect(psets).toHaveLength(3);
    expect(psets.every((p) => p.includes("'7D_Chainage'"))).toBe(true);
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('StartChainage',$,IFCLENGTHMEASURE(26470.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('EndChainage',$,IFCLENGTHMEASURE(40000.),$)");
    expect(text).toContain("IFCLABEL('26+470 \\X2\\2013\\X0\\ 40+000')");
    expect(ofType("IFCRELDEFINESBYPROPERTIES")).toHaveLength(3);
  });

  it("encodes Turkish letters and apostrophes", () => {
    expect(text).toContain("'K\\X2\\00F6\\X0\\pr\\X2\\00FC\\X0\\ \\X2\\0130\\X0\\malat\\X2\\0131\\X0\\ \\X2\\011F00FC015F013100F600E7\\X0\\'");
    expect(text).toContain("'Contractor''s drainage'");
  });

  it("references only defined instances and uses valid unique GlobalIds", () => {
    const defined = new Set(rows.map((r) => Number(/^#(\d+)=/.exec(r)![1])));
    for (const r of rows) {
      const body = r.slice(r.indexOf("=") + 1);
      for (const x of body.matchAll(/#(\d+)/g)) expect(defined.has(Number(x[1]))).toBe(true);
    }
    const rooted = /^#\d+=(IFCPROJECT|IFCWORKPLAN|IFCWORKSCHEDULE|IFCTASK|IFCREL\w+|IFCPROPERTYSET)\('([^']*)'/;
    const ids = rows.map((r) => rooted.exec(r)?.[2]).filter((x): x is string => x !== undefined);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(new Set(ids).size).toBe(ids.length);
    // deterministic
    expect(writeIfcSchedule(model()).data.equals(file.data)).toBe(true);
  });
});

describe("time–distance DXF export", () => {
  const file = writeTimeDistanceDxf(model(), { title: "Zaman–Mesafe Diyagramı" });
  const text = file.data.toString("latin1");
  const lines = text.split("\n");
  /** Entities as group-code maps (multi-valued codes keep the last value). */
  const entities = (() => {
    const start = lines.indexOf("ENTITIES");
    const out: { type: string; g: Map<number, string> }[] = [];
    for (let i = start + 1; i + 1 < lines.length; i += 2) {
      const code = Number(lines[i]), value = lines[i + 1]!;
      if (code === 0) {
        if (value === "ENDSEC") break;
        out.push({ type: value, g: new Map() });
      } else out.at(-1)?.g.set(code, value);
    }
    return out;
  })();
  const layerTable = (() => {
    const s = text.indexOf("2\nLAYER");
    return text.slice(s, text.indexOf("ENDTAB", s));
  })();

  it("writes an R12 ASCII DXF ending with EOF", () => {
    expect(file.extension).toBe("dxf");
    expect(file.contentType).toBe("application/dxf");
    expect(text.startsWith("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n")).toBe(true);
    expect(text.trimEnd().endsWith("0\nEOF")).toBe(true);
    expect(lines.length % 2).toBe(1); // code/value pairs + trailing newline
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });

  it("has the layer table with all diagram layers and the DASHED linetype", () => {
    for (const l of ["TD-GRID", "TD-AXIS", "TD-STRUCTURES", "TD-ACTIVITIES-TRACK", "TD-ACTIVITIES-BRIDGE", "TD-ACTIVITIES-CUT_AND_COVER", "TD-MILESTONES", "TD-DATADATE", "TD-TEXT"]) {
      expect(layerTable).toContain(`\n2\n${l}\n`);
    }
    expect(text).toContain("0\nLTYPE\n2\nDASHED\n");
    expect(layerTable).toContain("2\nTD-DATADATE\n70\n0\n62\n1\n6\nDASHED\n");
    expect(nearestAci("#ff0000")).toBe(1);
    expect(nearestAci("#1f6feb")).not.toBe(nearestAci("#12b76a"));
  });

  it("draws the linear track task as a LINE and the bridge task as a closed POLYLINE", () => {
    const track = entities.filter((e) => e.type === "LINE" && e.g.get(8) === "TD-ACTIVITIES-TRACK");
    expect(track).toHaveLength(1);
    // 26+470 → 40+000 in metres; 30.03.2026 → end of 05.06.2026, 10 units/day from 01.03.2026
    expect([track[0]!.g.get(10), track[0]!.g.get(20), track[0]!.g.get(11), track[0]!.g.get(21)]).toEqual(["26470", "-290", "40000", "-970"]);
    const bridge = entities.filter((e) => e.type === "POLYLINE" && e.g.get(8) === "TD-ACTIVITIES-BRIDGE");
    expect(bridge).toHaveLength(1);
    expect(bridge[0]!.g.get(70)).toBe("1");
    expect(entities.some((e) => e.type === "POLYLINE" && e.g.get(8) === "TD-ACTIVITIES-DRAINAGE")).toBe(true); // 0.8 km: box
    expect(entities.some((e) => e.type === "POLYLINE" && e.g.get(8) === "TD-MILESTONES")).toBe(true);
    expect(entities.some((e) => e.type === "POLYLINE" && e.g.get(8) === "TD-STRUCTURES")).toBe(true);
    const dd = entities.find((e) => e.type === "LINE" && e.g.get(8) === "TD-DATADATE")!;
    expect(dd.g.get(6)).toBe("DASHED");
  });

  it("draws tunnel drives as lines, reversed when the planner chose line_reverse, and blocks on request", () => {
    const m = model();
    m.locations.set("A1000", location("A1000", 26.47, 28, "tunnel", "line_reverse"));
    m.locations.set("A1010", location("A1010", 26.47, 40, "track", "block"));
    m.locations.set("A1020", location("A1020", 30, 31.5, "tunnel"));
    const ents = writeTimeDistanceDxf(m, { title: "TD" }).data.toString("latin1").split("\n");
    const lineOf = (layer: string) => {
      const out: string[][] = [];
      for (let i = 0; i + 1 < ents.length; i += 2) {
        if (Number(ents[i]) === 0 && ents[i + 1] === "LINE") {
          const g = new Map<string, string>();
          for (let j = i + 2; j + 1 < ents.length && Number(ents[j]) !== 0; j += 2) g.set(String(Number(ents[j])), ents[j + 1]!);
          if (g.get("8") === layer) out.push([g.get("10")!, g.get("11")!]);
        }
      }
      return out;
    };
    // A1000: from km 28 at its start to km 26.47 at its finish; A1020 (automatic tunnel, 1.5 km): forwards.
    expect(lineOf("TD-ACTIVITIES-TUNNEL")).toEqual(expect.arrayContaining([["28000", "26470"], ["30000", "31500"]]));
    expect(lineOf("TD-ACTIVITIES-TRACK")).toEqual([]);
  });

  it("writes labels with \\U+ escapes for Turkish letters", () => {
    const texts = entities.filter((e) => e.type === "TEXT").map((e) => e.g.get(1)!);
    expect(texts).toContain("26+000");
    expect(texts).toContain("40+000");
    expect(texts).toContain("03.2026");
    expect(texts).toContain("K\\U+00F6pr\\U+00FC-1");
    expect(texts).toContain("Zaman\\U+2013Mesafe Diyagram\\U+0131");
    expect(texts.some((t) => t.includes("H\\U+0131zl\\U+0131 Tren Hatt\\U+0131"))).toBe(true);
    expect(texts).toContain("M100 Hat tamam");
    expect(texts).toContain("A1000");
    expect(dxfText("ğüşıöç İ 5%")).toBe("\\U+011F\\U+00FC\\U+015F\\U+0131\\U+00F6\\U+00E7 \\U+0130 5%%%");
  });
});
