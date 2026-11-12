/** Penetration is the intersection's own thickness, not the overlap of the two element boxes. */
import { describe, expect, it } from "vitest";
import { clearanceClashMeshes, hardClashMeshes } from "../../src/jobs/clash-worker.js";

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const pos = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const tri: number[] = [];
  for (const [a, b, c, d] of quads) tri.push(a, b, c, a, c, d);
  return { pos, tri };
}

function merge(parts: { pos: number[]; tri: number[] }[]) {
  const pos: number[] = [];
  const tri: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...p.pos);
    for (const i of p.tri) tri.push(base + i);
  }
  return { pos, tri };
}

describe("clash penetration depth", () => {
  const wall = box(0, 0, 0, 5, 0.2, 3);
  const duct = box(2.35, -1, 1.35, 2.65, 1, 1.65);

  it("reports the wall thickness when a duct passes through, not a larger box overlap", () => {
    const hit = hardClashMeshes(wall, duct);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(-0.2, 3);
    expect(hit!.point[0]).toBeCloseTo(2.5, 2);
    expect(hit!.point[1]).toBeCloseTo(0.1, 2);
    expect(hit!.point[2]).toBeCloseTo(1.5, 2);
  });

  it("reports the few millimetres a wall nicks a bar, not the wall's own thickness inside a huge box", () => {
    // The bar plus a piece 10 m away makes one element whose box is 10 m wide.
    // The wall (341 mm thick) sits inside that box and enters the bar by 5 mm.
    const crown = merge([box(0, 0, 0, 0.05, 1, 1), box(10, 0, 0, 10.05, 1, 1)]);
    const nicking = box(0.045, 0.2, 0.2, 0.386, 0.8, 0.8);
    const hit = hardClashMeshes(crown, nicking);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(-0.005, 3);
    expect(hit!.distance).toBeGreaterThan(-0.02);
  });

  it("drops a nick thinner than the contact tolerance", () => {
    const crown = merge([box(0, 0, 0, 0.05, 1, 1), box(10, 0, 0, 10.05, 1, 1)]);
    const graze = box(0.04995, 0.2, 0.2, 0.39095, 0.8, 0.8);
    expect(hardClashMeshes(crown, graze)).toBeNull();
  });

  it("ignores a 5 mm nick when the test tolerance is 10 mm", () => {
    const crown = merge([box(0, 0, 0, 0.05, 1, 1), box(10, 0, 0, 10.05, 1, 1)]);
    const nicking = box(0.045, 0.2, 0.2, 0.386, 0.8, 0.8);
    expect(hardClashMeshes(crown, nicking, 0.01)).toBeNull();
  });

  it("does not clash a wall standing in the hole of a ring", () => {
    const ring = merge([
      box(0, 0, 0, 4, 0.05, 2),
      box(0, 3.95, 0, 4, 4, 2),
      box(0, 0, 0, 0.05, 4, 2),
      box(3.95, 0, 0, 4, 4, 2),
    ]);
    const standing = box(1.5, 1.5, 0.2, 1.841, 2.5, 1.8);
    expect(hardClashMeshes(ring, standing)).toBeNull();
  });

  it("does not clash elements that only touch", () => {
    expect(hardClashMeshes(box(0, 0, 0, 1, 0.2, 1), box(0, 0.2, 0, 1, 0.4, 1))).toBeNull();
  });

  it("still reports an element that lies completely inside another", () => {
    const hit = hardClashMeshes(box(0, 0, 0, 2, 2, 2), box(0.9, 0.9, 0.9, 1.1, 1.1, 1.1));
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(-0.2, 3);
  });

  it("still reports a plate inside a slab whose mesh has a gap", () => {
    // IFC exports are not always closed: drop the block's +x face. The ray leaving through the
    // gap reads "outside" while the others read "inside"; the winding number settles it.
    const block = box(0, 0, 0, 2, 2, 2);
    const open = { pos: block.pos, tri: block.tri.slice(0, 18).concat(block.tri.slice(24)) };
    const plate = box(1.0, 1.0, 1.0, 1.2, 1.2, 1.089);
    const hit = hardClashMeshes(open, plate);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeLessThan(0);
  });

  it("uses the same penetration for a clearance test that finds an intersection", () => {
    const hit = clearanceClashMeshes(wall, duct, 0.05);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(-0.2, 3);
    const gap = clearanceClashMeshes(box(0, 0, 0, 1, 0.2, 1), box(0, 0.23, 0, 1, 0.5, 1), 0.05);
    expect(gap!.distance).toBeCloseTo(0.03, 4);
    const touching = clearanceClashMeshes(box(0, 0, 0, 1, 0.2, 1), box(0, 0.2, 0, 1, 0.4, 1), 0.05);
    expect(touching!.distance).toBeCloseTo(0, 6);
  });
});
