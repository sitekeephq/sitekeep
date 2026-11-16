/** IFC version comparison engine (FP-1): GlobalId diff with categories, storeys and shape fingerprints. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeCategory, diffModels } from "../../src/doccompare/model-compare.js";
import { runIfcWorker } from "../../src/jobs/queue.js";
import type { IndexFile } from "../../src/jobs/version-index.js";
import { diffIndexes, shapesOf } from "../../src/model/compare.js";
import { ModelIndex } from "../../src/model/model-index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const V1 = readFileSync(path.join(here, "../fixtures/model-query.ifc"), "utf8");
const V2 = readFileSync(path.join(here, "../fixtures/model-query-v2.ifc"), "utf8");
/** V2 with slab 2 given its own, thicker shape and a larger NetArea. */
const V3 = V2.replace(
  "#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));",
  "#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));\n#70=IFCEXTRUDEDAREASOLID(#63,#13,#11,0.3);\n#71=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#70));\n#72=IFCPRODUCTDEFINITIONSHAPE($,$,(#71));",
)
  .replace("#313=IFCSLAB('0MqSlab000000000000002',#5,'Doseme-02',$,$,#312,#66,$,.FLOOR.);", "#313=IFCSLAB('0MqSlab000000000000002',#5,'Doseme-02',$,$,#312,#72,$,.FLOOR.);")
  .replace("#323=IFCQUANTITYAREA('NetArea',$,$,20.5,$);", "#323=IFCQUANTITYAREA('NetArea',$,$,22.,$);");

let dir: string;
const indexes: Record<string, ModelIndex> = {};

async function index(name: string, ifc: string): Promise<ModelIndex> {
  const input = path.join(dir, `${name}.ifc`);
  const out = path.join(dir, `${name}.index.json`);
  writeFileSync(input, ifc);
  const r = await runIfcWorker(input, null, 120_000, out);
  expect(r.index).toMatchObject({ elementCount: expect.any(Number) });
  return ModelIndex.of(JSON.parse(readFileSync(out, "utf8")) as IndexFile);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-fp1-"));
  indexes.v1 = await index("v1", V1);
  indexes.v2 = await index("v2", V2);
  indexes.v3 = await index("v3", V3);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("IFC comparison engine", () => {
  it("records a shape fingerprint per element; shared shapes give the same one", () => {
    const v1 = indexes.v1!;
    expect(v1.hasGeometry).toBe(true);
    expect(v1.shape("0MqDoor000000000000001")).toBeTruthy();
    expect(v1.shape("0MqDoor000000000000001")).toBe(v1.shape("0MqWall000000000000001"));
    expect(indexes.v3!.shape("0MqSlab000000000000002")).not.toBe(v1.shape("0MqSlab000000000000002"));
  });

  it("lists added, removed and changed elements by GlobalId with categories, classes and storeys", () => {
    const { summary, rows } = diffModels(indexes.v1!, indexes.v2!);
    expect(summary).toMatchObject({ elementsA: 7, elementsB: 7, added: 1, removed: 1, changed: 1, unchanged: 5, detailed: true, geometry: true });
    expect(summary.byClass.IfcDoor).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 2 });
    expect(summary.byClass.IfcWall).toMatchObject({ removed: 1 });
    expect(summary.byClass.IfcColumn).toMatchObject({ added: 1 });
    expect(summary.byStorey).toEqual({ "Zemin Kat": { added: 0, removed: 0, changed: 1 }, "Kat 1": { added: 1, removed: 1, changed: 0 } });
    expect(summary.byCategory).toMatchObject({ property: 1, geometry: 0 });
    expect(rows.map((r) => [r.kind, r.id, r.group, r.subgroup])).toEqual([
      ["added", "0MqColumn0000000000001", "IfcColumn", "Kat 1"],
      ["changed", "0MqDoor000000000000001", "IfcDoor", "Zemin Kat"],
      ["removed", "0MqWall000000000000002", "IfcWall", "Kat 1"],
    ]);
    const door = rows.find((r) => r.id === "0MqDoor000000000000001")!;
    expect(door).toMatchObject({ name: "Kapi-01", aspects: ["property"], changes: [{ prop: "Pset_DoorCommon.FireRating", from: "EI30", to: "EI60" }] });
  });

  it("sees shape and quantity changes that leave the attributes alone", () => {
    const { summary, rows } = diffModels(indexes.v2!, indexes.v3!);
    expect(summary).toMatchObject({ added: 0, removed: 0, changed: 1, unchanged: 6 });
    expect(summary.byCategory).toMatchObject({ quantity: 1, geometry: 1, property: 0 });
    const slab = rows[0]!;
    expect(slab).toMatchObject({ id: "0MqSlab000000000000002", kind: "changed", name: "Doseme-02", subgroup: "Kat 1" });
    expect(slab.aspects.sort()).toEqual(["geometry", "quantity"]);
    expect(slab.changes).toEqual(
      expect.arrayContaining([
        { prop: "Qto_SlabBaseQuantities.NetArea", from: "20.5", to: "22" },
        { prop: "@geometry", from: null, to: null },
      ]),
    );
  });

  it("counts a shape-only change in the viewer's GlobalId diff, but not with an older index", () => {
    const v2 = indexes.v2!;
    const v3 = indexes.v3!;
    // Only the shape: same elements otherwise.
    const shapeOnly = { ...v3.file, elements: { ...v3.file.elements, "0MqSlab000000000000002": v2.file.elements["0MqSlab000000000000002"]! } };
    const d = diffIndexes(v2.file.elements, shapeOnly.elements, shapesOf(v2, ModelIndex.of(shapeOnly)));
    expect(d.changed).toEqual(["0MqSlab000000000000002"]);
    const old = ModelIndex.of({ ...v2.file, geom: undefined, geomV: undefined });
    expect(shapesOf(old, v3)).toBeUndefined();
    expect(diffIndexes(old.file.elements, shapeOnly.elements, shapesOf(old, ModelIndex.of(shapeOnly))).changed).toEqual([]);
    expect(diffModels(old, ModelIndex.of(shapeOnly)).summary.geometry).toBe(false);
  });

  it("sorts property names into categories", () => {
    expect(changeCategory("Qto_WallBaseQuantities.NetSideArea")).toBe("quantity");
    expect(changeCategory("BaseQuantities.Length")).toBe("quantity");
    expect(changeCategory("Pset_WallCommon.FireRating")).toBe("property");
    expect(changeCategory("Attr.Tag")).toBe("attribute");
    expect(changeCategory("@type")).toBe("type");
    expect(changeCategory("@placement")).toBe("placement");
  });
});
