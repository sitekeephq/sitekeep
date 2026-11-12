/**
 * web-ifc 0.0.78 stitches part of an extrusion's side walls inside out for some trimmed-arc profiles
 * (a Revit counter of 24 identical segments showed a hole in one). The fixture holds two such
 * segments, numbers only: #1024 comes out right, #1048 does not. The conversion worker repairs the
 * winding before Fragments reads the mesh (ifc-worker.ts → consistentWinding).
 */
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { consistentWinding } from "@sitekeep/shared";
import { runIfcWorker } from "../../src/jobs/queue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../fixtures/arc-winding.ifc");
const require = createRequire(import.meta.url);
const WebIFC = require("web-ifc") as typeof import("web-ifc");
const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-winding-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function volume(v: Float32Array, ix: Uint32Array) {
  let s = 0;
  const p = (k: number) => [v[k * 6]!, v[k * 6 + 1]!, v[k * 6 + 2]!] as const;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [p(ix[t]!), p(ix[t + 1]!), p(ix[t + 2]!)];
    s += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return s / 1e9; // mm³ → m³
}

describe("inside-out extrusion walls from web-ifc", () => {
  it("repairs the broken segment to the volume of its healthy twin", async () => {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(path.dirname(require.resolve("web-ifc")) + path.sep, true);
    await api.Init();
    const model = api.OpenModel(new Uint8Array(readFileSync(FIXTURE)), { CIRCLE_SEGMENTS: 48 });
    const mesh = api.GetFlatMesh(model, 903);
    const volumes: Record<number, { raw: number; repaired: number; turned: number }> = {};
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const id = mesh.geometries.get(i).geometryExpressID;
      const g = api.GetGeometry(model, id);
      const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const raw = volume(v, ix);
      const turned = consistentWinding(v, ix);
      volumes[id] = { raw, repaired: volume(v, ix), turned };
    }
    api.CloseModel(model);
    const good = volumes[1024]!;
    const bad = volumes[1048]!;
    expect(good.turned).toBe(0);
    // If this starts failing because web-ifc got it right, the upstream bug is fixed: keep the repair anyway.
    expect(bad.raw).toBeLessThan(good.raw * 0.9);
    expect(bad.turned).toBeGreaterThan(0);
    expect(bad.repaired).toBeCloseTo(good.raw, 4);
  });

  it("converts with the repair in the worker", async () => {
    const out = path.join(dir, "winding.frag");
    await runIfcWorker(FIXTURE, out, 60_000, undefined, 48);
    expect(statSync(out).size).toBeGreaterThan(0);
  });
});
