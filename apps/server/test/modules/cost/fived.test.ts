/** 5D on a synthetic element index: cost computation, cash flow and unit price list import (docs/features/4D_5D.md). */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { type ActivityDto } from "@sitekeep/shared";
import { normalizeCostUnit } from "@7dimensions-project/sitekeep-ee-cost/shared/sim.js";
import { cashflowAt } from "@7dimensions-project/sitekeep-ee-planning/shared/sim.js";
import type { IndexFile } from "../../../src/jobs/version-index.js";
import { ModelIndex } from "../../../src/model/model-index.js";
import { computeCostLines, costCashflow, summarizeCosts, type CostItemRow, type CostRuleRow } from "@7dimensions-project/sitekeep-ee-cost/internal/fived/cost.js";
import { parseCostRows, parsePrice, readCostTable, suggestCostMapping } from "@7dimensions-project/sitekeep-ee-cost/internal/fived/cost-import.js";

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

const ITEMS: CostItemRow[] = [
  { id: "c30", code: "BET-C30", description: "C30 hazır beton", unit: "m³", unitPrice: 2500, currency: "TRY", category: "Betonarme", pozCode: "15.150.1005" },
  { id: "don", code: "DON-01", description: "Nervürlü donatı", unit: "kg", unitPrice: 30, currency: "TRY", category: "Betonarme" },
  { id: "kal", code: "KAL-01", description: "Döşeme kalıbı", unit: "m²", unitPrice: 400, currency: "TRY", category: "Kalıp" },
  { id: "ank", code: "ANK-01", description: "Kolon ankrajı", unit: "adet", unitPrice: 50, currency: "TRY", category: null },
];
const label = (id: string) => id;
const RULES: CostRuleRow[] = [
  { id: "r-c30", costItemId: "c30", match: { classes: ["IfcSlab"] }, quantity: "NetVolume", multiplier: 1, activityCode: null, label: label("r-c30") },
  { id: "r-don", costItemId: "don", match: { classes: ["IfcSlab"], storeys: ["Kat 2"] }, quantity: "NetVolume", multiplier: 100, activityCode: "A-200", label: label("r-don") },
  { id: "r-ank", costItemId: "ank", match: { classes: ["IfcColumn"] }, quantity: "count", multiplier: 1, activityCode: null, label: label("r-ank") },
  { id: "r-kal", costItemId: "kal", match: { classes: ["IfcSlab"], storeys: ["Kat 2"] }, quantity: "NetVolume", multiplier: 1, activityCode: null, label: label("r-kal") },
  { id: "r-poz", costItemId: null, match: { property: { key: "PozNo", equalsTarget: "code" } }, quantity: "NetVolume", multiplier: 1, activityCode: null, label: label("r-poz") },
];

