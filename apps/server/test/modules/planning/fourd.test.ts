/** 4D engine on a synthetic element index: rules, suggestions, 4D state. 5D: test/modules/cost/fived.test.ts. */
import { describe, expect, it } from "vitest";
import { ruleMatchLabel, type ActivityDto } from "@sitekeep/shared";
import { plannedStatusAt, progressAt, simStatusAt } from "@7dimensions-project/sitekeep-ee-planning/shared/sim.js";
import type { IndexFile } from "../../../src/jobs/version-index.js";
import { ModelIndex } from "../../../src/model/model-index.js";
import { fourDState } from "@7dimensions-project/sitekeep-ee-planning/internal/fourd.js";
import { evaluateRules, normalizeMatch, previewRules } from "../../../src/model/rule-match.js";
import { classesForName, storeyByName, suggestLinkRules } from "@7dimensions-project/sitekeep-ee-planning/internal/suggest.js";

type Props = Record<string, string | number | boolean>;
interface El {
  guid: string;
  cls: string;
  name: string;
  storey: number;
  props?: Props;
}

const STOREYS = [
  { name: "Bodrum Kat", elevation: -3 },
  { name: "Zemin Kat", elevation: 0 },
  { name: "Kat 1", elevation: 3.5 },
  { name: "Kat 2", elevation: 7 },
];

/** Builds a format-2 index file in memory (no IFC needed). */
export function synthIndex(els: El[], storeys = STOREYS): IndexFile {
  const keys: string[] = [];
  const vals: (string | number | boolean)[] = [];
  const k = (s: string) => (keys.includes(s) ? keys.indexOf(s) : keys.push(s) - 1);
  const v = (x: string | number | boolean) => (vals.includes(x) ? vals.indexOf(x) : vals.push(x) - 1);
  const file: IndexFile = { v: 2, storeys, keys, vals, elements: {}, details: {} };
  els.forEach((e, i) => {
    file.elements[e.guid] = [e.cls, e.name, `h${i}`];
    file.details![e.guid] = [100 + i, e.storey, -1, -1, `p${i}`, Object.entries(e.props ?? {}).flatMap(([kk, vv]) => [k(kk), v(vv)])];
  });
  return file;
}

const ELEMENTS: El[] = [
  { guid: "S2a", cls: "IfcSlab", name: "Döşeme D1", storey: 3, props: { "BaseQuantities.NetVolume": 10, "BaseQuantities.NetArea": 50, "Pset_Proje.WBS": "A-200" } },
  { guid: "S2b", cls: "IfcSlabStandardCase", name: "Döşeme D2", storey: 3, props: { "BaseQuantities.NetVolume": 12.5, "Pset_Proje.WBS": "A-200" } },
  { guid: "S2c", cls: "IfcSlab", name: "Döşeme D3", storey: 3, props: { "Pset_Proje.WBS": "X-999" } },
  { guid: "S1a", cls: "IfcSlab", name: "Döşeme D4", storey: 2, props: { "BaseQuantities.NetVolume": 8, "Pset_Proje.WBS": "A-100", "Pset_Proje.PozNo": "15.150.1005" } },
  { guid: "C2a", cls: "IfcColumn", name: "Kolon K1", storey: 3, props: { "BaseQuantities.NetVolume": 0.5 } },
  { guid: "C2b", cls: "IfcColumn", name: "Kolon K2", storey: 3, props: { "BaseQuantities.NetVolume": 0.5 } },
  { guid: "C1a", cls: "IfcColumn", name: "Kolon K3", storey: 2, props: { "BaseQuantities.NetVolume": 0.5 } },
  { guid: "W0a", cls: "IfcWall", name: "Perde Duvar P1", storey: 0, props: { "BaseQuantities.NetVolume": 6 } },
  { guid: "W0b", cls: "IfcWallStandardCase", name: "Bölme Duvar", storey: 0, props: { "BaseQuantities.NetVolume": 2 } },
  { guid: "ST1", cls: "IfcStair", name: "Merdiven M1", storey: 1 },
  { guid: "F1", cls: "IfcFooting", name: "Radye", storey: 0, props: { "BaseQuantities.NetVolume": "40,5" } },
];

const index = () => ModelIndex.of(synthIndex(ELEMENTS));

