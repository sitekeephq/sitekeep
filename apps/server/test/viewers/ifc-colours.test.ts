/**
 * #168: Revit models converted by rvt-rs opened grey: their colours are on the materials of family
 * types, not on the geometry, and web-ifc leaves such elements white. The conversion worker gives
 * them their material's (or type material's) colour, else a colour for their class. The fixture:
 *   A wall, styled red on its geometry (kept)
 *   B wall, blue material linked directly (web-ifc already colours it)
 *   C furnishing element, nothing (class colour)
 *   D wall, blue material through a layer set usage (web-ifc already colours it)
 *   E furniture, blue material on its type only (fallback)
 *   F slab, blue material through a constituent set (web-ifc already colours it)
 *   G proxy, green material written the way rvt-rs 0.25 writes it (rendering in a presentation style
 *     assignment; web-ifc already colours it)
 * rvt-rs links materials only for walls, floors, roofs and ceilings: its family instances have no
 * material at all and get their class colour.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as flatbuffers from "flatbuffers";
import pako from "pako";
import { Model } from "@thatopen/fragments";
import { classColour, elementColours, type IfcLineReader } from "@sitekeep/shared";
import { runIfcWorker } from "../../src/jobs/queue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../fixtures/unstyled-colours.ifc");
const require = createRequire(import.meta.url);
const WebIFC = require("web-ifc") as typeof import("web-ifc");
const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-colours-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const byte = (x: number) => Math.floor(x * 255); // Fragments stores colours as bytes, truncated

describe("colours for unstyled elements", () => {
  it("resolves the type's material, else the class, and leaves styled elements alone", async () => {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(path.dirname(require.resolve("web-ifc")) + path.sep, true);
    await api.Init();
    const model = api.OpenModel(new Uint8Array(readFileSync(FIXTURE)));
    const reader: IfcLineReader = {
      idsOfType: (name) => {
        const v = api.GetLineIDsWithType(model, (WebIFC as unknown as Record<string, number>)[name]!);
        return Array.from({ length: v.size() }, (_, i) => v.get(i));
      },
      line: (id) => api.GetLine(model, id) as Record<string, unknown>,
      typeName: (id) => api.GetNameFromTypeCode(api.GetLineType(model, id)).toUpperCase(),
    };
    const colours = elementColours(reader);
    const blue = [0.1, 0.2, 0.9, 1];
    expect(colours.colourOf(606)).toEqual(blue); // E: type material
    expect(colours.colourOf(506)).toEqual(blue); // D: layer set usage
    expect(colours.colourOf(706)).toEqual(blue); // F: constituent set
    expect(colours.colourOf(306)).toEqual(classColour("IFCFURNISHINGELEMENT")); // C
    expect(colours.materialColourOf(806)).toEqual([0.54902, 0.678431, 0.419608, 1]); // G
    expect(colours.materialColourOf(306)).toBeNull();
    api.CloseModel(model);
  });

  it("writes them into the viewer derivative", async () => {
    const out = path.join(dir, "colours.frag");
    await runIfcWorker(FIXTURE, out, 60_000, undefined, 48);
    const bytes = pako.inflate(readFileSync(out));
    const meshes = Model.getRootAsModel(new flatbuffers.ByteBuffer(bytes)).meshes()!;
    const seen = new Set<string>();
    for (let i = 0; i < meshes.materialsLength(); i++) {
      const m = meshes.materials(i)!;
      seen.add([m.r(), m.g(), m.b()].join(","));
    }
    const rgb = (c: number[]) => c.slice(0, 3).map(byte).join(",");
    expect(seen).toContain(rgb([0.8, 0.1, 0.1])); // A keeps its own red
    expect(seen).toContain(rgb([0.1, 0.2, 0.9])); // B, D, E, F
    expect(seen).toContain(rgb(classColour("IFCFURNISHINGELEMENT")!)); // C
    expect(seen).toContain(rgb([0.54902, 0.678431, 0.419608])); // G
    expect(seen).not.toContain("255,255,255"); // nothing left white
  });
});
