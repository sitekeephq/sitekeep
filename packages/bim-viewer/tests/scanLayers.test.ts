import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { configureScanAssets, scanAssetUrl } from "../src/scan/assets";
import { DEFAULT_SCAN_IFC_OFFSET } from "../src/scan/constants";
import { ensureScanLights, pointOnTrackPath, railFocusBox } from "../src/scan/layers/ifcMesh";
import { createIotLayer, DENSE_IOT_POINTS, iotMarkerRadius, iotSensorIdFromHit, paintIotLayer } from "../src/scan/layers/iotLayer";
import { createSamplePointCloud } from "../src/scan/layers/pointCloud";
import { colorFromMeasurement, heatmapLegendStops, heatmapRange, valueToHeatColor } from "../src/scan/layers/trackHeatmap";
import type { IotSensor } from "../src/scan/types";

const sensor = (over: Partial<IotSensor> = {}): IotSensor => ({
  id: "s1",
  name: "A",
  groupName: "hat",
  channel: "cant",
  channelLabel: "Cant",
  unit: "mm",
  value: 1,
  status: "ok",
  position: [0, 1, 0],
  timestamps: [],
  series: [],
  ...over,
});

describe("scan assets and lights", () => {
  it("joins the configured public prefix", () => {
    configureScanAssets("/files/scans/");
    expect(scanAssetUrl("/preview.bin")).toBe("/files/scans/preview.bin");
    configureScanAssets();
    expect(scanAssetUrl("preview.bin")).toBe("/scans/preview.bin");
    expect(DEFAULT_SCAN_IFC_OFFSET[0]).toBeCloseTo(728.78);
  });

  it("adds scan lights once and focuses a rail box", () => {
    const scene = new THREE.Scene();
    ensureScanLights(scene);
    ensureScanLights(scene);
    expect(scene.getObjectByName("scan-key-light")).toBeTruthy();
    expect(scene.children.filter((c) => c.name.startsWith("scan-")).length).toBe(3);
    const root = new THREE.Mesh(new THREE.BoxGeometry(20, 2, 20));
    root.name = "guzergah-sleepers";
    const box = railFocusBox(root);
    expect(box.isEmpty()).toBe(false);
  });
});

describe("point cloud / IoT layer / heatmap", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: () => undefined,
      beginPath: () => undefined,
      rect: () => undefined,
      fill: () => undefined,
      stroke: () => undefined,
      fillText: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  it("builds a smaller sample cloud and IoT markers", () => {
    const cloud = createSamplePointCloud(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 1, 4)), 200);
    expect(cloud).toBeInstanceOf(THREE.Points);
    expect((cloud.geometry.getAttribute("position") as THREE.BufferAttribute).count).toBe(200);
    expect(iotMarkerRadius(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 2, 10)))).toBeGreaterThan(0);
    const group = createIotLayer([sensor(), sensor({ id: "s2", status: "alarm", position: [2, 1, 2] })]);
    expect(group.children.length).toBeGreaterThan(0);
    paintIotLayer(group, [sensor({ status: "warn" })]);
  });

  it("maps values onto the heat ramp and expands a tight range", () => {
    const c = valueToHeatColor(0);
    expect(c.b).toBeCloseTo(1);
    const alarm = colorFromMeasurement(40, { IAL: { min: -10, max: 10 } }, -5, 5);
    expect(alarm.getHex()).toBe(0xff0000);
    expect(heatmapRange([])).toEqual({ min: -1, max: 1 });
    expect(heatmapRange([sensor({ value: 2 }), sensor({ value: 4 })]).min).toBeLessThan(2);
    expect(heatmapLegendStops().length).toBeGreaterThan(2);
  });

  it("interpolates a point on a track path", () => {
    const mid = pointOnTrackPath([new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)], 0.5);
    expect(mid.x).toBeCloseTo(5);
  });
});

describe("scan starting view", () => {
  it("frames the rail like That Open's OrthoPerspectiveCamera.fit([36 × 6 × 36 box], 2.2)", async () => {
    const OBC = await import("@thatopen/components");
    const { thatOpenFitSphere } = await import("../src/scan/createScanLayers");
    // Below zero on y and z (as the survey lies): camera.fit's bounds reach out to the origin there.
    for (const center of [new THREE.Vector3(120, -4, -350), new THREE.Vector3(40, 3, 60)]) {
      let framed: THREE.Sphere | null = null;
      const helper = new THREE.Mesh(new THREE.BoxGeometry(36, 6, 36));
      helper.position.copy(center);
      helper.updateMatrixWorld(true);
      const camera = {
        enabled: true,
        components: { get: () => ({ initialized: false, list: new Map() }) },
        controls: { fitToSphere: async (sphere: THREE.Sphere) => void (framed = sphere) },
      };
      await OBC.OrthoPerspectiveCamera.prototype.fit.call(camera as never, [helper], 2.2);
      const ours = thatOpenFitSphere(center, new THREE.Vector3(36, 6, 36), 2.2);
      expect(framed).not.toBeNull();
      expect(ours.center.distanceTo(framed!.center)).toBeLessThan(1e-6);
      expect(ours.radius).toBeCloseTo(framed!.radius, 6);
    }
    // The 0.3.1 – 0.4.1 sphere (box only) put the camera this much closer for a survey below zero.
    expect(thatOpenFitSphere(new THREE.Vector3(120, -4, -350), new THREE.Vector3(36, 6, 36), 2.2).radius).toBeGreaterThan(36 * 2.2 * 5);
  });
});

describe("dense IoT layer (the 25 cm survey)", () => {
  it("draws thousands of points as one instanced mesh, picks and repaints them by id", () => {
    const sensors = Array.from({ length: 4001 }, (_, i) =>
      sensor({ id: `p${i}`, position: [i * 0.25, 0, 0], status: i === 7 ? "alarm" : "ok" }),
    );
    const group = createIotLayer(sensors, 0.5);
    const meshes: THREE.Object3D[] = [];
    group.traverse((child) => meshes.push(child));
    // The group and one instanced mesh: no per-point halo or label texture.
    expect(meshes).toHaveLength(2);
    const points = group.children[0] as THREE.InstancedMesh;
    expect(points.isInstancedMesh).toBe(true);
    expect(points.count).toBe(4001);
    const color = new THREE.Color();
    points.getColorAt(7, color);
    expect(color.getHex()).toBe(0xef4444);

    const raycaster = new THREE.Raycaster(new THREE.Vector3(7 * 0.25, 5, 0), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObject(group, true)[0]!;
    expect(iotSensorIdFromHit(hit)).toBe("p7");

    paintIotLayer(group, [{ ...sensors[7]!, status: "ok" }]);
    points.getColorAt(7, color);
    expect(color.getHex()).toBe(0x22c55e);
    // Just above the threshold it is already one mesh (up to it, the marker test above applies).
    expect(createIotLayer(sensors.slice(0, DENSE_IOT_POINTS + 1)).children).toHaveLength(1);
  });
});
