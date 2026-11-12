/**
 * Worker thread: deterministic clash detection between two element selections of one or more
 * IFC versions.
 *
 * Coordinates: every model is opened with COORDINATE_TO_ORIGIN off, so web-ifc returns the
 * placement chain as written in the file (IfcSite → building → storey → element), scaled to
 * metres. All models of a federation are therefore compared in their own project coordinate
 * system; this is correct when the disciplines share the project base point (the usual BIM
 * coordination rule, ISO 19650 "shared coordinates"). IfcMapConversion / georeferencing is
 * not applied. Results are reported in IFC axes (metres, Z up).
 *
 * Algorithm:
 *  1. read the selected elements' triangle meshes (web-ifc StreamMeshes; openings are already
 *     cut by web-ifc) and their world AABBs;
 *  2. broad phase: sweep-and-prune over AABBs on X (expanded by the clearance tolerance);
 *  3. narrow phase per candidate pair with a BVH per element mesh:
 *     hard      — a triangle edge strictly crossing the other mesh's triangle (touching faces,
 *                 shared faces and coplanar contact are not clashes), plus a containment check
 *                 (rays from a vertex agree it is inside the other's solid; when they disagree — an open
 *                 mesh, a ring around the point — the generalised winding number decides) when one
 *                 element lies fully inside the other.
 *                 Penetration is the thickness of that intersection: the thinnest axis of the
 *                 crossing points, or how deep a vertex of one mesh sits inside the other.
 *                 It is not the overlap of the two elements' whole bounding boxes — a long
 *                 ring and a wall standing in its hole would otherwise be reported as deep
 *                 as the wall is thick.
 *     clearance — exact minimum triangle-triangle distance below the tolerance. A real
 *                 intersection uses the same penetration, not the element boxes.
 * Every step iterates in a fixed order, so the same input gives the same output.
 *
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import * as WebIFC from "web-ifc";

// ---- Texts (docs/architecture/i18n.md §8) -----------------------------------------------------
// Worker threads import no local modules, so this one reads its texts ("jobs" namespace) itself,
// in the installation's language (CDE_DEFAULT_LANGUAGE, else English): its results are stored.
const LOCALES = new URL("../i18n/locales/", import.meta.url);
function localeJson(lang: string, file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(new URL(`${lang}/${file}`, LOCALES), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const ENV_LANG = process.env.CDE_DEFAULT_LANGUAGE?.trim() || "en";
const TEXT_LANG = localeJson(ENV_LANG, "meta.json") ? ENV_LANG : "en";
const TEXTS = [localeJson(TEXT_LANG, "jobs.json"), localeJson("en", "jobs.json")];
/** Intl locale for numbers in the texts ("tr" → "tr-TR"). */
const TEXT_INTL = String(localeJson(TEXT_LANG, "meta.json")?.intl ?? TEXT_LANG);
function jt(key: string, params: Record<string, string | number> = {}): string {
  for (const tree of TEXTS) {
    const v = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), tree);
    if (typeof v === "string" && v.trim()) return v.replace(/\{\{(\w+)\}\}/g, (_, p: string) => String(params[p] ?? ""));
  }
  return key;
}

interface Selection {
  /** Lower-case IFC class names; empty = every building element. */
  classes: string[];
  property: { pset: string; name: string; value?: string | null } | null;
}

interface ModelInput {
  versionId: string;
  fileId: string;
  path: string;
  selA: Selection | null;
  selB: Selection | null;
}

interface Input {
  wasmDir: string;
  type: "hard" | "clearance";
  /** Metres. Hard: ignore penetrations up to this depth. Clearance: required distance. */
  tolerance: number;
  models: ModelInput[];
  limits: { maxElements: number; maxTriangles: number; maxCandidatePairs: number; maxClashes: number; timeoutMs: number };
}

export interface ClashElementOut {
  model: number;
  globalId: string;
  ifcClass: string;
  name: string | null;
  storey: string | null;
  system: string | null;
}

export interface ClashOut {
  a: number;
  b: number;
  point: [number, number, number];
  distance: number;
}

const input: Input = workerData ?? {
  wasmDir: "",
  type: "hard",
  tolerance: 0,
  models: [],
  limits: { maxElements: 1, maxTriangles: 1, maxCandidatePairs: 1, maxClashes: 1, timeoutMs: 60_000 },
};
const started = Date.now();
const deadline = started + input.limits.timeoutMs;

/** Touching / numerical noise threshold (metres): contact closer than this is not a penetration. */
const EPS = 1e-4;

/** Spatial structure and openings are not clash candidates. */
const NOT_ELEMENTS = new Set([
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCFACILITY",
  "IFCFACILITYPART",
  "IFCBRIDGE",
  "IFCBRIDGEPART",
  "IFCROAD",
  "IFCROADPART",
  "IFCRAILWAY",
  "IFCRAILWAYPART",
  "IFCMARINEFACILITY",
  "IFCMARINEPART",
  "IFCSPATIALZONE",
  "IFCEXTERNALSPATIALELEMENT",
  "IFCOPENINGELEMENT",
  "IFCOPENINGSTANDARDCASE",
  "IFCVIRTUALELEMENT",
]);

class ClashError extends Error {}

interface Bvh {
  /** 6 numbers per node: min xyz, max xyz. */
  box: Float64Array;
  /** Child indices; -1 for leaves. */
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  count: Int32Array;
  /** Triangle indices, leaves point into this array. */
  order: Uint32Array;
}

interface Element {
  idx: number;
  /** "fileId|GlobalId": orders the pair when both elements are in both selections. */
  key: string;
  model: number;
  expressId: number;
  globalId: string;
  ifcClass: string;
  name: string | null;
  inA: boolean;
  inB: boolean;
  /** World positions (metres, IFC axes), 3 per vertex. */
  pos: Float64Array;
  /** 3 vertex indices per triangle. */
  tri: Uint32Array;
  box: Float64Array;
  bvh: Bvh | null;
  storey: string | null;
  system: string | null;
}

function checkTime() {
  if (Date.now() > deadline)
    throw new ClashError(
      jt("clash.timeLimit", { minutes: Math.round(input.limits.timeoutMs / 60000) }),
    );
}

