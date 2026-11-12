import { describe, expect, it } from "vitest";
import { GuidCache, clearSim, costBin, paintCost, paintSim } from "../src/tools/sim-paint";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

describe("GuidCache and sim painting", () => {
  it("resolves GlobalIds once per model", async () => {
    const model = fakeModel({ id: "arch", guids: { a: 1, b: 2 }, localIds: [1, 2, 3] });
    const cache = new GuidCache();
    await expect(cache.ids("arch", model, ["a", "missing", "b"])).resolves.toEqual([1, 2]);
    await expect(cache.ids("arch", model, ["a"])).resolves.toEqual([1]);
    await expect(cache.allIds("arch", model)).resolves.toEqual([1, 2, 3]);
  });

  it("hides only the elements that have not started, then reveals the ones that start", async () => {
    const model = fakeModel({ id: "arch", guids: { a: 1, b: 2, c: 3 }, localIds: [1, 2, 3] });
    const seen: { ids: number[] | undefined; visible: boolean }[] = [];
    model.setVisible = async (ids?: Iterable<number>, visible?: boolean) => {
      seen.push({ ids: ids ? [...ids] : undefined, visible: !!visible });
    };
    const { engine, hider } = makeEngineStub([model]);
    const shownAll: boolean[] = [];
    hider.set = async (visible?: boolean, map?: unknown) => {
      if (map === undefined && visible !== undefined) shownAll.push(visible);
    };
    const cache = new GuidCache();
    const frame = {
      hideNotStarted: true,
      late: [] as string[],
      inProgress: new Map<number, string[]>(),
      fadeUnlinked: false,
      linked: new Set(["a", "b", "c"]),
    };
    await paintSim(engine, cache, { ...frame, notStarted: ["b", "c"] });
    expect(shownAll).toEqual([]);
    expect(seen).toEqual([{ ids: [2, 3], visible: false }]);
    seen.length = 0;
    await paintSim(engine, cache, { ...frame, notStarted: ["c"], inProgress: new Map([[0, ["b"]]]) });
    expect(shownAll).toEqual([]);
    expect(seen).toEqual([{ ids: [2], visible: true }]);
    await clearSim(engine);
    seen.length = 0;
    await paintSim(engine, cache, { ...frame, notStarted: ["a", "b", "c"] });
    expect(seen).toEqual([{ ids: [1, 2, 3], visible: false }]);
  });

  it("paints a playback frame and a cost heat map", async () => {
    const model = fakeModel({ id: "arch", guids: { a: 1, b: 2, c: 3 }, localIds: [1, 2, 3] });
    const { engine } = makeEngineStub([model]);
    const cache = new GuidCache();
    await paintSim(engine, cache, {
      notStarted: ["c"],
      hideNotStarted: true,
      late: ["b"],
      inProgress: new Map([[0, ["a"]]]),
      fadeUnlinked: true,
      linked: new Set(["a", "b"]),
    });
    await paintCost(
      engine,
      cache,
      new Map([["arch", { elements: { a: 4, b: 16 }, max: 16 }]]),
    );
    await clearSim(engine);
  });

  it("bins cost on a square-root scale", () => {
    expect(costBin(0, 100)).toBe(0);
    expect(costBin(100, 100)).toBe(5);
    expect(costBin(25, 100)).toBe(3);
  });
});
