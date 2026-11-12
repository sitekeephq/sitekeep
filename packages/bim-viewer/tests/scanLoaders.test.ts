import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { loadGuzergahMesh, sleeperMeshLayout, extractTrackPath, fitCameraToRail } from "../src/scan/layers/ifcMesh";
import { loadLasPreview, LAS_RENDER_POINT_BUDGET } from "../src/scan/layers/pointCloud";
import { applyTrackHeatmap } from "../src/scan/layers/trackHeatmap";
import { applyScanSelectionColor, scanElementFromHit } from "../src/scan/selection/scanSelection";
import {
  installScanWheelZoom,
  scanDollyPickRef,
  scanViewerDomRef,
  tuneScanNavigation,
} from "../src/scan/navigation/scanNavigation";
import { createScanLayers, type ScanLayerHost } from "../src/scan/createScanLayers";
import type { IotSensor } from "../src/scan/types";
import { configureScanAssets } from "../src/scan/assets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureScanAssets();
});

function sleeperMesh(count = 12) {
  const vertsPer = 8;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * vertsPer * 3);
  for (let s = 0; s < count; s++) {
    for (let v = 0; v < vertsPer; v++) {
      const i = (s * vertsPer + v) * 3;
      positions[i] = s;
      positions[i + 1] = 0;
      positions[i + 2] = v * 0.1;
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
  mesh.name = "guzergah-sleepers";
  return mesh;
}

function sensor(over: Partial<IotSensor> = {}): IotSensor {
  return {
    id: "s1",
    name: "A",
    groupName: "hat",
    channel: "cant",
    channelLabel: "Cant",
    unit: "mm",
    value: 2,
    status: "ok",
    position: [0, 1, 0],
    timestamps: [],
    series: [],
    ...over,
  };
}

describe("LAS / güzergah loaders", () => {
  it("builds a LAS preview from preview.json + preview.bin", async () => {
    const meta = {
      source: "line.las",
      count: 2,
      origin: [0, 0, 0],
      bbox: { min: [0, 0, 0], max: [2, 1, 2] },
    };
    const bin = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("preview.json")) return new Response(JSON.stringify(meta));
        if (String(url).endsWith("preview.bin")) return new Response(bin.buffer);
        return new Response(null, { status: 404 });
      }),
    );
    const points = await loadLasPreview();
    expect(points).toBeInstanceOf(THREE.Points);
    expect(points?.name).toBe("las-preview");
    expect((points!.geometry.getAttribute("position") as THREE.BufferAttribute).count).toBe(2);
    expect(LAS_RENDER_POINT_BUDGET).toBeGreaterThan(2);
  });

  it("returns null when LAS meta is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(loadLasPreview()).resolves.toBeNull();
  });

  it("assembles a güzergah group from mesh parts", async () => {
    const meta = {
      source: "guzergah.ifc",
      counts: { sleepers: 1, rails: 1 },
      parts: {
        sleepers: { file: "sleepers.bin", triangles: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
        rails: { file: "rails.bin", triangles: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
      },
    };
    const part = new Float32Array(18);
    for (let i = 0; i < 18; i++) part[i] = i;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("guzergah-mesh.json")) return new Response(JSON.stringify(meta));
        if (String(url).endsWith(".bin")) return new Response(part.buffer);
        return new Response(null, { status: 404 });
      }),
    );
    const group = await loadGuzergahMesh();
    expect(group?.name).toBe("guzergah-mesh");
    expect(group?.getObjectByName("guzergah-sleepers")).toBeTruthy();
    expect(group?.getObjectByName("guzergah-rails")).toBeTruthy();
    expect(group?.userData.ifcMeta.source).toBe("guzergah.ifc");
  });
});

