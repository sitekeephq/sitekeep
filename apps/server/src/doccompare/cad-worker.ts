/**
 * DWG / DXF version comparison (FP-1, docs/features/DOCUMENT_COMPARISON.md). Runs in a worker
 * thread so a large drawing never blocks the server; the parser and the diff are exported for
 * tests. The DWG is read as the DXF its viewer preview already made (LibreDWG dwg2dxf).
 *
 * Every entity of the ENTITIES section (model and paper space) gets four fingerprints: layer,
 * geometry (coordinates, sizes, flags, the block an INSERT places with that block's contents),
 * text (TEXT / MTEXT / attribute values) and display style (colour, linetype, lineweight …).
 * Handles, owners and reactors are left out, so re-saving an unchanged drawing gives the same
 * fingerprints. Entities are paired by handle when the handles are stable between the two
 * versions, else by fingerprint (a drawing re-created from scratch gets new handles).
 *
 * No relative imports: the file runs as a worker (see jobs/ifc-worker.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import type {
  CadChangeAspect,
  CadCompareSummary,
  CadLayerPropChange,
  CadLayerSummary,
  VersionDiffChange,
  VersionDiffRow,
} from "@sitekeep/shared";

export interface CadEntity {
  /** Handle (group code 5); null when the writer left it out. */
  h: string | null;
  /** Entity type (LINE, INSERT …). */
  t: string;
  /** Layer name. */
  l: string;
  /** Geometry fingerprint. */
  g: string;
  /** Text fingerprint ("" without text). */
  x: string;
  /** Display style values (colour, linetype, lineweight …), only those the entity sets. */
  s: Record<string, string>;
  /** Shown text (cleaned, shortened). */
  text: string | null;
  /** Block an INSERT places. */
  block: string | null;
}

export interface CadLayer {
  name: string;
  color: string | null;
  off: boolean;
  frozen: boolean;
  locked: boolean;
  linetype: string | null;
  lineweight: string | null;
  plot: boolean;
  trueColor: string | null;
}

export interface CadDrawing {
  entities: CadEntity[];
  layers: Map<string, CadLayer>;
}

type Pair = [number, string];
interface RawRecord {
  type: string;
  pairs: Pair[];
  subs: RawRecord[];
}

/** Sub-entities that belong to the entity before them (polyline vertices, attributes). */
const SUB_TYPES = new Set(["VERTEX", "ATTRIB", "SEQEND"]);
/** Text group codes per entity type. */
const TEXT_CODES: Record<string, number[]> = {
  TEXT: [1],
  ATTRIB: [1],
  ATTDEF: [1],
  MTEXT: [1, 3],
  DIMENSION: [1],
  MULTILEADER: [304],
  MLEADER: [304],
};
/** Display style group codes and their names. */
const STYLE_CODES: Record<number, string> = {
  6: "linetype",
  7: "textStyle",
  48: "ltscale",
  60: "visibility",
  62: "color",
  370: "lineweight",
  420: "trueColor",
  430: "colorName",
  440: "transparency",
};
/** Visual values that a missing code means by default (BYLAYER and the like). */
const STYLE_DEFAULTS: Record<string, string> = { linetype: "BYLAYER", color: "256", lineweight: "-1", ltscale: "1", visibility: "0" };

function skipped(code: number): boolean {
  return (
    code === 5 ||
    code === 100 ||
    code === 102 ||
    code === 105 ||
    (code >= 320 && code <= 369) ||
    (code >= 390 && code <= 399) ||
    code === 480 ||
    code === 481 ||
    code >= 1000
  );
}

function isReal(code: number): boolean {
  return (code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 460 && code <= 469);
}

