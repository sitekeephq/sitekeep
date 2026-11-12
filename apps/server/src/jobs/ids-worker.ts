/**
 * Worker thread: checks one IFC file against parsed IDS specifications (the subset read by
 * coordination/ids.ts: entity, attribute and property facets) with web-ifc.
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

type Restriction =
  | { simple: string }
  | {
      enumeration?: string[];
      pattern?: string;
      minInclusive?: number;
      maxInclusive?: number;
      minExclusive?: number;
      maxExclusive?: number;
      length?: number;
      minLength?: number;
      maxLength?: number;
    };
type Cardinality = "required" | "optional" | "prohibited";
type Facet =
  | { kind: "entity"; name: Restriction; predefinedType?: Restriction }
  | { kind: "attribute"; name: Restriction; value?: Restriction; cardinality: Cardinality }
  | { kind: "property"; pset: Restriction; name: Restriction; value?: Restriction; dataType?: string; cardinality: Cardinality };

interface Spec {
  name: string;
  description: string | null;
  ifcVersions: string[];
  minOccurs: number;
  maxOccurs: number | "unbounded";
  applicability: Facet[];
  requirements: Facet[];
  unsupported: string[];
  requirementTexts: string[];
}

interface Input {
  wasmDir: string;
  path: string;
  specs: Spec[];
  maxFailures: number;
}

const { wasmDir, path, specs, maxFailures } = workerData as Input;

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

/** Value of a web-ifc primitive as text (booleans as "true"/"false"); null for references and empty values. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  if (o.type === 5 || "expressID" in o) return null;
  if ("value" in o) {
    const x = o.value;
    if (typeof x === "boolean") return x ? "true" : "false";
    if (o.name === "IFCBOOLEAN" || o.name === "IFCLOGICAL") {
      if (x === "T") return "true";
      if (x === "F") return "false";
    }
    return x === null || x === undefined || x === "" ? null : String(x);
  }
  if ("_representationValue" in o) return String(o._representationValue);
  return null;
}

function typeName(v: unknown): string | null {
  return v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" ? (v as { name: string }).name.toUpperCase() : null;
}

/** IDS value match: numbers compare numerically (1e-6 relative), booleans case-insensitively, text exactly. */
function matches(value: string | null, r: Restriction | undefined, opts: { caseInsensitive?: boolean } = {}): boolean {
  if (!r) return value !== null;
  if (value === null) return false;
  const eq = (a: string, b: string) => {
    if (opts.caseInsensitive || a === "true" || a === "false") return a.toLowerCase() === b.toLowerCase();
    const na = Number(a);
    const nb = Number(b);
    if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb))
      return Math.abs(na - nb) <= 1e-6 * Math.max(1, Math.abs(nb));
    return a === b;
  };
  if ("simple" in r) return eq(value, r.simple);
  if (r.enumeration && !r.enumeration.some((e) => eq(value, e))) return false;
  if (r.pattern !== undefined) {
    try {
      if (!new RegExp(`^(?:${r.pattern})$`, opts.caseInsensitive ? "i" : "").test(value)) return false;
    } catch {
      return false;
    }
  }
  const n = Number(value);
  if (r.minInclusive !== undefined && !(n >= r.minInclusive)) return false;
  if (r.maxInclusive !== undefined && !(n <= r.maxInclusive)) return false;
  if (r.minExclusive !== undefined && !(n > r.minExclusive)) return false;
  if (r.maxExclusive !== undefined && !(n < r.maxExclusive)) return false;
  if (r.length !== undefined && value.length !== r.length) return false;
  if (r.minLength !== undefined && value.length < r.minLength) return false;
  if (r.maxLength !== undefined && value.length > r.maxLength) return false;
  return true;
}

function show(r: Restriction): string {
  if ("simple" in r) return r.simple;
  if (r.enumeration) return r.enumeration.join(" | ");
  if (r.pattern !== undefined) return `/${r.pattern}/`;
  return jt("ids.restriction");
}

interface Pset {
  name: string | null;
  props: Map<string, { value: string | null; type: string | null }>;
}

