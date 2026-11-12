/**
 * Worker thread: converts an IFC file to That Open Fragments and extracts a summary.
 * Optionally also writes an element index (GlobalId → class, name, propsHash) used for
 * version comparison.
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { IfcImporter } from "@thatopen/fragments";
import * as WebIFC from "web-ifc";
import { consistentWinding } from "@sitekeep/shared";

interface Input {
  inputPath: string;
  /** Fragments output; omitted when only the comparison index is built. */
  outputPath?: string;
  /** Element index output (compact JSON). */
  indexPath?: string;
  wasmDir: string;
  /** web-ifc CIRCLE_SEGMENTS for the Fragments conversion (default 12 is web-ifc's own). */
  circleSegments?: number;
}

const { inputPath, outputPath, indexPath, wasmDir, circleSegments } = workerData as Input;

/** Spatial structure and openings are not counted as building elements. */
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

function reader(fd: number) {
  const chunk = 4 * 1024 * 1024;
  const buffer = new Uint8Array(chunk);
  return (offset: number, size = chunk) => {
    const buf = size <= chunk ? buffer : new Uint8Array(size);
    const n = readSync(fd, buf, 0, Math.min(size, buf.length), offset);
    return buf.subarray(0, n);
  };
}

async function summarize() {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init();
  const fd = openSync(inputPath, "r");
  try {
    const read = reader(fd);
    const modelId = api.OpenModelFromCallback((offset: number, size: number) => read(offset, size));
    const schema = api.GetModelSchema(modelId);
    const byClass: Record<string, number> = {};
    let elementCount = 0;
    for (const t of api.GetAllTypesOfModel(modelId)) {
      if (!api.IsIfcElement(t.typeID) || NOT_ELEMENTS.has(t.typeName.toUpperCase())) continue;
      const n = api.GetLineIDsWithType(modelId, t.typeID).size();
      if (!n) continue;
      byClass[t.typeName] = n;
      elementCount += n;
    }
    let projectName: string | null = null;
    // IfcProject GlobalId: BCF header files name the model by it.
    let projectGuid: string | null = null;
    const projects = api.GetLineIDsWithType(modelId, WebIFC.IFCPROJECT);
    if (projects.size() > 0) {
      const p = api.GetLine(modelId, projects.get(0));
      projectName = (p?.LongName?.value as string) || (p?.Name?.value as string) || null;
      projectGuid = (p?.GlobalId?.value as string) || null;
    }
    api.CloseModel(modelId);
    return { schema, projectName, projectGuid, elementCount, byClass };
  } finally {
    closeSync(fd);
  }
}

/**
 * Element index for version comparison and "Modele sor": every building element with a GlobalId →
 * [class, name, propsHash]. The hash covers the element's own attributes, its placement
 * chain, its type and the property / quantity sets assigned to it or its type. Express ids,
 * owner history and nested GlobalIds are left out so a re-export of an unchanged model
 * gives the same hashes. Keys are sorted, numbers rounded to 1e-6.
 *
 * Format 2 adds per element (`details`): express id, storey, type name, material, a placement hash
 * and the flattened property / quantity values ("Pset.Name" → value, type values first, then the
 * instance's). Keys and values are interned (`keys`, `vals`) to keep the file small. Two optional
 * entries follow: the keys whose value comes from the element's type (parameter changes ask
 * whether to change the type or override on the element) and the type's GlobalId.
 */
