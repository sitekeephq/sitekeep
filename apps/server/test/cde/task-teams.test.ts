/**
 * ISO19650-2 5.1.7(e) / -1 12.2 task team WIP (ISO-5, docs/features/TASK_TEAMS.md): task teams as
 * project roles, owner teams on WIP folders, the team-only WIP rule in FolderTree (API, search,
 * zip, who-can-see), admin_sees_wip, exception grants with a reason (audit "cde.override"),
 * idempotent seeding, and the unchanged 'grants' policy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import type { ProjectRoleDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { FolderTree } from "../../src/core/security/access.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, companies, folders, memberRoles, projectRoles, systemSettings, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { seedTaskTeams, seedTaskTeamsOnce, TASK_TEAMS_BACKFILLED } from "../../src/cde/teams.js";
import { readBcfZip } from "../../src/bcf/unzip.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-teams-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
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
    /** True when the zip of `payload` contains an entry named `name` (names are stored uncompressed). */
    zipHas: async (payload: unknown, name: string) => {
      const pid = currentPid;
      const res = await app.inject({ method: "POST", url: `/api/v1/projects/${pid}/download-zip`, headers: { cookie }, payload: payload as object });
      return res.statusCode === 200 && res.rawPayload.includes(Buffer.from(name));
    },
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
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
type Api = ReturnType<typeof api>;
let currentPid = "";

