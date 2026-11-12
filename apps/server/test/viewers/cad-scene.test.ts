/**
 * Large drawings: DXF repair (LibreDWG 0.13 breaks values over lines), the drawing check
 * (Civil 3D, empty conversions) and the prebuilt 2D scene ("2B sahne"). Synthetic drawings only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import DxfParser from "dxf-viewer/src/parser/DxfParser.js";
import { DxfScene } from "dxf-viewer/src/DxfScene.js";
import opentype from "opentype.js";
import { DxfPairRepair, dxfInfo, repairDxfFile, repairDxfText } from "../../src/previews/preview-worker.js";
import { buildScenes, decodeScene, encodeScene, SCENE_FONTS, sceneOrigin, shuffleBytes, unshuffleBytes, type SerializedScene } from "../../src/previews/scene-worker.js";
import { cadCheck } from "../../src/previews/service.js";
import { decodeScene as decodeInBrowser, planCad, PHONE_DXF_LIMIT } from "../../../web/src/viewers/cad/scene-loader.js";
import { initI18n, setLanguage } from "../../../web/src/i18n/index.js";

// planCad's notices are web interface texts (docs/architecture/i18n.md); checked in Turkish.
await initI18n();
await setLanguage("tr", { persist: false });

const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-scene-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const parse = (text: string) => new DxfParser().parseSync(text) as { entities: { type: string; text?: string }[] };

/** A drawing with `lines` LINEs inside one block, `inserts` INSERTs of it, a TEXT and a paper-space LINE. */
function synthetic(lines: number, inserts: number): string {
  const out: string[] = ["  0", "SECTION", "  2", "HEADER", "  9", "$ACADVER", "  1", "AC1027", "  9", "$INSUNITS", " 70", "     6"];
  out.push("  9", "$EXTMIN", " 10", "0.0", " 20", "0.0", " 30", "0.0", "  9", "$EXTMAX", " 10", "1000.0", " 20", "500.0", " 30", "0.0", "  0", "ENDSEC");
  out.push("  0", "SECTION", "  2", "TABLES", "  0", "TABLE", "  2", "LAYER", "  0", "LAYER", "  2", "DUVAR", " 62", "     1", "  0", "LAYER", "  2", "YAZI", " 62", "     3", "  0", "ENDTAB", "  0", "ENDSEC");
  out.push("  0", "SECTION", "  2", "BLOCKS", "  0", "BLOCK", "  8", "0", "  2", "KAT", " 70", "     0", " 10", "0", " 20", "0", " 30", "0", "  3", "KAT");
  for (let i = 0; i < lines; i++) out.push("  0", "LINE", "  8", "DUVAR", " 10", String(i % 97), " 20", String(i % 89), " 30", "0", " 11", String((i % 97) + 1.5), " 21", String((i % 89) + 2.25), " 31", "0");
  out.push("  0", "ENDBLK", "  8", "0", "  0", "ENDSEC", "  0", "SECTION", "  2", "ENTITIES");
  for (let i = 0; i < inserts; i++) out.push("  0", "INSERT", "  8", "DUVAR", "  2", "KAT", " 10", String(i * 120), " 20", String((i % 4) * 110), " 30", "0");
  out.push("  0", "TEXT", "  8", "YAZI", " 10", "5", " 20", "5", " 30", "0", " 40", "2.5", "  1", "Zemin Kat Planı Ölçek 1/50");
  out.push("  0", "LINE", "  8", "0", " 67", "     1", " 10", "0", " 20", "0", " 30", "0", " 11", "297", " 21", "210", " 31", "0");
  out.push("  0", "ENDSEC", "  0", "EOF");
  return `${out.join("\r\n")}\r\n`;
}