async function buildIndex(path: string) {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init();
  const fd = openSync(inputPath, "r");
  try {
    const read = reader(fd);
    const modelId = api.OpenModelFromCallback((offset: number, size: number) => read(offset, size));

    // Property definitions and types per element, from the relationship entities.
    const psetsOf = new Map<number, number[]>();
    const typeOf = new Map<number, number>();
    const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelId, rels.get(i));
      const def = ref(rel?.RelatingPropertyDefinition);
      if (def === null) continue;
      for (const o of asArray(rel.RelatedObjects)) {
        const oid = ref(o);
        if (oid === null) continue;
        const list = psetsOf.get(oid);
        if (list) list.push(def);
        else psetsOf.set(oid, [def]);
      }
    }
    const typeRels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELDEFINESBYTYPE);
    for (let i = 0; i < typeRels.size(); i++) {
      const rel = api.GetLine(modelId, typeRels.get(i));
      const t = ref(rel?.RelatingType);
      if (t === null) continue;
      for (const o of asArray(rel.RelatedObjects)) {
        const oid = ref(o);
        if (oid !== null) typeOf.set(oid, t);
      }
    }

    const definitions = new Map<number, unknown>();
    const definitionValues = new Map<number, [string, unknown][]>();
    const definition = (defId: number) => {
      if (!definitions.has(defId)) {
        const line = api.GetLine(modelId, defId, true);
        definitions.set(defId, propertyDefinition(line));
        definitionValues.set(defId, propertyValues(line));
      }
      return definitions.get(defId);
    };
    const valuesOf = (defId: number) => {
      definition(defId);
      return definitionValues.get(defId) ?? [];
    };

    // Spatial structure: storeys, containment and decomposition (parts inherit their parent's storey).
    const storeyIds = api.GetLineIDsWithType(modelId, WebIFC.IFCBUILDINGSTOREY);
    const storeyList: { id: number; name: string; elevation: number | null }[] = [];
    for (let i = 0; i < storeyIds.size(); i++) {
      const sid = storeyIds.get(i);
      const st = api.GetLine(modelId, sid);
      const nm = primitive(st?.Name) ?? primitive(st?.LongName);
      const el = primitive(st?.Elevation);
      storeyList.push({ id: sid, name: typeof nm === "string" && nm ? nm : `Kat #${sid}`, elevation: typeof el === "number" ? el : null });
    }
    storeyList.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    const storeyIndex = new Map(storeyList.map((st, i) => [st.id, i]));
    const containedIn = new Map<number, number>();
    const parentOf = new Map<number, number>();
    const linkRel = (relType: number, fromKey: string, toKey: string, map: Map<number, number>) => {
      const list = api.GetLineIDsWithType(modelId, relType);
      for (let i = 0; i < list.size(); i++) {
        const rel = api.GetLine(modelId, list.get(i));
        const target = ref(rel?.[fromKey]);
        if (target === null) continue;
        for (const o of asArray(rel[toKey])) {
          const oid = ref(o);
          if (oid !== null && !map.has(oid)) map.set(oid, target);
        }
      }
    };
    linkRel(WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE, "RelatingStructure", "RelatedElements", containedIn);
    linkRel(WebIFC.IFCRELAGGREGATES, "RelatingObject", "RelatedObjects", parentOf);
    const storeyOf = (id: number): number => {
      let cur: number | undefined = id;
      for (let depth = 0; cur !== undefined && depth < 30; depth++) {
        const idx = storeyIndex.get(cur);
        if (idx !== undefined) return idx;
        cur = containedIn.get(cur) ?? parentOf.get(cur);
      }
      return -1;
    };

    // Materials (the element's own, else its type's).
    const materialOfObject = new Map<number, number>();
    linkRel(WebIFC.IFCRELASSOCIATESMATERIAL, "RelatingMaterial", "RelatedObjects", materialOfObject);
    const materialNames = new Map<number, string | null>();
    const collectMaterialNames = (id: number, out: string[], depth: number): void => {
      if (depth > 6 || out.length > 6) return;
      const line = api.GetLine(modelId, id);
      if (!line) return;
      let nested = false;
      for (const k of ["ForLayerSet", "ForProfileSet", "Material"]) {
        const r = ref(line[k]);
        if (r !== null) {
          nested = true;
          collectMaterialNames(r, out, depth + 1);
        }
      }
      for (const k of ["MaterialLayers", "Materials", "MaterialConstituents", "MaterialProfiles"]) {
        for (const item of asArray(line[k])) {
          const r = ref(item);
          if (r !== null) {
            nested = true;
            collectMaterialNames(r, out, depth + 1);
          }
        }
      }
      if (!nested) {
        const nm = primitive(line.Name);
        if (typeof nm === "string" && nm.trim()) out.push(nm.trim());
      }
    };
    const materialName = (matId: number): string | null => {
      if (!materialNames.has(matId)) {
        const names: string[] = [];
        collectMaterialNames(matId, names, 0);
        materialNames.set(matId, names.length ? [...new Set(names)].slice(0, 3).join(" / ") : null);
      }
      return materialNames.get(matId) ?? null;
    };

    // Interned keys and values of the details table.
    const keys: string[] = [];
    const keyIds = new Map<string, number>();
    const vals: (string | number | boolean)[] = [];
    const valIds = new Map<string, number>();
    const keyId = (k: string) => {
      let i = keyIds.get(k);
      if (i === undefined) keyIds.set(k, (i = keys.push(k) - 1));
      return i;
    };
    const valId = (v: string | number | boolean) => {
      const sig = `${typeof v}:${String(v)}`;
      let i = valIds.get(sig);
      if (i === undefined) valIds.set(sig, (i = vals.push(v) - 1));
      return i;
    };
    const typeNames = new Map<number, string | null>();
    const typeName = (typeId: number) => {
      if (!typeNames.has(typeId)) {
        const nm = primitive(api.GetLine(modelId, typeId)?.Name);
        typeNames.set(typeId, typeof nm === "string" && nm ? nm : null);
      }
      return typeNames.get(typeId) ?? null;
    };
    const typeSets = new Map<number, number[]>();
    const typeSetIds = (typeId: number) => {
      if (!typeSets.has(typeId))
        typeSets.set(
          typeId,
          asArray(api.GetLine(modelId, typeId)?.HasPropertySets)
            .map(ref)
            .filter((x): x is number => x !== null),
        );
      return typeSets.get(typeId)!;
    };
    const details: Record<string, [number, number, number, number, string, number[], number[], number]> = {};
    const typeGuids = new Map<number, string | null>();
    const typeGuid = (typeId: number) => {
      if (!typeGuids.has(typeId)) {
        const g = primitive(api.GetLine(modelId, typeId)?.GlobalId);
        typeGuids.set(typeId, typeof g === "string" && g ? g : null);
      }
      return typeGuids.get(typeId) ?? null;
    };
    const types = new Map<number, unknown>();
    const typeInfo = (typeId: number) => {
      if (!types.has(typeId)) {
        const t = api.GetLine(modelId, typeId);
        const sets = asArray(t?.HasPropertySets)
          .map(ref)
          .filter((x): x is number => x !== null)
          .map(definition);
        types.set(typeId, {
          class: api.GetNameFromTypeCode(api.GetLineType(modelId, typeId)),
          attrs: scalarAttributes(t),
          sets: sortedSets(sets),
        });
      }
      return types.get(typeId);
    };

    const elements: Record<string, [string, string | null, string]> = {};
    let elementCount = 0;
    for (const t of api.GetAllTypesOfModel(modelId)) {
      if (!api.IsIfcElement(t.typeID) || NOT_ELEMENTS.has(t.typeName.toUpperCase())) continue;
      const ids = api.GetLineIDsWithType(modelId, t.typeID);
      for (let i = 0; i < ids.size(); i++) {
        const eid = ids.get(i);
        const line = api.GetLine(modelId, eid);
        const guid = primitive(line?.GlobalId);
        if (typeof guid !== "string" || !guid) continue;
        const placementId = ref(line.ObjectPlacement);
        const typeId = typeOf.get(eid);
        const content = {
          attrs: scalarAttributes(line),
          placement: placementId === null ? null : plain(api.GetLine(modelId, placementId, true)),
          type: typeId === undefined ? null : typeInfo(typeId),
          sets: sortedSets((psetsOf.get(eid) ?? []).map(definition)),
        };
        const name = primitive(line.Name);
        elements[guid] = [t.typeName, typeof name === "string" ? name : null, hash(stableStringify(content))];
        elementCount++;

        const props = new Map<string, unknown>();
        // Keys whose value comes from the type (not overridden by the element's own sets).
        const fromType = new Set<string>();
        const addSets = (ids: number[], type: boolean) => {
          for (const d of ids)
            for (const [k, v] of valuesOf(d)) {
              props.set(k, v);
              if (type) fromType.add(k);
              else fromType.delete(k);
            }
        };
        if (typeId !== undefined) addSets(typeSetIds(typeId), true);
        addSets(psetsOf.get(eid) ?? [], false);
        for (const attr of ["ObjectType", "Tag", "PredefinedType", "Description"]) {
          const v = content.attrs[attr];
          if (typeof v === "string" && v.trim() && v !== "NOTDEFINED" && v !== "USERDEFINED") props.set(`Attr.${attr}`, v.trim());
        }
        const kv: number[] = [];
        const typeKv: number[] = [];
        for (const [k, v] of props) {
          if (typeof v === "string") {
            const sv = v.trim();
            if (!sv) continue;
            kv.push(keyId(k), valId(sv.length > 200 ? `${sv.slice(0, 200)}…` : sv));
          } else if (typeof v === "number" || typeof v === "boolean") kv.push(keyId(k), valId(v));
          else continue;
          if (fromType.has(k)) typeKv.push(keyId(k));
        }
        const tGuid = typeId === undefined ? null : typeGuid(typeId);
        const tName = typeId === undefined ? null : typeName(typeId);
        const matId = materialOfObject.get(eid) ?? (typeId === undefined ? undefined : materialOfObject.get(typeId));
        const mat = matId === undefined ? null : materialName(matId);
        details[guid] = [
          eid,
          storeyOf(eid),
          tName === null ? -1 : valId(tName),
          mat === null ? -1 : valId(mat),
          hash(stableStringify(content.placement)),
          kv,
          typeKv,
          tGuid === null ? -1 : valId(tGuid),
        ];
      }
    }
    // Units and openings only feed the Metraj page; a model they cannot read still gets its core index.
    let units: ReturnType<typeof modelUnits> | undefined;
    let openings: ReturnType<typeof readOpenings> | undefined;
    try {
      units = modelUnits(api, modelId);
      openings = readOpenings(api, modelId, units.length);
    } catch (err) {
      console.warn(`ifc-worker: units/openings skipped: ${(err as Error).message}`);
    }
    api.CloseModel(modelId);
    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        elements,
        storeys: storeyList.map((st) => ({ name: st.name, elevation: st.elevation })),
        keys,
        vals,
        details,
        ...(units && { units }),
        ...(openings && { openingsV: OPENINGS_FORMAT, openings }),
      }),
    );
    return { elementCount };
  } finally {
    closeSync(fd);
  }
}

