import { createServer, type Server } from "node:http";
import { hasAi, hasField, hasManage, hasPlanning } from "../helpers/modules.js"; // Field (forms), Planning (schedule); MCP and the AI evaluation are the AI module's
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, projects, users, works } from "../../src/db/schema.js";
import { devToolsEnabled } from "../../src/dev/flag.js";
import { recordServerError, redactSecrets } from "../../src/core/platform/error-ring.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let plain: FastifyInstance;
let dataDir: string;
let stub: Server;
let stubUrl: string;
const stubBodies: any[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-dev-test-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, devTools: true, webUrl: "http://web.test" });
  plain = await buildApp({ db: handle.db, storage, jobs, devTools: false });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });

  // Fake OpenAI-compatible model: answers by feature (recognised from the system prompt).
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      stubBodies.push(body);
      const system = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
      let content = "bu JSON değil";
      if (system.includes("Translate the Turkish texts")) content = JSON.stringify({ subject: "About the concrete schedule", body: "The concrete casting schedule has been reviewed.", signerTitle: "Project Manager" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await plain.close();
  await handle.close();
  await new Promise((r) => stub.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function rest(target: FastifyInstance, auth: { cookie: string } | { token: string }) {
  const headers = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  return async (method: string, url: string, payload?: unknown) => {
    const res = await target.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
}

let rpcId = 0;
async function mcp(target: FastifyInstance, token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await target.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  return res.json() as any;
}

async function toolNames(target: FastifyInstance, token: string): Promise<string[]> {
  return (await mcp(target, token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
}

/** Calls a developer tool over the hosted MCP endpoint (AI module), else over its REST route. */
async function dev(token: string, name: string, args: Record<string, unknown> = {}) {
  if (!hasAi) {
    const res = await rest(app, { token })("POST", `/dev/tools/${name}`, args);
    const ok = res.status === 200;
    return { isError: !ok, text: JSON.stringify(res.body), json: ok ? res.body : null };
  }
  const r = await mcp(app, token, "tools/call", { name, arguments: args });
  const text: string = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: !!(r.error ?? r.result?.isError), text, json };
}

describe("developer MCP tools (cde_dev_*)", () => {
  let admin: ReturnType<typeof rest>;
  let adminWrite: string;
  let adminRead: string;
  let bobWrite: string;
  let testProject: { id: string; code: string };
  let realProject: { id: string };

  it("sets up tokens: admin write/read, a non-admin write token", async () => {
    admin = rest(app, { cookie: await login("admin@7d.test") });
    await admin("PUT", "/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    adminWrite = (await admin("POST", "/auth/tokens", { name: "Claude Code (geliştirme)", scope: "write" })).body.token;
    adminRead = (await admin("POST", "/auth/tokens", { name: "okuma" })).body.token;
    await admin("POST", "/users", { email: "bob@7d.test", name: "Bob", password: PW });
    const bob = rest(app, { cookie: await login("bob@7d.test") });
    const t = await bob("POST", "/auth/tokens", { name: "bob", scope: "write" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    bobWrite = t.body.token;
    realProject = (await admin("POST", "/projects", { code: "GERCEK", name: "Gerçek Proje" })).body;
  });

  it("is off without CDE_DEV_TOOLS and in production", async () => {
    expect(devToolsEnabled({ CDE_DEV_TOOLS: "1" })).toBe(true);
    expect(devToolsEnabled({ CDE_DEV_TOOLS: "1", NODE_ENV: "production" })).toBe(false);
    expect(devToolsEnabled({})).toBe(false);
    if (hasAi) expect((await toolNames(plain, adminWrite)).some((n) => n.startsWith("cde_dev_"))).toBe(false);
    const off = await rest(plain, { token: adminWrite })("POST", "/dev/tools/cde_dev_health", {});
    expect(off.status).toBe(404);
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect((await rest(app, { token: adminWrite })("POST", "/dev/tools/cde_dev_health", {})).status).toBe(404);
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("serves the tools only to a system administrator's write token", async () => {
    if (hasAi) {
      const names = await toolNames(app, adminWrite);
      for (const n of ["cde_dev_health", "cde_dev_seed", "cde_dev_project", "cde_dev_upload", "cde_dev_scenario", "cde_dev_ai_eval", "cde_dev_ai_check", "cde_dev_time"]) expect(names).toContain(n);
      expect((await toolNames(app, adminRead)).some((n) => n.startsWith("cde_dev_"))).toBe(false);
      expect((await toolNames(app, bobWrite)).some((n) => n.startsWith("cde_dev_"))).toBe(false);
    }
    expect((await rest(app, { token: bobWrite })("POST", "/dev/tools/cde_dev_health", {})).status).toBe(403);
    expect((await rest(app, { token: adminRead })("POST", "/dev/tools/cde_dev_health", {})).status).toBe(403);
    expect((await admin("POST", "/dev/tools/cde_dev_health", {})).status).toBe(403); // browser session
    if (!hasAi) return;
    const destructive = (await mcp(app, adminWrite, "tools/list")).result.tools.find((t: any) => t.name === "cde_dev_project");
    expect(destructive.annotations.destructiveHint).toBe(true);
  });

  it("reports health: migrations, converters, AI, MCP, errors and table counts", async () => {
    recordServerError("test", new Error("Bearer 7dcde_api_gizlianahtar123 ile istek başarısız"));
    const h = await dev(adminWrite, "cde_dev_health", {});
    expect(h.isError, h.text).toBe(false);
    expect(h.json.database.migrations.upToDate).toBe(true);
    expect(h.json.mcp.allowWriteTokens).toBe(true);
    expect(h.json.tableCounts.projects).toBeGreaterThan(0);
    expect(h.json.converters.soffice).toBeDefined();
    expect(h.json.recentErrors[0].message).toContain("Bearer ***");
    expect(redactSecrets("anahtar 7dcde_api_abc123 sızdı")).toBe("anahtar 7dcde_api_*** sızdı");
    expect(JSON.stringify(h.json)).not.toContain("gizlianahtar");
    expect(redactSecrets("x?access_token=abc&y=1")).toBe("x?access_token=***&y=1");
  });

  it("creates a test project with demo companies and members", async () => {
    const r = await dev(adminWrite, "cde_dev_project", { action: "create", code: "DEVT", name: "Geliştirici Testi" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.code).toBe("DEVT-TEST");
    expect(r.json.members.map((m: any) => m.company).sort()).toEqual(["IDR", "MSV", "TSR", "YUK"]);
    expect(r.json.link).toBe(`http://web.test/projects/${r.json.id}`);
    testProject = { id: r.json.id, code: r.json.code };
    const list = await dev(adminWrite, "cde_dev_project", { action: "list" });
    expect(list.json.find((p: any) => p.code === "DEVT-TEST")).toMatchObject({ test: true, createdByDev: true });
    expect(list.json.find((p: any) => p.code === "GERCEK")).toMatchObject({ test: false });
  });

  it.skipIf(!hasManage)("sets module switches on test projects only, with the Modüller endpoint's validation", async () => {
    const c = await dev(adminWrite, "cde_dev_project", { action: "create", code: "MODT", members: false, modules: { schedule: false, rfi: false } });
    expect(c.isError, c.text).toBe(false);
    expect(c.json.modules).toMatchObject({ schedule: false, rfi: false, correspondence: true });
    const pid = c.json.id;

    const r = await dev(adminWrite, "cde_dev_project", { action: "set_modules", project: "MODT-TEST", modules: { rfi: true, meetings: false } });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.off.sort()).toEqual(["meetings", "schedule"]);
    const stored = (await admin("GET", `/projects/${pid}/modules`)).body;
    expect(stored).toMatchObject({ rfi: true, meetings: false, schedule: false, issues: true });
    const [row] = await handle.db.select().from(projects).where(eq(projects.id, pid));
    expect((row!.settings as { modules?: Record<string, boolean> }).modules).toMatchObject({ meetings: false, schedule: false, rfi: true });

    // Same validation as Proje Ayarları → Modüller: unknown keys are refused, nothing changes.
    const bad = await dev(adminWrite, "cde_dev_project", { action: "set_modules", project: "MODT-TEST", modules: { yok: false } });
    expect(bad.isError).toBe(true);
    expect((await dev(adminWrite, "cde_dev_project", { action: "set_modules", project: "MODT-TEST" })).isError).toBe(true);
    expect((await admin("GET", `/projects/${pid}/modules`)).body).toEqual(stored);

    // Real projects are refused.
    const real = await dev(adminWrite, "cde_dev_project", { action: "set_modules", project: "GERCEK", modules: { schedule: false } });
    expect(real.isError).toBe(true);
    expect(real.text).toContain("test/demo projesi değil");
    expect((await admin("GET", `/projects/${realProject.id}/modules`)).body.schedule).toBe(true);
  });

  it.skipIf(!hasField || !hasManage)("seeds backdated records once per tag; refuses real projects", async () => {
    const refused = await dev(adminWrite, "cde_dev_seed", { project: "GERCEK" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("test/demo projesi değil");
    const r = await dev(adminWrite, "cde_dev_seed", {
      project: testProject.code,
      tag: "t1",
      counts: { incomingLetters: 4, outgoingLetters: 3, rfis: 4, submittals: 3, meetings: 2, transmittals: 1, issues: 5, reviews: 2, forms: 2, schedule: true },
      overdueRatio: 0.5,
      backdateDays: 60,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.notes ?? []).toEqual([]);
    expect(r.json.counts.works).toBeGreaterThanOrEqual(15);
    expect(r.json.counts).toMatchObject({ issues: 5, reviews: 2, forms: 2, ...(hasPlanning ? { schedules: 2 } : {}) });
    // Backdated and marked.
    const [old] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(works)
      .where(and(eq(works.projectId, testProject.id), sql`${works.createdAt} < now() - interval '10 days'`));
    expect(old!.n).toBeGreaterThan(5);
    const [marked] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(works)
      .where(and(eq(works.projectId, testProject.id), sql`${works.data}->>'devSeed' = 't1'`));
    expect(marked!.n).toBe(r.json.counts.works);
    // Letters were answered through the real flow, RFIs carry the next party.
    const [answered] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(works)
      .where(and(eq(works.projectId, testProject.id), eq(works.status, "cevaplandi")));
    expect(answered!.n).toBeGreaterThan(0);
    const again = await dev(adminWrite, "cde_dev_seed", { project: testProject.code, tag: "t1" });
    expect(again.json.alreadySeeded).toBe(true);
    const status = await dev(adminWrite, "cde_dev_seed", { project: testProject.code, action: "status" });
    expect(Object.keys(status.json.seeds)).toEqual(["t1"]);
  });

  it.skipIf(!hasField || !hasManage)("shifts dates: overdue ratio needs confirm and a test project", async () => {
    expect((await dev(adminWrite, "cde_dev_time", { project: testProject.code, overdueRatio: 1 })).text).toContain("confirm: true");
    expect((await dev(adminWrite, "cde_dev_time", { project: "GERCEK", overdueRatio: 1, confirm: true })).isError).toBe(true);
    const r = await dev(adminWrite, "cde_dev_time", { project: testProject.code, overdueRatio: 1, confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.overdue.works.overdue).toBe(r.json.overdue.works.open);
    expect(r.json.overdue.issues.overdue).toBe(r.json.overdue.issues.open);
    const s = await dev(adminWrite, "cde_dev_time", { project: testProject.code, shiftDays: -3, kinds: ["issues"], confirm: true });
    expect(s.json.shifted).toMatchObject({ days: -3, issues: 5 });
  });

  it("uploads generated samples, fixtures and new versions", async () => {
    const kinds = ["pdf_drawing", "pdf_form", "docx", "xlsx", "pptx", "dxf", "ifc"];
    for (const sample of kinds) {
      const r = await dev(adminWrite, "cde_dev_upload", { project: testProject.code, sample });
      expect(r.isError, `${sample}: ${r.text}`).toBe(false);
      expect(r.json.uploaded[0].version).toBe(1);
    }
    const first = await dev(adminWrite, "cde_dev_upload", { project: testProject.code, sample: "pdf_drawing", name: "VERSIYON-A-500.pdf", revision: "A" });
    const second = await dev(adminWrite, "cde_dev_upload", { project: testProject.code, sample: "pdf_drawing", newVersionOf: first.json.uploaded[0].fileId, revision: "C" });
    expect(second.isError, second.text).toBe(false);
    expect(second.json.uploaded[0]).toMatchObject({ fileId: first.json.uploaded[0].fileId, version: 2, name: "VERSIYON-A-500.pdf" });
    expect((await dev(adminWrite, "cde_dev_upload", { project: testProject.code, fixture: "schedule.csv" })).isError).toBe(false);
    expect((await dev(adminWrite, "cde_dev_upload", { project: testProject.code, fixture: "../package.json" })).text).toContain("yalnız dosya adı");
  });

  it.skipIf(!hasField || !hasManage)("runs every built-in scenario green on a fresh project", async () => {
    const list = await dev(adminWrite, "cde_dev_scenario", { list: true });
    expect(list.json.scenarios).toHaveLength(9);
    const r = await dev(adminWrite, "cde_dev_scenario", {});
    expect(r.isError, r.text).toBe(false);
    const failed = r.json.results.filter((x: any) => !x.ok).map((x: any) => ({ s: x.scenario, steps: x.steps.filter((s: any) => !s.ok) }));
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(r.json.passed).toBe(9);
    const persona = r.json.results.find((x: any) => x.scenario === "gorunum");
    expect(persona.steps).toHaveLength(15);
    expect(r.json.table).toContain("| **yazisma-dongusu** | GEÇTİ");
    expect(persona.steps[0].link).toMatch(/^http:\/\/web\.test\/projects\//);
  }, 240_000);

  it.skipIf(!hasField || !hasAi || !hasManage)("evaluates AI features: dry prompts (policy-gated), a mocked provider and candidate checks", async () => {
    const blocked = await dev(adminWrite, "cde_dev_ai_eval", { mode: "dry", features: ["letter_translate"] });
    expect(blocked.isError, blocked.text).toBe(false);
    expect(blocked.json.prompts[0].error).toContain("Tam yerel mod");
    await admin("PUT", "/admin/settings/ai", { taskQueue: { allowExternalClients: true } });
    const dry = await dev(adminWrite, "cde_dev_ai_eval", { mode: "dry", features: ["letter_translate", "form_flow", "report_generate", "model_ask", "doc_compare_summary"] });
    expect(dry.isError, dry.text).toBe(false);
    for (const p of dry.json.prompts) expect(p.messages?.[0]?.role, `${p.feature}: ${p.error}`).toBe("system");
    expect(dry.json.prompts.find((p: any) => p.feature === "letter_translate").messages[0].content).toContain("Translate the Turkish texts");

    // A mocked local provider answers: translation valid, the rest invalid JSON.
    await admin("POST", "/admin/ai/providers", { name: "Sahte yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    const run = await dev(adminWrite, "cde_dev_ai_eval", { mode: "run", features: ["letter_translate", "minutes_actions"], model: "qwen3-8b-16k" });
    expect(run.isError, run.text).toBe(false);
    const byFeature = Object.fromEntries(run.json.rows.map((r: any) => [r.feature, r]));
    expect(byFeature.letter_translate).toMatchObject({ validJson: true, tokens: { input: 120, output: 30 } });
    expect(byFeature.minutes_actions.validJson).toBe(false);
    expect(run.json.model).toBe("qwen3-8b-16k");
    expect(stubBodies.at(-1).model).toBe("qwen3-8b-16k");
    expect(run.json.table).toContain("| letter_translate |");

    const good = await dev(adminWrite, "cde_dev_ai_check", { feature: "form_flow", output: { filler: "Şantiye Şefi", steps: [{ who: "Kalite Kontrol Mühendisi", action: "kontrol eder", outcomes: ["Onay", "Ret"], onReject: 0 }] } });
    expect(good.isError, good.text).toBe(false);
    expect(good.json.valid, good.text).toBe(true);
    const bad = await dev(adminWrite, "cde_dev_ai_check", { feature: "form_flow", output: { steps: [] } });
    expect(bad.json.valid).toBe(false);
    expect(bad.json.errors.length).toBeGreaterThan(0);
    const badReport = await dev(adminWrite, "cde_dev_ai_check", { feature: "report_generate", output: { name: "X", queries: [{ id: "q", spec: { dataset: "yok" } }], html: "<div></div>" } });
    expect(badReport.json.valid).toBe(false);
    expect(badReport.json.errors.join(" ")).toContain("yok");
  }, 120_000);

  it.skipIf(!hasField || !hasManage)("resets and archives only test projects, with confirm", async () => {
    expect((await dev(adminWrite, "cde_dev_project", { action: "reset", project: "GERCEK", confirm: true })).text).toContain("test/demo projesi değil");
    expect((await dev(adminWrite, "cde_dev_project", { action: "reset", project: testProject.code })).text).toContain("confirm: true");
    const removed = await dev(adminWrite, "cde_dev_seed", { project: testProject.code, tag: "t1", action: "remove", confirm: true });
    expect(removed.isError, removed.text).toBe(false);
    expect(removed.json.removed).toBe(true);
    const reset = await dev(adminWrite, "cde_dev_project", { action: "reset", project: testProject.code, confirm: true });
    expect(reset.isError, reset.text).toBe(false);
    const [left] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(works).where(eq(works.projectId, testProject.id));
    expect(left!.n).toBe(0);
    expect((await dev(adminWrite, "cde_dev_project", { action: "archive", project: "GERCEK", confirm: true })).isError).toBe(true);
    const arch = await dev(adminWrite, "cde_dev_project", { action: "archive", project: testProject.code, confirm: true });
    expect(arch.json.archived).toBe(true);
    const [p] = await handle.db.select().from(projects).where(eq(projects.id, testProject.id));
    expect(p!.archived).toBe(true);
    void realProject;
  });

  it.skipIf(!hasField || !hasManage)("audits every developer tool call", async () => {
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "dev.tool"));
    const tools = new Set(rows.map((r) => (r.details as { tool: string }).tool));
    const ai = hasAi ? ["cde_dev_ai_eval", "cde_dev_ai_check"] : [];
    for (const t of ["cde_dev_health", "cde_dev_seed", "cde_dev_project", "cde_dev_upload", "cde_dev_scenario", ...ai, "cde_dev_time"]) expect(tools).toContain(t);
    expect(rows.some((r) => (r.details as { ok: boolean }).ok === false)).toBe(true);
  });
});
