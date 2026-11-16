import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

describe("İş programı KPI panosu, gecikme bildirimleri ve aylık rapor API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  // Fake OpenAI-compatible model: answers a fixed narrative and records the prompt.
  let stub: Server;
  let stubUrl: string;
  const stubCalls: { system: string; user: string }[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-kpi-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 7) });
    await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
    stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
        const user = String(body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "");
        stubCalls.push({ system, user });
        const content = "<think>plan</think>Status\nThe programme is behind the baseline; A20 slipped because of rain.";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    stub.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  function client(cookie: string, lang = "en") {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": lang }, payload: payload as object });
      return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : null, raw: res.rawPayload, headers: res.headers };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      patch: (u: string, p: unknown) => call("PATCH", u, p),
      del: (u: string) => call("DELETE", u),
    };
  }

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let pid: string;
  let v1: string;
  let v2: string;
  let delayId: string;
  let reportId: string;
  const S = (id: string) => `/projects/${pid}/schedules/${id}`;

  it("sets up a baseline and a monthly update with progress", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    pid = (await admin.post("/projects", { code: "INR", name: "Hat projesi" })).body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));

    const s = await admin.post(`/projects/${pid}/schedules/new`, { name: "L4", startDate: "2026-01-05" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    v1 = s.body.id;
    const add = async (body: Record<string, unknown>) => {
      const r = await admin.post(`${S(v1)}/activities`, body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.id as string;
    };
    const a10 = await add({ code: "A10", name: "Earthworks", start: "2026-01-05", durationDays: 10 });
    const hp1 = await add({ code: "HP1", name: "ITP hold point", milestone: true, start: "2026-01-17" });
    const a20 = await add({ code: "A20", name: "Track laying", start: "2026-01-19", durationDays: 10 });
    await add({ code: "IF1", name: "Interface handover", milestone: true, start: "2026-01-16" });
    await add({ code: "M1", name: "Access milestone", milestone: true, start: "2026-02-06" });
    for (const [p, q] of [[a10, hp1], [hp1, a20]]) expect((await admin.post(`${S(v1)}/dependencies`, { predId: p, succId: q, type: "FS", lagDays: 0 })).status).toBe(200);
    expect((await admin.patch(S(v1), { isBaseline: true })).status).toBe(200);

    const next = await admin.post(`${S(v1)}/versions`, { dataDate: "2026-01-31" });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    v2 = next.body.id;
    const acts = (await admin.get(`${S(v2)}/activities`)).body as { id: string; code: string }[];
    const id = (code: string) => acts.find((a) => a.code === code)!.id;
    const patch = async (code: string, body: Record<string, unknown>) => {
      const r = await admin.patch(`${S(v2)}/activities/${id(code)}`, body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await patch("A10", { actualStart: "2026-01-05", actualFinish: "2026-01-16", percentComplete: 100 });
    await patch("IF1", { actualStart: "2026-01-20", actualFinish: "2026-01-20", percentComplete: 100 });
    await patch("A20", { start: "2026-01-28", durationDays: 10, actualStart: "2026-01-28", percentComplete: 20 });

    const settings = (await admin.get(`${S(v2)}/settings`)).body;
    const saved = await admin.put(`${S(v2)}/settings`, {
      ...settings,
      milestoneTypes: { IF1: "interface", HP1: "holdItp", M1: "contractual" },
      dayZero: "2026-01-05",
      timeForCompletionDays: 60,
      contractMilestones: [{ code: "M1", label: "M1 Access", month: 1 }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it("computes the KPIs of a version for project members", async () => {
    const r = await member.get(`${S(v2)}/kpi`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const k = r.body;
    expect(k.dataDate).toBe("2026-01-31");
    expect(k.spi).toMatchObject({ weightBasis: "duration", target: 0.95, status: "below" });
    expect(k.spi.spi).toBeGreaterThan(0);
    expect(k.spi.spi).toBeLessThan(0.95);
    expect(k.interfaces).toMatchObject({ total: 1, due: 1, achieved: 0, ratio: 0, status: "below" });
    expect(k.holdPoints).toMatchObject({ total: 1, linked: 1, status: "ok" });
    expect(k.milestones[0]).toMatchObject({ code: "M1", label: "M1 Access", contractualDate: "2026-02-05", source: "contract" });
    expect(k.completion.contractCompletion).toBe("2026-03-06");
    expect(k.recovery).toMatchObject({ total: 0, ratio: null, status: "na" });
    expect((await member.get(`${S(v2)}/kpi?weights=resources`)).body.spi.weightBasis).toBe("duration");
    expect((await member.get(`${S(v2)}/kpi?weights=money`)).status).toBe(400);
  });

  it("records delay notifications and measures recovery programmes against 10 working days", async () => {
    const body = { notifiedDate: "2026-01-20", description: "Heavy rain flooded the cutting", activityCodes: ["A20"], criticalImpactDays: 5, cause: "weather", recoveryMeasures: "Second shift on track laying" };
    expect((await member.post(`${S(v2)}/delays`, body)).status).toBe(403);
    expect((await admin.post(`${S(v2)}/delays`, { ...body, activityCodes: ["NOPE"] })).status).toBe(400);
    expect((await admin.post(`${S(v2)}/delays`, { ...body, recoverySubmittedDate: "2026-01-10" })).status).toBe(400);
    expect((await admin.post(`${S(v2)}/delays`, { ...body, cause: "aliens" })).status).toBe(400);
    const created = await admin.post(`${S(v2)}/delays`, body);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ status: "open", cause: "weather", activityCodes: ["A20"], seriesId: v1 });
    delayId = created.body.id;
    // Mon–Sat calendar: the 10th working day after Tue 20 Jan is Sat 31 Jan; not late on the data date.
    expect((await member.get(`${S(v2)}/kpi`)).body.recovery).toMatchObject({ total: 1, due: 0, open: 1, status: "na" });

    expect((await member.patch(`/projects/${pid}/schedule-delays/${delayId}`, { recoverySubmittedDate: "2026-01-30" })).status).toBe(403);
    const upd = await admin.patch(`/projects/${pid}/schedule-delays/${delayId}`, { recoverySubmittedDate: "2026-01-30", recoveryScheduleId: v2 });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body).toMatchObject({ status: "submitted", recoverySubmittedDate: "2026-01-30", recoveryScheduleId: v2, description: body.description });
    expect((await member.get(`${S(v2)}/kpi`)).body.recovery).toMatchObject({ due: 1, onTime: 1, ratio: 1, status: "ok" });
    const list = (await member.get(`${S(v1)}/delays`)).body as { id: string; createdByName: string }[];
    expect(list.map((d) => d.id)).toEqual([delayId]);
    expect(list[0]!.createdByName).toBe("Admin");
  });

  it("creates a monthly report against the previous version with deviations, causes and a narrative", async () => {
    expect((await member.post(`${S(v2)}/monthly-reports`, {})).status).toBe(403);
    const r = await admin.post(`${S(v2)}/monthly-reports`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    reportId = r.body.id;
    expect(r.body).toMatchObject({ month: "2026-01", scheduleId: v2, scheduleVersion: 2, compareScheduleId: v1, compareVersion: 1, status: "draft", thresholdDays: 5, frozen: false });
    expect(r.body.narrative).toContain("Programme L4, version 2");
    const dev = r.body.data.deviations.find((d: { code: string }) => d.code === "A20");
    expect(dev).toMatchObject({ cause: "weather", causeText: "Heavy rain flooded the cutting", recoveryText: "Second shift on track laying" });
    expect(dev.slipDays).toBeGreaterThan(5);
    expect(r.body.data.compare).toMatchObject({ version: 1, isBaseline: true });
    expect(r.body.data.delays).toHaveLength(1);
    expect(r.body.data.lookahead.map((x: { code: string }) => x.code)).toContain("A20");
    expect((await admin.post(`${S(v2)}/monthly-reports`, {})).status).toBe(409);
    expect((await admin.post(`${S(v2)}/monthly-reports`, { month: "2026-13" })).status).toBe(400);
    expect((await admin.post(`${S(v2)}/monthly-reports`, { month: "2026-02", compareToId: v2 })).status).toBe(400);
    expect((await member.get(`${S(v1)}/monthly-reports`)).body.map((x: { id: string }) => x.id)).toEqual([reportId]);
  });

  it("lets planners edit the narrative and deviation notes; members read", async () => {
    expect((await member.patch(`/projects/${pid}/schedule-reports/${reportId}`, { narrative: "x" })).status).toBe(403);
    const r = await admin.patch(`/projects/${pid}/schedule-reports/${reportId}`, { narrative: "Planner narrative.", recovery: "Night shifts from February.", notes: { A20: " Rain stopped the works ", A10: "  " } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ narrative: "Planner narrative.", narrativeSource: "manual", recovery: "Night shifts from February.", notes: { A20: "Rain stopped the works" } });
    expect(r.body.data.deviations.find((d: { code: string }) => d.code === "A20").note).toBe("Rain stopped the works");
    const read = await member.get(`/projects/${pid}/schedule-reports/${reportId}`);
    expect(read.status).toBe(200);
    expect(read.body.data.kpi.spi.status).toBe("below");
  });

  it("answers the AI draft with ai_off without the AI module", async () => {
    const none = await admin.post(`/projects/${pid}/schedule-reports/${reportId}/narrative/ai`, {});
    expect(none.status).toBe(hasAi ? 409 : 403);
  });

  it.runIf(hasAi)("drafts the narrative with the project's AI provider and explains a missing provider", async () => {
    const none = await admin.post(`/projects/${pid}/schedule-reports/${reportId}/narrative/ai`, {});
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("ai_no_provider");
    expect(none.body.message).toContain("narrative");
    expect(stubCalls).toHaveLength(0);
    expect((await member.post(`/projects/${pid}/schedule-reports/${reportId}/narrative/ai`, {})).status).toBe(403);

    const prov = await admin.post("/admin/ai/providers", { name: "Sahte yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    const r = await admin.post(`/projects/${pid}/schedule-reports/${reportId}/narrative/ai`, { lang: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ narrative: "Status\nThe programme is behind the baseline; A20 slipped because of rain.", model: "qwen3:8b" });
    expect(stubCalls.at(-1)!.system).toContain("Write in English");
    const facts = JSON.parse(stubCalls.at(-1)!.user);
    expect(facts.deviations.find((d: { code: string }) => d.code === "A20")).toMatchObject({ cause: "weather", plannerNote: "Rain stopped the works" });
    expect(facts.plannerRecoveryText).toBe("Night shifts from February.");
    const after = (await member.get(`/projects/${pid}/schedule-reports/${reportId}`)).body;
    expect(after).toMatchObject({ narrativeSource: "ai", narrativeModel: "qwen3:8b" });
  });

  it("exports the report as PDF and Excel", async () => {
    const pdf = await member.get(`/projects/${pid}/schedule-reports/${reportId}/export?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(String(pdf.headers["content-type"])).toContain("application/pdf");
    expect(pdf.raw.subarray(0, 5).toString()).toBe("%PDF-");
    expect(String(pdf.headers["content-disposition"])).toContain("2026-01-monthly-report.pdf");
    const xlsx = await member.get(`/projects/${pid}/schedule-reports/${reportId}/export?format=xlsx`);
    expect(xlsx.status).toBe(200);
    const wb = XLSX.read(xlsx.raw, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["1. Summary", "2. KPIs", "3. Contractual Milestones", "4. Deviations", "5. Recovery Measures", "6. Critical Path", "7. Look-Ahead (3 Months)", "8. Narrative"]);
    const devRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["4. Deviations"]!, { header: 1 });
    expect(devRows.some((row) => row[0] === "A20" && row[11] === "Rain stopped the works")).toBe(true);
    // Turkish labels for a Turkish reader.
    const tr = client((await login("uye@7d.test")), "tr");
    const trX = XLSX.read((await tr.get(`/projects/${pid}/schedule-reports/${reportId}/export?format=xlsx`)).raw, { type: "buffer" });
    expect(trX.SheetNames[0]).toBe("1. Özet");
    expect((await member.get(`/projects/${pid}/schedule-reports/${reportId}/export?format=docx`)).status).toBe(400);
  });

  it("issues a report with a frozen snapshot and reopens it", async () => {
    const issued = await admin.patch(`/projects/${pid}/schedule-reports/${reportId}`, { status: "issued" });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: "issued", frozen: true, issuedByName: "Admin" });
    expect((await admin.patch(`/projects/${pid}/schedule-reports/${reportId}`, { narrative: "Changed" })).status).toBe(409);
    expect((await admin.post(`/projects/${pid}/schedule-reports/${reportId}/narrative/ai`, {})).status).toBe(409);
    // The issued data stays even when the delay changes later.
    await admin.patch(`/projects/${pid}/schedule-delays/${delayId}`, { description: "Changed afterwards" });
    expect((await member.get(`/projects/${pid}/schedule-reports/${reportId}`)).body.data.delays[0].description).toBe("Heavy rain flooded the cutting");
    const reopened = await admin.patch(`/projects/${pid}/schedule-reports/${reportId}`, { status: "draft" });
    expect(reopened.body).toMatchObject({ status: "draft", frozen: false, issuedAt: null });
    expect(reopened.body.data.delays[0].description).toBe("Changed afterwards");
  });

  it("deletes reports and delay notifications and audits every change", async () => {
    expect((await member.del(`/projects/${pid}/schedule-reports/${reportId}`)).status).toBe(403);
    expect((await admin.del(`/projects/${pid}/schedule-reports/${reportId}`)).status).toBe(204);
    expect((await member.get(`/projects/${pid}/schedule-reports/${reportId}`)).status).toBe(404);
    expect((await admin.del(`/projects/${pid}/schedule-delays/${delayId}`)).status).toBe(204);
    expect((await member.get(`${S(v2)}/delays`)).body).toEqual([]);
    const actions = (await handle.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.projectId, pid))).map((r) => r.action);
    for (const a of [
      "schedule.delay_created",
      "schedule.delay_updated",
      "schedule.delay_deleted",
      "schedule.report_created",
      "schedule.report_updated",
      ...(hasAi ? ["schedule.report_narrative_ai"] : []),
      "schedule.report_exported",
      "schedule.report_issued",
      "schedule.report_reopened",
      "schedule.report_deleted",
    ])
      expect(actions).toContain(a);
  });
});
