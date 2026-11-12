/**
 * The simple project screen (docs/product/SIMPLIFICATION.md, 1. aşama): module switches, saved views,
 * project "Bugün" and user preferences.
 */
import { hasAi, hasField, hasManage } from "../helpers/modules.js"; // these steps use Field (forms)
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PROJECT_MODULES } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
// The AI module's internals load only when it is installed (a Community install has none).
const AI_ASSISTANT = "@7dimensions-project/sitekeep-ee-ai/internal/assistant.js";
const { buildAskTools, Refs, SHARED_ASK_TOOLS, TOOL_MODULES } = hasAi ? await import(AI_ASSISTANT) : ({} as Record<string, never>);
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { resolveModules } from "@sitekeep/shared";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-hub-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@hub.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
  };
}
type Client = ReturnType<typeof api>;

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let admin: Client, pm: Client, field: Client, other: Client;
const ids: Record<string, string> = {};
let pid: string, pid2: string;
const P = () => `/projects/${pid}`;

describe("simple screen: setup", () => {
  it("creates two projects, three companies and members", async () => {
    admin = api(await login("admin@hub.test"));
    for (const c of ["PAS", "CNS", "HLL"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    pid = (await admin.post("/projects", { code: "HUB", name: "Hub testi" })).body.id;
    pid2 = (await admin.post("/projects", { code: "HUB2", name: "Başka proje" })).body.id;
    for (const [key, company] of [
      ["pm", "PAS"],
      ["field", "PAS"],
      ["other", "HLL"],
    ] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@hub.test`, name: key.toUpperCase(), password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@hub.test`, isProjectAdmin: key === "pm" })).status).toBe(200);
      expect((await admin.post(`/projects/${pid2}/members`, { email: `${key}@hub.test` })).status).toBe(200);
    }
    pm = api(await login("pm@hub.test"));
    field = api(await login("field@hub.test"));
    other = api(await login("other@hub.test"));
  });
});

