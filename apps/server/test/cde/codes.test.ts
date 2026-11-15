/**
 * ISO 19650 suitability and revision codes per version over the API (docs/features/CDE_STATES.md
 * "Codes"): the checkCodes guard per state, the legacy profile, legacy attribute lifting,
 * PATCH /versions/:vid/codes permissions, the approved review copy and the live-data migration.
 * ISO 19650-2 §5.1.7 with the UK National Annex.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, fileVersions, files, folders, projectCdeSettings, reviewFiles, reviews, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { copyApprovedFiles } from "../../src/workflow/review-finalization.js";
import { migrateLegacyCodes } from "../../src/cde/codes-migration.js";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-codes-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash, isAdmin: true },
    { email: "eda@7d.test", name: "Eda Editor", passwordHash },
    { email: "vural@7d.test", name: "Vural Viewer", passwordHash },
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

async function stateFolders(pid: string) {
  const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
  const of = (s: string) => fs.find((f) => f.state === s)!.id;
  return { wip: of("wip"), shared: of("shared"), published: of("published"), archived: of("archived") };
}

async function latest(fileId: string) {
  const [f] = await handle.db.select().from(files).where(eq(files.id, fileId));
  const [v] = await handle.db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, f!.currentVersion)));
  return v!;
}

let admin: Api;
let pid: string;

/** Switches the ISO 19650 enforcement of a project (D-8): codes that do not fit are refused only when on. */
async function enforce(project: string, on: boolean) {
  expect((await admin.put(`/projects/${project}/cde/settings`, { enforceTransitions: on })).status).toBe(200);
}
let F: Awaited<ReturnType<typeof stateFolders>>;

