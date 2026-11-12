// @ts-nocheck
import * as THREE from "three";
import type { IotSensor, LimitBand } from "../types.js";
import { sleeperMeshLayout } from "./ifcMesh.js";
import type { IfcMeshMeta } from "./ifcMesh.js";

export type HeatmapFilter = "all" | "sleepers" | "rails";

const BASE_COLOR: Record<string, number> = {
  sleepers: 0x6fbf63,
  rails: 0x2b2d31,
};
const PLAIN_COLOR: Record<string, number> = {
  sleepers: 0x7a7a7a,
  rails: 0x4a4a4a,
};
const GRAY = new THREE.Color(0x595959);

export function valueToHeatColor(t: number, target = new THREE.Color()) {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (u < 0.25) {
    r = 0;
    g = u * 4;
    b = 1;
  } else if (u < 0.5) {
    r = 0;
    g = 1;
    b = 1 - (u - 0.25) * 4;
  } else if (u < 0.75) {
    r = (u - 0.5) * 4;
    g = 1;
    b = 0;
  } else {
    r = 1;
    g = 1 - (u - 0.75) * 4;
    b = 0;
  }
  return target.setRGB(r, g, b);
}

export function colorFromMeasurement(
  value: number | null,
  limits: IotSensor["limits"] | undefined,
  dataMin: number,
  dataMax: number,
  target = new THREE.Color()
) {
  if (value === null || !Number.isFinite(value)) return valueToHeatColor(0.5, target);
  if (limits?.IAL && (value < limits.IAL.min || value > limits.IAL.max)) return target.set(0xff0000);
  if (limits?.IL && (value < limits.IL.min || value > limits.IL.max)) return target.set(0xff8000);
  if (limits?.AL && (value < limits.AL.min || value > limits.AL.max)) return target.set(0xffeb3b);
  const span = dataMax - dataMin || 1;
  return valueToHeatColor((value - dataMin) / span, target);
}

export function heatmapRange(sensors: IotSensor[]) {
  const values = sensors.map((s) => s.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!values.length) return { min: -1, max: 1 };
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = dataMax - dataMin;
  if (span < 0.001) return { min: dataMin - 1, max: dataMax + 1 };
  return { min: dataMin - span * 0.1, max: dataMax + span * 0.1 };
}

function sampleAtT(sensors: IotSensor[], t: number): number | null {
  const usable = sensors.filter((s) => s.value !== null && Number.isFinite(s.value));
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0].value;
  const x = THREE.MathUtils.clamp(t, 0, 1) * (usable.length - 1);
  const i = Math.min(Math.floor(x), usable.length - 2);
  const a = usable[i].value as number;
  const b = usable[i + 1].value as number;
  return a + (b - a) * (x - i);
}

function ensureVertexColors(mesh: THREE.Mesh) {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) return null;
  let color = mesh.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!color || color.count !== pos.count) {
    color = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    mesh.geometry.setAttribute("color", color);
  }
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshLambertMaterial;
  if (material && "vertexColors" in material) {
    material.vertexColors = true;
    material.needsUpdate = true;
  }
  return color;
}

function fillSolid(mesh: THREE.Mesh, color: THREE.Color, useVertexColors: boolean) {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshLambertMaterial;
  if (!useVertexColors) {
    if (material) {
      material.vertexColors = false;
      material.color.copy(color);
      material.needsUpdate = true;
    }
    return;
  }
  const attr = ensureVertexColors(mesh);
  if (!attr) return;
  for (let i = 0; i < attr.count; i++) attr.setXYZ(i, color.r, color.g, color.b);
  attr.needsUpdate = true;
}

function paintSleepers(mesh: THREE.Mesh, sleeperCount: number, sensors: IotSensor[], range: { min: number; max: number }) {
  const layout = (mesh.userData.heatmapLayout as ReturnType<typeof sleeperMeshLayout>) || sleeperMeshLayout(mesh, sleeperCount);
  mesh.userData.heatmapLayout = layout;
  const attr = ensureVertexColors(mesh);
  if (!attr || !layout.vertsPer) return;
  const color = new THREE.Color();
  const limits = sensors[0]?.limits;
  const last = Math.max(layout.order.length - 1, 1);
  for (let trackI = 0; trackI < layout.order.length; trackI++) {
    const sleeper = layout.order[trackI];
    colorFromMeasurement(sampleAtT(sensors, trackI / last), limits, range.min, range.max, color);
    const start = sleeper * layout.vertsPer;
    const end = sleeper === layout.count - 1 ? attr.count : start + layout.vertsPer;
    for (let i = start; i < end; i++) attr.setXYZ(i, color.r, color.g, color.b);
  }
  attr.needsUpdate = true;
}