function reader(fd: number) {
  const chunk = 4 * 1024 * 1024;
  const buffer = new Uint8Array(chunk);
  return (offset: number, size = chunk) => {
    const buf = size <= chunk ? buffer : new Uint8Array(size);
    const n = readSync(fd, buf, 0, Math.min(size, buf.length), offset);
    return buf.subarray(0, n);
  };
}

function ref(v: unknown): number | null {
  if (v && typeof v === "object" && (v as { type?: unknown }).type === 5) {
    const id = (v as { value?: unknown }).value;
    return typeof id === "number" ? id : null;
  }
  return null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  if ("value" in o && o.type !== 5) {
    const x = o.value;
    if (typeof x === "boolean") return x ? "true" : "false";
    if (x === "T") return "true";
    if (x === "F") return "false";
    return x === null || x === undefined ? null : String(x);
  }
  if ("_representationValue" in o) return String(o._representationValue);
  return null;
}

function classMatches(cls: string, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const c = cls.toLowerCase();
  return wanted.some((w) => c === w || c === `${w}standardcase` || c === `${w}elementedcase`);
}

/** Loads one model's selected elements with geometry and metadata. */
async function loadModel(api: WebIFC.IfcAPI, m: ModelInput, modelIndex: number, out: Element[], totals: { triangles: number }) {
  const fd = openSync(m.path, "r");
  let modelId = -1;
  try {
    const read = reader(fd);
    modelId = api.OpenModelFromCallback((offset: number, size: number) => read(offset, size), {
      COORDINATE_TO_ORIGIN: false,
    });
    const classOf = new Map<number, string>();
    for (const t of api.GetAllTypesOfModel(modelId)) {
      if (!api.IsIfcElement(t.typeID) || NOT_ELEMENTS.has(t.typeName.toUpperCase())) continue;
      const ids = api.GetLineIDsWithType(modelId, t.typeID);
      for (let i = 0; i < ids.size(); i++) classOf.set(ids.get(i), t.typeName);
    }

    const needProps = !!(m.selA?.property || m.selB?.property);
    const props = needProps ? propertyReader(api, modelId) : null;
    const pick = (eid: number, cls: string, sel: Selection | null) => {
      if (!sel || !classMatches(cls, sel.classes)) return false;
      if (sel.property && !props!.matches(eid, sel.property)) return false;
      return true;
    };

    const chosen = new Map<number, { inA: boolean; inB: boolean; cls: string }>();
    for (const [eid, cls] of [...classOf.entries()].sort((a, b) => a[0] - b[0])) {
      const inA = pick(eid, cls, m.selA);
      const inB = pick(eid, cls, m.selB);
      if (inA || inB) chosen.set(eid, { inA, inB, cls });
    }
    if (out.length + chosen.size > input.limits.maxElements * 2)
      throw new ClashError(
        jt("clash.tooManyElements", { count: out.length + chosen.size, limit: input.limits.maxElements }),
      );

    const geo = new Map<number, { pos: number[]; tri: number[] }>();
    const ids = [...chosen.keys()];
    // Errors are not thrown from inside the web-ifc callback; the stream is drained and checked afterwards.
    let tooBig = false;
    if (ids.length) {
      api.StreamMeshes(
        modelId,
        ids,
        (mesh) => {
          if (tooBig) return;
          const eid = mesh.expressID;
          let g = geo.get(eid);
          if (!g) geo.set(eid, (g = { pos: [], tri: [] }));
          const n = mesh.geometries.size();
          for (let i = 0; i < n; i++) {
            const pg = mesh.geometries.get(i);
            const geometry = api.GetGeometry(modelId, pg.geometryExpressID);
            const verts = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const index = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const t = pg.flatTransformation;
            const base = g.pos.length / 3;
            // Vertex layout: position xyz + normal xyz. web-ifc output is Y up; convert back to IFC axes (Z up).
            for (let k = 0; k + 5 < verts.length; k += 6) {
              const x = verts[k]!;
              const y = verts[k + 1]!;
              const z = verts[k + 2]!;
              const wx = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!;
              const wy = t[1]! * x + t[5]! * y + t[9]! * z + t[13]!;
              const wz = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!;
              g.pos.push(wx, -wz, wy);
            }
            for (let k = 0; k + 2 < index.length; k++) g.tri.push(base + index[k]!);
            totals.triangles += Math.floor(index.length / 3);
            geometry.delete();
          }
          if (totals.triangles > input.limits.maxTriangles) tooBig = true;
        },
        true,
      );
    }
    if (tooBig)
      throw new ClashError(
        jt("clash.geometryTooLarge", { limit: input.limits.maxTriangles.toLocaleString(TEXT_INTL) }),
      );

    const meta = metadataReader(api, modelId);
    for (const eid of ids) {
      const g = geo.get(eid);
      if (!g || g.tri.length < 3) continue; // no body geometry
      const c = chosen.get(eid)!;
      const line = api.GetLine(modelId, eid);
      const globalId = text(line?.GlobalId);
      if (!globalId) continue;
      const pos = Float64Array.from(g.pos);
      const tri = Uint32Array.from(g.tri.slice(0, g.tri.length - (g.tri.length % 3)));
      out.push({
        idx: out.length,
        key: `${m.fileId}|${globalId}`,
        model: modelIndex,
        expressId: eid,
        globalId,
        ifcClass: c.cls,
        name: text(line?.Name),
        inA: c.inA,
        inB: c.inB,
        pos,
        tri,
        box: bounds(pos),
        bvh: null,
        storey: meta.storey(eid),
        system: meta.system(eid),
      });
    }
  } finally {
    if (modelId >= 0) api.CloseModel(modelId);
    closeSync(fd);
  }
}

