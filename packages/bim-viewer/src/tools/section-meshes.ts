/**
 * Section mesh compaction. Fragments' getSection returns a fixed, zero-filled 600 000-float buffer
 * plus the used length. ClipEdges passes the whole buffer to LineSegmentsGeometry.fromLineSegments
 * (which ignores the draw range), so every cut line draws 100 000 fat-line instances, almost all
 * empty, and the fill mesh uploads the same 2,4 MB as its positions. A section box has six faces
 * per model: with two or three disciplines that is over a million instances a frame (the viewer
 * stalls) and tens of megabytes uploaded whenever the box changes. Right before a frame, each new
 * buffer is replaced by a copy of the part that is really used; That Open is not modified.
 */
import * as THREE from "three";

/** Segments with data in a zero-filled xyz-xyz buffer: up to the last non-zero value. */
export function usedSegments(array: ArrayLike<number>, stride = 6): number {
  for (let i = array.length - 1; i >= 0; i--) if (array[i] !== 0) return Math.floor(i / stride) + 1;
  return 0;
}

/** The part of a LineSegmentsGeometry (three/examples) the compaction reads and writes. */
export interface SectionLineGeometry {
  instanceCount: number;
  attributes: { instanceStart?: { data?: { array: Float32Array; stride: number } } };
  setPositions(array: Float32Array): unknown;
}

/** Buffers that already hold only used data (ClipEdges brings new ones with every update). */
const compact = new WeakSet<object>();

/** Cut line: keeps only the real segments (an empty cut draws nothing). */
export function compactSectionLine(geometry: SectionLineGeometry): void {
  const data = geometry.attributes.instanceStart?.data;
  if (!data || compact.has(data.array)) return;
  const count = usedSegments(data.array, data.stride);
  const used = count * data.stride;
  if (used === data.array.length) {
    compact.add(data.array);
    return;
  }
  // An empty cut keeps one zero segment: an empty array would give three a NaN bounding sphere.
  const copy = count ? data.array.slice(0, used) : new Float32Array(data.stride);
  compact.add(copy);
  geometry.setPositions(copy);
  geometry.instanceCount = count;
}

/** Cut fill: positions up to the highest vertex its triangles use. */
export function compactSectionFill(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || !index || compact.has(position.array)) return;
  let last = -1;
  for (let i = 0; i < index.count; i++) last = Math.max(last, index.getX(i));
  const used = (last + 1) * position.itemSize;
  if (used >= position.array.length) {
    compact.add(position.array);
    return;
  }
  const copy = (position.array as Float32Array).slice(0, used);
  compact.add(copy);
  geometry.setAttribute("position", new THREE.BufferAttribute(copy, position.itemSize));
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
}

/** Compacts every cut line (LineSegments2) and fill mesh under the given ClipEdges roots. */
export function compactSectionMeshes(roots: Iterable<THREE.Object3D>): void {
  for (const root of roots) {
    root.traverse((object) => {
      const mesh = object as THREE.Object3D & { isLineSegments2?: boolean; isMesh?: boolean; geometry?: unknown };
      if (mesh.isLineSegments2) compactSectionLine(mesh.geometry as SectionLineGeometry);
      else if (mesh.isMesh && mesh.geometry instanceof THREE.BufferGeometry) compactSectionFill(mesh.geometry);
    });
  }
}