function normValue(code: number, raw: string): string {
  const v = raw.trim();
  if (!isReal(code)) return v;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return v;
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

function fingerprint(parts: string[]): string {
  if (!parts.length) return "";
  return createHash("sha1").update(parts.join("\u0001")).digest("base64url").slice(0, 16);
}

const MTEXT_SPECIAL: Record<string, string> = { c: "Ø", d: "°", p: "±" };

/** Plain text of an MTEXT/TEXT value (same rules as the preview's search text). */
export function cleanCadText(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%([cdp])/gi, (_, k: string) => MTEXT_SPECIAL[k.toLowerCase()]!)
    .replace(/%%u|%%o/gi, "")
    .replace(/\\[Pp]/g, " ")
    .replace(/\\[Ss]([^;]*?)[#^/]([^;]*);/g, "$1/$2")
    .replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, "")
    .replace(/\\[LlOoKkNn~]/g, (m) => (m === "\\~" ? " " : ""))
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text encoding of a DXF: given by the preview, else from the header (AC1021+ is UTF-8). */
export function dxfEncoding(buf: Buffer): string {
  const head = buf.subarray(0, 512 * 1024).toString("latin1");
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head)?.[1] ?? "";
  if (ver >= "AC1021") return "utf-8";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    if (buf.some((b) => b >= 0x80)) return "utf-8";
  } catch {
    /* not UTF-8 */
  }
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/i.exec(head)?.[1];
  const label = cp ? `windows-${cp}` : "windows-1252";
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return "windows-1252";
  }
}

/** Marks a binary DXF (the comparison reads ASCII DXF only). */
export const BINARY_DXF = "BINARY_DXF";

/** Layers and entities of an ASCII DXF. */
export function parseDxf(text: string): CadDrawing {
  const lines = text.split(/\r?\n/);
  const layers = new Map<string, CadLayer>();
  const blocks = new Map<string, RawRecord[]>();
  const entities: RawRecord[] = [];
  let section = "";
  let current: RawRecord | null = null;
  let block: { name: string; list: RawRecord[] } | null = null;
  /** The last entity record of the current list (sub-entities attach to it). */
  let owner: RawRecord | null = null;

  const valueOf = (r: RawRecord, code: number) => r.pairs.find((p) => p[0] === code)?.[1].trim();
  const finish = (r: RawRecord) => {
    if (r.type === "SECTION") {
      section = valueOf(r, 2) ?? "";
      owner = null;
      return;
    }
    if (r.type === "ENDSEC") {
      section = "";
      owner = null;
      return;
    }
    if (section === "TABLES") {
      if (r.type === "LAYER") {
        const layer = layerOf(r);
        if (layer) layers.set(layer.name, layer);
      }
      return;
    }
    if (section === "BLOCKS") {
      if (r.type === "BLOCK") {
        block = { name: valueOf(r, 2) ?? "", list: [] };
        owner = null;
      } else if (r.type === "ENDBLK") {
        if (block) blocks.set(block.name, block.list);
        block = null;
        owner = null;
      } else if (block) {
        if (SUB_TYPES.has(r.type) && owner) owner.subs.push(r);
        else block.list.push((owner = r));
      }
      return;
    }
    if (section === "ENTITIES") {
      if (SUB_TYPES.has(r.type) && owner) owner.subs.push(r);
      else entities.push((owner = r));
    }
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code)) continue;
    const value = lines[i + 1]!;
    if (code === 0) {
      if (current) finish(current);
      const type = value.trim();
      if (type === "EOF") {
        current = null;
        break;
      }
      current = { type, pairs: [], subs: [] };
      continue;
    }
    // Header, classes and objects are not compared; their pairs are not kept.
    if (current && section !== "HEADER" && section !== "CLASSES" && section !== "OBJECTS") current.pairs.push([code, value]);
    else if (current && (current.type === "SECTION" || current.type === "ENDSEC")) current.pairs.push([code, value]);
  }
  if (current) finish(current);

  const blockHashes = new Map<string, string>();
  const busy = new Set<string>();
  const blockHash = (name: string): string => {
    const hit = blockHashes.get(name);
    if (hit !== undefined) return hit;
    if (busy.has(name)) return "";
    busy.add(name);
    const list = blocks.get(name) ?? [];
    const parts = list.map((r) => {
      const e = entityOf(r, blockHash);
      return fingerprint([e.t, e.l, e.g, e.x, styleKey(e.s)]);
    });
    busy.delete(name);
    const h = fingerprint(parts.sort());
    blockHashes.set(name, h);
    return h;
  };
  return { entities: entities.map((r) => entityOf(r, blockHash)), layers };
}