function act(code: string, name: string, o: Partial<ActivityDto> = {}): ActivityDto {
  return {
    id: code,
    scheduleId: "s",
    code,
    externalId: null,
    wbsPath: null,
    name,
    start: null,
    finish: null,
    baselineStart: null,
    baselineFinish: null,
    actualStart: null,
    actualFinish: null,
    percentComplete: 0,
    durationDays: null,
    critical: false,
    milestone: false,
    summary: false,
    resource: null,
    parentId: null,
    outlineLevel: 2,
    sortIndex: 0,
    finishVarianceDays: null,
    ...o,
  };
}

const ACTIVITIES: ActivityDto[] = [
  act("S-1", "Kaba İnşaat", { summary: true, start: "2026-01-01", finish: "2026-03-10" }),
  act("A-005", "Kazı", { start: "2025-12-20", finish: "2025-12-31", percentComplete: 100, actualFinish: "2025-12-31" }),
  act("A-010", "Bodrum Perde Duvarları", { start: "2026-01-01", finish: "2026-01-10", baselineStart: "2026-01-01", baselineFinish: "2026-01-10", actualStart: "2026-01-01", actualFinish: "2026-01-09", percentComplete: 100 }),
  act("A-100", "Kat 1 Döşeme Betonu", { start: "2026-01-05", finish: "2026-01-16", baselineStart: "2026-01-05", baselineFinish: "2026-01-16", actualStart: "2026-01-05", actualFinish: "2026-01-16", percentComplete: 100 }),
  act("A-200", "Kat 2 Döşemeler", { start: "2026-02-02", finish: "2026-02-13", baselineStart: "2026-01-26", baselineFinish: "2026-02-06", actualStart: "2026-02-02", percentComplete: 40 }),
  act("A-210", "Kat 2 Kolon Betonu", { start: "2026-02-16", finish: "2026-02-20", baselineStart: "2026-02-09", baselineFinish: "2026-02-13" }),
  act("A-300", "Merdivenler", { start: "2026-03-01", finish: "2026-03-10", baselineStart: "2026-03-01", baselineFinish: "2026-03-10" }),
];
const DATA_DATE = "2026-02-10";
const targets = ACTIVITIES.filter((a) => !a.summary).map((a) => ({ key: a.code, code: a.code, alt: a.wbsPath }));

describe("rule engine (storey, class, property, name)", () => {
  it("matches storey + IFC class, StandardCase subclasses, name and literal property values", () => {
    const idx = index();
    const ev = evaluateRules(
      idx,
      [
        { id: "r1", target: "A-200", match: { classes: ["IfcSlab"], storeys: ["Kat 2"] }, label: "" },
        { id: "r2", target: "A-010", match: { classes: ["IfcWall"] }, label: "" },
        { id: "r3", target: "A-010", match: { nameContains: "PERDE" }, label: "" },
        { id: "r4", target: "A-100", match: { property: { key: "WBS", value: "a-100" } }, label: "" },
        { id: "r5", target: "A-999", match: { classes: ["IfcSlab"] }, label: "" },
      ],
      targets,
    );
    expect([...ev.rules[0]!.assigned.keys()].sort()).toEqual(["S2a", "S2b", "S2c"]);
    expect([...ev.rules[1]!.assigned.keys()].sort()).toEqual(["W0a", "W0b"]);
    expect([...ev.rules[2]!.assigned.keys()]).toEqual(["W0a"]);
    expect([...ev.rules[3]!.assigned.keys()]).toEqual(["S1a"]);
    expect(ev.rules[4]!.assigned.size).toBe(0);
    expect(ev.rules[4]!.warnings[0]).toContain("A-999");
    expect([...ev.byTarget.get("A-010")!].sort()).toEqual(["W0a", "W0b"]);
  });

  it("maps elements to activities by a property equal to the activity code (one rule for the model)", () => {
    const idx = index();
    const p = previewRules(idx, "v1", [{ id: null, target: null, match: { property: { key: "Pset_Proje.WBS", equalsTarget: "code" } }, label: "WBS" }], targets);
    expect(p.rules[0]).toMatchObject({ matched: 3, targets: 2, unknownValues: ["X-999"] });
    expect(p).toMatchObject({ modelElements: ELEMENTS.length, matchedElements: 3, targets: 2, multiTarget: 0 });
    // Overlapping rules: an element of two activities is counted once and reported.
    const both = previewRules(
      idx,
      "v1",
      [
        { id: null, target: "A-200", match: { classes: ["IfcSlab"], storeys: ["Kat 2"] }, label: "" },
        { id: null, target: "A-210", match: { storeys: ["Kat 2"] }, label: "" },
      ],
      targets,
    );
    expect(both).toMatchObject({ matchedElements: 5, multiTarget: 3 });
  });

  it("normalises and labels rules in Turkish", () => {
    expect(normalizeMatch({ classes: [" IfcSlab ", "IfcSlab"], storeys: [], nameContains: " ", property: { key: "WBS", value: "" } })).toEqual({
      classes: ["IfcSlab"],
      property: { key: "WBS" },
    });
    expect(ruleMatchLabel({ storeys: ["Kat 2"], classes: ["IfcSlab"] })).toBe("Kat: Kat 2 · Sınıf: Döşeme");
    expect(ruleMatchLabel({ property: { key: "WBS", equalsTarget: "code" } })).toBe("WBS = faaliyet kodu");
    expect(ruleMatchLabel({ property: { key: "PozNo", equalsTarget: "code" } }, "cost")).toBe("PozNo = poz no");
  });
});

