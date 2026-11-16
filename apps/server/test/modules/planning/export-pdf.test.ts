import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from "pdf-lib";
import { DEFAULT_SERIES_SETTINGS, MILESTONE_TYPES, type ActivityLocationDto } from "@7dimensions-project/sitekeep-ee-planning/shared/linear.js";
import { OPERATIONS } from "@7dimensions-project/sitekeep-ee-planning/shared/operations.js";
import { computeCpm } from "@7dimensions-project/sitekeep-ee-planning/shared/cpm.js";
import { type ActivityDto } from "@7dimensions-project/sitekeep-ee-planning/shared/schedule.js";
import { programmeAssumptions, weekdayRanges } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/assumptions.js";
import { STRUCTURE_KINDS, structureKind, writeSchedulePdf, type PdfOptions } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/pdf.js";
import type { ExportModel } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/export/model.js";

/** Hover fields of the first page: widget annotations with their field name, /TU text and /F flags. */
function hoverFields(doc: PDFDocument) {
  const annots = doc.getPage(0).node.Annots();
  const out: { name: string; tu: string; flags: number; dest: PDFArray | null }[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const a = annots!.lookup(i, PDFDict);
    if (a.get(PDFName.of("Subtype"))?.toString() !== "/Widget") continue;
    const text = (k: string) => a.lookup(PDFName.of(k), PDFHexString)?.decodeText() ?? "";
    const action = a.lookupMaybe(PDFName.of("A"), PDFDict);
    out.push({ name: text("T"), tu: text("TU"), flags: a.lookup(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0, dest: action?.lookupMaybe(PDFName.of("D"), PDFArray) ?? null });
  }
  return out;
}

const act = (code: string, start: string, finish: string, extra: Partial<ActivityDto> = {}): ActivityDto =>
  ({ id: code, code, name: `Activity ${code} with a fairly long descriptive name`, wbsPath: null, parentId: null, summary: false, milestone: false, start, finish, durationDays: null, percentComplete: 0, critical: false, baselineStart: null, baselineFinish: null, actualStart: null, actualFinish: null, resource: null, sortIndex: 0, ...extra }) as unknown as ActivityDto;
const loc = (code: string, kmStart: number, kmEnd: number): ActivityLocationDto =>
  ({ seriesId: "s", activityCode: code, kmStart, kmEnd, locationId: null, category: null, source: "manual", rule: null, detail: null, confidence: null, model: null, updatedBy: null, updatedAt: "" }) as unknown as ActivityLocationDto;

function model(n: number): ExportModel {
  const activities: ActivityDto[] = [];
  const locations = new Map<string, ActivityLocationDto>();
  // Many short works crowded into the same 2 km and 3 months: labels must give way, not overlap.
  for (let i = 0; i < n; i++) {
    const code = `A${i}`;
    activities.push(act(code, `2027-0${1 + (i % 3)}-0${1 + (i % 9)}`, `2027-0${2 + (i % 3)}-1${i % 9}`));
    locations.set(code, loc(code, 10 + (i % 20) / 10, 10.2 + (i % 20) / 10));
  }
  activities.push(act("M1", "2027-06-01", "2027-06-01", { milestone: true }));
  activities.push(act("M2", "2027-06-03", "2027-06-03", { milestone: true }));
  activities.push(act("X1", "2027-01-01", "2027-02-01")); // no chainage
  return {
    projectCode: "P", projectName: "Proje", schedule: { id: "s", name: "Program", version: 2, dataDate: "2027-02-01", startDate: null, finishDate: null },
    activities, dependencies: [], locations, calendar: { name: "c", hoursPerDay: 8, workDays: [1, 2, 3, 4, 5], holidays: [] },
    structures: [{ label: "BR-01", type: "Köprü", kmStart: 10.4, kmEnd: 10.6 }, { label: "TN-02", type: "Tünel", kmStart: 11, kmEnd: 11.8 }],
    exportedAt: "2027-03-01T00:00:00.000Z",
  };
}

const t = (k: string, p: Record<string, string | number> = {}) => `${k.split(".").pop()}(${Object.values(p).join("|")})`;

function options(m: ExportModel, extra: Partial<PdfOptions> = {}): PdfOptions {
  return {
    view: "td", page: "A3", template: null, logos: {}, revision: "R1",
    labels: {
      view: "TD", printed: "Printed", legend: "Work types",
      columns: { code: "Code", name: "Activity", start: "Start", finish: "Finish", float: "Float", kmStart: "Start km", kmEnd: "End km", category: "Type" },
      categories: { none: "Other" },
      symbols: { title: "Symbols", critical: "Critical", nearCritical: "Near", dataDate: "Data date", linear: "Linear", block: "Block", milestone: "Milestones", structures: "Structures" },
      milestoneTypes: Object.fromEntries(MILESTONE_TYPES.map((k) => [k, k])) as PdfOptions["labels"]["milestoneTypes"],
      structureTypes: Object.fromEntries(STRUCTURE_KINDS.map((k) => [k, k])) as PdfOptions["labels"]["structureTypes"],
      assumptions: "Assumptions", key: "Key", continued: "Continued", notLabelled: "No label",
      operationsTitle: "Operations", operations: Object.fromEntries(OPERATIONS.map((k) => [k, k])) as PdfOptions["labels"]["operations"], legendNote: "note",
    },
    formatDate: (iso) => iso,
    cpm: computeCpm(m.activities, m.dependencies, { dataDate: m.schedule.dataDate, calendar: DEFAULT_SERIES_SETTINGS.calendar, nearCriticalDays: 10 }),
    milestoneTypes: { M1: "contractual", M2: "holdEs" },
    assumptions: programmeAssumptions(m, { ...DEFAULT_SERIES_SETTINGS, assumptions: [] }, t, (d) => d),
    ...extra,
  };
}

describe("time–distance PDF", () => {
  it("states the generated assumptions", () => {
    const m = model(3);
    const a = programmeAssumptions(m, { ...DEFAULT_SERIES_SETTINGS, calendar: { workDays: [1, 2, 3, 4, 5, 6], holidays: ["2027-01-01"], hoursPerDay: 10 }, nearCriticalDays: 7, assumptions: ["own"] }, t, (d) => d);
    expect(a[0]).toBe("calendar(d1()–d6()|10|1)");
    expect(a).toContain("critical(7)");
    expect(a).toContain("dataDate(2027-02-01)");
    expect(a.some((x) => x.startsWith("chainage("))).toBe(true);
    expect(a).toContain("notDrawn(3)"); // M1, M2 and X1 have no chainage
    expect(a).not.toContain("own"); // planner assumptions are appended by the caller
  });

  it("collapses weekdays into ranges", () => {
    const n = (d: number) => ["", "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"][d]!;
    expect(weekdayRanges([1, 2, 3, 4, 5, 6, 7], n)).toBe("Mo–Su");
    expect(weekdayRanges([1, 2, 4, 5, 6], n)).toBe("Mo, Tu, Th–Sa");
    expect(weekdayRanges([7, 1], n)).toBe("Mo, Su");
  });

  it("classifies structures for the band and legend", () => {
    expect(structureKind("Köprü")).toBe("bridge");
    expect(structureKind("Viaduct")).toBe("bridge");
    expect(structureKind("Aç-Kapa")).toBe("tunnel");
    expect(structureKind("İstasyon")).toBe("station");
    expect(structureKind(null)).toBe("other");
  });

  it("draws a crowded diagram and adds the key sheets", async () => {
    const m = model(400);
    const file = await writeSchedulePdf(m, options(m));
    const doc = await PDFDocument.load(file.data);
    // diagram + assumptions/key sheets (403 drawn rows do not fit one sheet)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    // hover details over every drawn activity and milestone: push-button fields with /TU, none without tooltips
    const widgets = hoverFields(doc);
    expect(widgets.length).toBeGreaterThanOrEqual(402);
    expect(widgets.every((w) => w.tu.length > 0 && !w.name.includes(".") && (w.flags & 4) === 0)).toBe(true);
    expect(new Set(widgets.map((w) => w.name)).size).toBe(widgets.length);
    expect(widgets.some((w) => w.tu.includes("km "))).toBe(true);
    // registered in the AcroForm, appearances not regenerated by the viewer
    const form = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    expect(form.lookup(PDFName.of("Fields"), PDFArray).size()).toBe(widgets.length);
    expect(String(form.get(PDFName.of("NeedAppearances")))).toBe("false");
    // a click jumps to the activity key row (viewers without field tooltips: Chrome, Edge) …
    const keyPages = new Set(doc.getPages().slice(1).map((p) => p.ref.toString()));
    const jumps = widgets.filter((w) => w.dest);
    expect(jumps.length).toBeGreaterThanOrEqual(400);
    expect(jumps.every((w) => keyPages.has(w.dest!.get(0).toString()) && w.dest!.get(1).toString() === "/XYZ")).toBe(true);
    // … and every key code links back to the diagram
    const backLinks = doc.getPages().slice(1).flatMap((p) => {
      const an = p.node.Annots();
      return Array.from({ length: an?.size() ?? 0 }, (_, i) => an!.lookup(i, PDFDict)).filter((x) => x.get(PDFName.of("Subtype"))?.toString() === "/Link");
    });
    expect(backLinks.length).toBeGreaterThanOrEqual(400);
    expect(backLinks.every((x) => x.lookup(PDFName.of("Dest"), PDFArray).get(0).toString() === doc.getPage(0).ref.toString())).toBe(true);
    const plain = await PDFDocument.load((await writeSchedulePdf(m, options(m, { tooltips: false }))).data);
    expect(plain.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    // the labelled variant also renders (labels placed without overlaps)
    const coded = await PDFDocument.load((await writeSchedulePdf(m, options(m, { labelMode: "codes" }))).data);
    expect(coded.getPageCount()).toBe(doc.getPageCount());
  });

  it("keeps Gantt sheets without key pages", async () => {
    const m = model(5);
    const file = await writeSchedulePdf(m, options(m, { view: "gantt" }));
    expect((await PDFDocument.load(file.data)).getPageCount()).toBe(1);
  });
});
