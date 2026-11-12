import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cutBaseUnderOverlays, cutBaseUnderOverlaysIn, subtractRuns } from "../src/core/overlay-groups";

/** A tile as Fragments 3.4 groups it: visible runs on material 0, highlights on top. */
function tile(groups: [number, number, number][]) {
  const geometry = new THREE.BufferGeometry();
  for (const [start, count, material] of groups) geometry.addGroup(start, count, material);
  return geometry;
}

const plain = (g: THREE.BufferGeometry) => g.groups.map(({ start, count, materialIndex }) => [start, count, materialIndex]);

describe("subtractRuns", () => {
  it("cuts the middle, the edges and whole runs", () => {
    expect(subtractRuns([{ start: 0, count: 100 }], [{ start: 30, count: 10 }])).toEqual([
      { start: 0, count: 30 },
      { start: 40, count: 60 },
    ]);
    expect(subtractRuns([{ start: 0, count: 100 }], [{ start: 0, count: 100 }])).toEqual([]);
    expect(subtractRuns([{ start: 10, count: 20 }], [{ start: 0, count: 15 }, { start: 25, count: 50 }])).toEqual([{ start: 15, count: 10 }]);
  });

  it("handles open-ended runs (count Infinity) on both sides", () => {
    expect(subtractRuns([{ start: 0, count: Infinity }], [{ start: 36, count: Infinity }])).toEqual([{ start: 0, count: 36 }]);
    expect(subtractRuns([{ start: 0, count: Infinity }], [{ start: 12, count: 6 }])).toEqual([
      { start: 0, count: 12 },
      { start: 18, count: Infinity },
    ]);
  });

  it("keeps the base when nothing overlaps", () => {
    expect(subtractRuns([{ start: 0, count: 10 }, { start: 50, count: 5 }], [{ start: 20, count: 10 }])).toEqual([
      { start: 0, count: 10 },
      { start: 50, count: 5 },
    ]);
  });
});

describe("cutBaseUnderOverlays", () => {
  it("removes the opaque base under a see-through highlight of the whole tile (X-ray)", () => {
    const geometry = tile([[0, Infinity, 0], [0, Infinity, 1]]);
    expect(cutBaseUnderOverlays(geometry)).toBe(true);
    expect(plain(geometry)).toEqual([[0, Infinity, 1]]);
  });

  it("keeps the base outside a highlighted element", () => {
    const geometry = tile([[0, Infinity, 0], [36, Infinity, 1]]);
    cutBaseUnderOverlays(geometry);
    expect(plain(geometry)).toEqual([[0, 36, 0], [36, Infinity, 1]]);
  });

  it("works per visible run with several highlight materials", () => {
    const geometry = tile([[0, 30, 0], [60, 30, 0], [10, 5, 1], [70, 30, 2]]);
    cutBaseUnderOverlays(geometry);
    expect(plain(geometry)).toEqual([[0, 10, 0], [15, 15, 0], [60, 10, 0], [10, 5, 1], [70, 30, 2]]);
  });

  it("leaves tiles without highlights alone and reworks a tile only after Fragments regroups it", () => {
    const single = tile([[0, Infinity, 0]]);
    expect(cutBaseUnderOverlays(single)).toBe(false);
    const geometry = tile([[0, Infinity, 0], [0, Infinity, 1]]);
    cutBaseUnderOverlays(geometry);
    expect(cutBaseUnderOverlays(geometry)).toBe(false);
    // Fragments' next status update: clearGroups() + new groups.
    geometry.clearGroups();
    geometry.addGroup(0, Infinity, 0);
    geometry.addGroup(6, 6, 1);
    expect(cutBaseUnderOverlays(geometry)).toBe(true);
    expect(plain(geometry)).toEqual([[0, 6, 0], [12, Infinity, 0], [6, 6, 1]]);
  });

  it("walks model roots and only touches meshes", () => {
    const root = new THREE.Group();
    const geometry = tile([[0, Infinity, 0], [0, Infinity, 1]]);
    root.add(new THREE.Mesh(geometry), new THREE.Line(tile([[0, Infinity, 0], [0, Infinity, 1]])));
    cutBaseUnderOverlaysIn([root]);
    expect(plain(geometry)).toEqual([[0, Infinity, 1]]);
    expect(plain((root.children[1] as THREE.Line).geometry)).toEqual([[0, Infinity, 0], [0, Infinity, 1]]);
  });
});
