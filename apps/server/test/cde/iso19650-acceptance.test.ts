/**
 * ISO19650 acceptance scenario (ISO-13, docs/compliance/ISO19650.md "Acceptance scenario"): one
 * project created from the ISO 19650 template ("iso19650-temel", enforcement on) walked through the
 * acceptance criteria of ISO-1 … ISO-5 in sequence, as four parties (client, consultant, designer,
 * contractor) would use it:
 *
 *  1. the template switches the rules on (D-7, D-8, D-10) and makes one task team per party (D-4);
 *  2. a direct write into Published and a WIP → Published move are refused, administrators included;
 *  3. a suitability code that does not fit the state is refused;
 *  4. another task team's WIP is 404 over the API;
 *  5. a document code held by another container is refused;
 *  6. an approved review copies the document to Shared, then (two steps) to Published, with codes;
 *  7. a new publication archives the previous one as superseded;
 *  8. a rejected document returns to WIP (S0), its Shared copy is withdrawn;
 *  9. every step is in the audit log, the chain checks, and a tampered row is found.
 *
 * Core only: passes with and without Enterprise modules.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AuditVerifyDto, CdeSettingsDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, documentCodes, fileVersions, files, folders, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-iso-acceptance-"));
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
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
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
    upload: async (url: string, name: string, fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("file", new Blob([`%PDF-1.4 ${name} ${Math.random()}`]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "accept-language": "en", "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

async function latest(fileId: string) {
  const [f] = await handle.db.select().from(files).where(eq(files.id, fileId));
  const [v] = await handle.db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, f!.currentVersion)));
  return { file: f!, version: v! };
}

async function fileIn(folderId: string, name: string) {
  const [f] = await handle.db.select().from(files).where(and(eq(files.folderId, folderId), eq(files.name, name)));
  return f;
}

/** The project's audit actions on one target, oldest first. */
async function actionsOn(targetId: string) {
  const rows = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, targetId)).orderBy(asc(auditLog.id));
  return rows.map((r) => r.action);
}

