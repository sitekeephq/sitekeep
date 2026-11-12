/**
 * Worker thread: reads the spatial structure of an IFC file (IfcProject → IfcSite → IfcBuilding →
 * IfcBuildingStorey → IfcSpace, and the IFC 4.3 facilities: IfcRailway / IfcRoad / IfcBridge /
 * IfcFacilityPart …) through IfcRelAggregates.
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { closeSync, openSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import * as WebIFC from "web-ifc";

interface Input {
  inputPath: string;
  wasmDir: string;
}

export interface SpatialNode {
  globalId: string;
  ifcClass: string;
  name: string | null;
  longName: string | null;
  parentGlobalId: string | null;
  elevation: number | null;
  depth: number;
}

const SPATIAL: Record<string, string> = {
  IFCSITE: "IfcSite",
  IFCBUILDING: "IfcBuilding",
  IFCBUILDINGSTOREY: "IfcBuildingStorey",
  IFCSPACE: "IfcSpace",
  IFCFACILITY: "IfcFacility",
  IFCFACILITYPART: "IfcFacilityPart",
  IFCBRIDGE: "IfcBridge",
  IFCBRIDGEPART: "IfcBridgePart",
  IFCROAD: "IfcRoad",
  IFCROADPART: "IfcRoadPart",
  IFCRAILWAY: "IfcRailway",
  IFCRAILWAYPART: "IfcRailwayPart",
  IFCMARINEFACILITY: "IfcMarineFacility",
  IFCMARINEPART: "IfcMarinePart",
  IFCTUNNEL: "IfcTunnel",
  IFCTUNNELPART: "IfcTunnelPart",
};

const { inputPath, wasmDir } = workerData as Input;

function ref(v: unknown): number | null {
  if (v && typeof v === "object" && (v as { type?: unknown }).type === 5) {
    const id = (v as { value?: unknown }).value;
    return typeof id === "number" ? id : null;
  }
  return typeof v === "number" ? v : null;
}

function str(v: unknown): string | null {
  const x = v && typeof v === "object" ? (v as { value?: unknown }).value : v;
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function num(v: unknown): number | null {
  const x = v && typeof v === "object" ? (v as { value?: unknown }).value : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

async function run(): Promise<SpatialNode[]> {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init();
  const fd = openSync(inputPath, "r");
  try {
    const chunk = 4 * 1024 * 1024;
    const buffer = new Uint8Array(chunk);
    const modelId = api.OpenModelFromCallback((offset: number, size: number) => {
      const buf = size <= chunk ? buffer : new Uint8Array(size);
      const n = readSync(fd, buf, 0, Math.min(size, buf.length), offset);
      return buf.subarray(0, n);
    });
    const children = new Map<number, number[]>();
    const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELAGGREGATES);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelId, rels.get(i));
      const parent = ref(rel?.RelatingObject);
      if (parent === null) continue;
      const list = children.get(parent) ?? [];
      for (const o of Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [rel.RelatedObjects]) {
        const c = ref(o);
        if (c !== null) list.push(c);
      }
      children.set(parent, list);
    }
    const nodes: SpatialNode[] = [];
    const seen = new Set<number>();
    const walk = (id: number, parentGlobalId: string | null, depth: number) => {
      for (const c of children.get(id) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const cls = SPATIAL[api.GetNameFromTypeCode(api.GetLineType(modelId, c)).toUpperCase()];
        if (!cls) continue;
        const line = api.GetLine(modelId, c);
        const globalId = str(line?.GlobalId);
        if (!globalId) continue;
        nodes.push({
          globalId,
          ifcClass: cls,
          name: str(line.Name),
          longName: str(line.LongName),
          parentGlobalId,
          elevation: num(line.Elevation),
          depth,
        });
        walk(c, globalId, depth + 1);
      }
    };
    const projects = api.GetLineIDsWithType(modelId, WebIFC.IFCPROJECT);
    for (let i = 0; i < projects.size(); i++) walk(projects.get(i), null, 0);
    api.CloseModel(modelId);
    return nodes;
  } finally {
    closeSync(fd);
  }
}

try {
  parentPort?.postMessage({ type: "done", nodes: await run() });
} catch (err) {
  parentPort?.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
