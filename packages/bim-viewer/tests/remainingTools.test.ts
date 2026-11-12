import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { MeasureTool } from "../src/tools/measure";
import { WalkController } from "../src/tools/walk";
import { downloadBlob, recordCanvas } from "../src/tools/sim-paint";
import { useViewerTools } from "../src/react/useViewerTools";
import { ViewerTools } from "../src/tools/tools";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MeasureTool volume", () => {
  it("records the selected elements as a volume measurement", async () => {
    const { engine, highlighter } = makeEngineStub([fakeModel({ id: "arch", guids: { "arch-a": 1 } })]);
    const tool = new MeasureTool(engine);
    highlighter.selection.select = { arch: new Set([1]) };
    expect(tool.measureSelectionVolume()).toBe(true);
    expect(tool.entries().some((entry) => entry.kind === "volume")).toBe(true);
    const saved = await tool.state();
    expect(saved.some((item) => item.kind === "volume" && item.guids.includes("arch-a"))).toBe(true);
    await tool.apply([{ kind: "volume", guids: ["arch-a"], value: 3 }]);
    expect(tool.entries().filter((entry) => entry.kind === "volume")).toHaveLength(1);
    tool.dispose();
  });

  it("asks for a selection when volume is run from the tools rail", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tools = new ViewerTools(engine);
    tools.setMeasureTool("volume");
    expect(tools.state.hint).toMatch(/eleman seçin/);
    tools.dispose();
  });
});

describe("WalkController probes", () => {
  it("reads a floor and a blocking wall from fragment raycasts", async () => {
    const { engine, canvas } = makeEngineStub([fakeModel({ id: "arch" })]);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    });
    (engine.fragments as unknown as { raycast: (data: { camera: THREE.Camera }) => Promise<unknown> }).raycast = vi.fn(async ({ camera }) => {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      if (dir.y < -0.5) {
        return { point: new THREE.Vector3(1, 0, 2), fragments: { modelId: "arch" }, localId: 1 };
      }
      return {
        point: new THREE.Vector3(1, 1, 1),
        localId: 1,
        fragments: {
          modelId: "arch",
          getItemsData: async () => [{ _category: { value: "IFCWALL" } }],
        },
      };
    });
    const walk = new WalkController(engine);
    await walk.start(new THREE.Vector3(1, 1.7, 2));
    await (walk as unknown as { probeFloor(): Promise<void> }).probeFloor();
    await (walk as unknown as { probeWall(): Promise<void> }).probeWall();
    expect((walk as unknown as { floorY: number | null }).floorY).toBeCloseTo(0);
    expect((walk as unknown as { wall: { distance: number } | null }).wall?.distance).toBeGreaterThan(0);
    expect((walk as unknown as { wall: { distance: number } | null }).wall?.distance).not.toBe(Infinity);
    walk.dispose();
  });

  it("treats IFC doors as passable", async () => {
    const { engine, canvas } = makeEngineStub([fakeModel({ id: "arch" })]);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    });
    (engine.fragments as unknown as { raycast: () => Promise<unknown> }).raycast = vi.fn(async () => ({
      point: new THREE.Vector3(1, 1, 1),
      localId: 2,
      fragments: {
        modelId: "arch",
        getItemsData: async () => [{ _category: { value: "IFCDOOR" } }],
      },
    }));
    const walk = new WalkController(engine);
    await walk.start(new THREE.Vector3(1, 1.7, 2));
    await (walk as unknown as { probeWall(): Promise<void> }).probeWall();
    expect((walk as unknown as { wall: { distance: number } | null }).wall?.distance).toBe(Infinity);
    walk.dispose();
  });
});

describe("recordCanvas / downloadBlob", () => {
  it("returns null when the browser cannot record", () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    expect(recordCanvas(engine)).toBeNull();
  });

  it("records chunks and stops the stream", async () => {
    const { engine, canvas } = makeEngineStub([fakeModel({ id: "arch" })]);
    const stopTrack = vi.fn();
    Object.defineProperty(canvas, "captureStream", {
      configurable: true,
      value: () => ({ getTracks: () => [{ stop: stopTrack }] }),
    });
    class FakeRecorder {
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.ondataavailable?.({ data: new Blob(["frame"], { type: "video/webm" }) });
      }
      stop() {
        this.onstop?.();
      }
      static isTypeSupported() {
        return true;
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const rec = recordCanvas(engine);
    expect(rec).toBeTruthy();
    const blob = await rec!.stop();
    expect(blob.type).toMatch(/webm/);
    expect(blob.size).toBeGreaterThan(0);
    expect(stopTrack).toHaveBeenCalled();
  });

  it("clicks a temporary download link", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shot");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    downloadBlob(new Blob(["png"]), "kare.png");
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    revoke.mockRestore();
    create.mockRestore();
    click.mockRestore();
  });
});

describe("useViewerTools", () => {
  it("creates tools, follows model changes and routes phone commands", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const onFit = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ loaded }) => useViewerTools(engine, { loaded, onFit }),
      { initialProps: { loaded: ["arch"] } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.tools).toBeInstanceOf(ViewerTools);
    expect(result.current.state?.nav).toBe("orbit");
    act(() => result.current.command("t:panel:sections"));
    expect(result.current.panel).toBe("sections");
    act(() => result.current.command("t:measure:volume"));
    expect(result.current.state?.hint).toMatch(/eleman seçin/);
    rerender({ loaded: ["arch", "mep"] });
    unmount();
    expect(engine.extras).toBeNull();
  });
});
