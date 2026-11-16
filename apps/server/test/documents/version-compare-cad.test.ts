/** DWG / DXF version comparison engine (FP-1): parsing, pairing by handle or geometry, layers. */
import { describe, expect, it } from "vitest";
import { diffDrawings, parseDxf } from "../../src/doccompare/cad-worker.js";
import { dxf, line, text, type FixtureDrawing } from "./dxf-fixture.js";

const layers = [
  { name: "0" },
  { name: "WALL", color: 7 },
  { name: "DOOR", color: 3 },
  { name: "TEXT", color: 2 },
];

const v1: FixtureDrawing = {
  layers,
  entities: [
    line("1A", "WALL", 0, 0, 10, 0),
    line("1B", "WALL", 0, 0, 0, 10),
    text("1C", "TEXT", "KOLON S12 40x60", 5, 5),
    { type: "CIRCLE", handle: "1D", layer: "DOOR", codes: [[10, 3], [20, 3], [30, 0], [40, 0.45]] },
    line("1E", "WALL", 10, 0, 10, 10),
    line("1F0", "WALL", 0, 10, 10, 10),
  ],
};

const v2: FixtureDrawing = {
  layers: [{ name: "0" }, { name: "WALL", color: 1 }, { name: "DOOR", color: 3, flags: 1 }, { name: "TEXT", color: 2 }, { name: "NEW", color: 5 }],
  entities: [
    line("1A", "WALL", 0, 0, 12, 0),
    line("1B", "DOOR", 0, 0, 0, 10),
    text("1C", "TEXT", "KOLON S12 50x60", 5, 5),
    line("1E", "WALL", 10, 0, 10, 10, [[62, 1]]),
    line("1F0", "WALL", 0, 10, 10, 10),
    { type: "ARC", handle: "20", layer: "NEW", codes: [[10, 1], [20, 1], [30, 0], [40, 2], [50, 0], [51, 90]] },
  ],
};

