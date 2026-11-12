/** "Poz Öner": element groups, keyword / memory / AI suggestions over the poz.ifc fixture. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pozQuantityFor } from "@7dimensions-project/sitekeep-ee-cost/shared/poz.js";
import type { AiProvider } from "../../../src/ai/provider.js";
import { runIfcWorker } from "../../../src/jobs/queue.js";
import type { IndexFile } from "../../../src/jobs/version-index.js";
import { ModelAiError } from "../../../src/model/ai.js";
import { ModelIndex } from "../../../src/model/model-index.js";
import type { CostItemRow } from "@7dimensions-project/sitekeep-ee-cost/internal/fived/cost.js";
import { aiPozPick, fromKeywords, fromMemory, pozGroups, sortSuggestions, type PozGroup, type PozMemoryRow } from "@7dimensions-project/sitekeep-ee-cost/internal/fived/poz.js";
import { matchRule } from "../../../src/model/rule-match.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let index: ModelIndex;
let groups: PozGroup[];
let inexact: PozGroup[];

const item = (id: string, code: string, description: string, unit: CostItemRow["unit"], unitPrice: number, pozCode: string | null = null): CostItemRow => ({
  id,
  code,
  description,
  unit,
  unitPrice,
  currency: "TRY",
  category: null,
  pozCode,
});
const ITEMS: CostItemRow[] = [
  item("i-bet", "BET-C30", "C30 hazır beton dökülmesi", "m³", 2500, "15.150.1005"),
  item("i-gaz", "GAZ-20", "20 cm gazbeton duvar yapılması", "m²", 450, "18.071.1102"),
  item("i-kapi", "KAPI-90", "Ahşap iç kapı 90x210", "adet", 6000),
  item("i-pen", "PEN-120", "PVC pencere 120x120", "adet", 4000),
  item("i-don", "DON-01", "Nervürlü donatı", "ton", 30000),
  item("i-siva", "SIVA", "İç sıva", "m²", 200),
];

const find = (cls: string, type: string | null = null) => groups.find((g) => g.class === cls && g.type === type)!;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-poz-"));
  const out = path.join(dir, "poz.json");
  await runIfcWorker(path.join(here, "../../fixtures/poz.ifc"), null, 60_000, out);
  index = ModelIndex.of(JSON.parse(readFileSync(out, "utf8")) as IndexFile);
  ({ groups, inexact } = pozGroups(index, new Set(), "tr"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pozGroups", () => {
  it("groups by class · type · material with model quantities and an exact rule", () => {
    expect(groups.map((g) => [g.classLabel, g.type, g.material, g.count])).toEqual([
      ["Döşeme", null, "Beton C30", 2],
      ["Duvar", "Gazbeton Duvar 20", "Gazbeton G2", 2],
      ["Duvar", "Perde 25", "Beton C30", 2],
      ["Kapı", "KP-90", null, 2],
      ["Kiriş", null, "Beton C30", 1],
      ["Kolon", null, "Beton C30", 1],
      ["Korkuluk", null, null, 1],
      ["Pencere", "PN-120", null, 1],
    ]);
    const perde = find("IfcWall", "Perde 25");
    expect(perde.match).toEqual({ classes: ["IfcWall"], property: { key: "Tip", op: "=", value: "Perde 25" } });
    expect(perde.quantities).toEqual({ "m³": { source: "NetVolume", total: 4.8 }, "m²": { source: "NetSideArea", total: 24 }, m: { source: "Length", total: 9 } });
    expect(find("IfcSlab").match).toEqual({ classes: ["IfcSlab"], property: { key: "Malzeme", op: "=", value: "Beton C30" } });
    expect(find("IfcBeam").quantities["m³"]).toEqual({ source: "Volume", total: 0.5 });
    expect(find("IfcColumn").quantities.kg).toEqual({ source: "NetWeight", total: 900 });
    expect(find("IfcRailing").match).toEqual({ classes: ["IfcRailing"] });
    // Every suggested rule selects exactly its group.
    for (const g of groups) expect(matchRule(index, g.match).map((e) => e.guid).sort()).toEqual([...g.guids].sort());
  });

  it("reports groups no single rule can separate, and skips groups an existing rule prices", () => {
    expect(inexact.map((g) => [g.class, g.type, g.count])).toEqual([["IfcWindow", null, 1]]);
    const perde = find("IfcWall", "Perde 25");
    const res = pozGroups(index, new Set([perde.guids[0]!]), "tr");
    expect(res.covered).toBe(1);
    expect(res.groups.some((g) => g.key === perde.key)).toBe(false);
  });

  it("maps units to quantity sources (ton = weight ÷ 1000, adet = count)", () => {
    const col = find("IfcColumn");
    expect(pozQuantityFor("ton", col.quantities, col.count)).toEqual({ quantity: "NetWeight", multiplier: 0.001, total: 900 });
    expect(pozQuantityFor("adet", col.quantities, col.count)).toEqual({ quantity: "count", multiplier: 1, total: 1 });
    expect(pozQuantityFor("m²", col.quantities, col.count)).toBeNull();
  });
});

describe("keyword suggestions", () => {
  it("matches class words, material and preferred unit; computes the amount from the model", () => {
    const pick = (g: PozGroup) => fromKeywords(g, ITEMS, new Set(), "tr");
    const perde = pick(find("IfcWall", "Perde 25"))!;
    expect([perde.costItemId, perde.quantity, perde.amount, perde.source]).toEqual(["i-bet", "NetVolume", 12000, "keywords"]);
    expect(perde.reason).toContain("c30");
    expect(pick(find("IfcWall", "Gazbeton Duvar 20"))).toMatchObject({ costItemId: "i-gaz", quantity: "NetSideArea", amount: 8100 });
    expect(pick(find("IfcSlab"))).toMatchObject({ costItemId: "i-bet", amount: 22250 });
    expect(pick(find("IfcBeam"))).toMatchObject({ costItemId: "i-bet", quantity: "Volume", amount: 1250 });
    expect(pick(find("IfcDoor", "KP-90"))).toMatchObject({ costItemId: "i-kapi", quantity: "count", amount: 12000 });
    expect(pick(find("IfcWindow", "PN-120"))).toMatchObject({ costItemId: "i-pen", amount: 4000 });
    expect(pick(find("IfcRailing"))).toBeNull();
  });

  it("never offers a rejected pair", () => {
    const slab = find("IfcSlab");
    const rejected = new Set([`IfcSlab||betonc30|15150${"1005"}`]);
    expect(fromKeywords(slab, ITEMS, rejected, "tr")).toBeNull();
  });
});

describe("memory", () => {
  const row = (p: Partial<PozMemoryRow>): PozMemoryRow => ({ ifcClass: "IfcWall", typeKey: "", materialKey: "", pozKey: "180711102", decision: "accepted", uses: 1, ...p });

  it("prefers the closest accepted pair and resolves it by poz code in this project's list", () => {
    const gaz = find("IfcWall", "Gazbeton Duvar 20");
    // Another project's list: same poz no under a different item code.
    const items = [item("x-gaz", "D-01", "Gazbeton duvar", "m²", 500, "18.071.1102"), item("x-siva", "S-01", "Sıva", "m²", 100, "27.501")];
    const exact = fromMemory(gaz, [row({ typeKey: "gazbetonduvar20", materialKey: "gazbetong2", uses: 3 }), row({ pozKey: "27501", uses: 9 })], items, new Set(), "tr")!;
    expect([exact.costItemId, exact.source, exact.confidence, exact.amount]).toEqual(["x-gaz", "memory", 0.98, 9000]);
    expect(exact.reason).toContain("3 kez");
    const byType = fromMemory(gaz, [row({ typeKey: "gazbetonduvar20", materialKey: "baska" })], items, new Set(), "tr")!;
    expect(byType.confidence).toBe(0.86);
    const classOnly = fromMemory(gaz, [row({ pozKey: "27501" })], items, new Set(), "tr")!;
    expect([classOnly.costItemId, classOnly.confidence]).toEqual(["x-siva", 0.61]);
    // A pair learned for another type and material does not carry over.
    expect(fromMemory(gaz, [row({ typeKey: "perde25", materialKey: "betonc30" })], items, new Set(), "tr")).toBeNull();
    // Rejected rows and poz codes not in this list are ignored.
    expect(fromMemory(gaz, [row({ typeKey: "gazbetonduvar20", materialKey: "gazbetong2", decision: "rejected" })], items, new Set(), "tr")).toBeNull();
    expect(fromMemory(gaz, [row({ pozKey: "99999" })], items, new Set(), "tr")).toBeNull();
  });
});

describe("AI pick", () => {
  function fakeProvider(answer: (prompt: string) => string): AiProvider & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      id: "fake",
      name: "Fake",
      kind: "openai",
      model: "fake-1",
      external: false,
      prompts,
      async chat(messages) {
        const p = messages.map((m) => ("content" in m ? m.content : "")).join("\n");
        prompts.push(p);
        return { text: answer(p), model: "fake-1" } as Awaited<ReturnType<AiProvider["chat"]>>;
      },
      async embed() {
        return [];
      },
    };
  }

  it("keeps only codes from the group's candidates and computes quantities itself", async () => {
    const provider = fakeProvider((p) => {
      const perde = /(g\d+): Duvar \| tip: Perde 25/.exec(p)![1];
      const door = /(g\d+): Kapı/.exec(p)![1];
      return JSON.stringify({
        suggestions: [
          { group: perde, code: "gaz-20", confidence: 0.95, reason: "Perde duvar örgüsü" },
          { group: door, code: "UYDURMA-1" },
          { group: "g99", code: "BET-C30" },
        ],
      });
    });
    const res = await aiPozPick(provider, groups, ITEMS, new Set(), "tr");
    expect(provider.prompts[0]).toContain("adaylar: BET-C30");
    expect(provider.prompts[0]).not.toContain("Korkuluk");
    expect([...res.suggestions.values()].map((s) => [s.group.type, s.costItemId, s.quantity, s.amount, s.confidence, s.source])).toEqual([
      ["Perde 25", "i-gaz", "NetSideArea", 10800, 0.9, "ai"],
    ]);
    expect(res.suggestions.get(find("IfcWall", "Perde 25").key)!.reason).toBe("Yapay zekâ: Perde duvar örgüsü");
  });

  it("rejects an unreadable answer", async () => {
    await expect(aiPozPick(fakeProvider(() => "bilmiyorum"), groups, ITEMS, new Set(), "tr")).rejects.toBeInstanceOf(ModelAiError);
  });

  it("orders memory before AI before keywords", () => {
    const g = find("IfcSlab");
    const base = fromKeywords(g, ITEMS, new Set(), "tr")!;
    const sorted = sortSuggestions([base, { ...base, source: "memory", confidence: 0.6 }, { ...base, source: "ai", confidence: 0.9 }]);
    expect(sorted.map((s) => s.source)).toEqual(["memory", "ai", "keywords"]);
  });
});
