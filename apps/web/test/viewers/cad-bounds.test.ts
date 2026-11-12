import { describe, expect, it } from "vitest";
import { mainInterval, robustBounds } from "../../src/viewers/cad/bounds";

/** Deterministic pseudo-random numbers (no flaky tests). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function cluster(cx: number, cy: number, w: number, h: number, n: number, seed = 1): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(cx + (r() - 0.5) * w, cy + (r() - 0.5) * h);
  return out;
}

/** Text-like clumps: many tiny triangles (glyph vertices) in rows, as the scene has them. */
function textRows(x0: number, y0: number, w: number, h: number, rows: number, perRow: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  const size = h / rows / 3;
  for (let row = 0; row < rows; row++)
    for (let g = 0; g < perRow; g++) {
      const x = x0 + r() * w;
      const y = y0 + (row + 0.5) * (h / rows);
      for (let t = 0; t < 6; t++) out.push(x + r() * size, y + r() * size);
    }
  return out;
}

/** The live survey sheet (LibreDWG 0.14): main body, layout at 0,0, mirrored blocks at −y, strays. */
function surveySheet(dx = 0, dy = 0): number[] {
  const main = [
    ...cluster(389000, 4548000, 30000, 16000, 60000, 11),
    ...textRows(380000, 4542000, 20000, 12000, 40, 120, 12),
  ];
  // Mirrored blocks (scale −1, −1): about 17% of the points.
  const mirrored = cluster(-389000, -4547000, 30000, 16000, 28000, 13);
  // A layout near 0,0 in paper units with dense text: about 19% of the points.
  const layout = [...textRows(20, 20, 800, 560, 60, 80, 14), ...cluster(420, 297, 840, 594, 2000, 15)];
  const strays = [-8_877_004, 120_000, 4_587_024, -2_000_000, 1_000_000, 5_336_430, -3_000_000, -4_547_682, 7, 2_000_000, -5_000_000, 3_000_000, 250_000, -1_500_000, 900_000, 900_000];
  const all = [...main, ...mirrored, ...layout, ...strays];
  for (let i = 0; i < all.length; i += 2) {
    all[i] = all[i]! - dx;
    all[i + 1] = all[i + 1]! - dy;
  }
  return all;
}

