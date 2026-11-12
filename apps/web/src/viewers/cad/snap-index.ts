/**
 * Snap / pick index of a loaded DWG/DXF scene: endpoints, midpoints, arc and circle centres and
 * the nearest point on a segment, looked up through a uniform grid so that it stays fast with
 * hundreds of thousands of segments.
 *
 * Input is plain geometry (vertex/index buffers per batch and block instance transforms), not
 * the DXF: whatever built the scene, the index works from what is drawn. Arcs and circles are
 * already tessellated there, so they are recognised again from runs of equal segments that turn
 * by a constant angle (their centre becomes a "Merkez" snap, their inner vertices are not
 * "Uç Nokta"). Pure TS, no three.js (tests: apps/web/test/viewers/cad-snap.test.ts).
 */
import { i18n } from "../../i18n";
import { circumcenter, closestOnSegment, type Pt } from "./geometry";

export type SnapKind = "end" | "mid" | "center" | "near";
/** Name of a snap kind in the interface language ("Endpoint"). */
export function snapLabel(kind: SnapKind): string {
  return i18n.t(`viewers:cad.snapKinds.${kind}`);
}

export type ShapeKind = "line" | "polyline" | "arc" | "circle" | "point";
/** Name of a shape kind in the interface language ("Polyline"). */
export function shapeLabel(kind: ShapeKind): string {
  return i18n.t(`viewers:cad.shapes.${kind}`);
}
const SHAPES: ShapeKind[] = ["line", "polyline", "arc", "circle", "point"];
const KINDS: SnapKind[] = ["end", "mid", "center", "near"];

/** Line geometry of one batch / chunk. */
export interface LineSource {
  /** Vertex coordinates, `stride` numbers per vertex (x, y first). */
  positions: ArrayLike<number>;
  stride?: number;
  /** Vertex index pairs; without it consecutive vertex pairs are segments. */
  indices?: ArrayLike<number> | null;
  layer: string;
  /**
   * Block instances: 6 numbers each, x' = a·x + b·y + tx, y' = c·x + d·y + ty, laid out
   * (a, b, tx, c, d, ty). Without it the geometry is in scene coordinates.
   */
  instances?: ArrayLike<number> | null;
  /** Shared geometry of instanced sources (same key = same block geometry, indexed once). */
  key?: object;
}

/** Point entities (scene coordinates). */
export interface PointSource {
  positions: ArrayLike<number>;
  stride?: number;
  layer: string;
}

export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
  /** Distance from the query point. */
  d: number;
  layer: string;
  shape: ShapeKind;
  /** The segment (scene coordinates) for "near" hits and picks. */
  seg?: [number, number, number, number];
}

// ---------------------------------------------------------------------------------------------
// Growable typed arrays

class F32 {
  a = new Float32Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}
