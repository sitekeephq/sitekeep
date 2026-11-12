// @ts-nocheck
import * as THREE from "three";
import { scanAssetUrl } from "../assets.js";

type PartMeta = {
  file: string;
  triangles: number;
  bbox: { min: number[]; max: number[] };
};

export interface IfcMeshMeta {
  source: string;
  parts?: Record<string, PartMeta>;
  triangles?: number;
  bbox?: { min: number[]; max: number[] };
  counts?: { sleepers?: number; rails?: number };
}

const PART_COLOR: Record<string, number> = {
  sleepers: 0x7a7a7a,
  rails: 0x4a4a4a,
};

async function loadPart(file: string, color: number, name: string): Promise<THREE.Mesh | null> {
  const response = await fetch(scanAssetUrl(file));
  if (!response.ok) return null;
  const data = new Float32Array(await response.arrayBuffer());
  const count = Math.floor(data.length / 6);
  if (count < 3) return null;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = i * 6;
    const d = i * 3;
    positions[d] = data[s];
    positions[d + 1] = data[s + 1];
    positions[d + 2] = data[s + 2];
    normals[d] = data[s + 3];
    normals[d + 1] = data[s + 4];
    normals[d + 2] = data[s + 5];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.boundingSphere = geometry.boundingBox?.getBoundingSphere(new THREE.Sphere()) || null;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })
  );
  mesh.name = name;
  mesh.frustumCulled = true;
  return mesh;
}

export async function loadGuzergahMesh(): Promise<THREE.Group | null> {
  const metaRes = await fetch(scanAssetUrl("guzergah-mesh.json"));
  if (!metaRes.ok) return null;
  const meta = (await metaRes.json()) as IfcMeshMeta;
  const group = new THREE.Group();
  group.name = "guzergah-mesh";
  group.userData.ifcMeta = meta;

  if (meta.parts) {
    for (const [key, part] of Object.entries(meta.parts)) {
      const mesh = await loadPart(part.file, PART_COLOR[key] ?? 0xc5c8ce, `guzergah-${key}`);
      if (mesh) group.add(mesh);
    }
  } else {
    const mesh = await loadPart("guzergah-mesh.bin", 0xc5c8ce, "guzergah-legacy");
    if (mesh) group.add(mesh);
  }

  if (!group.children.length) return null;
  console.log("Güzergah mesh yüklendi", meta);
  return group;
}

export function ensureScanLights(scene: THREE.Scene) {
  if (scene.getObjectByName("scan-key-light")) return;
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  ambient.name = "scan-ambient";
  const key = new THREE.DirectionalLight(0xfff2dc, 1.2);
  key.name = "scan-key-light";
  key.position.set(80, 120, 40);
  const fill = new THREE.DirectionalLight(0xb9c8e6, 0.5);
  fill.name = "scan-fill-light";
  fill.position.set(-60, 40, -80);
  scene.add(ambient, key, fill);
}

export function railFocusBox(root: THREE.Object3D): THREE.Box3 {
  const sleepers = root.getObjectByName("guzergah-sleepers");
  const full = sleepers
    ? new THREE.Box3().setFromObject(sleepers)
    : new THREE.Box3().setFromObject(root);
  if (full.isEmpty()) return full;
  const t = 0.38;
  const along = new THREE.Vector3(full.max.x - full.min.x, 0, full.max.z - full.min.z);
  const origin = new THREE.Vector3(
    full.min.x + along.x * t,
    (full.min.y + full.max.y) * 0.5,
    full.min.z + along.z * t
  );
  const focus = new THREE.Box3();
  focus.setFromCenterAndSize(origin, new THREE.Vector3(48, 8, 48));
  return focus;
}

