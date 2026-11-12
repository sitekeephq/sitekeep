/**
 * Tools that let an external model (Claude, DeepSeek… over MCP) act as the CDE's AI:
 *   - schemas and instructions the app's own AI prompts use (cde_ai_schemas)
 *   - save what the in-app AI would draft: report dashboards, form templates, form flows, draft
 *     works, workflow templates. Every save goes through the normal REST route, so the same zod
 *     schemas, permission checks and module switches apply. Nothing is sent or published.
 *   - the AI task queue ("Yapay Zekâya Gönder"): tasks users handed to a connected AI client.
 */
import { z } from "zod";
import type { CdeCall } from "../core/types.js";
import type { ToolAdder } from "../core/define.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const confirm = " Changes live project data: confirm with the user first.";

/** Query ids the dashboard HTML never reads (the in-app builder refuses those). */
export function unusedQueryIds(html: string, ids: string[]): string[] {
  return ids.filter((id) => !new RegExp(`[.\\[]\\s*["']?${id}\\b`).test(html));
}

export function registerAiTools(tool: ToolAdder, call: CdeCall): void {
  const pid = z.string().uuid().describe("Project id (from cde_projects_list).");
  const queries = z
    .array(z.object({ id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), spec: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(20)
    .describe("Report queries [{id, spec: {dataset, filters, groupBy, metrics, fields, sort, limit}}] (cde_report_datasets).");

  tool(
    "cde_ai_schemas",
    "JSON schemas and short instructions the app's own AI prompts use: answers of each in-app AI feature (report spec, form fields, flow, model query, " +
      "translation…) and the bodies of the save tools (cde_report_save, cde_form_template_save, cde_form_flow_save, cde_workflow_template_save, cde_work_draft). " +
      "Read before producing such output so it is valid on the first try.",
    { part: z.string().max(60).optional().describe("Only one part: a feature kind (e.g. report_generate) or a save key (report, formTemplate, formFlow, workflowTemplate, letter).") },
    async (a) => {
      const all = await call<Any>("GET", "/ai/schemas");
      if (!a.part)
        return {
          note: "Call again with part=<kind or save key> for the full JSON schema.",
          features: (all.features as Any[]).map((f) => ({ kind: f.kind, label: f.label, format: f.format, instructions: f.instructions })),
          save: Object.fromEntries(Object.entries(all.save ?? {}).map(([k, v]) => [k, { tool: (v as Any).tool, instructions: (v as Any).instructions }])),
        };
      const feature = (all.features as Any[]).find((f) => f.kind === a.part);
      if (feature) return feature;
      if (all.save?.[a.part]) return all.save[a.part];
      return { error: `'${a.part}' yok.`, features: (all.features as Any[]).map((f) => f.kind), save: Object.keys(all.save ?? {}) };
    },
  );

  tool(
    "cde_report_save",
    "Creates (or with reportId updates) a report dashboard from {name, description, queries, html}. Queries are checked against the datasets the caller may use; " +
      "the HTML must read every query as d.<id> inside CDE.onData. New dashboards are private unless sharing is given. Returns the web link and row counts." +
      confirm,
    {
      projectId: pid,
      reportId: z.string().uuid().optional().describe("Existing dashboard to update (owner or project admin)."),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(2000).optional(),
      queries,
      html: z.string().min(1).max(500_000).describe("Dashboard HTML fragment (no <html>/<head>), Turkish labels."),
      sharing: z.enum(["private", "project", "company", "admins"]).optional(),
    },
    async (a) => {
      const unused = unusedQueryIds(a.html, a.queries.map((q) => q.id));
      if (unused.length)
        throw new Error(`HTML şu sorguları okumuyor: ${unused.join(", ")}. CDE.onData(function (d) { … d.${unused[0]} … }) içinde kullanın.`);
      const base = `/projects/${a.projectId}/reports`;
      const body = { name: a.name, description: a.description ?? null, queries: a.queries, html: a.html, ...(a.sharing && { sharing: a.sharing }) };
      const d = a.reportId ? await call<Any>("PATCH", `${base}/${a.reportId}`, body) : await call<Any>("POST", base, body);
      const data = await call<Any>("GET", `${base}/${d.id}/data`).catch(() => null);
      return {
        id: d.id,
        name: d.name,
        version: d.version,
        sharing: d.sharing,
        link: projectPath(a.projectId, `reports/${d.id}`),
        rows: data ? Object.fromEntries(Object.entries(data.results ?? {}).map(([k, v]) => [k, (v as unknown[]).length])) : undefined,
        errors: data && Object.keys(data.errors ?? {}).length ? data.errors : undefined,
      };
    },
    { write: true },
  );

  tool(
    "cde_form_template_save",
    "Creates (or with templateId updates) a form template from fields JSON: {code, name, category, schema: {sections: [{title, items: [{type, label, required, …}]}]}}. " +
      "Optionally attach an uploaded PDF source (sourceId from Formlar → PDF'ten Şablon) with items[].pdf rects {page, x, y, w, h}. Project admins only." +
      confirm,
    {
      projectId: pid,
      templateId: z.string().uuid().optional(),
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(200),
      category: z.string().max(100).nullable().optional(),
      description: z.string().max(2000).optional(),
      numberPattern: z.string().max(100).optional().describe("e.g. {PROJE}-{KOD}-{YYYY}-{000}; default {KOD}-{0000}."),
      schema: z.object({ sections: z.array(z.record(z.string(), z.unknown())).min(1).max(50) }).passthrough(),
      sourceId: z.string().uuid().optional().describe("PDF source id; item placements go in items[].pdf."),
      workflowTemplateId: z.string().uuid().nullable().optional(),
    },
    async (a) => {
      const { projectId, templateId, ...body } = a;
      const t = templateId
        ? await call<Any>("PUT", `/projects/${projectId}/form-templates/${templateId}`, body)
        : await call<Any>("POST", `/projects/${projectId}/form-templates`, body);
      const items = (t.schema?.sections ?? []).reduce((n: number, s: Any) => n + (s.items?.length ?? 0), 0);
      return { id: t.id, code: t.code, name: t.name, version: t.version, items, link: projectPath(projectId, "forms") };
    },
    { write: true },
  );

  tool(
    "cde_form_flow_save",
    "Saves a form template's approval flow. Give `draft` in the small format the app's own model answers (filler, steps [{who, action, outcomes, onReject, days, fields}]); " +
      "names are matched to project roles, companies and people with the app's rules. If some names are unknown the flow is NOT saved: the answer lists them " +
      "with suggestions (create the role or use a suggested name, then call again). Or give `flow` (full body with assignees) to save as is. Project admins only." +
      confirm,
    {
      projectId: pid,
      templateId: z.string().uuid().describe("Form template id (cde_form_templates_list)."),
      draft: z.record(z.string(), z.unknown()).optional().describe("Model-style flow draft (cde_ai_schemas part formFlow → draftSchema)."),
      flow: z.record(z.string(), z.unknown()).optional().describe("Full flow body {name, steps, finalOutcomes, chain} (flowSchema)."),
      name: z.string().max(200).optional().describe("Flow name (default: from the draft or the template)."),
    },
    async (a) => {
      if (!a.draft && !a.flow) throw new Error("draft veya flow verin.");
      let body: Any = a.flow;
      if (a.draft) {
        const c = await call<Any>("POST", `/projects/${a.projectId}/form-templates/flow/compile`, { draft: a.draft, templateId: a.templateId });
        if (c.unresolved?.length)
          return {
            saved: false,
            steps: c.lines,
            unresolvedRoles: c.unresolved.map((u: Any) => ({ name: u.name, suggestions: (u.suggestions ?? []).map((s: Any) => s.name) })),
            next: "Bu adlar projede yok. Önerilen bir adla tekrar deneyin ya da rolü Proje Ayarları → Roller'de oluşturun.",
            warnings: c.warnings,
          };
        body = { ...c.flow, ...(a.name && { name: a.name }) };
      } else if (a.name) body = { ...body, name: a.name };
      const saved = await call<Any>("PUT", `/projects/${a.projectId}/form-templates/${a.templateId}/flow`, body);
      return { saved: true, steps: saved.flow?.lines ?? [], workflowTemplateId: saved.flow?.workflowTemplateId, link: projectPath(a.projectId, "forms") };
    },
    { write: true },
  );

  tool(
    "cde_work_draft",
    "Creates a DRAFT work of any enabled type (cde_work_types_list): RFI, submittal item, meeting, transmittal or an outgoing letter with letter data " +
      "(recipient, body, signer, translations) and links (ilgi works, attached file versions). Drafts only: the tool never sends, e-mails or KEPs anything; " +
      "the user reviews and sends in the web app. With replyToWorkId the draft is created as the reply of that incoming letter." +
      confirm,
    {
      projectId: pid,
      typeKey: z.string().min(1).max(40).optional().describe("Work type key; default giden-yazi for replies."),
      title: z.string().min(1).max(300).optional(),
      fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      toCompanyIds: z.array(z.string().uuid()).max(50).optional(),
      ccCompanyIds: z.array(z.string().uuid()).max(50).optional(),
      assigneeUserId: z.string().uuid().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      parentWorkId: z.string().uuid().optional(),
      replyToWorkId: z.string().uuid().optional().describe("Incoming letter to answer (the reply is linked as ilgi and answers it when sent)."),
      letter: z.record(z.string(), z.unknown()).optional().describe("Letter data (cde_ai_schemas part letter)."),
      links: z
        .array(z.object({ kind: z.enum(["file_version", "review", "issue", "work"]), targetId: z.string().uuid(), role: z.enum(["ilgi", "ek", "kaynak"]).optional() }))
        .max(100)
        .optional(),
    },
    async (a) => {
      const base = `/projects/${a.projectId}/works`;
      let w: Any;
      if (a.replyToWorkId) {
        w = await call<Any>("POST", `${base}/${a.replyToWorkId}/reply`, { ...(a.title && { title: a.title }), ...(a.typeKey && { typeKey: a.typeKey }) });
        const patch = { ...(a.fields && { fields: a.fields }), ...(a.dueDate && { dueDate: a.dueDate }), ...(a.assigneeUserId && { assigneeUserId: a.assigneeUserId }) };
        if (Object.keys(patch).length) w = await call<Any>("PATCH", `${base}/${w.id}`, patch);
        if (a.letter) w = await call<Any>("PUT", `${base}/${w.id}/letter`, a.letter);
        if (a.links?.length) await call("POST", `${base}/${w.id}/links`, { links: a.links });
      } else {
        if (!a.typeKey || !a.title) throw new Error("typeKey ve title gerekli (yanıt değilse).");
        const { projectId, replyToWorkId, ...body } = a;
        void projectId;
        void replyToWorkId;
        w = await call<Any>("POST", base, body);
      }
      w = await call<Any>("GET", `${base}/${w.id}`);
      return { id: w.id, number: w.number, title: w.title, type: w.typeName, status: w.statusLabel ?? w.status, draft: true, link: projectPath(a.projectId, `works/${w.id}`) };
    },
    { write: true },
  );

  tool(
    "cde_workflow_template_save",
    "Creates (or with templateId updates) a workflow template {kind: review|rfi|submittal|transmittal|form, name, steps: [{name, assignees: [{type: user|company|role, id}], " +
      "rule: any|all, days, outcomes}], finalOutcomes, chain}. Project admins only." +
      confirm,
    {
      projectId: pid,
      templateId: z.string().uuid().optional(),
      kind: z.enum(["review", "rfi", "submittal", "transmittal", "form"]).default("review"),
      name: z.string().trim().min(1).max(200),
      steps: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
      finalOutcomes: z.record(z.string(), z.string()).optional(),
      chain: z.record(z.string(), z.unknown()).optional(),
    },
    async (a) => {
      const { projectId, templateId, ...body } = a;
      const t = templateId
        ? await call<Any>("PUT", `/projects/${projectId}/workflow-templates/${templateId}`, body)
        : await call<Any>("POST", `/projects/${projectId}/workflow-templates`, body);
      return { id: t.id, kind: t.kind, name: t.name, steps: (t.steps ?? []).map((s: Any) => s.name) };
    },
    { write: true },
  );

  // ---- AI task queue ("Yapay Zekâya Gönder") -----------------------------------------------

  tool(
    "cde_ai_tasks_list",
    "Pending AI tasks users handed to a connected AI client ('Yapay Zekâya Gönder') in projects you are a member of: report drafts, form flows, field naming, " +
      "translations, compare summaries, Modele sor, Sor questions, minutes actions, RFI drafts. Then cde_ai_task_claim → do it → cde_ai_task_complete.",
    {},
    async () => {
      const list = await call<Any[]>("GET", "/ai-tasks");
      return {
        count: list.length,
        tasks: list.map((t) => ({ taskId: t.id, projectId: t.projectId, project: t.projectCode, kind: t.kind, label: t.label, summary: t.summary, requestedBy: t.requestedByName, status: t.status, expiresAt: t.expiresAt })),
      };
    },
    { write: true },
  );

  tool(
    "cde_ai_task_claim",
    "Claims an AI task and returns everything to do it: the exact prompt the app's own model would get, the answer format and JSON schema, " +
      "and the read tools that help (data comes from the prompt; use tools only for missing details). Answer with cde_ai_task_complete.",
    { projectId: pid, taskId: z.string().uuid() },
    (a) => call("POST", `/projects/${a.projectId}/ai-tasks/${a.taskId}/claim`, {}),
    { write: true },
  );

  tool(
    "cde_ai_task_complete",
    "Sends the answer of a claimed AI task. The app validates it with its own schema and rules as the requesting user; on errors they come back — fix and resend. " +
      "A valid answer is applied with the requester's rights (a report becomes their private dashboard; flows, translations and templates stay drafts they confirm).",
    {
      projectId: pid,
      taskId: z.string().uuid(),
      result: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe("The answer: JSON object for JSON tasks, text for text tasks."),
    },
    (a) => call("POST", `/projects/${a.projectId}/ai-tasks/${a.taskId}/complete`, { result: a.result }),
    { write: true },
  );

  tool(
    "cde_ai_task_fail",
    "Gives up a claimed AI task with a short reason (Turkish) the requester sees.",
    { projectId: pid, taskId: z.string().uuid(), error: z.string().max(1000).default("") },
    (a) => call("POST", `/projects/${a.projectId}/ai-tasks/${a.taskId}/fail`, { error: a.error }),
    { write: true },
  );
}