/** Instance and type property sets, read lazily. */
function propertyReader(api: WebIFC.IfcAPI, modelId: number) {
  const psetsOf = new Map<number, number[]>();
  const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(modelId, rels.get(i));
    const def = ref(rel?.RelatingPropertyDefinition);
    if (def === null) continue;
    for (const o of asArray(rel.RelatedObjects)) {
      const oid = ref(o);
      if (oid !== null) psetsOf.set(oid, [...(psetsOf.get(oid) ?? []), def]);
    }
  }
  const typeRels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELDEFINESBYTYPE);
  for (let i = 0; i < typeRels.size(); i++) {
    const rel = api.GetLine(modelId, typeRels.get(i));
    const t = ref(rel?.RelatingType);
    if (t === null) continue;
    const typeLine = api.GetLine(modelId, t);
    const sets = asArray(typeLine?.HasPropertySets).map(ref).filter((x): x is number => x !== null);
    for (const o of asArray(rel.RelatedObjects)) {
      const oid = ref(o);
      // Type sets first; instance sets (added above) are checked before them below.
      if (oid !== null) psetsOf.set(oid, [...(psetsOf.get(oid) ?? []), ...sets]);
    }
  }
  const cache = new Map<number, { name: string | null; props: Map<string, string | null> }>();
  const pset = (id: number) => {
    let p = cache.get(id);
    if (p) return p;
    const line = api.GetLine(modelId, id);
    const props = new Map<string, string | null>();
    for (const r of asArray(line?.HasProperties ?? line?.Quantities)) {
      const pid = ref(r);
      if (pid === null) continue;
      const prop = api.GetLine(modelId, pid);
      const name = text(prop?.Name);
      if (!name) continue;
      const value =
        text(prop.NominalValue) ??
        (Array.isArray(prop.EnumerationValues) ? prop.EnumerationValues.map(text).join(",") : null) ??
        text(prop.LengthValue) ??
        text(prop.AreaValue) ??
        text(prop.VolumeValue) ??
        text(prop.CountValue) ??
        text(prop.WeightValue);
      if (!props.has(name)) props.set(name, value);
    }
    p = { name: text(line?.Name), props };
    cache.set(id, p);
    return p;
  };
  return {
    matches(eid: number, f: { pset: string; name: string; value?: string | null }) {
      for (const id of psetsOf.get(eid) ?? []) {
        const p = pset(id);
        if (f.pset && p.name?.toLowerCase() !== f.pset.toLowerCase()) continue;
        if (!p.props.has(f.name)) continue;
        if (f.value === undefined || f.value === null || f.value === "") return true;
        return (p.props.get(f.name) ?? "").toLowerCase() === f.value.toLowerCase();
      }
      return false;
    },
  };
}

/** Storey (spatial container) and system names for grouping. */
function metadataReader(api: WebIFC.IfcAPI, modelId: number) {
  const container = new Map<number, number>();
  const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(modelId, rels.get(i));
    const s = ref(rel?.RelatingStructure);
    if (s === null) continue;
    for (const o of asArray(rel.RelatedElements)) {
      const oid = ref(o);
      if (oid !== null) container.set(oid, s);
    }
  }
  const parent = new Map<number, number>();
  const aggs = api.GetLineIDsWithType(modelId, WebIFC.IFCRELAGGREGATES);
  for (let i = 0; i < aggs.size(); i++) {
    const rel = api.GetLine(modelId, aggs.get(i));
    const p = ref(rel?.RelatingObject);
    if (p === null) continue;
    for (const o of asArray(rel.RelatedObjects)) {
      const oid = ref(o);
      if (oid !== null) parent.set(oid, p);
    }
  }
  const systemOf = new Map<number, string>();
  const groups = api.GetLineIDsWithType(modelId, WebIFC.IFCRELASSIGNSTOGROUP);
  for (let i = 0; i < groups.size(); i++) {
    const rel = api.GetLine(modelId, groups.get(i));
    const g = ref(rel?.RelatingGroup);
    if (g === null) continue;
    const typeName = api.GetNameFromTypeCode(api.GetLineType(modelId, g)).toUpperCase();
    if (!typeName.includes("SYSTEM") && !typeName.includes("CIRCUIT")) continue;
    const name = text(api.GetLine(modelId, g)?.Name) ?? typeName;
    for (const o of asArray(rel.RelatedObjects)) {
      const oid = ref(o);
      if (oid !== null && !systemOf.has(oid)) systemOf.set(oid, name);
    }
  }
  const names = new Map<number, string | null>();
  const nameOf = (id: number) => {
    if (!names.has(id)) {
      const line = api.GetLine(modelId, id);
      names.set(id, text(line?.Name) ?? text(line?.LongName));
    }
    return names.get(id)!;
  };
  return {
    storey(eid: number): string | null {
      let cur: number | undefined = eid;
      for (let depth = 0; cur !== undefined && depth < 6; depth++) {
        const s = container.get(cur);
        if (s !== undefined) return nameOf(s);
        cur = parent.get(cur);
      }
      return null;
    },
    system(eid: number): string | null {
      let cur: number | undefined = eid;
      for (let depth = 0; cur !== undefined && depth < 6; depth++) {
        const s = systemOf.get(cur);
        if (s !== undefined) return s;
        cur = parent.get(cur);
      }
      return null;
    },
  };
}

function bounds(pos: Float64Array): Float64Array {
  const b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k]!;
      if (v < b[k]!) b[k] = v;
      if (v > b[k + 3]!) b[k + 3] = v;
    }
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// BVH over the triangles of one element

const LEAF = 4;

