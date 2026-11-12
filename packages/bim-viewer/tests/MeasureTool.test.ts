import { describe, expect, it } from "vitest";
import { MeasureTool } from "../src/tools/measure";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

describe("MeasureTool", () => {
  it("activates one kind at a time and lists applied length / area / angle", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch", guids: { v: 1 } })]);
    const tool = new MeasureTool(engine);
    tool.setActive("length");
    expect(tool.active).toBe("length");
    tool.setActive("area");
    expect(tool.active).toBe("area");
    tool.setActive(null);
    expect(tool.active).toBeNull();

    await tool.apply([
      { kind: "length", points: [[0, 0, 0], [3, 0, 4]], value: 5 },
      { kind: "area", points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]], value: 2 },
      { kind: "angle", points: [[1, 0, 0], [0, 0, 0], [0, 0, 1]], value: 90 },
    ]);
    const entries = tool.entries();
    expect(entries.map((e) => e.kind)).toEqual(["length", "area", "angle"]);
    expect(entries[0]?.value).toBeCloseTo(5);
    const saved = await tool.state();
    expect(saved).toHaveLength(3);
    expect(saved[0]).toMatchObject({ kind: "length", value: 5 });
    tool.delete(entries[0]!.key);
    expect(tool.entries()).toHaveLength(2);
    tool.clear();
    expect(tool.entries()).toEqual([]);
    tool.dispose();
  });

  it("does not add a volume without a selection", () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tool = new MeasureTool(engine);
    expect(tool.measureSelectionVolume()).toBe(false);
    tool.dispose();
  });

  it("drops a zero-length length and an empty area (two clicks on one point)", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tool = new MeasureTool(engine);
    await tool.apply([
      { kind: "length", points: [[1, 2, 3], [1, 2, 3]], value: 0 },
      { kind: "length", points: [[0, 0, 0], [0, 0, 0.0005]], value: 0.0005 },
      { kind: "length", points: [[0, 0, 0], [2, 0, 0]], value: 2 },
      { kind: "area", points: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], value: 0 },
      { kind: "area", points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]], value: 2 },
    ]);
    await Promise.resolve();
    expect(tool.entries().map((e) => [e.kind, e.value])).toEqual([
      ["length", 2],
      ["area", 2],
    ]);
    tool.dispose();
  });
});