describe("track layout / heatmap / selection color", () => {
  it("orders sleeper centroids along the track", () => {
    const mesh = sleeperMesh(12);
    const layout = sleeperMeshLayout(mesh, 12);
    expect(layout.count).toBe(12);
    expect(layout.order).toHaveLength(12);
    expect(layout.vertsPer).toBe(8);
    const root = new THREE.Group();
    root.name = "guzergah-mesh";
    root.userData.ifcMeta = { counts: { sleepers: 12 } };
    root.add(mesh);
    const path = extractTrackPath(root);
    expect(path.length).toBeGreaterThanOrEqual(8);
  });

  it("paints sleepers and greys the other part when filtered", () => {
    const root = new THREE.Group();
    const sleepers = sleeperMesh(12);
    const rails = sleeperMesh(12);
    rails.name = "guzergah-rails";
    root.add(sleepers, rails);
    root.userData.ifcMeta = { counts: { sleepers: 12, rails: 12 } };
    applyTrackHeatmap(root, [sensor({ value: 1 }), sensor({ id: "s2", value: 4 })], "sleepers", true);
    expect((sleepers.geometry.getAttribute("color") as THREE.BufferAttribute | undefined)?.count).toBeGreaterThan(0);
    applyTrackHeatmap(root, [sensor()], "all", false);
    expect((sleepers.material as THREE.MeshLambertMaterial).vertexColors).toBe(false);
  });

  it("highlights a selected rail slice and restores it", () => {
    const root = new THREE.Group();
    root.userData.ifcMeta = { counts: { rails: 2 } };
    const mesh = sleeperMesh(8);
    mesh.name = "guzergah-rails";
    const hit = scanElementFromHit(root, mesh, 0);
    expect(hit).toBeTruthy();
    const restore = applyScanSelectionColor(hit!);
    expect(Array.isArray(mesh.material)).toBe(true);
    expect(mesh.geometry.groups.length).toBeGreaterThan(0);
    restore();
    expect(Array.isArray(mesh.material)).toBe(false);
    expect(mesh.geometry.groups).toHaveLength(0);
  });

  it("looks along the rail from a non-empty box", () => {
    const setLookAt = vi.fn();
    fitCameraToRail({ setLookAt }, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 2, 4)));
    expect(setLookAt).toHaveBeenCalledOnce();
    fitCameraToRail({ setLookAt }, new THREE.Box3());
    expect(setLookAt).toHaveBeenCalledOnce();
  });
});

describe("scan navigation wiring", () => {
  it("tunes distances and zooms on wheel toward a pick", () => {
    const setLookAt = vi.fn();
    const dom = document.createElement("div");
    Object.defineProperty(dom, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }),
    });
    scanViewerDomRef.current = dom;
    scanDollyPickRef.current = () => new THREE.Vector3(0, 0, 0);
    const cam = {
      three: { near: 1, far: 1, updateProjectionMatrix: vi.fn() },
      controls: {
        minDistance: 1,
        maxDistance: 1,
        dollySpeed: 1,
        truckSpeed: 1,
        azimuthRotateSpeed: 1,
        polarRotateSpeed: 1,
        dollyToCursor: true,
        infinityDolly: true,
        mouseButtons: { wheel: 2 },
        colliderMeshes: [1],
        getDistance: () => 40,
        getPosition: (out: THREE.Vector3) => out.set(0, 0, 40),
        getTarget: (out: THREE.Vector3) => out.set(0, 0, 0),
        setLookAt,
        addEventListener: () => undefined,
      },
    };
    tuneScanNavigation(cam);
    expect(cam.controls.minDistance).toBeLessThan(1);
    expect(cam.controls.mouseButtons.wheel).toBe(0);
    installScanWheelZoom(cam);
    dom.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, clientX: 100, clientY: 50, bubbles: true, cancelable: true }));
    expect(setLookAt).toHaveBeenCalled();
    scanViewerDomRef.current = null;
    scanDollyPickRef.current = () => null;
  });
});

describe("createScanLayers", () => {
  it("attaches a sample cloud, reveals it, and errors without a güzergah", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/iot-sample.json")) {
          return new Response(
            JSON.stringify({
              sensors: {},
              channels: { cant: { name: "Cant", unit: "mm" } },
              samples: { timestamps: [], data: {} },
            }),
          );
        }
        return new Response(null, { status: 404 });
      }),
    );
    const scene = new THREE.Scene();
    const host: ScanLayerHost = {
      world: { scene: { three: scene }, camera: { controls: { setLookAt: () => undefined } } },
      iotOn: true,
      iotChannel: "cant",
      iotYear: 2024,
      bimOn: true,
      pointCloudOn: true,
      pointCloudRef: { current: null },
      iotGroupRef: { current: null },
      iotViewRef: { current: null },
      modelBoxRef: { current: null },
      iotRadiusRef: { current: 1 },
      remapIotRef: { current: false },
      trackPathRef: { current: [] },
      ifcModelsRef: { current: [] },
      v3ModelRef: { current: null },
      setSensors: vi.fn(),
      setIotView: vi.fn(),
      setIotChannel: vi.fn(),
      setLayersReady: vi.fn(),
      setIotTrackReady: vi.fn(),
      setScanIfcStatus: vi.fn(),
      setModelLoaded: vi.fn(),
      captureCameraPose: vi.fn(),
      fragmentRoutes: [],
    };
    const layers = createScanLayers(host);
    await layers.attachSceneLayers(host.world, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 1, 4)));
    expect(host.pointCloudRef.current).toBeInstanceOf(THREE.Points);
    expect(host.pointCloudRef.current?.visible).toBe(false);
    layers.revealScanLayers();
    expect(host.pointCloudRef.current?.visible).toBe(true);
    expect(host.setLayersReady).toHaveBeenCalledWith(true);
    await layers.loadScanIfcModels(host.world);
    expect(host.setScanIfcStatus).toHaveBeenCalledWith("error");
  });
});