describe("5D cost computation", () => {
  const elActs = new Map([
    ["S2a", ["A-200", "A-210"]],
    ["S2b", ["A-200"]],
    ["S1a", ["A-100"]],
    ["C2a", ["A-210"]],
  ]);

  it("multiplies quantities (with multipliers) by unit prices and flags missing base quantities", () => {
    const res = computeCostLines(index(), RULES, ITEMS, elActs);
    const by = (rule: string, guid: string) => res.lines.find((l) => l.ruleId === rule && l.guid === guid);
    expect(by("r-c30", "S2a")).toMatchObject({ quantity: 10, amount: 25000, activityCodes: ["A-200", "A-210"] });
    expect(by("r-c30", "S2c")).toMatchObject({ quantity: null, amount: 0 });
    expect(by("r-don", "S2b")).toMatchObject({ quantity: 1250, amount: 37500, activityCodes: ["A-200"] });
    expect(by("r-ank", "C1a")).toMatchObject({ quantity: 1, amount: 50, activityCodes: [] });
    // Property = poz no (official poz code of the item).
    expect(by("r-poz", "S1a")).toMatchObject({ itemId: "c30", quantity: 8, amount: 20000 });
    const stats = new Map(res.rules.map((r) => [r.id, r]));
    expect(stats.get("r-c30")).toMatchObject({ matched: 4, missing: 1, amount: 76250 });
    expect(stats.get("r-ank")).toMatchObject({ matched: 3, amount: 150 });
    // Unit check: m² item priced by a volume without a multiplier.
    expect(stats.get("r-kal")!.warnings.join(" ")).toContain("KAL-01 birimi m²");
    expect(stats.get("r-don")!.warnings).toEqual([]);
  });

  it("sums by item, category, storey, class and activity", () => {
    const idx = index();
    const res = computeCostLines(idx, RULES.slice(0, 3), ITEMS, elActs);
    const s = summarizeCosts([{ index: idx, lines: res.lines, ruleLabels: new Map(), ruleQuantity: new Map([["r-c30", "NetVolume"]]) }], ITEMS, new Map([["A-200", "Kat 2 Döşemeler"]]));
    // C30: (10 + 12.5 + 8) × 2500 = 76250; donatı: (10 + 12.5) × 100 × 30 = 67500; ankraj: 3 × 50.
    expect(s.total).toBe(76250 + 67500 + 150);
    expect(s.byItem.map((i) => [i.code, i.quantity, i.amount])).toEqual([
      ["BET-C30", 30.5, 76250],
      ["DON-01", 2250, 67500],
      ["ANK-01", 3, 150],
    ]);
    expect(s.byCategory.map((g) => [g.label, g.amount])).toEqual([
      ["Betonarme", 143750],
      ["Kategorisiz", 150],
    ]);
    expect(s.byStorey.map((g) => g.label)).toEqual(["Kat 1", "Kat 2"]);
    expect(s.byClass.find((g) => g.key === "IfcSlabStandardCase")).toMatchObject({ amount: 31250 + 37500 });
    const acts = new Map(s.byActivity.map((g) => [g.key, g.amount]));
    // S2a's concrete is split between its two activities; donatı goes to the rule's activity.
    expect(acts.get("A-200")).toBe(12500 + 31250 + 30000 + 37500);
    expect(acts.get("A-210")).toBe(12500 + 50);
    expect(s.byActivity.find((g) => g.key === "")).toMatchObject({ label: "Faaliyete Bağlı Değil", amount: 100 });
    expect(s.missingCount).toBe(2); // S2c has no NetVolume: concrete and rebar lines
    expect(s.missing[0]).toMatchObject({ guid: "S2c", quantity: "Net Hacim" });
    expect(s.warnings.join(" ")).toContain("miktar yok");
  });

  it("builds the cash-flow curve: planned on the baseline, actual earned up to the data date", () => {
    const costs = new Map([
      ["A-100", 12000],
      ["A-200", 10000],
      ["", 500],
    ]);
    const flow = costCashflow(ACTIVITIES, costs, { scheduleId: "s", dataDate: DATA_DATE, step: "day", currency: "TRY", ref: DATA_DATE });
    expect(flow).toMatchObject({ total: 22500, scheduled: 22000, unscheduled: 500 });
    const at = (d: string) => flow.points.find((p) => p.date === d)!;
    expect(at("2026-01-16")).toMatchObject({ planned: 12000, actual: 12000 });
    // A-200 baseline 26.01–06.02 (12 days): fully planned by 06.02; 40 % earned by the data date.
    expect(at("2026-02-06").planned).toBe(22000);
    expect(at(DATA_DATE)).toMatchObject({ planned: 22000, actual: 16000, forecast: 16000 });
    expect(at("2026-02-11").actual).toBeNull();
    expect(flow.points.at(-1)).toMatchObject({ forecast: 22000, planned: 22000 });
    expect(cashflowAt(flow.points, "2026-02-10", "actual")).toBe(16000);
    expect(cashflowAt(flow.points, "2025-01-01", "planned")).toBe(0);
    const weekly = costCashflow(ACTIVITIES, costs, { scheduleId: "s", dataDate: DATA_DATE, step: "week", currency: "TRY", ref: DATA_DATE });
    expect(weekly.points.some((p) => p.date === DATA_DATE)).toBe(true);
    expect(weekly.points.length).toBeLessThan(flow.points.length);
  });
});

