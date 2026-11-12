/**
 * Worker thread: builds the dxf-viewer scene of a drawing ONCE on the server ("2B sahne"), the
 * same work dxf-viewer's DxfWorker does in the browser (parse → DxfScene.Build with the same
 * bundled Noto Sans fonts), and writes it as one compact binary file (gzip):
 *
 *   "7DSCENE1"            8 bytes, ASCII magic + format version
 *   json length           uint32 little endian
 *   json                  UTF-8: { v, header, scene, buffers }
 *                         - header: $INSUNITS, $MEASUREMENT, $EXTMIN/$EXTMAX, $ACADVER
 *                         - scene: the serialised DxfScene without its typed arrays (batches,
 *                           layers with colours, origin, bounds, hasMissingChars, pointShapeHasDot)
 *                         - buffers: { vertices | indices | transforms: [byteOffset, byteLength] }
 *   padding               to 8 bytes
 *   vertices, indices, transforms   the scene's ArrayBuffers, each 8-byte aligned and byte-shuffled
 *                         (all first bytes of the 4-byte floats / 2-byte indices, then all second
 *                         bytes …): gzip packs float data far better that way (≈ 2x smaller)
 *
 * The browser (apps/web/src/viewers/cad/scene-loader.ts) answers dxf-viewer's worker protocol
 * with it, so the viewer gets exactly the scene object it would have built itself.
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import { robustBounds } from "@sitekeep/shared";

export const SCENE_MAGIC = "7DSCENE1";
export const SCENE_VERSION = 1;

/** Fonts in the order CadViewer hands them to dxf-viewer (glyphs are looked up in turn). */
export const SCENE_FONTS = [
  "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff",
  "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff",
];

export interface SceneHeader {
  insunits: number | null;
  measurement: number | null;
  extMin: { x: number; y: number } | null;
  extMax: { x: number; y: number } | null;
  acadver: string | null;
}

/** dxf-viewer's serialised scene (DxfScene._BuildScene). */
export interface SerializedScene {
  vertices: ArrayBuffer;
  indices: ArrayBuffer;
  transforms: ArrayBuffer;
  batches: unknown[];
  layers: { name: string; displayName: string; color: number }[];
  origin: { x: number; y: number } | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
  hasMissingChars: boolean;
  pointShapeHasDot?: boolean;
  [k: string]: unknown;
}

const BUFFERS = ["vertices", "indices", "transforms"] as const;
const align8 = (n: number) => (n + 7) & ~7;
/** Element width per buffer (Float32 vertices and transforms, Uint16 indices). */
const WIDTH = { vertices: 4, indices: 2, transforms: 4 } as const;

/** Byte shuffle: element bytes grouped by position (see the format above). */
export function shuffleBytes(src: Uint8Array, width: number, out: Uint8Array = new Uint8Array(src.length)): Uint8Array {
  const n = Math.floor(src.length / width);
  for (let b = 0; b < width; b++) {
    const base = b * n;
    for (let i = 0, j = b; i < n; i++, j += width) out[base + i] = src[j]!;
  }
  for (let k = n * width; k < src.length; k++) out[k] = src[k]!;
  return out;
}

export function unshuffleBytes(src: Uint8Array, width: number, out: Uint8Array = new Uint8Array(src.length)): Uint8Array {
  const n = Math.floor(src.length / width);
  for (let b = 0; b < width; b++) {
    const base = b * n;
    for (let i = 0, j = b; i < n; i++, j += width) out[j] = src[base + i]!;
  }
  for (let k = n * width; k < src.length; k++) out[k] = src[k]!;
  return out;
}