function sleeperCentroids(mesh: THREE.Mesh, sleeperCount: number): THREE.Vector3[] {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos || pos.count < 8) return [];
  const count = sleeperCount > 10 ? sleeperCount : Math.max(8, Math.round(pos.count / 252));
  const vertsPer = Math.floor(pos.count / count);
  if (vertsPer < 3) return [];
  const centroids: THREE.Vector3[] = [];
  for (let s = 0; s < count; s++) {
    const start = s * vertsPer;
    const end = s === count - 1 ? pos.count : start + vertsPer;
    let x = 0;
    let y = 0;
    let z = 0;
    const n = end - start;
    for (let i = start; i < end; i++) {
      x += pos.getX(i);
      y += pos.getY(i);
      z += pos.getZ(i);
    }
    centroids.push(new THREE.Vector3(x / n, y / n, z / n));
  }
  return centroids;
}

function chainAlongTrackIndices(points: THREE.Vector3[]): number[] {
  if (points.length < 2) return points.map((_, i) => i);
  let start = 0;
  let farthest = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = points[i].distanceToSquared(points[j]);
      if (d > farthest) {
        farthest = d;
        start = i;
      }
    }
  }
  const used = new Uint8Array(points.length);
  const ordered: number[] = [];
  let current = start;
  for (let step = 0; step < points.length; step++) {
    used[current] = 1;
    ordered.push(current);
    let next = -1;
    let nextDist = Infinity;
    const here = points[current];
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
      const d = here.distanceToSquared(points[i]);
      if (d < nextDist) {
        nextDist = d;
        next = i;
      }
    }
    if (next < 0) break;
    current = next;
  }
  return ordered;
}

function chainAlongTrack(points: THREE.Vector3[]): THREE.Vector3[] {
  return chainAlongTrackIndices(points).map((i) => points[i]);
}

export function sleeperMeshLayout(mesh: THREE.Mesh, sleeperCount: number) {
  const centroids = sleeperCentroids(mesh, sleeperCount);
  const order = chainAlongTrackIndices(centroids);
  const pos = mesh.geometry.getAttribute("position");
  const vertsPer = pos && centroids.length ? Math.floor(pos.count / centroids.length) : 0;
  return { centroids, order, vertsPer, count: centroids.length };
}

export function extractTrackPath(root: THREE.Object3D): THREE.Vector3[] {
  const mesh = root.getObjectByName("guzergah-sleepers") as THREE.Mesh | undefined;
  if (!mesh?.geometry) return [];
  const meta = (root.userData.ifcMeta || {}) as IfcMeshMeta;
  const centroids = sleeperCentroids(mesh, meta.counts?.sleepers || 0);
  if (centroids.length < 8) return [];
  return chainAlongTrack(centroids);
}

export function pointOnTrackPath(path: THREE.Vector3[], t: number): THREE.Vector3 {
  if (!path.length) return new THREE.Vector3();
  if (path.length === 1) return path[0].clone();
  const lengths = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += path[i].distanceTo(path[i - 1]);
    lengths.push(total);
  }
  const target = THREE.MathUtils.clamp(t, 0, 1) * total;
  let index = 1;
  while (index < lengths.length && lengths[index] < target) index += 1;
  const start = path[index - 1];
  const end = path[Math.min(index, path.length - 1)];
  const segment = lengths[index] - lengths[index - 1] || 1;
  return start.clone().lerp(end, (target - lengths[index - 1]) / segment);
}

export function fitCameraToRail(controls: { setLookAt?: Function } | null | undefined, box: THREE.Box3) {
  if (!controls?.setLookAt || box.isEmpty()) return;
  const target = box.getCenter(new THREE.Vector3());
  const along = new THREE.Vector3(box.max.x - box.min.x, 0, box.max.z - box.min.z);
  if (along.lengthSq() < 1) along.set(1, 0, 0);
  along.normalize();
  const side = new THREE.Vector3(-along.z, 0, along.x).normalize();
  const eye = target.clone().addScaledVector(side, 28).add(new THREE.Vector3(0, 12, 0)).addScaledVector(along, -16);
  controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
}
