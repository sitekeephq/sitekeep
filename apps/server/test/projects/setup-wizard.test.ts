// Project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md): the dry run and project creation
// with the wizard's choices on top of a template: parties, task teams and lead, folders, naming
// codes, approvers, code profile, ISO 19650 enforcement, WIP policy, people, details.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  applySetupOverrides,
  checkProjectSetup,
  isGroupAddress,
  type ProjectSetupOverrides,
  type TemplatePartReportDto,
} from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { folders, namingStandards, projects, users, workflowTemplates } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { builtInTemplates } from "../../src/projects/project-templates.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-setup-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash, isAdmin: true },
    { email: "member@7d.test", name: "Member", passwordHash },
    { email: "designer@7d.test", name: "Dana Designer", passwordHash },
    { email: "info@7d.test", name: "Info Box", passwordHash },
  ]);
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

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p?: unknown) => call("POST", u, p ?? {}) };
}
type Api = ReturnType<typeof api>;

const TEMPLATE = "iso19650-yapim-en";
const APPROVAL = "Approval: Consultant + Designer → Client acceptance → Publish";
const DESIGNER_CHECK = "Designer internal check → share for approval";
let admin: Api;
const co: Record<string, string> = {};
let slotCompanies: Record<string, string>;
const partsOf = (body: { parts: TemplatePartReportDto[] }) => Object.fromEntries(body.parts.map((p) => [p.part, p]));

/** The choices of a full wizard run. */
function fullSetup(): ProjectSetupOverrides {
  return {
    parties: [{ key: "teknik", label: "Client technical unit", party: "client", code: "CTU" }],
    taskTeams: [{ slot: "idare" }, { slot: "musavir" }, { slot: "tasarimci", lead: true }, { slot: "yuklenici" }, { slot: "teknik" }],
    folders: {
      add: [{ parent: "00-GENERAL", name: "09-Photographs" }, { parent: "10-WORK IN PROGRESS (WIP)", name: "Client technical unit" }],
      remove: ["00-GENERAL/08-Site Handover Records"],
    },
    containerStandard: "ISO 19650 Document Naming",
    naming: [{ standard: "ISO 19650 Document Naming", field: "Volume", values: [{ code: "ZZ", description: "All" }, { code: "B1", description: "Block 1" }] }],
    workflows: [
      { workflow: DESIGNER_CHECK, step: 2, assignees: [{ projectRole: "tasarimci-yetki" }], days: 3 },
      { workflow: APPROVAL, step: 1, assignees: [{ slot: "idare" }, { slot: "teknik" }], rule: "all" },
    ],
    transitions: [{ from: "wip", to: "shared", workflow: DESIGNER_CHECK }],
    cde: { codeScheme: "legacy_r", enforceTransitions: true, wipPolicy: "team_only", adminSeesWip: false },
    modules: { meetings: false },
  };
}

describe("project set-up wizard: shared checks", () => {
  const template = () => builtInTemplates("en").get(TEMPLATE)!;

  it("applies the choices to a copy of the template", () => {
    const source = template();
    const { template: out, errors } = applySetupOverrides(source, fullSetup(), "en");
    expect(errors).toEqual([]);
    expect(out.slots.map((s) => s.key)).toContain("teknik");
    expect(source.slots.map((s) => s.key)).not.toContain("teknik");
    expect(out.cde).toMatchObject({ codeScheme: "legacy_r", wipPolicy: "team_only", adminSeesWip: false });
    expect(out.cde!.taskTeams!.find((t) => t.lead)?.slot).toBe("tasarimci");
    expect(out.cde!.transitions!.find((t) => t.from === "wip" && t.to === "shared")?.workflow).toBe(DESIGNER_CHECK);
    expect(out.modules?.meetings).toBe(false);
    expect(checkProjectSetup(source, { setup: fullSetup() }, "en").errors).toEqual([]);
  });

  it("refuses choices outside the limits", () => {
    const { errors } = applySetupOverrides(
      template(),
      {
        parties: [{ key: "idare", label: "Again" }],
        taskTeams: [{ slot: "idare", lead: true }, { slot: "yuklenici", lead: true }],
        folders: { remove: ["20-SHARED", "00-GENERAL/06-Meeting Minutes", "nope"], add: [{ parent: "00-GENERAL", name: "a/b" }] },
        naming: [{ standard: "ISO 19650 Document Naming", field: "Number", values: [{ code: "1" }] }],
        workflows: [{ workflow: APPROVAL, step: 9, days: 1 }],
        transitions: [{ from: "shared", to: "wip", workflow: APPROVAL }],
      },
      "en",
    );
    expect(errors).toEqual([
      'Party key "idare" is already used by the template.',
      "Only one task team can be the lead appointed party.",
      '"20-SHARED" carries an ISO 19650 state or generated folders and cannot be left out.',
      '"00-GENERAL/06-Meeting Minutes" is used by the template (archive, review copy target or meeting minutes) and cannot be left out.',
      'Folder "nope" is not in the template.',
      expect.stringContaining('Folder name "a/b" is invalid'),
      'Field "Number" is not a list; only list codes can be changed here.',
      `Workflow "${APPROVAL}" has no step 10.`,
      "Transition shared>wip is not made through a review; only review transitions take a workflow.",
    ]);
    // References the choices create are checked by checkProjectTemplate.
    const check = checkProjectSetup(template(), { setup: { taskTeams: [{ slot: "ghost" }] }, details: { startDate: "2026-12-01", endDate: "2026-01-01" } }, "en");
    expect(check.errors).toEqual(expect.arrayContaining([expect.stringContaining('"ghost"'), "The end date is before the start date."]));
  });

  it("recognises shared mailboxes", () => {
    expect(isGroupAddress("info@firm.com")).toBe(true);
    expect(isGroupAddress("noreply2@firm.com")).toBe(true);
    expect(isGroupAddress("ayse.yilmaz@firm.com")).toBe(false);
  });
});