describe("ISO19650-1 12 / -2 5.1.7 acceptance: one ISO template project, enforcement on", () => {
  let admin: Api, client: Api, consultant: Api, designer: Api, contractor: Api;
  let pid: string;
  let settings: CdeSettingsDto;
  const F = {} as { wip: string; wipDesigner: string; wipContractor: string; shared: string; published: string; archived: string };
  const P = () => `/projects/${pid}`;
  // Names under the template's "ISO 19650 Kodlama" standard: project-originator-volume-level-type-role-number.
  const DOC1 = "ACC-TSR-ZZ-01-DR-A-0001.pdf";
  const DOC2 = "ACC-TSR-ZZ-01-DR-A-0002.pdf";
  const DOC3 = "ACC-TSR-ZZ-01-DR-A-0003.pdf";
  let doc1: string; // the designer's WIP file
  let doc1Shared: string;
  let doc1Published: string;
  let firstPublication: { storageKey: string };

  /** Starts a review as the project administrator; returns the review and its file rows. */
  async function start(workflow: string, fileId: string, targetFolderId: string, targetSuitability?: string) {
    const versionId = (await latest(fileId)).version.id;
    const r = await admin.post(`${P()}/reviews`, { templateId: workflow, versionIds: [versionId], targetFolderId, name: `ISO ${Math.random()}`, ...(targetSuitability ? { targetSuitability } : {}) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { id: string; files: { id: string }[] };
  }
  async function decide(who: Api, review: { id: string; files: { id: string }[] }, outcome: string) {
    const r = await who.post(`${P()}/reviews/${review.id}/submit`, { files: review.files.map((f) => ({ reviewFileId: f.id, outcome })) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  }
  const teamCheck = () => settings.transitions.find((t) => t.fromState === "wip" && t.toState === "shared")!.workflowTemplateId!;
  const publication = () => settings.transitions.find((t) => t.fromState === "shared" && t.toState === "published")!.workflowTemplateId!;
  /** WIP → Shared through the team check (one step: project administrators). */
  async function share(fileId: string, outcome: string, suitability?: string) {
    return decide(admin, await start(teamCheck(), fileId, F.shared, suitability), outcome);
  }
  /** Shared → Published through the two-step publication review: consultant, then client. */
  async function publish(fileId: string, suitability: string) {
    const r = await start(publication(), fileId, F.published, suitability);
    await decide(consultant, r, "approved");
    return decide(client, r, "approved");
  }

  it("creates the project from the ISO template: rules on, four parties, one task team each", async () => {
    admin = api(await login("admin@7d.test"));
    const parties = [
      ["idare", "client", "Idare Kurumu", "IDR"],
      ["musavir", "consultant", "Musavir Muhendislik", "MSV"],
      ["tasarimci", "designer", "Tasarim Ofisi", "TSR"],
      ["yuklenici", "contractor", "Yuklenici Insaat", "YKL"],
    ] as const;
    const slotCompanies: Record<string, string> = {};
    for (const [slot, who, name, code] of parties) {
      const c = await admin.post("/companies", { name, code });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      slotCompanies[slot] = c.body.id;
      const u = await admin.post("/users", { email: `${who}@iso.test`, name: who, password: PW, companyId: c.body.id });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
    }
    const r = await admin.post("/projects/from-template", { code: "ACC", name: "ISO acceptance", templateId: "iso19650-temel", slotCompanies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pid = r.body.id;
    for (const [, who] of parties) expect((await admin.post(`${P()}/members`, { email: `${who}@iso.test` })).status).toBe(200);
    client = api(await login("client@iso.test"));
    consultant = api(await login("consultant@iso.test"));
    designer = api(await login("designer@iso.test"));
    contractor = api(await login("contractor@iso.test"));

    settings = (await admin.get(`${P()}/cde/settings`)).body;
    expect(settings).toMatchObject({ enforceTransitions: true, codeScheme: "iso_uk_na", wipPolicy: "team_only", adminSeesWip: true });
    expect(settings.transitions.map((t) => `${t.fromState ?? "upload"}→${t.toState}:${t.mode}`)).toEqual([
      "upload→wip:direct",
      "wip→shared:review",
      "shared→wip:auto",
      "shared→published:review",
      "published→archived:auto",
    ]);

    const all = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    const top = (state: string) => all.find((f) => f.state === state && f.parentId === r.body.rootFolderId)!.id;
    F.wip = top("wip");
    F.shared = top("shared");
    F.published = top("published");
    F.archived = top("archived");
    expect(settings.archiveFolderId).toBe(F.archived);
    F.wipDesigner = all.find((f) => f.parentId === F.wip && f.name === "Tasarımcı")!.id;
    F.wipContractor = all.find((f) => f.parentId === F.wip && f.name === "Yüklenici")!.id;
    const teams = (await admin.get(`${P()}/roles`)).body.filter((t: { kind: string }) => t.kind === "task_team");
    expect(teams.map((t: { code: string }) => t.code).sort()).toEqual(["IDR", "MSV", "TSR", "YKL"]);

    // Configuration step (docs/compliance/ISO19650.md "How to enable"): register document codes
    // from WIP on, with the template's naming standard as the project's container standard.
    const standards = (await admin.get(`${P()}/naming-standards`)).body as { id: string; definition: { name: string } }[];
    const iso = standards.find((s) => s.definition.name === "ISO 19650 Kodlama")!;
    expect((await admin.put(`${P()}/cde/settings`, { containerStandardId: iso.id })).status).toBe(200);
    settings = (await admin.get(`${P()}/cde/settings`)).body;
    expect(settings).toMatchObject({ enforceTransitions: true, containerStandardId: iso.id });
  });

  it("refuses a direct write into Published and a WIP → Published move, for administrators too (ISO-1)", async () => {
    const direct = await admin.upload(`${P()}/folders/${F.published}/files`, DOC1, { suitabilityCode: "A1", revisionCode: "C01" });
    expect(direct.status).toBe(403);
    // The template gates Shared and Published (folder gate) on top of the transition table.
    expect(direct.body.message).toMatch(/approved review/);
    expect((await admin.upload(`${P()}/folders/${F.shared}/files`, DOC1)).status).toBe(403);

    const w = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, "ACC-TSR-ZZ-01-DR-A-0099.pdf");
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const id = w.body.results[0].fileId;
    // The designer has no write right on Published at all; the administrator has, and is refused by the rules.
    expect((await designer.patch(`${P()}/files/${id}`, { folderId: F.published })).status).toBe(403);
    const moved = await admin.patch(`${P()}/files/${id}`, { folderId: F.published });
    expect(moved.status).toBe(403);
    expect(moved.body.message).toBe("The project's ISO 19650 rules do not allow a document to go from Work in Progress to Published.");
    expect((await admin.post(`${P()}/files/${id}/copy`, { folderId: F.published })).status).toBe(403);
    expect(await handle.db.select().from(files).where(eq(files.folderId, F.published))).toEqual([]);
  });

  it("refuses a suitability or revision code that does not fit the state (ISO-2)", async () => {
    const wrong = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC1, { suitabilityCode: "A1" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.results[0].errors[0]).toBe("Suitability code A1 cannot be used in Work in Progress. Allowed here: S0.");
    const rev = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC1, { revisionCode: "C01" });
    expect(rev.status).toBe(400);
    expect(await fileIn(F.wipDesigner, DOC1)).toBeUndefined();

    // Without codes the project fills in S0 and the first WIP revision.
    const ok = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC1);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    doc1 = ok.body.results[0].fileId;
    const { file, version } = await latest(doc1);
    expect(version).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });
    expect(file.documentCode).toBe("ACC-TSR-ZZ-01-DR-A-0001");
  });

  it("keeps a task team's WIP from the other teams: 404 over the API (ISO-5)", async () => {
    for (const outsider of [contractor, consultant, client]) {
      expect((await outsider.get(`${P()}/files/${doc1}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/files/${doc1}/history`)).status).toBe(404);
      expect((await outsider.get(`${P()}/folders/${F.wipDesigner}`)).status).toBe(404);
      expect((await outsider.get(`${P()}/folders/${F.wipDesigner}/contents`)).status).toBe(404);
    }
    expect((await designer.get(`${P()}/files/${doc1}`)).status).toBe(200);
    expect((await contractor.get(`${P()}/folders/${F.wipContractor}`)).status).toBe(200);
  });

  it("refuses a document code another container holds (ISO-3)", async () => {
    const dup = await contractor.upload(`${P()}/folders/${F.wipContractor}/files`, DOC1);
    expect(dup.status).toBe(400);
    // The holder sits in another team's WIP: the refusal does not reveal where (ISO-5).
    expect(dup.body.results[0].conflict).toMatchObject({ kind: "document_code", code: "ACC-TSR-ZZ-01-DR-A-0001", existingPath: "…", existingFileId: null });
    expect(await fileIn(F.wipContractor, DOC1)).toBeUndefined();
    const held = await handle.db.select().from(documentCodes).where(eq(documentCodes.projectId, pid));
    expect(held.map((c) => c.codeNorm)).toContain("ACC-TSR-ZZ-01-DR-A-0001");
    // A rendition of the same document (another extension) is the same container (D-6).
    expect((await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, "ACC-TSR-ZZ-01-DR-A-0001.dwg")).status).toBe(200);
  });

  it("copies an approved document to Shared with the chosen suitability and P01, visible to every party (ISO-1, ISO-2, ISO-5)", async () => {
    await share(doc1, "approved", "S2");
    const copy = (await fileIn(F.shared, DOC1))!;
    doc1Shared = copy.id;
    const { file, version } = await latest(doc1Shared);
    expect(file.containerId).toBe((await latest(doc1)).file.containerId);
    expect(file.documentCode).toBe("ACC-TSR-ZZ-01-DR-A-0001");
    expect(version).toMatchObject({ suitabilityCode: "S2", revisionCode: "P01" });
    // The WIP original stays where it is, still private to its team.
    expect((await latest(doc1)).file.folderId).toBe(F.wipDesigner);
    for (const party of [contractor, consultant, client]) expect((await party.get(`${P()}/files/${doc1Shared}`)).status).toBe(200);
  });

  it("publishes through the two-step review (consultant, then client) as A1 / C01 (ISO-1)", async () => {
    await publish(doc1Shared, "A1");
    const pub = (await fileIn(F.published, DOC1))!;
    doc1Published = pub.id;
    const { file, version } = await latest(doc1Published);
    expect(file.containerId).toBe((await latest(doc1)).file.containerId);
    expect(version).toMatchObject({ suitabilityCode: "A1", revisionCode: "C01" });
    firstPublication = { storageKey: version.storageKey };
    expect(await fileIn(F.archived, DOC1)).toBeUndefined();
  });

  it("archives the previous publication as superseded when a new revision is published (ISO-1, D-10)", async () => {
    expect((await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC1)).status).toBe(200);
    expect((await latest(doc1)).version.revisionCode).toBe("P01.02");
    await share(doc1, "approved", "S3");
    expect((await latest(doc1Shared)).version).toMatchObject({ suitabilityCode: "S3", revisionCode: "P02" });
    await publish(doc1Shared, "A2");
    const current = await latest(doc1Published);
    expect(current.version).toMatchObject({ version: 2, suitabilityCode: "A2", revisionCode: "C02" });
    expect(current.file.cdeStatus).toBeNull();

    const archived = (await fileIn(F.archived, DOC1))!;
    expect(archived).toMatchObject({ cdeStatus: "superseded", containerId: current.file.containerId });
    expect((await latest(archived.id)).version).toMatchObject({ storageKey: firstPublication.storageKey, suitabilityCode: "A1", revisionCode: "C01" });
    expect(await actionsOn(archived.id)).toEqual(expect.arrayContaining(["cde.superseded", "cde.transition"]));
    // Nobody writes into the archive directly.
    expect((await admin.upload(`${P()}/folders/${F.archived}/files`, "ACC-TSR-ZZ-01-DR-A-0098.pdf")).status).toBe(403);
  });

  it("returns a document the team check sends back to WIP: returned, S0, no Shared copy (ISO-1, D-2)", async () => {
    const w = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC2);
    const id = w.body.results[0].fileId;
    await share(id, "revise_resubmit", "S2");
    const after = await latest(id);
    expect(after.file).toMatchObject({ cdeStatus: "returned", folderId: F.wipDesigner });
    expect(after.version.suitabilityCode).toBe("S0");
    expect(await fileIn(F.shared, DOC2)).toBeUndefined();
    expect(await actionsOn(id)).toContain("cde.returned");
  });

  it("withdraws a Shared copy the client rejects and returns its WIP original (ISO-1, D-2)", async () => {
    const w = await designer.upload(`${P()}/folders/${F.wipDesigner}/files`, DOC3);
    const id = w.body.results[0].fileId;
    await share(id, "approved", "S4");
    const shared = (await fileIn(F.shared, DOC3))!;
    const r = await start(publication(), shared.id, F.published, "A1");
    await decide(consultant, r, "approved");
    await decide(client, r, "rejected");
    expect((await latest(shared.id)).file.cdeStatus).toBe("withdrawn");
    expect((await latest(id)).file.cdeStatus).toBe("returned");
    expect(await fileIn(F.published, DOC3)).toBeUndefined();
    const [back] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "cde.transition"), eq(auditLog.targetId, id)));
    expect(back!.details).toMatchObject({ fromState: "shared", toState: "wip", mode: "auto" });
  });

  it("records the scenario in the audit log, checks the chain and finds a tampered row (ISO-4)", async () => {
    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.projectId, pid))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["file.uploaded", "review.submitted", "cde.transition", "cde.superseded", "cde.returned", "cde.withdrawn"]));
    const log = await admin.get(`${P()}/audit?action=cde.*&limit=200`);
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    expect(log.body.entries.length).toBeGreaterThan(0);
    expect((await designer.get(`${P()}/audit`)).status).toBe(403);

    const ok = (await admin.get("/admin/audit/verify")).body as AuditVerifyDto;
    expect(ok).toMatchObject({ ok: true, broken: null });

    // Change one row behind the triggers' back, as someone with database access could.
    const [victim] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "cde.superseded")));
    await handle.db.execute(sql.raw(`alter table audit_log disable trigger audit_log_immutable`));
    await handle.db.execute(sql.raw(`update audit_log set details = '{"forged": true}' where id = ${victim!.id}`));
    await handle.db.execute(sql.raw(`alter table audit_log enable trigger audit_log_immutable`));
    const bad = (await admin.get("/admin/audit/verify")).body as AuditVerifyDto;
    expect(bad).toMatchObject({ ok: false, broken: { id: victim!.id, reason: "hash_mismatch" } });
  });
});
