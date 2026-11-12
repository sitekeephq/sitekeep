/**
 * Read access to a version's element index (see jobs/ifc-worker.ts, format 2): storey, type,
 * material and flattened properties per GlobalId, plus the field resolution used by queries.
 */
import { foldPlain, ifcClassLabel, type ModelVocabDto, type OpeningSolid } from "@sitekeep/shared";
import { MODEL_INDEX_FORMAT, OPENINGS_FORMAT, type IndexFile } from "../jobs/version-index.js";

export interface OpeningView {
  guid: string;
  /** Door / window filling the opening. */
  filler: string | null;
  /** Extruded solids in metres; empty when the geometry could not be measured. */
  solids: OpeningSolid[];
}

export interface ElementView {
  guid: string;
  cls: string;
  name: string | null;
  expressId: number | null;
  storeyIdx: number;
  storey: string | null;
  type: string | null;
  material: string | null;
  placementHash: string | null;
  /** Interned [key, value, key, value …]; see ModelIndex.key / ModelIndex.val. */
  kv: number[];
  /** Keys whose value comes from the element's type; null when the index is older than this field. */
  typeKeys: number[] | null;
  /** GlobalId of the element's type object, when known. */
  typeGuid: string | null;
}

export type BuiltinField = "class" | "storey" | "type" | "name" | "material" | "globalId" | "change";

const BUILTIN_ALIASES: Record<BuiltinField, string[]> = {
  class: ["class", "sinif", "ifcclass", "ifc class", "category", "kategori", "entity"],
  storey: ["storey", "kat", "level", "seviye", "buildingstorey", "building storey", "floor"],
  type: ["type", "tip", "typename", "type name", "tip adi", "family and type"],
  name: ["name", "ad", "isim", "adi"],
  material: ["material", "malzeme"],
  globalId: ["globalid", "guid", "global id"],
  change: ["change", "degisiklik", "degisim"],
};

/** Built-in field for a (folded) field name, if it is one. */
export function builtinField(field: string): BuiltinField | null {
  const f = foldPlain(field);
  for (const [k, aliases] of Object.entries(BUILTIN_ALIASES)) if (aliases.includes(f)) return k as BuiltinField;
  return null;
}

/** "EI 60" = "ei60", "Kat-1" = "kat1". */
export function compactFold(v: string): string {
  return foldPlain(v).replace(/[\s\-_.]/g, "");
}

const instances = new WeakMap<IndexFile, ModelIndex>();

export class ModelIndex {
  readonly guids: string[];
  private readonly keyCache = new Map<string, { keys: number[]; approximate: boolean }>();
  private readonly foldedKeys: string[];
  private readonly foldedShort: string[];
  private vocabCache: Omit<ModelVocabDto, "versionId" | "fileName" | "version"> | null = null;

  /** One instance per loaded index file (derived caches live as long as the file is cached). */
  static of(file: IndexFile): ModelIndex {
    let m = instances.get(file);
    if (!m) instances.set(file, (m = new ModelIndex(file)));
    return m;
  }

  private constructor(readonly file: IndexFile) {
    this.guids = Object.keys(file.elements);
    this.foldedKeys = (file.keys ?? []).map(foldPlain);
    this.foldedShort = (file.keys ?? []).map((k) => foldPlain(k.slice(k.lastIndexOf(".") + 1)));
  }

  /** Storeys, types and properties are present (index format 2). */
  get detailed(): boolean {
    return this.file.v >= MODEL_INDEX_FORMAT && !!this.file.details;
  }

  /** Openings are read from the geometry (newer indexes; see OPENINGS_FORMAT). */
  get hasOpenings(): boolean {
    return (this.file.openingsV ?? 0) >= OPENINGS_FORMAT && !!this.file.openings;
  }

  /** Metres, m² and m³ per model unit; null when the index predates the field. */
  get units(): { length: number; area: number; volume: number } | null {
    return this.file.units ?? null;
  }

  /** Openings voiding an element (empty when it has none or the index lacks them). */
  openings(guid: string): OpeningView[] {
    const list = this.file.openings?.[guid];
    return list ? list.map(([g, filler, solids]) => ({ guid: g, filler, solids })) : [];
  }

  get size(): number {
    return this.guids.length;
  }