describe("rule suggestions from Turkish activity names", () => {
  it("maps Kolon, Döşeme, Perde, Merdiven to classes and storey names; skips Kazı without earthworks", () => {
    const vocab = index().vocab();
    expect(classesForName("Kat 2 Kolon Betonu", vocab).classes).toEqual(["IfcColumn"]);
    expect(classesForName("Bodrum Perde Duvarları", vocab)).toMatchObject({ classes: ["IfcWall"], words: ["Perde", "Duvar"] });
    expect(classesForName("Kazı", vocab)).toMatchObject({ classes: [], missing: ["Kazı"] });
    expect(classesForName("Çatışma analizi", vocab).classes).toEqual([]);

    const { suggestions, skipped } = suggestLinkRules(index(), ACTIVITIES);
    const by = new Map(suggestions.map((s) => [s.activityCode, s]));
    // The WBS property equals two activity codes: one property rule first.
    expect(suggestions[0]).toMatchObject({ activityCode: null, match: { property: { key: "Pset_Proje.WBS", equalsTarget: "code" } } });
    expect(by.get("A-200")).toMatchObject({ match: { classes: ["IfcSlab"], storeys: ["Kat 2"] }, matched: 3 });
    expect(by.get("A-210")).toMatchObject({ match: { classes: ["IfcColumn"], storeys: ["Kat 2"] }, matched: 2 });
    expect(by.get("A-100")).toMatchObject({ match: { classes: ["IfcSlab"], storeys: ["Kat 1"] }, matched: 1 });
    expect(by.get("A-010")).toMatchObject({ match: { classes: ["IfcWall"], storeys: ["Bodrum Kat"] }, matched: 2 });
    expect(by.get("A-300")).toMatchObject({ match: { classes: ["IfcStair"] }, matched: 1 });
    expect(by.get("A-300")!.reason).toContain("tüm katlar");
    expect(skipped).toEqual([{ code: "A-005", name: "Kazı", reason: "Modelde kazı elemanı yok." }]);
    // Deterministic: same input, same output.
    expect(suggestLinkRules(index(), ACTIVITIES)).toEqual({ suggestions, skipped });
  });

  it("finds storeys named with elevations and (SSL) suffixes; raft foundations as base slabs", () => {
    const storeys = [
      "-0.50 (+4.20) PERON ALTI KATI (SSL)",
      "+3.10 (+7.80) PERON KATI (SSL)",
      "+12.00 (+16.70) BİLET HOLÜ KİRİŞ KOTU (SSL)",
      "+15.00 (+19.70) BİLET HOLÜ KATI (SSL)",
      "+20.00 (+24.70) ÇATI KATI (SSL)",
      "1. Bodrum Kat",
      "2. Bodrum Kat",
    ];
    expect(storeyByName("Peron Altı Katı Döşemesi", storeys)).toBe(storeys[0]);
    expect(storeyByName("Peron Katı Kolonları", storeys)).toBe(storeys[1]);
    expect(storeyByName("Peron Perdeleri", storeys)).toBe(storeys[1]);
    expect(storeyByName("Bilet Holü Kirişleri", storeys)).toBe(storeys[3]);
    expect(storeyByName("Çatı Döşemesi", storeys)).toBe(storeys[4]);
    expect(storeyByName("2. Bodrum Kat Perdeleri", storeys)).toBe(storeys[6]);
    expect(storeyByName("Kolon Betonu", storeys)).toBeNull();

    const station = ModelIndex.of(
      synthIndex(
        [
          { guid: "R1", cls: "IfcSlab", name: "Foundation Slab:Radye Temel_1200mm", storey: 0, props: { "Attr.PredefinedType": "BASESLAB" } },
          { guid: "D1", cls: "IfcSlab", name: "Floor:Döşeme_300mm", storey: 1, props: { "Attr.PredefinedType": "FLOOR" } },
          { guid: "K1", cls: "IfcColumn", name: "Kolon 400x400", storey: 1 },
          { guid: "K2", cls: "IfcColumn", name: "Kolon 400x400", storey: 3 },
        ],
        storeys.slice(0, 4).map((name, i) => ({ name, elevation: i })),
      ),
    );
    const res = suggestLinkRules(station, [act("T-1", "Radye Temel Betonu"), act("T-2", "Peron Katı Kolonları"), act("T-3", "Peron Katı Döşemesi")]);
    expect(res.suggestions.map((x) => [x.activityCode, x.match, x.matched])).toEqual([
      ["T-1", { classes: ["IfcSlab"], property: { key: "PredefinedType", op: "=", value: "BASESLAB" } }, 1],
      ["T-2", { classes: ["IfcColumn"], storeys: [storeys[1]] }, 1],
      ["T-3", { classes: ["IfcSlab"], storeys: [storeys[1]] }, 1],
    ]);
  });
});

