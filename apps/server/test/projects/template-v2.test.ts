// Project template format v2 (docs/features/PROJECT_TEMPLATES.md): the ISO 19650 construction
// templates, per-language values, project roles, issue types, transmittal settings and the
// module hook (`manage.templateApply`, `field.templateApply`) that applies RFI, submittal, meeting
// and form settings, or skips them without the module.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { checkProjectTemplate, localizeTemplate, type TemplatePartReportDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { moduleIds } from "../../src/app/module-ids.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { folders, namingStandards, projectRoles, users, workTypes, workflowTemplates } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { builtInTemplates, parseProjectTemplate } from "../../src/projects/project-templates.js";
import { capability, provideCapability, type TemplateApplyContext } from "../../src/sdk/capabilities.js";
import { patchWorkType } from "../../src/works/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, "../../templates");
let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-tpl2-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string, language?: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const headers: Record<string, string> = { cookie };
    if (language) headers["accept-language"] = language;
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p?: unknown) => call("POST", u, p ?? {}) };
}
type Api = ReturnType<typeof api>;

const raw = (id: string) => JSON.parse(readFileSync(path.join(templatesDir, `${id}.json`), "utf8")) as Record<string, unknown>;
const partsOf = (body: { parts: TemplatePartReportDto[] }) => Object.fromEntries(body.parts.map((p) => [p.part, p]));
const MODULE_PARTS = ["rfi", "submittals", "meetings", "forms"] as const;
const moduleOf = { rfi: "manage", submittals: "manage", meetings: "manage", forms: "field" } as const;
/** The installed module applies the part (a module version with the handler). */
const handled = (part: (typeof MODULE_PARTS)[number]) =>
  !!(capability(`${moduleOf[part]}.templateApply`) as Record<string, unknown> | undefined)?.[part];

let admin: Api;
const co: Record<string, string> = {};
let slotCompanies: Record<string, string>;

