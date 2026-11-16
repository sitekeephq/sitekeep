/**
 * IFC version comparison for the comparison page (FP-1): elements matched by GlobalId in the two
 * versions' element indexes (jobs/ifc-worker.ts), each change sorted into a category (attribute,
 * property, quantity, type, placement, geometry), with counts by IFC class and storey.
 */
import type { ModelChangeCategory, ModelCompareSummary, VersionDiffChange, VersionDiffRow } from "@sitekeep/shared";
import { diffIndexes, shapesOf } from "../model/compare.js";
import {
  PROP_CLASS,
  PROP_GEOMETRY,
  PROP_MATERIAL,
  PROP_NAME,
  PROP_OTHER,
  PROP_PLACEMENT,
  PROP_STOREY,
  PROP_TYPE,
  elementChanges,
} from "../model/diff.js";
import type { ModelIndex } from "../model/model-index.js";

/** Built-in change keys of model/diff.ts → the language-free names the page and the export show. */
const BUILTIN: Record<string, { prop: string; category: ModelChangeCategory }> = {
  [PROP_CLASS]: { prop: "@class", category: "attribute" },
  [PROP_NAME]: { prop: "@name", category: "attribute" },
  [PROP_STOREY]: { prop: "@storey", category: "attribute" },
  [PROP_MATERIAL]: { prop: "@material", category: "attribute" },
  [PROP_TYPE]: { prop: "@type", category: "type" },
  [PROP_PLACEMENT]: { prop: "@placement", category: "placement" },
  [PROP_GEOMETRY]: { prop: "@geometry", category: "geometry" },
  [PROP_OTHER]: { prop: "@other", category: "attribute" },
};

/** Quantity sets: IFC base quantities ("Qto_…") and exporter "BaseQuantities" sets. */
const QUANTITY_SET = /^(qto_|basequantities)|quantities$/i;

/** Category of one property-level change. */
export function changeCategory(prop: string): ModelChangeCategory {
  const builtin = BUILTIN[prop] ?? Object.values(BUILTIN).find((b) => b.prop === prop);
  if (builtin) return builtin.category;
  const dot = prop.indexOf(".");
  const set = dot > 0 ? prop.slice(0, dot) : "";
  if (set === "Attr") return "attribute";
  if (QUANTITY_SET.test(set)) return "quantity";
  return "property";
}

/** Element differences of two versions (old → new) and their summary. */
export function diffModels(oldIdx: ModelIndex, newIdx: ModelIndex): { summary: ModelCompareSummary; rows: VersionDiffRow[] } {
  const base = diffIndexes(oldIdx.file.elements, newIdx.file.elements, shapesOf(oldIdx, newIdx));
  const detailed = oldIdx.detailed && newIdx.detailed;
  const geometry = oldIdx.hasGeometry && newIdx.hasGeometry;
  const byCategory: Record<ModelChangeCategory, number> = { attribute: 0, property: 0, quantity: 0, type: 0, placement: 0, geometry: 0 };
  const byStorey: ModelCompareSummary["byStorey"] = {};
  const bump = (storey: string | null, kind: "added" | "removed" | "changed") => {
    (byStorey[storey ?? ""] ??= { added: 0, removed: 0, changed: 0 })[kind]++;
  };
  const rows: VersionDiffRow[] = [];
  for (const guid of base.added) {
    const e = newIdx.element(guid);
    bump(e?.storey ?? null, "added");
    rows.push({ id: guid, kind: "added", group: e?.cls ?? "", subgroup: e?.storey ?? null, name: e?.name ?? null, aspects: [], changes: [] });
  }
  for (const guid of base.removed) {
    const e = oldIdx.element(guid);
    bump(e?.storey ?? null, "removed");
    rows.push({ id: guid, kind: "removed", group: e?.cls ?? "", subgroup: e?.storey ?? null, name: e?.name ?? null, aspects: [], changes: [] });
  }
  for (const guid of base.changed) {
    const a = oldIdx.element(guid);
    const b = newIdx.element(guid);
    let changes: VersionDiffChange[] = elementChanges(oldIdx, newIdx, guid).map((c) => ({ prop: BUILTIN[c.prop]?.prop ?? c.prop, from: c.from, to: c.to }));
    // A move is a change of its own, also when properties changed with it.
    if (detailed && a && b && a.placementHash !== b.placementHash && !changes.some((c) => c.prop === "@placement")) {
      changes.push({ prop: "@placement", from: null, to: null });
    }
    // "Something else changed" only stands alone.
    if (changes.length > 1) changes = changes.filter((c) => c.prop !== "@other");
    const aspects = new Set(changes.map((c) => changeCategory(c.prop)));
    for (const asp of aspects) byCategory[asp]++;
    bump(b?.storey ?? null, "changed");
    rows.push({ id: guid, kind: "changed", group: b?.cls ?? "", subgroup: b?.storey ?? null, name: b?.name ?? a?.name ?? null, aspects: [...aspects], changes });
  }
  const order = { added: 0, removed: 1, changed: 2 } as const;
  rows.sort((x, y) => x.group.localeCompare(y.group) || order[x.kind] - order[y.kind] || (x.subgroup ?? "").localeCompare(y.subgroup ?? "", "tr") || x.id.localeCompare(y.id));
  return {
    summary: {
      elementsA: oldIdx.size,
      elementsB: newIdx.size,
      added: base.added.length,
      removed: base.removed.length,
      changed: base.changed.length,
      unchanged: base.unchanged,
      detailed,
      geometry,
      byClass: base.byClass,
      byStorey,
      byCategory,
    },
    rows,
  };
}
