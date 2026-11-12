import { FORM_STATUS_LABELS_TR, projectPath } from "@sitekeep/shared";
import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, cut, day, qs, type Any, type Row } from "../../format/common.js";
import { capList } from "../../format/lists.js";

const formStatus = (status: string): string => { const label = FORM_STATUS_LABELS_TR[status as keyof typeof FORM_STATUS_LABELS_TR]; return label ? label[0]!.toLocaleLowerCase("tr-TR") + label.slice(1) : status; };
const confirm = " Changes live project data: confirm with the user first.";

function formValueText(item: Any, value: unknown): unknown { if (value === null || value === undefined || value === "") return undefined; switch (item.type) { case "yes_no": return value === "yes" ? "Evet" : value === "no" ? "Hayır" : value === "na" ? "U.D." : value; case "photo": case "signature": return Array.isArray(value) ? `${value.length} ek` : "ek var"; case "table": return Array.isArray(value) ? `${value.length} satır` : undefined; case "location": case "file": return undefined; default: return Array.isArray(value) ? value.join(", ") : typeof value === "string" ? cut(value, 200) : value; } }

export function registerFormTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// ---- Forms & locations -------------------------------------------------------------------

tool(
  "cde_form_templates_list",
  "Form templates (id, code, name, category, form count, origin: pdf = made from the client's own PDF form, library, manual) " +
    "with the approval flow as numbered steps (who fills, who checks, where a rejection goes, which items each step signs). " +
    "includeItems lists the item ids, labels and types (values of cde_form_create_draft are keyed by item id).",
  { projectId: pid, includeItems: z.boolean().default(false) },
  async (a) =>
    (await call<Any[]>("GET", `/projects/${a.projectId}/form-templates`)).map((t) =>
      clean({
        id: t.id,
        code: t.code,
        name: t.name,
        category: t.category,
        forms: t.formCount,
        origin: t.origin,
        sourcePdf: t.source ? clean({ file: t.source.fileName, pages: t.source.pageCount, detection: t.source.level }) : undefined,
        flow: t.flowLines?.length ? t.flowLines : undefined,
        items: a.includeItems
          ? (t.schema?.sections ?? []).flatMap((s: Any) =>
              (s.items ?? []).map((i: Any) => clean({ id: i.id, section: s.title, label: i.label, type: i.type, required: !!i.required, options: i.options })),
            )
          : undefined,
      }),
    ),
);

tool(
  "cde_forms_list",
  "Lists forms (inspections, checklists, daily reports): number, template, status, location, date, score and failed items. status open = not closed.",
  {
    projectId: pid,
    templateId: id("Form template id").optional(),
    status: z.enum(["draft", "submitted", "in_review", "closed", "open"]).optional(),
    locationId: id("Location id (includes sub-locations)").optional(),
    from: date.optional(),
    to: date.optional(),
    mine: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async (a) => {
    const rows = await call<Any[]>(
      "GET",
      `/projects/${a.projectId}/forms${qs({ templateId: a.templateId, status: a.status, locationId: a.locationId, from: a.from, to: a.to, mine: a.mine })}`,
    );
    const list = capList(
      rows.map((f) =>
        clean({
          id: f.id,
          number: f.number,
          template: f.templateName,
          status: formStatus(f.status),
          date: f.formDate,
          location: f.locationPath,
          score: f.score,
          failed: f.failedCount || undefined,
          by: f.createdByName,
        }),
      ),
      a.limit,
    );
    return clean({ total: rows.length, open: rows.filter((f) => f.status !== "closed").length, forms: list.items, more: list.more });
  },
);

tool(
  "cde_form_get",
  "Form details: answers by item label, failed items, linked issues, attachments count and review step.",
  { projectId: pid, formId: id("Form id") },
  async (a) => {
    const f = await call<Any>("GET", `/projects/${a.projectId}/forms/${a.formId}`);
    const answers: Row = {};
    let count = 0;
    for (const s of f.schema?.sections ?? [])
      for (const i of s.items ?? []) {
        const v = formValueText(i, f.values?.[i.id]);
        if (v === undefined || count >= 60) continue;
        answers[i.label] = v;
        count++;
      }
    return clean({
      id: f.id,
      number: f.number,
      template: f.templateName,
      status: formStatus(f.status),
      date: f.formDate,
      location: f.locationPath,
      score: f.score,
      by: f.createdByName,
      submitted: day(f.submittedAt),
      closed: day(f.closedAt),
      answers,
      failedItems: (f.failedItems ?? []).slice(0, 20).map((x: Any) => x.label),
      issues: (f.issueLinks ?? []).map((l: Any) => `#${l.issueNumber} ${l.issueTitle} (${l.issueStatus})`),
      attachments: (f.attachments ?? []).length,
      workflow: f.workflow
        ? clean({
            status: f.workflow.status,
            step: f.workflow.stepName ? `${f.workflow.stepIndex + 2}. ${f.workflow.stepName}` : undefined,
            due: day(f.workflow.stepDueAt),
            answers: (f.workflow.options ?? []).map((o: Any) => o.label),
          })
        : undefined,
      stepItems: f.reservedFields && Object.keys(f.reservedFields).length ? f.reservedFields : undefined,
      printsOnSourcePdf: f.source ? true : undefined,
    });
  },
);

tool(
  "cde_locations_tree",
  "Location breakdown (blocks, floors, rooms, chainage) as a tree with ids, codes and types.",
  { projectId: pid, depth: z.number().int().min(1).max(10).default(4) },
  async (a) => {
    const rows = await call<Any[]>("GET", `/projects/${a.projectId}/locations`);
    const kids = new Map<string | null, Any[]>();
    for (const l of rows) kids.set(l.parentId ?? null, [...(kids.get(l.parentId ?? null) ?? []), l]);
    let budget = 300;
    const walk = (l: Any, d: number): Row => {
      budget--;
      const children = d < a.depth ? (kids.get(l.id) ?? []).filter(() => budget > 0).map((c) => walk(c, d + 1)) : [];
      return clean({
        id: l.id,
        name: l.name,
        code: l.code,
        type: l.type,
        km: l.kmStart != null ? (l.kmEnd != null ? `${l.kmStart}–${l.kmEnd}` : String(l.kmStart)) : null,
        children,
        moreChildren: d >= a.depth && kids.get(l.id)?.length ? kids.get(l.id)!.length : undefined,
      });
    };
    const tree = (kids.get(null) ?? []).map((l) => walk(l, 1));
    return clean({ count: rows.length, tree, note: budget <= 0 ? "Ağaç kısaltıldı." : undefined });
  },
);
}

