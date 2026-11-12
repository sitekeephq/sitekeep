/**
 * Robust extents of a drawing for "Sığdır": the main body, without stray far-away entities
 * (a survey drawing in UTM coordinates with a layout near 0,0, mirrored blocks at −y or a few
 * entities at absurd coordinates would otherwise fit as dots). Pure TS (tests:
 * apps/web/test/viewers/cad-bounds.test.ts).
 *
 * Method, per axis, alternating X and Y on the surviving points until nothing changes:
 * 1. Sort the coordinates and split them into clusters at gaps wider than 1% of their range.
 * 2. The cluster with the most points is the kernel.
 * 3. The kernel grows into a neighbouring cluster while the gap is at most twice the larger of
 *    the two extents (kernel or neighbour). Separate views, sections, legends and the title
 *    block of one sheet stay together; clusters far away (relative to their size) are dropped.
 * Nothing is cut on an axis when a dropped group of clusters is close to the kernel in number
 * (two drawings of similar weight: no single main body), and the full extent is kept when
 * fewer than 30% of the points would remain.
 *
 * Shared by the CAD viewer (Sığdır, apps/web/src/viewers/cad/bounds.ts) and the server-built 2D
 * scene, whose origin is the centre of the robust box (float32 precision in UTM drawings).
 */

/** Axis-aligned box in drawing coordinates. */
export interface CadBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
type Box = CadBox;

export interface RobustBounds extends Box {
  /** Points left outside (0: the robust box is the full extent). */
  outliers: number;
  /** Points looked at (after sampling). */
  total: number;
}

const MAX_SAMPLES = 200_000;
/** Clusters are split at gaps wider than this share of the range. */
const SPLIT_SHARE = 0.01;
/** A neighbour joins when gap ≤ GROW_RATIO × max(kernel extent, neighbour extent, split gap). */
const GROW_RATIO = 2;
/** No cut when a dropped group has more than this share of the kept points. */
const AMBIGUOUS = 0.75;
/** Full extent when fewer than this share of the points would remain. */
const MIN_KEPT = 0.3;

/**
 * The value interval of the main cluster along one axis (sorted values), or null when nothing
 * should be cut.
 */
export function mainInterval(sorted: ArrayLike<number>): [number, number] | null {
  const n = sorted.length;
  if (n < 2) return null;
  const range = sorted[n - 1]! - sorted[0]!;
  if (!(range > 0)) return null;
  const split = range * SPLIT_SHARE;
  const starts: number[] = [0];
  for (let i = 1; i < n; i++) if (sorted[i]! - sorted[i - 1]! > split) starts.push(i);
  const k = starts.length;
  if (k === 1) return null;
  const first = (c: number) => starts[c]!;
  const last = (c: number) => (c + 1 < k ? starts[c + 1]! : n) - 1;
  const count = (c: number) => last(c) - first(c) + 1;
  const extent = (c: number) => sorted[last(c)]! - sorted[first(c)]!;
  let kernel = 0;
  for (let c = 1; c < k; c++) if (count(c) > count(kernel)) kernel = c;
  let a = kernel;
  let b = kernel;
  for (;;) {
    const ext = sorted[last(b)]! - sorted[first(a)]!;
    let pick: "left" | "right" | null = null;
    let best = Infinity;
    if (a > 0) {
      const gap = sorted[first(a)]! - sorted[last(a - 1)]!;
      if (gap <= GROW_RATIO * Math.max(ext, extent(a - 1), split) && gap < best) {
        best = gap;
        pick = "left";
      }
    }
    if (b < k - 1) {
      const gap = sorted[first(b + 1)]! - sorted[last(b)]!;
      if (gap <= GROW_RATIO * Math.max(ext, extent(b + 1), split) && gap < best) {
        best = gap;
        pick = "right";
      }
    }
    if (pick === "left") a--;
    else if (pick === "right") b++;
    else break;
  }
  if (a === 0 && b === k - 1) return null;
  // Dropped clusters in groups (neighbours joined by the same rule): a group about as heavy as
  // the kernel means there is no single main body.
  const kept = last(b) - first(a) + 1;
  let group = 0;
  let heaviest = 0;
  for (let c = 0; c < k; c++) {
    if (c >= a && c <= b) {
      group = 0;
      continue;
    }
    const joined = c > 0 && !(c - 1 >= a && c - 1 <= b) && sorted[first(c)]! - sorted[last(c - 1)]! <= GROW_RATIO * Math.max(extent(c), extent(c - 1), split);
    group = (joined ? group : 0) + count(c);
    heaviest = Math.max(heaviest, group);
  }
  if (heaviest > AMBIGUOUS * kept) return null;
  return [sorted[first(a)]!, sorted[last(b)]!];
}

/** @param xy Flat x, y list (non-finite pairs are skipped). Large inputs are sampled evenly. */
export function robustBounds(xy: ArrayLike<number>): RobustBounds | null {
  const n = Math.floor(xy.length / 2);
  const step = Math.max(1, Math.ceil(n / MAX_SAMPLES));
  const xsList: number[] = [];
  const ysList: number[] = [];
  for (let i = 0; i < n; i += step) {
    const x = xy[2 * i]!;
    const y = xy[2 * i + 1]!;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xsList.push(x);
      ysList.push(y);
    }
  }
  const m = xsList.length;
  if (!m) return null;
  let xs: Float64Array = Float64Array.from(xsList);
  let ys: Float64Array = Float64Array.from(ysList);
  const box = (px: Float64Array, py: Float64Array): Box => {
    const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < px.length; i++) {
      if (px[i]! < b.minX) b.minX = px[i]!;
      if (px[i]! > b.maxX) b.maxX = px[i]!;
      if (py[i]! < b.minY) b.minY = py[i]!;
      if (py[i]! > b.maxY) b.maxY = py[i]!;
    }
    return b;
  };
  const full = box(xs, ys);
  /** Keeps the points whose `along` value is inside the main interval of that axis. */
  const trim = (along: Float64Array, other: Float64Array): [Float64Array, Float64Array] | null => {
    const iv = mainInterval(Float64Array.from(along).sort());
    if (!iv) return null;
    const keepA: number[] = [];
    const keepO: number[] = [];
    for (let i = 0; i < along.length; i++)
      if (along[i]! >= iv[0] && along[i]! <= iv[1]) {
        keepA.push(along[i]!);
        keepO.push(other[i]!);
      }
    return keepA.length < along.length ? [Float64Array.from(keepA), Float64Array.from(keepO)] : null;
  };
  for (let round = 0; round < 12; round++) {
    let changed = false;
    const tx = trim(xs, ys);
    if (tx) {
      [xs, ys] = tx;
      changed = true;
    }
    const ty = trim(ys, xs);
    if (ty) {
      [ys, xs] = ty;
      changed = true;
    }
    if (!changed) break;
  }
  if (xs.length === m || xs.length < MIN_KEPT * m) return { ...full, outliers: 0, total: m };
  return { ...box(xs, ys), outliers: m - xs.length, total: m };
}
