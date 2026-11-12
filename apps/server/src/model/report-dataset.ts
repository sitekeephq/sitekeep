/**
 * Report dataset `model_elements`: the elements of one IFC model that match a "Modele sor" query,
 * so a question can be saved as a personal report panel that follows the model's newest version.
 * Required filters: fileId (or versionId) and modelQuery (the query JSON); both are eq filters.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { ifcClassLabel, type ModelQuery, type ReportDraft, type ReportQueryRef, type ReportRow, type ReportQuerySpec } from "@sitekeep/shared";
import { fileVersions, files } from "../db/schema.js";
import { HttpError, badRequest } from "../core/platform/http.js";
import { reportDatasets, type ReportContext } from "../reports/datasets.js";
import { requireView } from "../modules/documents/files.js";
import type { Storage } from "../core/platform/storage.js";
import { matchCandidates, modelQuerySchema, normalizeQuery, numericValue, fieldValue, versionCandidates } from "./query.js";
import { builtinField } from "./model-index.js";
import { indexForVersionId } from "./service.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";

let storageRef: Storage | null = null;

/** The storage indexes are read from (set when the routes are registered). */
export function setModelDatasetStorage(storage: Storage): void {
  storageRef = storage;
}

const PROP_PREFIX = "p.";

function eqFilter(spec: ReportQuerySpec, field: string): string | null {
  const f = spec.filters?.find((x) => x.field === field && x.op === "eq");
  return typeof f?.value === "string" ? f.value : null;
}

/** Fields a spec refers to with the property prefix. */
function propFields(spec: ReportQuerySpec): string[] {
  const names = new Set<string>();
  const add = (f: string | undefined) => f?.startsWith(PROP_PREFIX) && names.add(f);
  for (const f of spec.filters ?? []) add(f.field);
  for (const g of spec.groupBy ?? []) add(typeof g === "string" ? g : g.field);
  for (const m of spec.metrics ?? []) add(m.field);
  for (const f of spec.fields ?? []) add(f);
  for (const s of spec.sort ?? []) add(s.field);
  return [...names];
}

async function loadModelRows(ctx: ReportContext, spec: ReportQuerySpec): Promise<ReportRow[]> {
  if (!storageRef) throw new HttpError(503, "unavailable", msg("model:errors.datasetUnavailable"));
  const fileId = eqFilter(spec, "fileId");
  const versionId = eqFilter(spec, "versionId");
  if (!fileId && !versionId) throw badRequest(msg("model:errors.datasetNeedsFile"));
  const [row] = versionId
    ? await ctx.db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.id, versionId), eq(files.projectId, ctx.access.project.id), isNull(files.deletedAt)))
    : await ctx.db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(files.id, fileId!), eq(files.projectId, ctx.access.project.id), isNull(files.deletedAt)))
        .orderBy(desc(fileVersions.version))
        .limit(1);
  if (!row) throw new HttpError(404, "not_found", msg("model:errors.modelNotFound"));
  const tree = await ctx.tree();
  if (!tree.byId.has(row.f.folderId)) throw new HttpError(404, "not_found", msg("model:errors.modelNotFound"));
  requireView(tree, ctx.access, row.f);
  const index = await indexForVersionId(ctx.db, storageRef, row.v.id);
  if (!index) throw new HttpError(409, "preparing", msg("model:errors.indexNotReady"));

  const raw = eqFilter(spec, "modelQuery");
  let query: ModelQuery = {};
  if (raw) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw badRequest(msg("model:errors.modelQueryNotJson"));
    }
    const parsed = modelQuerySchema.safeParse(json);
    if (!parsed.success) throw badRequest(msg("model:errors.modelQueryInvalid", { detail: parsed.error.issues.map((i) => i.message).join("; ") }));
    query = normalizeQuery(parsed.data);
  }
  const matched = matchCandidates(versionCandidates(index), query, {});
  const props = propFields(spec);
  const valueField = query.aggregate?.field;
  return matched.map((m) => {
    const r: ReportRow = {
      fileId: row.f.id,
      versionId: row.v.id,
      modelQuery: raw,
      fileName: row.f.name,
      version: row.v.version,
      globalId: m.el.guid,
      expressId: m.el.expressId,
      class: m.el.cls,
      classLabel: ifcClassLabel(m.el.cls, ctx.lang),
      storey: m.el.storey,
      type: m.el.type,
      name: m.el.name,
      material: m.el.material,
      value: valueField ? numericValue(valueField, m) : null,
    };
    for (const p of props) {
      const v = fieldValue(p.slice(PROP_PREFIX.length), m);
      r[p] = v === null ? null : typeof v === "boolean" ? v : String(v);
    }
    return r;
  });
}