/** Same as OPENINGS_FORMAT in version-index.ts (this file has no relative imports). */
const OPENINGS_FORMAT = 1;

const SI_PREFIX: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };

/** Metres / m² / m³ per model unit, from the project's IfcUnitAssignment (SI prefixes and conversion-based units such as feet). */
function modelUnits(api: WebIFC.IfcAPI, modelId: number): { length: number; area: number; volume: number } {
  const out = { length: 1, area: 1, volume: 1 };
  const projects = api.GetLineIDsWithType(modelId, WebIFC.IFCPROJECT);
  if (!projects.size()) return out;
  const assignment = ref(api.GetLine(modelId, projects.get(0))?.UnitsInContext);
  if (assignment === null) return out;
  const power: Record<string, [keyof typeof out, number]> = { LENGTHUNIT: ["length", 1], AREAUNIT: ["area", 2], VOLUMEUNIT: ["volume", 3] };
  const factor = (id: number, depth = 0): { kind: string; f: number } | null => {
    const u = api.GetLine(modelId, id);
    if (!u || depth > 3) return null;
    const kind = String(primitive(u.UnitType) ?? "");
    const type = api.GetLineType(modelId, id);
    if (type === WebIFC.IFCSIUNIT) {
      const p = primitive(u.Prefix);
      const base = typeof p === "string" ? (SI_PREFIX[p] ?? 1) : 1;
      return { kind, f: base ** (power[kind]?.[1] ?? 1) };
    }
    if (type === WebIFC.IFCCONVERSIONBASEDUNIT) {
      const m = api.GetLine(modelId, ref(u.ConversionFactor) ?? -1);
      const value = primitive(m?.ValueComponent);
      const inner = ref(m?.UnitComponent);
      const si = inner === null ? null : factor(inner, depth + 1);
      return typeof value === "number" && si ? { kind, f: value * si.f } : null;
    }
    return null;
  };
  for (const u of asArray(api.GetLine(modelId, assignment)?.Units)) {
    const id = ref(u);
    const r = id === null ? null : factor(id);
    const slot = r ? power[r.kind] : undefined;
    if (r && slot && Number.isFinite(r.f) && r.f > 0) out[slot[0]] = r.f;
  }
  return out;
}