function buildBvh(el: Element): Bvh {
  const { pos, tri } = el;
  const n = tri.length / 3;
  const cent = new Float64Array(n * 3);
  const tb = new Float64Array(n * 6);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = pos[tri[t * 3]! * 3 + k]!;
      const b = pos[tri[t * 3 + 1]! * 3 + k]!;
      const c = pos[tri[t * 3 + 2]! * 3 + k]!;
      cent[t * 3 + k] = (a + b + c) / 3;
      tb[t * 6 + k] = Math.min(a, b, c);
      tb[t * 6 + 3 + k] = Math.max(a, b, c);
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const box: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const start: number[] = [];
  const count: number[] = [];

  const build = (s: number, c: number): number => {
    const node = left.length;
    left.push(-1);
    right.push(-1);
    start.push(s);
    count.push(c);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = s; i < s + c; i++) {
      const t = order[i]!;
      for (let k = 0; k < 3; k++) {
        bb[k] = Math.min(bb[k]!, tb[t * 6 + k]!);
        bb[k + 3] = Math.max(bb[k + 3]!, tb[t * 6 + 3 + k]!);
        cb[k] = Math.min(cb[k]!, cent[t * 3 + k]!);
        cb[k + 3] = Math.max(cb[k + 3]!, cent[t * 3 + k]!);
      }
    }
    box.push(...bb);
    if (c <= LEAF) return node;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (cb[k + 3]! - cb[k]! > cb[axis + 3]! - cb[axis]!) axis = k;
    if (cb[axis + 3]! - cb[axis]! <= 0) return node; // all centroids in one point
    const slice = Array.from(order.subarray(s, s + c)).sort((x, y) => cent[x * 3 + axis]! - cent[y * 3 + axis]! || x - y);
    order.set(slice, s);
    const half = c >> 1;
    left[node] = build(s, half);
    right[node] = build(s + half, c - half);
    count[node] = 0;
    return node;
  };
  build(0, n);
  return {
    box: Float64Array.from(box),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    start: Int32Array.from(start),
    count: Int32Array.from(count),
    order,
  };
}

function bvhOf(el: Element): Bvh {
  if (!el.bvh) el.bvh = buildBvh(el);
  return el.bvh;
}

function boxesOverlap(a: Float64Array, ai: number, b: Float64Array, bi: number, margin: number): boolean {
  const o = ai * 6;
  const p = bi * 6;
  return (
    a[o]! <= b[p + 3]! + margin &&
    b[p]! <= a[o + 3]! + margin &&
    a[o + 1]! <= b[p + 4]! + margin &&
    b[p + 1]! <= a[o + 4]! + margin &&
    a[o + 2]! <= b[p + 5]! + margin &&
    b[p + 2]! <= a[o + 5]! + margin
  );
}

function boxDistance(a: Float64Array, ai: number, b: Float64Array, bi: number): number {
  const o = ai * 6;
  const p = bi * 6;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(0, a[o + k]! - b[p + 3 + k]!, b[p + k]! - a[o + 3 + k]!);
    s += gap * gap;
  }
  return Math.sqrt(s);
}

// ---------------------------------------------------------------------------------------------
// Triangle geometry. Triangles are passed as 9 numbers in a scratch array.

type V = [number, number, number];
const v = (): V => [0, 0, 0];

function loadTri(el: Element, t: number, out: Float64Array) {
  for (let j = 0; j < 3; j++) {
    const vi = el.tri[t * 3 + j]! * 3;
    out[j * 3] = el.pos[vi]!;
    out[j * 3 + 1] = el.pos[vi + 1]!;
    out[j * 3 + 2] = el.pos[vi + 2]!;
  }
}

/**
 * Segment p→q strictly crossing the plane of triangle (t), at least `margin` inside the
 * triangle's edges. Endpoints on the plane (touching), segments in the plane and crossings on
 * the triangle's border (edge-on-face contact) do not count. Rays use a negative margin.
 */
function segmentCrossesTriangle(px: number, py: number, pz: number, qx: number, qy: number, qz: number, t: Float64Array, hit: V | null, margin = EPS): boolean {
  const ax = t[0]!, ay = t[1]!, az = t[2]!;
  const e1x = t[3]! - ax, e1y = t[4]! - ay, e1z = t[5]! - az;
  const e2x = t[6]! - ax, e2y = t[7]! - ay, e2z = t[8]! - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nl < 1e-12) return false;
  const dp = (nx * (px - ax) + ny * (py - ay) + nz * (pz - az)) / nl;
  const dq = (nx * (qx - ax) + ny * (qy - ay) + nz * (qz - az)) / nl;
  if (!((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS))) return false;
  const s = dp / (dp - dq);
  const xx = px + s * (qx - px);
  const xy = py + s * (qy - py);
  const xz = pz + s * (qz - pz);
  // Inside test with edge normals (n · (edge × (x − vertex)) ≥ 0 for all three edges).
  // n · (edge × w) = |n| · |edge| · (distance of x from the edge line, positive inside).
  const side = (ox: number, oy: number, oz: number, ex: number, ey: number, ez: number) => {
    const wx = xx - ox, wy = xy - oy, wz = xz - oz;
    const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (el < 1e-12) return 0;
    return (nx * (ey * wz - ez * wy) + ny * (ez * wx - ex * wz) + nz * (ex * wy - ey * wx)) / (nl * el);
  };
  const tol = margin;
  if (side(ax, ay, az, e1x, e1y, e1z) < tol) return false;
  if (side(t[3]!, t[4]!, t[5]!, t[6]! - t[3]!, t[7]! - t[4]!, t[8]! - t[5]!) < tol) return false;
  if (side(t[6]!, t[7]!, t[8]!, ax - t[6]!, ay - t[7]!, az - t[8]!) < tol) return false;
  if (hit) {
    hit[0] = xx;
    hit[1] = xy;
    hit[2] = xz;
  }
  return true;
}

/** Strict surface intersection of two triangles; crossing points are added to `points`. */
function trianglesCross(a: Float64Array, b: Float64Array, points: number[] | null): boolean {
  let found = false;
  const hit = v();
  for (const [s, o] of [
    [a, b],
    [b, a],
  ] as const) {
    for (let e = 0; e < 3; e++) {
      const i = e * 3;
      const j = ((e + 1) % 3) * 3;
      if (segmentCrossesTriangle(s[i]!, s[i + 1]!, s[i + 2]!, s[j]!, s[j + 1]!, s[j + 2]!, o, points ? hit : null)) {
        found = true;
        if (!points) return true;
        points.push(hit[0], hit[1], hit[2]);
      }
    }
  }
  return found;
}