describe("unit price list import (XLSX / CSV)", () => {
  function xlsx(rows: (string | number)[][]): Buffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Birim Fiyatlar");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  it("finds the header row, maps Turkish columns and normalises units and prices", () => {
    const data = xlsx([
      ["2026 Yılı Birim Fiyat Listesi"],
      [],
      ["Sıra", "Poz No", "Tanımı", "Birimi", "Birim Fiyatı (TL)", "Kategori"],
      ["", "BETONARME İŞLERİ", "", "", "", ""],
      [1, "15.150.1005", "C30/37 hazır beton", "m3", 2500.5, "Betonarme"],
      [2, "15.160.1003", "Nervürlü donatı", "ton", "31.250,00", "Betonarme"],
      [3, "15.180.1001", "Döşeme kalıbı", "M2", "1.234,56", "Kalıp"],
      [4, "15.999.0001", "Ankraj", "ad.", 45, ""],
      [5, "15.999.0002", "Tuhaf birim", "kutu", 10, ""],
      [6, "15.150.1005", "C30/37 hazır beton (güncel)", "m³", 2600, "Betonarme"],
    ]);
    const table = readCostTable("fiyatlar.xlsx", data);
    expect(table.headerRow).toBe(2);
    const mapping = suggestCostMapping(table.headers);
    expect(mapping).toMatchObject({ code: 1, description: 2, unit: 3, unitPrice: 4, category: 5 });
    const { items, warnings, skipped } = parseCostRows(table, mapping);
    expect(items.map((i) => [i.code, i.unit, i.unitPrice, i.category])).toEqual([
      ["15.150.1005", "m³", 2600, "Betonarme"],
      ["15.160.1003", "ton", 31250, "Betonarme"],
      ["15.180.1001", "m²", 1234.56, "Kalıp"],
      ["15.999.0001", "adet", 45, null],
    ]);
    expect(items[0]!.description).toBe("C30/37 hazır beton (güncel)");
    expect(items.every((i) => i.currency === "TRY")).toBe(true);
    expect(skipped).toBe(2); // heading row and the unknown unit
    expect(warnings.join(" ")).toContain('"kutu" birimi tanınmadı');
    expect(warnings.join(" ")).toContain("iki kez");
    // A manual mapping wins over the suggestion; missing required columns are refused.
    expect(() => parseCostRows(table, { ...mapping, unitPrice: null })).toThrow("Birim Fiyat");
  });

  it("reads a semicolon CSV with Turkish number formats", () => {
    const csv = "Poz No;Tanım;Birim;Birim Fiyat;Para Birimi\nK-01;Kazı;m³;125,5;TL\nK-02;Dolgu;m3;1.050;EUR\n";
    const bytes = Buffer.from(new TextEncoder().encode(csv));
    const table = readCostTable("liste.csv", bytes);
    const { items } = parseCostRows(table, suggestCostMapping(table.headers));
    expect(items).toEqual([
      expect.objectContaining({ code: "K-01", unit: "m³", unitPrice: 125.5, currency: "TRY" }),
      expect.objectContaining({ code: "K-02", unit: "m³", unitPrice: 1050, currency: "EUR" }),
    ]);
    expect(parsePrice("1,234.56")).toBe(1234.56);
    expect(parsePrice("12 TL")).toBe(12);
    expect(parsePrice("abc")).toBeNull();
    expect(normalizeCostUnit("mtül")).toBe("m");
    expect(normalizeCostUnit("Metreküp")).toBe("m³");
  });
});
