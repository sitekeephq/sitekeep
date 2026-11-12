/**
 * cde_* tools for parameter change requests ("Değişiklik Talebi"): read, create a draft, verify a
 * later version and apply in the CDE (new IFC version). Step 2 (Revit via AEC Pilot) uses the same
 * request: list / get the items, change them in Revit, re-export, then cde_change_request_verify.
 * Every rule (rights, approval, upload rules of the folder) stays in the CDE REST layer.
 */
import { z } from "zod";
import type { CdeCall } from "../core/types.js";
import { modelQueryShape } from "./model.js";
import type { ToolAdder } from "../core/define.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const STATUSES = ["open", "all", "draft", "pending", "approved", "applying", "applied", "rejected", "cancelled", "authoring", "values_lost"] as const;

const setRule = z.object({
  pset: z.string().optional().describe("Property set, e.g. Pset_DoorCommon. Omit to use the set the property is in."),
  property: z.string().describe("Property name as in the model vocabulary (cde_model_query without query), e.g. FireRating."),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("New value."),
  valueType: z.enum(["text", "number", "boolean", "enum"]).optional(),
});

function row(r: Any) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status,
    statusLabel: r.statusLabel,
    ownership: r.ownershipLabel,
    file: `${r.fileName} V${r.baseVersion}`,
    fileId: r.fileId,
    baseVersionId: r.baseVersionId,
    ...(r.stale && { stale: true, latestVersionId: r.latestVersionId }),
    itemCount: r.itemCount,
    counts: r.counts,
    ...(r.appliedVersionId && { appliedVersionId: r.appliedVersionId, appliedVersion: r.appliedVersion }),
    ...(r.lostVersionId && { lostVersion: r.lostVersion }),
    ...(r.error && { error: r.error }),
    link: r.link,
  };
}

function detail(r: Any, limit: number) {
  return {
    ...row(r),
    reason: r.reason,
    typeMode: r.typeMode,
    spec: r.spec,
    ...(r.workLabel && { work: r.workLabel }),
    ...(r.issueLabel && { issue: r.issueLabel }),
    createdBy: r.createdByName,
    ...(r.decidedByName && { decidedBy: r.decidedByName, decisionNote: r.decisionNote }),
    can: Object.entries(r.can)
      .filter(([, v]) => v)
      .map(([k]) => k),
    items: (r.items ?? []).slice(0, limit).map((i: Any) => ({
      globalId: i.globalId,
      element: `${i.classLabel} ${i.name ?? ""}`.trim(),
      storey: i.storey,
      property: `${i.pset}.${i.property}`,
      old: i.oldValue,
      new: i.newValue,
      source: i.source,
      ...(i.unchanged && { unchanged: true }),
      result: i.result,
      ...(i.resultMessage && { message: i.resultMessage }),
    })),
    ...(r.itemCount > limit && { moreItems: r.itemCount - limit }),
  };
}