/** Closest point on triangle t to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointTriangle(px: number, py: number, pz: number, t: Float64Array, out: V) {
  const ax = t[0]!, ay = t[1]!, az = t[2]!;
  const bx = t[3]!, by = t[4]!, bz = t[5]!;
  const cx = t[6]!, cy = t[7]!, cz = t[8]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(out, ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(out, bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const w = d1 / (d1 - d3);
    return set(out, ax + w * abx, ay + w * aby, az + w * abz);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(out, cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(out, ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(out, bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }
  const denom = 1 / (va + vb + vc);
  const vv = vb * denom;
  const ww = vc * denom;
  return set(out, ax + abx * vv + acx * ww, ay + aby * vv + acy * ww, az + abz * vv + acz * ww);
}

function set(out: V, x: number, y: number, z: number) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/** Closest points of segments p1q1 and p2q2 (Ericson 5.1.9). */
function closestSegmentSegment(s: Float64Array, i: number, j: number, o: Float64Array, k: number, l: number, c1: V, c2: V) {
  const d1x = s[j]! - s[i]!, d1y = s[j + 1]! - s[i + 1]!, d1z = s[j + 2]! - s[i + 2]!;
  const d2x = o[l]! - o[k]!, d2y = o[l + 1]! - o[k + 1]!, d2z = o[l + 2]! - o[k + 2]!;
  const rx = s[i]! - o[k]!, ry = s[i + 1]! - o[k + 1]!, rz = s[i + 2]! - o[k + 2]!;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let sp: number;
  let tp: number;
  if (a <= 1e-18 && e <= 1e-18) {
    sp = 0;
    tp = 0;
  } else if (a <= 1e-18) {
    sp = 0;
    tp = clamp(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-18) {
      tp = 0;
      sp = clamp(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      sp = denom !== 0 ? clamp((b * f - c * e) / denom) : 0;
      tp = (b * sp + f) / e;
      if (tp < 0) {
        tp = 0;
        sp = clamp(-c / a);
      } else if (tp > 1) {
        tp = 1;
        sp = clamp((b - c) / a);
      }
    }
  }
  set(c1, s[i]! + d1x * sp, s[i + 1]! + d1y * sp, s[i + 2]! + d1z * sp);
  set(c2, o[k]! + d2x * tp, o[k + 1]! + d2y * tp, o[k + 2]! + d2z * tp);
}

function clamp(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const tmpA = v();
const tmpB = v();

/** Minimum distance between two triangles; closest points go to pa / pb. */
function triangleDistance(a: Float64Array, b: Float64Array, pa: V, pb: V): number {
  const hit = v();
  for (const [s, o] of [
    [a, b],
    [b, a],
  ] as const) {
    for (let e = 0; e < 3; e++) {
      const i = e * 3;
      const j = ((e + 1) % 3) * 3;
      if (segmentCrossesTriangle(s[i]!, s[i + 1]!, s[i + 2]!, s[j]!, s[j + 1]!, s[j + 2]!, o, hit)) {
        set(pa, hit[0], hit[1], hit[2]);
        set(pb, hit[0], hit[1], hit[2]);
        return 0;
      }
    }
  }
  let best = Infinity;
  const consider = (x1: V, x2: V, swap: boolean) => {
    const dx = x1[0] - x2[0], dy = x1[1] - x2[1], dz = x1[2] - x2[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      if (swap) {
        set(pa, x2[0], x2[1], x2[2]);
        set(pb, x1[0], x1[1], x1[2]);
      } else {
        set(pa, x1[0], x1[1], x1[2]);
        set(pb, x2[0], x2[1], x2[2]);
      }
    }
  };
  for (let e = 0; e < 3; e++) {
    for (let f = 0; f < 3; f++) {
      closestSegmentSegment(a, e * 3, ((e + 1) % 3) * 3, b, f * 3, ((f + 1) % 3) * 3, tmpA, tmpB);
      consider(tmpA, tmpB, false);
    }
  }
  for (let e = 0; e < 3; e++) {
    set(tmpA, a[e * 3]!, a[e * 3 + 1]!, a[e * 3 + 2]!);
    closestPointTriangle(tmpA[0], tmpA[1], tmpA[2], b, tmpB);
    consider(tmpA, tmpB, false);
    set(tmpA, b[e * 3]!, b[e * 3 + 1]!, b[e * 3 + 2]!);
    closestPointTriangle(tmpA[0], tmpA[1], tmpA[2], a, tmpB);
    consider(tmpA, tmpB, true);
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------------------------
// Narrow phase

const triA = new Float64Array(9);
const triB = new Float64Array(9);
let narrowChecks = 0;

/** Pairs of BVH nodes whose boxes pass `keep`, visited depth-first in a fixed order. */
function traverse(ea: Element, eb: Element, keep: (ba: Bvh, na: number, bb: Bvh, nb: number) => boolean, leaf: (ta: number, tb: number) => boolean) {
  const ba = bvhOf(ea);
  const bb = bvhOf(eb);
  const stack: number[] = [0, 0];
  while (stack.length) {
    const nb = stack.pop()!;
    const na = stack.pop()!;
    if (!keep(ba, na, bb, nb)) continue;
    const la = ba.left[na]! < 0;
    const lb = bb.left[nb]! < 0;
    if (la && lb) {
      if ((++narrowChecks & 0xfff) === 0) checkTime();
      for (let i = ba.start[na]!; i < ba.start[na]! + ba.count[na]!; i++) {
        for (let j = bb.start[nb]!; j < bb.start[nb]! + bb.count[nb]!; j++) {
          if (leaf(ba.order[i]!, bb.order[j]!)) return;
        }
      }
      continue;
    }
    // Descend into the larger node (or the one that is not a leaf).
    const sizeA = la ? -1 : boxSize(ba.box, na);
    const sizeB = lb ? -1 : boxSize(bb.box, nb);
    if (sizeA >= sizeB) {
      stack.push(ba.right[na]!, nb, ba.left[na]!, nb);
    } else {
      stack.push(na, bb.right[nb]!, na, bb.left[nb]!);
    }
  }
}

function boxSize(b: Float64Array, n: number) {
  const o = n * 6;
  return b[o + 3]! - b[o]! + b[o + 4]! - b[o + 1]! + b[o + 5]! - b[o + 2]!;
}

/** Smallest-axis overlap of the two element boxes. Correct when one element sits fully inside the other. */
function overlapDepth(a: Element, b: Element): number {
  let d = Infinity;
  for (let k = 0; k < 3; k++) d = Math.min(d, Math.min(a.box[k + 3]!, b.box[k + 3]!) - Math.max(a.box[k]!, b.box[k]!));
  return Math.max(0, d);
}

const RAYS: V[] = (
  [
    [0.5377, 0.4231, 0.7298],
    [-0.221, 0.812, 0.541],
    [0.801, -0.312, 0.51],
  ] as V[]
).map((d) => {
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
});

const rayTri = new Float64Array(9);
const nearTri = new Float64Array(9);
const nearPoint = v();

/** Odd crossing count along one ray. A single ray mis-counts a point in a hole, so callers require several. */
function rayOdd(px: number, py: number, pz: number, el: Element, ray: V): boolean {
  const b = bvhOf(el);
  const far = 1e7;
  const qx = px + ray[0] * far, qy = py + ray[1] * far, qz = pz + ray[2] * far;
  let crossings = 0;
  const stack = [0];
  while (stack.length) {
    const n = stack.pop()!;
    if (!rayHitsBox(px, py, pz, ray, b.box, n)) continue;
    if (b.left[n]! < 0) {
      for (let i = b.start[n]!; i < b.start[n]! + b.count[n]!; i++) {
        loadTri(el, b.order[i]!, rayTri);
        if (segmentCrossesTriangle(px, py, pz, qx, qy, qz, rayTri, null, -1e-9)) crossings++;
      }
    } else stack.push(b.right[n]!, b.left[n]!);
  }
  return crossings % 2 === 1;
}

function rayHitsBox(px: number, py: number, pz: number, ray: V, box: Float64Array, n: number): boolean {
  let tmin = 0;
  let tmax = Infinity;
  const p = [px, py, pz];
  for (let k = 0; k < 3; k++) {
    const lo = box[n * 6 + k]!;
    const hi = box[n * 6 + 3 + k]!;
    const d = ray[k]!;
    const o = p[k]!;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/**
 * Inside a solid. Rays that all agree decide. One ray alone is fooled by a slat ring or a window
 * opening, and requiring every ray drops a plate inside a slab whose exported mesh has a gap;
 * when the rays disagree, the generalised winding number decides.
 */
function pointInside(px: number, py: number, pz: number, el: Element): boolean {
  let odd = 0;
  for (const ray of RAYS) if (rayOdd(px, py, pz, el, ray)) odd++;
  if (odd === RAYS.length) return true;
  if (odd === 0) return false;
  return Math.abs(windingNumber(px, py, pz, el)) >= 0.5;
}

/**
 * Generalised winding number (sum of the triangles' solid angles / 4π): about 1 inside a
 * closed mesh, 0 outside, and still close to that for a mesh with gaps. The sign follows the
 * triangle winding, which IFC exports do not keep consistently, so callers use its size.
 */
function windingNumber(px: number, py: number, pz: number, el: Element): number {
  let sum = 0;
  const n = el.tri.length / 3;
  for (let i = 0; i < n; i++) {
    loadTri(el, i, rayTri);
    const ax = rayTri[0]! - px, ay = rayTri[1]! - py, az = rayTri[2]! - pz;
    const bx = rayTri[3]! - px, by = rayTri[4]! - py, bz = rayTri[5]! - pz;
    const cx = rayTri[6]! - px, cy = rayTri[7]! - py, cz = rayTri[8]! - pz;
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
    sum += 2 * Math.atan2(det, den);
  }
  return sum / (4 * Math.PI);
}

/**
 * Every vertex of `inner` inside `outer` or on its surface: a plate flush with the slab's top
 * face is still inside the slab. One vertex is not enough, it may sit in a face it only grazes.
 */
function contains(outer: Element, inner: Element): boolean {
  for (let k = 0; k < 3; k++) {
    if (inner.box[k]! < outer.box[k]! - EPS || inner.box[k + 3]! > outer.box[k + 3]! + EPS) return false;
  }
  const p = inner.pos;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (!pointInside(x, y, z, outer) && distanceToMesh(x, y, z, outer) > EPS) return false;
  }
  return true;
}

function pointBoxDist2(px: number, py: number, pz: number, box: Float64Array, n: number): number {
  const o = n * 6;
  const p = [px, py, pz];
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const v = p[k]!;
    const lo = box[o + k]!;
    const hi = box[o + 3 + k]!;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    s += d * d;
  }
  return s;
}

/** Distance from a point to the closest point on the mesh. */
function distanceToMesh(px: number, py: number, pz: number, el: Element): number {
  const b = bvhOf(el);
  let best = Infinity;
  const stack = [0];
  while (stack.length) {
    const n = stack.pop()!;
    if (pointBoxDist2(px, py, pz, b.box, n) >= best) continue;
    if (b.left[n]! < 0) {
      for (let i = b.start[n]!; i < b.start[n]! + b.count[n]!; i++) {
        loadTri(el, b.order[i]!, nearTri);
        closestPointTriangle(px, py, pz, nearTri, nearPoint);
        const dx = px - nearPoint[0], dy = py - nearPoint[1], dz = pz - nearPoint[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    } else stack.push(b.right[n]!, b.left[n]!);
  }
  return Math.sqrt(best);
}

/** Deepest vertex of `inner` that lies inside `outer`, measured to the outer surface. */
function vertexIntrusion(inner: Element, outer: Element): number {
  const p = inner.pos;
  const o = outer.box;
  let best = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < o[0]! - EPS || y < o[1]! - EPS || z < o[2]! - EPS || x > o[3]! + EPS || y > o[4]! + EPS || z > o[5]! + EPS) continue;
    if (!pointInside(x, y, z, outer)) continue;
    const d = distanceToMesh(x, y, z, outer);
    if (d > best) best = d;
  }
  return best;
}

/**
 * Thinnest extent of a point cloud. The axis-aligned box and the smallest principal axis are
 * both upper bounds; the smaller one is kept, so a flat diagonal scar stays near zero and an
 * axis-aligned pierce keeps the real thickness.
 */
function cloudThickness(points: number[]): number {
  const n = points.length / 3;
  if (n < 2) return 0;
  const box = pointsBox(points);
  let aligned = Infinity;
  for (let k = 0; k < 3; k++) aligned = Math.min(aligned, box[k + 3]! - box[k]!);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < points.length; i += 3) {
    cx += points[i]!;
    cy += points[i + 1]!;
    cz += points[i + 2]!;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]! - cx, y = points[i + 1]! - cy, z = points[i + 2]! - cz;
    xx += x * x;
    yy += y * y;
    zz += z * z;
    xy += x * y;
    xz += x * z;
    yz += y * z;
  }
  const axis = smallestAxis(xx, yy, zz, xy, xz, yz);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const t = (points[i]! - cx) * axis[0] + (points[i + 1]! - cy) * axis[1] + (points[i + 2]! - cz) * axis[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return Math.max(0, Math.min(aligned, hi - lo));
}

/** Smallest-eigenvector of a symmetric 3×3, Jacobi. Columns of `v` are the axes. */
function smallestAxis(c00: number, c11: number, c22: number, c01: number, c02: number, c12: number): V {
  const a = [
    [c00, c01, c02],
    [c01, c11, c12],
    [c02, c12, c22],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p]![p]!;
        const aqq = a[q]![q]!;
        const tau = (aqq - app) / (2 * apq);
        const t = tau === 0 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        a[p]![p] = app - t * apq;
        a[q]![q] = aqq + t * apq;
        a[p]![q] = 0;
        a[q]![p] = 0;
        for (let r = 0; r < 3; r++) {
          if (r === p || r === q) continue;
          const arp = a[r]![p]!;
          const arq = a[r]![q]!;
          const np = c * arp - s * arq;
          const nq = s * arp + c * arq;
          a[r]![p] = a[p]![r] = np;
          a[r]![q] = a[q]![r] = nq;
        }
        for (let r = 0; r < 3; r++) {
          const vp = v[r]![p]!;
          const vq = v[r]![q]!;
          v[r]![p] = c * vp - s * vq;
          v[r]![q] = s * vp + c * vq;
        }
      }
    }
  }
  let k = 0;
  if (a[1]![1]! < a[k]![k]!) k = 1;
  if (a[2]![2]! < a[k]![k]!) k = 2;
  return [v[0]![k]!, v[1]![k]!, v[2]![k]!];
}

