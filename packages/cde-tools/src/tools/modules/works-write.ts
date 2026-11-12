import { WORK_STATUS, projectPath } from "@sitekeep/shared";
import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, day, type Any, type Row } from "../../format/common.js";
import { workRow } from "../../format/works.js";

export function registerWorkWriteTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const companyNames = async (): Promise<Map<string, string>> => call<Any[]>("GET", "/companies").then((rows) => new Map(rows.map((company) => [company.id as string, company.name as string]))).catch(() => new Map<string, string>());
// ---- Write tools -------------------------------------------------------------------------

const confirm = " Changes live project data: confirm with the user first.";
const workResult = async (projectId: string, workId: string) => {
  const w = await call<Any>("GET", `/projects/${projectId}/works/${workId}`);
  return clean({ ...workRow(w), ballInCourt: w.build?.ballInCourt, link: `/projects/${projectId}/works/${w.id}` });
};

tool(
  "cde_work_create",
  "Creates a work (draft) of a type by its key (cde_work_types_list), e.g. an RFI or a submittal item. Fields are validated by the server " +
    "against the type's required fields and options." +
    confirm,
  {
    projectId: pid,
    typeKey: z.string().min(1).max(40),
    title: z.string().min(1).max(300),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Custom field values by field key"),
    toCompanyIds: z.array(z.string().uuid()).max(50).optional(),
    ccCompanyIds: z.array(z.string().uuid()).max(50).optional(),
    assigneeUserId: z.string().uuid().optional(),
    dueDate: date.optional(),
    parentWorkId: z.string().uuid().optional().describe("Submittal package or meeting"),
  },
  async (a) => {
    const { projectId, ...body } = a;
    const w = await call<Any>("POST", `/projects/${projectId}/works`, body);
    return clean({ ...workRow(w), link: `/projects/${projectId}/works/${w.id}` });
  },
  { write: true },
);

const INTAKE_TYPE_KEYS: Record<string, string> = { "gelen-yazi": "gelen-yazi", rfi: "rfi", submittal: "submittal-kalemi", transmittal: "transmittal" };
const INTAKE_LABELS: Record<string, string> = { "gelen-yazi": "Gelen Yazı", rfi: "Bilgi Talebi", submittal: "Teknik Onay", transmittal: "Gönderim Formu" };

tool(
  "cde_record_from_file",
  "\"Bırak, kaydet\": reads an uploaded project file (PDF letter, .eml / .msg e-mail or .docx) and proposes a record draft with the app's rules " +
    "(no AI): type (Gelen Yazı unless the text names Bilgi Talebi / Teknik Onay / Gönderim Formu), sender company, sayı, letter date, subject, " +
    "ilgi references matched to existing works, due date (\"… gün içinde\") and reply flag. A scanned PDF without a text layer gives an empty draft. " +
    "With create=true the record is created as a DRAFT (status taslak, never sent) with the file as \"ek\" and the matched ilgi links; " +
    "the type can be overridden with type." +
    confirm,
  {
    projectId: pid,
    fileId: id("File id (current version)").optional(),
    versionId: id("Version id").optional(),
    create: z.boolean().optional().describe("Create the draft record"),
    type: z.enum(["gelen-yazi", "rfi", "submittal", "transmittal"]).optional().describe("Override the proposed type"),
  },
  async (a) => {
    if (!a.fileId && !a.versionId) throw new Error("fileId veya versionId gerekli.");
    const r = await call<Any>("POST", `/projects/${a.projectId}/record-from-file`, a.versionId ? { versionId: a.versionId } : { fileId: a.fileId });
    const d = r.draft;
    const kind: string = a.type ?? d.kind;
    const names = new Map(((await call<Any[]>("GET", "/companies")) ?? []).map((c: Any) => [c.id, c.name]));
    const out: Row = clean({
      file: r.file.name,
      type: kind,
      typeLabel: INTAKE_LABELS[kind],
      title: d.title,
      sender: (d.fromCompanyId && names.get(d.fromCompanyId)) || d.fromText,
      senderCompanyId: d.fromCompanyId,
      sayi: d.sayi,
      date: d.date,
      subject: d.subject,
      references: (d.references as Any[]).map((x) => clean({ number: x.number, date: x.date, work: x.workNumber, workId: x.workId })),
      dueDate: d.dueDate,
      replyRequired: d.replyRequired,
      noTextLayer: r.noTextLayer,
      notes: r.notes,
    });
    out.created = null;
    if (!a.create) return out;
    const typeKey = INTAKE_TYPE_KEYS[kind]!;
    const types = await call<Any[]>("GET", `/projects/${a.projectId}/work-types`);
    const t = types.find((x) => x.key === typeKey);
    if (!t) throw new Error(`${INTAKE_LABELS[kind]} iş tipi bu projede yok.`);
    const keys = (t.fields as Any[]).map((f) => f.key);
    const fields = Object.fromEntries(Object.entries({ sayi: d.sayi, tarih: d.date, konu: d.subject }).filter(([k, v]) => v && keys.includes(k)));
    try {
      const w = await call<Any>("POST", `/projects/${a.projectId}/works`, {
        typeKey,
        title: d.title || r.file.name,
        status: WORK_STATUS.draft,
        fields,
        ...(t.settings?.incoming && d.fromCompanyId ? { fromCompanyId: d.fromCompanyId } : {}),
        dueDate: d.dueDate,
        replyRequired: d.replyRequired,
        links: [
          { kind: "file_version", targetId: r.file.versionId, role: "ek" },
          ...(d.references as Any[]).filter((x) => x.workId).map((x) => ({ kind: "work", targetId: x.workId, role: "ilgi" })),
        ],
      });
      out.created = clean({ ...workRow(w), link: projectPath(a.projectId, `works/${w.id}`) });
    } catch (e) {
      out.createError = (e as Error).message;
    }
    return out;
  },
  { write: true },
);

