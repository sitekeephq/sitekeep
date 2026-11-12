/**
 * Fragments 3.4 draws a tile as base groups (material 0, the visible index runs) plus one group
 * per highlighted run (setColor / setOpacity / highlight materials) on top of them. The base still
 * covers the highlighted runs, so a see-through highlight (X-ray, faded comparison / 4D, view
 * rules with opacity) is drawn over the opaque original and nothing changes on screen. Before
 * each frame the base groups of re-grouped tiles are cut where a highlight group lies; the
 * highlight groups stay as they are. An opaque highlight looks the same, drawn once instead of
 * twice. Fragments rebuilds a tile's groups with clearGroups() (a new array), so a tile is only
 * reworked when its groups array changed.
 */
import type * as THREE from "three";

type Group = { start: number; count: number; materialIndex?: number };

/** Base runs minus the overlay runs (half-open index intervals; count may be Infinity). */
export function subtractRuns(base: readonly Group[], overlays: readonly Group[]): { start: number; count: number }[] {
  const cuts = overlays
    .filter((o) => o.count > 0)
    .map((o) => [o.start, o.start + o.count] as const)
    .sort((a, b) => a[0] - b[0]);
  const out: { start: number; count: number }[] = [];
  for (const run of base) {
    let start = run.start;
    const end = run.start + run.count;
    for (const [cutStart, cutEnd] of cuts) {
      if (cutEnd <= start || cutStart >= end) continue;
      if (cutStart > start) out.push({ start, count: cutStart - start });
      start = Math.max(start, cutEnd);
      if (start >= end) break;
    }
    if (start < end) out.push({ start, count: end - start });
  }
  return out;
}

/** Cuts the base groups of one geometry under its highlight groups; returns true when it changed. */
export function cutBaseUnderOverlays(geometry: THREE.BufferGeometry): boolean {
  const groups = geometry.groups;
  const done = geometry.userData.vtCutGroups as unknown;
  if (groups === done || groups.length < 2) return false;
  const base = groups.filter((g) => (g.materialIndex ?? 0) === 0);
  const overlays = groups.filter((g) => (g.materialIndex ?? 0) !== 0);
  if (!base.length || !overlays.length) {
    geometry.userData.vtCutGroups = groups;
    return false;
  }
  const runs = subtractRuns(base, overlays);
  geometry.clearGroups();
  for (const run of runs) geometry.addGroup(run.start, run.count, 0);
  for (const o of overlays) geometry.addGroup(o.start, o.count, o.materialIndex);
  geometry.userData.vtCutGroups = geometry.groups;
  return true;
}

/** Applies the cut to every mesh of the given model roots. */
export function cutBaseUnderOverlaysIn(roots: Iterable<THREE.Object3D>): void {
  for (const root of roots) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) cutBaseUnderOverlays(mesh.geometry as THREE.BufferGeometry);
    });
  }
}