class U16 {
  a = new Uint16Array(512);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Uint16Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

// ---------------------------------------------------------------------------------------------
// Arc recognition

const MIN_ARC_SEGMENTS = 4;
const MAX_TURN = (45.5 * Math.PI) / 180;
const MIN_TURN = (0.25 * Math.PI) / 180;

function turn(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/** Collects segments and snap points of one coordinate space, then builds its grid. */
class GeomBuilder {
  segs = new F32();
  segLayer = new U16();
  segShape: number[] = [];
  pts = new F32();
  ptLayer = new U16();
  ptKind: number[] = [];
  ptShape: number[] = [];

  addPoint(x: number, y: number, kind: SnapKind, shape: ShapeKind, layer: number) {
    this.pts.push(x);
    this.pts.push(y);
    this.ptLayer.push(layer);
    this.ptKind.push(KINDS.indexOf(kind));
    this.ptShape.push(SHAPES.indexOf(shape));
  }

  addSeg(ax: number, ay: number, bx: number, by: number, shape: ShapeKind, layer: number) {
    this.segs.push(ax);
    this.segs.push(ay);
    this.segs.push(bx);
    this.segs.push(by);
    this.segLayer.push(layer);
    this.segShape.push(SHAPES.indexOf(shape));
  }

  /** One connected chain of vertices (flat x, y list). */
  addChain(v: number[], layer: number) {
    const n = v.length / 2;
    const m = n - 1;
    if (m < 1) return;
    const closed = n > 2 && v[0] === v[2 * m] && v[1] === v[2 * m + 1];
    // Segment lengths and turn angles.
    const len = new Float64Array(m);
    for (let j = 0; j < m; j++) len[j] = Math.hypot(v[2 * j + 2]! - v[2 * j]!, v[2 * j + 3]! - v[2 * j + 1]!);
    const turnAt = (j: number) =>
      turn(v[2 * j]! - v[2 * j - 2]!, v[2 * j + 1]! - v[2 * j - 1]!, v[2 * j + 2]! - v[2 * j]!, v[2 * j + 3]! - v[2 * j + 1]!);
    // arc[j] = run id of segment j (-1: not an arc).
    const arc = new Int32Array(m).fill(-1);
    const runs: { s: number; e: number; t: number }[] = [];
    for (let j = 0; j < m - 1; ) {
      const t0 = turnAt(j + 1);
      const L = len[j]!;
      const at = Math.abs(t0);
      let e = j;
      if (at >= MIN_TURN && at <= MAX_TURN && L > 0) {
        const tolT = 0.05 * at + 1e-3;
        while (e + 1 < m && Math.abs(len[e + 1]! - L) <= 0.02 * L && Math.abs(turnAt(e + 1) - t0) <= tolT) e++;
      }
      if (e - j + 1 >= MIN_ARC_SEGMENTS) {
        for (let k = j; k <= e; k++) arc[k] = runs.length;
        runs.push({ s: j, e, t: t0 });
        j = e + 1;
      } else j++;
    }
    const interior = new Uint8Array(n);
    for (const r of runs) {
      const k = r.e - r.s + 1;
      const full = Math.abs(r.t) * k >= 2 * Math.PI - Math.abs(r.t) * 0.5;
      const shape: ShapeKind = full ? "circle" : "arc";
      const i0 = r.s;
      const i2 = r.e + 1;
      const i1 = full ? r.s + Math.floor(k / 3) : r.s + Math.floor(k / 2);
      const i3 = full ? r.s + Math.floor((2 * k) / 3) : i2;
      const c = circumcenter(v[2 * i0]!, v[2 * i0 + 1]!, v[2 * i1]!, v[2 * i1 + 1]!, v[2 * i3]!, v[2 * i3 + 1]!);
      if (c) {
        this.addPoint(c.x, c.y, "center", shape, layer);
        if (!full) {
          // Arc midpoint: middle vertex, or the middle segment's midpoint pushed out to the radius.
          const R = Math.hypot(v[2 * i0]! - c.x, v[2 * i0 + 1]! - c.y);
          let mx: number;
          let my: number;
          if (k % 2 === 0) {
            mx = v[2 * (r.s + k / 2)]!;
            my = v[2 * (r.s + k / 2) + 1]!;
          } else {
            const q = r.s + (k - 1) / 2;
            mx = (v[2 * q]! + v[2 * q + 2]!) / 2;
            my = (v[2 * q + 1]! + v[2 * q + 3]!) / 2;
            const d = Math.hypot(mx - c.x, my - c.y) || 1;
            mx = c.x + ((mx - c.x) * R) / d;
            my = c.y + ((my - c.y) * R) / d;
          }
          this.addPoint(mx, my, "mid", shape, layer);
        }
      }
      for (let i = r.s + 1; i <= r.e; i++) interior[i] = 1;
      if (full) {
        interior[r.s] = 1;
        interior[r.e + 1] = 1;
      }
      for (let j = r.s; j <= r.e; j++) this.addSeg(v[2 * j]!, v[2 * j + 1]!, v[2 * j + 2]!, v[2 * j + 3]!, shape, layer);
    }
    const plain: ShapeKind = m === 1 ? "line" : "polyline";
    for (let j = 0; j < m; j++) {
      if (arc[j]! >= 0) continue;
      const ax = v[2 * j]!;
      const ay = v[2 * j + 1]!;
      const bx = v[2 * j + 2]!;
      const by = v[2 * j + 3]!;
      this.addSeg(ax, ay, bx, by, plain, layer);
      this.addPoint((ax + bx) / 2, (ay + by) / 2, "mid", plain, layer);
    }
    const last = closed ? n - 1 : n;
    // An endpoint takes the shape of its segments (the ends of an arc run are the arc's ends).
    const onArc = (i: number) => (i > 0 && arc[i - 1]! >= 0) || (i < m && arc[i]! >= 0);
    for (let i = 0; i < last; i++) if (!interior[i]) this.addPoint(v[2 * i]!, v[2 * i + 1]!, "end", onArc(i) ? "arc" : plain, layer);
  }

  addLines(src: LineSource, layer: number) {
    const P = src.positions;
    const st = src.stride ?? 2;
    const I = src.indices;
    const nSeg = I ? Math.floor(I.length / 2) : Math.floor(P.length / st / 2);
    let chain: number[] = [];
    let lastIdx = -1;
    for (let k = 0; k < nSeg; k++) {
      const ia = I ? I[2 * k]! : 2 * k;
      const ib = I ? I[2 * k + 1]! : 2 * k + 1;
      const ax = P[ia * st]!;
      const ay = P[ia * st + 1]!;
      const bx = P[ib * st]!;
      const by = P[ib * st + 1]!;
      if (!Number.isFinite(ax + ay + bx + by)) continue;
      const cont = chain.length > 0 && (I ? ia === lastIdx : ax === chain[chain.length - 2] && ay === chain[chain.length - 1]);
      if (!cont) {
        if (chain.length) this.addChain(chain, layer);
        chain = [ax, ay];
      }
      chain.push(bx, by);
      lastIdx = ib;
    }
    if (chain.length) this.addChain(chain, layer);
  }

  build(): GeomIndex {
    return new GeomIndex(this.segs.done(), this.segLayer.done(), Uint8Array.from(this.segShape), this.pts.done(), this.ptLayer.done(), Uint8Array.from(this.ptKind), Uint8Array.from(this.ptShape));
  }
}

// ---------------------------------------------------------------------------------------------
// Grid

const BRUTE_FORCE = 48;
const MAX_QUERY_CELLS = 20000;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Best hits of one query, in the index's own coordinates. */
interface LocalHits {
  point: { i: number; d2: number } | null;
  seg: { i: number; d2: number; x: number; y: number } | null;
}

/** Segments and snap points of one coordinate space with a uniform grid (CSR layout). */
export class GeomIndex {
  readonly bounds: Box;
  private cell = 1;
  private nx = 0;
  private ny = 0;
  private cellStart: Uint32Array | null = null;
  /** ≥ 0: segment index; < 0: point -(i + 1). */
  private cellItems: Int32Array | null = null;
  private segStamp: Uint32Array;
  private ptStamp: Uint32Array;
  private stamp = 0;

  constructor(
    readonly segs: Float32Array,
    readonly segLayer: Uint16Array,
    readonly segShape: Uint8Array,
    readonly pts: Float32Array,
    readonly ptLayer: Uint16Array,
    readonly ptKind: Uint8Array,
    readonly ptShape: Uint8Array,
  ) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < segs.length; i += 2) {
      const x = segs[i]!;
      const y = segs[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.bounds = { minX, minY, maxX, maxY };
    this.segStamp = new Uint32Array(this.segCount);
    this.ptStamp = new Uint32Array(this.ptCount);
    if (this.segCount + this.ptCount > BRUTE_FORCE) this.buildGrid();
  }

  get segCount() {
    return this.segs.length / 4;
  }
  get ptCount() {
    return this.pts.length / 2;
  }

  private buildGrid() {
    const { minX, minY, maxX, maxY } = this.bounds;
    const items = this.segCount + this.ptCount;
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const w = Math.max(maxX - minX, span * 1e-6);
    const h = Math.max(maxY - minY, span * 1e-6);
    const target = Math.min(Math.max(items / 2, 1), 1 << 20);
    this.cell = Math.max(Math.sqrt((w * h) / target), span / 4096);
    this.nx = Math.min(4096, Math.floor(w / this.cell) + 1);
    this.ny = Math.min(4096, Math.floor(h / this.cell) + 1);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    this.forEachItemCell((c) => counts[c]!++);
    const start = new Uint32Array(this.nx * this.ny + 1);
    let acc = 0;
    for (let c = 0; c < this.nx * this.ny; c++) {
      start[c] = acc;
      acc += counts[c]!;
    }
    start[this.nx * this.ny] = acc;
    const fill = start.slice(0, this.nx * this.ny);
    const out = new Int32Array(acc);
    this.forEachItemCell((c, item) => {
      out[fill[c]!++] = item;
    });
    this.cellStart = start;
    this.cellItems = out;
  }

  private cx(x: number) {
    const i = Math.floor((x - this.bounds.minX) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }
  private cy(y: number) {
    const j = Math.floor((y - this.bounds.minY) / this.cell);
    return j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
  }

  /** Every (cell, item) pair; segments are walked in steps no longer than a cell. */
  private forEachItemCell(cb: (cell: number, item: number) => void) {
    const s = this.segs;
    const ring = new Int32Array(8);
    for (let k = 0; k < this.segCount; k++) {
      const ax = s[4 * k]!;
      const ay = s[4 * k + 1]!;
      const bx = s[4 * k + 2]!;
      const by = s[4 * k + 3]!;
      const steps = Math.min(8192, Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / this.cell)));
      ring.fill(-1);
      let r = 0;
      for (let t = 0; t < steps; t++) {
        const x0 = ax + ((bx - ax) * t) / steps;
        const y0 = ay + ((by - ay) * t) / steps;
        const x1 = ax + ((bx - ax) * (t + 1)) / steps;
        const y1 = ay + ((by - ay) * (t + 1)) / steps;
        const i0 = this.cx(Math.min(x0, x1));
        const i1 = this.cx(Math.max(x0, x1));
        const j0 = this.cy(Math.min(y0, y1));
        const j1 = this.cy(Math.max(y0, y1));
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const c = j * this.nx + i;
            if (ring.includes(c)) continue;
            ring[r] = c;
            r = (r + 1) & 7;
            cb(c, k);
          }
      }
    }
    for (let p = 0; p < this.ptCount; p++) cb(this.cy(this.pts[2 * p + 1]!) * this.nx + this.cx(this.pts[2 * p]!), -(p + 1));
  }

