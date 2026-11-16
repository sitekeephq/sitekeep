/**
 * Version comparison of drawings and models (FP-1): DWG / DXF per layer and IFC per GlobalId.
 * The server writes a summary into the comparison (DocCompareResult.cad / .model) and keeps the
 * full list of differences in a file; the list is read page by page with filters.
 */

export type VersionDiffKind = "added" | "removed" | "changed";

/**
 * What changed in a DWG entity: its layer, its geometry (coordinates, sizes, block), its text or its
 * display style (colour, linetype, lineweight …).
 */
export type CadChangeAspect = "layer" | "geometry" | "text" | "style";

/** What changed in an IFC element. */
export type ModelChangeCategory = "attribute" | "property" | "quantity" | "type" | "placement" | "geometry";

export const CAD_CHANGE_ASPECTS: readonly CadChangeAspect[] = ["layer", "geometry", "text", "style"];
export const MODEL_CHANGE_CATEGORIES: readonly ModelChangeCategory[] = ["attribute", "property", "quantity", "type", "placement", "geometry"];

/**
 * One changed value. Built-in fields start with "@" ("@layer", "@color", "@geometry", "@storey" …)
 * and are shown in the reader's language; other names are IFC properties ("Pset_WallCommon.FireRating").
 */
export interface VersionDiffChange {
  prop: string;
  from: string | null;
  to: string | null;
}

/** One difference: a DWG entity (by handle) or an IFC element (by GlobalId). */
export interface VersionDiffRow {
  /** DWG handle (or "#n" when matched by geometry), IFC GlobalId. */
  id: string;
  kind: VersionDiffKind;
  /** DWG layer, IFC class. */
  group: string;
  /** DWG entity type (LINE, INSERT …), IFC storey. */
  subgroup: string | null;
  /** Text or block name of a DWG entity, Name of an IFC element. */
  name: string | null;
  /** CadChangeAspect or ModelChangeCategory values (changed rows). */
  aspects: string[];
  changes: VersionDiffChange[];
}

export interface CadLayerPropChange {
  prop: "color" | "linetype" | "lineweight" | "frozen" | "off" | "locked" | "plot" | "trueColor";
  from: string | null;
  to: string | null;
}

export interface CadLayerSummary {
  layer: string;
  /** Layer exists only in the new drawing (added), only in the old one (removed), differs (changed). */
  status: VersionDiffKind | "same";
  entitiesA: number;
  entitiesB: number;
  added: number;
  removed: number;
  changed: number;
  /** Entity type → [count in the old drawing, count in the new one]. */
  types: Record<string, [number, number]>;
  /** Layer table changes (colour, linetype, frozen …). */
  props: CadLayerPropChange[];
}

export interface CadCompareSummary {
  /** Entities matched by their handle (stable handles) or by geometry (the drawing was re-created). */
  matchedBy: "handle" | "geometry";
  entitiesA: number;
  entitiesB: number;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Changed entities per aspect. */
  byAspect: Record<CadChangeAspect, number>;
  /** Layers with differences first. */
  layers: CadLayerSummary[];
  /** The list of differences holds only the first rows (huge drawings). */
  truncated?: boolean;
}

export interface ModelClassSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export interface ModelCompareSummary {
  elementsA: number;
  elementsB: number;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Property-level comparison (both indexes have storeys, types and properties). */
  detailed: boolean;
  /** Geometry (shape representation) was compared; false for indexes written before it was recorded. */
  geometry: boolean;
  /** IFC class → counts. */
  byClass: Record<string, ModelClassSummary>;
  /** Storey name ("" = no storey) → counts. */
  byStorey: Record<string, Omit<ModelClassSummary, "unchanged">>;
  /** Changed elements per category. */
  byCategory: Record<ModelChangeCategory, number>;
}

export interface VersionDiffFilter {
  kind?: VersionDiffKind;
  group?: string;
  subgroup?: string;
  aspect?: string;
  q?: string;
}

export interface VersionDiffPageDto {
  total: number;
  offset: number;
  limit: number;
  rows: VersionDiffRow[];
}

/** Rows that pass a filter (the server pages the result). */
export function filterDiffRows(rows: readonly VersionDiffRow[], f: VersionDiffFilter): VersionDiffRow[] {
  const q = f.q?.trim().toLocaleLowerCase("tr");
  return rows.filter(
    (r) =>
      (!f.kind || r.kind === f.kind) &&
      (f.group === undefined || r.group === f.group) &&
      (f.subgroup === undefined || (r.subgroup ?? "") === f.subgroup) &&
      (!f.aspect || r.aspects.includes(f.aspect)) &&
      (!q ||
        r.id.toLocaleLowerCase("tr").includes(q) ||
        (r.name ?? "").toLocaleLowerCase("tr").includes(q) ||
        r.changes.some((c) => c.prop.toLocaleLowerCase("tr").includes(q) || (c.from ?? "").toLocaleLowerCase("tr").includes(q) || (c.to ?? "").toLocaleLowerCase("tr").includes(q))),
  );
}
