/** 2D geometry helpers of the DWG/DXF measuring tools. Pure functions, no DOM. */

export type Pt = { x: number; y: number };

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Sum of the segment lengths; `closed` adds the last → first segment. */
export function polylineLength(pts: Pt[], closed = false): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1]!, pts[0]!);
  return s;
}

/**
 * Polygon area (shoelace), always ≥ 0. Computed relative to the first vertex so that large
 * survey coordinates (e.g. 423000 / 4550700) do not lose precision.
 */
export function polygonArea(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  const o = pts[0]!;
  let s = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    s += (a.x - o.x) * (b.y - o.y) - (b.x - o.x) * (a.y - o.y);
  }
  return Math.abs(s) / 2;
}

/** Angle at `vertex` between the arms to `a` and `c`, in degrees (0…180). */
export function angleDeg(a: Pt, vertex: Pt, c: Pt): number {
  const ux = a.x - vertex.x;
  const uy = a.y - vertex.y;
  const vx = c.x - vertex.x;
  const vy = c.y - vertex.y;
  if ((ux === 0 && uy === 0) || (vx === 0 && vy === 0)) return 0;
  return (Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) * 180) / Math.PI;
}

/** Closest point of segment a–b to p; `t` is the 0…1 parameter, `d2` the squared distance. */
export function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { x: number; y: number; t: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, t, d2: (px - x) * (px - x) + (py - y) * (py - y) };
}

/** Centre of the circle through three points; null when they are (nearly) collinear. */
export function circumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): Pt | null {
  // Relative to a for precision.
  const bx1 = bx - ax;
  const by1 = by - ay;
  const cx1 = cx - ax;
  const cy1 = cy - ay;
  const d = 2 * (bx1 * cy1 - by1 * cx1);
  const scale = Math.max(bx1 * bx1 + by1 * by1, cx1 * cx1 + cy1 * cy1);
  if (!scale || Math.abs(d) < 1e-12 * scale) return null;
  const b2 = bx1 * bx1 + by1 * by1;
  const c2 = cx1 * cx1 + cy1 * cy1;
  return { x: ax + (cy1 * b2 - by1 * c2) / d, y: ay + (bx1 * c2 - cx1 * b2) / d };
}