/** Packs a scene into the container (uncompressed). */
export function encodeScene(scene: SerializedScene, header: SceneHeader): Buffer {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scene)) if (!(BUFFERS as readonly string[]).includes(k)) rest[k] = v;
  // Offsets depend on the JSON length, which depends on the offsets: lay out with a fixed-width guess first.
  const lengths = BUFFERS.map((k) => scene[k].byteLength);
  let jsonBytes = Buffer.alloc(0);
  let offsets: number[] = [];
  for (let guess = 0, pass = 0; pass < 4; pass++) {
    let at = align8(12 + guess);
    offsets = lengths.map((len) => {
      const o = at;
      at = align8(at + len);
      return o;
    });
    const buffers = Object.fromEntries(BUFFERS.map((k, i) => [k, [offsets[i], lengths[i]]]));
    jsonBytes = Buffer.from(JSON.stringify({ v: SCENE_VERSION, header, scene: rest, buffers, shuffled: true }), "utf8");
    if (align8(12 + jsonBytes.length) === align8(12 + guess)) break;
    guess = jsonBytes.length;
  }
  const total = BUFFERS.length ? Math.max(align8(12 + jsonBytes.length), offsets[2]! + lengths[2]!) : 0;
  const out = Buffer.alloc(total);
  out.write(SCENE_MAGIC, 0, "latin1");
  out.writeUInt32LE(jsonBytes.length, 8);
  jsonBytes.copy(out, 12);
  BUFFERS.forEach((k, i) => shuffleBytes(new Uint8Array(scene[k]), WIDTH[k], out.subarray(offsets[i]!, offsets[i]! + lengths[i]!)));
  return out;
}

/** Unpacks a container (tests; the browser has its own copy in scene-loader.ts). */
export function decodeScene(buf: Uint8Array): { header: SceneHeader; scene: SerializedScene } {
  const magic = Buffer.from(buf.buffer, buf.byteOffset, 8).toString("latin1");
  if (magic !== SCENE_MAGIC) throw new Error("Sahne dosyası tanınmadı."); // i18n-ok: decodeScene is used by tests only (the browser has its own copy)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint32(8, true);
  const json = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset + 12, len).toString("utf8")) as {
    header: SceneHeader;
    scene: SerializedScene;
    buffers: Record<(typeof BUFFERS)[number], [number, number]>;
    shuffled?: boolean;
  };
  const scene = { ...json.scene } as SerializedScene;
  for (const k of BUFFERS) {
    const [o, l] = json.buffers[k];
    const part = buf.subarray(o, o + l);
    scene[k] = (json.shuffled ? unshuffleBytes(part, WIDTH[k]) : part.slice()).buffer as ArrayBuffer;
  }
  return { header: json.header, scene };
}

function headerOf(dxf: { header?: Record<string, unknown> }): SceneHeader {
  const h = dxf.header ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pt = (v: unknown) => {
    const p = v as { x?: unknown; y?: unknown } | undefined;
    const x = num(p?.x);
    const y = num(p?.y);
    return x !== null && y !== null && Math.abs(x) < 1e19 && Math.abs(y) < 1e19 ? { x, y } : null;
  };
  return {
    insunits: num(h.$INSUNITS),
    measurement: num(h.$MEASUREMENT),
    extMin: pt(h.$EXTMIN),
    extMax: pt(h.$EXTMAX),
    acadver: typeof h.$ACADVER === "string" ? h.$ACADVER : null,
  };
}

export interface SceneBuildInput {
  task: "scene";
  inputPath: string;
  /** TextDecoder label (preview meta "encoding"). */
  encoding: string;
  /** Gzip output: the full scene. */
  outputPath: string;
  /** Gzip output: model space only ("Yalnız Model Alanı"); only built when the drawing has paper-space entities. */
  modelOutputPath?: string;
}

export interface SceneBuildResult {
  header: SceneHeader;
  /** Container size before / after gzip, full scene. */
  bytes: number;
  gzBytes: number;
  /** Same for the model-space-only scene (null when not built). */
  model: { bytes: number; gzBytes: number } | null;
  batches: number;
  layers: number;
  /** Milliseconds per phase. */
  timings: { parse: number; build: number; encode: number };
}

type Progress = (phase: "parse" | "build" | "compress") => void;

/** The parts of a parsed entity (dxf-viewer's parser) that carry a location. */
interface ParsedEntity {
  inPaperSpace?: boolean;
  vertices?: unknown[];
  controlPoints?: unknown[];
  position?: unknown;
  center?: unknown;
  startPoint?: unknown;
  endPoint?: unknown;
}

/**
 * Scene origin: centre of the robust extents (shared robustBounds, the same the viewer's
 * "Sığdır" uses) of the top-level entities' first/last vertices, centres and insertion points.
 */
