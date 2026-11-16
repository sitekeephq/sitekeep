// Project templates, format v2 with Manage: the construction template's RFI, submittal and meeting
// settings land on the project's work types (manage.templateApply). Skipped while the installed
// Manage version has no handler (docs/features/PROJECT_TEMPLATES.md#module-hook).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { capability } from "../../../src/sdk/capabilities.js";
import { workTypes, workflowTemplates } from "../../../src/db/schema.js";
import { hasManage } from "../../helpers/modules.js";
import { templateServer, type TemplateServer } from "../../helpers/template-project.js";

const handlers = hasManage ? capability("manage.templateApply") : undefined;
let s: TemplateServer;

beforeAll(async () => {
  s = await templateServer();
});
afterAll(async () => {
  await s.close();
});

describe("project templates with Manage", () => {
  it.skipIf(!handlers?.rfi)("applies the RFI, submittal and meeting settings of the English construction template", async () => {
    const r = await s.create({ code: "MGT", name: "Manage", templateId: "iso19650-yapim-en", slotCompanies: s.slotCompanies, language: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parts = Object.fromEntries((r.body.parts as { part: string }[]).map((p) => [p.part, p]));
    for (const part of ["rfi", "submittals", "meetings"]) expect(["applied", "partial"]).toContain((parts[part] as { status: string }).status);
    const pid = r.body.id as string;
    const type = async (key: string) => (await s.handle.db.select().from(workTypes).where(and(eq(workTypes.projectId, pid), eq(workTypes.key, key))))[0]!;
    const options = (t: { fields: { key: string; options?: string[] }[] }, key: string) => t.fields.find((f) => f.key === key)!.options;
    const rfi = await type("rfi");
    expect(options(rfi, "disiplin")![0]).toBe("Z - General");
    expect(options(rfi, "kategori")).toEqual(["Design Coordination", "Site Execution", "Material", "Other"]);
    expect(rfi.settings.dueDays).toBe(7);
    expect(rfi.numberingPattern).toBe("{Proje}-{Gönderen}-{Alıcı}-RFI-{Disiplin}-{0000}");
    const [rfiFlow] = await s.handle.db.select().from(workflowTemplates).where(and(eq(workflowTemplates.projectId, pid), eq(workflowTemplates.kind, "rfi")));
    expect(rfi.defaultWorkflowTemplateId).toBe(rfiFlow!.id);
    const item = await type("submittal-kalemi");
    expect(options(item, "tur")).toContain("MAR - Material Approval Request");
    expect(options(item, "disiplin")).toContain("M - Mechanical engineer");
    expect(item.settings.dueDays).toBe(14);
    expect(options(await type("toplanti"), "tur")).toEqual(["Client", "Design", "Site coordination", "Quality control", "MEP", "Programme", "BIM coordination", "HSE"]);
  });
});
