/**
 * Reads the drawn geometry back from the viewer's three.js scene (after load, whatever built
 * it): line batches with their vertex/index buffers, block instances with their transforms and
 * point entities. Structural types only, so the module needs no three.js and is unit-tested
 * with plain objects (apps/web/test/viewers/cad-snap.test.ts).
 */
import type { LineSource, PointSource } from "./snap-index";

/** BufferAttribute or InterleavedBufferAttribute, as far as we read them. */
export interface AttrLike {
  itemSize: number;
  count: number;
  array?: ArrayLike<number>;
  /** Interleaved: the shared buffer. */
  data?: { array: ArrayLike<number>; stride: number };
  offset?: number;
  isInterleavedBufferAttribute?: boolean;
}

export interface SceneObjectLike {
  isLineSegments?: boolean;
  isPoints?: boolean;
  geometry?: {
    attributes: Record<string, AttrLike | undefined>;
    index?: { array: ArrayLike<number> } | null;
  };
  /** dxf-viewer's layer of the object. */
  _dxfViewerLayer?: { name: string } | null;
}

function get(a: AttrLike, i: number, c: number): number {
  if (a.isInterleavedBufferAttribute || a.data) return a.data!.array[i * a.data!.stride + (a.offset ?? 0) + c]!;
  return a.array![i * a.itemSize + c]!;
}

/** Plain x, y positions of an attribute (copy only when interleaved). */
function positions(a: AttrLike): { positions: ArrayLike<number>; stride: number } {
  if (!a.isInterleavedBufferAttribute && !a.data && a.array) return { positions: a.array, stride: a.itemSize };
  const out = new Float32Array(a.count * 2);
  for (let i = 0; i < a.count; i++) {
    out[2 * i] = get(a, i, 0);
    out[2 * i + 1] = get(a, i, 1);
  }
  return { positions: out, stride: 2 };
}

export function sceneSources(objects: Iterable<SceneObjectLike>): { lines: LineSource[]; points: PointSource[] } {
  const lines: LineSource[] = [];
  const points: PointSource[] = [];
  const seenPointSets = new Set<AttrLike>();
  for (const o of objects) {
    const g = o.geometry;
    const pos = g?.attributes.position;
    if (!g || !pos) continue;
    const layer = o._dxfViewerLayer?.name ?? "0";
    const t0 = g.attributes.instanceTransform0;
    const t1 = g.attributes.instanceTransform1;
    const tp = g.attributes.instanceTransform;
    let instances: Float64Array | null = null;
    if (t0 && t1) {
      // Block instances: two rows of a 3×2 matrix.
      const n = Math.min(t0.count, t1.count);
      instances = new Float64Array(n * 6);
      for (let i = 0; i < n; i++)
        for (let c = 0; c < 3; c++) {
          instances[6 * i + c] = get(t0, i, c);
          instances[6 * i + 3 + c] = get(t1, i, c);
        }
    } else if (tp) {
      // Point shapes: a translation per point; the points themselves are snap points too.
      const n = tp.count;
      instances = new Float64Array(n * 6);
      const pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const x = get(tp, i, 0);
        const y = get(tp, i, 1);
        instances.set([1, 0, x, 0, 1, y], 6 * i);
        pts[2 * i] = x;
        pts[2 * i + 1] = y;
      }
      if (!seenPointSets.has(tp)) points.push({ positions: pts, layer });
      seenPointSets.add(tp);
    }
    if (o.isLineSegments) {
      const p = positions(pos);
      lines.push({ ...p, indices: g.index?.array ?? null, layer, instances, key: instances ? (g.index ?? pos) : undefined });
    } else if (o.isPoints && !instances) {
      points.push({ ...positions(pos), layer });
    }
  }
  return { lines, points };
}

/**
 * Sample of the drawn vertices in scene coordinates (flat x, y list) for robust extents: every
 * object's vertices (evenly thinned out to about `max` points), block instances as the four
 * corners of their transformed geometry box, point shapes as their positions.
 */
export function scenePoints(objects: Iterable<SceneObjectLike>, max = 400_000): Float64Array {
  const list = [...objects].filter((o) => o.geometry?.attributes.position);
  let total = 0;
  for (const o of list) {
    const a = o.geometry!.attributes;
    total += a.instanceTransform0 ? 4 * a.instanceTransform0.count : a.instanceTransform ? a.instanceTransform.count : a.position!.count;
  }
  const step = Math.max(1, Math.ceil(total / max));
  const out: number[] = [];
  let k = 0;
  const push = (x: number, y: number) => {
    if (k++ % step === 0 && Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  };
  for (const o of list) {
    const a = o.geometry!.attributes;
    const pos = a.position!;
    const t0 = a.instanceTransform0;
    const t1 = a.instanceTransform1;
    if (t0 && t1) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = get(pos, i, 0);
        const y = get(pos, i, 1);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX + minY + maxX + maxY)) continue;
      const n = Math.min(t0.count, t1.count);
      for (let i = 0; i < n; i++) {
        const [a0, b0, tx] = [get(t0, i, 0), get(t0, i, 1), get(t0, i, 2)];
        const [c0, d0, ty] = [get(t1, i, 0), get(t1, i, 1), get(t1, i, 2)];
        for (const [x, y] of [
          [minX, minY],
          [maxX, minY],
          [minX, maxY],
          [maxX, maxY],
        ] as const)
          push(a0 * x + b0 * y + tx, c0 * x + d0 * y + ty);
      }
    } else if (a.instanceTransform) {
      const tp = a.instanceTransform;
      for (let i = 0; i < tp.count; i++) push(get(tp, i, 0), get(tp, i, 1));
    } else {
      for (let i = 0; i < pos.count; i++) push(get(pos, i, 0), get(pos, i, 1));
    }
  }
  return Float64Array.from(out);
}
