/**
 * Worker thread: applies parameter changes (property set values) to an IFC file with web-ifc and
 * writes the result as a new file (docs/features/PARAMETER_CHANGE.md).
 *
 * Only property sets change: IfcPropertySingleValue / IfcPropertyEnumeratedValue values, new
 * properties, new property sets (IfcPropertySet + IfcRelDefinesByProperties, IFC2X3 and IFC4).
 * Geometry, placements, quantities and GlobalIds are never touched; express ids stay as they are.
 *
 * A property set or property entity shared by elements that do not all get the same change is
 * copied first ("copy on write"), so nothing outside the request changes. Values that live on the
 * type object are either overridden on the element (target "instance", default) or changed on the
 * type (target "type": every instance of the type changes).
 *
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
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

type Scalar = string | number | boolean;
type ValueType = "text" | "number" | "boolean" | "enum";

export interface ParamWorkerItem {
  key: string;
  globalId: string;
  pset: string;
  property: string;
  value: Scalar;
  valueType: ValueType;
  target: "instance" | "type";
}

export interface ParamWorkerOutcome {
  key: string;
  status: "ok" | "failed";
  message: string;
}

interface Input {
  wasmDir: string;
  inputPath: string;
  outputPath: string;
  items: ParamWorkerItem[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Line = any;

function fold(v: string): string {
  return v
    .normalize("NFC")
    .replace(/[İI]/g, "i")
    .toLocaleLowerCase("tr-TR")
    .replace(/i̇/g, "i")
    .replace(/ı/g, "i")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

function ref(v: unknown): number | null {
  if (v && typeof v === "object" && (v as { type?: unknown }).type === 5) {
    const id = (v as { value?: unknown }).value;
    return typeof id === "number" ? id : null;
  }
  return null;
}

const handle = (id: number) => new WebIFC.Handle(id);

function toNumber(v: Scalar): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return null;
  const t = v.trim().replace(",", ".");
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ? Number(t) : null;
}

const TRUE_WORDS = new Set(["true", "evet", "yes", "1", "t", "dogru", "var", "e"]);
const FALSE_WORDS = new Set(["false", "hayir", "no", "0", "f", "yanlis", "yok", "h"]);
function toBool(v: Scalar): boolean | null {
  if (typeof v === "boolean") return v;
  const f = fold(String(v));
  if (TRUE_WORDS.has(f)) return true;
  if (FALSE_WORDS.has(f)) return false;
  return null;
}

class Fail extends Error {}

export function applyParamChanges(api: WebIFC.IfcAPI, m: number, items: ParamWorkerItem[]): ParamWorkerOutcome[] {
  const schema = api.GetModelSchema(m);
  const outcomes = new Map<string, ParamWorkerOutcome>();
  const fail = (key: string, message: string) => outcomes.set(key, { key, status: "failed", message });
  const ok = (key: string, message: string) => outcomes.set(key, { key, status: "ok", message });

  // ---- Lines are read once and written once at the end ------------------------------------
  const lines = new Map<number, Line>();
  const dirty = new Set<number>();
  const deleted = new Set<number>();
  const line = (id: number): Line => {
    let l = lines.get(id);
    if (!l) lines.set(id, (l = api.GetLine(m, id)));
    return l;
  };
  const lineType = (id: number) => api.GetLineType(m, id);
  const created: Line[] = [];
  const create = (type: number, ...args: unknown[]): number => {
    const l = api.CreateIfcEntity(m, type, ...args) as Line;
    api.WriteLine(m, l);
    created.push(l);
    return l.expressID as number;
  };

  // ---- Model structure -------------------------------------------------------------------
  const wanted = new Set(items.map((i) => i.globalId));
  const elementOf = new Map<string, number>();
  for (const t of api.GetAllTypesOfModel(m)) {
    if (!api.IsIfcElement(t.typeID)) continue;
    const ids = api.GetLineIDsWithType(m, t.typeID);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const g = api.GetLine(m, id)?.GlobalId?.value;
      if (typeof g === "string" && wanted.has(g)) elementOf.set(g, id);
    }
  }
  const relsOfObject = new Map<number, number[]>();
  const relsOfDef = new Map<number, number[]>();
  const rels = api.GetLineIDsWithType(m, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    const rid = rels.get(i);
    const r = line(rid);
    const def = ref(r?.RelatingPropertyDefinition);
    if (def === null) continue;
    (relsOfDef.get(def) ?? relsOfDef.set(def, []).get(def)!).push(rid);
    for (const o of asArray(r.RelatedObjects)) {
      const oid = ref(o);
      if (oid !== null) (relsOfObject.get(oid) ?? relsOfObject.set(oid, []).get(oid)!).push(rid);
    }
  }
  const typeOf = new Map<number, number>();
  const instancesOfType = new Map<number, number>();
  const typeRels = api.GetLineIDsWithType(m, WebIFC.IFCRELDEFINESBYTYPE);
  for (let i = 0; i < typeRels.size(); i++) {
    const r = api.GetLine(m, typeRels.get(i));
    const t = ref(r?.RelatingType);
    if (t === null) continue;
    for (const o of asArray(r.RelatedObjects)) {
      const oid = ref(o);
      if (oid === null) continue;
      typeOf.set(oid, t);
      instancesOfType.set(t, (instancesOfType.get(t) ?? 0) + 1);
    }
  }
  // How many property sets use a property; how many types use a property set.
  const propUsage = new Map<number, number>();
  const psets = api.GetLineIDsWithType(m, WebIFC.IFCPROPERTYSET);
  for (let i = 0; i < psets.size(); i++) {
    for (const p of asArray(api.GetLine(m, psets.get(i))?.HasProperties)) {
      const pid = ref(p);
      if (pid !== null) propUsage.set(pid, (propUsage.get(pid) ?? 0) + 1);
    }
  }
  const typePsetUsage = new Map<number, number>();
  for (const t of new Set(typeOf.values())) {
    for (const s of asArray(line(t)?.HasPropertySets)) {
      const sid = ref(s);
      if (sid !== null) typePsetUsage.set(sid, (typePsetUsage.get(sid) ?? 0) + 1);
    }
  }
  let defaultOwner: number | null = null;
  if (schema === "IFC2X3") {
    const oh = api.GetLineIDsWithType(m, WebIFC.IFCOWNERHISTORY);
    if (oh.size()) defaultOwner = oh.get(0);
  }
  const ownerOf = (id: number) => {
    const o = ref(line(id)?.OwnerHistory);
    return o !== null ? handle(o) : defaultOwner !== null ? handle(defaultOwner) : null;
  };

  const nameOf = (l: Line): string => {
    const v = l?.Name?.value;
    return typeof v === "string" ? v : "";
  };
  const propsOf = (psetId: number): number[] =>
    asArray(line(psetId)?.HasProperties)
      .map(ref)
      .filter((x): x is number => x !== null);
  const findProp = (psetId: number, prop: string): number | null => propsOf(psetId).find((p) => fold(nameOf(line(p))) === fold(prop)) ?? null;
  /** The element's own sets (property or quantity sets) with the name. */
  const ownSets = (eid: number, pset: string, type: number): number[] => {
    const out: number[] = [];
    for (const rid of relsOfObject.get(eid) ?? []) {
      const def = ref(line(rid).RelatingPropertyDefinition);
      if (def !== null && lineType(def) === type && fold(nameOf(line(def))) === fold(pset) && !out.includes(def)) out.push(def);
    }
    return out;
  };
  const typeSets = (tid: number, pset: string): number[] =>
    asArray(line(tid)?.HasPropertySets)
      .map(ref)
      .filter((x): x is number => x !== null && lineType(x) === WebIFC.IFCPROPERTYSET && fold(nameOf(line(x))) === fold(pset));

  // ---- Values ----------------------------------------------------------------------------
  const typeCode = (name: string): number => (WebIFC as unknown as Record<string, number>)[name.toUpperCase()] ?? WebIFC.IFCLABEL;
  /** A typed value like `like` (an existing IFC value) or, without one, for the value type. */
  const typed = (like: Line | null, v: Scalar, valueType: ValueType): Line => {
    if (like && typeof like.name === "string") {
      const name = like.name.toUpperCase();
      if (name === "IFCBOOLEAN" || name === "IFCLOGICAL") {
        const b = toBool(v);
        if (b === null) throw new Fail(jt("paramChange.notBoolean", { value: String(v) }));
        return api.CreateIfcType(m, typeCode(name), b);
      }
      if (like.type === 4 || like.type === 10 || typeof like.value === "number" || "_representationValue" in like) {
        const n = toNumber(v);
        if (n === null) throw new Fail(jt("paramChange.notNumberTyped", { value: String(v), type: name }));
        if (like.type === 10 && !Number.isInteger(n)) throw new Fail(jt("paramChange.notInteger", { value: String(v), type: name }));
        return api.CreateIfcType(m, typeCode(name), n);
      }
      const s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
      return api.CreateIfcType(m, typeCode(name), s);
    }
    if (valueType === "number") {
      const n = toNumber(v);
      if (n === null) throw new Fail(jt("paramChange.notNumber", { value: String(v) }));
      return api.CreateIfcType(m, WebIFC.IFCREAL, n);
    }
    if (valueType === "boolean") {
      const b = toBool(v);
      if (b === null) throw new Fail(jt("paramChange.notBoolean", { value: String(v) }));
      return api.CreateIfcType(m, WebIFC.IFCBOOLEAN, b);
    }
    const s = String(v);
    return api.CreateIfcType(m, s.length > 255 ? WebIFC.IFCTEXT : WebIFC.IFCLABEL, s);
  };

  /** Checks the property kind and returns how to write its value. */
  const kindOf = (propId: number): "single" | "enum" => {
    const t = lineType(propId);
    if (t === WebIFC.IFCPROPERTYSINGLEVALUE) return "single";
    if (t === WebIFC.IFCPROPERTYENUMERATEDVALUE) return "enum";
    throw new Fail(jt("paramChange.kindNotEditable", { kind: api.GetNameFromTypeCode(t) }));
  };

  /** Writes the new value into an existing property line (in place). */
  const setValue = (propId: number, v: Scalar, valueType: ValueType) => {
    const p = line(propId);
    if (kindOf(propId) === "single") p.NominalValue = typed(p.NominalValue ?? null, v, valueType);
    else p.EnumerationValues = [typed(asArray(p.EnumerationValues)[0] ?? null, v, "text")];
    dirty.add(propId);
  };

  /** A new property entity: a copy of `like` (same kind, unit, value type) or a new one. */
  const newProp = (name: string, like: number | null, v: Scalar, valueType: ValueType): number => {
    if (like !== null) {
      const src = line(like);
      if (kindOf(like) === "single")
        return create(WebIFC.IFCPROPERTYSINGLEVALUE, src.Name, src.Description ?? null, typed(src.NominalValue ?? null, v, valueType), src.Unit ?? null);
      return create(WebIFC.IFCPROPERTYENUMERATEDVALUE, src.Name, src.Description ?? null, [typed(asArray(src.EnumerationValues)[0] ?? null, v, "text")], src.EnumerationReference ?? null);
    }
    const id = api.CreateIfcType(m, WebIFC.IFCIDENTIFIER, name);
    if (valueType === "enum") return create(WebIFC.IFCPROPERTYENUMERATEDVALUE, id, null, [typed(null, v, "text")], null);
    return create(WebIFC.IFCPROPERTYSINGLEVALUE, id, null, typed(null, v, valueType), null);
  };

  /** Converts the value once before anything is written (a bad value fails only its item). */
  const validate = (propId: number | null, item: ParamWorkerItem) => {
    if (propId === null) {
      typed(null, item.value, item.valueType === "enum" ? "text" : item.valueType);
      return;
    }
    const p = line(propId);
    if (kindOf(propId) === "single") typed(p.NominalValue ?? null, item.value, item.valueType);
    else typed(asArray(p.EnumerationValues)[0] ?? null, item.value, "text");
  };

  // ---- Plan: what changes where ----------------------------------------------------------
  interface Change {
    item: ParamWorkerItem;
    /** Property in the set being edited (null: add). */
    existing: number | null;
    /** Property to copy the kind / value type from (a type-level value overridden on the element). */
    template: number | null;
    note: string;
  }
  /** Element-level edits: existing set id (or "new:<element>:<set>") → element → changes. */
  const instanceEdits = new Map<string, { psetId: number | null; psetName: string; elements: Map<number, Change[]> }>();
  /** Type-level edits: "<type>|<set id or new:name>" → changes by property. */
  const typeEdits = new Map<string, { typeId: number; psetId: number | null; psetName: string; changes: Map<string, Change[]> }>();
  const seen = new Set<string>();

  const addInstance = (eid: number, psetId: number | null, psetName: string, c: Change) => {
    const k = psetId !== null ? String(psetId) : `new:${eid}:${fold(psetName)}`;
    let e = instanceEdits.get(k);
    if (!e) instanceEdits.set(k, (e = { psetId, psetName, elements: new Map() }));
    (e.elements.get(eid) ?? e.elements.set(eid, []).get(eid)!).push(c);
  };

  for (const item of items) {
    try {
      const eid = elementOf.get(item.globalId);
      if (eid === undefined) throw new Fail(jt("paramChange.elementNotFound"));
      const dup = `${item.globalId}|${fold(item.pset)}|${fold(item.property)}`;
      if (seen.has(dup)) throw new Fail(jt("paramChange.duplicate"));
      seen.add(dup);
      for (const q of ownSets(eid, item.pset, WebIFC.IFCELEMENTQUANTITY)) {
        if (asArray(line(q).Quantities).some((x) => fold(nameOf(line(ref(x)!))) === fold(item.property)))
          throw new Fail(jt("paramChange.quantity"));
      }
      const own = ownSets(eid, item.pset, WebIFC.IFCPROPERTYSET);
      const ownHit = own.map((s) => ({ s, p: findProp(s, item.property) })).find((x) => x.p !== null);
      if (ownHit) {
        validate(ownHit.p, item);
        addInstance(eid, ownHit.s, item.pset, { item, existing: ownHit.p, template: null, note: jt("paramChange.valueUpdated") });
        continue;
      }
      const tid = typeOf.get(eid) ?? null;
      const tSets = tid !== null ? typeSets(tid, item.pset) : [];
      const tHit = tSets.map((s) => ({ s, p: findProp(s, item.property) })).find((x) => x.p !== null);
      if (tHit && item.target === "instance") {
        validate(tHit.p, item);
        addInstance(eid, own[0] ?? null, item.pset, {
          item,
          existing: null,
          template: tHit.p,
          note: own.length ? jt("paramChange.typeOverridden") : jt("paramChange.typeOverriddenNewSet"),
        });
        continue;
      }
      if (tid !== null && (tHit || item.target === "type")) {
        validate(tHit?.p ?? null, item);
        const psetId = tHit?.s ?? tSets[0] ?? null;
        const k = `${tid}|${psetId ?? `new:${fold(item.pset)}`}`;
        let e = typeEdits.get(k);
        if (!e) typeEdits.set(k, (e = { typeId: tid, psetId, psetName: item.pset, changes: new Map() }));
        const n = instancesOfType.get(tid) ?? 0;
        const c: Change = {
          item,
          existing: tHit?.p ?? null,
          template: null,
          note: jt(tHit ? "paramChange.typeChanged" : psetId !== null ? "paramChange.typePropertyAdded" : "paramChange.typeSetAdded", { count: n }),
        };
        (e.changes.get(fold(item.property)) ?? e.changes.set(fold(item.property), []).get(fold(item.property))!).push(c);
        continue;
      }
      validate(null, item);
      addInstance(eid, own[0] ?? null, item.pset, {
        item,
        existing: null,
        template: null,
        note: own.length ? jt("paramChange.propertyAdded") : jt("paramChange.setAndPropertyAdded"),
      });
    } catch (e) {
      if (e instanceof Fail) fail(item.key, e.message);
      else throw e;
    }
  }

  // ---- Execute: element level ------------------------------------------------------------
  const sig = (cs: Change[]) =>
    JSON.stringify(
      cs.map((c) => [fold(c.item.property), typeof c.item.value, c.item.value, c.item.valueType]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  const runChanges = (keys: string[], fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      for (const k of keys) fail(k, e.message);
      return false;
    }
    return true;
  };

  for (const edit of instanceEdits.values()) {
    if (edit.psetId === null) {
      // New property set for one element.
      const [[eid, changes]] = [...edit.elements.entries()] as [[number, Change[]]];
      runChanges(
        changes.map((c) => c.item.key),
        () => {
          const props = changes.map((c) => handle(newProp(c.item.property, c.template, c.item.value, c.item.valueType)));
          const owner = ownerOf(eid);
          const ps = create(WebIFC.IFCPROPERTYSET, api.CreateIFCGloballyUniqueId(m), owner, api.CreateIfcType(m, WebIFC.IFCLABEL, edit.psetName), null, props);
          create(WebIFC.IFCRELDEFINESBYPROPERTIES, api.CreateIFCGloballyUniqueId(m), owner, null, null, [handle(eid)], handle(ps));
          for (const c of changes) ok(c.item.key, c.note);
        },
      );
      continue;
    }
    const psetId = edit.psetId;
    const relIds = relsOfDef.get(psetId) ?? [];
    const sharers = new Set<number>();
    for (const rid of relIds) for (const o of asArray(line(rid).RelatedObjects)) ref(o) !== null && sharers.add(ref(o)!);
    const groups = new Map<string, number[]>();
    for (const [eid, cs] of edit.elements) (groups.get(sig(cs)) ?? groups.set(sig(cs), []).get(sig(cs))!).push(eid);
    const others = [...sharers].some((o) => !edit.elements.has(o)) || (typePsetUsage.get(psetId) ?? 0) > 0;
    const groupList = [...groups.values()];
    const inPlace = others ? null : groupList[0]!;
    const cloned = groupList.length > (inPlace ? 1 : 0);

    for (const g of groupList) {
      const changes = edit.elements.get(g[0]!)!;
      const keysOf = g.flatMap((eid) => edit.elements.get(eid)!.map((c) => c.item.key));
      if (g === inPlace) {
        runChanges(keysOf, () => {
          const props = propsOf(psetId);
          for (const c of changes) {
            if (c.existing !== null && !cloned && (propUsage.get(c.existing) ?? 0) <= 1) setValue(c.existing, c.item.value, c.item.valueType);
            else if (c.existing !== null) {
              const np = newProp(c.item.property, c.existing, c.item.value, c.item.valueType);
              const i = props.indexOf(c.existing);
              props[i] = np;
            } else props.push(newProp(c.item.property, c.template, c.item.value, c.item.valueType));
          }
          line(psetId).HasProperties = props.map(handle);
          dirty.add(psetId);
          for (const eid of g) for (const c of edit.elements.get(eid)!) ok(c.item.key, c.note);
        });
        continue;
      }
      // Copy the shared set for this group, then move the group to the copy.
      runChanges(keysOf, () => {
        const src = line(psetId);
        const props = propsOf(psetId);
        for (const c of changes) {
          if (c.existing !== null) props[props.indexOf(c.existing)] = newProp(c.item.property, c.existing, c.item.value, c.item.valueType);
          else props.push(newProp(c.item.property, c.template, c.item.value, c.item.valueType));
        }
        const owner = ownerOf(psetId) ?? ownerOf(g[0]!);
        const copy = create(WebIFC.IFCPROPERTYSET, api.CreateIFCGloballyUniqueId(m), owner, src.Name, src.Description ?? null, props.map(handle));
        create(WebIFC.IFCRELDEFINESBYPROPERTIES, api.CreateIFCGloballyUniqueId(m), owner, null, null, g.map(handle), handle(copy));
        const moved = new Set(g);
        for (const rid of relIds) {
          const r = line(rid);
          const rest = asArray(r.RelatedObjects).filter((o) => !moved.has(ref(o)!));
          if (rest.length === asArray(r.RelatedObjects).length) continue;
          if (rest.length) {
            r.RelatedObjects = rest;
            dirty.add(rid);
          } else deleted.add(rid);
        }
        for (const eid of g) for (const c of edit.elements.get(eid)!) ok(c.item.key, jt("paramChange.sharedSetSplit", { note: c.note }));
      });
    }
  }

  // ---- Execute: type level ---------------------------------------------------------------
  for (const edit of typeEdits.values()) {
    const all: Change[] = [...edit.changes.values()].flat();
    // One value per type property; differing values for the same type cannot both win.
    const chosen: Change[] = [];
    for (const list of edit.changes.values()) {
      const first = list[0]!;
      for (const c of list) {
        if (c.item.value !== first.item.value) fail(c.item.key, jt("paramChange.typeConflict"));
      }
      chosen.push(first);
    }
    const okKeys = all.filter((c) => !outcomes.has(c.item.key));
    runChanges(
      okKeys.map((c) => c.item.key),
      () => {
        const t = line(edit.typeId);
        if (edit.psetId === null) {
          const props = chosen.map((c) => handle(newProp(c.item.property, null, c.item.value, c.item.valueType)));
          const ps = create(WebIFC.IFCPROPERTYSET, api.CreateIFCGloballyUniqueId(m), ownerOf(edit.typeId), api.CreateIfcType(m, WebIFC.IFCLABEL, edit.psetName), null, props);
          t.HasPropertySets = [...asArray(t.HasPropertySets), handle(ps)];
          dirty.add(edit.typeId);
        } else {
          let psetId = edit.psetId;
          const shared = (typePsetUsage.get(psetId) ?? 0) > 1 || (relsOfDef.get(psetId)?.length ?? 0) > 0;
          const props = propsOf(psetId);
          for (const c of chosen) {
            if (c.existing !== null && !shared && (propUsage.get(c.existing) ?? 0) <= 1) setValue(c.existing, c.item.value, c.item.valueType);
            else if (c.existing !== null) props[props.indexOf(c.existing)] = newProp(c.item.property, c.existing, c.item.value, c.item.valueType);
            else props.push(newProp(c.item.property, null, c.item.value, c.item.valueType));
          }
          if (shared) {
            const src = line(psetId);
            const copy = create(WebIFC.IFCPROPERTYSET, api.CreateIFCGloballyUniqueId(m), ownerOf(psetId), src.Name, src.Description ?? null, props.map(handle));
            t.HasPropertySets = asArray(t.HasPropertySets).map((s) => (ref(s) === psetId ? handle(copy) : s));
            dirty.add(edit.typeId);
            psetId = copy;
          } else {
            line(psetId).HasProperties = props.map(handle);
            dirty.add(psetId);
          }
        }
        for (const c of okKeys) ok(c.item.key, c.note);
      },
    );
  }

  for (const id of dirty) if (!deleted.has(id)) api.WriteLine(m, line(id));
  for (const id of deleted) api.DeleteLine(m, id);
  return items.map((i) => outcomes.get(i.key) ?? { key: i.key, status: "failed", message: jt("paramChange.notApplied") });
}

async function main() {
  const { wasmDir, inputPath, outputPath, items } = workerData as Input;
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmDir, true);
  await api.Init();
  const m = api.OpenModel(new Uint8Array(readFileSync(inputPath)));
  if (m < 0) throw new Error(jt("paramChange.ifcOpenFailed"));
  const schema = api.GetModelSchema(m);
  const outcomes = applyParamChanges(api, m, items);
  if (outcomes.some((o) => o.status === "ok")) writeFileSync(outputPath, api.SaveModel(m));
  api.CloseModel(m);
  parentPort?.postMessage({ type: "done", schema, outcomes });
}

if (parentPort && workerData && (workerData as Input).inputPath) {
  main().catch((err) => parentPort?.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }));
}