export function sceneOrigin(entities: ParsedEntity[], withPaperSpace: boolean): { x: number; y: number } | null {
  const xy: number[] = [];
  const add = (p: unknown) => {
    const q = p as { x?: unknown; y?: unknown } | undefined;
    if (q && typeof q.x === "number" && typeof q.y === "number" && Number.isFinite(q.x) && Number.isFinite(q.y)) xy.push(q.x, q.y);
  };
  for (const e of entities) {
    if (!withPaperSpace && e.inPaperSpace) continue;
    if (Array.isArray(e.vertices) && e.vertices.length) {
      add(e.vertices[0]);
      if (e.vertices.length > 1) add(e.vertices[e.vertices.length - 1]);
    }
    if (Array.isArray(e.controlPoints) && e.controlPoints.length) add(e.controlPoints[0]);
    add(e.position);
    add(e.center);
    add(e.startPoint);
    add(e.endPoint);
  }
  const b = robustBounds(xy);
  if (!b) return null;
  // Whole drawing units: tidy, and far below float32 trouble.
  return { x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2) };
}

/** Parses the DXF and builds the scene(s); the work of one worker run. */
export async function buildScenes(input: SceneBuildInput, progress: Progress = () => undefined): Promise<SceneBuildResult> {
  const require = createRequire(import.meta.url);
  const { default: DxfParser } = (await import("dxf-viewer/src/parser/DxfParser.js")) as {
    default: new () => { parseSync(s: string): { header?: Record<string, unknown>; entities?: ParsedEntity[] } };
  };
  const { DxfScene } = (await import("dxf-viewer/src/DxfScene.js")) as {
    DxfScene: new (o: unknown) => { Build(dxf: unknown, fonts: (() => Promise<unknown>)[]): Promise<void>; scene: SerializedScene };
  };
  const opentype = ((await import("opentype.js")) as { default?: { parse(b: ArrayBuffer): unknown }; parse?(b: ArrayBuffer): unknown });
  const parseFont = (opentype.default?.parse ?? opentype.parse)!.bind(opentype.default ?? opentype);
  const fonts = SCENE_FONTS.map((f) => {
    let font: unknown = null;
    return async () => {
      if (!font) {
        const b = readFileSync(require.resolve(f));
        font = parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }
      return font;
    };
  });

  const t0 = performance.now();
  progress("parse");
  let text: string | null = new TextDecoder(input.encoding).decode(readFileSync(input.inputPath));
  const dxf = new DxfParser().parseSync(text);
  text = null;
  const t1 = performance.now();
  progress("build");
  const header = headerOf(dxf);
  const build = async (suppressPaperSpace: boolean) => {
    const s = new DxfScene({ sceneOptions: { suppressPaperSpace } }) as { origin: { x: number; y: number } | null } & InstanceType<typeof DxfScene>;
    // dxf-viewer takes the first vertex it meets as the origin; a stray entity at 0,0 in a UTM
    // drawing would leave the geometry at float32 resolution of ~0.5 m. Centre of the robust body instead.
    const origin = sceneOrigin(dxf.entities ?? [], !suppressPaperSpace);
    if (origin) s.origin = origin;
    await s.Build(dxf, fonts);
    return s.scene;
  };
  const silence = console.log;
  console.log = () => undefined; // DxfScene logs statistics
  try {
    const full = await build(false);
    const t2 = performance.now();
    progress("compress");
    const packed = encodeScene(full, header);
    const gz = gzipSync(packed, { level: 6 });
    writeFileSync(input.outputPath, gz);
    let model: SceneBuildResult["model"] = null;
    const hasPaper = (dxf.entities ?? []).some((e) => e.inPaperSpace);
    if (input.modelOutputPath && hasPaper) {
      progress("build");
      const m = encodeScene(await build(true), header);
      progress("compress");
      const mgz = gzipSync(m, { level: 6 });
      writeFileSync(input.modelOutputPath, mgz);
      model = { bytes: m.length, gzBytes: mgz.length };
    }
    const t3 = performance.now();
    return {
      header,
      bytes: packed.length,
      gzBytes: gz.length,
      model,
      batches: full.batches.length,
      layers: full.layers.length,
      timings: { parse: Math.round(t1 - t0), build: Math.round(t2 - t1), encode: Math.round(t3 - t2) },
    };
  } finally {
    console.log = silence;
  }
}

if (parentPort && workerData && (workerData as SceneBuildInput).task === "scene") {
  const port = parentPort;
  buildScenes(workerData as SceneBuildInput, (phase) => port.postMessage({ type: "progress", phase })).then(
    (result) => port.postMessage({ type: "done", result }),
    (err: unknown) => port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
}