describe("ISO19650-2 5.1.7 / UK NA suitability: codes on upload, per state", () => {
  it("stores normalised codes that fit the folder's state", async () => {
    admin = api(await login("admin@7d.test"));
    pid = (await admin.post("/projects", { code: "COD", name: "Codes", template: "iso19650" })).body.id;
    F = await stateFolders(pid);
    const up = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "W-1.pdf", { suitabilityCode: "s0", revisionCode: "p1.1" });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const f = (await admin.get(`/projects/${pid}/files/${up.body.results[0].fileId}`)).body;
    expect(f.latest).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });
    const v = await latest(f.id);
    expect(v.codesSetBy).toBeTruthy();
    expect(v.codesSetAt).toBeTruthy();
    const [uploaded] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "file.uploaded"), eq(auditLog.targetId, f.id)));
    expect(uploaded!.details).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });

    for (const [folder, codes] of [
      [F.shared, { suitabilityCode: "S2", revisionCode: "P01" }],
      [F.published, { suitabilityCode: "A", revisionCode: "C01" }],
      [F.published, { suitabilityCode: "CR", revisionCode: "C02" }],
      [F.archived, { suitabilityCode: "B2", revisionCode: "P03.01" }],
    ] as const) {
      const r = await admin.upload(`/projects/${pid}/folders/${folder}/files`, `X-${codes.suitabilityCode}.pdf`, codes);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const [a] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "X-A.pdf")));
    expect((await latest(a!.id)).suitabilityCode).toBe("A1");
  });

  it("stores a code that does not fit the state with a warning when the project does not enforce the rules", async () => {
    const r = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "N-1.pdf", { suitabilityCode: "s2", revisionCode: "C01" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results[0].ok).toBe(true);
    expect(r.body.results[0].warnings).toEqual([
      { field: "suitabilityCode", kind: "suitabilityState", value: "S2", allowed: "S0", state: "wip", message: "Suitability code S2 cannot be used in Work in Progress. Allowed here: S0." },
      { field: "revisionCode", kind: "revisionState", value: "C01", allowed: "P01.01", state: "wip", message: "Revision C01 cannot be used in Work in Progress. Expected here: P01.01." },
    ]);
    expect(await latest(r.body.results[0].fileId)).toMatchObject({ suitabilityCode: "S2", revisionCode: "C01" });
    // A code outside the profile is kept too (as sent, normalised), with a warning.
    const s7 = await admin.upload(`/projects/${pid}/folders/${F.shared}/files`, "N-2.pdf", { suitabilityCode: "s7" });
    expect(s7.status).toBe(200);
    expect(s7.body.results[0].warnings[0]).toMatchObject({ kind: "suitabilityUnknown", value: "S7" });
    // A code that fits: no warning.
    const fine = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "N-3.pdf", { suitabilityCode: "S0" });
    expect(fine.body.results[0].warnings).toBeUndefined();
  });

  it("refuses a code that does not fit the state, with the allowed codes, when the project enforces the rules", async () => {
    await enforce(pid, true);
    const wrong = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "W-2.pdf", { suitabilityCode: "S2" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.results[0].errors[0]).toBe("Suitability code S2 cannot be used in Work in Progress. Allowed here: S0.");
    const rev = await admin.upload(`/projects/${pid}/folders/${F.shared}/files`, "S-2.pdf", { suitabilityCode: "S3", revisionCode: "C01" });
    expect(rev.body.results[0].errors[0]).toBe("Revision C01 cannot be used in Shared. Expected here: P01.");
    const pub = await admin.upload(`/projects/${pid}/folders/${F.published}/files`, "P-2.pdf", { suitabilityCode: "S4" });
    expect(pub.body.results[0].errors[0]).toMatch(/S4 cannot be used in Published\. Allowed here: A1…An, B1…Bn, CR/);
    const s7 = await admin.upload(`/projects/${pid}/folders/${F.shared}/files`, "S-3.pdf", { suitabilityCode: "S7" });
    expect(s7.body.results[0].errors[0]).toMatch(/S7 is not one of this project's codes/);
    // Nothing was stored.
    const names = (await handle.db.select().from(files).where(eq(files.projectId, pid))).map((f) => f.name);
    expect(names).not.toContain("W-2.pdf");
    expect(names).not.toContain("S-2.pdf");
    await enforce(pid, false);
  });

  it("a folder without a state accepts any code of the profile", async () => {
    const free = (await admin.post(`/projects/${pid}/folders`, { parentId: (await admin.get(`/projects/${pid}`)).body.rootFolderId, name: "Serbest" })).body.id;
    const r = await admin.upload(`/projects/${pid}/folders/${free}/files`, "F-1.pdf", { suitabilityCode: "S3", revisionCode: "C04" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await enforce(pid, true);
    const bad = await admin.upload(`/projects/${pid}/folders/${free}/files`, "F-2.pdf", { revisionCode: "R01" });
    expect(bad.body.results[0].errors[0]).toMatch(/Revision R01 does not follow the project's revision scheme/);
    await enforce(pid, false);
  });

  it("lifts the legacy attributes into the codes when they fit, and keeps the attributes", async () => {
    const r = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "L-1.pdf", {
      attributes: JSON.stringify({ "Uygunluk Kodu": "s0", Revizyon: "P02.01" }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.results[0].fileId;
    expect(await latest(id)).toMatchObject({ suitabilityCode: "S0", revisionCode: "P02.01" });
    const [f] = await handle.db.select().from(files).where(eq(files.id, id));
    expect(f!.attributes).toEqual({ "Uygunluk Kodu": "s0", Revizyon: "P02.01" });
    // Not enforced: a code of the profile is taken even when it does not fit the state (with a
    // warning); a value outside the profile stays an attribute only. The upload is not refused.
    const old = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "L-2.pdf", { attributes: JSON.stringify({ Uygunluk: "S2", Revizyon: "R01" }) });
    expect(old.status, JSON.stringify(old.body)).toBe(200);
    expect(old.body.results[0].warnings[0]).toMatchObject({ kind: "suitabilityState", value: "S2" });
    expect(await latest(old.body.results[0].fileId)).toMatchObject({ suitabilityCode: "S2", revisionCode: null });
    // Enforced: only values that fit the state are taken; the others stay attributes, no refusal.
    await enforce(pid, true);
    const strict = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "L-4.pdf", { attributes: JSON.stringify({ Uygunluk: "S2", Revizyon: "P01.01" }) });
    expect(strict.status, JSON.stringify(strict.body)).toBe(200);
    expect(await latest(strict.body.results[0].fileId)).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });
    await enforce(pid, false);
    // Codes given explicitly win over the attributes.
    const both = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "L-3.pdf", {
      attributes: JSON.stringify({ Revizyon: "P01.01" }),
      revisionCode: "P01.05",
    });
    expect(await latest(both.body.results[0].fileId)).toMatchObject({ revisionCode: "P01.05" });
  });

  it("does not check a code again when it equals the previous version's (grandfathered data)", async () => {
    await enforce(pid, true);
    const [w] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "W-1.pdf")));
    // Old data: a WIP version with a Shared code.
    await handle.db.update(fileVersions).set({ suitabilityCode: "S2" }).where(eq(fileVersions.fileId, w!.id));
    const again = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "W-1.pdf", { suitabilityCode: "S2", revisionCode: "P01.02" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const changed = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "W-1.pdf", { suitabilityCode: "S3" });
    expect(changed.status).toBe(400);
    await enforce(pid, false);
  });

  it("fills in S0 and the next revision when the project enforces the ISO 19650 rules", async () => {
    expect((await admin.put(`/projects/${pid}/cde/settings`, { enforceTransitions: true })).status).toBe(200);
    const one = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "E-1.pdf");
    const id = one.body.results[0].fileId;
    expect(await latest(id)).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.01" });
    await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "E-1.pdf");
    expect(await latest(id)).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.02" });
    expect((await admin.put(`/projects/${pid}/cde/settings`, { enforceTransitions: false })).status).toBe(200);
    // Not enforced: nothing is filled in.
    const two = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "E-2.pdf");
    expect(await latest(two.body.results[0].fileId)).toMatchObject({ suitabilityCode: null, revisionCode: null });
  });

  it("tells the web the folder's profile and state", async () => {
    const r = await admin.get(`/projects/${pid}/folders/${F.shared}/cde/codes`);
    expect(r.body).toEqual({ codeScheme: "iso_uk_na", suitabilityCodes: null, enforceTransitions: false, state: "shared" });
  });
});