/**
 * Openings per host GlobalId: [opening GlobalId, filling door/window GlobalId, solids], each solid
 * [profile area m², profile width m, profile height m, extrusion height m] (an opening that is not an
 * extrusion has no solids and is reported as unmeasured).
 */
function readOpenings(api: WebIFC.IfcAPI, modelId: number, metres: number): Record<string, [string, string | null, number[][]][]> {
  const guidOf = (id: number | null): string | null => {
    if (id === null) return null;
    const g = primitive(api.GetLine(modelId, id)?.GlobalId);
    return typeof g === "string" && g ? g : null;
  };
  const filler = new Map<number, number>();
  const fills = api.GetLineIDsWithType(modelId, WebIFC.IFCRELFILLSELEMENT);
  for (let i = 0; i < fills.size(); i++) {
    const rel = api.GetLine(modelId, fills.get(i));
    const o = ref(rel?.RelatingOpeningElement);
    const f = ref(rel?.RelatedBuildingElement);
    if (o !== null && f !== null) filler.set(o, f);
  }
  const out: Record<string, [string, string | null, number[][]][]> = {};
  const voids = api.GetLineIDsWithType(modelId, WebIFC.IFCRELVOIDSELEMENT);
  for (let i = 0; i < voids.size(); i++) {
    const rel = api.GetLine(modelId, voids.get(i));
    const host = guidOf(ref(rel?.RelatingBuildingElement));
    const openingId = ref(rel?.RelatedOpeningElement);
    const opening = guidOf(openingId);
    if (!host || !opening || openingId === null) continue;
    let solids: number[][] = [];
    try {
      solids = openingSolids(api, modelId, openingId, metres);
    } catch {
      solids = [];
    }
    (out[host] ??= []).push([opening, guidOf(filler.get(openingId) ?? null), solids]);
  }
  return out;
}