function nearestPathT(x: number, z: number, path: THREE.Vector3[]) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dx = path[i].x - x;
    const dz = path[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return path.length > 1 ? best / (path.length - 1) : 0;
}

function paintRails(mesh: THREE.Mesh, sensors: IotSensor[], range: { min: number; max: number }, path: THREE.Vector3[]) {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) return;
  const attr = ensureVertexColors(mesh);
  if (!attr) return;
  let bins = mesh.userData.heatmapRailBins as Array<{ start: number; end: number; t: number }> | undefined;
  if (!bins) {
    const railCount = 3;
    const binsPerRail = 360;
    bins = [];
    const vertsPerRail = Math.floor(pos.count / railCount);
    for (let r = 0; r < railCount; r++) {
      const railStart = r * vertsPerRail;
      const railEnd = r === railCount - 1 ? pos.count : railStart + vertsPerRail;
      const span = railEnd - railStart;
      for (let b = 0; b < binsPerRail; b++) {
        const start = railStart + Math.floor((b * span) / binsPerRail);
        const end = railStart + Math.floor(((b + 1) * span) / binsPerRail);
        let x = 0;
        let z = 0;
        let n = 0;
        const step = Math.max(1, Math.floor((end - start) / 8));
        for (let i = start; i < end; i += step) {
          x += pos.getX(i);
          z += pos.getZ(i);
          n += 1;
        }
        bins.push({ start, end, t: n ? nearestPathT(x / n, z / n, path) : b / binsPerRail });
      }
    }
    mesh.userData.heatmapRailBins = bins;
  }
  const color = new THREE.Color();
  const limits = sensors[0]?.limits;
  for (const bin of bins) {
    colorFromMeasurement(sampleAtT(sensors, bin.t), limits, range.min, range.max, color);
    for (let i = bin.start; i < bin.end; i++) attr.setXYZ(i, color.r, color.g, color.b);
  }
  attr.needsUpdate = true;
}

export function applyTrackHeatmap(
  root: THREE.Object3D | null | undefined,
  sensors: IotSensor[],
  filter: HeatmapFilter,
  enabled: boolean
) {
  if (!root) return;
  if (!enabled || !sensors.length) {
    const sleepersOff = root.getObjectByName("guzergah-sleepers") as THREE.Mesh | undefined;
    const railsOff = root.getObjectByName("guzergah-rails") as THREE.Mesh | undefined;
    if (sleepersOff) fillSolid(sleepersOff, new THREE.Color(PLAIN_COLOR.sleepers), false);
    if (railsOff) fillSolid(railsOff, new THREE.Color(PLAIN_COLOR.rails), false);
    return;
  }
  const sleepers = root.getObjectByName("guzergah-sleepers") as THREE.Mesh | undefined;
  const rails = root.getObjectByName("guzergah-rails") as THREE.Mesh | undefined;
  const meta = (root.userData.ifcMeta || {}) as IfcMeshMeta;
  const range = heatmapRange(sensors);
  const layout = sleepers ? sleeperMeshLayout(sleepers, meta.counts?.sleepers || 0) : null;
  const path = layout ? layout.order.map((i) => layout.centroids[i]) : [];

  if (sleepers) {
    if (!enabled) {
      fillSolid(sleepers, new THREE.Color(BASE_COLOR.sleepers), false);
    } else if (filter === "rails") {
      fillSolid(sleepers, GRAY, false);
    } else {
      paintSleepers(sleepers, meta.counts?.sleepers || 0, sensors, range);
    }
  }
  if (rails) {
    if (!enabled) {
      fillSolid(rails, new THREE.Color(BASE_COLOR.rails), false);
    } else if (filter === "sleepers") {
      fillSolid(rails, GRAY, false);
    } else {
      paintRails(rails, sensors, range, path);
    }
  }
}

export function heatmapLegendStops() {
  return ["#2196F3", "#00bcd4", "#4caf50", "#ffeb3b", "#f44336"];
}

export type { LimitBand };