function collectCrossings(a: Element, b: Element, points: number[]) {
  traverse(
    a,
    b,
    (ba, na, bb, nb) => boxesOverlap(ba.box, na, bb.box, nb, EPS),
    (ta, tb) => {
      loadTri(a, ta, triA);
      loadTri(b, tb, triB);
      trianglesCross(triA, triB, points);
      return points.length >= 3 * 256;
    },
  );
}

function pointsBox(points: number[]): number[] {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k]!, points[i + k]!);
      box[k + 3] = Math.max(box[k + 3]!, points[i + k]!);
    }
  }
  return box;
}

/** Thickness of a surface intersection, or null when the triangles do not cross. */
function intersection(a: Element, b: Element): { point: [number, number, number]; depth: number } | null {
  const points: number[] = [];
  collectCrossings(a, b, points);
  if (!points.length) return null;
  const depth = Math.max(cloudThickness(points), vertexIntrusion(a, b), vertexIntrusion(b, a));
  return { point: center(pointsBox(points)), depth };
}

function hardClash(a: Element, b: Element): ClashOut | null {
  const hit = intersection(a, b);
  if (hit) {
    if (hit.depth <= Math.max(input.tolerance, EPS)) return null;
    return { a: a.idx, b: b.idx, point: hit.point, distance: -hit.depth };
  }
  // No surface crossing: one element may lie completely inside the other.
  const depth = overlapDepth(a, b);
  for (const [outer, inner] of [
    [b, a],
    [a, b],
  ] as const) {
    if (contains(outer, inner)) {
      if (depth <= input.tolerance) return null;
      return { a: a.idx, b: b.idx, point: center(Array.from(inner.box)), distance: -depth };
    }
  }
  return null;
}

