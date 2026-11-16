import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, users } from "../../../src/db/schema.js";
import { msg, render } from "../../../src/i18n/index.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(path.join(here, "../../fixtures", "schedule.csv"));
const PW = "Sifre-1234567";
const tr = (key: Parameters<typeof msg>[0], params?: Record<string, unknown>) => render("tr", msg(key, params as never));

type Act = { id: string; code: string; start: string | null; finish: string | null; durationDays: number | null; critical: boolean; wbsPath: string | null; outlineLevel: number; parentId: string | null; summary: boolean };

describe("İş programı hazırlama, hesaplama ve kaynak yükleme API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-authoring-"));
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

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  function client(cookie: string) {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
      return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : null };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      patch: (u: string, p: unknown) => call("PATCH", u, p),
      del: (u: string) => call("DELETE", u),
      upload: async (url: string, name: string, data: Buffer) => {
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

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let pid: string;
  let sid: string;
  const ids: Record<string, string> = {};
  const S = () => `/projects/${pid}/schedules/${sid}`;

  async function activities(scheduleId = sid): Promise<Act[]> {
    const r = await admin.get(`/projects/${pid}/schedules/${scheduleId}/activities`);
    expect(r.status).toBe(200);
    return r.body;
  }
  const byCode = (list: Act[], code: string) => list.find((a) => a.code === code)!;

  it("creates an empty programme from scratch (planners only)", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    pid = (await admin.post("/projects", { code: "INR", name: "Hat projesi" })).body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));

    expect((await member.post(`/projects/${pid}/schedules/new`, { name: "X", startDate: "2027-01-04" })).status).toBe(403);
    expect((await admin.post(`/projects/${pid}/schedules/new`, { name: "X", startDate: "04.01.2027" })).status).toBe(400);
    const r = await admin.post(`/projects/${pid}/schedules/new`, { name: "Hat programı", startDate: "2027-01-04" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ name: "Hat programı", version: 1, sourceType: "manual", isBaseline: false, activityCount: 0, startDate: "2027-01-04", dataDate: "2027-01-04" });
    sid = r.body.id;
    expect(await activities()).toEqual([]);
  });

  it("adds WBS nodes, tasks and milestones in outline order", async () => {
    const add = async (body: Record<string, unknown>) => {
      const r = await admin.post(`${S()}/activities`, body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      ids[r.body.code] = r.body.id;
      return r.body;
    };
    const w1 = await add({ code: "W1", name: "Hazırlık", summary: true });
    expect(w1).toMatchObject({ summary: true, start: null, wbsPath: "W1", outlineLevel: 1 });
    const a = await add({ code: "A", name: "Mobilizasyon", parentId: ids.W1, start: "2027-01-04", durationDays: 5 });
    // Mon–Sat calendar (default): 4–8 Jan
    expect(a).toMatchObject({ start: "2027-01-04", finish: "2027-01-08", durationDays: 5, wbsPath: "W1", outlineLevel: 2, parentId: ids.W1 });
    const b = await add({ code: "B", name: "Şantiye", parentId: ids.W1, durationDays: 3 });
    expect(b).toMatchObject({ start: "2027-01-04", finish: "2027-01-06" });
    const m = await add({ code: "M", name: "Hazırlık bitti", parentId: ids.W1, milestone: true });
    expect(m).toMatchObject({ milestone: true, durationDays: 0, start: "2027-01-04", finish: "2027-01-04" });
    await add({ code: "C", name: "Tasarım", start: "2027-01-04", finish: "2027-01-05" });
    await add({ code: "A2", name: "Ara iş", afterId: ids.A, durationDays: 1 });

    expect((await activities()).map((x) => x.code)).toEqual(["W1", "A", "A2", "B", "M", "C"]);
    expect(byCode(await activities(), "A2").parentId).toBe(ids.W1);
    const s = (await admin.get(S())).body;
    expect(s).toMatchObject({ activityCount: 5, startDate: "2027-01-04" });
  });

  it("rejects bad activities and keeps codes unique", async () => {
    const dup = await admin.post(`${S()}/activities`, { code: "A", name: "Tekrar" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe(tr("schedule:errors.codeTaken", { code: "A" }));
    expect((await admin.post(`${S()}/activities`, { code: "Z", name: "Z", parentId: ids.A })).body.message).toBe(tr("schedule:errors.parentNotSummary"));
    expect((await admin.post(`${S()}/activities`, { code: "Z", name: "Z", start: "2027-01-05", finish: "2027-01-01" })).body.message).toBe(tr("schedule:errors.finishBeforeStart"));
    expect((await admin.post(`${S()}/activities`, { code: "Z", name: "Z", actualFinish: "2027-01-05" })).body.message).toBe(tr("schedule:errors.actualFinishNeedsStart"));
    expect((await admin.post(`${S()}/activities`, { code: "Z", name: "Z", parentId: ids.W1, afterId: ids.C })).body.message).toBe(tr("schedule:errors.afterNotSibling"));
    expect((await member.post(`${S()}/activities`, { code: "Z", name: "Z" })).status).toBe(403);
    expect((await member.patch(`${S()}/activities/${ids.A}`, { name: "Z" })).status).toBe(403);
    expect((await member.del(`${S()}/activities/${ids.A}`)).status).toBe(403);
  });

  it("deletes tasks, and WBS nodes only when empty", async () => {
    const full = await admin.del(`${S()}/activities/${ids.W1}`);
    expect(full.status).toBe(409);
    expect(full.body.message).toBe(tr("schedule:errors.summaryNotEmpty"));
    expect((await admin.del(`${S()}/activities/${ids.A2}`)).status).toBe(200);
    const w9 = await admin.post(`${S()}/activities`, { code: "W9", name: "Boş", summary: true });
    expect((await admin.del(`${S()}/activities/${w9.body.id}`)).status).toBe(200);
    expect((await activities()).map((x) => x.code)).toEqual(["W1", "A", "B", "M", "C"]);
  });

  it("links activities and rejects self links, duplicates, WBS links and loops", async () => {
    const link = (predId: string, succId: string, extra: Record<string, unknown> = {}) => admin.post(`${S()}/dependencies`, { predId, succId, ...extra });
    const ab = await link(ids.A, ids.B);
    expect(ab.status, JSON.stringify(ab.body)).toBe(200);
    expect(ab.body).toMatchObject({ predId: ids.A, succId: ids.B, type: "FS", lagDays: 0 });
    ids.AB = ab.body.id;
    expect((await link(ids.B, ids.M)).status).toBe(200);
    expect((await link(ids.A, ids.A)).body.message).toBe(tr("schedule:errors.selfLink"));
    expect((await link(ids.A, ids.B, { type: "SS" })).status).toBe(409);
    expect((await link(ids.B, ids.A)).body.message).toBe(tr("schedule:errors.dependencyExists"));
    const loop = await link(ids.M, ids.A);
    expect(loop.status).toBe(400);
    expect(loop.body.message).toBe(tr("schedule:errors.dependencyLoop", { pred: "M", succ: "A" }));
    expect((await link(ids.W1, ids.C)).body.message).toBe(tr("schedule:errors.summaryLink"));
    expect((await member.post(`${S()}/dependencies`, { predId: ids.C, succId: ids.A })).status).toBe(403);
    // Not recalculated yet: B still starts on its own date.
    expect(byCode(await activities(), "B").start).toBe("2027-01-04");
    expect((await admin.get(`${S()}/dependencies`)).body).toHaveLength(2);
  });

  it("calculates the programme: early dates, critical flag, WBS roll-up, version dates", async () => {
    const r = await admin.post(`${S()}/schedule`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ finish: "2027-01-12", critical: 3, loops: [] });
    expect(r.body.schedule).toMatchObject({ startDate: "2027-01-04", finishDate: "2027-01-12", activityCount: 4 });
    const list = await activities();
    // B after A (Fri 8): Sat 9, Mon 11, Tue 12
    expect(byCode(list, "B")).toMatchObject({ start: "2027-01-09", finish: "2027-01-12", durationDays: 3, critical: true });
    expect(byCode(list, "M")).toMatchObject({ start: "2027-01-12", finish: "2027-01-12", critical: true });
    expect(byCode(list, "A").critical).toBe(true);
    expect(byCode(list, "C")).toMatchObject({ start: "2027-01-04", finish: "2027-01-05", critical: false });
    expect(byCode(list, "W1")).toMatchObject({ start: "2027-01-04", finish: "2027-01-12" });
    // A second run changes nothing.
    expect((await admin.post(`${S()}/schedule`)).body.updated).toBe(0);
  });

  it("edits dates without recalculating; the next calculation moves successors", async () => {
    const p = await admin.patch(`${S()}/activities/${ids.A}`, { durationDays: 6 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ start: "2027-01-04", finish: "2027-01-09", durationDays: 6 });
    expect(byCode(await activities(), "B").start).toBe("2027-01-09");
    await admin.post(`${S()}/schedule`);
    expect(byCode(await activities(), "B")).toMatchObject({ start: "2027-01-11", finish: "2027-01-13" });
    expect((await admin.patch(`${S()}/activities/${ids.A}`, { finish: "2027-01-08" })).body).toMatchObject({ durationDays: 5, finish: "2027-01-08" });
    expect((await admin.patch(`${S()}/activities/${ids.W1}`, { milestone: true })).body.message).toBe(tr("schedule:errors.summaryMilestone"));
    expect((await admin.patch(`${S()}/activities/${ids.W1}`, { parentId: ids.W1 })).body.message).toBe(tr("schedule:errors.parentLoop"));
    await admin.post(`${S()}/schedule`);
  });

  it("moves an activity under a WBS node and renames a node", async () => {
    const r = await admin.patch(`${S()}/activities/${ids.C}`, { parentId: ids.W1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ parentId: ids.W1, wbsPath: "W1", outlineLevel: 2 });
    expect((await activities()).map((x) => x.code)).toEqual(["W1", "A", "B", "M", "C"]);
    await admin.patch(`${S()}/activities/${ids.W1}`, { code: "HZ" });
    const list = await activities();
    expect(list.map((x) => x.wbsPath)).toEqual(["HZ", "HZ", "HZ", "HZ", "HZ"]);
    await admin.patch(`${S()}/activities/${ids.W1}`, { code: "W1" });
    expect((await admin.del(`${S()}/dependencies/${ids.AB}`)).status).toBe(200);
    expect((await admin.post(`${S()}/dependencies`, { predId: ids.A, succId: ids.B })).status).toBe(200);
  });

  it("manages the resource library (planners write, members read)", async () => {
    const R = `/projects/${pid}/schedule-resources`;
    const r1 = await admin.post(R, { code: "EKP", name: "Ray ekibi", kind: "labor", unit: "kişi", unitCost: 100, maxPerDay: 5 });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ code: "EKP", kind: "labor", unitCost: 100, maxPerDay: 5, assignmentCount: 0 });
    ids.R1 = r1.body.id;
    const r2 = await admin.post(R, { code: "VNC", name: "Vinç", kind: "equipment" });
    expect(r2.body).toMatchObject({ unit: "", unitCost: 0, maxPerDay: null });
    ids.R2 = r2.body.id;
    const dup = await admin.post(R, { code: "EKP", name: "Tekrar", kind: "labor" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe(tr("schedule:errors.resourceCodeTaken", { code: "EKP" }));
    expect((await admin.post(R, { code: "X", name: "X", kind: "people" })).status).toBe(400);
    expect((await member.post(R, { code: "X", name: "X", kind: "labor" })).status).toBe(403);
    expect((await admin.patch(`${R}/${ids.R1}`, { unitCost: 120 })).body.unitCost).toBe(120);
    expect((await admin.patch(`${R}/${ids.R2}`, { code: "EKP" })).status).toBe(409);
    expect((await admin.patch(`${R}/${ids.R2}`, { unitCost: 1000 })).status).toBe(200);
    expect((await member.patch(`${R}/${ids.R1}`, { unitCost: 1 })).status).toBe(403);
    const list = await member.get(R);
    expect(list.body.map((r: { code: string }) => r.code)).toEqual(["EKP", "VNC"]);
  });

  it("assigns resources to activities (replace list)", async () => {
    const A = (code: string) => `${S()}/activities/${ids[code]}/assignments`;
    const a = await admin.put(A("A"), { items: [{ resourceId: ids.R1, quantityPerDay: 4 }] });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    // A: 4–8 Jan = 5 working days × 4 = 20 units × 120
    expect(a.body).toEqual([expect.objectContaining({ resourceId: ids.R1, quantityPerDay: 4, workDays: 5, totalQuantity: 20, cost: 2400, resource: expect.objectContaining({ code: "EKP" }) })]);
    expect((await admin.put(A("B"), { items: [{ resourceId: ids.R1, quantityPerDay: 3 }, { resourceId: ids.R2, quantityPerDay: 1 }] })).status).toBe(200);
    expect((await admin.put(A("C"), { items: [{ resourceId: ids.R1, quantityPerDay: 3 }] })).status).toBe(200);
    expect((await admin.put(A("W1"), { items: [{ resourceId: ids.R1, quantityPerDay: 1 }] })).body.message).toBe(tr("schedule:errors.summaryAssignment"));
    expect((await admin.put(A("A"), { items: [{ resourceId: ids.R1, quantityPerDay: 1 }, { resourceId: ids.R1, quantityPerDay: 2 }] })).body.message).toBe(tr("schedule:errors.duplicateAssignment"));
    expect((await admin.put(A("A"), { items: [{ resourceId: ids.R1, quantityPerDay: 0 }] })).status).toBe(400);
    expect((await member.put(A("A"), { items: [] })).status).toBe(403);
    expect((await member.get(A("B"))).body).toHaveLength(2);
    expect((await admin.get(`/projects/${pid}/schedule-resources`)).body[0].assignmentCount).toBe(3);
  });

  it("builds the resource histogram from CPM dates with capacity and over-allocation", async () => {
    const day = await member.get(`${S()}/resource-histogram?resourceId=${ids.R1}&step=day`);
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    // 4–5 Jan: A 4 + C 3 = 7 > 5 per day
    expect(day.body.periods[0]).toMatchObject({ start: "2027-01-04", quantity: 7, capacity: 5, peakPerDay: 7, overallocated: true, cost: 840 });
    expect(day.body.periods[2]).toMatchObject({ start: "2027-01-06", quantity: 4, overallocated: false });
    const week = await member.get(`${S()}/resource-histogram?resourceId=${ids.R1}&step=week`);
    // week 1: A 20 + C 6 + B (Sat 9) 3 = 29; week 2: B 11, 12 = 6
    expect(week.body.periods.map((p: { start: string; quantity: number }) => [p.start, p.quantity])).toEqual([
      ["2027-01-04", 29],
      ["2027-01-11", 6],
    ]);
    const all = await member.get(`${S()}/resource-histogram`);
    expect(all.body.step).toBe("week");
    expect(all.body.periods[0].quantity).toBeNull();
    expect(all.body.totals).toEqual([
      expect.objectContaining({ code: "EKP", quantity: 35, cost: 4200, overallocatedDays: 2 }),
      expect.objectContaining({ code: "VNC", quantity: 3, cost: 3000 }),
    ]);
    expect(all.body.totalCost).toBe(7200);
    expect((await member.get(`${S()}/resource-histogram?step=year`)).status).toBe(400);
  });

  it("locks the baseline version; a new version copies activities, links and assignments", async () => {
    expect((await admin.patch(S(), { isBaseline: true })).status).toBe(200);
    const locked = await admin.patch(`${S()}/activities/${ids.A}`, { name: "Z" });
    expect(locked.status).toBe(409);
    expect(locked.body.message).toBe(tr("schedule:errors.baselineLocked"));
    expect((await admin.post(`${S()}/activities`, { code: "Z", name: "Z" })).status).toBe(409);
    expect((await admin.post(`${S()}/schedule`)).status).toBe(409);
    expect((await admin.post(`${S()}/dependencies`, { predId: ids.C, succId: ids.M })).status).toBe(409);
    expect((await admin.put(`${S()}/activities/${ids.A}/assignments`, { items: [] })).status).toBe(409);
    expect((await admin.del(`${S()}/activities/${ids.C}`)).status).toBe(409);

    expect((await member.post(`${S()}/versions`, {})).status).toBe(403);
    const v2 = await admin.post(`${S()}/versions`, { dataDate: "2027-01-11" });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    expect(v2.body).toMatchObject({ version: 2, isBaseline: false, activityCount: 4, dataDate: "2027-01-11", seriesId: sid });
    const list = await activities(v2.body.id);
    expect(list.map((x) => x.code)).toEqual(["W1", "A", "B", "M", "C"]);
    expect(byCode(list, "A").parentId).toBe(byCode(list, "W1").id);
    expect((await admin.get(`/projects/${pid}/schedules/${v2.body.id}/dependencies`)).body).toHaveLength(2);
    const asg = await admin.get(`/projects/${pid}/schedules/${v2.body.id}/activities/${byCode(list, "B").id}/assignments`);
    expect(asg.body).toHaveLength(2);
    expect((await admin.patch(`/projects/${pid}/schedules/${v2.body.id}/activities/${byCode(list, "A").id}`, { percentComplete: 50, actualStart: "2027-01-04" })).status).toBe(200);
    expect((await admin.post(`/projects/${pid}/schedules/${v2.body.id}/schedule`)).status).toBe(200);
  });

  it("keeps imported baselines read-only and deletes a resource with its assignments", async () => {
    const imp = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV);
    expect(imp.status).toBe(200);
    expect(imp.body.isBaseline).toBe(true);
    expect((await admin.post(`/projects/${pid}/schedules/${imp.body.id}/activities`, { code: "Z", name: "Z" })).status).toBe(409);

    expect((await admin.del(`/projects/${pid}/schedule-resources/${ids.R2}`)).status).toBe(200);
    expect((await admin.get(`${S()}/activities/${ids.B}/assignments`)).body).toHaveLength(1);
  });

  it("audits every write", async () => {
    const rows = await handle.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.projectId, pid));
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      "schedule.created",
      "schedule.version_created",
      "schedule.activity_created",
      "schedule.activity_updated",
      "schedule.activity_deleted",
      "schedule.dependency_added",
      "schedule.dependency_removed",
      "schedule.calculated",
      "schedule.resource_created",
      "schedule.resource_updated",
      "schedule.resource_deleted",
      "schedule.assignments_saved",
    ])
      expect(actions, a).toContain(a);
  });
});