describe("ISO19650-2 5.1.7(e) / -1 12.2 task team WIP", () => {
  let admin: Api, ua: Api, ub: Api, viewer: Api, pa: Api;
  const ids: Record<string, string> = {};
  let pid: string;
  let wipId: string, wipA: string, wipB: string, sharedId: string, fileA: string;
  let teams: ProjectRoleDto[];
  const P = () => `/projects/${pid}`;

  it("creates a project from the ISO template: team_only, one team per slot company, owner teams on WIP", async () => {
    admin = api(await login("admin@7d.test"));
    ids.A = (await admin.post("/companies", { name: "Alfa Tasarım", code: "ALF" })).body.id;
    ids.B = (await admin.post("/companies", { name: "Beta Yapı", code: "BET" })).body.id;
    const r = await admin.post("/projects/from-template", {
      code: "TT1",
      name: "Task teams",
      templateId: "iso19650-temel",
      slotCompanies: { tasarimci: ids.A, yuklenici: ids.B },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pid = r.body.id;
    currentPid = pid;
    expect((await admin.get(`${P()}/cde/settings`)).body.wipPolicy).toBe("team_only");

    teams = ((await admin.get(`${P()}/roles`)).body as ProjectRoleDto[]).filter((t) => t.kind === "task_team");
    expect(teams.map((t) => [t.name, t.code, t.companyId]).sort()).toEqual([
      ["Alfa Tasarım", "ALF", ids.A],
      ["Beta Yapı", "BET", ids.B],
    ]);
    const root = await admin.get(`${P()}/folders/${r.body.rootFolderId}/contents`);
    wipId = root.body.folders.find((f: { state: string }) => f.state === "wip").id;
    sharedId = root.body.folders.find((f: { state: string }) => f.state === "shared").id;
    const wip = await admin.get(`${P()}/folders/${wipId}/contents`);
    const byName = (n: string) => wip.body.folders.find((f: { name: string }) => f.name === n);
    wipA = byName("Tasarımcı").id;
    wipB = byName("Yüklenici").id;
    const teamOf = (c: string) => teams.find((t) => t.companyId === c)!.id;
    expect(byName("Tasarımcı").ownerTeamId).toBe(teamOf(ids.A));
    expect(byName("Yüklenici").ownerTeamId).toBe(teamOf(ids.B));
    // Slots without a company get no team and their folders no owner.
    expect(byName("İdare").ownerTeamId).toBeNull();
  });

  it("puts new members in their company's team", async () => {
    const people: [string, string | null, Record<string, unknown>][] = [
      ["ua", ids.A!, {}],
      ["ub", ids.B!, {}],
      ["viewer", null, {}],
      ["pa", null, { isProjectAdmin: true }],
    ];
    const roles = (await admin.get(`${P()}/roles`)).body as ProjectRoleDto[];
    const viewerRole = roles.find((x) => x.name === "Görüntüleyici")!.id;
    for (const [key, company, extra] of people) {
      ids[key] = (await admin.post("/users", { email: `${key}@tt.test`, name: key, password: PW, companyId: company })).body.id;
      const add = await admin.post(`${P()}/members`, { email: `${key}@tt.test`, ...(key === "viewer" ? { roleId: viewerRole } : {}), ...extra });
      expect(add.status, JSON.stringify(add.body)).toBe(200);
    }
    ua = api(await login("ua@tt.test"));
    ub = api(await login("ub@tt.test"));
    viewer = api(await login("viewer@tt.test"));
    pa = api(await login("pa@tt.test"));
    const after = (await admin.get(`${P()}/roles`)).body as ProjectRoleDto[];
    expect(after.find((t) => t.companyId === ids.A)!.memberIds).toEqual([ids.ua]);
    expect(after.find((t) => t.companyId === ids.B)!.memberIds).toEqual([ids.ub]);
  });

  it("hides team A's WIP from team B and from project-wide viewers: API 404, search, zip", async () => {
    const up = await ua.upload(`${P()}/folders/${wipA}/files`, "ALFA-gizli-plan.pdf", "secret A");
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    fileA = up.body.results[0].fileId;
    expect(fileA).toBeTruthy();

    for (const outsider of [ub, viewer]) {
      expect((await outsider.get(`${P()}/folders/${wipA}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/folders/${wipA}/contents`)).status).toBe(404);
      expect((await outsider.get(`${P()}/files/${fileA}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/files/${fileA}/history`)).status).toBe(404);
      const list = await outsider.get(`${P()}/folders/${wipId}/contents`);
      expect(list.body.folders.map((f: { id: string }) => f.id)).not.toContain(wipA);
      const search = await outsider.get(`${P()}/search?q=gizli`);
      expect(search.status).toBe(200);
      expect(search.body.results).toEqual([]);
      expect(await outsider.zipHas({ fileIds: [fileA] }, "ALFA-gizli-plan.pdf")).toBe(false);
      expect(await outsider.zipHas({ folderIds: [wipId] }, "ALFA-gizli-plan.pdf")).toBe(false);
    }
    // The viewer still sees Shared through the root grant.
    expect((await viewer.get(`${P()}/folders/${sharedId}`)).status).toBe(200);
    // Team A sees its own WIP; team B its own.
    expect((await ua.get(`${P()}/files/${fileA}`)).status).toBe(200);
    expect((await ua.get(`${P()}/search?q=gizli`)).body.results).toHaveLength(1);
    expect(await ua.zipHas({ folderIds: [wipId] }, "ALFA-gizli-plan.pdf")).toBe(true);
    expect((await ub.get(`${P()}/folders/${wipB}`)).status).toBe(200);
  });

  it("leaves another team's WIP model out of a BCF export's header files", async () => {
    const versionId = (await ua.get(`${P()}/files/${fileA}`)).body.versions[0].id as string;
    const viewpoint = {
      camera: { position: [0, 5, 10], target: [0, 0, 0], projection: "perspective", up: [0, 1, 0], fov: 55, aspect: 1.5 },
      fileVersionIds: [versionId],
    };
    const issue = await ua.post(`${P()}/issues`, { title: "Koordinasyon", viewpoint });
    expect(issue.status, JSON.stringify(issue.body)).toBe(200);
    const markups = async (who: Api) => {
      const res = await who.post(`${P()}/bcf/export`, { version: "3.0", snapshots: false });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const zip = await readBcfZip(Buffer.from(res.body.base64, "base64"));
      return [...zip.files].filter(([n]) => n.endsWith("markup.bcf")).map(([, b]) => b.toString()).join("");
    };
    expect(await markups(ua)).toContain("ALFA-gizli-plan.pdf");
    expect(await markups(ub)).not.toContain("ALFA-gizli-plan.pdf");
  });

  it("lets project administrators see all WIP only while admin_sees_wip is on", async () => {
    expect((await pa.get(`${P()}/files/${fileA}`)).status).toBe(200);
    expect((await admin.put(`${P()}/cde/settings`, { adminSeesWip: false })).status).toBe(200);
    expect((await pa.get(`${P()}/files/${fileA}`)).status).toBe(404);
    expect((await pa.get(`${P()}/search?q=gizli`)).body.results).toEqual([]);
    // The project audit log keeps the rows but withholds the file's name and details.
    const log = await pa.get(`${P()}/audit?limit=200`);
    expect(log.status).toBe(200);
    const rows = log.body.entries.filter((e: { targetId: string }) => e.targetId === fileA);
    expect(rows.length).toBeGreaterThan(0);
    for (const e of rows) {
      expect(e.targetName).toBeUndefined();
      expect(e.details).toEqual({ withheld: "task_team_wip" });
    }
    expect(JSON.stringify(log.body)).not.toContain("ALFA-gizli-plan.pdf");
    expect(JSON.stringify((await pa.get(`${P()}/activity?limit=500`)).body)).not.toContain("ALFA-gizli-plan.pdf");
    expect((await admin.put(`${P()}/cde/settings`, { adminSeesWip: true })).status).toBe(200);
    expect((await pa.get(`${P()}/files/${fileA}`)).status).toBe(200);
    const shown = (await pa.get(`${P()}/audit?limit=200`)).body.entries.find((e: { targetId: string }) => e.targetId === fileA);
    expect(shown.targetName).toBe("ALFA-gizli-plan.pdf");
  });

  it("explains the rule in who-can-see", async () => {
    const w = await admin.get(`${P()}/folders/${wipA}/who-can-see`);
    expect(w.status).toBe(200);
    const entry = (uid: string) => w.body.entries.find((e: { userId: string }) => e.userId === uid);
    expect(entry(ids.ub!).canSee).toBe(false);
    expect(entry(ids.ub!).reasons[0]).toMatchObject({ via: "task_team_wip", subjectName: "Alfa Tasarım", level: "none" });
    expect(entry(ids.ub!).explanation).toContain("Alfa Tasarım");
    expect(entry(ids.ua!).canSee).toBe(true);
  });

  it("requires a reason for an exception grant outside the team and logs cde.override", async () => {
    const entries = [{ subjectType: "user", subjectId: ids.ub, level: "view_download" }];
    const no = await admin.put(`${P()}/folders/${wipA}/permissions`, { entries });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe("wip_reason_required");
    expect(no.body.details.teamName).toBe("Alfa Tasarım");
    // A grant inside the team needs no reason.
    const inside = await admin.put(`${P()}/folders/${wipA}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.A, level: "edit" }],
      mode: "replace",
    });
    expect(inside.status).toBe(200);

    const ok = await admin.put(`${P()}/folders/${wipA}/permissions`, { entries, reason: "Statik koordinasyon için" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.results[0].status).toBe("ok");
    const [row] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "cde.override")))
      .orderBy(desc(auditLog.at));
    expect(row!.details).toMatchObject({ reason: "Statik koordinasyon için", teamName: "Alfa Tasarım" });
    expect((await ub.get(`${P()}/files/${fileA}`)).status).toBe(200);
    // The exception reaches only that person.
    expect((await viewer.get(`${P()}/files/${fileA}`)).status).toBe(404);
    // Removing it closes the folder again.
    await admin.put(`${P()}/folders/${wipA}/permissions`, { entries: [{ ...entries[0], level: "none" }], mode: "replace" });
    expect((await ub.get(`${P()}/files/${fileA}`)).status).toBe(404);
  });

  it("sets the owner team of a WIP folder (project administrators, WIP only)", async () => {
    const teamB = teams.find((t) => t.companyId === ids.B)!.id;
    expect((await ua.put(`${P()}/folders/${wipA}/owner-team`, { teamId: teamB })).status).toBe(403);
    expect((await admin.put(`${P()}/folders/${sharedId}/owner-team`, { teamId: teamB })).status).toBe(400);
    const sub = (await admin.post(`${P()}/folders`, { parentId: wipA, name: "Alt" })).body.id;
    const set = await admin.put(`${P()}/folders/${sub}/owner-team`, { teamId: teamB });
    expect(set.status).toBe(200);
    expect(set.body.ownerTeamId).toBe(teamB);
    // The nearest owner wins: team B now owns the subfolder, so team A's grant above no longer
    // reaches it. Ownership closes the folder to others; it gives team B no rights by itself.
    expect((await ua.get(`${P()}/folders/${sub}`)).status).toBe(404);
    expect((await ub.get(`${P()}/folders/${sub}`)).status).toBe(404);
    expect((await admin.put(`${P()}/folders/${sub}/owner-team`, { teamId: null })).body.ownerTeamId).toBeNull();
    expect((await ua.get(`${P()}/folders/${sub}`)).status).toBe(200);
  });

  it("keeps the 'grants' policy unchanged: inherited grants apply, no reason needed", async () => {
    expect((await admin.put(`${P()}/cde/settings`, { wipPolicy: "grants" })).status).toBe(200);
    expect((await viewer.get(`${P()}/files/${fileA}`)).status).toBe(200);
    expect((await ub.get(`${P()}/folders/${wipA}`)).status).toBe(404); // no grant at all
    const ok = await admin.put(`${P()}/folders/${wipA}/permissions`, {
      entries: [{ subjectType: "user", subjectId: ids.ub, level: "view" }],
    });
    expect(ok.status).toBe(200);
    const tree = await FolderTree.load(handle.db, pid);
    expect(tree.wipTeamScope(wipA)).toBeNull();
    await admin.put(`${P()}/cde/settings`, { wipPolicy: "team_only" });
  });
});

describe("ISO19650-2 5.1.7(e) task team seeding", () => {
  it("seeds one team per company once, joins members, and is idempotent", async () => {
    const admin = api(await login("admin@7d.test"));
    const c1 = (await admin.post("/companies", { name: "Gama Mühendislik", code: "GAM" })).body.id;
    const c2 = (await admin.post("/companies", { name: "Delta Müşavir" })).body.id;
    const p = await admin.post("/projects", { code: "SEED", name: "Seed" });
    const pid = p.body.id;
    for (const [key, company] of [
      ["g1", c1],
      ["g2", c1],
      ["d1", c2],
    ] as const) {
      await admin.post("/users", { email: `${key}@seed.test`, name: key, password: PW, companyId: company });
      expect((await admin.post(`/projects/${pid}/members`, { email: `${key}@seed.test` })).status).toBe(200);
    }
    const teamRows = () =>
      handle.db.select().from(projectRoles).where(and(eq(projectRoles.projectId, pid), eq(projectRoles.kind, "task_team")));
    expect(await teamRows()).toHaveLength(0);

    const first = await seedTaskTeams(handle.db, { batchSize: 1 });
    expect(first.teamsCreated).toBeGreaterThanOrEqual(2);
    const created = await teamRows();
    expect(created.map((t) => [t.name, t.code]).sort()).toEqual([
      ["Delta Müşavir", null],
      ["Gama Mühendislik", "GAM"],
    ]);
    const gama = created.find((t) => t.companyId === c1)!;
    const links = await handle.db.select().from(memberRoles).where(eq(memberRoles.roleId, gama.id));
    expect(links).toHaveLength(2);

    expect(await seedTaskTeams(handle.db)).toEqual({ projectsSeeded: 0, teamsCreated: 0, foldersOwned: 0 });
    // A team an administrator deleted is not brought back at the next start.
    await handle.db.delete(projectRoles).where(eq(projectRoles.id, gama.id));
    expect((await seedTaskTeams(handle.db)).teamsCreated).toBe(0);
    // The explicit seed action fills the gap.
    const seed = await admin.post(`/projects/${pid}/cde/teams/seed`);
    expect(seed.body).toEqual({ created: 1, foldersOwned: 0 });
    expect((await admin.post(`/projects/${pid}/cde/teams/seed`)).body).toEqual({ created: 0, foldersOwned: 0 });
    // Existing projects stay on 'grants': no folder is closed by seeding.
    expect((await admin.get(`/projects/${pid}/cde/settings`)).body.wipPolicy).toBe("grants");
    const owned = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    expect(owned.every((f) => f.ownerTeamId === null)).toBe(true);
  });
});

describe("Task teams are the parties chosen, and stay deleted (#171)", () => {
  it("does not add the creator's company as a task team when a project is made from a template", async () => {
    const [own] = await handle.db.insert(companies).values({ name: "Kuran Danışmanlık", code: "KUR" }).returning();
    await handle.db
      .insert(users)
      .values({ email: "creator@7d.test", name: "Creator", passwordHash: await hashPassword(PW), isAdmin: true, companyId: own!.id });
    const creator = api(await login("creator@7d.test"));
    const contractor = (await creator.post("/companies", { name: "Epsilon İnşaat", code: "EPS" })).body.id;
    const r = await creator.post("/projects/from-template", {
      code: "TT171",
      name: "Creator company",
      templateId: "iso19650-temel",
      slotCompanies: { yuklenici: contractor },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const teams = ((await creator.get(`/projects/${r.body.id}/roles`)).body as ProjectRoleDto[]).filter((t) => t.kind === "task_team");
    expect(teams.map((t) => t.companyId)).toEqual([contractor]);
    // The creator's company is still a project company (members), only not a task team.
    expect((await creator.get(`/projects/${r.body.id}/members`)).body.some((m: { companyId: string | null }) => m.companyId === own!.id)).toBe(true);

    // A project's last team, once deleted, is not brought back at the next start.
    const del = await app.inject({ method: "DELETE", url: `/api/v1/projects/${r.body.id}/roles/${teams[0]!.id}`, headers: { cookie: await login("creator@7d.test") } });
    expect(del.statusCode, del.body).toBe(200);
    await handle.db.delete(systemSettings).where(eq(systemSettings.key, TASK_TEAMS_BACKFILLED));
    // An installation that already has task teams was backfilled before: only the marker is written.
    expect(await seedTaskTeamsOnce(handle.db)).toEqual({ projectsSeeded: 0, teamsCreated: 0, foldersOwned: 0 });
    expect(await seedTaskTeamsOnce(handle.db)).toBeNull();
    const after = await handle.db
      .select()
      .from(projectRoles)
      .where(and(eq(projectRoles.projectId, r.body.id), eq(projectRoles.kind, "task_team")));
    expect(after).toHaveLength(0);
  });
});