function openingSolids(api: WebIFC.IfcAPI, modelId: number, openingId: number, metres: number): number[][] {
  const shape = api.GetLine(modelId, ref(api.GetLine(modelId, openingId)?.Representation) ?? -1);
  const reps = asArray(shape?.Representations)
    .map((r) => api.GetLine(modelId, ref(r) ?? -1))
    .filter((r): r is Record<string, unknown> => !!r);
  const body = reps.filter((r) => primitive(r.RepresentationIdentifier) === "Body");
  const solids: number[][] = [];
  for (const rep of body.length ? body : reps)
    for (const item of asArray(rep.Items)) collectSolids(api, modelId, ref(item), metres, solids, 0);
  return solids;
}

function collectSolids(api: WebIFC.IfcAPI, modelId: number, id: number | null, scale: number, out: number[][], depth: number): void {
  if (id === null || depth > 6 || out.length > 50) return;
  const line = api.GetLine(modelId, id);
  if (!line) return;
  const type = api.GetLineType(modelId, id);
  if (type === WebIFC.IFCEXTRUDEDAREASOLID) {
    const profile = profileSize(api, modelId, ref(line.SweptArea));
    const d = primitive(line.Depth);
    if (!profile || typeof d !== "number") return;
    const dir = asArray(api.GetLine(modelId, ref(line.ExtrudedDirection) ?? -1)?.DirectionRatios).map((v) => Number(primitive(v)));
    const len = Math.hypot(...dir);
    const height = Math.abs(d) * (dir.length === 3 && len > 0 ? Math.abs(dir[2]!) / len : 1);
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
    out.push([r6(profile.area * scale * scale), r6(profile.bx * scale), r6(profile.by * scale), r6(height * scale)]);
  } else if (type === WebIFC.IFCMAPPEDITEM) {
    const map = api.GetLine(modelId, ref(line.MappingSource) ?? -1);
    const rep = api.GetLine(modelId, ref(map?.MappedRepresentation) ?? -1);
    const s = primitive(api.GetLine(modelId, ref(line.MappingTarget) ?? -1)?.Scale);
    const k = typeof s === "number" && s > 0 ? s : 1;
    for (const item of asArray(rep?.Items)) collectSolids(api, modelId, ref(item), scale * k, out, depth + 1);
  } else if (type === WebIFC.IFCBOOLEANCLIPPINGRESULT || type === WebIFC.IFCBOOLEANRESULT) {
    collectSolids(api, modelId, ref(line.FirstOperand), scale, out, depth + 1);
  }
}