export function registerFormWriteTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
tool(
  "cde_form_template_from_description",
  "Creates a form template from a short Turkish description with the project's local AI model (project admins), optionally with its " +
    "approval flow from a second description (\"Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa geri döner\"). " +
    "Roles the project does not have are not created: the flow is then returned as a draft with suggestions and saved later in Formlar → Şablonlar. Slow on CPU (minutes)." +
    confirm,
  {
    projectId: pid,
    description: z.string().min(5).max(2000).describe("What the form checks, in Turkish"),
    flowDescription: z.string().min(10).max(3000).optional().describe("Who fills, who checks / approves, where a rejection goes, due days"),
    code: z.string().max(20).optional(),
    name: z.string().max(200).optional(),
  },
  async (a) => {
    const g = await call<Any>("POST", `/projects/${a.projectId}/form-templates/generate`, { description: a.description });
    const t = await call<Any>("POST", `/projects/${a.projectId}/form-templates`, {
      code: (a.code ?? g.code).toLocaleUpperCase("tr-TR"),
      name: a.name ?? g.name,
      category: g.category,
      schema: g.schema,
    });
    let flow: Any = undefined;
    if (a.flowDescription) {
      const d = await call<Any>("POST", `/projects/${a.projectId}/form-templates/flow/generate`, { description: a.flowDescription, templateId: t.id });
      if (!d.unresolved?.length) {
        const saved = await call<Any>("PUT", `/projects/${a.projectId}/form-templates/${t.id}/flow`, d.flow);
        flow = { saved: true, steps: saved.flow.lines };
      } else
        flow = {
          saved: false,
          steps: d.lines,
          unresolvedRoles: d.unresolved.map((u: Any) => ({ name: u.name, suggestions: u.suggestions.map((s: Any) => s.name) })),
          next: "Rolleri Formlar → Şablonlar → Akış ekranında oluşturun veya eşleştirin, sonra kaydedin.",
        };
    }
    return clean({ id: t.id, code: t.code, name: t.name, items: (t.schema?.sections ?? []).reduce((n: number, s: Any) => n + (s.items?.length ?? 0), 0), flow, link: projectPath(a.projectId, "forms") });
  },
  { write: true },
);

tool(
  "cde_form_create_draft",
  "Creates a draft form from a template (cde_form_templates_list), optionally at a location, with answers keyed by item id. Not submitted." + confirm,
  {
    projectId: pid,
    templateId: id("Form template id"),
    locationId: z.string().uuid().optional(),
    formDate: date.optional(),
    values: z.record(z.string(), z.unknown()).optional().describe("Answers by item id, e.g. yes_no: \"yes\"|\"no\"|\"na\""),
  },
  async (a) => {
    const { projectId, ...body } = a;
    const f = await call<Any>("POST", `/projects/${projectId}/forms`, body);
    return clean({ id: f.id, number: f.number, template: f.templateName, status: formStatus(f.status), date: f.formDate, location: f.locationPath, link: `/projects/${projectId}/forms/${f.id}` });
  },
  { write: true },
);
}
