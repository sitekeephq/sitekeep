// @ts-nocheck
import * as THREE from "three";
import { scanAssetUrl } from "../assets.js";

function heightColor(t: number, target: THREE.Color) {
  // Tarama görünümü: alçak mavi, yüksek amber
  const low = new THREE.Color(0x3b82f6);
  const high = new THREE.Color(0xf59e0b);
  target.copy(low).lerp(high, t);
}

/**
 * Gerçek .rcs yerine model bounding box'ından tarama benzeri nokta bulutu üretir.
 * school_arq üzerinde üç katmanı göstermek için.
 */
export function createSamplePointCloud(box: THREE.Box3, count = 70000): THREE.Points {
  const size = box.getSize(new THREE.Vector3());
  const min = box.min;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const bucket = i / count;
    let x: number;
    let y: number;
    let z: number;

    if (bucket < 0.35) {
      // Zemin taraması
      x = min.x + Math.random() * size.x;
      y = min.y + Math.random() * size.y * 0.04;
      z = min.z + Math.random() * size.z;
    } else if (bucket < 0.75) {
      // Cephe kabuğu
      const face = Math.floor(Math.random() * 4);
      const u = Math.random();
      const v = Math.random();
      if (face === 0) {
        x = min.x;
        y = min.y + v * size.y;
        z = min.z + u * size.z;
      } else if (face === 1) {
        x = min.x + size.x;
        y = min.y + v * size.y;
        z = min.z + u * size.z;
      } else if (face === 2) {
        x = min.x + u * size.x;
        y = min.y + v * size.y;
        z = min.z;
      } else {
        x = min.x + u * size.x;
        y = min.y + v * size.y;
        z = min.z + size.z;
      }
    } else {
      // İç hacim (seyrek)
      x = min.x + Math.random() * size.x;
      y = min.y + Math.random() * size.y;
      z = min.z + Math.random() * size.z;
    }

    // Hafif gürültü — tarama hissi
    x += (Math.random() - 0.5) * size.x * 0.008;
    y += (Math.random() - 0.5) * size.y * 0.008;
    z += (Math.random() - 0.5) * size.z * 0.008;

    const i3 = i * 3;
    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;

    const t = size.y > 0 ? THREE.MathUtils.clamp((y - min.y) / size.y, 0, 1) : 0;
    heightColor(t, color);
    colors[i3] = color.r;
    colors[i3 + 1] = color.g;
    colors[i3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    size: Math.max(size.length() * 0.0016, 0.08),
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "demo-pointcloud";
  points.frustumCulled = false;
  return points;
}

export interface LasPreviewMeta {
  source: string;
  count: number;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export const LAS_RENDER_POINT_BUDGET = 900_000;

export async function loadLasPreview(url = scanAssetUrl("preview.bin")): Promise<THREE.Points | null> {
  const metaRes = await fetch(scanAssetUrl("preview.json"));
  if (!metaRes.ok) return null;
  const meta = (await metaRes.json()) as LasPreviewMeta;
  const binRes = await fetch(url);
  if (!binRes.ok) return null;
  const buffer = await binRes.arrayBuffer();
  const data = new Float32Array(buffer);
  const sourceCount = Math.floor(data.length / 6);
  if (!sourceCount) return null;
  const count = Math.min(sourceCount, LAS_RENDER_POINT_BUDGET);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const sourceIndex = Math.floor((i * sourceCount) / count);
    const s = sourceIndex * 6;
    const d = i * 3;
    positions[d] = data[s];
    positions[d + 1] = data[s + 1];
    positions[d + 2] = data[s + 2];
    colors[d] = data[s + 3];
    colors[d + 1] = data[s + 4];
    colors[d + 2] = data[s + 5];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const size = meta.bbox
    ? Math.hypot(
        meta.bbox.max[0] - meta.bbox.min[0],
        meta.bbox.max[1] - meta.bbox.min[1],
        meta.bbox.max[2] - meta.bbox.min[2]
      )
    : 200;
  const material = new THREE.PointsMaterial({
    size: Math.max(size * 0.0009, 0.6),
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "las-preview";
  points.userData.lasMeta = { ...meta, sourceCount, renderedCount: count };
  points.frustumCulled = true;
  console.log("LAS preview loaded", { count, sourceCount, source: meta.source, bbox: meta.bbox });
  return points;
}