/** Area and bounding box of a profile in its own axes (model units); null for unsupported profiles. */
function profileSize(api: WebIFC.IfcAPI, modelId: number, id: number | null): { area: number; bx: number; by: number } | null {
  if (id === null) return null;
  const p = api.GetLine(modelId, id);
  if (!p) return null;
  const type = api.GetLineType(modelId, id);
  const n = (v: unknown) => {
    const x = primitive(v);
    return typeof x === "number" ? x : NaN;
  };
  if (type === WebIFC.IFCRECTANGLEPROFILEDEF || type === WebIFC.IFCROUNDEDRECTANGLEPROFILEDEF) {
    const x = n(p.XDim);
    const y = n(p.YDim);
    return x > 0 && y > 0 ? { area: x * y, bx: x, by: y } : null;
  }
  if (type === WebIFC.IFCCIRCLEPROFILEDEF) {
    const r = n(p.Radius);
    return r > 0 ? { area: Math.PI * r * r, bx: 2 * r, by: 2 * r } : null;
  }
  if (type === WebIFC.IFCELLIPSEPROFILEDEF) {
    const a = n(p.SemiAxis1);
    const b = n(p.SemiAxis2);
    return a > 0 && b > 0 ? { area: Math.PI * a * b, bx: 2 * a, by: 2 * b } : null;
  }
  if (type === WebIFC.IFCARBITRARYCLOSEDPROFILEDEF || type === WebIFC.IFCARBITRARYPROFILEDEFWITHVOIDS) {
    const outer = curvePoints(api, modelId, ref(p.OuterCurve));
    if (outer.length < 3) return null;
    let area = shoelace(outer);
    for (const inner of asArray(p.InnerCurves)) area -= shoelace(curvePoints(api, modelId, ref(inner)));
    const xs = outer.map((q) => q[0]);
    const ys = outer.map((q) => q[1]);
    const bx = Math.max(...xs) - Math.min(...xs);
    const by = Math.max(...ys) - Math.min(...ys);
    return area > 0 && bx > 0 && by > 0 ? { area, bx, by } : null;
  }
  return null;
}