describe("ISO19650-2 5.1.7 / UK NA suitability: legacy profile and project overrides", () => {
  it("legacy_r: R revisions in any state, no S/A split", async () => {
    const p = (await admin.post("/projects", { code: "LEG", name: "Legacy", template: "iso19650" })).body.id;
    const f = await stateFolders(p);
    expect((await admin.put(`/projects/${p}/cde/settings`, { codeScheme: "legacy_r", enforceTransitions: true })).status).toBe(200);
    const a = await admin.upload(`/projects/${p}/folders/${f.wip}/files`, "R-1.pdf", { suitabilityCode: "A1", revisionCode: "r1" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(await latest(a.body.results[0].fileId)).toMatchObject({ suitabilityCode: "A1", revisionCode: "R01" });
    const b = await admin.upload(`/projects/${p}/folders/${f.published}/files`, "R-2.pdf", { suitabilityCode: "S0" });
    // Enforced: the first revision is R00.
    expect(await latest(b.body.results[0].fileId)).toMatchObject({ suitabilityCode: "S0", revisionCode: "R00" });
    await admin.upload(`/projects/${p}/folders/${f.published}/files`, "R-2.pdf");
    expect(await latest(b.body.results[0].fileId)).toMatchObject({ suitabilityCode: "S0", revisionCode: "R01" });
    const bad = await admin.upload(`/projects/${p}/folders/${f.wip}/files`, "R-3.pdf", { revisionCode: "P01.01" });
    expect(bad.body.results[0].errors[0]).toMatch(/does not follow the project's revision scheme \(legacy R00\)/);
  });

  it("custom suitability codes replace the built-in list", async () => {
    const p = (await admin.post("/projects", { code: "CUS", name: "Custom", template: "iso19650" })).body.id;
    const f = await stateFolders(p);
    const s = await admin.put(`/projects/${p}/cde/settings`, {
      codeScheme: "custom",
      enforceTransitions: true,
      suitabilityCodes: [{ code: "S0", states: ["wip"] }, { code: "D1", description: "For costing", states: ["shared"] }],
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((await admin.upload(`/projects/${p}/folders/${f.shared}/files`, "C-1.pdf", { suitabilityCode: "d1" })).status).toBe(200);
    const no = await admin.upload(`/projects/${p}/folders/${f.shared}/files`, "C-2.pdf", { suitabilityCode: "S2" });
    expect(no.body.results[0].errors[0]).toMatch(/S2 is not one of this project's codes \(custom\)\. Allowed here: D1/);
  });
});

describe("ISO19650-2 5.1.7 / UK NA suitability: changing the codes of a version", () => {
  let eda: Api;
  let vural: Api;
  let wipVersion: string;
  let sharedVersion: string;
  let sharedFile: string;

  it("sets up members: an editor and a viewer", async () => {
    for (const email of ["eda@7d.test", "vural@7d.test"]) expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    const [e] = await handle.db.select().from(users).where(eq(users.email, "eda@7d.test"));
    const [v] = await handle.db.select().from(users).where(eq(users.email, "vural@7d.test"));
    for (const folder of [F.wip, F.shared])
      expect(
        (
          await admin.put(`/projects/${pid}/folders/${folder}/permissions`, {
            entries: [
              { subjectType: "user", subjectId: e!.id, level: "edit" },
              { subjectType: "user", subjectId: v!.id, level: "view" },
            ],
          })
        ).status,
      ).toBe(200);
    await enforce(pid, true);
    eda = api(await login("eda@7d.test"));
    vural = api(await login("vural@7d.test"));
    const w = await admin.upload(`/projects/${pid}/folders/${F.wip}/files`, "PATCH-W.pdf", { suitabilityCode: "S0", revisionCode: "P01.01" });
    wipVersion = (await latest(w.body.results[0].fileId)).id;
    const s = await admin.upload(`/projects/${pid}/folders/${F.shared}/files`, "PATCH-S.pdf", { suitabilityCode: "S1", revisionCode: "P01" });
    sharedFile = s.body.results[0].fileId;
    sharedVersion = (await latest(sharedFile)).id;
  });

  it("WIP: editors change the codes; viewers cannot; the rules apply", async () => {
    const ok = await eda.patch(`/projects/${pid}/versions/${wipVersion}/codes`, { revisionCode: "p1.2" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ id: wipVersion, suitabilityCode: "S0", revisionCode: "P01.02" });
    expect((await vural.patch(`/projects/${pid}/versions/${wipVersion}/codes`, { revisionCode: "P01.03" })).status).toBe(403);
    const wrong = await eda.patch(`/projects/${pid}/versions/${wipVersion}/codes`, { suitabilityCode: "A1" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/A1 cannot be used in Work in Progress/);
    const [row] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "file.codes_changed"), eq(auditLog.projectId, pid)));
    expect(row!.details).toMatchObject({
      versionId: wipVersion,
      state: "wip",
      before: { suitabilityCode: "S0", revisionCode: "P01.01" },
      after: { suitabilityCode: "S0", revisionCode: "P01.02" },
    });
    // Clearing a code is a change too.
    const cleared = await eda.patch(`/projects/${pid}/versions/${wipVersion}/codes`, { revisionCode: null });
    expect(cleared.body.revisionCode).toBeNull();
  });

  it("Shared: only project administrators, with a reason (audited as an override)", async () => {
    const editor = await eda.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { suitabilityCode: "S2", reason: "x" });
    expect(editor.status).toBe(403);
    expect(editor.body.message).toBe("Only project administrators can change the codes of a version in Shared.");
    const noReason = await admin.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { suitabilityCode: "S2" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toBe("Changing the codes of a version in Shared needs a reason.");
    const ok = await admin.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { suitabilityCode: "S2", reason: "Wrong code on upload" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.suitabilityCode).toBe("S2");
    const override = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "cde.override"), eq(auditLog.targetId, sharedFile)));
    expect(override).toHaveLength(1);
    expect(override[0]!.details).toMatchObject({ what: "codes", reason: "Wrong code on upload", before: { suitabilityCode: "S1" }, after: { suitabilityCode: "S2" } });
    const bad = await admin.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { revisionCode: "C01", reason: "x" });
    expect(bad.status).toBe(400);
    // The file DTO shows the new codes.
    expect((await admin.get(`/projects/${pid}/files/${sharedFile}`)).body.latest.suitabilityCode).toBe("S2");
    // Not enforced: the same permissions, but a code that does not fit is stored with a warning.
    await enforce(pid, false);
    expect((await eda.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { revisionCode: "C01", reason: "x" })).status).toBe(403);
    const warned = await admin.patch(`/projects/${pid}/versions/${sharedVersion}/codes`, { revisionCode: "C01", reason: "Contract revision" });
    expect(warned.status, JSON.stringify(warned.body)).toBe(200);
    expect(warned.body).toMatchObject({ revisionCode: "C01", warnings: [{ field: "revisionCode", kind: "revisionState", state: "shared", allowed: "P01" }] });
    expect(warned.body.warnings[0].message).toBe("Revision C01 cannot be used in Shared. Expected here: P01.");
    const wipWarn = await eda.patch(`/projects/${pid}/versions/${wipVersion}/codes`, { suitabilityCode: "A1" });
    expect(wipWarn.status).toBe(200);
    expect(wipWarn.body.warnings[0]).toMatchObject({ kind: "suitabilityState", value: "A1" });
  });

  it("an approved review copy carries the source version's codes", async () => {
    const [src] = await handle.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.name, "PATCH-W.pdf")));
    const v = await latest(src!.id);
    await handle.db.update(fileVersions).set({ suitabilityCode: "S0", revisionCode: "P01.04" }).where(eq(fileVersions.id, v.id));
    const [me] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    const [review] = await handle.db
      .insert(reviews)
      .values({ projectId: pid, number: 1, name: "R1", targetFolderId: F.shared, createdBy: me!.id })
      .returning();
    await handle.db.insert(reviewFiles).values({ reviewId: review!.id, fileId: src!.id, fileVersionId: v.id, sourceFolderId: F.wip, finalStatus: "approved" });
    const report = await copyApprovedFiles({ db: handle.db, jobs }, review!, me!.id);
    expect(report).toMatchObject({ approved: 1, copied: 1, failed: 0 });
    const copy = await latest(report.results[0]!.fileId!);
    expect(copy).toMatchObject({ suitabilityCode: "S0", revisionCode: "P01.04" });
  });
});

