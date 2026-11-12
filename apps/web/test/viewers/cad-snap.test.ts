import { describe, expect, it } from "vitest";
import { sceneSources, scenePoints, type SceneObjectLike } from "../../src/viewers/cad/scene-geometry";
import { SceneSnapper, type LineSource } from "../../src/viewers/cad/snap-index";

/** A tessellated circle as dxf-viewer batches it: indexed line pairs, closed back to vertex 0. */
function circle(cx: number, cy: number, r: number, n = 36, layer = "C"): LineSource {
  const positions = new Float32Array(2 * n);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    positions[2 * i] = cx + r * Math.cos((2 * Math.PI * i) / n);
    positions[2 * i + 1] = cy + r * Math.sin((2 * Math.PI * i) / n);
    indices.push(i, (i + 1) % n);
  }
  return { positions, indices: Uint16Array.from(indices), layer };
}

/** Open arc from a0 to a1 (radians) in n segments. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number, layer = "A"): LineSource {
  const positions = new Float32Array(2 * (n + 1));
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    positions[2 * i] = cx + r * Math.cos(a);
    positions[2 * i + 1] = cy + r * Math.sin(a);
    if (i < n) indices.push(i, i + 1);
  }
  return { positions, indices: Uint16Array.from(indices), layer };
}

/** Separate LINE entities: consecutive vertex pairs. */
function lines(segs: [number, number, number, number][], layer = "L"): LineSource {
  return { positions: Float32Array.from(segs.flat()), layer };
}

/** Closed polyline (rectangle) as indexed pairs. */
function rect(x0: number, y0: number, x1: number, y1: number, layer = "R"): LineSource {
  return { positions: Float32Array.from([x0, y0, x1, y0, x1, y1, x0, y1]), indices: Uint16Array.from([0, 1, 1, 2, 2, 3, 3, 0]), layer };
}

describe("CAD snapping (snap-index.ts)", () => {
  const s = new SceneSnapper([rect(0, 0, 100, 50), circle(200, 200, 20), arc(400, 0, 30, 0, Math.PI / 2, 9), lines([[500, 0, 600, 0]])]);

  it("snaps to endpoints and midpoints of polylines and lines", () => {
    expect(s.snap(101, 49, 3)).toMatchObject({ kind: "end", x: 100, y: 50, layer: "R", shape: "polyline" });
    expect(s.snap(50.5, 1, 3)).toMatchObject({ kind: "mid", x: 50, y: 0, layer: "R" });
    expect(s.snap(549, 1, 3)).toMatchObject({ kind: "mid", x: 550, y: 0, layer: "L", shape: "line" });
    expect(s.snap(599, 0.5, 3)).toMatchObject({ kind: "end", x: 600, y: 0 });
  });

  it("finds circle centres and does not offer tessellation vertices as endpoints", () => {
    const c = s.snap(201, 199, 3)!;
    expect(c.kind).toBe("center");
    expect(c.shape).toBe("circle");
    expect(c.x).toBeCloseTo(200, 3);
    expect(c.y).toBeCloseTo(200, 3);
    // A circle vertex (at angle 0) is "on" the circle, not an endpoint.
    const v = s.snap(220.5, 0.2 + 200, 2)!;
    expect(v.kind).toBe("near");
    expect(v.shape).toBe("circle");
  });

  it("recognises an arc: centre, its two ends and its midpoint", () => {
    const c = s.snap(401, 1, 3)!;
    expect(c).toMatchObject({ kind: "center", shape: "arc" });
    expect(c.x).toBeCloseTo(400, 3);
    expect(s.snap(430.5, 0.5, 2)).toMatchObject({ kind: "end", shape: "arc" });
    const mid = s.snap(400 + 30 * Math.SQRT1_2 + 0.5, 30 * Math.SQRT1_2, 2)!;
    expect(mid.kind).toBe("mid");
    expect(mid.x).toBeCloseTo(400 + 30 * Math.SQRT1_2, 3);
    expect(mid.y).toBeCloseTo(30 * Math.SQRT1_2, 3);
  });

  it("falls back to the nearest point on a segment, and to nothing", () => {
    expect(s.snap(30, 2, 3)).toMatchObject({ kind: "near", x: 30, y: 0, layer: "R" });
    expect(s.snap(30, 20, 3)).toBeNull();
  });

  it("picks the nearest segment with its layer and shape (Bilgi)", () => {
    expect(s.pick(50, 2, 5)).toMatchObject({ layer: "R", shape: "polyline", seg: [0, 0, 100, 0] });
    expect(s.pick(200, 221, 3)).toMatchObject({ layer: "C", shape: "circle" });
  });

  it("ignores hidden layers", () => {
    const h = new SceneSnapper([rect(0, 0, 100, 50, "R"), lines([[0, 0, 0, 80]], "L")]);
    h.setHiddenLayers(["R"]);
    expect(h.snap(100, 50, 3)).toBeNull();
    expect(h.snap(0.5, 40, 2)).toMatchObject({ layer: "L", kind: "mid" });
    h.setHiddenLayers([]);
    expect(h.snap(100, 50, 3)).toMatchObject({ layer: "R", kind: "end" });
  });

  it("snaps to block instances with their transforms (rotation, scale, translation)", () => {
    const block = rect(0, 0, 10, 5, "ignored");
    const key = {};
    // Instance 1: 90° rotation, scale 2, at (100, 50): local (10, 5) → (100 - 10, 50 + 20) = (90, 70).
    // Instance 2: identity at (1000, 0).
    const instances = [0, -2, 100, 2, 0, 50, 1, 0, 1000, 0, 1, 0];
    const b = new SceneSnapper([{ ...block, layer: "INSERTS", instances, key }]);
    expect(b.snap(90.5, 70.5, 2)).toMatchObject({ kind: "end", x: 90, y: 70, layer: "INSERTS" });
    expect(b.snap(1010.4, 5.2, 1)).toMatchObject({ kind: "end", x: 1010, y: 5 });
    expect(b.snap(1005, 0.3, 1)).toMatchObject({ kind: "mid", x: 1005, y: 0 });
    expect(b.pick(1003, 0.5, 1)).toMatchObject({ layer: "INSERTS", seg: [1000, 0, 1010, 0] });
    b.setHiddenLayers(["INSERTS"]);
    expect(b.snap(90, 70, 2)).toBeNull();
  });

  it("stays fast with ~600k segments", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const n = 600_000;
    const pos = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = r() * 20000;
      const y = r() * 20000;
      pos.set([x, y, x + (r() - 0.5) * 40, y + (r() - 0.5) * 40], 4 * i);
    }
    // A few very long lines too (they cross many cells).
    pos.set([0, 0, 20000, 20000, 0, 20000, 20000, 0], 0);
    const t0 = performance.now();
    const big = new SceneSnapper([{ positions: pos, layer: "0" }]);
    const build = performance.now() - t0;
    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < 5000; i++) if (big.snap(r() * 20000, r() * 20000, 15)) hits++;
    const query = performance.now() - t1;
    expect(big.segmentCount).toBe(n);
    expect(hits).toBeGreaterThan(0);
    expect(build).toBeLessThan(8000);
    expect(query).toBeLessThan(2000);
  }, 30_000);
});

