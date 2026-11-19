/**
 * Core-side test (copy to sitekeep apps/server/test/modules/cost/quantities/ with the pin that
 * brings this version): the inventory fills volume and area from the mesh the core measured.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIfcWorker } from "../../../../src/jobs/queue.js";
import type { IndexFile } from "../../../../src/jobs/version-index.js";
import { ModelIndex } from "../../../../src/model/model-index.js";
import { elementDto, inventory, quantityDiff } from "@sitekeephq/sitekeep-ee-cost/internal/quantities/inventory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let file: IndexFile;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-meshinv-"));
  const out = path.join(dir, "index.json");
  await runIfcWorker(path.join(here, "../../../fixtures/mesh-quantities.ifc"), null, 60_000, out);
  file = JSON.parse(readFileSync(out, "utf8")) as IndexFile;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("inventory with quantities from the mesh", () => {
  it("fills volume and area of elements without base quantities, marked as from geometry", () => {
    const idx = ModelIndex.of(file);
    const w = elementDto(idx, "0MqWall000000000000002")!;
    expect(w.values.netVolume).toBeCloseTo(3.9, 3);
    expect(w.values.netArea).toBeCloseTo(13, 3);
    // The opening is measured too: gross = net (mesh) + opening.
    expect(w.sources).toMatchObject({ netVolume: "geometry:mesh", netArea: "geometry:mesh", grossArea: "geometry:netPlusOpenings" });
    expect(w.values.grossArea).toBeCloseTo(15, 2);
    // A volume in the base quantities: the element stays as exported.
    const partial = elementDto(idx, "0MqWall000000000000003")!;
    expect(partial.sources).toEqual({ netVolume: "Qto_WallBaseQuantities.NetVolume" });
    expect(elementDto(idx, "0MqColu000000000000001")!.sources).toEqual({ netVolume: "Qto_ColumnBaseQuantities.NetVolume", netArea: "Qto_ColumnBaseQuantities.NetArea" });
    const inv = inventory(idx, ["class"]);
    expect(inv.totals).toMatchObject({ count: 5, withQuantities: 5, fromMesh: 3 });
    expect(inv.totals.netVolume).toBeCloseTo(4.5 + 3.9 + 4.4 + 4 + 1, 2);
  });

  it("compares with mesh values only when both indexes have them", () => {
    const idx = ModelIndex.of(file);
    const { meshQ: _q, meshQV: _v, ...older } = file;
    const d = quantityDiff(ModelIndex.of(older as IndexFile), idx, ["class"]);
    expect(d.elementCount).toBe(0);
    expect(d.groups).toEqual([]);
  });
});