describe("robust drawing extents (Sığdır)", () => {
  it("keeps only the main body of a sheet with a layout at 0,0, mirrored blocks and strays", () => {
    for (const [dx, dy] of [
      [0, 0],
      // The same in scene coordinates (dxf-viewer's origin subtracted).
      [389453.8, 4548533.3],
    ] as const) {
      const b = robustBounds(surveySheet(dx, dy))!;
      expect(b.minX + dx).toBeGreaterThan(373000);
      expect(b.maxX + dx).toBeLessThan(405000);
      expect(b.minY + dy).toBeGreaterThan(4539000);
      expect(b.maxY + dy).toBeLessThan(4557000);
      // Real edges of the main body are kept.
      expect(b.maxX - b.minX).toBeGreaterThan(29000);
      expect(b.maxY - b.minY).toBeGreaterThan(15000);
    }
  });

  it("does not cut a normal multi-view sheet (plan, section, detail, legend, title block, frame)", () => {
    const sheet = [
      // Frame and inner frame corners (lines only have their end vertices).
      ...[0, 0, 840, 0, 840, 594, 0, 594, 10, 10, 830, 10, 830, 584, 10, 584],
      ...cluster(210, 330, 380, 460, 8000, 21),
      ...cluster(630, 455, 380, 210, 4000, 22),
      ...cluster(520, 210, 160, 180, 1500, 23),
      ...textRows(640, 120, 180, 180, 20, 20, 24),
      ...textRows(600, 15, 230, 75, 8, 80, 25),
    ];
    const b = robustBounds(sheet)!;
    expect(b).toMatchObject({ minX: 0, minY: 0, maxX: 840, maxY: 594, outliers: 0 });
  });

  it("keeps separate views of one sheet together but drops a far cluster (one axis)", () => {
    const sorted = (v: number[]) => Float64Array.from(v).sort();
    const views = [...Array.from({ length: 300 }, (_, i) => i / 3), ...Array.from({ length: 200 }, (_, i) => 130 + i / 10)];
    expect(mainInterval(sorted(views))).toBeNull();
    expect(mainInterval(sorted([...views, 5000, 5001]))).toEqual([0, 149.9]);
    // Two drawings of similar weight: no single main body, nothing cut.
    expect(mainInterval(sorted([...views, ...views.map((v) => v + 10000)]))).toBeNull();
  });

  it("leaves out a stray point at 0,0 of a survey drawing in UTM coordinates", () => {
    const xy = [...cluster(423000, 4550700, 2000, 1500, 20000), 0, 0];
    const b = robustBounds(xy)!;
    expect(b.outliers).toBe(1);
    expect(b.minX).toBeGreaterThan(421900);
    expect(b.maxX).toBeLessThan(424100);
    expect(b.minY).toBeGreaterThan(4549900);
    expect(b.maxY).toBeLessThan(4551500);
    // The real edges of the main body are kept (not cut at the percentiles).
    expect(b.minX).toBeLessThan(422010);
    expect(b.maxX).toBeGreaterThan(423990);
  });

  it("leaves out a small stray cluster (a few entities near the origin)", () => {
    const xy = [...cluster(423000, 4550700, 3000, 3000, 50000, 2), ...cluster(5, 5, 10, 10, 200, 3)];
    const b = robustBounds(xy)!;
    expect(b.outliers).toBe(200);
    expect(b.minX).toBeGreaterThan(400000);
  });

  it("leaves out paper-space entities near 0,0 and scattered far entities (more than a few percent)", () => {
    // Like a real survey sheet: model space in UTM metres, ~7% of the vertices in a layout near
    // the origin, single hatches/inserts at absurd coordinates.
    const xy = [
      ...cluster(412000, 4550000, 25000, 8000, 70000, 8),
      ...cluster(500, 300, 1000, 600, 5600, 9),
      -8_550_000, 650_000, -4_100_000, 3_700_000, 4_700_000, 2_950_000, 150_000, 0, 300_000, 0, 350_000, 45_500_000,
    ];
    const b = robustBounds(xy)!;
    expect(b.outliers).toBe(5600 + 6);
    expect(b.minX).toBeGreaterThan(399000);
    expect(b.maxX).toBeLessThan(425000);
    expect(b.minY).toBeGreaterThan(4545000);
    expect(b.maxY).toBeLessThan(4555000);
  });

  it("keeps a legend or title block beside the drawing", () => {
    const xy = [...cluster(50, 50, 100, 100, 5000, 4), ...cluster(140, 20, 20, 30, 300, 5)];
    const b = robustBounds(xy)!;
    expect(b.outliers).toBe(0);
    expect(b.maxX).toBeGreaterThan(149);
  });

  it("gives the full extent when there is no single main body", () => {
    const xy = [...cluster(0, 0, 10, 10, 1000, 6), ...cluster(10000, 0, 10, 10, 1000, 7)];
    const b = robustBounds(xy)!;
    expect(b.outliers).toBe(0);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(10000);
  });

  it("handles degenerate input", () => {
    expect(robustBounds([])).toBeNull();
    expect(robustBounds([NaN, 1])).toBeNull();
    expect(robustBounds([3, 4])).toMatchObject({ minX: 3, maxX: 3, minY: 4, maxY: 4, outliers: 0 });
    // All points on a horizontal line.
    const line: number[] = [];
    for (let i = 0; i <= 100; i++) line.push(i, 7);
    expect(robustBounds([...line, -1e6, 7])).toMatchObject({ minX: 0, maxX: 100, minY: 7, maxY: 7, outliers: 1 });
  });
});