describe("ISO19650-2 5.1.7 / UK NA suitability: live-data migration", () => {
  /** A file with old attributes and no codes (as before codes were stored per version). */
  async function oldFile(project: string, folder: string, name: string, attributes: Record<string, string>) {
    const r = await admin.upload(`/projects/${project}/folders/${folder}/files`, name, { attributes: JSON.stringify(attributes) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.results[0].fileId as string;
    await handle.db.update(fileVersions).set({ suitabilityCode: null, revisionCode: null, codesSetAt: null, codesSetBy: null }).where(eq(fileVersions.fileId, id));
    return id;
  }
  const actions = async (project: string, action: string) =>
    handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, project), eq(auditLog.action, action)));

  it("copies valid values, chooses the scheme per project and reports what does not map; idempotent", async () => {
    const iso = (await admin.post("/projects", { code: "MIG1", name: "Mig ISO", template: "iso19650" })).body.id;
    const fi = await stateFolders(iso);
    const isoA = await oldFile(iso, fi.published, "M-1.pdf", { "Uygunluk Kodu": "A", Revizyon: "c1" });
    const isoB = await oldFile(iso, fi.shared, "M-2.pdf", { Uygunluk: "S9", Revizyon: "P02" });
    const isoOld = await oldFile(iso, fi.shared, "M-3.pdf", { Revizyon: "B" });
    const leg = (await admin.post("/projects", { code: "MIG2", name: "Mig legacy", template: "iso19650" })).body.id;
    const fl = await stateFolders(leg);
    const legA = await oldFile(leg, fl.wip, "L-1.pdf", { Revizyon: "R01", "Uygunluk Kodu": "S2" });
    const legB = await oldFile(leg, fl.wip, "L-2.pdf", { Revizyon: "Rev 3" });
    // A project whose settings were saved by a person keeps its scheme, even with R revisions.
    const kept = (await admin.post("/projects", { code: "MIG3", name: "Mig kept", template: "iso19650" })).body.id;
    const fk = await stateFolders(kept);
    expect((await admin.put(`/projects/${kept}/cde/settings`, { wipPolicy: "grants" })).status).toBe(200);
    const keptA = await oldFile(kept, fk.wip, "K-1.pdf", { Revizyon: "R02" });

    const first = await migrateLegacyCodes(handle.db, { batchSize: 2 });
    expect(first.versionsMapped).toBeGreaterThanOrEqual(4);
    expect(await latest(isoA)).toMatchObject({ suitabilityCode: "A1", revisionCode: "C01", codesSetBy: null });
    expect((await latest(isoA)).codesSetAt).toBeTruthy();
    expect(await latest(isoB)).toMatchObject({ suitabilityCode: null, revisionCode: "P02" });
    expect(await latest(isoOld)).toMatchObject({ suitabilityCode: null, revisionCode: null });
    expect(await latest(legA)).toMatchObject({ suitabilityCode: "S2", revisionCode: "R01" });
    expect(await latest(legB)).toMatchObject({ revisionCode: "R03" });
    expect(await latest(keptA)).toMatchObject({ revisionCode: null });
    const scheme = async (p: string) => (await handle.db.select().from(projectCdeSettings).where(eq(projectCdeSettings.projectId, p)))[0]!.codeScheme;
    expect(await scheme(iso)).toBe("iso_uk_na");
    expect(await scheme(leg)).toBe("legacy_r");
    expect(await scheme(kept)).toBe("iso_uk_na");
    // Attributes stay.
    const [fa] = await handle.db.select().from(files).where(eq(files.id, isoA));
    expect(fa!.attributes).toEqual({ "Uygunluk Kodu": "A", Revizyon: "c1" });

    // Unmapped values: reported in the audit log and by the endpoint.
    const [un] = await actions(iso, "cde.migration_unmapped");
    expect(un!.details).toMatchObject({ count: 2 });
    const list = await admin.get(`/projects/${iso}/cde/codes/unmapped`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { name: string; field: string; value: string }) => [i.name, i.field, i.value]).sort()).toEqual([
      ["M-2.pdf", "suitabilityCode", "S9"],
      ["M-3.pdf", "revisionCode", "B"],
    ]);
    expect((await actions(kept, "cde.migration_unmapped"))[0]!.details).toMatchObject({ count: 1 });
    expect((await actions(leg, "cde.codes_migrated"))[0]!.details).toMatchObject({ scheme: "legacy_r", schemeChosen: true, mapped: 2 });
    const eda = api(await login("eda@7d.test"));
    expect((await eda.get(`/projects/${iso}/cde/codes/unmapped`)).status).toBe(404);

    // A second run changes nothing and writes no new audit rows.
    const before = (await handle.db.select().from(auditLog)).length;
    const second = await migrateLegacyCodes(handle.db, { batchSize: 2 });
    expect(second).toMatchObject({ versionsMapped: 0, schemesChosen: 0 });
    expect((await handle.db.select().from(auditLog)).length).toBe(before);

    // A later change of scheme by an administrator is not undone by the next run.
    expect((await admin.put(`/projects/${leg}/cde/settings`, { codeScheme: "iso_uk_na" })).status).toBe(200);
    await oldFile(leg, fl.wip, "L-3.pdf", { Revizyon: "R07" });
    await migrateLegacyCodes(handle.db);
    expect(await scheme(leg)).toBe("iso_uk_na");
  });
});