async function main() {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init();
  const fd = openSync(path, "r");
  let modelId = -1;
  try {
    const read = reader(fd);
    modelId = api.OpenModelFromCallback((offset: number, size: number) => read(offset, size));
    const schema = api.GetModelSchema(modelId).toUpperCase();

    // Candidate objects: everything with a GlobalId that is an element or a spatial structure.
    const classOf = new Map<number, string>();
    for (const t of api.GetAllTypesOfModel(modelId)) {
      const upper = t.typeName.toUpperCase();
      const spatial = ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE"].includes(upper);
      if (!spatial && !api.IsIfcElement(t.typeID)) continue;
      const ids = api.GetLineIDsWithType(modelId, t.typeID);
      for (let i = 0; i < ids.size(); i++) classOf.set(ids.get(i), upper);
    }
    const objects = [...classOf.keys()].sort((a, b) => a - b);

    // Property sets per object (instance first, then type), types per object.
    const psetIds = new Map<number, number[]>();
    const typeOf = new Map<number, number>();
    const rels = api.GetLineIDsWithType(modelId, WebIFC.IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(modelId, rels.get(i));
      const def = ref(rel?.RelatingPropertyDefinition);
      if (def === null) continue;
      for (const o of asArray(rel.RelatedObjects)) {
        const oid = ref(o);
        if (oid !== null) psetIds.set(oid, [...(psetIds.get(oid) ?? []), def]);
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
    const psetCache = new Map<number, Pset>();
    const pset = (id: number): Pset => {
      let p = psetCache.get(id);
      if (p) return p;
      const line = api.GetLine(modelId, id);
      const props = new Map<string, { value: string | null; type: string | null }>();
      for (const r of asArray(line?.HasProperties ?? line?.Quantities)) {
        const pid = ref(r);
        if (pid === null) continue;
        const prop = api.GetLine(modelId, pid);
        const name = text(prop?.Name);
        if (!name || props.has(name)) continue;
        const raw =
          prop.NominalValue ??
          prop.LengthValue ??
          prop.AreaValue ??
          prop.VolumeValue ??
          prop.CountValue ??
          prop.WeightValue ??
          prop.TimeValue ??
          null;
        let value = text(raw);
        if (value === null && Array.isArray(prop.EnumerationValues)) value = prop.EnumerationValues.map(text).filter(Boolean).join(",") || null;
        props.set(name, { value, type: typeName(raw) });
      }
      p = { name: text(line?.Name), props };
      psetCache.set(id, p);
      return p;
    };
    const lines = new Map<number, Record<string, unknown>>();
    const lineOf = (id: number) => {
      let l = lines.get(id);
      if (!l) lines.set(id, (l = api.GetLine(modelId, id) as Record<string, unknown>));
      return l;
    };
    const setsOf = (id: number): Pset[] => {
      const own = (psetIds.get(id) ?? []).map(pset);
      const t = typeOf.get(id);
      const typeSets =
        t === undefined
          ? []
          : asArray(lineOf(t)?.HasPropertySets)
              .map(ref)
              .filter((x): x is number => x !== null)
              .map(pset);
      return [...own, ...typeSets];
    };
    const predefinedType = (id: number): string | null => {
      const own = text(lineOf(id).PredefinedType);
      if (own === "USERDEFINED") return text(lineOf(id).ObjectType) ?? own;
      if (own && own !== "NOTDEFINED") return own;
      const t = typeOf.get(id);
      if (t === undefined) return own;
      const tp = text(lineOf(t).PredefinedType);
      if (tp === "USERDEFINED") return text(lineOf(t).ElementType) ?? tp;
      return tp ?? own;
    };

    /** null = facet satisfied, otherwise the reason it is not. */
    const check = (id: number, f: Facet): string | null => {
      const cls = classOf.get(id)!;
      if (f.kind === "entity") {
        if (!matches(cls, f.name, { caseInsensitive: true })) return jt("ids.entityExpected", { expected: show(f.name), found: cls });
        if (f.predefinedType && !matches(predefinedType(id), f.predefinedType))
          return jt("ids.predefinedTypeExpected", { expected: show(f.predefinedType), found: predefinedType(id) ?? jt("ids.empty") });
        return null;
      }
      if (f.kind === "attribute") {
        const line = lineOf(id);
        const names = Object.keys(line).filter((k) => k !== "expressID" && k !== "type" && matches(k, f.name));
        const present = names.filter((k) => text(line[k]) !== null);
        const good = present.filter((k) => !f.value || matches(text(line[k]), f.value));
        if (f.cardinality === "prohibited") {
          const bad = f.value ? good : present;
          return bad.length ? jt("ids.attributeProhibited", { name: bad[0]! }) : null;
        }
        if (!present.length) return f.cardinality === "required" ? jt("ids.attributeMissing", { name: show(f.name) }) : null;
        if (!good.length) return jt("ids.valueExpected", { name: present[0]!, value: text(line[present[0]!]) ?? "", expected: show(f.value!) });
        return null;
      }
      // property
      const found: { pset: string; name: string; value: string | null; type: string | null }[] = [];
      for (const s of setsOf(id)) {
        if (!matches(s.name, f.pset)) continue;
        for (const [name, p] of s.props) if (matches(name, f.name)) found.push({ pset: s.name ?? "", name, ...p });
      }
      const present = found.filter((p) => p.value !== null);
      const good = present.filter(
        (p) => (!f.value || matches(p.value, f.value)) && (!f.dataType || !p.type || p.type === f.dataType),
      );
      if (f.cardinality === "prohibited") {
        const bad = f.value ? good : present;
        return bad.length ? jt("ids.propertyProhibited", { name: `${bad[0]!.pset}.${bad[0]!.name}` }) : null;
      }
      if (!present.length) return f.cardinality === "required" ? jt("ids.propertyMissing", { name: `${show(f.pset)}.${show(f.name)}` }) : null;
      if (!good.length) {
        const p = present[0]!;
        if (f.dataType && p.type && p.type !== f.dataType) return jt("ids.dataTypeExpected", { name: `${p.pset}.${p.name}`, type: p.type, expected: f.dataType });
        return jt("ids.valueExpected", { name: `${p.pset}.${p.name}`, value: String(p.value), expected: show(f.value!) });
      }
      return null;
    };

    const results = specs.map((spec) => {
      const base = {
        name: spec.name,
        description: spec.description,
        ifcVersions: spec.ifcVersions,
        requirements: spec.requirementTexts,
        unsupported: spec.unsupported,
        applicable: 0,
        passed: 0,
        failed: 0,
        failures: [] as { globalId: string; ifcClass: string; name: string | null; reasons: string[] }[],
      };
      const schemaOk = !spec.ifcVersions.length || spec.ifcVersions.some((v) => schema.startsWith(v) || v.startsWith(schema));
      if (!schemaOk) return { ...base, status: "skipped" as const, note: jt("ids.schemaSkipped", { schema, versions: spec.ifcVersions.join(", ") }) };
      if (spec.unsupported.some((u) => u.startsWith("uygulanabilirlik")))
        return { ...base, status: "skipped" as const, note: jt("ids.applicabilityUnsupported") };
      const applicable = objects.filter((id) => spec.applicability.every((f) => check(id, f) === null));
      base.applicable = applicable.length;
      const prohibited = spec.maxOccurs === 0;
      let truncated = false;
      for (const id of applicable) {
        const reasons = prohibited ? [jt("ids.prohibited")] : spec.requirements.map((f) => check(id, f)).filter((r): r is string => r !== null);
        if (!reasons.length) {
          base.passed++;
          continue;
        }
        base.failed++;
        if (base.failures.length >= maxFailures) {
          truncated = true;
          continue;
        }
        const line = lineOf(id);
        base.failures.push({ globalId: text(line.GlobalId) ?? `#${id}`, ifcClass: classOf.get(id)!, name: text(line.Name), reasons });
      }
      let note: string | undefined;
      let status: "pass" | "fail" = base.failed ? "fail" : "pass";
      if (spec.minOccurs > 0 && applicable.length === 0) {
        status = "fail";
        note = jt("ids.noApplicable");
      }
      if (spec.unsupported.length) note = [note, jt("ids.unsupportedFacets", { facets: spec.unsupported.join(", ") })].filter(Boolean).join(" ");
      return { ...base, status, note, truncated: truncated || undefined };
    });
    parentPort?.postMessage({ type: "done", schema, elementsChecked: objects.length, results });
  } finally {
    if (modelId >= 0) api.CloseModel(modelId);
    closeSync(fd);
  }
}

try {
  await main();
} catch (err) {
  parentPort?.postMessage({ type: "error", message: jt("ids.failed", { reason: err instanceof Error ? err.message : String(err) }) });
}