describe("CAD scene geometry (scene-geometry.ts)", () => {
  // three.js-like objects: plain and interleaved attributes, as dxf-viewer creates them.
  const attr = (array: ArrayLike<number>, itemSize: number) => ({ array, itemSize, count: array.length / itemSize });
  const transforms = new Float32Array([1, 0, 50, 0, 1, 60, 2, 0, 0, 0, 2, 0]);
  const buf = { array: transforms, stride: 6, count: 2 };
  const objects: SceneObjectLike[] = [
    { isLineSegments: true, geometry: { attributes: { position: attr(new Float32Array([0, 0, 10, 0]), 2) } }, _dxfViewerLayer: { name: "L" } },
    {
      isLineSegments: true,
      geometry: {
        attributes: {
          position: attr(new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]), 2),
          instanceTransform0: { itemSize: 3, count: 2, data: buf, offset: 0, isInterleavedBufferAttribute: true },
          instanceTransform1: { itemSize: 3, count: 2, data: buf, offset: 3, isInterleavedBufferAttribute: true },
        },
        index: { array: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0]) },
      },
      _dxfViewerLayer: { name: "B" },
    },
    { isPoints: true, geometry: { attributes: { position: attr(new Float32Array([7, 7]), 2) } }, _dxfViewerLayer: { name: "P" } },
    // Meshes (text, fills) are not snapped.
    { geometry: { attributes: { position: attr(new Float32Array([0, 0, 1, 0, 0, 1]), 2) } } },
  ];

  it("reads line batches, block instances and points", () => {
    const { lines, points } = sceneSources(objects);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.instances && Array.from(lines[1]!.instances)).toEqual([1, 0, 50, 0, 1, 60, 2, 0, 0, 0, 2, 0]);
    expect(points).toHaveLength(1);
    const s = new SceneSnapper(lines, points);
    expect(s.snap(54.2, 64.1, 1)).toMatchObject({ kind: "end", x: 54, y: 64, layer: "B" });
    expect(s.snap(8, 8.2, 1)).toMatchObject({ kind: "end", x: 8, y: 8, layer: "B" });
    expect(s.snap(7, 7.1, 0.5)).toMatchObject({ kind: "end", shape: "point", layer: "P" });
    expect(s.snap(5, 0.1, 1)).toMatchObject({ kind: "mid", layer: "L" });
  });

  it("samples vertices for the extents, instances as transformed boxes", () => {
    const xy = Array.from(scenePoints(objects));
    const pairs: string[] = [];
    for (let i = 0; i < xy.length; i += 2) pairs.push(`${xy[i]},${xy[i + 1]}`);
    expect(pairs).toEqual(expect.arrayContaining(["10,0", "50,60", "54,64", "0,0", "8,8", "7,7"]));
  });
});