describe("ISO19650-2 5.1.2-5.1.6 / 5.3 / 5.4 information requirements, BEP and standards: ISO 19650 construction templates (format v2)", () => {
  it("sets up companies", async () => {
    admin = api(await login("admin@7d.test"));
    for (const name of ["Client Co", "Consult Co", "Design Co", "Build Co"]) co[name] = (await admin.post("/companies", { name })).body.id;
    slotCompanies = { idare: co["Client Co"]!, musavir: co["Consult Co"]!, tasarimci: co["Design Co"]!, yuklenici: co["Build Co"]! };
  });

  it("is generated from its single source (templates/src/iso19650-yapim.mjs --check)", () => {
    execFileSync(process.execPath, [path.join(templatesDir, "src/iso19650-yapim.mjs"), "--check"], { stdio: "pipe" });
  });

  it("parses and checks in both languages, with the cde block and every v2 part", () => {
    for (const id of ["iso19650-yapim-tr", "iso19650-yapim-en"]) {
      for (const lang of ["tr", "en"]) {
        const t = parseProjectTemplate(localizeTemplate(raw(id), lang));
        expect(checkProjectTemplate(t, {}, lang), `${id} ${lang}`).toEqual([]);
        expect(t.format).toBe("7d-cde/project-template@2");
        expect(t.family).toBe("iso19650-yapim");
        expect(t.cde).toMatchObject({ codeScheme: "iso_uk_na", enforceTransitions: true, wipPolicy: "team_only", adminSeesWip: true });
        expect(t.cde!.taskTeams!.map((x) => x.slot).sort()).toEqual(["idare", "musavir", "tasarimci", "yuklenici"]);
        expect(t.cde!.taskTeams!.find((x) => x.lead)?.slot).toBe("yuklenici");
        expect(t.namingStandards!.map((n) => n.name)).toContain(t.cde!.containerStandard);
        for (const part of ["roles", "issues", "transmittal", "rfi", "submittals", "meetings", "forms"] as const) expect(t[part], part).toBeTruthy();
      }
    }
  });

  it("lists template names in the project language", async () => {
    const en = (await admin.get("/templates?language=en")).body as { id: string; name: string; language?: string; family?: string; parts: string[] }[];
    const tr = (await admin.get("/templates?language=tr")).body as typeof en;
    const pick = (list: typeof en, id: string) => list.find((t) => t.id === id)!;
    expect(pick(en, "iso19650-yapim-en").name).toBe("ISO 19650 Construction Project (multi-party, English names)");
    expect(pick(tr, "iso19650-yapim-en").name).toBe("ISO 19650 Yapım Projesi (çok taraflı, İngilizce adlarla)");
    expect(pick(tr, "iso19650-yapim-tr").name).toBe("ISO 19650 Yapım Projesi (çok taraflı, Türkçe adlarla)");
    expect(pick(en, "iso19650-temel").name).toBe("ISO 19650 Basic");
    expect(pick(tr, "iso19650-temel").name).toBe("ISO 19650 Temel");
    expect(pick(en, "iso19650-yapim-tr")).toMatchObject({ language: "tr", family: "iso19650-yapim" });
    expect(pick(en, "iso19650-yapim-en").parts).toEqual(["roles", "issues", "transmittal", "rfi", "submittals", "meetings", "forms"]);
    expect(pick(en, "metro-ibb").parts).toEqual([]);
    // Without ?language= the requester's language decides.
    const viaHeader = (await api((await login("admin@7d.test")), "tr").get("/templates")).body as typeof en;
    expect(pick(viaHeader, "iso19650-temel").name).toBe("ISO 19650 Temel");
  });

  it("previews which parts this server applies", async () => {
    const p = await admin.post("/templates/preview", { templateId: "iso19650-yapim-en", code: "PRV", slotCompanies });
    expect(p.status).toBe(200);
    expect(p.body.errors).toEqual([]);
    const parts = Object.fromEntries((p.body.parts as { part: string; available: boolean; module: string | null }[]).map((x) => [x.part, x]));
    expect(parts.roles).toMatchObject({ module: null, available: true });
    expect(parts.transmittal).toMatchObject({ module: null, available: true });
    expect(parts.rfi).toMatchObject({ module: "manage", available: handled("rfi") });
    expect(parts.forms).toMatchObject({ module: "field", available: handled("forms") });
  });

  let en: { id: string; rootFolderId: string; parts: TemplatePartReportDto[]; issueTypes?: unknown[] };

  it("creates a project from the English template: ISO 19650 rules, teams, roles, issue types, transmittal", async () => {
    const r = await admin.post("/projects/from-template", { code: "ISOEN2", name: "Construction EN", templateId: "iso19650-yapim-en", slotCompanies, language: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.warnings).toEqual([]);
    en = r.body;
    const pid = en.id;
    // CDE settings (D-7 transitions, team-only WIP, archive, document code standard).
    const s = (await admin.get(`/projects/${pid}/cde/settings`)).body;
    expect(s).toMatchObject({ enforceTransitions: true, codeScheme: "iso_uk_na", wipPolicy: "team_only", adminSeesWip: true });
    const stds = await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, pid));
    expect(stds.find((n) => n.id === s.containerStandardId)!.definition.name).toBe("ISO 19650 Document Naming");
    const [archive] = await handle.db.select().from(folders).where(eq(folders.id, s.archiveFolderId));
    expect(archive!.name).toBe("40-ARCHIVED");
    const wfs = await handle.db.select().from(workflowTemplates).where(eq(workflowTemplates.projectId, pid));
    expect(wfs).toHaveLength(8);
    const approval = wfs.find((w) => w.name.startsWith("Approval:"))!;
    expect(s.transitions.map((t: { fromState: string | null; toState: string; mode: string; workflowTemplateId: string | null }) => [t.fromState, t.toState, t.mode, t.workflowTemplateId])).toEqual([
      [null, "wip", "direct", null],
      ["wip", "shared", "review", null],
      ["shared", "wip", "auto", null],
      ["shared", "published", "review", approval.id],
      ["published", "archived", "auto", null],
    ]);
    // One task team per party; the contractor's team leads.
    const roles = await handle.db.select().from(projectRoles).where(eq(projectRoles.projectId, pid));
    const teams = roles.filter((x) => x.kind === "task_team");
    expect(teams.map((x) => x.companyId).sort()).toEqual([...Object.values(slotCompanies)].sort());
    expect(teams.find((x) => x.isLead)!.companyId).toBe(co["Build Co"]);
    expect(teams.find((x) => x.companyId === co["Build Co"])!.code).toBe("CTR");
    // Template roles (kind "role") besides the default ones.
    const templateRoles = roles.filter((x) => x.kind === "role" && !["Görüntüleyici", "Düzenleyici", "Yönetici"].includes(x.name));
    expect(templateRoles.map((x) => x.name)).toContain("Contractor - Checker");
    expect(templateRoles.map((x) => x.name)).toContain("Information Manager");
    expect(templateRoles).toHaveLength(11);
    expect(templateRoles.find((x) => x.name === "Client - Watcher")!.description).toBe("Client / Appointing party");
    // WIP folders belong to the party's task team.
    const wipTop = await handle.db.select().from(folders).where(and(eq(folders.projectId, pid), eq(folders.name, "10-WORK IN PROGRESS (WIP)")));
    const wipChildren = await handle.db.select().from(folders).where(eq(folders.parentId, wipTop[0]!.id));
    const contractorWip = wipChildren.find((f) => f.name === "Contractor")!;
    expect(contractorWip.ownerTeamId).toBe(teams.find((x) => x.companyId === co["Build Co"])!.id);
    // Issue types on the project, transmittal numbering on its work type.
    const project = (await admin.get(`/projects/${pid}`)).body;
    expect(project.issueTypes.map((g: { category: string }) => g.category)).toEqual([
      "Design coordination",
      "Site observation",
      "Quality",
      "HSE",
      "Testing and commissioning",
    ]);
    const [transmittal] = await handle.db.select().from(workTypes).where(and(eq(workTypes.projectId, pid), eq(workTypes.key, "transmittal")));
    expect(transmittal!.numberingPattern).toBe("{Proje}-{Gönderen}-{Alıcı}-TRN-{0000}");
    // Report: core parts applied, module parts skipped without the modules (no failure).
    const parts = partsOf(en);
    expect(parts.roles).toMatchObject({ module: null, status: "applied", count: 11 });
    expect(parts.issues).toMatchObject({ status: "partial", count: 13 });
    expect(parts.transmittal).toMatchObject({ status: "partial", count: 1 });
    for (const part of MODULE_PARTS) {
      if (handled(part)) {
        expect(["applied", "partial"], part).toContain(parts[part]!.status);
        continue;
      }
      const reason = moduleIds().includes(moduleOf[part]) ? "unsupported" : "module_not_installed";
      expect(parts[part], part).toMatchObject({ module: moduleOf[part], status: "skipped", reason });
    }
  });

  it("provides folders for the information requirements, the BEP and delivery plans, and the standards (ISO-8, ISO-14)", async () => {
    const pid = en.id;
    const [general] = await handle.db.select().from(folders).where(and(eq(folders.projectId, pid), eq(folders.name, "00-GENERAL")));
    const names = (await handle.db.select().from(folders).where(eq(folders.parentId, general!.id))).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "02-Information Requirements (OIR, AIR, PIR, EIR)",
        "03-BIM Execution Plan and Delivery Plans (BEP, MIDP, TIDP)",
        "04-Standards and Templates",
      ]),
    );
    const tr = parseProjectTemplate(localizeTemplate(raw("iso19650-yapim-tr"), "tr"));
    const trGeneral = tr.folders.find((f) => typeof f !== "string" && f.name === "00-GENEL") as { children: (string | { name: string })[] };
    expect(trGeneral.children.map((c) => (typeof c === "string" ? c : c.name))).toEqual(
      expect.arrayContaining(["02-Bilgi Gereksinimleri (OIR, AIR, PIR, EIR)", "03-BIM Uygulama Planı ve Teslim Planları (BEP, MIDP, TIDP)", "04-Standartlar ve Şablonlar"]),
    );
  });

  it("materializes on-demand folders of the English template", async () => {
    const pid = en.id;
    const [shared] = await handle.db.select().from(folders).where(and(eq(folders.projectId, pid), eq(folders.name, "20-SHARED")));
    const forReview = (await handle.db.select().from(folders).where(eq(folders.parentId, shared!.id))).find((f) => f.name === "01-For Review")!;
    const m = await admin.post(`/projects/${pid}/folders/${forReview.id}/materialize`, { path: ["A"] });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.created).toEqual(["A"]);
    expect(m.body.folder.name).toBe("A");
  });

  it("creates a project from the Turkish template with Turkish names and 3-letter disciplines", async () => {
    const r = await admin.post("/projects/from-template", { code: "ISOTR2", name: "Yapım TR", templateId: "iso19650-yapim-tr", slotCompanies, language: "tr" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pid = r.body.id;
    const std = (await admin.get(`/projects/${pid}/naming-standards`)).body.find((n: { definition: { name: string } }) => n.definition.name === "ISO 19650 Doküman Kodlama").definition;
    expect(std.fields[5].values.map((v: { code: string }) => v.code)).toContain("MIM");
    expect(std.fields[1].values.map((v: { code: string }) => v.code)).toEqual(["IDR", "MSV", "TSR", "YKL"]);
    const roles = await handle.db.select().from(projectRoles).where(eq(projectRoles.projectId, pid));
    expect(roles.map((x) => x.name)).toContain("Yüklenici - Kontrol");
    const s = (await admin.get(`/projects/${pid}/cde/settings`)).body;
    const [archive] = await handle.db.select().from(folders).where(eq(folders.id, s.archiveFolderId));
    expect(archive!.name).toBe("40-ARŞİV (Archived)");
  });
});

