import { describe, expect, it } from "vitest";
import { consistentWinding } from "../src/index.js";

/** A unit cube, one vertex per face corner (as web-ifc writes it), outward winding, xyz + normal. */
function cube() {
  const faces: [number[][], number[]][] = [
    [[[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [0, 0, -1]],
    [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 0, 1]],
    [[[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0]],
    [[[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [0, 1, 0]],
    [[[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [-1, 0, 0]],
    [[[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0]],
  ];
  const v: number[] = [];
  const ix: number[] = [];
  for (const [corners, n] of faces) {
    const base = v.length / 6;
    for (const c of corners) v.push(...c, ...n);
    ix.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(v), index: new Uint32Array(ix) };
}

function volume(v: Float32Array, ix: Uint32Array) {
  let s = 0;
  const p = (k: number) => [v[k * 6]!, v[k * 6 + 1]!, v[k * 6 + 2]!];
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [p(ix[t]!), p(ix[t + 1]!), p(ix[t + 2]!)] as [number[], number[], number[]];
    s += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return s;
}

const flipTriangle = (ix: Uint32Array, t: number) => ([ix[t * 3 + 1], ix[t * 3 + 2]] = [ix[t * 3 + 2]!, ix[t * 3 + 1]!]);

describe("consistentWinding", () => {
  it("leaves a consistent solid as it is", () => {
    const { vertices, index } = cube();
    const before = Uint32Array.from(index);
    expect(consistentWinding(vertices, index)).toBe(0);
    expect([...index]).toEqual([...before]);
  });

  it("turns the minority of a closed solid back, with their normals", () => {
    const { vertices, index } = cube();
    flipTriangle(index, 2); // top face, both triangles
    flipTriangle(index, 3);
    flipTriangle(index, 6); // one triangle of a side
    expect(volume(vertices, index)).toBeLessThan(1);
    expect(consistentWinding(vertices, index)).toBe(3);
    expect(volume(vertices, index)).toBeCloseTo(1, 6);
  });

  it("does not assume a sign: a solid turned entirely inside out stays as the exporter wrote it", () => {
    const { vertices, index } = cube();
    for (let t = 0; t < 12; t++) flipTriangle(index, t);
    expect(consistentWinding(vertices, index)).toBe(0);
    expect(volume(vertices, index)).toBeCloseTo(-1, 6);
  });

  it("leaves open surfaces alone", () => {
    const { vertices, index } = cube();
    const open = index.slice(0, 30); // the cube without its last face
    flipTriangle(open, 0);
    expect(consistentWinding(vertices, open)).toBe(0);
  });

  it("ignores zero-area slivers (web-ifc leaves some where an arc meets a line)", () => {
    const { vertices, index } = cube();
    flipTriangle(index, 4);
    const sliver = Uint32Array.from([...index, 0, 0, 3, 4, 7, 7]);
    expect(consistentWinding(vertices, sliver)).toBe(1);
    expect(volume(vertices, sliver.subarray(0, 36))).toBeCloseTo(1, 6);
  });
});