function clearanceClash(a: Element, b: Element): ClashOut | null {
  let best = input.tolerance;
  const pa = v();
  const pb = v();
  const ca = v();
  const cb = v();
  let found = false;
  traverse(
    a,
    b,
    (ba, na, bb, nb) => boxDistance(ba.box, na, bb.box, nb) < best,
    (ta, tb) => {
      loadTri(a, ta, triA);
      loadTri(b, tb, triB);
      const d = triangleDistance(triA, triB, ca, cb);
      if (d < best) {
        best = d;
        found = true;
        set(pa, ca[0], ca[1], ca[2]);
        set(pb, cb[0], cb[1], cb[2]);
      }
      return best === 0;
    },
  );
  if (!found) {
    // Fully inside each other without touching surfaces: distance 0.
    if (!contains(b, a) && !contains(a, b)) return null;
    return { a: a.idx, b: b.idx, point: center(Array.from(overlapBox(a, b))), distance: -overlapDepth(a, b) };
  }
  const point: [number, number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
  if (best === 0) {
    const hit = intersection(a, b);
    const depth = hit?.depth ?? 0;
    if (depth <= EPS) return { a: a.idx, b: b.idx, point: round3(point), distance: 0 };
    return { a: a.idx, b: b.idx, point: hit!.point, distance: -depth };
  }
  return { a: a.idx, b: b.idx, point: round3(point), distance: best };
}

function overlapBox(a: Element, b: Element): number[] {
  const o: number[] = [];
  for (let k = 0; k < 3; k++) o.push(Math.max(a.box[k]!, b.box[k]!));
  for (let k = 0; k < 3; k++) o.push(Math.min(a.box[k + 3]!, b.box[k + 3]!));
  return o;
}

function center(box: number[]): [number, number, number] {
  return round3([(box[0]! + box[3]!) / 2, (box[1]! + box[4]!) / 2, (box[2]! + box[5]!) / 2]);
}

function round3(p: [number, number, number]): [number, number, number] {
  return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, Math.round(p[2] * 1e6) / 1e6];
}