/** 2D points of an IfcPolyline or IfcIndexedPolyCurve (arc segments taken as their vertices). */
function curvePoints(api: WebIFC.IfcAPI, modelId: number, id: number | null): [number, number][] {
  if (id === null) return [];
  const c = api.GetLine(modelId, id);
  const type = api.GetLineType(modelId, id);
  const xy = (coords: unknown): [number, number] | null => {
    const a = asArray(coords).map((v) => primitive(v));
    return typeof a[0] === "number" && typeof a[1] === "number" ? [a[0], a[1]] : null;
  };
  let pts: [number, number][] = [];
  if (type === WebIFC.IFCPOLYLINE) {
    pts = asArray(c?.Points)
      .map((r) => xy(api.GetLine(modelId, ref(r) ?? -1)?.Coordinates))
      .filter((q): q is [number, number] => !!q);
  } else if (type === WebIFC.IFCINDEXEDPOLYCURVE) {
    const list = api.GetLine(modelId, ref(c?.Points) ?? -1);
    pts = asArray(list?.CoordList)
      .map(xy)
      .filter((q): q is [number, number] => !!q);
  }
  if (pts.length > 1 && pts[0]![0] === pts.at(-1)![0] && pts[0]![1] === pts.at(-1)![1]) pts.pop();
  return pts;
}

function shoelace(pts: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

type Line = Record<string, unknown> | null | undefined;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

/** Express id of an unresolved reference ({type: 5, value: id}). */
function ref(v: unknown): number | null {
  if (v && typeof v === "object" && (v as { type?: unknown }).type === 5) {
    const id = (v as { value?: unknown }).value;
    return typeof id === "number" ? id : null;
  }
  return null;
}

/** Value of a web-ifc primitive wrapper ({type, value} or a number class); undefined for entities and references. */
function primitive(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return round(v);
  const o = v as Record<string, unknown>;
  if ("expressID" in o) return undefined;
  if ("_representationValue" in o) return round(o._representationValue);
  if ("value" in o && o.type !== 5) return round(o.value);
  return undefined;
}

function round(v: unknown): unknown {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}

const SKIP_KEYS = new Set(["expressID", "OwnerHistory", "GlobalId"]);

/** Own attributes of an entity that are values (references are skipped). */
function scalarAttributes(line: Line): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!line) return out;
  for (const [k, v] of Object.entries(line)) {
    if (SKIP_KEYS.has(k) || k === "type") continue;
    if (Array.isArray(v)) {
      const vals = v.map(primitive);
      if (vals.every((x) => x !== undefined)) out[k] = vals;
      continue;
    }
    const p = primitive(v);
    if (p !== undefined) out[k] = p;
  }
  return out;
}

/** A flattened (resolved) entity as plain data without ids, owner history or GlobalIds. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  const p = primitive(v);
  if (p !== undefined) return p;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SKIP_KEYS.has(k)) continue;
    out[k] = plain(val);
  }
  return out;
}

/** Property and quantity sets as {Name, props: {name: value}}: the order of properties in the file does not matter. */
function propertyDefinition(line: Line): unknown {
  if (!line) return null;
  const items = line.HasProperties ?? line.Quantities;
  if (Array.isArray(items)) {
    const props: Record<string, unknown> = {};
    for (const item of items as Record<string, unknown>[]) {
      const rest = plain(item) as Record<string, unknown>;
      const name = String(rest.Name);
      delete rest.Name;
      props[name] = rest;
    }
    return { Name: primitive(line.Name), props };
  }
  return plain(line);
}

/** Flat values of a property / quantity set (flattened line): ["Pset_X.Prop", value][]. */
function propertyValues(line: Line): [string, unknown][] {
  if (!line) return [];
  const items = line.HasProperties ?? line.Quantities;
  if (!Array.isArray(items)) return [];
  const setName = primitive(line.Name);
  const prefix = typeof setName === "string" && setName ? setName : "Pset";
  const out: [string, unknown][] = [];
  for (const item of items as Record<string, unknown>[]) {
    const name = primitive(item?.Name);
    if (typeof name !== "string" || !name) continue;
    const v = flatValue(item);
    if (v !== undefined && v !== null) out.push([`${prefix}.${name}`, v]);
  }
  return out;
}