  /** Closest snap point and closest segment within r (own coordinates). */
  query(x: number, y: number, r: number, hidden: Uint8Array | null, points = true): LocalHits {
    const out: LocalHits = { point: null, seg: null };
    const r2 = r * r;
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    const st = this.stamp;
    const visitSeg = (k: number) => {
      if (this.segStamp[k] === st) return;
      this.segStamp[k] = st;
      if (hidden && hidden[this.segLayer[k]!]) return;
      const s = this.segs;
      const c = closestOnSegment(x, y, s[4 * k]!, s[4 * k + 1]!, s[4 * k + 2]!, s[4 * k + 3]!);
      if (c.d2 <= r2 && (!out.seg || c.d2 < out.seg.d2)) out.seg = { i: k, d2: c.d2, x: c.x, y: c.y };
    };
    const visitPt = (p: number) => {
      if (!points || this.ptStamp[p] === st) return;
      this.ptStamp[p] = st;
      if (hidden && hidden[this.ptLayer[p]!]) return;
      const dx = this.pts[2 * p]! - x;
      const dy = this.pts[2 * p + 1]! - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      const best = out.point;
      // Ties (same spot): Uç Nokta before Orta Nokta before Merkez.
      if (!best || d2 < best.d2 * 0.999999 || (d2 <= best.d2 * 1.000001 && this.ptKind[p]! < this.ptKind[best.i]!)) out.point = { i: p, d2 };
    };
    if (!this.cellStart || !this.cellItems) {
      for (let k = 0; k < this.segCount; k++) visitSeg(k);
      for (let p = 0; p < this.ptCount; p++) visitPt(p);
      return out;
    }
    const b = this.bounds;
    if (x + r < b.minX || x - r > b.maxX || y + r < b.minY || y - r > b.maxY) return out;
    const i0 = this.cx(x - r);
    const i1 = this.cx(x + r);
    const j0 = this.cy(y - r);
    const j1 = this.cy(y + r);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_QUERY_CELLS) return out;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i;
        for (let q = this.cellStart[c]!; q < this.cellStart[c + 1]!; q++) {
          const it = this.cellItems[q]!;
          if (it >= 0) visitSeg(it);
          else visitPt(-it - 1);
        }
      }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Grid of boxes (block instances)

