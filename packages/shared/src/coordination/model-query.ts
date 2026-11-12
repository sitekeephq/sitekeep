/**
 * "Modele sor": a small, safe query language over the element index of an IFC version, and the
 * richer version comparison (property-level changes, groups by storey and class).
 * The AI only ever produces a ModelQuery (validated JSON), never code; the server runs it.
 */
import { labelText, sharedText, SHARED_DEFAULT_LANGUAGE } from "../platform/i18n.js";

export const MODEL_QUERY_OPS = ["=", "!=", "contains", ">", "<", ">=", "<=", "exists", "missing"] as const;
export type ModelQueryOp = (typeof MODEL_QUERY_OPS)[number];

export const MODEL_AGG_OPS = ["count", "sum", "avg", "min", "max"] as const;
export type ModelAggOp = (typeof MODEL_AGG_OPS)[number];

export const MODEL_CHANGE_KINDS = ["added", "changed", "removed"] as const;
export type ModelChangeKind = (typeof MODEL_CHANGE_KINDS)[number];

export const MODEL_QUERY_MAX_FILTERS = 12;
export const MODEL_QUERY_MAX_ELEMENTS = 2000;

/** Built-in fields; anything else is a property ("Pset_DoorCommon.FireRating" or just "FireRating"). Labels: modelFieldLabel. */
export const MODEL_BUILTIN_FIELDS: readonly string[] = ["class", "storey", "type", "name", "material", "globalId", "change"];

export const MODEL_OP_LABELS_TR: Record<ModelQueryOp, string> = {
  "=": "=",
  "!=": "≠",
  contains: "içerir",
  ">": ">",
  "<": "<",
  ">=": "≥",
  "<=": "≤",
  exists: "var",
  missing: "yok",
};

export const MODEL_AGG_LABELS_TR: Record<ModelAggOp, string> = {
  count: "Adet",
  sum: "Toplam",
  avg: "Ortalama",
  min: "En Küçük",
  max: "En Büyük",
};

export const MODEL_CHANGE_LABELS_TR: Record<ModelChangeKind, string> = {
  added: "Eklenen",
  changed: "Değişen",
  removed: "Silinen",
};

export interface ModelQueryFilter {
  field: string;
  op: ModelQueryOp;
  value?: string | number | boolean;
}

export interface ModelQuery {
  /** IFC classes ("IfcDoor"; "IfcWall" also matches IfcWallStandardCase). Empty = all. */
  classes?: string[];
  /** Storey names as in the model. Empty = all. */
  storeys?: string[];
  filters?: ModelQueryFilter[];
  /** Up to two fields to group the result table by. */
  groupBy?: string[];
  /** count (default) or sum / avg / min / max of a numeric property (e.g. a base quantity). */
  aggregate?: { op: ModelAggOp; field?: string };
  /** Comparison scope only: which kinds of change. */
  change?: ModelChangeKind[];
  /** Elements listed in the answer (all matches are still counted and highlighted). */
  limit?: number;
}

export interface ModelQueryElement {
  guid: string;
  expressId: number | null;
  class: string;
  name: string | null;
  storey: string | null;
  type: string | null;
  /** Model version id when the query spans several federated models. */
  versionId?: string;
  /** Model file name when the query spans several federated models. */
  modelName?: string;
  /** Value of the aggregate field (or of the first filter's field). */
  value?: string | number | boolean | null;
  change?: ModelChangeKind;
}

export interface ModelQueryTable {
  columns: { key: string; label: string }[];
  rows: (string | number | null)[][];
}

