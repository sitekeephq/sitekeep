/**
 * cde_* read tools for IFC model questions ("Modele sor") and version comparison summaries.
 * The query is structured JSON (no code); the CDE server validates and runs it over the version's
 * element index with the caller's permissions.
 */
import { z } from "zod";
import type { CdeCall } from "../core/types.js";
import type { ToolAdder } from "../core/define.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OPS = ["=", "!=", "contains", ">", "<", ">=", "<=", "exists", "missing"] as const;

const QUANTITY_FIELDS = ["netVolume", "grossVolume", "grossArea", "openingArea", "netArea", "length", "weight"] as const;
const QUANTITY_UNITS = { netVolume: "m³", grossVolume: "m³", grossArea: "m²", openingArea: "m²", netArea: "m²", length: "m", weight: "kg" };

export const modelQueryShape = z
  .object({
    classes: z.array(z.string()).optional().describe('IFC classes, e.g. ["IfcDoor"]; IfcWall also matches IfcWallStandardCase.'),
    storeys: z.array(z.string()).optional().describe("Storey names exactly as in the vocabulary."),
    filters: z
      .array(
        z.object({
          field: z.string().describe("class, storey, type, name, material or a property (FireRating, Pset_DoorCommon.FireRating, NetArea …)."),
          op: z.enum(OPS),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
      )
      .optional()
      .describe("All must hold. '!=' also matches elements without the property."),
    groupBy: z.array(z.string()).max(2).optional().describe('e.g. ["storey"] or ["type"].'),
    aggregate: z
      .object({ op: z.enum(["count", "sum", "avg", "min", "max"]), field: z.string().optional() })
      .optional()
      .describe("sum/avg/min/max of a numeric property, e.g. {op:'sum', field:'NetArea'}."),
    change: z.array(z.enum(["added", "changed", "removed"])).optional().describe("Only with compareFromVersionId."),
  })
  .describe("Structured model query.");

/** Newest IFC version whose file name contains `model` (or the only / first model). */
async function pickVersion(call: CdeCall, projectId: string, model: string | undefined): Promise<Any> {
  const list = await call<Any[]>("GET", `/projects/${projectId}/models`);
  if (!list.length) throw new Error("Bu projede görüntülenebilir IFC modeli yok.");
  if (!model) return list[0];
  const m = model.toLocaleLowerCase("tr-TR");
  const hit = list.find((x) => String(x.fileName).toLocaleLowerCase("tr-TR").includes(m));
  if (!hit) throw new Error(`"${model}" adlı bir model yok. Modeller: ${list.map((x) => x.fileName).join(", ")}`);
  return hit;
}

function compactResult(r: Any, limit: number) {
  return {
    answer: r.answer,
    count: r.count,
    inScope: r.total,
    ...(r.aggregate && { aggregate: r.aggregate }),
    ...(r.table && { table: { columns: r.table.columns.map((c: Any) => c.label), rows: r.table.rows.slice(0, 50) } }),
    elements: r.elements.slice(0, limit).map((e: Any) => ({
      globalId: e.guid,
      class: e.class,
      name: e.name,
      storey: e.storey,
      ...(e.modelName && { model: e.modelName }),
      ...(e.type && { type: e.type }),
      ...(e.value !== undefined && e.value !== null && { value: e.value }),
      ...(e.change && { change: e.change }),
    })),
    ...(r.count > limit && { moreElements: r.count - Math.min(limit, r.elements.length) }),
    ...(r.removedGuids?.length && { removedGlobalIds: r.removedGuids.slice(0, 50) }),
    ...(r.warnings?.length && { warnings: r.warnings }),
  };
}

export function registerModelTools(tool: ToolAdder, call: CdeCall): void {
  const pid = z.string().uuid().describe("Project id (from cde_projects_list).");

  tool(
    "cde_model_query",
    "Questions about an IFC model's elements (counts, lists, quantities by storey / class / property). " +
      "Call once without `query` to get the vocabulary (classes, storeys, property names with sample values), then call with a structured `query`. " +
      "Pick the model by versionId (cde_models_list) or by a part of its file name (`model`, or `'all'` / `allModels: true` to query every ready IFC model together); default: the first model. " +
      "With compareFromVersionId the query runs over the changed elements between the two versions only.",
    {
      projectId: pid,
      versionId: z.string().uuid().optional().describe("IFC version id (cde_models_list)."),
      versionIds: z.array(z.string().uuid()).max(50).optional().describe("Multiple IFC version ids to query together as a federated model."),
      allModels: z.boolean().optional().describe("Query all ready IFC models in the project together."),
      model: z.string().optional().describe("Part of the model file name, or 'all' for all models, when versionId is not known."),
      query: modelQueryShape.optional(),
      compareFromVersionId: z.string().uuid().optional().describe("Older version: restrict the query to the changes."),
      limit: z.number().int().min(1).max(200).default(30).describe("Elements listed (all are counted)."),
    },
    async (a) => {
      let versionIds = a.versionIds?.length ? a.versionIds : undefined;
      const wantAll = a.allModels || (a.model && /^(all|tumu|tümü|hepsi)$/i.test(a.model.trim()));
      let v: Any;
      if (wantAll && !versionIds) {
        const list = await call<Any[]>("GET", `/projects/${a.projectId}/models`);
        if (!list.length) throw new Error("Bu projede görüntülenebilir IFC modeli yok.");
        v = list[0];
        if (list.length > 1) versionIds = list.map((x) => x.id as string);
      } else if (versionIds) {
        v = { id: versionIds[0] };
      } else {
        v = a.versionId ? { id: a.versionId } : await pickVersion(call, a.projectId, a.model);
      }
      const qsParams = new URLSearchParams();
      if (a.compareFromVersionId) qsParams.set("compareFrom", a.compareFromVersionId);
      if (versionIds && versionIds.length > 1) qsParams.set("versions", versionIds.join(","));
      const qs = qsParams.size ? `?${qsParams}` : "";
      if (!a.query) {
        const voc = await call<Any>("GET", `/projects/${a.projectId}/versions/${v.id}/model-vocab${qs}`);
        return {
          versionId: voc.versionId,
          ...(versionIds && versionIds.length > 1 && { versionIds, modelCount: versionIds.length }),
          model: versionIds && versionIds.length > 1 ? `Tüm Modeller (${versionIds.length})` : `${voc.fileName} V${voc.version}`,
          elements: voc.elementCount,
          classes: voc.classes.slice(0, 40).map((c: Any) => `${c.name} (${c.label}) ${c.count}`),
          storeys: voc.storeys.map((s: Any) => `${s.name} (${s.count})`),
          types: voc.types.slice(0, 20).map((t: Any) => `${t.name} (${t.count})`),
          properties: voc.properties
            .slice(0, 80)
            .map((p: Any) => (p.numeric ? `${p.key} (number)` : `${p.key}: ${p.samples.slice(0, 5).join(" | ")}`)),
        };
      }
      const r = await call<Any>("POST", `/projects/${a.projectId}/versions/${v.id}/model-query`, {
        query: { ...a.query, limit: a.limit },
        ...(a.compareFromVersionId && { compareFrom: a.compareFromVersionId }),
        ...(versionIds && versionIds.length > 1 && { versionIds }),
      });
      return { versionId: r.versionId, ...(versionIds && versionIds.length > 1 && { versionIds }), ...compactResult(r, a.limit) };
    },
  );

  tool(
    "cde_quantity_inventory",
    "Metraj (quantity take-off) of an IFC model version from its base quantities (Qto_*): count, net / gross volume (m³), gross area, openings and net area (m²), " +
      "length (m) and weight (kg), grouped by class, storey, type or material. compareWithPrevious (or compareFromVersionId): the quantity difference to an older " +
      "version with the added / removed / changed elements. Openings are measured from the IFC geometry when the index has them " +
      "(openings.source \"geometry\"; differs = hosts whose own gross − net disagrees), else gross − net. " +
      "Exact numbers; use this, not cde_model_query, for 'metraj', 'kaç m³ beton', 'geçen revizyondan farkı'.",
    {
      projectId: pid,
      versionId: z.string().uuid().optional().describe("IFC version id (cde_models_list)."),
      model: z.string().optional().describe("Part of the model file name when versionId is not known."),
      groupBy: z.array(z.enum(["class", "storey", "type", "material"])).min(1).max(3).optional().describe('Default ["class","storey"].'),
      compareWithPrevious: z.boolean().optional().describe("Difference to the previous version of the same file."),
      compareFromVersionId: z.string().uuid().optional().describe("Older version for the difference."),
      limit: z.number().int().min(1).max(200).default(40).describe("Groups / elements listed."),
    },
    async (a) => {
      const v = a.versionId ? { id: a.versionId } : await pickVersion(call, a.projectId, a.model);
      const groupBy = (a.groupBy ?? ["class", "storey"]).join(",");
      let from = a.compareFromVersionId;
      if (!from && a.compareWithPrevious) {
        const all = await call<Any[]>("GET", `/projects/${a.projectId}/models?all=1`);
        const cur = all.find((x) => x.id === v.id);
        const prev = all.filter((x) => cur && x.fileId === cur.fileId && x.version < cur.version).sort((x, y) => y.version - x.version)[0];
        if (!prev) throw new Error("Bu modelin önceki bir versiyonu yok.");
        from = prev.id;
      }
      const vals = (o: Any) => {
        const out: Record<string, number> = {};
        for (const m of QUANTITY_FIELDS) if (o?.[m] !== null && o?.[m] !== undefined) out[m] = o[m];
        return out;
      };
      if (!from) {
        const r = await call<Any>("GET", `/projects/${a.projectId}/versions/${v.id}/quantities?groupBy=${groupBy}`);
        return {
          model: `${r.fileName} V${r.version}`,
          versionId: r.versionId,
          units: QUANTITY_UNITS,
          totals: { count: r.totals.count, withQuantities: r.totals.withQuantities, ...vals(r.totals) },
          groups: r.groups.slice(0, a.limit).map((g: Any) => ({ group: g.label, count: g.count, ...vals(g) })),
          ...(r.groups.length > a.limit && { moreGroups: r.groups.length - a.limit }),
          ...(r.openings && { openings: r.openings }),
        };
      }
      const d = await call<Any>("GET", `/projects/${a.projectId}/versions/${v.id}/quantities/diff?from=${from}&groupBy=${groupBy}`);
      return {
        model: `${d.to.fileName} V${d.from.version} → V${d.to.version}`,
        fromVersionId: d.from.versionId,
        toVersionId: d.to.versionId,
        units: QUANTITY_UNITS,
        totals: {
          old: { count: d.totals.old.count, ...vals(d.totals.old) },
          new: { count: d.totals.new.count, ...vals(d.totals.new) },
          delta: { count: d.totals.delta.count, ...vals(d.totals.delta) },
        },
        changedGroups: d.groups.slice(0, a.limit).map((g: Any) => ({
          group: g.label,
          added: g.added,
          removed: g.removed,
          changed: g.changed,
          delta: { count: g.delta.count, ...vals(g.delta) },
        })),
        unchangedGroups: d.unchangedGroups,
        elements: d.elements.slice(0, a.limit).map((e: Any) => ({
          globalId: e.guid,
          name: e.name,
          class: e.classLabel,
          storey: e.storey,
          change: e.change,
          delta: vals(e.delta),
        })),
        ...(d.elementCount > a.limit && { moreElements: d.elementCount - a.limit }),
      };
    },
  );

  tool(
    "cde_model_compare_summary",
    "What changed between two IFC versions: counts and change groups by storey and class, with property changes (old → new), most significant first. " +
      "Give both version ids, or a model file name to compare its newest two versions. ai: true adds the CDE's own AI narrative (slower).",
    {
      projectId: pid,
      fromVersionId: z.string().uuid().optional().describe("Older version."),
      toVersionId: z.string().uuid().optional().describe("Newer version."),
      model: z.string().optional().describe("Part of the file name: compares its newest two versions."),
      ai: z.boolean().default(false),
    },
    async (a) => {
      let from = a.fromVersionId;
      let to = a.toVersionId;
      if (!from || !to) {
        const all = await call<Any[]>("GET", `/projects/${a.projectId}/models?all=1`);
        const target = to ? all.find((x) => x.id === to) : await pickVersion(call, a.projectId, a.model);
        if (!target) throw new Error("Versiyon bulunamadı.");
        const versions = all.filter((x) => x.fileId === target.fileId).sort((x, y) => y.version - x.version);
        to ??= versions[0]?.id;
        from ??= versions.find((x) => x.version < (versions.find((y) => y.id === to)?.version ?? 0))?.id;
        if (!from || !to) throw new Error("Bu modelin karşılaştırılacak ikinci bir versiyonu yok.");
      }
      const s = await call<Any>("POST", `/projects/${a.projectId}/compare/summary`, { from, to, ai: a.ai });
      return {
        model: `${s.to.fileName} V${s.from.version} → V${s.to.version}`,
        fromVersionId: s.from.versionId,
        toVersionId: s.to.versionId,
        counts: s.counts,
        ...(s.detailed ? {} : { note: "Index without storeys/properties (being upgraded); groups are by class only." }),
        summary: (s.ai?.bullets ?? s.bullets).map((b: Any) => b.text),
        ...(s.aiError && { aiError: s.aiError }),
        groups: s.groups.slice(0, 30).map((g: Any) => ({
          text: g.text,
          kind: g.kind,
          count: g.count,
          globalIds: g.guids.slice(0, 10),
        })),
      };
    },
  );
}
