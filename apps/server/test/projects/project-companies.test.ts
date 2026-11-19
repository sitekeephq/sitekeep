/**
 * Companies on a project (docs/features/COMPANIES.md, issue #142): two customers on one server do not
 * see each other's companies; project pickers list the project's companies; writes refuse a company
 * of another project.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-pcomp-"));
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

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

type Api = ReturnType<typeof api>;
const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

describe("companies are scoped to projects", () => {
  let admin: Api;
  let alice: Api; // project administrator of P1 (customer A)
  let bob: Api; // project administrator of P2 (customer B)
  let carol: Api; // plain member of P1
  const co: Record<string, string> = {};
  const p: Record<string, { id: string; rootFolderId: string }> = {};

  it("sets up two customers on one server", async () => {
    admin = api(await login("admin@7d.test"));
    for (const name of ["Alfa Yapı", "Alfa Müşavir", "Beta İnşaat", "Riverside Design JV", "Yeni Firma"]) {
      const r = await admin.post("/companies", { name });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      co[name] = r.body.id;
    }
    for (const [email, name, company] of [
      ["alice@a.test", "Alice", "Alfa Yapı"],
      ["carol@a.test", "Carol", "Alfa Müşavir"],
      ["bob@b.test", "Bob", "Beta İnşaat"],
    ] as const)
      expect((await admin.post("/users", { email, name, password: PW, companyId: co[company] })).status).toBe(200);
    for (const code of ["P1", "P2"]) {
      const r = await admin.post("/projects", { code, name: code });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      p[code] = { id: r.body.id, rootFolderId: r.body.rootFolderId };
    }
    // The member's own company comes onto the project with them.
    expect((await admin.post(`/projects/${p.P1!.id}/members`, { email: "alice@a.test", isProjectAdmin: true })).status).toBe(200);
    expect((await admin.post(`/projects/${p.P1!.id}/members`, { email: "carol@a.test" })).status).toBe(200);
    expect((await admin.post(`/projects/${p.P2!.id}/members`, { email: "bob@b.test", isProjectAdmin: true })).status).toBe(200);
    // The demo company goes onto P2 only (created straight onto the project).
    const demo = await admin.post("/companies", { name: "Riverside Metro Authority", projectId: p.P2!.id });
    expect(demo.status).toBe(200);
    co["Riverside Metro Authority"] = demo.body.id;
    expect((await admin.post(`/projects/${p.P2!.id}/companies`, { companyId: co["Riverside Design JV"] })).status).toBe(200);
    alice = api(await login("alice@a.test"));
    bob = api(await login("bob@b.test"));
    carol = api(await login("carol@a.test"));
  });

  it("lists only the caller's companies", async () => {
    expect(names((await alice.get("/companies")).body)).toEqual(["Alfa Müşavir", "Alfa Yapı"]);
    expect(names((await bob.get("/companies")).body)).toEqual(["Beta İnşaat", "Riverside Design JV", "Riverside Metro Authority"]);
    // The system administrator sees every company, with its projects, and can filter by project.
    const all = (await admin.get("/companies")).body as { name: string; projects: { code: string }[] }[];
    expect(all).toHaveLength(6);
    expect(all.find((c) => c.name === "Yeni Firma")!.projects).toEqual([]);
    expect(all.find((c) => c.name === "Riverside Design JV")!.projects.map((x) => x.code)).toEqual(["P2"]);
    expect(names((await admin.get(`/companies?projectId=${p.P1!.id}`)).body)).toEqual(["Alfa Müşavir", "Alfa Yapı"]);
    // Another project's list is not reachable.
    expect((await alice.get(`/companies?projectId=${p.P2!.id}`)).status).toBe(404);
    expect((await alice.get(`/projects/${p.P2!.id}/companies`)).status).toBe(404);
  });

  it("project pickers list the project's companies, also for the system administrator", async () => {
    expect(names((await carol.get(`/projects/${p.P1!.id}/companies`)).body)).toEqual(["Alfa Müşavir", "Alfa Yapı"]);
    expect(names((await admin.get(`/projects/${p.P1!.id}/companies`)).body)).toEqual(["Alfa Müşavir", "Alfa Yapı"]);
  });

  it("refuses another customer's company on writes", async () => {
    const P1 = p.P1!.id;
    const foreign = co["Riverside Metro Authority"]!;
    expect((await alice.post(`/projects/${P1}/companies`, { companyId: foreign })).status).toBe(400);
    expect((await alice.post(`/projects/${P1}/companies`, { companyId: co["Yeni Firma"] })).status).toBe(400);
    const carolId = (await alice.get(`/projects/${P1}/members`)).body.find((m: { name: string }) => m.name === "Carol").userId;
    expect((await alice.patch(`/projects/${P1}/members/${carolId}`, { companyId: foreign })).status).toBe(400);
    expect((await alice.post(`/projects/${P1}/roles`, { name: "Dış Ekip", kind: "task_team", companyId: foreign })).status).toBe(400);
    expect((await alice.post(`/projects/${P1}/issues`, { title: "Sorun", assigneeCompanyId: foreign })).status).toBe(400);
    expect((await carol.post(`/projects/${P1}/issues`, { title: "Sorun", assigneeCompanyId: foreign })).status).toBe(400);
    const grant = await alice.put(`/projects/${P1}/folders/${p.P1!.rootFolderId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: foreign, level: "view" }],
    });
    expect(grant.status).toBe(400);
    expect((await alice.post(`/projects/${P1}/invitations`, { email: "dave@a.test", companyId: foreign })).status).toBe(400);
    // Nothing leaked onto P1.
    expect(names((await alice.get(`/projects/${P1}/companies`)).body)).toEqual(["Alfa Müşavir", "Alfa Yapı"]);
  });

  it("accepts the project's own companies", async () => {
    const P1 = p.P1!.id;
    const own = co["Alfa Müşavir"]!;
    expect((await carol.post(`/projects/${P1}/issues`, { title: "Sorun", assigneeCompanyId: own })).status).toBe(200);
    expect((await alice.post(`/projects/${P1}/roles`, { name: "Müşavir Ekibi", kind: "task_team", companyId: own })).status).toBe(200);
    const grant = await alice.put(`/projects/${P1}/folders/${p.P1!.rootFolderId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: own, level: "view" }],
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  });

  it("only project administrators put companies on a project, and only ones they can see", async () => {
    const P2 = p.P2!.id;
    // Bob sees Riverside Design JV through P2; the system administrator puts any company on a project.
    expect((await admin.post(`/projects/${p.P1!.id}/companies`, { companyId: co["Yeni Firma"] })).status).toBe(200);
    expect(names((await alice.get("/companies")).body)).toContain("Yeni Firma");
    expect(names((await bob.get("/companies")).body)).not.toContain("Yeni Firma");
    // A plain member cannot.
    expect((await carol.post(`/projects/${p.P1!.id}/companies`, { companyId: co["Alfa Yapı"] })).status).toBe(403);
    // Bob takes a company off P2 while nothing uses it; the one his membership uses stays.
    expect((await bob.del(`/projects/${P2}/companies/${co["Riverside Design JV"]}`)).status).toBe(200);
    expect((await bob.del(`/projects/${P2}/companies/${co["Beta İnşaat"]}`)).status).toBe(409);
    expect(names((await bob.get(`/projects/${P2}/companies`)).body)).toEqual(["Beta İnşaat", "Riverside Metro Authority"]);
    expect(names((await bob.get("/companies")).body)).toEqual(["Beta İnşaat", "Riverside Metro Authority"]);
  });

  it("the user directory shows only people who share a project (plus oneself)", async () => {
    const emails = (rows: { email: string }[]) => rows.map((r) => r.email).sort();
    // The system administrator created both projects, so is a member of both.
    expect(emails((await alice.get("/users")).body)).toEqual(["admin@7d.test", "alice@a.test", "carol@a.test"]);
    expect(emails((await carol.get("/users")).body)).toEqual(["admin@7d.test", "alice@a.test", "carol@a.test"]);
    expect(emails((await bob.get("/users")).body)).toEqual(["admin@7d.test", "bob@b.test"]);
    // The system administrator sees everyone.
    expect(emails((await admin.get("/users")).body)).toEqual(["admin@7d.test", "alice@a.test", "bob@b.test", "carol@a.test"]);
    // A project administrator still adds an existing account by its exact e-mail; then both see each other.
    expect((await alice.post(`/projects/${p.P1!.id}/members`, { email: "bob@b.test" })).status).toBe(200);
    expect(emails((await bob.get("/users")).body)).toEqual(["admin@7d.test", "alice@a.test", "bob@b.test", "carol@a.test"]);
    // An archived project no longer connects people.
    expect((await admin.del(`/projects/${p.P1!.id}`)).status).toBe(200);
    expect(emails((await bob.get("/users")).body)).toEqual(["admin@7d.test", "bob@b.test"]);
    expect(emails((await alice.get("/users")).body)).toEqual(["alice@a.test"]);
  });
});
