import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkflowStep } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { assigneeMatches, isStepComplete, onBehalfOf, type ActorContext } from "../../src/workflow/engine.js";

// ---- Engine (pure) --------------------------------------------------------------------------

const actor = (o: Partial<ActorContext> & { userId: string }): ActorContext => ({
  companyId: null,
  isProjectAdmin: false,
  isStarter: false,
  ...o,
});
const step = (o: Partial<WorkflowStep>): WorkflowStep => ({
  name: "Adım",
  assignees: [],
  rule: "any",
  days: 0,
  outcomes: ["approved", "rejected"],
  ...o,
});

describe("workflow engine with project roles", () => {
  it("matches a role assignee through the member's roles", () => {
    const a = actor({ userId: "u1", companyId: "c1", roleIds: ["r-mimari", "r-bim"] });
    expect(assigneeMatches({ type: "role", id: "r-mimari" }, a)).toBe(true);
    expect(assigneeMatches({ type: "role", id: "r-statik" }, a)).toBe(false);
    expect(assigneeMatches({ type: "role", id: "r-mimari" }, actor({ userId: "u2" }))).toBe(false);
    // Built-in roles keep working.
    expect(assigneeMatches({ type: "role", id: "starter" }, actor({ userId: "u3", isStarter: true }))).toBe(true);
  });

  it("lists the teams and companies an answer is given for", () => {
    const s = step({
      assignees: [
        { type: "user", id: "u1" },
        { type: "role", id: "r-mimari" },
        { type: "role", id: "r-statik" },
        { type: "company", id: "c1" },
        { type: "role", id: "starter" },
      ],
    });
    const a = actor({ userId: "u1", companyId: "c1", roleIds: ["r-mimari"], isStarter: true });
    expect(onBehalfOf(s, a)).toEqual([
      { type: "role", id: "r-mimari" },
      { type: "company", id: "c1" },
    ]);
    expect(onBehalfOf(s, actor({ userId: "u9" }))).toEqual([]);
  });

  it("completes an 'all' step when one member answers for both of their teams", () => {
    const s = step({ rule: "all", assignees: [{ type: "role", id: "rA" }, { type: "role", id: "rB" }] });
    const both = { actor: actor({ userId: "u1", roleIds: ["rA", "rB"] }), outcomes: {} };
    const onlyA = { actor: actor({ userId: "u2", roleIds: ["rA"] }), outcomes: {} };
    expect(isStepComplete(s, [onlyA])).toBe(false);
    expect(isStepComplete(s, [both])).toBe(true);
  });
});