describe("DXF repair", () => {
  it("joins an MTEXT value broken over lines (LibreDWG 0.13) so dxf-viewer can parse it", () => {
    const broken = [
      "  0", "SECTION", "  2", "ENTITIES",
      "  0", "MTEXT", "  8", "YAZI", " 10", "0", " 20", "0", " 40", "2.5",
      "  1", "{\\fArial|b0|i0|c162|p34;KESİT A-A",
      "c162|p34;\\fArial Unicode MS|b0|i0|c0|p34;Ölçek 1/50}",
      "2024",
      "  0", "TEXT", "  8", "0", " 10", "1", " 20", "1", " 40", "1",
      "  1", "Kot +3.50",
      " 45",
      "metre",
      "  0", "ENDSEC", "  0", "EOF",
    ].join("\n");
    expect(() => parse(broken)).toThrow(/Cannot parse group code/);
    const r = repairDxfText(broken);
    // Two lines joined onto the MTEXT value ("2024" is no group code), two onto the TEXT value (" 45" is followed by no number).
    expect(r.repairs).toBe(4);
    const ents = parse(r.text).entities;
    expect(ents.map((e) => e.type)).toEqual(["MTEXT", "TEXT"]);
    expect(ents[0]!.text).toBe("{\\fArial|b0|i0|c162|p34;KESİT A-A\\Pc162|p34;\\fArial Unicode MS|b0|i0|c0|p34;Ölçek 1/50}\\P2024");
    expect(ents[1]!.text).toBe("Kot +3.50  45 metre");
  });

  it("leaves a clean drawing unchanged", () => {
    const text = synthetic(20, 2);
    const r = repairDxfText(text);
    expect(r.repairs).toBe(0);
    expect(r.text).toBe(text.replace(/\r\n/g, "\n"));
  });

  it("streams large files and keeps CRLF pairs split over chunk ends", async () => {
    const big = synthetic(60_000, 5).replace("Zemin Kat Planı Ölçek 1/50", "Zemin Kat\r\nPlanı Ölçek 1/50");
    const src = path.join(dir, "big.dxf");
    const out = path.join(dir, "big-fixed.dxf");
    writeFileSync(src, big, "utf8");
    const r = await repairDxfFile(src, out);
    expect(r.repairs).toBe(1);
    const fixed = readFileSync(out, "utf8");
    const parsed = parse(fixed);
    expect(parsed.entities.find((e) => e.type === "TEXT")!.text).toBe("Zemin Kat Planı Ölçek 1/50");
    // Byte for byte otherwise (latin1 round trip of UTF-8 text).
    expect(fixed.length).toBe(big.replace(/\r\n/g, "\n").length);
  });

  it("feeds lines one by one", () => {
    const lines: string[] = [];
    const r = new DxfPairRepair((l) => lines.push(l));
    for (const l of ["  0", "EOF"]) r.push(l);
    r.end();
    expect(lines).toEqual(["  0", "EOF"]);
  });
});

describe("drawing check", () => {
  const civil =
    "  0\nSECTION\n  2\nCLASSES\n  0\nCLASS\n  1\nAECC_ALIGNMENT\n  2\nAeccDbAlignment\n  0\nCLASS\n  1\nAECC_TIN_SURFACE\n  2\nAeccDbSurfaceTin\n  0\nENDSEC\n" +
    "  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n";

  it("recognises a Civil 3D drawing with nothing LibreDWG could read", () => {
    const info = dxfInfo(Buffer.from(civil));
    expect(info.stats).toMatchObject({ entities: 0, aeccClasses: 2 });
    expect(cadCheck(info.stats, 1246).status).toBe("civil3d");
  });

  it("tells empty, partial and good conversions apart", () => {
    const info = dxfInfo(Buffer.from(synthetic(10, 3)));
    expect(info.stats).toMatchObject({ entities: 5, paperEntities: 1, blockEntities: 10, aeccClasses: 0, insunits: 6, extMin: [0, 0], extMax: [1000, 500] });
    expect(cadCheck(info.stats, 0).status).toBe("ok");
    expect(cadCheck(info.stats, 3).status).toBe("ok");
    expect(cadCheck(info.stats, 32).status).toBe("ok"); // a few dozen harmless errors are common
    expect(cadCheck(info.stats, 402).status).toBe("partial");
    expect(cadCheck({ ...info.stats, entities: 40, aeccClasses: 4 }, 0).status).toBe("partial");
    expect(cadCheck({ ...info.stats, entities: 2, aeccClasses: 4 }, 0).status).toBe("civil3d");
    expect(cadCheck({ ...info.stats, entities: 0 }, 50).status).toBe("empty");
  });
});

