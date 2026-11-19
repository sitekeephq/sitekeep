/** Volume and area measured from the triangle mesh for elements without base quantities (docs/features/QUANTITIES.md). */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIfcWorker } from "../../src/jobs/queue.js";
import { MESH_QUANTITIES_FORMAT, type IndexFile } from "../../src/jobs/version-index.js";
import { ModelIndex } from "../../src/model/model-index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
let file: IndexFile;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-meshq-"));
  const out = path.join(dir, "index.json");
  await runIfcWorker(path.join(here, "../fixtures/mesh-quantities.ifc"), null, 60_000, out);
  file = JSON.parse(readFileSync(out, "utf8")) as IndexFile;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("mesh quantities in the element index", () => {
  it("measures elements without quantity sets in m³ and m² (model in mm)", () => {
    expect(file.meshQV).toBe(MESH_QUANTITIES_FORMAT);
    const idx = ModelIndex.of(file);
    expect(idx.hasMeshQuantities).toBe(true);
    const wall = idx.meshQuantities("0MqWall000000000000001")!;
    expect(wall.volume).toBeCloseTo(4.5, 3);
    expect(wall.area).toBeCloseTo(15, 3); // one side face
    const slab = idx.meshQuantities("0MqSlab000000000000001")!;
    expect(slab.volume).toBeCloseTo(4, 3);
    expect(slab.area).toBeCloseTo(20, 3); // plan area
  });

  it("measures the net solid: the opening is cut out, its reveals do not count", () => {
    const wall = ModelIndex.of(file).meshQuantities("0MqWall000000000000002")!;
    expect(wall.volume).toBeCloseTo(3.9, 3);
    expect(wall.area).toBeCloseTo(13, 3);
  });

  it("leaves elements whose sets have a volume or an area as exported", () => {
    const idx = ModelIndex.of(file);
    expect(idx.meshQuantities("0MqWall000000000000003")).toBeNull();
    expect(idx.meshQuantities("0MqColu000000000000001")).toBeNull();
  });

  it("reads as absent from an older index", () => {
    const { meshQ: _q, meshQV: _v, ...older } = file;
    const idx = ModelIndex.of(older as IndexFile);
    expect(idx.hasMeshQuantities).toBe(false);
    expect(idx.meshQuantities("0MqWall000000000000001")).toBeNull();
  });
});
