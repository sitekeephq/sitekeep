/** "Modele sor" engine: query schema, executor, keyword rules, AI answer clean-up and diff groups. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelQuery } from "@sitekeep/shared";
import { runIfcWorker } from "../../src/jobs/queue.js";
import type { IndexFile } from "../../src/jobs/version-index.js";
import type { AiProvider } from "../../src/ai/provider.js";
import { aiCompareSummary, aiQuery, cleanAiQuery, Lru, questionKey, vocabText } from "../../src/model/ai.js";
import { detailDiff, diffCandidates } from "../../src/model/diff.js";
import { ModelIndex } from "../../src/model/model-index.js";
import { executeModelQuery, looseEquals, modelQuerySchema, versionCandidates } from "../../src/model/query.js";
import { rulesQuery } from "../../src/model/rules.js";
import { diffIndexes } from "../../src/doccompare/routes/compare.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let v1: ModelIndex;
let v2: ModelIndex;

const D1 = "0MqDoor000000000000001";
const D2 = "0MqDoor000000000000002";
const D3 = "0MqDoor000000000000003";
const W1 = "0MqWall000000000000001";
const W2 = "0MqWall000000000000002";
const S1 = "0MqSlab000000000000001";
const S2 = "0MqSlab000000000000002";
const COL = "0MqColumn0000000000001";

async function indexOf(fixture: string): Promise<ModelIndex> {
  const out = path.join(dir, `${fixture}.json`);
  const r = await runIfcWorker(path.join(here, "../fixtures", fixture), null, 60_000, out);
  expect(r.index).toEqual({ elementCount: fixture.includes("v2") ? 7 : 7 });
  return ModelIndex.of(JSON.parse(readFileSync(out, "utf8")) as IndexFile);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-mq-"));
  v1 = await indexOf("model-query.ifc");
  v2 = await indexOf("model-query-v2.ifc");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (q: ModelQuery, idx = v1) => executeModelQuery(versionCandidates(idx), modelQuerySchema.parse(q), { versionId: "v" });
const guids = (q: ModelQuery, idx = v1) => run(q, idx).guids.sort();

describe("element index (format 2)", () => {
  it("stores storeys, types, materials and flattened properties", () => {
    expect(v1.detailed).toBe(true);
    expect(v1.storeyNames()).toEqual(["Zemin Kat", "Kat 1"]);
    const d1 = v1.element(D1)!;
    expect(d1).toMatchObject({ cls: "IfcDoor", name: "Kapi-01", storey: "Zemin Kat", type: "KP-90", expressId: 103 });
    // Type properties first, instance properties override / add.
    expect(Object.fromEntries(v1.props(d1))).toMatchObject({ "Pset_DoorCommon.IsExternal": false, "Pset_DoorCommon.FireRating": "EI30" });
    expect(v1.element(W1)).toMatchObject({ storey: "Zemin Kat", material: "Beton C30" });
    expect(v1.element(S2)).toMatchObject({ storey: "Kat 1", material: "Beton C30" });
    expect(Object.fromEntries(v1.props(v1.element(S2)!))).toMatchObject({ "Qto_SlabBaseQuantities.NetArea": 20.5 });
  });

  it("builds a vocabulary with counts and samples", () => {
    const v = v1.vocab();
    expect(v.classes.find((c) => c.name === "IfcDoor")).toEqual({ name: "IfcDoor", label: "Kapı", count: 3 });
    expect(v.storeys).toEqual([
      { name: "Zemin Kat", elevation: 0, count: 3 },
      { name: "Kat 1", elevation: 3.5, count: 4 },
    ]);
    const fire = v.properties.find((p) => p.key === "Pset_DoorCommon.FireRating")!;
    expect(fire).toMatchObject({ name: "FireRating", count: 2, numeric: false });
    expect(fire.samples.sort()).toEqual(["EI30", "EI60"]);
    expect(v.properties.find((p) => p.name === "NetArea")).toMatchObject({ numeric: true, count: 2 });
    const text = vocabText({ ...v, types: v.types });
    expect(text).toContain("IfcDoor (Kapı) 3");
    expect(text).toContain("Katlar (alttan üste): Zemin Kat, Kat 1");
    expect(text).toContain("Qto_SlabBaseQuantities.NetArea (sayı)");
    expect(text.length).toBeLessThan(3600);
  });
});

describe("query schema", () => {
  it("accepts structured queries and rejects anything else", () => {
    expect(modelQuerySchema.safeParse({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "!=", value: "EI60" }] }).success).toBe(true);
    expect(modelQuerySchema.safeParse({ code: "process.exit()" }).success).toBe(false);
    expect(modelQuerySchema.safeParse({ filters: [{ field: "FireRating", op: "eval", value: "x" }] }).success).toBe(false);
    expect(modelQuerySchema.safeParse({ filters: [{ field: "FireRating", op: "=" }] }).success).toBe(false);
    expect(modelQuerySchema.safeParse({ filters: [{ field: "FireRating", op: "exists" }] }).success).toBe(true);
    expect(modelQuerySchema.safeParse({ aggregate: { op: "sum" } }).success).toBe(false);
    expect(modelQuerySchema.safeParse({ groupBy: ["a", "b", "c"] }).success).toBe(false);
    expect(modelQuerySchema.safeParse({ limit: 100000 }).success).toBe(false);
  });

  it("cleans up model answers before validation", () => {
    const raw = { query: { classes: "IfcDoor", storeys: null, filters: [{ field: "FireRating", op: "<>", value: "EI60" }, { field: "X", op: "isnull", value: null }], aggregate: { op: "COUNT" }, extra: 1 } };
    const q = modelQuerySchema.parse(cleanAiQuery(raw));
    expect(q).toEqual({
      classes: ["IfcDoor"],
      filters: [
        { field: "FireRating", op: "!=", value: "EI60" },
        { field: "X", op: "missing" },
      ],
      aggregate: { op: "count" },
    });
  });

  it("compares loosely: case, spaces, numbers, booleans", () => {
    expect(looseEquals("EI 60", "ei60")).toBe(true);
    expect(looseEquals(60, "60")).toBe(true);
    expect(looseEquals(true, "evet")).toBe(true);
    expect(looseEquals(false, "true")).toBe(false);
    expect(looseEquals("EI30", "EI60")).toBe(false);
  });
});

describe("query executor", () => {
  it("filters by class (subtypes, Turkish labels) and storey", () => {
    expect(guids({ classes: ["IfcDoor"] })).toEqual([D1, D2, D3]);
    expect(guids({ classes: ["duvar"] })).toEqual([W1, W2]);
    expect(guids({ classes: ["IfcDoor"], storeys: ["Kat 1"] })).toEqual([D2, D3]);
    expect(guids({ storeys: ["zemin kat"] })).toEqual([D1, S1, W1]);
    const r = run({ storeys: ["Kat 9"] });
    expect(r.count).toBe(0);
    expect(r.warnings.join(" ")).toContain("Kat 9");
  });

  it("applies property operators (missing values count as different)", () => {
    expect(guids({ filters: [{ field: "FireRating", op: "=", value: "EI60" }] })).toEqual([D2]);
    expect(guids({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "!=", value: "EI60" }] })).toEqual([D1, D3]);
    expect(guids({ filters: [{ field: "FireRating", op: "exists" }] })).toEqual([D1, D2]);
    expect(guids({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "missing" }] })).toEqual([D3]);
    expect(guids({ filters: [{ field: "Pset_DoorCommon.FireRating", op: "contains", value: "ei" }] })).toEqual([D1, D2]);
    expect(guids({ filters: [{ field: "NetArea", op: ">", value: 21 }] })).toEqual([S1]);
    expect(guids({ filters: [{ field: "NetSideArea", op: "<=", value: "10.5" }] })).toEqual([W2]);
    expect(guids({ classes: ["IfcWall"], filters: [{ field: "IsExternal", op: "=", value: true }] })).toEqual([W1]);
    // Inherited from the door type.
    expect(guids({ classes: ["IfcDoor"], filters: [{ field: "IsExternal", op: "=", value: "false" }] })).toEqual([D1, D2, D3]);
    expect(guids({ filters: [{ field: "type", op: "=", value: "KP-90" }] })).toEqual([D1, D2, D3]);
    expect(guids({ filters: [{ field: "malzeme", op: "contains", value: "beton" }] })).toEqual([S1, S2, W1, W2]);
    const unknown = run({ filters: [{ field: "Yok", op: "=", value: "x" }] });
    expect(unknown.count).toBe(0);
    expect(unknown.warnings[0]).toContain("Yok");
  });

  it("aggregates and groups", () => {
    const r = run({ classes: ["IfcSlab"], aggregate: { op: "sum", field: "NetArea" }, groupBy: ["storey"] });
    expect(r.aggregate).toEqual({ op: "sum", field: "NetArea", value: 44.5, unit: "m²" });
    expect(r.table!.columns.map((c) => c.label)).toEqual(["Kat", "Adet", "Toplam NetArea (m²)"]);
    expect(r.table!.rows).toEqual([
      ["Zemin Kat", 1, 24],
      ["Kat 1", 1, 20.5],
    ]);
    expect(r.answer).toContain("2 döşeme bulundu");
    expect(r.answer).toContain("Toplam NetArea: 44,5 m²");
    expect(r.elements.map((e) => e.value)).toEqual([24, 20.5]);

    const byClass = run({ groupBy: ["class"] });
    expect(byClass.table!.rows[0]).toEqual(["Kapı", 3]);
    const avg = run({ classes: ["IfcWall"], aggregate: { op: "avg", field: "NetSideArea" } });
    expect(avg.aggregate!.value).toBe(12.75);
  });

  it("lists elements with express ids, capped by limit", () => {
    const r = run({ limit: 2 });
    expect(r.count).toBe(7);
    expect(r.elements).toHaveLength(2);
    expect(r.more).toBe(5);
    expect(r.guids).toHaveLength(7);
    expect(r.elements[0]).toMatchObject({ storey: "Zemin Kat", expressId: expect.any(Number) });
  });

  it("describes results per storey", () => {
    expect(run({ classes: ["IfcDoor"], storeys: ["Kat 1"], filters: [{ field: "FireRating", op: "exists" }] }).answer).toBe(
      "Kat 1: 1 kapı bulundu (FireRating var).",
    );
  });

  it("describes empty results", () => {
    const r = run({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "=", value: "EI120" }] });
    expect(r.answer).toMatch(/^Aranan koşullara uyan kapı bulunamadı/);
  });
});

describe("keyword rules", () => {
  const vocab = () => v1.vocab();
  it("reads classes, storeys and fire ratings", () => {
    expect(rulesQuery("1. kattaki yangın kapıları", vocab())).toEqual({
      classes: ["IfcDoor"],
      storeys: ["Kat 1"],
      filters: [{ field: "FireRating", op: "exists" }],
    });
    expect(rulesQuery("EI60 olmayan kapılar", vocab())).toEqual({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "!=", value: "EI60" }] });
    expect(rulesQuery("Kat 1'deki duvarları listele", vocab())).toEqual({ classes: ["IfcWall"], storeys: ["Kat 1"] });
    expect(rulesQuery("zemin kattaki dış duvarlar", vocab())).toEqual({
      classes: ["IfcWall"],
      storeys: ["Zemin Kat"],
      filters: [{ field: "IsExternal", op: "=", value: true }],
    });
  });

  it("reads quantities and grouping", () => {
    expect(rulesQuery("kaç m² döşeme var", vocab())).toEqual({ classes: ["IfcSlab"], aggregate: { op: "sum", field: "NetArea" } });
    expect(rulesQuery("katlara göre duvar alanı", vocab())).toEqual({
      classes: ["IfcWall"],
      aggregate: { op: "sum", field: "NetSideArea" },
      groupBy: ["storey"],
    });
    expect(rulesQuery("beton elemanlar", vocab())).toEqual({ filters: [{ field: "material", op: "contains", value: "beton" }] });
  });

  it("answers the example questions end to end", () => {
    const r = run(rulesQuery("EI60 olmayan kapılar", vocab()));
    expect(r.guids.sort()).toEqual([D1, D3]);
    expect(run(rulesQuery("kaç m² döşeme var", vocab())).aggregate!.value).toBe(44.5);
  });

  it("reads kinds of change when comparing", () => {
    expect(rulesQuery("hangi kapılar değişti?", vocab(), { comparing: true })).toEqual({ classes: ["IfcDoor"], change: ["changed"] });
    expect(rulesQuery("silinen duvarlar", vocab(), { comparing: true })).toEqual({ classes: ["IfcWall"], change: ["removed"] });
  });
});

describe("comparison groups", () => {
  it("finds property-level changes and groups them by storey and class", () => {
    const base = diffIndexes(v1.file.elements, v2.file.elements);
    expect(base).toMatchObject({ added: [COL], removed: [W2], changed: [D1] });
    const d = detailDiff(v1, v2, base);
    expect(d.detailed).toBe(true);
    expect(d.changes[D1]).toEqual([{ prop: "Pset_DoorCommon.FireRating", from: "EI30", to: "EI60" }]);
    expect(d.storeys).toEqual({ [COL]: "Kat 1", [W2]: "Kat 1", [D1]: "Zemin Kat" });
    expect(d.groups.map((g) => g.text)).toEqual([
      "Zemin Kat · Kapı: 1 elemanda FireRating EI30 → EI60",
      "Kat 1 · Duvar: 1 silindi",
      "Kat 1 · Kolon: 1 eklendi",
    ]);
    expect(d.groups[0]).toMatchObject({ id: "g1", kind: "changed", storey: "Zemin Kat", class: "IfcDoor", guids: [D1], from: "EI30", to: "EI60" });
  });

  it("folds many different value pairs into one group", () => {
    const fake = (n: number, v: string) => ({
      v: 2,
      elements: Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, ["IfcWall", `W${i}`, `${v}${i}`]])),
      storeys: [{ name: "K", elevation: 0 }],
      keys: ["P.Code"],
      vals: Array.from({ length: n }, (_, i) => `${v}${i}`),
      details: Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, [i, 0, -1, -1, "p", [0, i]]])),
    }) as unknown as IndexFile;
    const a = ModelIndex.of(fake(5, "a"));
    const b = ModelIndex.of(fake(5, "b"));
    const d = detailDiff(a, b, diffIndexes(a.file.elements, b.file.elements));
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]).toMatchObject({ mixed: true, count: 5, text: "K · Duvar: 5 elemanda Code değişti (5 farklı değer)" });
  });

  it("queries the changed elements only", () => {
    const base = diffIndexes(v1.file.elements, v2.file.elements);
    const cands = diffCandidates(v1, v2, base);
    const all = executeModelQuery(cands, {}, { versionId: "v2", compareFrom: "v1" });
    expect(all.total).toBe(3);
    expect(all.guids.sort()).toEqual([COL, D1].sort());
    expect(all.removedGuids).toEqual([W2]);
    const doors = executeModelQuery(cands, { classes: ["IfcDoor"], change: ["changed"] }, { versionId: "v2", compareFrom: "v1" });
    expect(doors.guids).toEqual([D1]);
    expect(doors.elements[0]).toMatchObject({ change: "changed" });
    expect(doors.answer).toBe("Değişikliklerde (değişen): 1 kapı bulundu.");
    const removed = executeModelQuery(cands, { change: ["removed"] }, { versionId: "v2", compareFrom: "v1" });
    expect(removed).toMatchObject({ guids: [], removedGuids: [W2] });
  });
});

describe("AI answers are validated", () => {
  const fake = (text: string) =>
    ({ name: "Sahte", chat: async () => ({ text, toolCalls: [], model: "sahte", stopReason: "stop" }) }) as unknown as AiProvider;

  it("turns the model's JSON into a query, rejects anything else", async () => {
    const ok = await aiQuery(fake('Tamam:\n```json\n{"classes":["IfcDoor"],"filters":[{"field":"FireRating","op":"==","value":"EI60"}]}\n```'), "x", v1.vocab(), { comparing: false });
    expect(ok.query).toEqual({ classes: ["IfcDoor"], filters: [{ field: "FireRating", op: "=", value: "EI60" }] });
    await expect(aiQuery(fake('{"filters":[{"field":"x","op":"exec","value":"rm"}]}'), "x", v1.vocab(), { comparing: false })).rejects.toThrow(/geçersiz/);
    await expect(aiQuery(fake("Bilmiyorum"), "x", v1.vocab(), { comparing: false })).rejects.toThrow(/geçerli/);
  });

  it("drops summary lines with invented numbers and infers missing refs", async () => {
    const d = detailDiff(v1, v2, diffIndexes(v1.file.elements, v2.file.elements));
    const r = await aiCompareSummary(
      fake('{"bullets":[{"text":"Zemin Kat: 3 kapı değişti"},{"text":"Zemin Kat kapı FireRating EI60 oldu"},{"text":"Kat 1: 1 duvar silindi","refs":["g2","g42"]}]}'),
      "Toplam: 1 eklendi, 1 silindi, 1 değişti.",
      d.groups,
    );
    expect(r.bullets).toEqual([
      { text: "Zemin Kat kapı FireRating EI60 oldu", groupIds: ["g1"] },
      { text: "Kat 1: 1 duvar silindi", groupIds: ["g2"] },
    ]);
    await expect(aiCompareSummary(fake('{"bullets":[{"text":"9 kolon eklendi"}]}'), "Toplam: 1", d.groups)).rejects.toThrow();
  });
});

describe("cache helpers", () => {
  it("evicts the least recently used entry and folds questions", () => {
    const c = new Lru<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(questionKey("v", undefined, "Kaç Döşeme VAR?")).toBe(questionKey("v", undefined, "kaç döşeme var"));
  });
});