export interface ModelQueryResultDto {
  versionId: string;
  compareFrom?: string;
  query: ModelQuery;
  /** Elements in scope (whole model, or the changed elements when comparing). */
  total: number;
  count: number;
  /** All matched GlobalIds in this version (capped at 20 000). */
  guids: string[];
  /** Matched GlobalIds per model version when querying several federated models. */
  byVersion?: { versionId: string; guids: string[] }[];
  /** Comparison scope: matched elements that were removed (they exist only in the old version). */
  removedGuids: string[];
  elements: ModelQueryElement[];
  /** Matched elements not in `elements`. */
  more: number;
  table: ModelQueryTable | null;
  aggregate: { op: ModelAggOp; field: string | null; value: number | null; unit: string | null } | null;
  /** One-paragraph Turkish answer, built from the numbers (no AI involved). */
  answer: string;
  warnings: string[];
}

export interface ModelAskResultDto extends ModelQueryResultDto {
  question: string;
  /** ai: the model wrote the query; rules: keyword rules (quick answer or AI unavailable). */
  source: "ai" | "rules";
  model?: string;
  aiError?: string;
  cached?: boolean;
  ms: number;
}

export interface ModelVocabDto {
  versionId: string;
  fileName: string;
  version: number;
  elementCount: number;
  classes: { name: string; label: string; count: number }[];
  storeys: { name: string; elevation: number | null; count: number }[];
  types: { name: string; count: number }[];
  properties: { key: string; name: string; count: number; numeric: boolean; samples: string[] }[];
}

// ---- Comparison ------------------------------------------------------------------------------

export interface ComparePropChange {
  prop: string;
  from: string | null;
  to: string | null;
}

export interface CompareGroupDto {
  id: string;
  kind: ModelChangeKind;
  storey: string | null;
  class: string;
  count: number;
  /** GlobalIds; removed elements exist only in the old version. */
  guids: string[];
  /** Changed groups: the property that changed (with from → to when the values agree). */
  prop?: string;
  from?: string | null;
  to?: string | null;
  /** Several different value pairs were folded into this group. */
  mixed?: boolean;
  /** Short Turkish line, e.g. "Kat 1 · Kapı: 3 elemanda FireRating EI30 → EI60". */
  text: string;
  /** Higher = more significant (used for ordering). */
  score: number;
}

export interface CompareSummaryDto {
  from: { versionId: string; fileName: string; version: number };
  to: { versionId: string; fileName: string; version: number };
  counts: { added: number; changed: number; removed: number; unchanged: number };
  /** False while one of the indexes is in the old format (no properties / storeys yet). */
  detailed: boolean;
  groups: CompareGroupDto[];
  /** Deterministic bullets (always present). */
  bullets: { text: string; groupIds: string[] }[];
  /** AI narrative, when requested and available. */
  ai: { bullets: { text: string; groupIds: string[] }[]; model: string } | null;
  source: "ai" | "deterministic";
  aiError?: string;
  cached?: boolean;
}

// ---- Labels ------------------------------------------------------------------------------------

export const IFC_CLASS_LABELS_TR: Record<string, string> = {
  IfcWall: "Duvar",
  IfcWallStandardCase: "Duvar",
  IfcWallElementedCase: "Duvar",
  IfcCurtainWall: "Giydirme Cephe",
  IfcDoor: "Kapı",
  IfcDoorStandardCase: "Kapı",
  IfcWindow: "Pencere",
  IfcWindowStandardCase: "Pencere",
  IfcSlab: "Döşeme",
  IfcSlabStandardCase: "Döşeme",
  IfcRoof: "Çatı",
  IfcColumn: "Kolon",
  IfcColumnStandardCase: "Kolon",
  IfcBeam: "Kiriş",
  IfcBeamStandardCase: "Kiriş",
  IfcMember: "Çubuk Eleman",
  IfcPlate: "Levha",
  IfcStair: "Merdiven",
  IfcStairFlight: "Merdiven Kolu",
  IfcRamp: "Rampa",
  IfcRampFlight: "Rampa Kolu",
  IfcRailing: "Korkuluk",
  IfcCovering: "Kaplama",
  IfcFooting: "Temel",
  IfcPile: "Kazık",
  IfcFurnishingElement: "Mobilya",
  IfcFurniture: "Mobilya",
  IfcBuildingElementProxy: "Genel Eleman",
  IfcPipeSegment: "Boru",
  IfcPipeFitting: "Boru Bağlantı Parçası",
  IfcDuctSegment: "Kanal",
  IfcDuctFitting: "Kanal Bağlantı Parçası",
  IfcFlowSegment: "Boru / Kanal",
  IfcFlowFitting: "Bağlantı Parçası",
  IfcFlowTerminal: "Uç Birim",
  IfcAirTerminal: "Menfez",
  IfcSanitaryTerminal: "Vitrifiye",
  IfcLightFixture: "Aydınlatma",
  IfcCableCarrierSegment: "Kablo Tavası",
  IfcValve: "Vana",
  IfcPump: "Pompa",
  IfcSpace: "Mahal",
  IfcOpeningElement: "Boşluk",
};

