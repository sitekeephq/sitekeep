/** Metraj envanteri: quantities from base quantity sets, group totals and the version difference. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseQuantityGroupBy } from "@7dimensions-project/sitekeep-ee-cost/shared/quantities.js";
import { runIfcWorker } from "../../../../src/jobs/queue.js";
import type { IndexFile } from "../../../../src/jobs/version-index.js";
import { ModelIndex } from "../../../../src/model/model-index.js";
import { elementDto, inventory, inventoryElements, quantityDiff } from "@7dimensions-project/sitekeep-ee-cost/internal/quantities/inventory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let v1: ModelIndex;
let v2: ModelIndex;

const W1 = "0QtWall000000000000001";
const W2 = "0QtWall000000000000002";
const S1 = "0QtSlab000000000000001";
const S2 = "0QtSlab000000000000002";
const C1 = "0QtColumn0000000000001";
const C2 = "0QtColumn0000000000002";
const B1 = "0QtBeam000000000000001";
const D1 = "0QtDoor000000000000001";
const D2 = "0QtDoor000000000000002";

async function indexOf(fixture: string): Promise<ModelIndex> {
  const out = path.join(dir, `${fixture}.json`);
  await runIfcWorker(path.join(here, "../../../fixtures", fixture), null, 60_000, out);
  return ModelIndex.of(JSON.parse(readFileSync(out, "utf8")) as IndexFile);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-qty-"));
  v1 = await indexOf("quantities.ifc");
  v2 = await indexOf("quantities-v2.ifc");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("element quantities", () => {
  it("reads net and gross from the base quantity set; the opening is gross − net", () => {
    expect(elementDto(v1, W1)).toMatchObject({
      class: "IfcWall",
      classLabel: "Duvar",
      storey: "Zemin Kat",
      material: "Beton C30",
      values: { netVolume: 2.4, grossVolume: 3, grossArea: 15, openingArea: 3, netArea: 12, length: 5, weight: null },
      sources: { netArea: "Qto_WallBaseQuantities.NetSideArea", grossArea: "Qto_WallBaseQuantities.GrossSideArea" },
    });
    expect(elementDto(v1, W2)!.values).toMatchObject({ grossArea: 12, netArea: 12, openingArea: 0 });
    expect(elementDto(v1, S1)!.values).toMatchObject({ grossArea: 25, netArea: 24, openingArea: 1, netVolume: 4.8 });
    expect(elementDto(v1, C1)!.values).toMatchObject({ netVolume: 0.36, length: 3, weight: 900, netArea: null });
  });

  it("falls back to plain Area and to Revit's Dimensions set, and leaves missing values null", () => {
    expect(elementDto(v1, D1)).toMatchObject({ values: { netArea: 1.89, grossArea: null, openingArea: null }, sources: { netArea: "Qto_DoorBaseQuantities.Area" } });
    expect(elementDto(v1, B1)).toMatchObject({ values: { netVolume: 0.5, length: 4 }, sources: { netVolume: "Dimensions.Volume", length: "Dimensions.Length" } });
    const door = elementDto(v1, D2)!;
    expect(Object.values(door.values).every((v) => v === null)).toBe(true);
    expect(elementDto(v1, "missing")).toBeNull();
  });
});

describe("inventory", () => {
  it("totals the version and groups by class and storey, storeys bottom-up", () => {
    const r = inventory(v1, ["class", "storey"]);
    expect(r.totals).toEqual({
      count: 8,
      withQuantities: 7,
      netVolume: 14.56,
      grossVolume: 3,
      grossArea: 52,
      openingArea: 4,
      netArea: 70.39,
      length: 16,
      weight: 900,
    });
    const walls = r.groups.filter((g) => g.class === "IfcWall");
    expect(walls.map((g) => g.label)).toEqual(["Duvar · Zemin Kat", "Duvar · Kat 1"]);
    expect(walls[0]).toMatchObject({ count: 1, netArea: 12, openingArea: 3, guids: [W1] });
    const doors = r.groups.find((g) => g.label === "Kapı · Kat 1")!;
    expect(doors).toMatchObject({ count: 1, withQuantities: 0, netArea: null });
  });

  it("groups by material and type, naming the empty ones", () => {
    const r = inventory(v1, ["material"]);
    expect(r.groups.map((g) => [g.label, g.count])).toEqual([
      ["Beton C30", 6],
      ["Malzemesiz", 2],
    ]);
    expect(inventory(v1, ["material"], "en").groups[1]!.label).toBe("No material");
    expect(inventory(v1, ["class"], "en").groups.map((g) => g.label)).toContain("Wall");
  });

  it("lists the elements of one group", () => {
    const r = inventory(v1, ["class", "storey"]);
    const slabs = r.groups.find((g) => g.label === "Döşeme · Kat 1")!;
    const els = inventoryElements(v1, ["class", "storey"], slabs.key, 100);
    expect(els.total).toBe(1);
    expect(els.elements[0]).toMatchObject({ guid: S2, values: { netArea: 20.5 } });
    expect(inventoryElements(v1, ["class"], null, 3)).toMatchObject({ total: 8 });
    expect(inventoryElements(v1, ["class"], null, 3).elements).toHaveLength(3);
  });

  it("parses the grouping from the query string", () => {
    expect(parseQuantityGroupBy("storey,class,storey,bogus")).toEqual(["storey", "class"]);
    expect(parseQuantityGroupBy("")).toEqual(["class", "storey"]);
    expect(parseQuantityGroupBy("class,storey,type,material")).toEqual(["class", "storey", "type"]);
  });
});

describe("version difference", () => {
  it("finds added, removed and changed quantities by GlobalId", () => {
    const d = quantityDiff(v1, v2, ["class", "storey"]);
    expect(d.totals.delta).toMatchObject({ count: 0, netVolume: -2.34, netArea: -13.5, openingArea: 3, length: -1, weight: 900 });
    expect(d.totals.new.count).toBe(8);

    const byGuid = Object.fromEntries(d.elements.map((e) => [e.guid, e]));
    expect(Object.keys(byGuid).sort()).toEqual([C2, S2, W1, W2].sort());
    expect(byGuid[W1]).toMatchObject({ change: "changed", old: { netArea: 12, openingArea: 3 }, new: { netArea: 9, openingArea: 6 }, delta: { netArea: -3, openingArea: 3, netVolume: -0.6, length: 0 } });
    expect(byGuid[W2]).toMatchObject({ change: "removed", new: null, delta: { netArea: -12, netVolume: -2.4 } });
    expect(byGuid[C2]).toMatchObject({ change: "added", old: null, delta: { netVolume: 0.36, weight: 900 } });
    expect(byGuid[S2]!.delta).toMatchObject({ netArea: 1.5, netVolume: 0.3 });
    expect(d.elementCount).toBe(4);
    expect(d.truncated).toBe(false);
  });

  it("lists only the groups that changed, largest change first", () => {
    const d = quantityDiff(v1, v2, ["class", "storey"]);
    expect(d.groups.map((g) => g.label)).toEqual(["Duvar · Kat 1", "Kolon · Kat 1", "Duvar · Zemin Kat", "Döşeme · Kat 1"]);
    expect(d.unchangedGroups).toBe(5);
    expect(d.groups[0]).toMatchObject({ removed: 1, old: { count: 1, netArea: 12 }, new: { count: 0, netArea: null }, delta: { count: -1, netArea: -12 } });
    expect(d.groups.find((g) => g.label === "Kolon · Kat 1")).toMatchObject({ added: 1, delta: { count: 1, netVolume: 0.36 } });
  });

  it("is empty for the same index", () => {
    const d = quantityDiff(v1, v1, ["class"]);
    expect(d.groups).toEqual([]);
    expect(d.elements).toEqual([]);
    expect(d.totals.delta).toMatchObject({ count: 0, netVolume: 0, netArea: 0 });
  });
});