describe("prebuilt 2D scene", () => {
  it("round-trips the container (byte-shuffled buffers)", () => {
    const v = new Float32Array([1.5, -2.25, 3e6, 0]);
    const ix = new Uint16Array([0, 1, 2, 65535, 7]);
    expect(unshuffleBytes(shuffleBytes(new Uint8Array(ix.buffer), 2), 2)).toEqual(new Uint8Array(ix.buffer));
    const scene: SerializedScene = {
      vertices: v.buffer,
      indices: ix.buffer,
      transforms: new ArrayBuffer(0),
      batches: [{ key: { blockName: null, geometryType: 0, layerName: "0", color: 7, lineType: null }, verticesOffset: 0, verticesSize: 4 }],
      layers: [{ name: "0", displayName: "0", color: 16777215 }],
      origin: { x: 10, y: 20 },
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      hasMissingChars: false,
      pointShapeHasDot: false,
    };
    const header = { insunits: 6, measurement: 1, extMin: null, extMax: null, acadver: "AC1032" };
    const packed = encodeScene(scene, header);
    for (const decoded of [decodeScene(packed), decodeInBrowser(new Uint8Array(packed))]) {
      expect(decoded.header).toEqual(header);
      expect(new Float32Array(decoded.scene.vertices)).toEqual(v);
      expect(new Uint16Array(decoded.scene.indices)).toEqual(ix);
      expect(decoded.scene.batches).toEqual(scene.batches);
      expect(decoded.scene.origin).toEqual(scene.origin);
    }
  });

  it("builds the same scene dxf-viewer builds in the browser, plus the model-space-only variant", async () => {
    const text = synthetic(3_000, 12);
    const src = path.join(dir, "kat.dxf");
    writeFileSync(src, text, "utf8");
    const out = path.join(dir, "kat.scene.gz");
    const modelOut = path.join(dir, "kat.model.scene.gz");
    const phases: string[] = [];
    const r = await buildScenes({ task: "scene", inputPath: src, encoding: "utf-8", outputPath: out, modelOutputPath: modelOut }, (p) => phases.push(p));
    expect(phases).toEqual(["parse", "build", "compress", "build", "compress"]);
    expect(r.header).toMatchObject({ insunits: 6, acadver: "AC1027", extMax: { x: 1000, y: 500 } });
    expect(r.model).not.toBeNull();
    expect(r.gzBytes).toBeLessThan(r.bytes);

    // What DxfWorker does in the browser (same parser, same fonts).
    const require = createRequire(import.meta.url);
    const fonts = SCENE_FONTS.map((f) => async () => {
      const b = readFileSync(require.resolve(f));
      return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    });
    const log = console.log;
    console.log = () => undefined;
    const browser = new DxfScene({ sceneOptions: { suppressPaperSpace: false } });
    const parsed = new DxfParser().parseSync(text);
    // The only difference on purpose: the server picks the origin (robust body centre).
    browser.origin = sceneOrigin(parsed.entities, true);
    expect(browser.origin).toEqual({ x: 660, y: 165 });
    await browser.Build(parsed, fonts);
    console.log = log;
    const expected = browser.scene as SerializedScene;

    const { scene } = decodeInBrowser(new Uint8Array(gunzipSync(readFileSync(out))));
    expect(JSON.parse(JSON.stringify(scene.batches))).toEqual(JSON.parse(JSON.stringify(expected.batches)));
    expect(scene.layers).toEqual(expected.layers);
    expect(scene.origin).toEqual(expected.origin);
    expect(scene.bounds).toEqual(expected.bounds);
    expect(scene.hasMissingChars).toBe(false);
    for (const k of ["vertices", "indices", "transforms"] as const) expect(new Uint8Array(scene[k])).toEqual(new Uint8Array(expected[k]));
    expect(scene.layers.map((l) => l.name)).toEqual(expect.arrayContaining(["DUVAR", "YAZI"]));

    const model = decodeScene(gunzipSync(readFileSync(modelOut))).scene;
    expect(model.vertices.byteLength).toBeLessThan(scene.vertices.byteLength);
  });

  it("puts the origin in the robust body, not at a stray entity (float32 precision in UTM drawings)", async () => {
    const ents: string[] = ["  0", "LINE", "  8", "0", " 10", "0", " 20", "0", " 30", "0", " 11", "1", " 21", "1", " 31", "0"];
    for (let i = 0; i < 400; i++) {
      const x = 423000 + (i % 20) * 3.137;
      const y = 4550700 + Math.floor(i / 20) * 2.711;
      ents.push("  0", "LINE", "  8", "PARSEL", " 10", String(x), " 20", String(y), " 30", "0", " 11", String(x + 1.234), " 21", String(y + 0.567), " 31", "0");
    }
    const text = ["  0", "SECTION", "  2", "ENTITIES", ...ents, "  0", "ENDSEC", "  0", "EOF"].join("\n");
    const src = path.join(dir, "utm.dxf");
    writeFileSync(src, text);
    const out = path.join(dir, "utm.scene.gz");
    await buildScenes({ task: "scene", inputPath: src, encoding: "utf-8", outputPath: out });
    const { scene } = decodeScene(gunzipSync(readFileSync(out)));
    // dxf-viewer alone would take the stray line's 0,0.
    expect(scene.origin!.x).toBeGreaterThan(423000);
    expect(scene.origin!.x).toBeLessThan(423070);
    expect(scene.origin!.y).toBeGreaterThan(4550700);
    expect(scene.origin!.y).toBeLessThan(4550760);
    // Vertices relative to it: the parcel lines sit within metres of 0, where float32 keeps sub-millimetre detail.
    const v = new Float32Array(scene.vertices);
    const near = [...v].filter((n) => Math.abs(n) < 100).length;
    expect(near).toBe(v.length - 4);
  });

  it("plans the loading path: scene, DXF, cards", () => {
    const meta = (m: object) => ({ error: null, hint: null, updatedAt: "", ...m });
    const dxf = (m: object = {}) => meta({ kind: "dxf", status: "ready", meta: { dxfBytes: 1_000_000, cad: undefined, ...m } });
    const scene = (status: string) => meta({ kind: "scene", status, meta: status === "ready" ? { scene: { format: 1 } } : {} });
    const info = (...previews: object[]) => ({ size: 1, previews }) as never;
    expect(planCad(info(dxf(), scene("ready")), { phone: true })).toMatchObject({ show: "viewer", source: "scene" });
    expect(planCad(info(dxf(), scene("processing")), { phone: true })).toMatchObject({ show: "viewer", source: "dxf" });
    const big = { dxfBytes: PHONE_DXF_LIMIT + 1 };
    expect(planCad(info(dxf(big), scene("processing")), { phone: true })).toMatchObject({ show: "preparing", canOpenDxf: false });
    expect(planCad(info(dxf(big), scene("processing")), { phone: false })).toMatchObject({ show: "preparing", canOpenDxf: true });
    expect(planCad(info(dxf(big), scene("processing")), { phone: false, openDxf: true })).toMatchObject({ show: "viewer", source: "dxf" });
    expect(planCad(info(dxf(big), scene("failed")), { phone: true })).toMatchObject({ show: "too-big" });
    expect(planCad(info(dxf(big), scene("failed")), { phone: false })).toMatchObject({ show: "viewer", source: "dxf" });
    const civil = { status: "civil3d", converterErrors: 1246, aeccClasses: 258, entities: 0 };
    expect(planCad(info(dxf({ cad: civil })), { phone: false })).toMatchObject({ show: "civil3d" });
    const partial = { status: "partial", converterErrors: 402, aeccClasses: 0, entities: 10 };
    expect(planCad(info(dxf({ cad: partial }), scene("ready")), { phone: false })).toMatchObject({ show: "viewer", notice: expect.stringContaining("402 hata") });
  });
});