describe("template format v2: per-language values, project roles, module switches", () => {
  const custom = () => ({
    format: "7d-cde/project-template@2",
    name: { tr: "Deneme Şablonu", en: "Trial Template" },
    slots: [{ key: "a", label: { tr: "Yüklenici", en: "Contractor" } }],
    folders: [{ name: { tr: "Çalışma", en: "Work" }, state: "wip" }],
    roles: [{ key: "chk", name: { tr: "Kontrolcü", en: "Checker" }, slot: "a" }],
    workflows: [{ name: "Check", steps: [{ name: "Check", assignees: [{ projectRole: "chk" }], rule: "any", days: 2, outcomes: ["approved", "rejected"] }] }],
    issues: { categories: [{ category: { tr: "Kalite", en: "Quality" }, types: [{ tr: "Uygunsuzluk", en: "Non-conformance" }] }] },
    rfi: { types: [{ code: "A", name: "A - Architect" }], responseDays: 5 },
    modules: { rfi: false },
  });

  it("resolves per-language values with the project language", async () => {
    const tr = await admin.post("/templates/preview", { template: custom(), code: "X", language: "tr" });
    expect(tr.body).toMatchObject({ ok: true, name: "Deneme Şablonu" });
    expect(tr.body.slots[0].label).toBe("Yüklenici");
    expect(tr.body.tree[0].name).toBe("Çalışma");
    const en = await admin.post("/templates/preview", { template: custom(), code: "X", language: "en" });
    expect(en.body).toMatchObject({ ok: true, name: "Trial Template" });
    expect(en.body.tree[0].name).toBe("Work");
  });

  it("creates project roles first and assigns workflow steps to them; an off module skips its part", async () => {
    const r = await admin.post("/projects/from-template", { template: custom(), code: "V2A", name: "V2", language: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pid = r.body.id;
    const [role] = await handle.db.select().from(projectRoles).where(and(eq(projectRoles.projectId, pid), eq(projectRoles.name, "Checker")));
    expect(role!.description).toBe("Contractor");
    const [wf] = await handle.db.select().from(workflowTemplates).where(eq(workflowTemplates.projectId, pid));
    expect(wf!.steps[0]!.assignees).toEqual([{ type: "role", id: role!.id }]);
    expect(r.body.issueTypes).toEqual([{ category: "Quality", types: ["Non-conformance"] }]);
    expect(partsOf(r.body).rfi).toMatchObject({ status: "skipped", reason: "module_off" });
    // Export keeps the role and the assignment.
    const e = (await admin.get(`/projects/${pid}/export-template`)).body;
    expect(e.roles).toEqual([{ key: "checker", name: "Checker", description: "Contractor" }]);
    expect(e.workflows[0].steps[0].assignees).toEqual([{ projectRole: "checker" }]);
    const again = await admin.post("/projects/from-template", { template: e, code: "V2B", name: "V2 again" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it("refuses unknown project roles, slots and workflows in v2 parts", async () => {
    const t = custom() as Record<string, any>;
    t.workflows[0].steps[0].assignees = [{ projectRole: "nope" }];
    t.forms = [{ key: "F", name: "Form", workflow: "Missing", sections: [{ name: "S", editor: "ghost" }] }];
    t.cde = { containerStandard: "No Such Standard", taskTeams: [{ slot: "zz" }] };
    const p = await admin.post("/templates/preview", { template: t, code: "X", language: "en" });
    expect(p.body.ok).toBe(false);
    const text = p.body.errors.join("\n");
    expect(text).toContain("nope");
    expect(text).toContain("Missing");
    expect(text).toContain("ghost");
    expect(text).toContain("No Such Standard");
    expect(text).toContain("zz");
  });
});

describe("patchWorkType (SDK): work type settings from a template", () => {
  it("sets list options, settings, the number pattern and the default workflow; reports what it cannot apply", async () => {
    const r = await admin.post("/projects", { code: "PWT", name: "Patch", template: "empty" });
    const pid = r.body.id as string;
    const ok = await patchWorkType(handle.db, pid, "rfi", {
      fieldOptions: { disiplin: ["A - Architect", "S - Structural", "A - Architect"], nope: ["x"] },
      settings: { dueDays: 5 },
      numberingPattern: "{Proje}-RFI-{Disiplin}-{0000}",
    });
    expect(ok).toEqual({ found: true, changed: true, problems: ["nope"] });
    const [rfi] = await handle.db.select().from(workTypes).where(and(eq(workTypes.projectId, pid), eq(workTypes.key, "rfi")));
    expect(rfi!.fields.find((f) => f.key === "disiplin")!.options).toEqual(["A - Architect", "S - Structural"]);
    expect(rfi!.settings.dueDays).toBe(5);
    expect(rfi!.numberingPattern).toBe("{Proje}-RFI-{Disiplin}-{0000}");
    const bad = await patchWorkType(handle.db, pid, "rfi", { numberingPattern: "{Proje}-{Nope}" }, "en");
    expect(bad.changed).toBe(false);
    expect(bad.problems).toHaveLength(1);
    expect(await patchWorkType(handle.db, pid, "no-such-type", { name: "x" })).toEqual({ found: false, changed: false, problems: [] });
  });
});

describe("anonymised demo template (Bina, veri merkezi tipi)", () => {
  it("carries invented company codes only", () => {
    const text = JSON.stringify(raw("bina-veri-merkezi"));
    expect(text).not.toMatch(/\b(PAS|CNS|HLL|ZRT|ZAVM)\b/);
    expect(text).not.toMatch(/Poyraz|Çınar|Hilal|Zirve/);
    const t = builtInTemplates("tr").get("bina-veri-merkezi")!;
    expect(t.slots.map((s) => s.code)).toEqual(["KYA", "ATL", "MRT", "VDT"]);
    expect(builtInTemplates("en").get("bina-veri-merkezi")!.name).toBe("Building (data-centre type)");
  });
});

// Last: the fake module handlers stay registered for the rest of this file.
describe("module hook: manage.templateApply and field.templateApply", () => {
  it("hands the module parts to the modules with the project context and reports each one", async () => {
    const seen: Record<string, { ctx: TemplateApplyContext; value: unknown }> = {};
    provideCapability("manage.templateApply", {
      rfi: async (ctx, value) => {
        seen.rfi = { ctx, value };
        return { status: "applied", count: value.types?.length ?? 0 };
      },
      meetings: async () => {
        throw new Error("meeting store down");
      },
    });
    provideCapability("field.templateApply", {
      forms: async (ctx, value) => {
        seen.forms = { ctx, value };
        return { status: "partial", count: value.length, notes: ["editors are not enforced"] };
      },
    });
    const r = await admin.post("/projects/from-template", { code: "HOOK", name: "Hook", templateId: "iso19650-yapim-en", slotCompanies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parts = partsOf(r.body);
    expect(parts.rfi).toMatchObject({ module: "manage", status: "applied", count: 12 });
    expect(parts.submittals).toMatchObject({ module: "manage", status: "skipped", reason: "unsupported" });
    expect(parts.meetings).toMatchObject({ module: "manage", status: "failed", reason: "error", notes: ["meeting store down"] });
    expect(parts.forms).toMatchObject({ module: "field", status: "partial", count: 4, notes: ["editors are not enforced"] });
    // The project stays; the context names what the core created.
    const ctx = seen.rfi!.ctx;
    expect(ctx.projectId).toBe(r.body.id);
    expect(ctx.projectCode).toBe("HOOK");
    expect(ctx.language).toBe("tr"); // the requester's language (tests run in Turkish)
    expect(ctx.slots.get("musavir")).toMatchObject({ companyId: co["Consult Co"], code: "CON" });
    expect(ctx.workflowIds.get((seen.rfi!.value as { workflow: string }).workflow)).toBeTruthy();
    expect(ctx.roleIds.get("idare-gozlemci")).toBeTruthy();
    expect(ctx.folderIds.get("00-GENERAL/06-Meeting Minutes/01-Client")).toBeTruthy();
    const forms = seen.forms!.value as { key: string; workflow?: string }[];
    expect(forms.map((f) => f.key)).toEqual(["DTF", "AYF", "EIN", "DR"]);
    expect(seen.forms!.ctx.workflowIds.get(forms[0]!.workflow!)).toBeTruthy();
    // Preview now reports the parts with a handler as available.
    const p = await admin.post("/templates/preview", { templateId: "iso19650-yapim-en", code: "PRV2", slotCompanies });
    const avail = Object.fromEntries((p.body.parts as { part: string; available: boolean }[]).map((x) => [x.part, x.available]));
    expect(avail).toMatchObject({ rfi: true, submittals: false, meetings: true, forms: true });
  });
});