describe("project set-up wizard: dry run and creation", () => {
  it("sets up companies", async () => {
    admin = api(await login("admin@7d.test"));
    for (const name of ["Client Co", "Consult Co", "Design Co", "Build Co", "Tech Unit Co"]) co[name] = (await admin.post("/companies", { name })).body.id;
    slotCompanies = { idare: co["Client Co"]!, musavir: co["Consult Co"]!, tasarimci: co["Design Co"]!, yuklenici: co["Build Co"]!, teknik: co["Tech Unit Co"]! };
  });

  it("dry run: the preview with the choices, the project code and the people's accounts; system administrators only", async () => {
    const body = {
      templateId: TEMPLATE,
      language: "en",
      code: "WIZ1",
      slotCompanies,
      setup: fullSetup(),
      people: [{ email: "member@7d.test", slot: "yuklenici" }, { email: "nobody@7d.test" }, { email: "info@7d.test" }],
    };
    const dry = await admin.post("/projects/setup/preview", body);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.ok).toBe(true);
    expect(dry.body.slots.map((s: { key: string }) => s.key)).toContain("teknik");
    expect(dry.body.people).toEqual([
      { email: "member@7d.test", status: "added", userId: expect.any(String), name: "Member" },
      { email: "nobody@7d.test", status: "no_account" },
      { email: "info@7d.test", status: "group_address" },
    ]);
    expect(dry.body.warnings).toEqual(expect.arrayContaining([expect.stringContaining("nobody@7d.test has no SiteKeep account")]));
    const general = dry.body.tree.find((f: { name: string }) => f.name === "00-GENERAL");
    expect(general.children.map((f: { name: string }) => f.name)).toContain("09-Photographs");
    expect(general.children.map((f: { name: string }) => f.name)).not.toContain("08-Site Handover Records");
    expect(await handle.db.select().from(projects).where(eq(projects.code, "WIZ1"))).toEqual([]);

    const member = api(await login("member@7d.test"));
    expect((await member.post("/projects/setup/preview", body)).status).toBe(403);
    expect((await member.post("/projects/from-template", { ...body, name: "No" })).status).toBe(403);
  });

  it("refuses invalid choices with the template's checks and creates nothing", async () => {
    const res = await admin.post("/projects/from-template", {
      templateId: TEMPLATE,
      language: "en",
      code: "WIZBAD",
      name: "Bad",
      slotCompanies,
      setup: {
        taskTeams: [{ slot: "ghost", lead: true }],
        workflows: [{ workflow: APPROVAL, step: 0, assignees: [{ projectRole: "nobody" }] }],
        folders: { remove: ["30-PUBLISHED"] },
      },
      details: { startDate: "2026-13-40" },
      people: [{ email: "member@7d.test", roles: ["no-such-role"] }],
    });
    expect(res.status).toBe(400);
    const text = (res.body.details as string[]).join("\n");
    for (const part of ['"ghost"', '"nobody"', "30-PUBLISHED", "2026-13-40", "no-such-role"]) expect(text).toContain(part);
    expect(await handle.db.select().from(projects).where(eq(projects.code, "WIZBAD"))).toEqual([]);
    // A taken project code is reported by the dry run.
    const { teknik: _, ...templateSlots } = slotCompanies;
    expect((await admin.post("/projects/from-template", { templateId: TEMPLATE, language: "en", code: "WIZTAKEN", name: "Taken", slotCompanies: templateSlots })).status).toBe(200);
    const dry = await admin.post("/projects/setup/preview", { templateId: TEMPLATE, language: "en", code: "WIZTAKEN", slotCompanies: templateSlots });
    expect(dry.body.ok).toBe(false);
    expect(dry.body.errors).toContain("Project code WIZTAKEN is already used by another project.");
  });

  it("creates the project with the choices: teams from parties with the lead, folders, codes, approvers, ISO rules, people", async () => {
    const res = await admin.post("/projects/from-template", {
      templateId: TEMPLATE,
      language: "en",
      code: "WIZ1",
      name: "Wizard Project",
      slotCompanies,
      setup: fullSetup(),
      details: { startDate: "2026-12-01", endDate: "2028-06-30", location: "Istanbul", client: "Client Co" },
      people: [
        { email: "member@7d.test", slot: "yuklenici" },
        { email: "designer@7d.test", slot: "tasarimci", roles: ["tasarimci-yetki"], projectAdmin: false },
        { email: "nobody@7d.test" },
        { email: "info@7d.test" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pid = res.body.id as string;
    expect(res.body.details).toEqual({ startDate: "2026-12-01", endDate: "2028-06-30", location: "Istanbul", client: "Client Co" });
    expect(res.body.people.map((p: { status: string }) => p.status)).toEqual(["added", "added", "no_account", "group_address"]);

    // Parts: core applied, meetings switched off by the wizard, other module parts skipped or applied.
    const parts = partsOf(res.body);
    expect(parts.roles?.status).toBe("applied");
    expect(parts.meetings).toMatchObject({ status: "skipped", reason: "module_off" });
    for (const part of ["rfi", "submittals", "forms"]) expect(parts[part]?.status, part).not.toBe("failed");
    expect(res.body.modules.meetings).toBe(false);

    // Task teams: one per party with a company (the added party too), the designer's team leads.
    const roles = (await admin.get(`/projects/${pid}/roles`)).body as { id: string; name: string; kind: string; companyId: string | null; isLead: boolean; code: string | null }[];
    const teams = roles.filter((r) => r.kind === "task_team");
    for (const id of Object.values(slotCompanies)) expect(teams.some((t) => t.companyId === id), id).toBe(true);
    expect(teams.filter((t) => t.isLead).map((t) => t.companyId)).toEqual([co["Design Co"]]);
    expect(teams.find((t) => t.companyId === co["Tech Unit Co"])?.code).toBe("CTU");

    // People: in the company of their party, in its team, with their project roles.
    const members = (await admin.get(`/projects/${pid}/members`)).body as { email: string; companyId: string; roleIds: string[]; isProjectAdmin: boolean }[];
    const designer = members.find((m) => m.email === "designer@7d.test")!;
    expect(designer.companyId).toBe(co["Design Co"]);
    expect(designer.roleIds).toContain(roles.find((r) => r.name === "Designer - Authorizer")!.id);
    expect(designer.roleIds).toContain(teams.find((t) => t.companyId === co["Design Co"])!.id);
    expect(members.find((m) => m.email === "member@7d.test")?.roleIds).toContain(teams.find((t) => t.companyId === co["Build Co"])!.id);
    expect(members.some((m) => m.email === "info@7d.test")).toBe(false);

    // ISO 19650 settings.
    const cde = (await admin.get(`/projects/${pid}/cde/settings`)).body;
    expect(cde).toMatchObject({ codeScheme: "legacy_r", enforceTransitions: true, wipPolicy: "team_only", adminSeesWip: false });
    const flows = await handle.db.select().from(workflowTemplates).where(eq(workflowTemplates.projectId, pid));
    const designerCheck = flows.find((w) => w.name === DESIGNER_CHECK)!;
    expect(cde.transitions.find((t: { fromState: string; toState: string }) => t.fromState === "wip" && t.toState === "shared").workflowTemplateId).toBe(designerCheck.id);
    const standards = await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, pid));
    const docCode = standards.find((s) => s.definition.name === "ISO 19650 Document Naming")!;
    expect(cde.containerStandardId).toBe(docCode.id);
    const volume = docCode.definition.fields.find((f) => f.name === "Volume")!;
    expect(volume.type === "list" && volume.values.map((v) => v.code)).toEqual(["ZZ", "B1"]);

    // Approvers: the authorize step goes to the project role, the acceptance to both client parties.
    const authorize = designerCheck.steps[2]!;
    expect(authorize.assignees).toEqual([{ type: "role", id: roles.find((r) => r.name === "Designer - Authorizer")!.id }]);
    expect(authorize.days).toBe(3);
    const acceptance = flows.find((w) => w.name === APPROVAL)!.steps[1]!;
    expect(acceptance.rule).toBe("all");
    expect(acceptance.assignees).toEqual([{ type: "company", id: co["Client Co"] }, { type: "company", id: co["Tech Unit Co"] }]);

    // Folders: added and left out.
    const names = (await handle.db.select({ name: folders.name }).from(folders).where(eq(folders.projectId, pid))).map((f) => f.name);
    expect(names).toContain("09-Photographs");
    expect(names).toContain("Client technical unit");
    expect(names).not.toContain("08-Site Handover Records");

    // The audit entry records the choices.
    const activity = (await admin.get(`/projects/${pid}/activity`)).body as { action: string; details: Record<string, unknown> }[];
    const created = activity.find((a) => a.action === "project.created_from_template")!;
    expect(created.details.setup).toMatchObject({ cde: { codeScheme: "legacy_r" } });
  });

  it("without choices a wizard request equals a template request (quick create)", async () => {
    const res = await admin.post("/projects/from-template", { templateId: TEMPLATE, language: "en", code: "WIZQ", name: "Quick" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.people).toEqual([]);
    const cde = (await admin.get(`/projects/${res.body.id}/cde/settings`)).body;
    expect(cde).toMatchObject({ codeScheme: "iso_uk_na", enforceTransitions: true, wipPolicy: "team_only", adminSeesWip: true });
  });
});