// ---- API ----------------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-roles-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string, password = PW): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "cde_session");
  return `cde_session=${cookie!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, fileList: { name: string; data: string }[]) => {
      const form = new FormData();
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

type Client = ReturnType<typeof api>;

describe("project roles and teams", () => {
  let admin: Client, ali: Client, ayse: Client, veli: Client, yunus: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let wipId: string, sharedId: string, publishedId: string, archivedId: string;
  let designId: string, sharedSubId: string, yklAreaId: string;
  let mimariId: string, bimId: string;
  const P = () => `/projects/${pid}`;

  it("sets up an ISO 19650 project with four parties", async () => {
    admin = api(await login("admin@7d.test"));
    for (const c of ["İDR", "MSV", "TSR", "YKL"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects", { code: "RT", name: "Rol testi" });
    pid = p.body.id;
    const people: [string, string, string][] = [
      ["ali", "MSV", "Ali"],
      ["ayse", "MSV", "Ayşe"],
      ["veli", "TSR", "Veli"],
      ["yunus", "YKL", "Yunus"],
    ];
    for (const [key, company, name] of people) {
      ids[key] = (await admin.post("/users", { email: `${key}@rt.test`, name, password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@rt.test` })).status).toBe(200);
    }
    ali = api(await login("ali@rt.test"));
    ayse = api(await login("ayse@rt.test"));
    veli = api(await login("veli@rt.test"));
    yunus = api(await login("yunus@rt.test"));
    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    [wipId, sharedId, publishedId, archivedId] = root.body.folders.map((f: { id: string }) => f.id);
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "TSR Alanı" })).body.id;
    yklAreaId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "YKL Alanı" })).body.id;
    sharedSubId = (await admin.post(`${P()}/folders`, { parentId: sharedId, name: "Mimari" })).body.id;
    await admin.put(`${P()}/folders/${designId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.TSR, level: "manage" }],
    });
    const up = await veli.upload(`${P()}/folders/${designId}/files`, [{ name: "A.pdf", data: "A" }]);
    expect(up.status).toBe(200);
  });

  it("manages roles (project admins only) and assigns several roles to a member", async () => {
    expect((await ali.post(`${P()}/roles`, { name: "X" })).status).toBe(403);
    const m = await admin.post(`${P()}/roles`, { name: "Müşavir Mimari Ekip", description: "Mimari kontrol", color: "#2e7d32" });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    mimariId = m.body.id;
    bimId = (await admin.post(`${P()}/roles`, { name: "BIM" })).body.id;
    expect((await admin.post(`${P()}/roles`, { name: "BIM" })).status).toBe(409);
    expect((await admin.post(`${P()}/roles`, { name: "Renkli", color: "kırmızı" })).status).toBe(400);
    expect((await admin.patch(`${P()}/roles/${bimId}`, { description: "BIM koordinasyon" })).body.description).toBe(
      "BIM koordinasyon",
    );

    expect((await admin.post(`${P()}/roles/${mimariId}/members/${ids.ali}`)).body.memberIds).toEqual([ids.ali]);
    await admin.post(`${P()}/roles/${mimariId}/members/${ids.ayse}`);
    // An unknown user cannot be added.
    expect((await admin.post(`${P()}/roles/${mimariId}/members/${crypto.randomUUID()}`)).status).toBe(404);
    // Multi-role: Ali also joins BIM (set via the member endpoint).
    expect((await admin.put(`${P()}/members/${ids.ali}/roles`, { roleIds: [mimariId, bimId] })).status).toBe(200);

    const members = (await ali.get(`${P()}/members`)).body;
    const byName = Object.fromEntries(members.map((x: { name: string }) => [x.name, x]));
    expect(byName.Ali.roleIds.sort()).toEqual([mimariId, bimId].sort());
    expect(byName.Ayşe.roleIds).toEqual([mimariId]);
    expect(byName.Veli.roleIds).toEqual([]);
    const roles = (await veli.get(`${P()}/roles`)).body;
    expect(roles.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(["BIM", "Müşavir Mimari Ekip", "Görüntüleyici", "Düzenleyici", "Yönetici"]),
    );
    const mimari = roles.find((r: { id: string }) => r.id === mimariId);
    expect(mimari).toMatchObject({ color: "#2e7d32", description: "Mimari kontrol" });
    expect(mimari.memberIds.sort()).toEqual([ids.ali, ids.ayse].sort());
  });

  it("gives folder access through a role grant, and the highest of several roles wins", async () => {
    expect((await ali.get(`${P()}/folders/${sharedSubId}/contents`)).status).toBe(404);
    // Roles from another project or unknown ids are refused.
    expect(
      (
        await admin.put(`${P()}/folders/${sharedId}/permissions`, {
          entries: [{ subjectType: "role", subjectId: crypto.randomUUID(), level: "view" }],
        })
      ).status,
    ).toBe(404);
    const set = await admin.put(`${P()}/folders/${sharedId}/permissions`, {
      entries: [{ subjectType: "role", subjectId: mimariId, level: "view_download" }],
    });
    expect(set.status).toBe(200);
    expect(set.body.grants[0]).toMatchObject({ subjectType: "role", subjectName: "Müşavir Mimari Ekip", level: "view_download" });

    const sub = await ayse.get(`${P()}/folders/${sharedSubId}`);
    expect(sub.status).toBe(200);
    expect(sub.body.myLevel).toBe("view_download");
    expect((await veli.get(`${P()}/folders/${sharedSubId}/contents`)).status).toBe(404);

    // BIM gets edit on the subfolder: Ali holds both roles → edit, Ayşe only view_download.
    await admin.put(`${P()}/folders/${sharedSubId}/permissions`, {
      entries: [{ subjectType: "role", subjectId: bimId, level: "edit" }],
    });
    expect((await ali.get(`${P()}/folders/${sharedSubId}`)).body.myLevel).toBe("edit");
    expect((await ayse.get(`${P()}/folders/${sharedSubId}`)).body.myLevel).toBe("view_download");
    // Taking the BIM role away takes the right away.
    await admin.del(`${P()}/roles/${bimId}/members/${ids.ali}`);
    expect((await ali.get(`${P()}/folders/${sharedSubId}`)).body.myLevel).toBe("view_download");
    await admin.post(`${P()}/roles/${bimId}/members/${ids.ali}`);
  });

  it("lets any member of a role answer a review step on behalf of the team", async () => {
    // Unknown role ids are rejected in templates.
    const bad = await admin.post(`${P()}/workflow-templates`, {
      name: "Kötü",
      steps: [{ name: "X", assignees: [{ type: "role", id: crypto.randomUUID() }], rule: "any", days: 0, outcomes: ["approved"] }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("Bilinmeyen rol");

    const t = await admin.post(`${P()}/workflow-templates`, {
      name: "Müşavir → Firma",
      steps: [
        { name: "Mimari kontrol", assignees: [{ type: "role", id: mimariId }], rule: "any", days: 5, outcomes: ["approved", "rejected"] },
        { name: "MSV onay", assignees: [{ type: "company", id: ids.MSV }], rule: "any", days: 5, outcomes: ["approved", "rejected"] },
      ],
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const version = (await veli.get(`${P()}/folders/${designId}/contents`)).body.files[0].latest.id;
    const r = await veli.post(`${P()}/reviews`, { name: "Mimari set", templateId: t.body.id, versionIds: [version] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rid = r.body.id;
    expect(r.body.names[mimariId]).toBe("Müşavir Mimari Ekip");

    // Both role members get the task and the notification; others do not.
    expect((await ali.get("/my-tasks")).body).toHaveLength(1);
    expect((await ayse.get("/my-tasks")).body).toHaveLength(1);
    expect((await yunus.get("/my-tasks")).body).toHaveLength(0);
    expect((await ayse.get("/notifications")).body[0]).toMatchObject({ kind: "review.assigned" });
    expect((await yunus.get(`${P()}/reviews/${rid}`)).status).toBe(404);

    const before = (await ayse.get(`${P()}/reviews/${rid}`)).body;
    expect(before.canAct).toBe(true);
    expect(before.actingFor).toEqual([{ type: "role", id: mimariId, name: "Müşavir Mimari Ekip" }]);
    const files = before.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" }));
    expect((await yunus.post(`${P()}/reviews/${rid}/submit`, { files })).status).toBe(404);

    const s1 = await ayse.post(`${P()}/reviews/${rid}/submit`, { files, comment: "Ekip görüşü" });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect(s1.body).toMatchObject({ stepIndex: 1, stepName: "MSV onay" });
    const submit = s1.body.actions.find((x: { kind: string }) => x.kind === "submit");
    expect(submit).toMatchObject({ userId: ids.ayse, userName: "Ayşe" });
    expect(submit.onBehalfOf).toEqual([{ type: "role", id: mimariId, name: "Müşavir Mimari Ekip" }]);
    expect(s1.body.marks[0].onBehalfOf).toEqual([{ type: "role", id: mimariId, name: "Müşavir Mimari Ekip" }]);
    // The team step is done for everyone; Ali's next task is the company step.
    const aliTasks = (await ali.get("/my-tasks")).body;
    expect(aliTasks).toHaveLength(1);
    expect(aliTasks[0].stepName).toBe("MSV onay");

    // Company step: Ali answers for MSV.
    const s2 = await ali.post(`${P()}/reviews/${rid}/submit`, { files });
    expect(s2.status).toBe(200);
    expect(s2.body.status).toBe("completed");
    const submits = s2.body.actions.filter((x: { kind: string }) => x.kind === "submit");
    expect(submits[1]).toMatchObject({ userId: ids.ali });
    expect(submits[1].onBehalfOf).toEqual([{ type: "company", id: ids.MSV, name: "MSV" }]);

    // A role in use by a template cannot be deleted.
    const del = await admin.del(`${P()}/roles/${mimariId}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toContain("Müşavir → Firma");
  });

  it("explains who can see a folder or a file and why", async () => {
    // Yunus may upload into SHARED/Mimari but not see others' files.
    await admin.put(`${P()}/folders/${sharedSubId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: ids.yunus, level: "upload_only" }],
    });
    const up = await ali.upload(`${P()}/folders/${sharedSubId}/files`, [{ name: "M.pdf", data: "M" }]);
    expect(up.status).toBe(200);
    const fileId = up.body.results[0].fileId;

    // Veli cannot see the folder, so he cannot ask either.
    expect((await veli.get(`${P()}/folders/${sharedSubId}/who-can-see`)).status).toBe(404);
    const w = await ayse.get(`${P()}/folders/${sharedSubId}/who-can-see`);
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.folderPath).toBe("Proje Dosyaları / 02-SHARED (Paylaşılan) / Mimari");
    const by = Object.fromEntries(w.body.entries.map((e: { name: string }) => [e.name, e]));

    expect(by.Admin).toMatchObject({ level: "manage", canSee: true });
    expect(by.Admin.reasons[0].via).toBe("project_admin");

    expect(by.Ali).toMatchObject({ level: "edit", canSee: true });
    expect(by.Ali.roleNames.sort()).toEqual(["BIM", "Müşavir Mimari Ekip"]);
    expect(by.Ali.reasons[0]).toMatchObject({ via: "role", subjectName: "BIM", level: "edit", inherited: false, decisive: true });
    expect(by.Ali.reasons[1]).toMatchObject({
      via: "role",
      subjectName: "Müşavir Mimari Ekip",
      folderName: "02-SHARED (Paylaşılan)",
      inherited: true,
      decisive: false,
    });
    expect(by.Ali.explanation).toContain('"BIM" rolü üzerinden');

    expect(by.Ayşe.reasons).toHaveLength(1);
    expect(by.Ayşe.explanation).toContain('"02-SHARED (Paylaşılan)" klasöründen miras');
    expect(by.Ayşe.explanation).toContain("Görüntüle + İndir");

    expect(by.Veli).toMatchObject({ level: "none", canSee: false, reasons: [] });
    expect(by.Veli.explanation).toContain("göremez");
    expect(by.Yunus).toMatchObject({ level: "upload_only", canSee: true });
    expect(w.body.entries[0].canSee).toBe(true);
    expect(w.body.entries.at(-1).name).toBe("Veli");

    // For a file uploaded by Ali, upload-only Yunus does not see it.
    const wf = await ali.get(`${P()}/folders/${sharedSubId}/who-can-see?fileId=${fileId}`);
    expect(wf.body.fileName).toBe("M.pdf");
    const yf = wf.body.entries.find((e: { name: string }) => e.name === "Yunus");
    expect(yf).toMatchObject({ level: "upload_only", canSee: false });
    expect(yf.explanation).toContain("bu dosyayı göremez");
    expect((await ali.get(`${P()}/folders/${sharedId}/who-can-see?fileId=${fileId}`)).status).toBe(404);
  });

  it("previews and applies a role package to a company without lowering anything", async () => {
    // A published subfolder inside SHARED: the package's lower level there must be rejected.
    const inner = (await admin.post(`${P()}/folders`, { parentId: sharedId, name: "Yayın kopyası" })).body.id;
    await admin.patch(`${P()}/folders/${inner}`, { state: "published" });
    // YKL already manages ARCHIVED: never lowered.
    await admin.put(`${P()}/folders/${archivedId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.YKL, level: "manage" }],
    });

    const q = `companyId=${ids.YKL}&package=yuklenici&areaFolderId=${yklAreaId}`;
    expect((await yunus.get(`${P()}/role-packages/preview?${q}`)).status).toBe(403);
    expect((await admin.get(`${P()}/role-packages/preview?companyId=${ids.YKL}&package=bilinmeyen`)).status).toBe(400);
    expect(
      (await admin.get(`${P()}/role-packages/preview?companyId=${ids.YKL}&package=yuklenici&areaFolderId=${(await admin.get(`/projects/${pid}`)).body.rootFolderId}`))
        .status,
    ).toBe(400);
    const pkgs = (await yunus.get(`${P()}/role-packages`)).body;
    expect(pkgs.map((x: { label: string }) => x.label)).toEqual(["İdare", "Müşavir", "Tasarımcı", "Yüklenici"]);

    const preview = await admin.get(`${P()}/role-packages/preview?${q}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ companyName: "YKL", memberCount: 1, applied: false, writes: 3 });
    const plan = Object.fromEntries(
      preview.body.entries.map((e: { folderId: string; action: string; level: string }) => [e.folderId, e]),
    );
    expect(plan[wipId]).toMatchObject({ action: "no_grant", level: "none" });
    expect(plan[sharedId]).toMatchObject({ action: "create", level: "edit", current: null });
    expect(plan[publishedId]).toMatchObject({ action: "create", level: "view_download" });
    expect(plan[archivedId]).toMatchObject({ action: "kept_higher", current: "manage", level: "view_download" });
    expect(plan[inner]).toMatchObject({ action: "rejected_lower_than_inherited", inherited: "edit", level: "view_download" });
    expect(plan[yklAreaId]).toMatchObject({ action: "create", level: "manage", reason: "own_area" });
    // Previewing writes nothing.
    expect((await yunus.get(`${P()}/folders/${sharedId}`)).body.myLevel).toBe("none");

    const applied = await admin.post(`${P()}/role-packages/apply`, {
      companyId: ids.YKL,
      package: "yuklenici",
      areaFolderId: yklAreaId,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, writes: 3 });
    expect((await yunus.get(`${P()}/folders/${sharedId}`)).body.myLevel).toBe("edit");
    expect((await yunus.get(`${P()}/folders/${publishedId}`)).body.myLevel).toBe("view_download");
    expect((await yunus.get(`${P()}/folders/${archivedId}`)).body.myLevel).toBe("manage");
    expect((await yunus.get(`${P()}/folders/${yklAreaId}`)).body.myLevel).toBe("manage");
    expect((await yunus.get(`${P()}/folders/${designId}/contents`)).status).toBe(404);
    const grants = (await admin.get(`${P()}/folders/${inner}/permissions`)).body;
    expect(grants.filter((g: { subjectId: string; inherited: boolean }) => g.subjectId === ids.YKL && !g.inherited)).toEqual([]);

    // Applying again changes nothing.
    const again = await admin.post(`${P()}/role-packages/apply`, { companyId: ids.YKL, package: "yuklenici", areaFolderId: yklAreaId });
    expect(again.body.writes).toBe(0);
    expect(
      again.body.entries.filter((e: { action: string }) => e.action === "unchanged").map((e: { folderId: string }) => e.folderId).sort(),
    ).toEqual([sharedId, publishedId, yklAreaId].sort());
    // Upgrading: the İdare package over a lower existing grant.
    await admin.put(`${P()}/folders/${publishedId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.İDR, level: "view" }],
    });
    const idare = await admin.get(`${P()}/role-packages/preview?companyId=${ids.İDR}&package=idare`);
    expect(idare.body.entries.find((e: { folderId: string }) => e.folderId === publishedId)).toMatchObject({
      action: "upgrade",
      current: "view",
      level: "view_download_markup",
    });
    expect(idare.body.memberCount).toBe(0);
    const activity = (await admin.get(`${P()}/activity`)).body.map((x: { action: string }) => x.action);
    expect(activity).toContain("role_package.applied");
  });

  it("deletes an unused role together with its grants; removing a member drops their roles", async () => {
    const tmp = (await admin.post(`${P()}/roles`, { name: "Geçici" })).body.id;
    await admin.post(`${P()}/roles/${tmp}/members/${ids.veli}`);
    await admin.put(`${P()}/folders/${publishedId}/permissions`, {
      entries: [{ subjectType: "role", subjectId: tmp, level: "view" }],
    });
    expect((await veli.get(`${P()}/folders/${publishedId}`)).body.myLevel).toBe("view");
    const del = await admin.del(`${P()}/roles/${tmp}`);
    expect(del.body).toMatchObject({ ok: true, removedGrants: 1 });
    expect((await veli.get(`${P()}/folders/${publishedId}`)).status).toBe(404);

    expect((await admin.del(`${P()}/members/${ids.ayse}`)).status).toBe(200);
    const roles = (await admin.get(`${P()}/roles`)).body;
    expect(roles.find((r: { id: string }) => r.id === mimariId).memberIds).toEqual([ids.ali]);
  });

  it("seeds Görüntüleyici / Düzenleyici / Yönetici on the project and assigns them on add-member", async () => {
    const roles = (await admin.get(`${P()}/roles`)).body as { id: string; name: string; memberIds: string[] }[];
    expect(roles.slice(0, 3).map((r) => r.name)).toEqual(["Görüntüleyici", "Düzenleyici", "Yönetici"]);
    const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
    expect(byName.Yönetici.memberIds.length).toBeGreaterThan(0);

    const email = "fatma@rt.test";
    const uid = (await admin.post("/users", { email, name: "Fatma", password: PW })).body.id;
    expect((await admin.post(`${P()}/members`, { email, roleId: byName.Görüntüleyici.id })).status).toBe(200);
    const fatma = ((await admin.get(`${P()}/members`)).body as { userId: string; roleIds: string[]; isProjectAdmin: boolean }[]).find(
      (m) => m.userId === uid,
    )!;
    expect(fatma.roleIds).toContain(byName.Görüntüleyici.id);
    expect(fatma.isProjectAdmin).toBe(false);
    const asFatma = api(await login(email));
    const published = await asFatma.get(`${P()}/folders/${publishedId}`);
    expect(published.status).toBe(200);
    expect(published.body.myLevel).toBe("view_download");

    const email2 = "cem@rt.test";
    await admin.post("/users", { email: email2, name: "Cem", password: PW });
    expect((await admin.post(`${P()}/members`, { email: email2, roleId: byName.Yönetici.id })).status).toBe(200);
    const cem = ((await admin.get(`${P()}/members`)).body as { email: string; isProjectAdmin: boolean }[]).find((m) => m.email === email2);
    expect(cem?.isProjectAdmin).toBe(true);
  });
});