describe("DWG comparison engine", () => {
  it("reads layers and entities of a DXF", () => {
    const d = parseDxf(dxf(v1));
    expect(d.entities.map((e) => [e.h, e.t, e.l])).toEqual([
      ["1A", "LINE", "WALL"],
      ["1B", "LINE", "WALL"],
      ["1C", "TEXT", "TEXT"],
      ["1D", "CIRCLE", "DOOR"],
      ["1E", "LINE", "WALL"],
      ["1F0", "LINE", "WALL"],
    ]);
    expect(d.entities[2]!.text).toBe("KOLON S12 40x60");
    expect(d.layers.get("WALL")).toMatchObject({ color: "7", frozen: false, off: false, linetype: "CONTINUOUS" });
  });

  it("pairs entities by handle: geometry, layer, text and style changes, added and removed per layer", () => {
    const { summary, rows } = diffDrawings(parseDxf(dxf(v1)), parseDxf(dxf(v2)));
    expect(summary).toMatchObject({ matchedBy: "handle", entitiesA: 6, entitiesB: 6, added: 1, removed: 1, changed: 4, unchanged: 1 });
    expect(summary.byAspect).toEqual({ layer: 1, geometry: 1, text: 1, style: 1 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["1A"]).toMatchObject({ kind: "changed", group: "WALL", subgroup: "LINE", aspects: ["geometry"] });
    expect(byId["1B"]).toMatchObject({ kind: "changed", group: "DOOR", aspects: ["layer"], changes: [{ prop: "@layer", from: "WALL", to: "DOOR" }] });
    expect(byId["1C"]).toMatchObject({ kind: "changed", aspects: ["text"], changes: [{ prop: "@text", from: "KOLON S12 40x60", to: "KOLON S12 50x60" }] });
    expect(byId["1E"]).toMatchObject({ kind: "changed", aspects: ["style"], changes: [{ prop: "@color", from: "256", to: "1" }] });
    expect(byId["1D"]).toMatchObject({ kind: "removed", group: "DOOR", subgroup: "CIRCLE" });
    expect(byId["20"]).toMatchObject({ kind: "added", group: "NEW", subgroup: "ARC" });
    expect(byId["1F0"]).toBeUndefined();

    const layer = (name: string) => summary.layers.find((l) => l.layer === name)!;
    expect(layer("WALL")).toMatchObject({ status: "changed", entitiesA: 4, entitiesB: 3, changed: 2, props: [{ prop: "color", from: "7", to: "1" }] });
    expect(layer("WALL").types).toEqual({ LINE: [4, 3] });
    expect(layer("DOOR")).toMatchObject({ status: "changed", removed: 1, changed: 1, props: [{ prop: "frozen", from: "false", to: "true" }] });
    expect(layer("NEW")).toMatchObject({ status: "added", added: 1, entitiesB: 1 });
    expect(layer("0").status).toBe("same");
    // Layers with differences come first.
    expect(summary.layers.at(-1)!.layer).toBe("0");
  });

  it("finds no differences in a re-saved drawing (owners and float noise do not count)", () => {
    const resaved = dxf(v1).replace(/330\r\n1F/g, "330\r\n2A").replace("10\r\n10\r\n", "10\r\n10.0000000001\r\n");
    const { summary, rows } = diffDrawings(parseDxf(dxf(v1)), parseDxf(resaved));
    expect(summary).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 6, matchedBy: "handle" });
    expect(rows).toEqual([]);
    expect(summary.layers.every((l) => l.status === "same")).toBe(true);
  });

  it("matches by geometry when the drawing was re-created with new handles", () => {
    const recreated: FixtureDrawing = {
      layers,
      entities: [
        line("5001", "WALL", 0, 0, 10, 0),
        line("5002", "WALL", 0, 0, 0, 10),
        text("5003", "TEXT", "KOLON S12 40x60", 5, 5),
        // The circle moved to another layer, one line is gone, a text is new.
        { type: "CIRCLE", handle: "5004", layer: "WALL", codes: [[10, 3], [20, 3], [30, 0], [40, 0.45]] },
        line("5005", "WALL", 10, 0, 10, 10),
        text("5006", "TEXT", "NOT 4"),
      ],
    };
    const { summary, rows } = diffDrawings(parseDxf(dxf(v1)), parseDxf(dxf(recreated)));
    expect(summary).toMatchObject({ matchedBy: "geometry", unchanged: 4, changed: 1, added: 1, removed: 1 });
    expect(rows.find((r) => r.kind === "changed")).toMatchObject({ id: "5004", aspects: ["layer"], changes: [{ prop: "@layer", from: "DOOR", to: "WALL" }] });
    expect(rows.find((r) => r.kind === "added")).toMatchObject({ id: "5006", name: "NOT 4" });
    expect(rows.find((r) => r.kind === "removed")).toMatchObject({ id: "1F0", subgroup: "LINE" });
  });

  it("matches by geometry when the writer left handles out", () => {
    const noHandles = (d: FixtureDrawing): FixtureDrawing => ({ ...d, entities: d.entities.map((e) => ({ ...e, handle: undefined })) });
    const { summary, rows } = diffDrawings(parseDxf(dxf(noHandles(v1))), parseDxf(dxf(noHandles(v2))));
    expect(summary.matchedBy).toBe("geometry");
    // Without identity the 1A geometry change is a removed + added line; layer, text and style changes still pair.
    expect(summary).toMatchObject({ unchanged: 1, changed: 3 });
    expect(rows.filter((r) => r.kind === "changed").flatMap((r) => r.aspects).sort()).toEqual(["layer", "style", "text"]);
    expect(rows.every((r) => r.id.startsWith("#"))).toBe(true);
  });

  it("sees a changed block definition through its INSERTs and polyline vertices through the polyline", () => {
    const drawing = (doorWidth: number, vertexY: number): FixtureDrawing => ({
      layers,
      blocks: [{ name: "DOOR90", entities: [line(undefined, "0", 0, 0, doorWidth, 0)] }],
      entities: [
        { type: "INSERT", handle: "30", layer: "DOOR", codes: [[2, "DOOR90"], [10, 4], [20, 0], [30, 0]] },
        {
          type: "POLYLINE",
          handle: "31",
          layer: "WALL",
          codes: [[66, 1], [70, 0]],
          subs: [
            { type: "VERTEX", handle: "32", layer: "WALL", codes: [[10, 0], [20, 0], [30, 0]] },
            { type: "VERTEX", handle: "33", layer: "WALL", codes: [[10, 5], [20, vertexY], [30, 0]] },
            { type: "SEQEND", handle: "34", layer: "WALL" },
          ],
        },
      ],
    });
    const same = diffDrawings(parseDxf(dxf(drawing(0.9, 0))), parseDxf(dxf(drawing(0.9, 0))));
    expect(same.summary).toMatchObject({ changed: 0, unchanged: 2 });
    const { summary, rows } = diffDrawings(parseDxf(dxf(drawing(0.9, 0))), parseDxf(dxf(drawing(1.0, 2))));
    expect(summary).toMatchObject({ entitiesA: 2, entitiesB: 2, changed: 2, added: 0, removed: 0 });
    expect(rows.map((r) => [r.id, r.subgroup, r.name, r.aspects])).toEqual([
      ["30", "INSERT", "DOOR90", ["geometry"]],
      ["31", "POLYLINE", null, ["geometry"]],
    ]);
  });

  it("keeps only the first rows of a huge list (the counts stay exact)", () => {
    const many = (n: number, dx: number): FixtureDrawing => ({ layers, entities: Array.from({ length: n }, (_, i) => line(String(100 + i), "WALL", i, 0, i + dx, 0)) });
    const { summary, rows } = diffDrawings(parseDxf(dxf(many(30, 1))), parseDxf(dxf(many(30, 2))), 10);
    expect(summary).toMatchObject({ changed: 30, truncated: true });
    expect(rows).toHaveLength(10);
  });
});
