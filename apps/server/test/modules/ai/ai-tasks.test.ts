import { mkdtempSync, rmSync } from "node:fs";
import { hasField, hasManage } from "../../helpers/modules.js"; // these steps use Field (forms)
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, dashboards, notifications, users } from "../../../src/db/schema.js";
import { aiTasks } from "@7dimensions-project/sitekeep-ee-ai/internal/schema-tables.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { repairErrors } from "@7dimensions-project/sitekeep-ee-ai/internal/features.js";

const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-aitask-test-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), devTools: false });
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

function rest(auth: { cookie: string } | { token: string }) {
  const headers = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  return async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
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
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
  });
  const r = res.json() as any;
  const text: string = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { isError: !!(r.error ?? r.result?.isError), text, json };
}

async function toolNames(token: string): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
  });
  return (res.json() as any).result.tools.map((t: { name: string }) => t.name);
}

const REPORT = {
  name: "Açık Sorunlar",
  description: "Önceliğe göre açık sorunlar",
  queries: [{ id: "acik", spec: { dataset: "issues", filters: [{ field: "status", op: "neq", value: "closed" }], groupBy: ["priority"], metrics: [{ op: "count", as: "adet" }] } }],
  html: '<div id="g"></div><script>CDE.onData(function (d) { CDE.table("#g", d.acik); });</script>',
};

