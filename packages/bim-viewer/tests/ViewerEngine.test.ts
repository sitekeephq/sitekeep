import { LodMode } from "@thatopen/fragments";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { CLASH_COLORS, COMPARE_COLORS, FOURD_COLORS, cssColor } from "../src/core/ViewerEngine";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

// Stubbed fetch must not leak into the next test when an assertion fails.
afterEach(() => vi.unstubAllGlobals());

describe("cssColor / palette tokens", () => {
  it("falls back when the token is missing", () => {
    expect(cssColor("--missing-token", "#3b6fb5")).toBe("#3b6fb5");
  });

  it("keeps clash / compare / 4D colours stable", () => {
    expect(CLASH_COLORS).toEqual({ a: "#d92d20", b: "#2e90fa" });
    expect(COMPARE_COLORS.added).toBe("#12b76a");
    expect(FOURD_COLORS.late).toBe("#d92d20");
  });
});

describe("ViewerEngine federation and queries", () => {
  it("aligns later models onto the first model's import offset", async () => {
    const arch = fakeModel({ id: "arch", offset: [100, 0, 40] });
    const mep = fakeModel({ id: "mep", offset: [130, 0, 40] });
    const { engine } = makeEngineStub([arch, mep]);
    await engine.align("arch");
    await engine.align("mep");
    expect(mep.object.position.toArray()).toEqual([-30, 0, 0]);
    await engine.align("mep");
    expect(mep.object.position.toArray()).toEqual([-30, 0, 0]);
  });

  it("maps IFC world points (Z up) into the model scene", async () => {
    const arch = fakeModel({ id: "arch", offset: [10, 2, 4] });
    const { engine } = makeEngineStub([arch]);
    const p = await engine.ifcToScene([1, 3, 5], "arch");
    expect(p?.toArray()).toEqual([11, 7, 1]);
    expect(await engine.ifcToScene([0, 0, 0], "missing")).toBeNull();
  });

  it("selects and focuses GlobalIds across federated models", async () => {
    const arch = fakeModel({ id: "arch", guids: { "guid-a": 11 } });
    const mep = fakeModel({ id: "mep", guids: { "guid-b": 22 } });
    const { engine, highlighter } = makeEngineStub([arch, mep]);
    expect(await engine.focusGuid("guid-b", ["arch", "mep"])).toBe(true);
    expect(await engine.selectGuids(["guid-a", "guid-b"], false)).toBe(2);
    expect(highlighter.selection.select).toBeTruthy();
    highlighter.selection.select = { arch: new Set([11]) };
    await expect(engine.selectedGuids()).resolves.toEqual([{ modelId: "arch", guids: ["guid-a"] }]);
  });

  it("paints comparison, 4D and clash colours from GlobalIds", async () => {
    const neu = fakeModel({ id: "new", guids: { add: 1, chg: 2, keep: 3 }, localIds: [1, 2, 3] });
    const alt = fakeModel({ id: "old", guids: { rem: 4, ghost: 5 }, localIds: [4, 5] });
    const { engine } = makeEngineStub([neu, alt]);
    await expect(
      engine.showComparison({
        newModelId: "new",
        added: ["add"],
        changed: ["chg"],
        fadeUnchanged: true,
        oldModelId: "old",
        removed: ["rem"],
      }),
    ).resolves.toEqual({ added: 1, changed: 1, removed: 1 });
    await expect(
      engine.show4D({ not_started: ["keep"], in_progress: ["add"], complete: ["chg"], late: [] }, true),
    ).resolves.toMatchObject({ in_progress: 1, complete: 1 });
    await expect(
      engine.showClash({ a: { modelId: "new", globalId: "add" }, b: { modelId: "old", globalId: "rem" } }),
    ).resolves.toBe(true);
    await expect(
      engine.showClash({ a: { modelId: "new", globalId: "nope" }, b: { modelId: "old", globalId: "nope" } }),
    ).resolves.toBe(false);
  });

  it("applies hide / isolate / color view rules per file", async () => {
    const model = fakeModel({ id: "arch", classes: { IfcWall: [1, 2] }, localIds: [1, 2, 3] });
    const { engine } = makeEngineStub([model]);
    const setVisible = vi.spyOn(model, "setVisible");
    const setColor = vi.spyOn(model, "setColor");
    await engine.applyRules([{ classes: ["IfcWall"], action: "hide" }], { arch: "file-1" });
    expect(setVisible).toHaveBeenCalledWith([1, 2], false);
    await engine.applyRules(
      [{ classes: ["IfcWall"], action: "color", color: "#ff0000", fileIds: ["file-1"] }],
      { arch: "file-1" },
    );
    expect(setColor).toHaveBeenCalled();
    await engine.clearRules();
  });

  it("loads a buffer once, unloads it, and draws pins", async () => {
    const { engine } = makeEngineStub([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })),
    );
    await engine.load("m1", "/models/a.frag");
    expect(engine.loadedIds).toEqual(["m1"]);
    expect(engine.fragments.list.get("m1")!.setLodMode).toHaveBeenCalledWith(LodMode.ALL_GEOMETRY);
    expect(engine.fragments.core.settings.graphicsQuality).toBeCloseTo(4 / 3);
    await engine.load("m1", "/models/a.frag");
    expect(engine.loadedIds).toEqual(["m1"]);
    engine.setPins([{ position: [1, 2, 3], color: "#f00" }]);
    expect(engine["pins"].children).toHaveLength(1);
    await engine.unload("m1");
    expect(engine.loadedIds).toEqual([]);
  });

  it("keeps the ground grid under the lowest model so it does not cut the ±0.00 slab", async () => {
    const slab = fakeModel({ id: "slab", box: new THREE.Box3(new THREE.Vector3(-5, -0.3, -5), new THREE.Vector3(5, 0.2, 5)) });
    const { engine, grid } = makeEngineStub([slab]);
    engine["placeGrid"]();
    expect(grid.three.position.y).toBeCloseTo(-0.4);
    const raised = fakeModel({ id: "raised", box: new THREE.Box3(new THREE.Vector3(0, 30, 0), new THREE.Vector3(1, 31, 1)) });
    const { engine: other, grid: otherGrid } = makeEngineStub([raised]);
    other["placeGrid"]();
    expect(otherGrid.three.position.y).toBe(0);
    await engine.unload("slab");
    expect(grid.three.position.y).toBe(0);
  });

  it("turns the worker's string rejection of a broken file into an Error", async () => {
    const { engine } = makeEngineStub([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })));
    (engine.fragments.core as unknown as { load: () => Promise<void> }).load = () => Promise.reject("Error: Fragments: Malformed fragments data!");
    await expect(engine.load("x", "/broken.frag")).rejects.toThrow("Model okunamadı: Fragments: Malformed fragments data!");
    expect(engine.loadedIds).toEqual([]);
  });

  it("rejects a missing model file", async () => {
    const { engine } = makeEngineStub([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(engine.load("x", "/no.frag")).rejects.toThrow(/HTTP 404/);
  });

  it("applies a viewpoint: extras, camera, selection and BCF lines", async () => {
    const model = fakeModel({ id: "arch", guids: { sel: 9 } });
    const { engine, camera } = makeEngineStub([model]);
    const setLookAt = vi.spyOn(camera.controls, "setLookAt");
    const extras = { apply: vi.fn(async () => undefined), save: vi.fn(async () => ({})), dispose: () => undefined };
    engine.extras = extras;
    await engine.applyViewpoint({
      camera: { position: [0, 10, 0], target: [0, 0, 0], projection: "perspective", up: [0, 0, 1] },
      fileVersionIds: ["arch"],
      selection: ["sel"],
      lines: [
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
      ],
      coloring: [{ color: "80ff0000", guids: ["sel"] }],
    });
    expect(extras.apply).toHaveBeenCalled();
    // Straight down with an image "up": the eye moves a hair against it (camera-controls cannot roll).
    expect(setLookAt).toHaveBeenCalledOnce();
    const [px, py, pz, tx, ty, tz, smooth] = setLookAt.mock.calls[0] as unknown as [number, number, number, number, number, number, boolean];
    expect([tx, ty, tz]).toEqual([0, 0, 0]);
    expect(py).toBe(10);
    expect(Math.hypot(px, pz)).toBeCloseTo(0.01, 6);
    expect(smooth).toBe(false);
    expect(engine["bcfLines"].children.length).toBeGreaterThan(0);
    const cam = engine.cameraState();
    expect(cam.projection).toBe("perspective");
    await engine.setCamera({ position: [1, 2, 3], target: [0, 0, 0] });
  });
});