function layerOf(r: RawRecord): CadLayer | null {
  let name: string | null = null;
  let flags = 0;
  let color: number | null = null;
  let linetype: string | null = null;
  let lineweight: string | null = null;
  let plot = true;
  let trueColor: string | null = null;
  for (const [code, raw] of r.pairs) {
    const v = raw.trim();
    if (code === 2) name = v;
    else if (code === 70) flags = Number.parseInt(v, 10) || 0;
    else if (code === 62) color = Number.parseInt(v, 10);
    else if (code === 6) linetype = v;
    else if (code === 370) lineweight = v;
    else if (code === 290) plot = v !== "0";
    else if (code === 420) trueColor = v;
  }
  if (name === null) return null;
  return {
    name,
    color: color === null || !Number.isFinite(color) ? null : String(Math.abs(color)),
    off: color !== null && color < 0,
    frozen: (flags & 1) !== 0,
    locked: (flags & 4) !== 0,
    linetype,
    lineweight,
    plot,
    trueColor,
  };
}

function styleKey(s: Record<string, string>): string {
  return Object.keys(s)
    .sort()
    .map((k) => `${k}=${s[k]}`)
    .join(";");
}

function entityOf(r: RawRecord, blockHash: (name: string) => string): CadEntity {
  const own: { h: string | null; l: string; block: string | null } = { h: null, l: "0", block: null };
  const geom: string[] = [r.type];
  const text: string[] = [];
  const style: Record<string, string> = {};
  const read = (rec: RawRecord, sub: boolean) => {
    const textCodes = TEXT_CODES[rec.type] ?? [];
    if (sub) geom.push(`>${rec.type}`);
    for (const [code, raw] of rec.pairs) {
      if (code === 5) {
        if (!sub && own.h === null) own.h = raw.trim() || null;
        continue;
      }
      if (code === 8 && !sub) {
        own.l = raw.trim() || "0";
        continue;
      }
      if (skipped(code)) continue;
      if (textCodes.includes(code)) {
        text.push(raw);
        continue;
      }
      const styleName = STYLE_CODES[code];
      if (styleName && !sub) {
        style[styleName] = raw.trim();
        continue;
      }
      if (code === 2 && rec.type === "INSERT" && !sub) own.block = raw.trim();
      geom.push(String(code), normValue(code, raw));
    }
  };
  read(r, false);
  for (const s of r.subs) read(s, true);
  if (own.block !== null) geom.push("block", blockHash(own.block));
  for (const [k, v] of Object.entries(style)) if (STYLE_DEFAULTS[k] === v) delete style[k];
  const shown = text.length ? cleanCadText(text.join(r.type === "MTEXT" ? "" : " ")) : "";
  return {
    h: own.h,
    t: r.type,
    l: own.l,
    g: fingerprint(geom),
    x: text.length ? fingerprint(text) : "",
    s: style,
    text: shown ? (shown.length > 160 ? `${shown.slice(0, 160)}…` : shown) : null,
    block: own.block,
  };
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

const fullKey = (e: CadEntity) => `${e.l}\u0001${e.t}\u0001${e.g}\u0001${e.x}\u0001${styleKey(e.s)}`;

/** Pairs entities whose key (one aspect left out) is equal, first come first served. */
function matchBy(a: CadEntity[], b: CadEntity[], key: (e: CadEntity) => string): { pairs: [CadEntity, CadEntity][]; restA: CadEntity[]; restB: CadEntity[] } {
  const pool = new Map<string, CadEntity[]>();
  for (const e of a) {
    const k = key(e);
    const list = pool.get(k);
    if (list) list.push(e);
    else pool.set(k, [e]);
  }
  const pairs: [CadEntity, CadEntity][] = [];
  const restB: CadEntity[] = [];
  for (const e of b) {
    const hit = pool.get(key(e))?.shift();
    if (hit) pairs.push([hit, e]);
    else restB.push(e);
  }
  const used = new Set(pairs.map((p) => p[0]));
  return { pairs, restA: a.filter((e) => !used.has(e)), restB };
}

/** Pairs by fingerprints: equal first, then equal but for one aspect (style, layer, text). */
function matchByFingerprint(a: CadEntity[], b: CadEntity[]): { pairs: [CadEntity, CadEntity][]; restA: CadEntity[]; restB: CadEntity[] } {
  const keys: ((e: CadEntity) => string)[] = [
    fullKey,
    (e) => `${e.l}\u0001${e.t}\u0001${e.g}\u0001${e.x}`,
    (e) => `${e.t}\u0001${e.g}\u0001${e.x}\u0001${styleKey(e.s)}`,
    (e) => `${e.l}\u0001${e.t}\u0001${e.g}\u0001${styleKey(e.s)}`,
  ];
  const pairs: [CadEntity, CadEntity][] = [];
  let restA = a;
  let restB = b;
  for (const key of keys) {
    const m = matchBy(restA, restB, key);
    pairs.push(...m.pairs);
    restA = m.restA;
    restB = m.restB;
  }
  return { pairs, restA, restB };
}

const LAYER_PROPS: CadLayerPropChange["prop"][] = ["color", "linetype", "lineweight", "frozen", "off", "locked", "plot", "trueColor"];

function layerProps(a: CadLayer | undefined, b: CadLayer | undefined): CadLayerPropChange[] {
  if (!a || !b) return [];
  const out: CadLayerPropChange[] = [];
  for (const prop of LAYER_PROPS) {
    const from = a[prop];
    const to = b[prop];
    if (from !== to) out.push({ prop, from: from === null ? null : String(from), to: to === null ? null : String(to) });
  }
  return out;
}

function changesOf(a: CadEntity, b: CadEntity): { aspects: CadChangeAspect[]; changes: VersionDiffChange[] } {
  const aspects: CadChangeAspect[] = [];
  const changes: VersionDiffChange[] = [];
  if (a.l !== b.l) {
    aspects.push("layer");
    changes.push({ prop: "@layer", from: a.l, to: b.l });
  }
  if (a.g !== b.g) {
    aspects.push("geometry");
    changes.push({ prop: "@geometry", from: null, to: null });
  }
  if (a.x !== b.x) {
    aspects.push("text");
    changes.push({ prop: "@text", from: a.text, to: b.text });
  }
  const keys = [...new Set([...Object.keys(a.s), ...Object.keys(b.s)])].sort();
  const styled = keys.filter((k) => a.s[k] !== b.s[k]);
  if (styled.length) {
    aspects.push("style");
    for (const k of styled) changes.push({ prop: `@${k}`, from: a.s[k] ?? STYLE_DEFAULTS[k] ?? null, to: b.s[k] ?? STYLE_DEFAULTS[k] ?? null });
  }
  return { aspects, changes };
}

/** Rows kept in the list of differences (the summary counts everything). */
export const MAX_CAD_ROWS = 200_000;

const KIND_ORDER = { added: 0, removed: 1, changed: 2 } as const;

/** Differences of two drawings, per layer. */
export function diffDrawings(a: CadDrawing, b: CadDrawing, maxRows = MAX_CAD_ROWS): { summary: CadCompareSummary; rows: VersionDiffRow[] } {
  // Handles are used when most entities have one and they still point at the same things.
  const withHandle = (list: CadEntity[]) => list.filter((e) => e.h !== null).length;
  const handled = withHandle(a.entities) >= a.entities.length * 0.9 && withHandle(b.entities) >= b.entities.length * 0.9;
  const byFingerprint = matchByFingerprint(a.entities, b.entities);
  let matchedBy: CadCompareSummary["matchedBy"] = "geometry";
  let pairs = byFingerprint.pairs;
  let restA = byFingerprint.restA;
  let restB = byFingerprint.restB;
  if (handled) {
    const mapA = new Map<string, CadEntity>();
    for (const e of a.entities) if (e.h !== null && !mapA.has(e.h)) mapA.set(e.h, e);
    const hp: [CadEntity, CadEntity][] = [];
    const used = new Set<CadEntity>();
    const extraB: CadEntity[] = [];
    for (const e of b.entities) {
      const old = e.h === null ? undefined : mapA.get(e.h);
      if (old && old.t === e.t && !used.has(old)) {
        hp.push([old, e]);
        used.add(old);
      } else extraB.push(e);
    }
    const extraA = a.entities.filter((e) => !used.has(e));
    const sameByHandle = hp.filter(([x, y]) => fullKey(x) === fullKey(y)).length;
    const sameByFingerprint = byFingerprint.pairs.filter(([x, y]) => fullKey(x) === fullKey(y)).length;
    if (hp.length >= Math.min(a.entities.length, b.entities.length) * 0.3 && sameByHandle >= sameByFingerprint * 0.9) {
      matchedBy = "handle";
      // Entities without a handle (or with a new one) are paired by fingerprint among themselves.
      const rest = matchByFingerprint(extraA, extraB);
      pairs = [...hp, ...rest.pairs];
      restA = rest.restA;
      restB = rest.restB;
    }
  }

  const rows: VersionDiffRow[] = [];
  const byAspect: Record<CadChangeAspect, number> = { layer: 0, geometry: 0, text: 0, style: 0 };
  const layers = new Map<string, CadLayerSummary>();
  const layer = (name: string): CadLayerSummary => {
    let s = layers.get(name);
    if (!s) layers.set(name, (s = { layer: name, status: "same", entitiesA: 0, entitiesB: 0, added: 0, removed: 0, changed: 0, types: {}, props: [] }));
    return s;
  };
  for (const e of a.entities) {
    const s = layer(e.l);
    s.entitiesA++;
    (s.types[e.t] ??= [0, 0])[0]++;
  }
  for (const e of b.entities) {
    const s = layer(e.l);
    s.entitiesB++;
    (s.types[e.t] ??= [0, 0])[1]++;
  }
  for (const name of [...a.layers.keys(), ...b.layers.keys()]) layer(name);

  let seq = 0;
  const idOf = (e: CadEntity) => e.h ?? `#${++seq}`;
  const row = (kind: VersionDiffRow["kind"], e: CadEntity, extra: Pick<VersionDiffRow, "aspects" | "changes"> = { aspects: [], changes: [] }) => ({
    id: idOf(e),
    kind,
    group: e.l,
    subgroup: e.t,
    name: e.text ?? e.block,
    ...extra,
  });
  let unchanged = 0;
  let changed = 0;
  for (const [x, y] of pairs) {
    if (fullKey(x) === fullKey(y)) {
      unchanged++;
      continue;
    }
    changed++;
    const c = changesOf(x, y);
    for (const asp of c.aspects) byAspect[asp]++;
    layer(y.l).changed++;
    rows.push(row("changed", y, c));
  }
  for (const e of restB) {
    layer(e.l).added++;
    rows.push(row("added", e));
  }
  for (const e of restA) {
    layer(e.l).removed++;
    rows.push(row("removed", e));
  }

  for (const s of layers.values()) {
    const ta = a.layers.get(s.layer);
    const tb = b.layers.get(s.layer);
    s.props = layerProps(ta, tb);
    const inA = !!ta || s.entitiesA > 0;
    const inB = !!tb || s.entitiesB > 0;
    if (!inA && inB) s.status = "added";
    else if (inA && !inB) s.status = "removed";
    else if (s.props.length || s.added || s.removed || s.changed) s.status = "changed";
  }
  const weight = (s: CadLayerSummary) => s.added + s.removed + s.changed + s.props.length + (s.status === "same" ? 0 : 1);
  const layerList = [...layers.values()].sort((x, y) => weight(y) - weight(x) || x.layer.localeCompare(y.layer, "tr"));

  rows.sort((x, y) => x.group.localeCompare(y.group, "tr") || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.subgroup ?? "").localeCompare(y.subgroup ?? "") || x.id.localeCompare(y.id));
  const summary: CadCompareSummary = {
    matchedBy,
    entitiesA: a.entities.length,
    entitiesB: b.entities.length,
    added: restB.length,
    removed: restA.length,
    changed,
    unchanged,
    byAspect,
    layers: layerList,
  };
  if (rows.length > maxRows) summary.truncated = true;
  return { summary, rows: rows.slice(0, maxRows) };
}

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------

export interface CadCompareInput {
  task: "cad-compare";
  a: { path: string; encoding?: string };
  b: { path: string; encoding?: string };
  /** The rows go here as gzip JSON. */
  outputPath: string;
}

export function readDrawing(path: string, encoding?: string): CadDrawing {
  const buf = readFileSync(path);
  if (buf.subarray(0, 22).toString("latin1").startsWith("AutoCAD Binary DXF")) throw new Error(BINARY_DXF);
  return parseDxf(new TextDecoder(encoding || dxfEncoding(buf)).decode(buf));
}

export function runCadCompareTask(input: CadCompareInput): CadCompareSummary {
  const a = readDrawing(input.a.path, input.a.encoding);
  const b = readDrawing(input.b.path, input.b.encoding);
  const { summary, rows } = diffDrawings(a, b);
  writeFileSync(input.outputPath, gzipSync(Buffer.from(JSON.stringify(rows))));
  return summary;
}

if (parentPort && workerData && (workerData as CadCompareInput).task === "cad-compare") {
  const port = parentPort;
  try {
    port.postMessage({ type: "done", result: runCadCompareTask(workerData as CadCompareInput) });
  } catch (err) {
    port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