describe("4D state at a date", () => {
  const links = [
    { activityCode: "A-100", globalIds: ["S1a"] },
    { activityCode: "A-200", globalIds: ["S2a", "S2b", "S2c"] },
    { activityCode: "A-210", globalIds: ["C2a", "C2b", "S2a"] },
    { activityCode: "A-010", globalIds: ["W0a", "W0b"] },
  ];
  const s = { id: "s", dataDate: DATA_DATE };

  it("uses reported progress up to the data date (late in red) and the current plan after it", () => {
    const st = fourDState(s, ACTIVITIES, links, DATA_DATE, "actual");
    // A-210 should have started on 09.02 (baseline) but has not: late as well.
    expect(st.counts).toEqual({ complete: 3, late: 2, not_started: 1, in_progress: 0 });
    expect(st.active).toEqual([
      expect.objectContaining({ code: "A-200", status: "late", percent: 40, elementCount: 3 }),
      expect.objectContaining({ code: "A-210", status: "late", percent: 0, elementCount: 3 }),
    ]);
    expect(st.elementCounts).toEqual({ complete: 3, late: 5, not_started: 0, in_progress: 0 });
    expect(st.linkedElements).toBe(8);
    // After the data date the current plan runs: A-200 done, A-210 under way but past its baseline.
    const later = fourDState(s, ACTIVITIES, links, "2026-02-17", "actual");
    expect(later.active.map((x) => [x.code, x.status, x.percent])).toEqual([["A-210", "late", 40]]);
    expect(progressAt(ACTIVITIES[4]!, "2026-02-12", DATA_DATE, "actual")).toBe(80);
  });

  it("plays the baseline in planned mode (no late, finish day still in progress)", () => {
    const st = fourDState(s, ACTIVITIES, links, DATA_DATE, "planned");
    expect(st.active.map((x) => [x.code, x.status, x.percent])).toEqual([["A-210", "in_progress", 40]]);
    expect(st.counts.late).toBe(0);
    expect(plannedStatusAt(ACTIVITIES[4]!, "2026-02-06")).toBe("in_progress");
    expect(plannedStatusAt(ACTIVITIES[4]!, "2026-02-07")).toBe("complete");
    expect(simStatusAt(ACTIVITIES[4]!, "2026-02-07", DATA_DATE, "actual")).toBe("late");
    // S2a belongs to a finished (A-200) and a running (A-210) activity: in progress.
    expect(st.elementCounts).toMatchObject({ complete: 5, in_progress: 3, late: 0 });
  });
});