const VALUE_KEYS = ["NominalValue", "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"];

/** Value of one property or quantity (enumerations and lists joined, bounds as "lo–hi"). */
function flatValue(item: Record<string, unknown>): unknown {
  for (const k of VALUE_KEYS) {
    if (item[k] === null || item[k] === undefined) continue;
    const v = primitive(item[k]);
    if (v !== undefined && v !== null) return v;
  }
  for (const k of ["EnumerationValues", "ListValues"]) {
    if (!Array.isArray(item[k])) continue;
    const list = (item[k] as unknown[]).map(primitive).filter((x) => x !== undefined && x !== null);
    if (list.length) return list.join(", ");
  }
  const lo = primitive(item.LowerBoundValue);
  const hi = primitive(item.UpperBoundValue);
  if ((lo !== undefined && lo !== null) || (hi !== undefined && hi !== null)) return `${lo ?? ""}–${hi ?? ""}`;
  return undefined;
}

function sortedSets(sets: unknown[]): unknown[] {
  return sets
    .map((s) => [stableStringify(s), s] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((x) => x[1]);
}

function stableStringify(v: unknown): string {
  if (v === undefined || v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("base64url").slice(0, 16);
}

/**
 * Applies consistentWinding to every geometry the importer reads, in web-ifc's own memory, so the
 * Fragments importer (geometry hashing, shells) only ever sees the repaired mesh.
 */
function repairWindingOnRead() {
  const proto = WebIFC.IfcAPI.prototype;
  const getGeometry = proto.GetGeometry;
  proto.GetGeometry = function (this: WebIFC.IfcAPI, modelID: number, geometryExpressID: number) {
    const geometry = getGeometry.call(this, modelID, geometryExpressID);
    const heap = this.wasmModule as { HEAPU32: Uint32Array; HEAPF32: Float32Array };
    const indexPtr = geometry.GetIndexData() / 4;
    const vertexPtr = geometry.GetVertexData() / 4;
    const index = heap.HEAPU32.subarray(indexPtr, indexPtr + geometry.GetIndexDataSize());
    const vertices = heap.HEAPF32.subarray(vertexPtr, vertexPtr + geometry.GetVertexDataSize());
    if (index.length && vertices.length) consistentWinding(vertices, index);
    return geometry;
  };
}

async function convert(outputPath: string) {
  repairWindingOnRead();
  const importer = new IfcImporter();
  importer.wasm = { path: wasmDir, absolute: true };
  // web-ifc draws every circle / arc with CIRCLE_SEGMENTS straight pieces (default 12): round eaves
  // then show as polygons and pre-faceted members behind them poke through (see queue.ts).
  importer.webIfcSettings = { ...importer.webIfcSettings, CIRCLE_SEGMENTS: circleSegments ?? 12 };
  const fd = openSync(inputPath, "r");
  try {
    const read = reader(fd);
    let last = -1;
    const bytes = await importer.process({
      readFromCallback: true,
      readCallback: (offset: number) => read(offset),
      raw: false,
      progressCallback: (p: number) => {
        const pct = Math.floor(p * 100);
        if (pct !== last && pct % 10 === 0) {
          last = pct;
          parentPort?.postMessage({ type: "progress", pct });
        }
      },
    });
    writeFileSync(outputPath, bytes);
  } finally {
    closeSync(fd);
  }
}

try {
  const summary = await summarize();
  let index: { elementCount: number } | { error: string } | null = null;
  if (indexPath) {
    try {
      index = await buildIndex(indexPath);
    } catch (err) {
      // The viewer derivative is still useful without the comparison index.
      index = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (outputPath) await convert(outputPath);
  parentPort?.postMessage({ type: "done", summary, index });
} catch (err) {
  parentPort?.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