describe("AI task queue (Yapay Zekâya Gönder) and Claude-as-AI write tools", () => {
  let admin: ReturnType<typeof rest>;
  let alice: ReturnType<typeof rest>; // project member (requester)
  let pid: string;
  let otherPid: string;
  let claimer: string; // write token of a member (the connected AI client)
  let outsider: string; // write token of a user who is not a member
  let readToken: string;

  it("sets up a project, members and tokens", async () => {
    admin = rest({ cookie: await login("admin@7d.test") });
    await admin("PUT", "/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    const co = (await admin("POST", "/companies", { name: "Yüklenici A.Ş.", code: "YUK" })).body;
    await admin("POST", "/users", { email: "alice@7d.test", name: "Alice", password: PW, companyId: co.id });
    await admin("POST", "/users", { email: "claude@7d.test", name: "Claude Kullanıcısı", password: PW, companyId: co.id });
    await admin("POST", "/users", { email: "eve@7d.test", name: "Eve", password: PW });
    pid = (await admin("POST", "/projects", { code: "KYR", name: "Kuyruk Projesi" })).body.id;
    otherPid = (await admin("POST", "/projects", { code: "DIGER", name: "Diğer" })).body.id;
    await admin("POST", `/projects/${pid}/members`, { email: "alice@7d.test" });
    await admin("POST", `/projects/${pid}/members`, { email: "claude@7d.test", isProjectAdmin: true });
    await admin("POST", `/projects/${otherPid}/members`, { email: "eve@7d.test" });
    alice = rest({ cookie: await login("alice@7d.test") });
    const c = rest({ cookie: await login("claude@7d.test") });
    claimer = (await c("POST", "/auth/tokens", { name: "Claude Code", scope: "write" })).body.token;
    readToken = (await c("POST", "/auth/tokens", { name: "okuma" })).body.token;
    const e = rest({ cookie: await login("eve@7d.test") });
    outsider = (await e("POST", "/auth/tokens", { name: "Eve Claude", scope: "write" })).body.token;
  });

  it("is gated by the admin switch and the external-AI policy", async () => {
    const off = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık sorunlar" } });
    expect(off.status).toBe(403);
    expect(off.body.error).toBe("ai_queue_off");
    expect((await alice("GET", `/projects/${pid}/ai-tasks/status`)).body).toMatchObject({ enabled: false, allowed: false, providerAvailable: false });
    await admin("PUT", "/admin/settings/ai", { taskQueue: { enabled: true } });
    const local = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık sorunlar" } });
    expect(local.status).toBe(403);
    expect(local.body.message).toContain("Tam yerel mod");
    // allow_external alone is not enough: the project must consent…
    await admin("PUT", "/admin/settings/ai", { mode: "allow_external" });
    expect((await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık sorunlar" } })).status).toBe(403);
    await admin("PUT", `/projects/${pid}/ai`, { enabled: true, providerId: null, allowExternal: true });
    expect((await alice("GET", `/projects/${pid}/ai-tasks/status`)).body).toMatchObject({ enabled: true, allowed: true });
    // …or the explicit switch for connected clients works in local-only mode too.
    await admin("PUT", "/admin/settings/ai", { mode: "local_only", taskQueue: { allowExternalClients: true } });
    expect((await alice("GET", `/projects/${pid}/ai-tasks/status`)).body).toMatchObject({ allowed: true, reason: null });
    await admin("PUT", "/admin/settings/ai", { mode: "off" });
    expect((await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık sorunlar" } })).status).toBe(403);
    await admin("PUT", "/admin/settings/ai", { mode: "local_only" });
    expect((await admin("GET", "/admin/settings")).body.ai.taskQueue).toMatchObject({ enabled: true, allowExternalClients: true, ttlHours: 24 });
  });

  let taskId: string;

  it("queues a report request, the client claims it with the app's prompt and schema", async () => {
    const bad = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "x" } });
    expect(bad.status).toBe(400);
    const adminOnly = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "form_template_from_text", input: { description: "Beton döküm kontrol formu" } });
    expect(adminOnly.status).toBe(403);
    const t = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Önceliğe göre açık sorun sayısı tablosu" } });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body).toMatchObject({ kind: "report_generate", status: "pending", statusLabel: "Bekliyor", label: "Rapor Paneli Oluşturma" });
    taskId = t.body.id;
    expect((await alice("GET", `/projects/${pid}/ai-tasks`)).body.map((x: any) => x.id)).toContain(taskId);

    const list = await tool(claimer, "cde_ai_tasks_list", {});
    expect(list.isError, list.text).toBe(false);
    expect(list.json.tasks[0]).toMatchObject({ taskId, projectId: pid, project: "KYR", kind: "report_generate", requestedBy: "Alice" });
    // Not a member of the project: refused; no task listed.
    expect((await tool(outsider, "cde_ai_tasks_list", {})).json.count).toBe(0);
    const refused = await tool(outsider, "cde_ai_task_claim", { projectId: pid, taskId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("üyesi değilsiniz");
    expect(await toolNames(readToken)).not.toContain("cde_ai_task_claim");

    const claim = await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId });
    expect(claim.isError, claim.text).toBe(false);
    expect(claim.json.task.status).toBe("claimed");
    expect(claim.json.prompt.messages[0].role).toBe("system");
    expect(claim.json.prompt.messages.at(-1).content).toContain("Önceliğe göre açık sorun sayısı");
    expect(claim.json.answer).toMatchObject({ format: "json" });
    expect(claim.json.answer.schema.properties.queries).toBeDefined();
    expect(claim.json.tools).toContain("cde_report_datasets");
  });

  it("returns the app's validation errors, then applies a valid result as the requester", async () => {
    const invalid = await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId, result: { name: "X", queries: [{ id: "q", spec: { dataset: "yok" } }], html: "<div></div>" } });
    expect(invalid.isError, invalid.text).toBe(false);
    expect(invalid.json.ok).toBe(false);
    expect(invalid.json.errors.join(" ")).toContain("yok");
    expect((await alice("GET", `/projects/${pid}/ai-tasks/${taskId}`)).body.status).toBe("claimed");

    const ok = await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId, result: JSON.stringify(REPORT) });
    expect(ok.json.ok, ok.text).toBe(true);
    const t = (await alice("GET", `/projects/${pid}/ai-tasks/${taskId}`)).body;
    expect(t).toMatchObject({ status: "done", clientName: "Claude Code" });
    expect(t.link).toMatch(new RegExp(`^/projects/${pid}/reports/`));
    const [d] = await handle.db.select().from(dashboards).where(eq(dashboards.id, t.result.dashboardId));
    const [aliceRow] = await handle.db.select().from(users).where(eq(users.email, "alice@7d.test"));
    expect(d).toMatchObject({ ownerId: aliceRow!.id, sharing: "private", name: "Açık Sorunlar" });
    const notes = await handle.db.select().from(notifications).where(eq(notifications.userId, aliceRow!.id));
    expect(notes.some((n) => n.kind === "ai_task.done" && n.title.includes("Claude Code"))).toBe(true);
    // Done tasks cannot be completed again.
    expect((await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId, result: REPORT })).isError).toBe(true);
    const audits = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, taskId))).map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(["ai_task.created", "ai_task.claimed", "ai_task.rejected", "ai_task.completed"]));
  });

  it("never applies with more rights than the requester has", async () => {
    // Alice may run a report but not see the 'activity' dataset (project admins only).
    const t = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Proje etkinlik kaydı" } })).body;
    const r = await tool(claimer, "cde_ai_task_complete", {
      projectId: pid,
      taskId: t.id,
      result: { ...REPORT, queries: [{ id: "acik", spec: { dataset: "activity", metrics: [{ op: "count", as: "n" }] } }] },
    });
    expect(r.json.ok).toBe(false);
  });

  it.skipIf(!hasManage)("cancels, fails and expires tasks", async () => {
    const a = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "1) Kalıp revize edilecek, sorumlu Alice, 20 Ekim." } })).body;
    expect((await alice("POST", `/projects/${pid}/ai-tasks/${a.id}/cancel`)).body.status).toBe("cancelled");
    expect((await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId: a.id })).text).toContain("iptal");
    const b = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "2) İSG eğitimi yapılacak, 25 Ekim." } })).body;
    const failed = await tool(claimer, "cde_ai_task_fail", { projectId: pid, taskId: b.id, error: "Metin yetersiz." });
    expect(failed.json).toMatchObject({ status: "failed", error: "Metin yetersiz." });
    const c = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "3) Döküm programı güncellenecek." } })).body;
    await handle.db.update(aiTasks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiTasks.id, c.id));
    expect((await tool(claimer, "cde_ai_tasks_list", {})).json.tasks.map((x: any) => x.taskId)).not.toContain(c.id);
    const expired = (await alice("GET", `/projects/${pid}/ai-tasks/${c.id}`)).body;
    expect(expired).toMatchObject({ status: "failed" });
    expect(expired.error).toContain("Süresi doldu");
  });

  it.skipIf(!hasManage)("validates and applies other kinds through their own routes (minutes actions)", async () => {
    const t = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "1) Kalıp çizimleri revize edilecek, sorumlu Alice, termin 2026-10-20." } })).body;
    const claim = await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId: t.id });
    expect(claim.json.prompt.messages[0].content).toContain("items");
    const r = await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId: t.id, result: { items: [{ konu: "Kalıp çizimleri", karar: "Revize edilecek", sorumlu: "Alice", termin: "2026-10-20" }] } });
    expect(r.json.ok, r.text).toBe(true);
    const done = (await alice("GET", `/projects/${pid}/ai-tasks/${t.id}`)).body;
    expect(done.result.items[0]).toMatchObject({ konu: "Kalıp çizimleri", termin: "2026-10-20" });
    expect(done.result.items[0].sorumluUserId).toBeTruthy();
  });

  it("parses repair requests into error lists", () => {
    expect(repairErrors("Bu JSON geçersiz. Hatalar:\n- a eksik\n- b yanlış\nAynı biçimde düzeltilmiş JSON'u döndür.")).toEqual(["a eksik", "b yanlış"]);
  });

  // ---- Claude-as-AI write tools --------------------------------------------------------------

  it("lists the AI tools per token type", async () => {
    const ro = await toolNames(readToken);
    expect(ro).toContain("cde_ai_schemas");
    for (const n of ["cde_report_save", "cde_form_template_save", "cde_form_flow_save", "cde_work_draft", "cde_workflow_template_save", "cde_ai_tasks_list"]) expect(ro).not.toContain(n);
    const rw = await toolNames(claimer);
    for (const n of ["cde_ai_schemas", "cde_report_save", "cde_form_template_save", "cde_form_flow_save", "cde_work_draft", "cde_workflow_template_save", "cde_ai_tasks_list", "cde_ai_task_claim", "cde_ai_task_complete", "cde_ai_task_fail"])
      expect(rw).toContain(n);
    expect(rw.some((n) => n.startsWith("cde_dev_"))).toBe(false);
  });

  it("returns the schemas behind the app's AI prompts", async () => {
    const all = await tool(readToken, "cde_ai_schemas", {});
    expect(all.json.features.map((f: any) => f.kind)).toEqual(expect.arrayContaining(["report_generate", "form_flow", "letter_translate", "model_ask"]));
    expect(all.json.save.report.instructions).toContain("CDE.onData");
    const report = await tool(readToken, "cde_ai_schemas", { part: "report" });
    expect(report.json.schema.properties.html).toBeDefined();
    const flow = await tool(readToken, "cde_ai_schemas", { part: "formFlow" });
    expect(flow.json.draftSchema.properties.steps).toBeDefined();
  });

  it("offers form, minutes, RFI and parameter-change features only with their modules", async () => {
    const moduleBound = ["form_flow", "form_fields_naming", "form_template_from_text", "minutes_actions", "rfi_draft", "record_from_file", "param_change"];
    const saved = process.env.SITEKEEP_MODULES;
    process.env.SITEKEEP_MODULES = "ai";
    try {
      const only = await tool(readToken, "cde_ai_schemas", {});
      const kinds = only.json.features.map((f: any) => f.kind);
      expect(kinds).toEqual(expect.arrayContaining(["report_generate", "letter_translate", "today_summary"]));
      for (const k of moduleBound) expect(kinds, k).not.toContain(k);
      expect(only.json.save.formTemplate).toBeUndefined();
      expect(only.json.save.formFlow).toBeUndefined();
      const queued = await admin("POST", `/projects/${pid}/ai-tasks`, { kind: "form_template_from_text", input: { description: "Beton döküm kontrol formu" } });
      expect(queued.status, JSON.stringify(queued.body)).toBe(404);
      expect(queued.body.error).toBe("feature_not_installed");
    } finally {
      if (saved === undefined) delete process.env.SITEKEEP_MODULES;
      else process.env.SITEKEEP_MODULES = saved;
    }
    const all = (await tool(readToken, "cde_ai_schemas", {})).json.features.map((f: any) => f.kind);
    for (const k of moduleBound) expect(all, k).toContain(k);
  });

  it("saves a report dashboard with checked queries", async () => {
    const unused = await tool(claimer, "cde_report_save", { projectId: pid, ...REPORT, html: "<div></div>" });
    expect(unused.isError).toBe(true);
    expect(unused.text).toContain("acik");
    const wrong = await tool(claimer, "cde_report_save", { projectId: pid, ...REPORT, queries: [{ id: "acik", spec: { dataset: "issues", groupBy: ["yokAlan"] } }] });
    expect(wrong.isError).toBe(true);
    const ok = await tool(claimer, "cde_report_save", { projectId: pid, ...REPORT });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.json).toMatchObject({ name: "Açık Sorunlar", sharing: "private", rows: { acik: 0 } });
    const upd = await tool(claimer, "cde_report_save", { projectId: pid, reportId: ok.json.id, ...REPORT, name: "Açık Sorunlar (v2)" });
    expect(upd.json.version).toBe(2);
  });

  let templateId: string;

  it.skipIf(!hasField)("saves form templates (project admins) and flows from a model-style draft", async () => {
    const schema = { sections: [{ title: "Kontroller", items: [{ type: "yes_no", label: "Kalıp temiz" }, { type: "signature", label: "Kontrol Eden" }] }] };
    const t = await tool(claimer, "cde_form_template_save", { projectId: pid, code: "KK", name: "Kalıp Kontrol", schema });
    expect(t.isError, t.text).toBe(false);
    templateId = t.json.id;
    expect(t.json.items).toBe(2);
    const aliceTok = (await alice("POST", "/auth/tokens", { name: "alice-w", scope: "write" })).body.token;
    expect((await tool(aliceTok, "cde_form_template_save", { projectId: pid, code: "KK2", name: "X", schema })).isError).toBe(true);
    const draft = { filler: "Şantiye Şefi", steps: [{ who: "Kalite Kontrol Mühendisi", action: "kontrol eder", outcomes: ["Onay", "Ret"], onReject: 0, days: 3 }] };
    const unknown = await tool(claimer, "cde_form_flow_save", { projectId: pid, templateId, draft });
    expect(unknown.isError, unknown.text).toBe(false);
    expect(unknown.json.saved).toBe(false);
    expect(unknown.json.unresolvedRoles.map((u: any) => u.name)).toEqual(expect.arrayContaining(["Kalite Kontrol Mühendisi"]));
    await admin("POST", `/projects/${pid}/roles`, { name: "Şantiye Şefi" });
    await admin("POST", `/projects/${pid}/roles`, { name: "Kalite Kontrol Mühendisi" });
    const saved = await tool(claimer, "cde_form_flow_save", { projectId: pid, templateId, draft });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.json.saved).toBe(true);
    expect(saved.json.steps[0]).toContain("Şantiye Şefi");
  });

  it.skipIf(!hasManage)("creates draft works only (letter data and links), never sends", async () => {
    const co = (await admin("GET", "/companies")).body[0];
    const inc = await tool(claimer, "cde_work_draft", {
      projectId: pid,
      typeKey: "gelen-yazi",
      title: "Hakediş ödemesi",
      fromCompanyId: undefined,
      toCompanyIds: [co.id],
    });
    expect(inc.isError, inc.text).toBe(false);
    const letter = await tool(claimer, "cde_work_draft", {
      projectId: pid,
      typeKey: "giden-yazi",
      title: "Hakediş ödemesi hakkında",
      toCompanyIds: [co.id],
      letter: { body: "İlgi yazınız incelenmiştir.", signer: { name: "Ali Veli", title: "Proje Müdürü" } },
      links: [{ kind: "work", targetId: inc.json.id }],
    });
    expect(letter.isError, letter.text).toBe(false);
    expect(letter.json).toMatchObject({ draft: true, status: "Taslak" });
    const reply = await tool(claimer, "cde_work_draft", { projectId: pid, replyToWorkId: inc.json.id, letter: { body: "Cevabımızdır." } });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json.status).toBe("Taslak");
  });

  it("saves workflow templates", async () => {
    const co = (await admin("GET", "/companies")).body[0];
    const r = await tool(claimer, "cde_workflow_template_save", {
      projectId: pid,
      kind: "review",
      name: "Müşavir İncelemesi",
      steps: [{ name: "Müşavir", assignees: [{ type: "company", id: co.id }], rule: "any", days: 5, outcomes: ["approved", "rejected"] }],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ kind: "review", name: "Müşavir İncelemesi", steps: ["Müşavir"] });
  });

  it.skipIf(!hasManage)("refuses tasks and drafts of off modules (Proje Ayarları → Modüller)", async () => {
    const queued = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "1) Kalıp revize edilecek, sorumlu Alice, 20 Ekim." } })).body;
    const early = (await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "rfi_draft", input: { description: "Mekanik şaft ölçüsü belirsiz" } })).body;
    const claimed = await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId: early.id });
    expect(claimed.isError, claimed.text).toBe(false);

    expect((await admin("PUT", `/projects/${pid}/modules`, { modules: { meetings: false, rfi: false } })).status).toBe(200);
    try {
      // Queueing a kind whose module is off is refused.
      const minutes = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "minutes_actions", input: { text: "2) İSG eğitimi yapılacak, 25 Ekim." } });
      expect(minutes.status).toBe(403);
      expect(minutes.body.error).toBe("module_disabled");
      expect(minutes.body.message).toMatch(/^Toplantı ve Eylem modülü/);
      const rfi = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "rfi_draft", input: { description: "Kolon ölçüsü belirsiz" } });
      expect(rfi.status).toBe(403);
      expect(rfi.body.message).toMatch(/^Bilgi Talebi modülü/);
      const report = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık bilgi talepleri", module: "rfi" } });
      expect(report.status).toBe(403);
      expect(report.body.message).toMatch(/^Bilgi Talebi modülü/);
      // Kinds of modules that are on still queue.
      const ok = await alice("POST", `/projects/${pid}/ai-tasks`, { kind: "report_generate", input: { prompt: "Açık sorunlar", module: "issues" } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      await alice("POST", `/projects/${pid}/ai-tasks/${ok.body.id}/cancel`);

      // Tasks queued before the switch fail at claim / completion with the module's message.
      const late = await tool(claimer, "cde_ai_task_claim", { projectId: pid, taskId: queued.id });
      expect(late.isError).toBe(true);
      expect(late.text).toContain("Toplantı ve Eylem modülü");
      expect((await alice("GET", `/projects/${pid}/ai-tasks/${queued.id}`)).body).toMatchObject({ status: "failed", error: expect.stringMatching(/^Toplantı ve Eylem modülü/) });
      const done = await tool(claimer, "cde_ai_task_complete", { projectId: pid, taskId: early.id, result: { title: "Şaft ölçüsü", fields: { soru: "Şaft ölçüsü nedir?" } } });
      expect(done.isError).toBe(true);
      expect(done.text).toContain("Bilgi Talebi modülü");
      expect((await alice("GET", `/projects/${pid}/ai-tasks/${early.id}`)).body.status).toBe("failed");

      // cde_work_draft goes through the works API: an off module's new draft is refused, others still work.
      const draft = await tool(claimer, "cde_work_draft", { projectId: pid, typeKey: "rfi", title: "Şaft ölçüsü", fields: { soru: "Şaft ölçüsü nedir?" } });
      expect(draft.isError).toBe(true);
      expect(draft.text).toContain("Bilgi Talebi modülü bu projede kapalı");
      const meeting = await tool(claimer, "cde_work_draft", { projectId: pid, typeKey: "toplanti", title: "Haftalık toplantı" });
      expect(meeting.isError).toBe(true);
      expect(meeting.text).toContain("Toplantı ve Eylem modülü");
      const co = (await admin("GET", "/companies")).body[0];
      const letter = await tool(claimer, "cde_work_draft", { projectId: pid, typeKey: "giden-yazi", title: "Modül kapalıyken yazı", toCompanyIds: [co.id] });
      expect(letter.isError, letter.text).toBe(false);
    } finally {
      await admin("PUT", `/projects/${pid}/modules`, { modules: { meetings: true, rfi: true } });
    }
  });
});