// ---------------------------------------------------------------------------------------------
// Broad phase: sweep and prune on X

function candidatePairs(elements: Element[], margin: number): [Element, Element][] {
  const items = elements.filter((e) => e.inA || e.inB).sort((x, y) => x.box[0]! - y.box[0]! || x.idx - y.idx);
  const activeA: Element[] = [];
  const activeB: Element[] = [];
  const seen = new Set<number>();
  const n = elements.length;
  const pairs: [Element, Element][] = [];
  const overlapsYZ = (p: Element, q: Element) =>
    p.box[1]! <= q.box[4]! + margin &&
    q.box[1]! <= p.box[4]! + margin &&
    p.box[2]! <= q.box[5]! + margin &&
    q.box[2]! <= p.box[5]! + margin;
  const prune = (list: Element[], x: number) => {
    let w = 0;
    for (const e of list) if (e.box[3]! + margin >= x) list[w++] = e;
    list.length = w;
  };
  for (const it of items) {
    const x = it.box[0]!;
    prune(activeA, x);
    prune(activeB, x);
    const test = (others: Element[], itIsA: boolean) => {
      for (const o of others) {
        if (o === it || !overlapsYZ(it, o)) continue;
        const lo = Math.min(it.idx, o.idx);
        const hi = Math.max(it.idx, o.idx);
        const key = lo * n + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        // Orientation: the element in selection A goes first; when both are in both selections the
        // lower (file, GlobalId) key goes first, so the pair (and its stable id) never flips.
        const [a, b] = itIsA ? (o.inA && o.inB && it.inB && o.key < it.key ? [o, it] : [it, o]) : [o, it];
        pairs.push([a, b]);
        if (pairs.length > input.limits.maxCandidatePairs)
          throw new ClashError(
            jt("clash.tooManyPairs", { limit: input.limits.maxCandidatePairs.toLocaleString(TEXT_INTL) }),
          );
      }
    };
    if (it.inA) test(activeB, true);
    if (it.inB) test(activeA, false);
    if (it.inA) activeA.push(it);
    if (it.inB) activeB.push(it);
  }
  return pairs.sort((p, q) => p[0].idx - q[0].idx || p[1].idx - q[1].idx);
}

async function main() {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(input.wasmDir, true);
  await api.Init();
  const elements: Element[] = [];
  const totals = { triangles: 0 };
  const t0 = Date.now();
  for (let i = 0; i < input.models.length; i++) {
    await loadModel(api, input.models[i]!, i, elements, totals);
    checkTime();
  }
  const elementsA = elements.filter((e) => e.inA).length;
  const elementsB = elements.filter((e) => e.inB).length;
  if (elementsA > input.limits.maxElements || elementsB > input.limits.maxElements)
    throw new ClashError(
      jt("clash.tooManyElementsAB", { a: elementsA, b: elementsB, limit: input.limits.maxElements }),
    );
  const t1 = Date.now();
  const margin = input.type === "clearance" ? input.tolerance : EPS;
  const pairs = candidatePairs(elements, margin);
  const t2 = Date.now();
  const clashes: ClashOut[] = [];
  for (const [a, b] of pairs) {
    const c = input.type === "hard" ? hardClash(a, b) : clearanceClash(a, b);
    if (c) {
      clashes.push(c);
      if (clashes.length > input.limits.maxClashes)
        throw new ClashError(
          jt("clash.tooManyClashes", { limit: input.limits.maxClashes.toLocaleString(TEXT_INTL) }),
        );
    }
    checkTime();
  }
  const t3 = Date.now();
  const used = new Set<number>();
  for (const c of clashes) {
    used.add(c.a);
    used.add(c.b);
  }
  const out: Record<number, ClashElementOut> = {};
  for (const e of elements) {
    if (!used.has(e.idx)) continue;
    out[e.idx] = { model: e.model, globalId: e.globalId, ifcClass: e.ifcClass, name: e.name, storey: e.storey, system: e.system };
  }
  parentPort?.postMessage({
    type: "done",
    elements: out,
    clashes,
    stats: {
      elementsA,
      elementsB,
      triangles: totals.triangles,
      candidatePairs: pairs.length,
      clashes: clashes.length,
      timings: { geometry: t1 - t0, broad: t2 - t1, narrow: t3 - t2 },
    },
  });
}

function meshElement(mesh: { pos: ArrayLike<number>; tri: ArrayLike<number> }, idx: number): Element {
  const pos = Float64Array.from(mesh.pos);
  return {
    idx,
    key: String(idx),
    model: 0,
    expressId: idx,
    globalId: String(idx),
    ifcClass: "IfcBuildingElementProxy",
    name: null,
    inA: true,
    inB: true,
    pos,
    tri: Uint32Array.from(mesh.tri),
    box: bounds(pos),
    bvh: null,
    storey: null,
    system: null,
  };
}

/** Hard clash of two triangle meshes. `toleranceM` ignores penetrations up to that depth (metres). */
export function hardClashMeshes(
  a: { pos: ArrayLike<number>; tri: ArrayLike<number> },
  b: { pos: ArrayLike<number>; tri: ArrayLike<number> },
  toleranceM = 0,
): ClashOut | null {
  input.tolerance = toleranceM;
  input.type = "hard";
  return hardClash(meshElement(a, 0), meshElement(b, 1));
}

/** Clearance clash. Positive distance is the gap; negative is penetration. Null when the gap is at least `toleranceM`. */
export function clearanceClashMeshes(
  a: { pos: ArrayLike<number>; tri: ArrayLike<number> },
  b: { pos: ArrayLike<number>; tri: ArrayLike<number> },
  toleranceM: number,
): ClashOut | null {
  input.tolerance = toleranceM;
  input.type = "clearance";
  return clearanceClash(meshElement(a, 0), meshElement(b, 1));
}

if (parentPort && workerData) {
  try {
    await main();
  } catch (err) {
    parentPort.postMessage({
      type: "error",
      message: err instanceof ClashError ? err.message : jt("clash.failed", { reason: err instanceof Error ? err.message : String(err) }),
    });
  }
}