const MAX_BOX_CELLS = 256;

/** Axis-aligned boxes (minX, minY, maxX, maxY per box) in a uniform grid; big boxes are kept aside. */
export class BoxGrid {
  private minX = Infinity;
  private minY = Infinity;
  private cell = 1;
  private nx = 1;
  private ny = 1;
  private start: Uint32Array;
  private items: Uint32Array;
  private big: number[] = [];
  private seen: Uint32Array;
  private stamp = 0;

  constructor(private readonly boxes: Float64Array) {
    const n = boxes.length / 4;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      this.minX = Math.min(this.minX, boxes[4 * k]!);
      this.minY = Math.min(this.minY, boxes[4 * k + 1]!);
      maxX = Math.max(maxX, boxes[4 * k + 2]!);
      maxY = Math.max(maxY, boxes[4 * k + 3]!);
      sum += Math.max(boxes[4 * k + 2]! - boxes[4 * k]!, boxes[4 * k + 3]! - boxes[4 * k + 1]!);
    }
    const span = Math.max(maxX - this.minX, maxY - this.minY, 1e-9);
    // About the typical box size, but not more than ~1M cells.
    this.cell = Math.max(n ? sum / n : span, span / 1024, 1e-12);
    this.nx = Math.min(1024, Math.floor((maxX - this.minX) / this.cell) + 1);
    this.ny = Math.min(1024, Math.floor((maxY - this.minY) / this.cell) + 1);
    const counts = new Uint32Array(this.nx * this.ny);
    const spans: number[] = [];
    for (let k = 0; k < n; k++) {
      const i0 = this.ix(boxes[4 * k]!);
      const i1 = this.ix(boxes[4 * k + 2]!);
      const j0 = this.iy(boxes[4 * k + 1]!);
      const j1 = this.iy(boxes[4 * k + 3]!);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_BOX_CELLS) {
        this.big.push(k);
        spans.push(-1, 0, 0, 0);
        continue;
      }
      spans.push(i0, i1, j0, j1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * this.nx + i]!++;
    }
    this.start = new Uint32Array(this.nx * this.ny + 1);
    let acc = 0;
    for (let c = 0; c < counts.length; c++) {
      this.start[c] = acc;
      acc += counts[c]!;
    }
    this.start[counts.length] = acc;
    const fill = this.start.slice(0, counts.length);
    this.items = new Uint32Array(acc);
    for (let k = 0; k < n; k++) {
      const i0 = spans[4 * k]!;
      if (i0 < 0) continue;
      for (let j = spans[4 * k + 2]!; j <= spans[4 * k + 3]!; j++) for (let i = i0; i <= spans[4 * k + 1]!; i++) this.items[fill[j * this.nx + i]!++] = k;
    }
    this.seen = new Uint32Array(n);
  }

  private ix(x: number) {
    const i = Math.floor((x - this.minX) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }
  private iy(y: number) {
    const j = Math.floor((y - this.minY) / this.cell);
    return j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
  }

  /** Every box whose cells touch the square around (x, y) (each once; callers test the box). */
  forEachNear(x: number, y: number, r: number, cb: (k: number) => void) {
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    const st = this.stamp;
    for (const k of this.big) cb(k);
    const i0 = this.ix(x - r);
    const i1 = this.ix(x + r);
    const j0 = this.iy(y - r);
    const j1 = this.iy(y + r);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_QUERY_CELLS) return;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i;
        for (let q = this.start[c]!; q < this.start[c + 1]!; q++) {
          const k = this.items[q]!;
          if (this.seen[k] === st) continue;
          this.seen[k] = st;
          cb(k);
        }
      }
  }
}

