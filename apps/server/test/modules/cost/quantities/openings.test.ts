/** Openings deducted from IFC geometry (docs/features/QUANTITIES.md "Boşluklar"): worker output and inventory numbers. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIfcWorker } from "../../../../src/jobs/queue.js";
import { OPENINGS_FORMAT, type IndexFile } from "../../../../src/jobs/version-index.js";
import { ModelIndex } from "../../../../src/model/model-index.js";
import { elementDto, elementQuantities, inventory, inventoryElements, quantityDiff } from "@7dimensions-project/sitekeep-ee-cost/internal/quantities/inventory.js";
import { pozGroups } from "@7dimensions-project/sitekeep-ee-cost/internal/fived/poz.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let file: IndexFile;
let idx: ModelIndex;
let old: ModelIndex;

const WA = "0OpWall000000000000001";
const WB = "0OpWall000000000000002";
const WC = "0OpWall000000000000003";
const SA = "0OpSlab000000000000001";

async function indexFile(fixture: string): Promise<IndexFile> {
  const out = path.join(dir, `${fixture}.json`);
  await runIfcWorker(path.join(here, "../../../fixtures", fixture), null, 60_000, out);
  return JSON.parse(readFileSync(out, "utf8")) as IndexFile;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-open-"));
  file = await indexFile("openings.ifc");
  idx = ModelIndex.of(file);
  // The same model indexed before openings were read (no units, no openings).
  const { units: _u, openings: _o, openingsV: _v, ...older } = file;
  old = ModelIndex.of(older as IndexFile);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("worker", () => {
  it("writes the model's units and every opening with its filling and solids in metres", () => {
    expect(file.units).toEqual({ length: 0.001, area: 1, volume: 1 });
    expect(file.openingsV).toBe(OPENINGS_FORMAT);
    expect(idx.hasOpenings).toBe(true);
    expect(file.openings![WA]).toEqual([
      ["0OpOpen000000000000001", "0OpDoor000000000000001", [[1.89, 0.9, 2.1, 0.3]]],
      ["0OpOpen000000000000002", "0OpWind000000000000001", [[0.48, 1.2, 0.4, 1.5]]],
    ]);
    expect(file.openings![WB]![0]![2]![0]![0]).toBeCloseTo(Math.PI * 0.09, 5);
    expect(file.openings![SA]).toEqual([
      ["0OpOpen000000000000004", null, [[1.5, 1, 1.5, 0.3]]],
      ["0OpOpen000000000000005", null, []],
    ]);
    expect(file.openings![WC]).toBeUndefined();
  });
});

describe("inventory with geometric openings", () => {
  it("deducts door and Revit-style window openings the exporter left in", () => {
    const w = elementDto(idx, WA)!;
    expect(w.values).toMatchObject({ grossArea: 15, openingArea: 3.69, netArea: 11.31, grossVolume: 4.5, netVolume: 3.393, length: 5 });
    expect(w.sources).toMatchObject({ openingArea: "geometry:openings", netArea: "geometry:grossMinusOpenings", netVolume: "geometry:grossVolumeMinusOpenings" });
    expect(w.openings).toEqual({ count: 2, measured: 2, area: 3.69, volume: 1.107, modelArea: 0, fillers: ["Kapi-A", "Pencere-A"] });
  });

  it("adds the openings to a net-only area (Revit Dimensions) to get the gross", () => {
    const w = elementDto(idx, WB)!;
    expect(w.values).toMatchObject({ netArea: 10, grossArea: 10.283, openingArea: 0.283 });
    expect(w.sources).toMatchObject({ netArea: "Dimensions.Area", grossArea: "geometry:netPlusOpenings" });
    expect(w.openings).toMatchObject({ count: 1, measured: 1, modelArea: null, fillers: [] });
  });

  it("prefers the geometry over the model's gross − net and keeps an unmeasurable opening visible", () => {
    const s = elementDto(idx, SA)!;
    expect(s.values).toMatchObject({ grossArea: 25, netArea: 23.5, openingArea: 1.5, netVolume: 4.8 });
    expect(s.sources.netVolume).toBe("Qto_SlabBaseQuantities.NetVolume");
    expect(s.openings).toMatchObject({ count: 2, measured: 1, area: 1.5, modelArea: 1 });
  });

  it("converts mm quantities and leaves hosts without openings as the model gives them", () => {
    const w = elementDto(idx, WC)!;
    expect(w.values).toMatchObject({ length: 2, grossArea: 6, netArea: 6, openingArea: 0 });
    expect(w.openings).toBeNull();
  });

  it("summarises openings for the inventory", () => {
    const r = inventory(idx, ["class"]);
    expect(r.openings).toEqual({ source: "geometry", hosts: 3, openings: 5, unmeasured: 1, area: 5.473, differs: 2 });
    const walls = r.groups.find((g) => g.class === "IfcWall")!;
    expect(walls).toMatchObject({ netArea: 27.31, openingArea: 3.973, grossArea: 31.283 });
    expect(inventoryElements(idx, ["class"], walls.key, 10).elements.find((e) => e.guid === WA)!.openings!.count).toBe(2);
  });

  it("falls back to the model's gross − net for an index without openings", () => {
    expect(old.hasOpenings).toBe(false);
    expect(elementDto(old, WA)!.values).toMatchObject({ grossArea: 15, netArea: 15, openingArea: 0, netVolume: null, length: 5000 });
    expect(elementDto(old, WA)!.openings).toBeNull();
    expect(inventory(old, ["class"]).openings).toMatchObject({ source: "model", hosts: 0 });
  });
});

describe("other consumers", () => {
  it("does not report a re-indexed version as a quantity change", () => {
    const d = quantityDiff(old, idx, ["class"]);
    expect(d.elementCount).toBe(0);
    expect(quantityDiff(idx, idx, ["class"]).elementCount).toBe(0);
  });

  it("keeps poz suggestions on the exported property values", () => {
    const raw = elementQuantities(idx, idx.element(WA)!, { geometry: false });
    expect(raw.values).toMatchObject({ netArea: 15, length: 5000 });
    expect(raw.openings).toBeNull();
    const poz = pozGroups(idx, new Set());
    expect([...poz.groups, ...poz.inexact].some((g) => g.class === "IfcWall")).toBe(true);
    expect(JSON.stringify(poz)).not.toContain("geometry");
  });
});