tool(
  "cde_work_comment",
  "Adds a comment to a work's timeline." + confirm,
  { projectId: pid, workId: wid, body: z.string().min(1).max(10000) },
  async (a) => {
    await call("POST", `/projects/${a.projectId}/works/${a.workId}/comments`, { body: a.body });
    return workResult(a.projectId, a.workId);
  },
  { write: true },
);

tool(
  "cde_work_submit",
  "Submits an RFI or submittal (draft or returned for revision) into its workflow; the first step's assignees get the ball." + confirm,
  { projectId: pid, workId: wid, comment: z.string().max(5000).optional() },
  async (a) => {
    await call("POST", `/projects/${a.projectId}/works/${a.workId}/submit`, { comment: a.comment ?? null });
    return workResult(a.projectId, a.workId);
  },
  { write: true },
);

tool(
  "cde_work_respond",
  "Answers the current workflow step of an RFI or submittal as the caller: outcome code (from cde_work_get options), comment and, " +
    "for RFIs, the official response text." +
    confirm,
  {
    projectId: pid,
    workId: wid,
    outcome: z.string().min(1).max(60),
    comment: z.string().max(10000).optional(),
    response: z.string().max(20000).optional().describe("Official response (RFI)"),
  },
  async (a) => {
    await call("POST", `/projects/${a.projectId}/works/${a.workId}/respond`, { outcome: a.outcome, comment: a.comment ?? null, response: a.response ?? null });
    return workResult(a.projectId, a.workId);
  },
  { write: true },
);

tool(
  "cde_meeting_minutes_update",
  "Saves the minutes of a meeting: the FULL list of items (keep existing items with their id from cde_work_get; items without id are new). " +
    "Items with a responsible person/company or a due date become action works." +
    confirm,
  {
    projectId: pid,
    workId: wid,
    items: z
      .array(
        z.object({
          id: z.string().max(64).optional(),
          konu: z.string().min(1).max(300).describe("Topic"),
          karar: z.string().max(5000).optional().describe("Decision"),
          sorumluUserId: z.string().uuid().optional(),
          sorumluCompanyId: z.string().uuid().optional(),
          termin: date.optional().describe("Due date"),
        }),
      )
      .max(300),
    notes: z.string().max(20000).optional(),
  },
  async (a) => {
    const r = await call<Any>("PUT", `/projects/${a.projectId}/works/${a.workId}/minutes`, { items: a.items, notes: a.notes ?? null });
    return { ...(await workResult(a.projectId, a.workId)), saved: r };
  },
  { write: true },
);
}