// ---------------------------------------------------------------------------------------------
// Scene snapper: world geometry + block instances

interface InstanceGroup {
  geom: GeomIndex;
  layer: number;
  /** 6 per instance (a, b, tx, c, d, ty). */
  m: Float64Array;
}

function inverse(m: Float64Array, o: number): [number, number, number, number, number, number] | null {
  const a = m[o]!;
  const b = m[o + 1]!;
  const tx = m[o + 2]!;
  const c = m[o + 3]!;
  const d = m[o + 4]!;
  const ty = m[o + 5]!;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/** Smallest scale of the linear part (smallest singular value). */
function minScale(a: number, b: number, c: number, d: number): number {
  const p = a * a + b * b + c * c + d * d;
  const q = Math.abs(a * d - b * c);
  const s = Math.sqrt(Math.max(0, p * p - 4 * q * q));
  return Math.sqrt(Math.max(0, (p - s) / 2));
}

export class SceneSnapper {
  private layerIds = new Map<string, number>();
  private layerNames: string[] = [];
  private hidden: Uint8Array = new Uint8Array(0);
  private world: GeomIndex;
  private groups: InstanceGroup[] = [];
  /** Instances: group, index, world AABB. */
  private instGroup: Uint32Array;
  private instIndex: Uint32Array;
  private instBox: Float64Array;
  private instGrid: BoxGrid | null = null;
  readonly segmentCount: number;

  constructor(lines: LineSource[], points: PointSource[] = []) {
    const world = new GeomBuilder();
    const shared = new Map<object, GeomIndex>();
    const groups: { src: LineSource; geom: GeomIndex }[] = [];
    let count = 0;
    for (const src of lines) {
      const layer = this.layerId(src.layer);
      if (!src.instances || !src.instances.length) {
        world.addLines(src, layer);
        continue;
      }
      const key = src.key ?? src;
      let geom = shared.get(key);
      if (!geom) {
        const b = new GeomBuilder();
        b.addLines(src, 0);
        geom = b.build();
        shared.set(key, geom);
      }
      if (geom.segCount + geom.ptCount) groups.push({ src, geom });
    }
    for (const p of points) {
      const layer = this.layerId(p.layer);
      const st = p.stride ?? 2;
      for (let i = 0; i + 1 < p.positions.length; i += st) {
        const x = p.positions[i]!;
        const y = p.positions[i + 1]!;
        if (Number.isFinite(x + y)) world.addPoint(x, y, "end", "point", layer);
      }
    }
    this.world = world.build();
    count += this.world.segCount;

    // Instances: their world boxes go into a grid of their own.
    const ig: number[] = [];
    const ii: number[] = [];
    const ib: number[] = [];
    for (const { src, geom } of groups) {
      const n = Math.floor(src.instances!.length / 6);
      const g: InstanceGroup = { geom, layer: this.layerId(src.layer), m: Float64Array.from(src.instances!) };
      const gi = this.groups.push(g) - 1;
      const bb = geom.bounds;
      for (let k = 0; k < n; k++) {
        const o = 6 * k;
        const [a, b, tx, c, d, ty] = [g.m[o]!, g.m[o + 1]!, g.m[o + 2]!, g.m[o + 3]!, g.m[o + 4]!, g.m[o + 5]!];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of [
          [bb.minX, bb.minY],
          [bb.maxX, bb.minY],
          [bb.minX, bb.maxY],
          [bb.maxX, bb.maxY],
        ] as const) {
          const wx = a * x + b * y + tx;
          const wy = c * x + d * y + ty;
          minX = Math.min(minX, wx);
          maxX = Math.max(maxX, wx);
          minY = Math.min(minY, wy);
          maxY = Math.max(maxY, wy);
        }
        if (!Number.isFinite(minX + minY + maxX + maxY)) continue;
        ig.push(gi);
        ii.push(k);
        ib.push(minX, minY, maxX, maxY);
        count += geom.segCount;
      }
    }
    this.instGroup = Uint32Array.from(ig);
    this.instIndex = Uint32Array.from(ii);
    this.instBox = Float64Array.from(ib);
    if (ig.length) this.instGrid = new BoxGrid(this.instBox);
    this.segmentCount = count;
  }

  private layerId(name: string): number {
    let id = this.layerIds.get(name);
    if (id === undefined) {
      id = Math.min(this.layerNames.length, 0xffff);
      this.layerIds.set(name, id);
      this.layerNames.push(name);
    }
    return id;
  }

  /** Layers whose geometry is not snapped / picked (hidden layers). */
  setHiddenLayers(names: Iterable<string>) {
    this.hidden = new Uint8Array(this.layerNames.length + 1);
    for (const n of names) {
      const id = this.layerIds.get(n);
      if (id !== undefined) this.hidden[id] = 1;
    }
  }

  /**
   * Snap near (x, y) within radius r (scene coordinates): the closest end/mid/centre point,
   * else the closest point on a segment ("Üzerinde"); null when nothing is near.
   */
  snap(x: number, y: number, r: number): SnapHit | null {
    return this.find(x, y, r, true);
  }

  /** The closest segment within r (for "Bilgi"): its layer and shape. */
  pick(x: number, y: number, r: number): SnapHit | null {
    return this.find(x, y, r, false);
  }

  private find(x: number, y: number, r: number, points: boolean): SnapHit | null {
    let bestPt: SnapHit | null = null;
    let bestSeg: SnapHit | null = null;
    const take = (geom: GeomIndex, hits: LocalHits, layerOf: (i: number, seg: boolean) => number, map: ((x: number, y: number) => Pt) | null) => {
      if (hits.point) {
        const p = hits.point.i;
        const w = map ? map(geom.pts[2 * p]!, geom.pts[2 * p + 1]!) : { x: geom.pts[2 * p]!, y: geom.pts[2 * p + 1]! };
        const d = Math.hypot(w.x - x, w.y - y);
        const kind = KINDS[geom.ptKind[p]!]!;
        if (d <= r && (!bestPt || d < bestPt.d || (d === bestPt.d && KINDS.indexOf(kind) < KINDS.indexOf(bestPt.kind))))
          bestPt = { x: w.x, y: w.y, kind, d, layer: this.layerNames[layerOf(p, false)] ?? "0", shape: SHAPES[geom.ptShape[p]!]! };
      }
      if (hits.seg) {
        const k = hits.seg.i;
        const s = geom.segs;
        const a = map ? map(s[4 * k]!, s[4 * k + 1]!) : { x: s[4 * k]!, y: s[4 * k + 1]! };
        const b = map ? map(s[4 * k + 2]!, s[4 * k + 3]!) : { x: s[4 * k + 2]!, y: s[4 * k + 3]! };
        const c = closestOnSegment(x, y, a.x, a.y, b.x, b.y);
        const d = Math.sqrt(c.d2);
        if (d <= r && (!bestSeg || d < bestSeg.d))
          bestSeg = { x: c.x, y: c.y, kind: "near", d, layer: this.layerNames[layerOf(k, true)] ?? "0", shape: SHAPES[geom.segShape[k]!]!, seg: [a.x, a.y, b.x, b.y] };
      }
    };
    const hidden = this.hidden.length ? this.hidden : null;
    take(this.world, this.world.query(x, y, r, hidden, points), (i, seg) => (seg ? this.world.segLayer[i]! : this.world.ptLayer[i]!), null);
    if (this.instGrid) {
      this.instGrid.forEachNear(x, y, r, (k) => {
        const bx = this.instBox;
        if (x + r < bx[4 * k]! || x - r > bx[4 * k + 2]! || y + r < bx[4 * k + 1]! || y - r > bx[4 * k + 3]!) return;
        const g = this.groups[this.instGroup[k]!]!;
        if (hidden && hidden[g.layer]) return;
        const o = 6 * this.instIndex[k]!;
        const inv = inverse(g.m, o);
        if (!inv) return;
        const s = minScale(g.m[o]!, g.m[o + 1]!, g.m[o + 3]!, g.m[o + 4]!);
        if (!(s > 0)) return;
        const lx = inv[0] * x + inv[1] * y + inv[2];
        const ly = inv[3] * x + inv[4] * y + inv[5];
        const hits = g.geom.query(lx, ly, r / s, null, points);
        const m = g.m;
        take(g.geom, hits, () => g.layer, (px, py) => ({ x: m[o]! * px + m[o + 1]! * py + m[o + 2]!, y: m[o + 3]! * px + m[o + 4]! * py + m[o + 5]! }));
      });
    }
    if (!points) return bestSeg;
    return bestPt ?? bestSeg;
  }
}