/** Label of an IFC class ("IfcDoor" → "Kapı" / "Door"); unknown classes lose their "Ifc" prefix. */
export function ifcClassLabel(cls: string, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  const hit = Object.keys(IFC_CLASS_LABELS_TR).find((k) => k.toLowerCase() === cls.toLowerCase());
  return hit ? labelText(lang, "ifcClass", hit) : cls.replace(/^Ifc/i, "");
}

/** Lower case without Turkish diacritics, for forgiving matches ("Döşeme" = "doseme"). */
export function foldPlain(value: string): string {
  return value
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

/** Short label of a query field for chips ("Pset_DoorCommon.FireRating" → "FireRating"). */
export function modelFieldLabel(field: string, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  if (MODEL_BUILTIN_FIELDS.includes(field)) return sharedText(lang, `modelQuery.fields.${field}`);
  const i = field.lastIndexOf(".");
  return i >= 0 ? field.slice(i + 1) : field;
}

/** One chip per query part, e.g. ["Sınıf: Kapı", "Kat: Kat 1", "FireRating ≠ EI60", "Toplam NetArea"]. */
export function modelQueryChips(q: ModelQuery, lang: string = SHARED_DEFAULT_LANGUAGE): { part: "class" | "storey" | "filter" | "groupBy" | "aggregate" | "change"; index: number; text: string }[] {
  const out: { part: "class" | "storey" | "filter" | "groupBy" | "aggregate" | "change"; index: number; text: string }[] = [];
  (q.change ?? []).forEach((c, i) => out.push({ part: "change", index: i, text: labelText(lang, "modelChange", c) }));
  (q.classes ?? []).forEach((c, i) => out.push({ part: "class", index: i, text: sharedText(lang, "modelQuery.chips.class", { value: ifcClassLabel(c, lang) }) }));
  (q.storeys ?? []).forEach((s, i) => out.push({ part: "storey", index: i, text: sharedText(lang, "modelQuery.chips.storey", { value: s }) }));
  (q.filters ?? []).forEach((f, i) => {
    const field = modelFieldLabel(f.field, lang);
    const op = labelText(lang, "modelOp", f.op);
    const text =
      f.op === "exists" || f.op === "missing"
        ? sharedText(lang, "modelQuery.chips.filterNoValue", { field, op })
        : sharedText(lang, "modelQuery.chips.filter", { field, op, value: String(f.value ?? "") });
    out.push({ part: "filter", index: i, text });
  });
  (q.groupBy ?? []).forEach((g, i) => out.push({ part: "groupBy", index: i, text: sharedText(lang, "modelQuery.chips.groupBy", { field: modelFieldLabel(g, lang) }) }));
  if (q.aggregate && q.aggregate.op !== "count")
    out.push({
      part: "aggregate",
      index: 0,
      text: sharedText(lang, "modelQuery.chips.aggregate", { op: labelText(lang, "modelAgg", q.aggregate.op), field: modelFieldLabel(q.aggregate.field ?? "", lang) }),
    });
  return out;
}
