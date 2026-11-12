/**
 * Mesh repair for viewer derivatives (apps/server/src/jobs/ifc-worker.ts): pure maths, shared so it
 * is unit-tested here and runs in the conversion worker.
 */

/**
 * web-ifc 0.0.78 sometimes stitches part of an extrusion's side walls inside out (seen on a Revit
 * counter: one of 24 identical arc segments, its trimmed arc starting at the circle's 180° seam).
 * The viewer culls those back faces, so the element shows a hole where the IFC has none.
 *
 * Makes every closed piece of a mesh consistently wound, keeping the winding most of its triangles
 * already have (no assumption about the sign of the volume). Open surfaces and pieces that are
 * already consistent are left as they are. Mutates `index` (and the normals of flipped triangles
 * in `vertices`, xyz + normal per vertex) and returns the number of triangles turned.
 */
export function consistentWinding(vertices: Float32Array, index: Uint32Array): number {
  const triangles = index.length / 3;
  const vertexCount = vertices.length / 6;
  // web-ifc repeats a vertex per face (flat normals): weld by position to find shared edges.
  const welded = new Int32Array(vertexCount);
  const byPosition = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(vertices[v * 6]! * 1e3)},${Math.round(vertices[v * 6 + 1]! * 1e3)},${Math.round(vertices[v * 6 + 2]! * 1e3)}`;
    let id = byPosition.get(key);
    if (id === undefined) byPosition.set(key, (id = byPosition.size));
    welded[v] = id;
  }
  const corner = (t: number, j: number) => welded[index[t * 3 + j]!]!;
  const edgeKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  // Slivers whose corners weld together have no area and no orientation: left out of the topology.
  const degenerate = new Uint8Array(triangles);
  const edges = new Map<number, number[]>();
  for (let t = 0; t < triangles; t++) {
    if (corner(t, 0) === corner(t, 1) || corner(t, 1) === corner(t, 2) || corner(t, 0) === corner(t, 2)) {
      degenerate[t] = 1;
      continue;
    }
    for (let j = 0; j < 3; j++) {
      const a = corner(t, j);
      const b = corner(t, (j + 1) % 3);
      if (a === b) continue;
      const k = edgeKey(a, b);
      const list = edges.get(k);
      if (list) list.push(t);
      else edges.set(k, [t]);
    }
  }
  /** +1 when triangle t walks a → b, -1 when it walks b → a. */
  const along = (t: number, a: number, b: number) => {
    for (let j = 0; j < 3; j++) if (corner(t, j) === a && corner(t, (j + 1) % 3) === b) return 1;
    return -1;
  };
  const flip = new Uint8Array(triangles);
  const seen = new Uint8Array(triangles);
  let turned = 0;
  for (let start = 0; start < triangles; start++) {
    if (seen[start] || degenerate[start]) continue;
    seen[start] = 1;
    const piece = [start];
    let closed = true;
    for (let q = 0; q < piece.length; q++) {
      const t = piece[q]!;
      for (let j = 0; j < 3; j++) {
        const a = corner(t, j);
        const b = corner(t, (j + 1) % 3);
        if (a === b) continue;
        const list = edges.get(edgeKey(a, b))!;
        if (list.length !== 2) {
          closed = false;
          continue;
        }
        const other = list[0] === t ? list[1]! : list[0]!;
        if (seen[other]) continue;
        // Neighbours with the same winding walk their shared edge in opposite directions.
        flip[other] = along(t, a, b) * (flip[t] ? -1 : 1) === along(other, a, b) ? 1 : 0;
        seen[other] = 1;
        piece.push(other);
      }
    }
    const flipped = piece.filter((t) => flip[t]).length;
    if (!closed || flipped === 0) {
      for (const t of piece) flip[t] = 0;
      continue;
    }
    // Keep the majority's winding.
    if (flipped > piece.length / 2) for (const t of piece) flip[t] = flip[t] ? 0 : 1;
  }
  // A vertex's normal turns only when every triangle using it turns (bit 1: a flipped one, bit 2: a kept one).
  const use = new Uint8Array(vertexCount);
  for (let t = 0; t < triangles; t++) {
    for (let j = 0; j < 3; j++) use[index[t * 3 + j]!]! |= flip[t] ? 1 : 2;
  }
  for (let t = 0; t < triangles; t++) {
    if (!flip[t]) continue;
    const b = index[t * 3 + 1]!;
    index[t * 3 + 1] = index[t * 3 + 2]!;
    index[t * 3 + 2] = b;
    turned++;
  }
  for (let v = 0; v < vertexCount; v++) {
    if (use[v] === 1) for (let k = 3; k < 6; k++) vertices[v * 6 + k] = -vertices[v * 6 + k]!;
  }
  return turned;
}