reportDatasets.register("model_elements", {
  label: msg("model:datasets.modelElements.label"),
  module: "models",
  sources: ["files"],
  description: msg("model:datasets.modelElements.description"),
  fields: {
    fileId: { type: "string", label: msg("model:datasets.modelElements.fields.fileId") },
    versionId: { type: "string", label: msg("model:datasets.modelElements.fields.versionId") },
    modelQuery: { type: "string", label: msg("model:datasets.modelElements.fields.modelQuery") },
    fileName: { type: "string", label: msg("model:datasets.modelElements.fields.fileName") },
    version: { type: "number", label: msg("model:datasets.modelElements.fields.version") },
    globalId: { type: "string", label: msg("model:datasets.modelElements.fields.globalId") },
    expressId: { type: "number", label: msg("model:datasets.modelElements.fields.expressId") },
    class: { type: "string", label: msg("model:datasets.modelElements.fields.class") },
    classLabel: { type: "string", label: msg("model:datasets.modelElements.fields.classLabel") },
    storey: { type: "string", label: msg("model:datasets.modelElements.fields.storey") },
    type: { type: "string", label: msg("model:datasets.modelElements.fields.type") },
    name: { type: "string", label: msg("model:datasets.modelElements.fields.name") },
    material: { type: "string", label: msg("model:datasets.modelElements.fields.material") },
    value: { type: "number", label: msg("model:datasets.modelElements.fields.value"), description: msg("model:datasets.modelElements.hints.value") },
  },
  dynamicPrefix: PROP_PREFIX,
  dynamicType: "string",
  dynamicDescription: msg("model:datasets.modelElements.hints.dynamic"),
  async load() {
    return [];
  },
  loadFor: loadModelRows,
});

const reportField = (f: string): string => {
  const b = builtinField(f);
  if (b === "class") return "classLabel";
  if (b === "storey" || b === "type" || b === "name" || b === "material") return b;
  if (b === "globalId") return "globalId";
  return `${PROP_PREFIX}${f}`;
};

/** A personal report panel for a model query (live: it follows the file's newest version). */
export function modelReportDraft(o: {
  fileId: string;
  fileName: string;
  query: ModelQuery;
  question?: string | null;
  name?: string | null;
  /** Language of the panel texts (the requester's: it becomes their own dashboard). */
  lang?: string;
}): ReportDraft {
  const t = tFor(o.lang ?? DEFAULT_LANGUAGE);
  const query = normalizeQuery(o.query);
  const base = [
    { field: "fileId", op: "eq" as const, value: o.fileId },
    { field: "modelQuery", op: "eq" as const, value: JSON.stringify(query) },
  ];
  const agg = query.aggregate && query.aggregate.op !== "count" ? query.aggregate : null;
  const propCols = [...new Set((query.filters ?? []).map((f) => f.field).filter((f) => !builtinField(f)))].slice(0, 4);
  const groupBy = (query.groupBy?.length ? query.groupBy : ["storey"]).map(reportField);
  const queries: ReportQueryRef[] = [
    {
      id: "items",
      spec: {
        dataset: "model_elements",
        filters: base,
        fields: ["name", "classLabel", "storey", "type", ...propCols.map((f) => `${PROP_PREFIX}${f}`), ...(agg ? ["value"] : []), "globalId"],
        sort: [{ field: "storey" }, { field: "name" }],
        limit: 2000,
      },
    },
    {
      id: "summary",
      spec: {
        dataset: "model_elements",
        filters: base,
        groupBy,
        metrics: [{ op: "count" }, ...(agg ? [{ op: agg.op === "avg" || agg.op === "min" || agg.op === "max" ? agg.op : ("sum" as const), field: "value", as: "value" }] : [])],
        sort: [{ field: "count", dir: "desc" }],
        limit: 100,
      },
    },
  ];
  const title = (o.name?.trim() || o.question?.trim() || t("model:draft.defaultTitle")).slice(0, 200);
  const unit = agg?.field ?? "";
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const js = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  const html = `<h1>${esc(title)}</h1>
<p class="muted small">${esc(o.fileName)} · ${esc(t("model:draft.newestVersion"))}${o.question ? ` · ${esc(t("model:draft.question", { question: o.question }))}` : ""}</p>
<div class="kpis"><div id="k-count"></div>${agg ? `<div id="k-agg"></div>` : ""}</div>
<div class="card"><div id="chart"></div></div>
<div class="card"><div id="list"></div></div>
<p class="muted small" id="stamp"></p>
<script>
CDE.onData(function (d) {
  var items = d.items || [];
  CDE.kpi("#k-count", { label: ${js(t("model:draft.element"))}, value: items.length });
  ${agg ? `CDE.kpi("#k-agg", { label: ${js(t("model:draft.total", { unit }))}, value: CDE.sum(items, "value") });` : ""}
  CDE.bar("#chart", d.summary || [], { title: ${js(t("model:draft.by", { fields: groupBy.map((g) => g.replace(/^p\./, "")).join(" / ") }))}, x: ${js(groupBy[0]!)}, y: ${agg ? '"value"' : '"count"'}${groupBy[1] ? `, series: ${js(groupBy[1])}` : ""} });
  CDE.table("#list", items, { title: ${js(t("model:draft.elements"))}, limit: 500, columns: [
    { field: "name", label: ${js(t("model:draft.name"))} }, { field: "classLabel", label: ${js(t("model:draft.class"))} }, { field: "storey", label: ${js(t("model:draft.storey"))} }, { field: "type", label: ${js(t("model:draft.type"))} }${propCols
      .map((f) => `, { field: ${js(`${PROP_PREFIX}${f}`)}, label: ${js(f.slice(f.lastIndexOf(".") + 1))} }`)
      .join("")}${agg ? `, { field: "value", label: ${js(unit)} }` : ""}
  ] });
  document.getElementById("stamp").textContent = CDE.project.name + " · " + CDE.fmt.datetime(CDE.generatedAt);
});
</script>`;
  return { name: title, description: t("model:draft.description", { query: o.question?.trim() || JSON.stringify(query) }).slice(0, 2000), queries, html };
}