  has(guid: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.file.elements, guid);
  }

  storeyNames(): string[] {
    return (this.file.storeys ?? []).map((s) => s.name);
  }

  key(i: number): string {
    return this.file.keys?.[i] ?? "";
  }

  val(i: number): string | number | boolean | null {
    return i >= 0 ? (this.file.vals?.[i] ?? null) : null;
  }

  element(guid: string): ElementView | null {
    const e = this.file.elements[guid];
    if (!e) return null;
    const d = this.file.details?.[guid];
    const storeyIdx = d ? d[1] : -1;
    const tv = d ? this.val(d[2]) : null;
    const mv = d ? this.val(d[3]) : null;
    return {
      guid,
      cls: e[0],
      name: e[1],
      expressId: d ? d[0] : null,
      storeyIdx,
      storey: storeyIdx >= 0 ? (this.file.storeys?.[storeyIdx]?.name ?? null) : null,
      type: tv === null ? null : String(tv),
      material: mv === null ? null : String(mv),
      placementHash: d ? d[4] : null,
      kv: d ? d[5] : [],
      typeKeys: d && Array.isArray(d[6]) ? d[6] : null,
      typeGuid: d && typeof d[7] === "number" && d[7] >= 0 ? String(this.val(d[7])) : null,
    };
  }

  /** All property values of an element as "Pset.Name" → value. */
  props(el: ElementView): Map<string, string | number | boolean> {
    const out = new Map<string, string | number | boolean>();
    for (let i = 0; i + 1 < el.kv.length; i += 2) {
      const v = this.val(el.kv[i + 1]!);
      if (v !== null) out.set(this.key(el.kv[i]!), v);
    }
    return out;
  }

  /** Values of the given keys on an element (several when the name occurs in more than one set). */
  values(el: ElementView, keys: number[]): (string | number | boolean)[] {
    if (!keys.length) return [];
    const out: (string | number | boolean)[] = [];
    for (let i = 0; i + 1 < el.kv.length; i += 2) {
      if (keys.includes(el.kv[i]!)) {
        const v = this.val(el.kv[i + 1]!);
        if (v !== null) out.push(v);
      }
    }
    return out;
  }

  /**
   * Property keys a field refers to: the full key ("Pset_DoorCommon.FireRating"), else every key
   * with that property name in any set, else (approximate) keys whose name contains the field.
   */
  resolveKeys(field: string): { keys: number[]; approximate: boolean } {
    const f = foldPlain(field);
    const hit = this.keyCache.get(f);
    if (hit) return hit;
    let keys: number[] = [];
    let approximate = false;
    this.foldedKeys.forEach((k, i) => k === f && keys.push(i));
    if (!keys.length) {
      const short = f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : f;
      const set = f.includes(".") ? f.slice(0, f.lastIndexOf(".")) : null;
      this.foldedShort.forEach((k, i) => {
        if (k === short && (!set || this.foldedKeys[i]!.includes(set))) keys.push(i);
      });
      if (!keys.length && short.length >= 3) {
        const c = compactFold(short);
        this.foldedShort.forEach((k, i) => compactFold(k).includes(c) && keys.push(i));
        approximate = keys.length > 0;
        if (keys.length > 12) keys = [];
      }
    }
    const res = { keys, approximate };
    this.keyCache.set(f, res);
    return res;
  }

  /** Classes, storeys, types and properties with counts and sample values (filter builder, AI prompt). */
  vocab(): Omit<ModelVocabDto, "versionId" | "fileName" | "version"> {
    if (this.vocabCache) return this.vocabCache;
    const classes = new Map<string, number>();
    const storeys = new Map<number, number>();
    const types = new Map<string, number>();
    const keyCount = new Map<number, number>();
    const keyNumeric = new Map<number, boolean>();
    const keyValues = new Map<number, Map<string, number>>();
    for (const guid of this.guids) {
      const el = this.element(guid)!;
      classes.set(el.cls, (classes.get(el.cls) ?? 0) + 1);
      storeys.set(el.storeyIdx, (storeys.get(el.storeyIdx) ?? 0) + 1);
      if (el.type) types.set(el.type, (types.get(el.type) ?? 0) + 1);
      for (let i = 0; i + 1 < el.kv.length; i += 2) {
        const k = el.kv[i]!;
        const v = this.val(el.kv[i + 1]!);
        keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
        if (typeof v !== "number") keyNumeric.set(k, false);
        else if (!keyNumeric.has(k)) keyNumeric.set(k, true);
        if (typeof v !== "number") {
          let m = keyValues.get(k);
          if (!m) keyValues.set(k, (m = new Map()));
          if (m.size < 200 || m.has(String(v))) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
        }
      }
    }
    const file = this.file;
    this.vocabCache = {
      elementCount: this.guids.length,
      classes: [...classes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, label: ifcClassLabel(name), count })),
      storeys: [
        ...(file.storeys ?? []).map((s, i) => ({ name: s.name, elevation: s.elevation, count: storeys.get(i) ?? 0 })),
      ],
      types: [...types.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([name, count]) => ({ name, count })),
      properties: [...keyCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, count]) => {
          const key = this.key(k);
          const samples = [...(keyValues.get(k)?.entries() ?? [])]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([v]) => v);
          return { key, name: key.slice(key.lastIndexOf(".") + 1), count, numeric: keyNumeric.get(k) === true, samples };
        }),
    };
    return this.vocabCache;
  }
}