/** Newest IFC version whose file name contains `model` (or the only / first model). */
async function pickVersion(call: CdeCall, projectId: string, model: string | undefined): Promise<Any> {
  const list = await call<Any[]>("GET", `/projects/${projectId}/models`);
  if (!list.length) throw new Error("Bu projede IFC modeli yok.");
  if (!model) return list[0];
  const m = model.toLocaleLowerCase("tr-TR");
  const hit = list.find((x) => String(x.fileName).toLocaleLowerCase("tr-TR").includes(m));
  if (!hit) throw new Error(`"${model}" adlı bir model yok. Modeller: ${list.map((x) => x.fileName).join(", ")}`);
  return hit;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerParamChangeTools(tool: ToolAdder, call: CdeCall): void {
  const pid = z.string().uuid().describe("Project id (from cde_projects_list).");
  const rid = z.string().uuid().describe("Change request id (from cde_change_requests_list).");

  tool(
    "cde_change_requests_list",
    "Parameter change requests (Değişiklik Talebi) of a project: element property changes of IFC models, with status " +
      "(draft, pending, approved, applied, authoring = 'Revit'te uygulanacak', values_lost = a later version lost the values). " +
      "Filter by IFC file or status (default: open ones).",
    { projectId: pid, fileId: z.string().uuid().optional(), status: z.enum(STATUSES).default("open") },
    async (a) => {
      const qs = new URLSearchParams({ status: a.status, ...(a.fileId && { fileId: a.fileId }) });
      const list = await call<Any[]>("GET", `/projects/${a.projectId}/param-changes?${qs}`);
      return { count: list.length, requests: list.slice(0, 100).map(row) };
    },
  );

  tool(
    "cde_change_request_get",
    "One parameter change request with its items (GlobalId, element, Pset.Property, old → new value, where the value lives, result). " +
      "For step 2 (Revit): apply these items in the authoring model, re-export the IFC as a new version, then call cde_change_request_verify.",
    { projectId: pid, requestId: rid, limit: z.number().int().min(1).max(2000).default(200).describe("Items listed.") },
    async (a) => detail(await call<Any>("GET", `/projects/${a.projectId}/param-changes/${a.requestId}`), a.limit),
  );

  tool(
    "cde_change_request_create",
    "Creates a DRAFT parameter change request on an IFC model: which elements (globalIds, or a structured model query as in cde_model_query) " +
      "and what to set (property and new value). The CDE computes the items (old → new, missing properties are added). " +
      "preview: true only returns the item preview without saving. Confirm with the user before creating.",
    {
      projectId: pid,
      versionId: z.string().uuid().optional().describe("IFC version id (cde_models_list); default: newest version of `model`."),
      model: z.string().optional().describe("Part of the model file name, when versionId is not known."),
      title: z.string().min(1).max(200).optional().describe("Short title, e.g. 'Kapı yangın dayanımı EI60'. Required unless preview."),
      reason: z.string().max(4000).optional(),
      globalIds: z.array(z.string()).max(5000).optional().describe("Explicit element selection."),
      query: modelQueryShape.optional(),
      set: z.union([setRule, z.array(setRule).min(1).max(10)]),
      ownership: z.enum(["revit", "cde_only"]).optional().describe("revit: the authoring model must get it too; cde_only: information kept in the CDE."),
      typeMode: z.enum(["instance", "type"]).default("instance").describe("Values on the type object: override on the element (default) or change the type."),
      workId: z.string().uuid().optional().describe("Work (e.g. bilgi talebi) that caused the change."),
      issueId: z.string().uuid().optional().describe("Issue that caused the change."),
      preview: z.boolean().default(false),
    },
    async (a) => {
      const versionId = a.versionId ?? (await pickVersion(call, a.projectId, a.model)).id;
      if (!a.globalIds?.length && !a.query) throw new Error("globalIds veya query gerekli.");
      const spec = a.globalIds?.length ? { source: "selection", globalIds: a.globalIds, set: a.set } : { source: "query", query: a.query, set: a.set };
      if (a.preview) {
        const p = await call<Any>("POST", `/projects/${a.projectId}/param-changes/preview`, { versionId, spec });
        return {
          total: p.total,
          changes: p.changes,
          added: p.missing,
          unchanged: p.unchanged,
          typeLevel: p.typeLevel,
          byClass: p.byClass,
          byStorey: p.byStorey,
          typeImpact: p.typeImpact,
          suggestedOwnership: p.suggestedOwnership,
          warnings: p.warnings,
          items: p.items.slice(0, 50).map((i: Any) => ({ globalId: i.globalId, property: `${i.pset}.${i.property}`, old: i.oldValue, new: i.newValue, source: i.source })),
        };
      }
      if (!a.title) throw new Error("title gerekli.");
      const r = await call<Any>("POST", `/projects/${a.projectId}/param-changes`, {
        versionId,
        title: a.title,
        reason: a.reason,
        spec,
        ownership: a.ownership,
        typeMode: a.typeMode,
        workId: a.workId,
        issueId: a.issueId,
      });
      return { ...detail(r, 20), next: "Draft saved. It needs approval (submit in the web app) before it is applied, unless the project does not require approval." };
    },
    { write: true },
  );

  tool(
    "cde_change_request_verify",
    "Checks a later IFC version (default: the newest) against a change request's items. All expected values present → the request becomes 'uygulandı' " +
      "(use after a Revit re-export for requests in 'Revit'te uygulanacak'). Returns the missing items.",
    { projectId: pid, requestId: rid, versionId: z.string().uuid().optional() },
    async (a) => {
      const r = await call<Any>("POST", `/projects/${a.projectId}/param-changes/${a.requestId}/verify`, a.versionId ? { versionId: a.versionId } : {});
      return { ...row(r), check: { version: r.check.version, ok: r.check.ok, present: r.check.present, missing: r.check.lost.slice(0, 100) } };
    },
    { write: true },
  );

  tool(
    "cde_change_request_apply",
    "Applies an APPROVED change request in the CDE: writes the property values with web-ifc and stores a new version of the IFC file " +
      "(same rules as an upload; project admin or approver only). Waits up to `waitSeconds` for the new version and its verification. " +
      "Confirm with the user before applying.",
    {
      projectId: pid,
      requestId: rid,
      typeMode: z.enum(["instance", "type"]).optional(),
      waitSeconds: z.number().int().min(0).max(600).default(120),
    },
    async (a) => {
      let r = await call<Any>("POST", `/projects/${a.projectId}/param-changes/${a.requestId}/apply`, a.typeMode ? { typeMode: a.typeMode } : {});
      const deadline = Date.now() + a.waitSeconds * 1000;
      while (r.status === "applying" && Date.now() < deadline) {
        await wait(2000);
        r = await call<Any>("GET", `/projects/${a.projectId}/param-changes/${a.requestId}`);
      }
      return {
        ...row(r),
        ...(r.status === "applying" && { note: "Still running: the new version is being created and indexed. Check later with cde_change_request_get." }),
        ...(r.appliedVersionId && { compare: projectPath(a.projectId, `viewer?v=${r.appliedVersionId}&cmp=${r.baseVersionId},${r.appliedVersionId}`) }),
      };
    },
    { write: true },
  );
}