describe("module switches (Proje Ayarları → Modüller)", () => {
  let issueId: string;

  it.skipIf(!hasManage)("existing projects have every module on; the project DTO carries them", async () => {
    const p = await field.get(P());
    expect(p.body.modules).toEqual(resolveModules(null));
    expect(Object.values((await field.get(`${P()}/modules`)).body).every(Boolean)).toBe(true);
    issueId = (await field.post(`${P()}/issues`, { title: "Modül kapanmadan önce açılan sorun" })).body.id;
    expect(issueId).toBeTruthy();
  });

  it.skipIf(!hasManage)("only project administrators switch modules", async () => {
    expect((await field.put(`${P()}/modules`, { modules: { issues: false } })).status).toBe(403);
    expect((await pm.put(`${P()}/modules`, { modules: { nope: false } })).status).toBe(400);
    const r = await pm.put(`${P()}/modules`, { modules: { issues: false, submittals: false, forms: false, coordination: false, reports: false } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.issues).toBe(false);
    expect(r.body.correspondence).toBe(true);
    expect((await field.get(P())).body.modules.submittals).toBe(false);
  });

  it.skipIf(!hasField || !hasManage)("refuses new records of an off module with a Turkish message", async () => {
    const issue = await field.post(`${P()}/issues`, { title: "Yeni sorun" });
    expect(issue.status).toBe(403);
    expect(issue.body.error).toBe("module_disabled");
    expect(issue.body.message).toMatch(/^Sorun modülü bu projede kapalı; yeni kayıt oluşturulamaz/);

    const types = (await field.get(`${P()}/work-types`)).body as { id: string; key: string; category: string }[];
    const submittal = types.find((t) => t.key === "submittal-kalemi")!;
    const w = await field.post(`${P()}/works`, { typeId: submittal.id, title: "Kapı numunesi", fields: {} });
    expect(w.status).toBe(403);
    expect(w.body.message).toMatch(/^Teknik Onay modülü/);
    expect((await pm.post(`${P()}/reports`, { templateId: "issue-status" })).status).toBe(403);
    expect((await pm.post(`${P()}/model-sets`, { name: "Set", items: [] })).status).toBe(403);
    expect((await pm.post(`${P()}/forms`, { templateId: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);

    // Modules that are on keep working.
    const outgoing = types.find((t) => t.key === "giden-yazi")!;
    expect((await field.post(`${P()}/works`, { typeId: outgoing.id, title: "Yazı", toCompanyIds: [ids.CNS], fields: {} })).status).toBe(200);
  });

  it.skipIf(!hasManage)("keeps the data of an off module: existing records still open and update", async () => {
    const got = await field.get(`${P()}/issues/${issueId}`);
    expect(got.status).toBe(200);
    expect((await field.get(`${P()}/issues`)).body).toHaveLength(1);
    expect((await field.patch(`${P()}/issues/${issueId}`, { status: "in_progress" })).status).toBe(200);
  });

  it.skipIf(!hasManage || !hasAi)("filters lists: creatable work types, report catalog and the assistant's tools", async () => {
    const creatable = (await field.get(`${P()}/work-types?creatable=1`)).body as { key: string }[];
    expect(creatable.map((t) => t.key)).not.toContain("submittal-kalemi");
    expect(creatable.map((t) => t.key)).not.toContain("submittal-paketi");
    expect(creatable.map((t) => t.key)).toContain("giden-yazi");
    expect((await field.get(`${P()}/work-types`)).body.map((t: { key: string }) => t.key)).toContain("submittal-kalemi");

    // Reports off: nothing in the catalog. Reports on, issues off: no issue datasets or templates.
    let cat = (await field.get(`${P()}/reports/catalog`)).body;
    expect(cat.datasets).toEqual([]);
    expect(cat.templates).toEqual([]);
    await pm.put(`${P()}/modules`, { modules: { reports: true } });
    cat = (await field.get(`${P()}/reports/catalog`)).body;
    expect(cat.datasets.length).toBeGreaterThan(0);
    expect(cat.datasets.some((d: { module?: string }) => d.module === "issues")).toBe(false);
    expect(cat.datasets.some((d: { module?: string }) => d.module === "submittals")).toBe(false);
    expect(cat.datasets.some((d: { module?: string }) => d.module === "documents")).toBe(true);
    expect(cat.templates.some((t: { id: string }) => t.id === "issue-status")).toBe(false);
    expect(cat.modules.map((m: { key: string }) => m.key)).not.toContain("issues");

    const call = async () => {
      throw new Error("not called");
    };
    const all = buildAskTools({ call, projectId: pid, refs: new Refs(pid), today: day(0) }).map((t) => t.name);
    const some = buildAskTools({ call, projectId: pid, refs: new Refs(pid), today: day(0), modules: resolveModules({ issues: false, forms: false }) }).map(
      (t) => t.name,
    );
    expect(all).toContain("cde_issues_list");
    expect(some).not.toContain("cde_issues_list");
    expect(some).not.toContain("cde_issue_get");
    expect(some).not.toContain("cde_forms_list");
    expect(some).toContain("cde_works_list");
    expect(some).toContain("cde_project_overview");
    // Every module-bound tool exists in the shared tool list.
    for (const name of Object.keys(TOOL_MODULES)) expect(SHARED_ASK_TOOLS as readonly string[]).toContain(name);
  });

  it.skipIf(!hasManage)("a reply is checked against the module of the reply's own type", async () => {
    const types = (await other.get(`${P()}/work-types`)).body as { id: string; key: string }[];
    const letter = (await other.post(`${P()}/works`, { typeId: types.find((t) => t.key === "giden-yazi")!.id, title: "Cevaplanacak yazı", toCompanyIds: [ids.PAS], fields: {} })).body;
    expect((await other.post(`${P()}/works/${letter.id}/send`, { channel: "cde" })).status).toBe(200);
    await pm.put(`${P()}/modules`, { modules: { correspondence: false } });
    const refused = await field.post(`${P()}/works/${letter.id}/reply`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/^Yazışma modülü/);
    await pm.put(`${P()}/modules`, { modules: { correspondence: true } });
    expect((await field.post(`${P()}/works/${letter.id}/reply`, {})).status).toBe(200);
    // Received, so it does not show up in later "Bugün" checks.
    expect((await field.post(`${P()}/works/${letter.id}/receive`, {})).status).toBe(200);
  });

  it("turning a module back on allows new records again", async () => {
    await pm.put(`${P()}/modules`, { modules: { issues: true, submittals: true, forms: true, coordination: true } });
    expect((await field.post(`${P()}/issues`, { title: "Yeniden açık" })).status).toBe(200);
  });

  it.skipIf(!hasManage)("project templates set defaults: ISO 19650 generic is lean, Metro İBB and Veri Merkezi have everything", async () => {
    const iso = await admin.post("/projects/from-template", { code: "ISOM", name: "ISO", templateId: "iso19650-temel" });
    expect(iso.status, JSON.stringify(iso.body)).toBe(200);
    const m = (await admin.get(`/projects/${iso.body.id}/modules`)).body;
    expect(PROJECT_MODULES.filter((k) => m[k])).toEqual(["correspondence", "issues", "reviews", "reports"]);
    for (const [code, templateId] of [
      ["MET", "metro-ibb"],
      ["BVM", "bina-veri-merkezi"],
    ]) {
      const r = await admin.post("/projects/from-template", { code, name: templateId, templateId });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(Object.values((await admin.get(`/projects/${r.body.id}/modules`)).body).every(Boolean)).toBe(true);
    }
    // The exported template carries the switches of a lean project.
    const exported = (await admin.get(`/projects/${iso.body.id}/export-template`)).body;
    expect(exported.modules.rfi).toBe(false);
  });
});

describe("saved views", () => {
  let mineId: string, sharedId: string;

  it("creates, lists and keeps them per user per project", async () => {
    const a = await field.post(`${P()}/saved-views`, { name: "Geciken yazılar", view: "yazismalar", params: { termin: "overdue", gorunum: "x", q: "" } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ name: "Geciken yazılar", view: "yazismalar", params: { termin: "overdue" }, shared: false, mine: true, canEdit: true });
    mineId = a.body.id;
    const b = await field.post(`${P()}/saved-views`, { name: "Açık sorunlar", view: "sorunlar", params: { durum: "open" } });
    expect(b.body.position).toBe(1);
    expect((await field.get(`${P()}/saved-views`)).body.map((v: { name: string }) => v.name)).toEqual(["Geciken yazılar", "Açık sorunlar"]);
    // Other users and other projects do not see them.
    expect((await other.get(`${P()}/saved-views`)).body).toEqual([]);
    expect((await field.get(`/projects/${pid2}/saved-views`)).body).toEqual([]);
    expect((await other.patch(`${P()}/saved-views/${mineId}`, { name: "x" })).status).toBe(404);
    expect((await other.del(`${P()}/saved-views/${mineId}`)).status).toBe(404);
  });

  it("validates the view and its filters", async () => {
    expect((await field.post(`${P()}/saved-views`, { name: "x", view: "nope" })).status).toBe(400);
    expect((await field.post(`${P()}/saved-views`, { name: " ", view: "tum" })).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "v"]));
    expect((await field.post(`${P()}/saved-views`, { name: "x", view: "tum", params: many })).status).toBe(400);
  });

  it("renames, reorders and deletes own views", async () => {
    const r = await field.patch(`${P()}/saved-views/${mineId}`, { name: "Termini geçen yazılar", params: { termin: "overdue", acik: "1" } });
    expect(r.body).toMatchObject({ name: "Termini geçen yazılar", params: { termin: "overdue", acik: "1" } });
    const list = (await field.get(`${P()}/saved-views`)).body as { id: string }[];
    const order = await field.put(`${P()}/saved-views/order`, { ids: [list[1]!.id, list[0]!.id] });
    expect(order.status).toBe(200);
    expect((await field.get(`${P()}/saved-views`)).body.map((v: { id: string }) => v.id)).toEqual([list[1]!.id, list[0]!.id]);
    expect((await field.put(`${P()}/saved-views/order`, { ids: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await field.del(`${P()}/saved-views/${list[1]!.id}`)).status).toBe(200);
    expect((await field.get(`${P()}/saved-views`)).body).toHaveLength(1);
  });

  it("only project administrators share a view with the project", async () => {
    expect((await field.post(`${P()}/saved-views`, { name: "Herkese", view: "tum", shared: true })).status).toBe(403);
    expect((await field.patch(`${P()}/saved-views/${mineId}`, { shared: true })).status).toBe(403);
    const s = await pm.post(`${P()}/saved-views`, { name: "Proje geneli gecikenler", view: "tum", params: { termin: "overdue" }, shared: true });
    expect(s.status).toBe(200);
    sharedId = s.body.id;
    // Members see it after their own views, but cannot change or delete it.
    const seen = (await field.get(`${P()}/saved-views`)).body as { id: string; mine: boolean; canEdit: boolean; ownerName: string }[];
    expect(seen.map((v) => v.id)).toEqual([mineId, sharedId]);
    expect(seen[1]).toMatchObject({ mine: false, canEdit: false, ownerName: "PM" });
    expect((await other.get(`${P()}/saved-views`)).body.map((v: { id: string }) => v.id)).toEqual([sharedId]);
    expect((await field.patch(`${P()}/saved-views/${sharedId}`, { name: "x" })).status).toBe(403);
    expect((await field.del(`${P()}/saved-views/${sharedId}`)).status).toBe(403);
    // An administrator may rename or unshare it, not rewrite another person's filters.
    expect((await admin.patch(`${P()}/saved-views/${sharedId}`, { name: "Gecikenler (proje)" })).body.name).toBe("Gecikenler (proje)");
    expect((await admin.patch(`${P()}/saved-views/${sharedId}`, { params: { q: "x" } })).status).toBe(403);
    expect((await pm.patch(`${P()}/saved-views/${sharedId}`, { shared: false })).body.shared).toBe(false);
    expect((await field.get(`${P()}/saved-views`)).body.map((v: { id: string }) => v.id)).toEqual([mineId]);
  });
});

describe("project Bugün", () => {
  it.skipIf(!hasManage)("lists my items, overdue, upcoming and recent changes of this project only", async () => {
    const types = (await field.get(`${P()}/work-types`)).body as { id: string; key: string }[];
    const type = (k: string) => types.find((t) => t.key === k)!.id;
    const action = (await pm.post(`${P()}/works`, { typeId: type("aksiyon"), title: "Numuneleri getir", assigneeUserId: ids.field, dueDate: day(-1), fields: {} })).body;
    await pm.patch(`${P()}/works/${action.id}`, { status: "acik" });
    const soon = (await pm.post(`${P()}/works`, { typeId: type("aksiyon"), title: "Hesabı gönder", assigneeUserId: ids.field, dueDate: day(3), fields: {} })).body;
    await pm.patch(`${P()}/works/${soon.id}`, { status: "acik" });
    // Letter HLL → PAS with a reply expected: PAS members must answer.
    const letter = (await other.post(`${P()}/works`, { typeId: type("giden-yazi"), title: "Kablo tavası onayı", toCompanyIds: [ids.PAS], replyRequired: true, dueDate: day(2), fields: {} })).body;
    expect((await other.post(`${P()}/works/${letter.id}/send`, { channel: "cde" })).status).toBe(200);
    // A letter between other companies: PAS does not see it.
    const hidden = (await other.post(`${P()}/works`, { typeId: type("giden-yazi"), title: "HLL → CNS gizli yazı", toCompanyIds: [ids.CNS], dueDate: day(-5), fields: {} })).body;
    expect((await other.post(`${P()}/works/${hidden.id}/send`, { channel: "cde" })).status).toBe(200);
    const issue = (await pm.post(`${P()}/issues`, { title: "Pas payı yetersiz", assigneeUserId: ids.field, dueDate: day(-2) })).body;
    // The same kind of records in the other project must not appear.
    const t2 = (await field.get(`/projects/${pid2}/work-types`)).body as { id: string; key: string }[];
    await field.post(`/projects/${pid2}/works`, { typeId: t2.find((t) => t.key === "aksiyon")!.id, title: "Başka projenin eylemi", assigneeUserId: ids.field, dueDate: day(-1), fields: {} });
    await field.post(`/projects/${pid2}/issues`, { title: "Başka projenin sorunu", assigneeUserId: ids.field, dueDate: day(-1) });

    const r = await field.get(`${P()}/today`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = r.body;
    expect(t.projectId).toBe(pid);
    // No model configured: only the automatic summary (phase 2a), at once.
    expect(t.summary.ai).toBeNull();
    expect(t.summary.auto.length).toBeGreaterThanOrEqual(3);
    const titles = (rows: { title: string }[]) => rows.map((x) => x.title);
    expect(titles(t.mine.actions)).toEqual(["Numuneleri getir", "Hesabı gönder"]);
    expect(titles(t.mine.replies)).toEqual(["Kablo tavası onayı"]);
    expect(titles(t.mine.receipts)).toEqual(["Kablo tavası onayı"]);
    expect(titles(t.mine.issues)).toEqual(["Pas payı yetersiz"]);
    expect(t.mine.issues[0].link).toBe(`/projects/${pid}/issues/${issue.id}`);
    expect(titles(t.overdue)).toEqual(expect.arrayContaining(["Numuneleri getir", "Pas payı yetersiz"]));
    expect(titles(t.upcoming)).toEqual(expect.arrayContaining(["Hesabı gönder", "Kablo tavası onayı"]));
    const everything = JSON.stringify(t);
    expect(everything).not.toContain("Başka projenin");
    expect(everything).not.toContain("gizli yazı");
    expect(t.mine.actions[0].link).toBe(`/projects/${pid}/works/${action.id}`);

    // Recent changes: grouped by day and person + action, only visible records.
    const today = t.changes[0];
    expect(today.day).toBe(day(0));
    const created = today.changes.find((c: { action: string; userName: string }) => c.action === "work.created" && c.userName === "PM");
    expect(created.count).toBe(2);
    expect(created.text).toBe("2 iş oluşturdu");
    expect(created.items.map((i: { label: string }) => i.label).join(" ")).toContain("Numuneleri getir");
    const otherCreated = today.changes.find((c: { action: string; userName: string }) => c.action === "work.created" && c.userName === "OTHER");
    // OTHER wrote more letters today (the reply test, the HLL → CNS letter): the group holds them all.
    expect(otherCreated.items.map((i: { label: string }) => i.label).join(" ")).toContain("Kablo tavası onayı");

    // The other company sees its own letter, but not PAS's private actions.
    const o = (await other.get(`${P()}/today`)).body;
    expect(JSON.stringify(o.changes)).toContain("gizli yazı");
    expect(o.mine.actions).toEqual([]);
    expect(o.overdue.map((x: { title: string }) => x.title)).not.toContain("Numuneleri getir");

    // Non-members get 404, like every project route.
    await admin.post("/users", { email: "out@hub.test", name: "Out", password: PW });
    const out = api(await login("out@hub.test"));
    expect((await out.get(`${P()}/today`)).status).toBe(404);
  });

  it("includes review steps waiting for me", async () => {
    // A review template whose first step is PAS.
    const tpl = await admin.post(`${P()}/workflow-templates`, {
      kind: "review",
      name: "PAS kontrol",
      steps: [{ name: "PAS ön kontrol", assignees: [{ type: "company", id: ids.PAS }], rule: "any", days: 3, outcomes: ["approved", "rejected"] }],
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const root = (await admin.get(P())).body.rootFolderId;
    const folder = (await admin.post(`${P()}/folders`, { parentId: root, name: "Statik" })).body.id;
    await admin.put(`${P()}/folders/${folder}/permissions`, { entries: [{ subjectType: "company", subjectId: ids.PAS, level: "edit" }] });
    const form = new FormData();
    form.append("file", new Blob(["x"]), "S-01.pdf");
    const req = new Request("http://x", { method: "POST", body: form });
    const up = await app.inject({
      method: "POST",
      url: `/api/v1${P()}/folders/${folder}/files`,
      headers: { cookie: await login("admin@hub.test"), "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(up.statusCode, up.body).toBe(200);
    const versionId = (await admin.get(`${P()}/folders/${folder}/contents`)).body.files[0].latest.id;
    const rv = await admin.post(`${P()}/reviews`, { name: "Statik SD", templateId: tpl.body.id, versionIds: [versionId] });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    const t = (await field.get(`${P()}/today`)).body;
    expect(t.mine.tasks.map((x: { title: string; note: string }) => [x.title, x.note])).toEqual([["Statik SD", "1. PAS ön kontrol"]]);
    expect((await field.get(`/projects/${pid2}/today`)).body.mine.tasks).toEqual([]);
    expect(JSON.stringify(t.changes)).toContain("S-01.pdf");
    // HLL cannot see the PAS folder: the upload is not in its changes.
    expect(JSON.stringify((await other.get(`${P()}/today`)).body.changes)).not.toContain("S-01.pdf");
  });
});

describe("user preferences", () => {
  it("remembers 'Gelişmiş Ayarları Göster' per user", async () => {
    expect((await field.get("/me/prefs")).body).toEqual({});
    expect((await field.patch("/me/prefs", { advancedSettings: true })).body).toEqual({ advancedSettings: true });
    expect((await field.get("/me/prefs")).body).toEqual({ advancedSettings: true });
    expect((await other.get("/me/prefs")).body).toEqual({});
    expect((await field.patch("/me/prefs", { other: 1 })).status).toBe(400);
  });
});
