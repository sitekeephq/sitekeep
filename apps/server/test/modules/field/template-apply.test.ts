// Project templates, format v2 with Field: the construction template's forms become form templates
// with their sections and approval workflows (field.templateApply). Skipped while the installed Field
// version has no handler (docs/features/PROJECT_TEMPLATES.md#module-hook).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { capability } from "../../../src/sdk/capabilities.js";
import { moduleTable } from "../../../src/app/modules.js";
import { workflowTemplates } from "../../../src/db/schema.js";
import { hasField } from "../../helpers/modules.js";
import { templateServer, type TemplateServer } from "../../helpers/template-project.js";

const handlers = hasField ? capability("field.templateApply") : undefined;
let s: TemplateServer;

beforeAll(async () => {
  s = await templateServer();
});
afterAll(async () => {
  await s.close();
});

describe("project templates with Field", () => {
  it.skipIf(!handlers?.forms)("creates the form templates of the Turkish construction template", async () => {
    const r = await s.create({ code: "FLD", name: "Field", templateId: "iso19650-yapim-tr", slotCompanies: s.slotCompanies, language: "tr" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const forms = (r.body.parts as { part: string; status: string; count?: number }[]).find((p) => p.part === "forms")!;
    expect(forms).toMatchObject({ status: "partial", count: 4 });
    const table = moduleTable<any>("field", "formTemplates")!;
    const rows = (await s.handle.db.select().from(table).where(eq(table.projectId, r.body.id))) as { code: string; name: string; workflowTemplateId: string | null }[];
    expect(rows.map((x) => x.code).sort()).toEqual(["AYF", "DTF", "GR", "MTL"]);
    const flows = await s.handle.db.select().from(workflowTemplates).where(eq(workflowTemplates.projectId, r.body.id));
    const dtf = rows.find((x) => x.code === "DTF")!;
    expect(flows.find((w) => w.id === dtf.workflowTemplateId)!.name).toBe("Değişiklik talebi (DTF): Müşavir → İdare");
    expect(rows.find((x) => x.code === "GR")!.workflowTemplateId).toBeNull();
    // Creating it again in another project works; codes are per project.
    const again = await s.create({ code: "FLD2", name: "Field 2", templateId: "iso19650-yapim-tr", slotCompanies: s.slotCompanies });
    expect(again.status).toBe(200);
  });
});
