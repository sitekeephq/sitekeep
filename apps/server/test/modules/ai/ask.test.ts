import { hasManage } from "../../helpers/modules.js"; // steps that create RFIs, letters or meetings need Manage
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { AskBridge } from "../../../src/core/platform/ask-bridge.js";
import { bridgeCall, linkifyRefs, MAX_OFFERED_TOOLS, parseToolRequests, Refs, routeTools } from "@7dimensions-project/sitekeep-ee-ai/internal/assistant.js";
import { cleanupAskHistory, TokenBucket } from "@7dimensions-project/sitekeep-ee-ai/internal/routes/ask.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, systemSettings, users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const bridge = new AskBridge();

// ---- Fake OpenAI-compatible model on 127.0.0.1, scripted per test --------------------------

type Reply = { status?: number; json?: unknown; sse?: string[]; delayMs?: number };
type Scripted = (body: any) => Reply;
const script: Scripted[] = [];
const requests: any[] = [];
let stub: Server;
let stubUrl: string;

const chat = (content: string, toolCalls?: { name: string; args: unknown }[]) => ({
  id: "x",
  model: "qwen3:8b",
  choices: [
    {
      index: 0,
      finish_reason: toolCalls ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content,
        ...(toolCalls && {
          tool_calls: toolCalls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        }),
      },
    },
  ],
});
const answer = (text: string): Scripted => () => ({ json: chat(text) });
const tools = (...calls: { name: string; args: unknown }[]): Scripted => () => ({ json: chat("", calls) });
/** Tool results the assistant sent back in a request (native protocol). */
const toolResults = (body: any): string[] => body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-ask-test-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), askBridge: bridge });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });

  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push(body);
      const next = script.shift() ?? answer("Tamam.");
      const r = next(body);
      setTimeout(() => {
        if (res.destroyed) return;
        if (r.sse) {
          res.setHeader("content-type", "text/event-stream");
          for (const chunk of r.sse) res.write(`data: ${chunk}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.statusCode = r.status ?? 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(r.json));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function client(auth: { cookie: string } | { token: string }) {
  const headers = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { ...headers, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return res.json();
    },
    ask: (pid: string, question: string, extra: Record<string, unknown> = {}, wait = true) =>
      call("POST", `/projects/${pid}/ask${wait ? "?wait=1" : ""}`, { question, ...extra }),
  };
}
type Caller = ReturnType<typeof client>;

const WRITE_TOOLS = [
  "cde_folder_create",
  "cde_folder_update",
  "cde_folder_permissions_set",
  "cde_member_add",
  "cde_file_update",
  "cde_file_upload",
  "cde_issue_create",
  "cde_issue_update",
  "cde_issue_comment_add",
];

describe('"Sor" assistant', () => {
  let admin: Caller;
  let alice: Caller; // project admin, company A
  let bob: Caller; // member, company B — no access to "Gizli"
  let p1: { id: string; code: string; rootFolderId: string };
  let p2: { id: string; rootFolderId: string };
  let statik: { id: string };
  let gizli: { id: string };
  let statikFile: { fileId: string };
  let bobId: string;
  let aliceId: string;

  it("sets up a project with a restricted folder and a local model", async () => {
    admin = client({ cookie: await login("admin@7d.test") });
    const ca = (await admin.post("/companies", { name: "Firma A" })).body;
    const cb = (await admin.post("/companies", { name: "Firma B" })).body;
    aliceId = (await admin.post("/users", { email: "alice@7d.test", name: "Alice", password: PW, companyId: ca.id })).body.id;
    bobId = (await admin.post("/users", { email: "bob@7d.test", name: "Bob", password: PW, companyId: cb.id })).body.id;
    p1 = (await admin.post("/projects", { code: "P1", name: "Proje 1", template: "empty" })).body;
    p2 = (await admin.post("/projects", { code: "P2", name: "Proje 2", template: "empty" })).body;
    await admin.post(`/projects/${p1.id}/members`, { email: "alice@7d.test", isProjectAdmin: true });
    await admin.post(`/projects/${p1.id}/members`, { email: "bob@7d.test" });
    statik = (await admin.post(`/projects/${p1.id}/folders`, { parentId: p1.rootFolderId, name: "Statik" })).body;
    gizli = (await admin.post(`/projects/${p1.id}/folders`, { parentId: p1.rootFolderId, name: "Gizli" })).body;
    await admin.put(`/projects/${p1.id}/folders/${statik.id}/permissions`, {
      entries: [
        { subjectType: "company", subjectId: ca.id, level: "view_download" },
        { subjectType: "company", subjectId: cb.id, level: "view_download" },
      ],
    });
    await admin.put(`/projects/${p1.id}/folders/${gizli.id}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ca.id, level: "view_download" }],
    });
    const up = await admin.upload(`/projects/${p1.id}/folders/${statik.id}/files`, "STATIK-PAFTA-001.pdf", "%PDF-1.4 statik");
    statikFile = { fileId: up.results[0].fileId };
    await admin.upload(`/projects/${p1.id}/folders/${gizli.id}/files`, "GIZLI-RAPOR-007.pdf", "%PDF-1.4 gizli");
    await admin.upload(`/projects/${p2.id}/folders/${p2.rootFolderId}/files`, "P2-DOSYA.pdf", "%PDF-1.4 p2");
    const issue = await admin.post(`/projects/${p1.id}/issues`, {
      title: "Kolon donatısı eksik",
      assigneeUserId: bobId,
      dueDate: "2020-01-15",
    });
    expect(issue.status).toBe(200);

    const provider = await admin.post("/admin/ai/providers", {
      name: "Ollama (sahte)",
      kind: "openai_compatible",
      baseUrl: `${stubUrl}/v1`,
      model: "qwen3:8b",
      disableThinking: true,
    });
    expect(provider.status).toBe(200);
    // Generous limit while testing; the rate-limit test lowers it.
    await admin.put("/admin/settings/ask", { perMinute: 600, burst: 100 });
    alice = client({ cookie: await login("alice@7d.test") });
    bob = client({ cookie: await login("bob@7d.test") });
  });

  it("calls a read tool, then answers with linked sources (and remembers the conversation)", async () => {
    requests.length = 0;
    script.push(tools({ name: "cde_search_files", args: { q: "STATIK" } }), (body) => {
      const result = JSON.parse(toolResults(body)[0]!);
      return { json: chat(`Statik paftası: [${result.files[0].ref}]. Son versiyon v${result.files[0].v}.`) };
    });
    const res = await alice.ask(p1.id, "Statik paftaları hangileri?");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.result;
    expect(res.body.status).toBe("done");
    expect(r.answer).toContain(`[STATIK-PAFTA-001.pdf](/projects/${p1.id}/files/${statik.id}?file=${statikFile.fileId})`);
    expect(r.sources[0]).toMatchObject({ type: "file", id: statikFile.fileId, label: "STATIK-PAFTA-001.pdf", cited: true });
    expect(r.toolCalls).toEqual([expect.objectContaining({ tool: "cde_search_files", ok: true })]);
    expect(r.toolCalls[0].ms).toBeGreaterThanOrEqual(0);
    expect(r).toMatchObject({ model: "qwen3:8b", provider: "Ollama (sahte)", protocol: "native", rounds: 1 });
    expect(typeof r.ms).toBe("number");
    expect(r.conversationId).toMatch(/^[0-9a-f-]{36}$/);

    // Only read tools are offered, without projectId (the assistant fixes it to the current project).
    // The router offers the file tools for a drawing question (always with overview and search).
    const offered: string[] = requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(["cde_project_overview", "cde_search_files", "cde_folder_contents", "cde_file_get"]));
    expect(offered).not.toContain("cde_schedule_activities");
    expect(r.toolSet).toEqual(offered);
    for (const w of WRITE_TOOLS) expect(offered).not.toContain(w);
    expect(offered).not.toContain("cde_projects_list");
    for (const t of requests[0].tools) expect(Object.keys(t.function.parameters.properties ?? {})).not.toContain("projectId");
    expect(requests[0].reasoning_effort).toBe("none");
    expect(requests[0].messages[0].content).toContain("P1 – Proje 1");
    // The tool result went back as a tool message, compact and tagged.
    const sent = JSON.parse(toolResults(requests[1])[0]!);
    expect(sent.files[0]).toMatchObject({ ref: expect.stringMatching(/^F\d+$/), name: "STATIK-PAFTA-001.pdf", folder: "Proje Dosyaları / Statik" });
    expect(JSON.stringify(sent)).not.toContain(statikFile.fileId);

    // Follow-up in the same conversation carries the previous turn.
    requests.length = 0;
    script.push(answer("Evet, tek dosya var."));
    const follow = await alice.ask(p1.id, "Başka var mı?", { conversationId: r.conversationId });
    expect(follow.body.result.conversationId).toBe(r.conversationId);
    const msgs = requests[0].messages.map((m: any) => m.content).join("\n");
    expect(msgs).toContain("Statik paftaları hangileri?");
    expect(msgs).toContain("Statik paftası: STATIK-PAFTA-001.pdf");

    // Audited without question or answer text.
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "ai.ask"));
    const first = rows.find((x) => (x.details as any).tools?.includes("cde_search_files"))!;
    expect(first).toMatchObject({ projectId: p1.id, userId: aliceId });
    expect(first.details).toMatchObject({ ok: true, questionLength: "Statik paftaları hangileri?".length, model: "qwen3:8b", rounds: 1 });
    expect((first.details as any).read).toContain(`file:${statikFile.fileId}`);
    expect(JSON.stringify(first.details)).not.toContain("hangileri");
    expect(JSON.stringify(first.details)).not.toContain("Statik paftası");
  });

  it("rejects unknown tools and tells the model which tools exist", async () => {
    requests.length = 0;
    let rejection = "";
    script.push(tools({ name: "cde_delete_everything", args: {} }), (body) => {
      rejection = toolResults(body)[0]!;
      return { json: chat("Bunu yapamam.") };
    });
    const res = await alice.ask(p1.id, "Her şeyi sil");
    expect(res.status).toBe(200);
    expect(rejection).toContain('"cde_delete_everything" adlı bir araç yok');
    expect(rejection).toContain("cde_search_files");
    expect(res.body.result.toolCalls).toEqual([{ tool: "cde_delete_everything", ms: 0, ok: false, error: "unknown_tool" }]);
    expect(res.body.steps.some((s: any) => s.label === "Reddedilen araç: cde_delete_everything" && s.state === "error")).toBe(true);
    expect(res.body.result.answer).toBe("Bunu yapamam.");
  });

  it("never runs write tools, even when the model asks for one", async () => {
    script.push(
      tools(
        { name: "cde_folder_create", args: { parentId: p1.rootFolderId, name: "AI klasörü" } },
        { name: "cde_issue_update", args: { issueId: "00000000-0000-0000-0000-000000000000", status: "closed" } },
      ),
      answer("Klasör oluşturamıyorum."),
    );
    const res = await alice.ask(p1.id, "Kök klasöre 'AI klasörü' aç");
    expect(res.body.result.toolCalls.map((t: any) => [t.tool, t.ok])).toEqual([
      ["cde_folder_create", false],
      ["cde_issue_update", false],
    ]);
    const root = await alice.get(`/projects/${p1.id}/folders/${p1.rootFolderId}/contents`);
    expect(root.body.folders.map((f: any) => f.name)).not.toContain("AI klasörü");
    const issues = await alice.get(`/projects/${p1.id}/issues`);
    expect(issues.body.every((i: any) => i.status === "open")).toBe(true);
  });

  it("bridges tool calls with the caller's identity, read-only and limited to the project", async () => {
    const bobUser = { id: bobId, email: "bob@7d.test", name: "Bob", isAdmin: false, companyId: null };
    const b = bridge.open(bobUser, p1.id, "test");
    const call = bridgeCall(app, b.key);
    try {
      await expect(call("POST", `/projects/${p1.id}/folders`, { parentId: p1.rootFolderId, name: "X" })).rejects.toMatchObject({ status: 403 });
      await expect(call("GET", `/projects/${p1.id}/folders/${gizli.id}/contents`)).rejects.toMatchObject({ status: 404 });
      await expect(call("GET", `/projects/${p2.id}`)).rejects.toMatchObject({ status: 404 });
      await expect(call("GET", "/admin/settings")).rejects.toMatchObject({ status: 403 });
      const visible = await call<{ results: { name: string }[] }>("GET", `/projects/${p1.id}/search`);
      expect(visible.results.map((r) => r.name)).toEqual(["STATIK-PAFTA-001.pdf"]);
      // Even an administrator's bridge cannot write.
      const adminBridge = bridge.open({ id: "x", email: "a", name: "A", isAdmin: true, companyId: null }, p1.id, "t2");
      await expect(bridgeCall(app, adminBridge.key)("PATCH", `/projects/${p1.id}`, { name: "Yeni" })).rejects.toMatchObject({ status: 403 });
      adminBridge.close();
    } finally {
      b.close();
    }
    // A closed (or forged) key authenticates nobody.
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${p1.id}`, headers: { "x-cde-ask-bridge": b.key } });
    expect(res.statusCode).toBe(401);
  });

  it("gives a user without folder access no data from that folder", async () => {
    requests.length = 0;
    script.push(
      tools(
        { name: "cde_search_files", args: { q: "GIZLI" } },
        { name: "cde_folder_contents", args: { folderId: gizli.id } },
        { name: "cde_search_files", args: {} },
      ),
      answer("Gizli bir rapor bulamadım."),
    );
    const res = await bob.ask(p1.id, "Gizli rapor nerede?");
    expect(res.status).toBe(200);
    const results = toolResults(requests[1]);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).not.toContain("GIZLI-RAPOR");
    expect(JSON.parse(results[0]!)).toMatchObject({ total: 0, files: [] });
    expect(results[1]).toMatch(/^Hata: HTTP 404/);
    expect(JSON.parse(results[2]!).files.map((f: any) => f.name)).toEqual(["STATIK-PAFTA-001.pdf"]);
    expect(res.body.result.toolCalls.map((t: any) => t.ok)).toEqual([true, false, true]);
    expect(JSON.stringify(res.body.result.sources)).not.toContain("GIZLI");

    // Issues: overdue flag and the assignee's company come from the members list.
    script.push(tools({ name: "cde_issues_list", args: {} }), (body) => ({ json: chat(toolResults(body)[0]!) }));
    const issues = await bob.ask(p1.id, "Termini geçen issue'lar hangi firmada?");
    const data = JSON.parse(issues.body.result.answer);
    expect(data).toMatchObject({ total: 1, overdue: 1 });
    expect(data.issues[0]).toMatchObject({ title: "Kolon donatısı eksik", overdue: true, assignee: "Bob", company: "Firma B", due: "2020-01-15" });
  });

  it("returns 403 with a clear message when AI is off for the system or the project", async () => {
    const before = requests.length;
    await admin.put("/admin/settings/ai", { mode: "off" });
    const off = await alice.ask(p1.id, "Kaç model var?");
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ error: "ai_off", message: "Yapay zekâ sistem yöneticisi tarafından kapatıldı." });
    await admin.put("/admin/settings/ai", { mode: "local_only" });

    await alice.put(`/projects/${p1.id}/ai`, { enabled: false, providerId: null, allowExternal: false });
    const projOff = await bob.ask(p1.id, "Kaç model var?");
    expect(projOff.status).toBe(403);
    expect(projOff.body).toMatchObject({ error: "ai_project_off", message: "Bu projede yapay zekâ kapalı." });
    await alice.put(`/projects/${p1.id}/ai`, { enabled: true, providerId: null, allowExternal: false });
    expect(requests.length).toBe(before); // the model was never called

    // Non-members get 404; refusals are audited too.
    expect((await bob.ask(p2.id, "Merhaba")).status).toBe(404);
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "ai.ask"));
    expect(rows.filter((r) => (r.details as any).ok === false).map((r) => (r.details as any).code)).toEqual(
      expect.arrayContaining(["ai_off", "ai_project_off"]),
    );
  });

  it("falls back to a JSON tool request protocol", async () => {
    // (1) The model writes the call as text.
    script.push(answer('{"tool": "cde_models_list", "args": {}}'), answer("Bu projede IFC modeli yok."));
    const res = await alice.ask(p1.id, "Kaç IFC modeli var?");
    expect(res.body.result).toMatchObject({ protocol: "json", answer: "Bu projede IFC modeli yok." });
    expect(res.body.result.toolCalls).toEqual([expect.objectContaining({ tool: "cde_models_list", ok: true })]);

    // (2) The server refuses tools: the assistant retries with the protocol in the prompt.
    requests.length = 0;
    script.push(
      () => ({ status: 400, json: { error: { message: "registry.ollama.ai/library/tiny does not support tools" } } }),
      answer('<tool_call>{"name": "cde_project_overview", "arguments": {}}</tool_call>'),
      answer("Projede 1 açık issue var."),
    );
    const res2 = await alice.ask(p1.id, "Proje özeti?");
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    expect(res2.body.result.protocol).toBe("json");
    expect(requests[0].tools).toBeDefined();
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].messages[0].content).toContain('{"tool":"<ad>","args":{...}}');
    const overview = requests[2].messages.at(-1).content as string;
    expect(overview).toContain("Araç sonucu (cde_project_overview)");
    expect(overview).toContain('"overdue":1');

    expect(parseToolRequests('```json\n{"name":"cde_issues_list","arguments":"{\\"status\\":\\"open\\"}"}\n```')).toEqual([
      { id: "text_0", name: "cde_issues_list", arguments: { status: "open" } },
    ]);
    expect(parseToolRequests("Elektrik paftaları şunlar: …")).toEqual([]);
  });

  it("runs as a polled job with progress steps, streams partial text and can be cancelled", async () => {
    script.push(tools({ name: "cde_folder_contents", args: {} }), () => ({
      sse: [
        JSON.stringify({ model: "qwen3:8b", choices: [{ index: 0, delta: { role: "assistant", content: "Kökte " } }] }),
        JSON.stringify({ model: "qwen3:8b", choices: [{ index: 0, delta: { content: "2 klasör var." }, finish_reason: "stop" }] }),
      ],
      delayMs: 300,
    }));
    const start = await alice.ask(p1.id, "Kök klasörde ne var?", {}, false);
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ status: "running" });
    let job = start.body;
    for (let i = 0; i < 100 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await alice.get(`/projects/${p1.id}/ask/${start.body.id}`)).body;
    }
    expect(job.status).toBe("done");
    expect(job.result.answer).toBe("Kökte 2 klasör var.");
    expect(job.steps.map((s: any) => s.label)).toEqual(["Soru inceleniyor…", "Araç: cde_folder_contents…", "Sonuçlar değerlendiriliyor…"]);
    expect(job.steps[1]).toMatchObject({ state: "ok" });
    // Extra arguments are ignored; a folder tag the model never saw lists the root.
    script.push(
      tools({ name: "cde_models_list", args: { folderId: "D7" } }, { name: "cde_folder_contents", args: { folderId: "D9" } }),
      (body) => ({ json: chat(JSON.stringify(toolResults(body).map((r) => JSON.parse(r)))) }),
    );
    const extra = JSON.parse((await alice.ask(p1.id, "Modeller ve kök?")).body.result.answer);
    expect(extra[0]).toMatchObject({ modelCount: 0 });
    expect(extra[1].folder.name).toBe("Proje Dosyaları");
    // Folder names work as folderId (small models rarely copy ids).
    script.push(tools({ name: "cde_folder_contents", args: { folderId: "statik" } }), (body) => ({ json: chat(toolResults(body)[0]!) }));
    const byName = await alice.ask(p1.id, "Statik klasöründe ne var?");
    expect(JSON.parse(byName.body.result.answer).files[0].name).toBe("STATIK-PAFTA-001.pdf");
    // Other users cannot read the job.
    expect((await bob.get(`/projects/${p1.id}/ask/${start.body.id}`)).status).toBe(404);

    script.push(() => ({ json: chat("geç"), delayMs: 5000 }));
    const slow = await alice.ask(p1.id, "Yavaş soru", {}, false);
    const busy = await alice.ask(p1.id, "İkinci soru", {}, false);
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe("ask_busy");
    const cancelled = await alice.post(`/projects/${p1.id}/ask/${slow.body.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: { code: "cancelled" } });
  });

  it("rate-limits questions per user", async () => {
    await admin.put("/admin/settings/ask", { perMinute: 0.5, burst: 1 });
    expect((await alice.put("/admin/settings/ask", { burst: 50 })).status).toBe(403);
    script.push(answer("Bir."));
    const first = await bob.ask(p1.id, "Birinci");
    expect(first.status).toBe(200);
    const second = await bob.ask(p1.id, "İkinci");
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    await admin.put("/admin/settings/ask", { perMinute: 600, burst: 100 });
    // Bob's bucket is empty; at 600/min it holds a token again after 100 ms. Later tests ask as Bob.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const b = new TokenBucket();
    const s = { perMinute: 60, burst: 2 };
    expect(b.take("u", s, 0).ok).toBe(true);
    expect(b.take("u", s, 0).ok).toBe(true);
    expect(b.take("u", s, 0)).toEqual({ ok: false, retryAfterSec: 1 });
    expect(b.take("u", s, 1000).ok).toBe(true);
  });

  it("lets read-only API tokens ask", async () => {
    const t = await alice.post("/auth/tokens", { name: "sor" });
    expect(t.status).toBe(200);
    script.push(answer("Hazır."));
    const res = await client({ token: t.body.token }).ask(p1.id, "Merhaba");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("routes each question to a small tool subset", () => {
    const tools = (q: string, prev: string[] = []) => routeTools(q, prev).tools;
    for (const q of ["Açık RFI'lar kimde bekliyor?", "Merhaba", "İş programında geciken kritik faaliyetler", "Çakışmalar hangi firmada?"]) {
      const t = tools(q);
      expect(t.slice(0, 2)).toEqual(["cde_project_overview", "cde_search_files"]);
      expect(t.length).toBeLessThanOrEqual(MAX_OFFERED_TOOLS);
    }
    expect(routeTools("Açık RFI'lar kimde bekliyor?").groups).toEqual(["rfi"]);
    expect(tools("Açık RFI'lar kimde bekliyor?")).toEqual(["cde_project_overview", "cde_search_files", "cde_rfi_log", "cde_works_list", "cde_work_get"]);
    expect(tools("Submittal register'da onaylanmayanlar")).toEqual(expect.arrayContaining(["cde_submittal_register", "cde_reviews_list"]));
    expect(routeTools("Son toplantının tutanağında kimlere aksiyon var?").groups).toContain("meeting");
    expect(tools("Açık kontrol formları hangi blokta?")).toEqual(expect.arrayContaining(["cde_forms_list", "cde_locations_tree"]));
    const schedule = routeTools("İş programında geciken kritik faaliyetler");
    expect(schedule.groups).toEqual(["schedule"]); // "iş programı" is not the works group
    expect(schedule.tools).toContain("cde_schedule_compare");
    expect(tools("Çakışmalar hangi firmada?")).toEqual(expect.arrayContaining(["cde_clash_tests_list", "cde_clash_results", "cde_members_list"]));
    expect(tools("A-101 paftasının antetindeki revizyon")).toEqual(expect.arrayContaining(["cde_file_antet", "cde_file_get"]));
    expect(tools("Termini geçen issue'lar")).toEqual(expect.arrayContaining(["cde_issues_list", "cde_today"]));
    expect(tools("Onay bekleyen review'lar")).toContain("cde_review_get");
    // No keyword: the general set. A follow-up keeps the previous question's groups.
    expect(tools("Merhaba")).toEqual(["cde_project_overview", "cde_search_files", "cde_folder_contents", "cde_issues_list", "cde_reviews_list", "cde_works_list", "cde_models_list"]);
    expect(routeTools("Başka var mı?", ["Açık RFI'lar?"]).groups).toEqual(["rfi"]);
  });

  it.skipIf(!hasManage)("answers RFI questions with the routed tools, tags works and extends the overview", async () => {
    const companies = (await admin.get("/companies")).body as { id: string; name: string }[];
    const firmaB = companies.find((c) => c.name === "Firma B")!;
    const fields = { soru: "Kolon ölçüsü nedir?", disiplin: "M - Mekanik", kategori: "Tasarım Koordinasyonu", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Var" };
    const rfi = await alice.post(`/projects/${p1.id}/works`, { typeKey: "rfi", title: "Kolon ölçüsü", fields, toCompanyIds: [firmaB.id], dueDate: "2020-03-01" });
    expect(rfi.status, JSON.stringify(rfi.body)).toBe(200);
    expect((await alice.post(`/projects/${p1.id}/works/${rfi.body.id}/submit`, {})).status).toBe(200);

    requests.length = 0;
    let logResult: any;
    let detail: any;
    script.push(
      tools({ name: "cde_rfi_log", args: { open: true } }),
      (body) => {
        logResult = JSON.parse(toolResults(body)[0]!);
        // The model passes the RFI number instead of an id.
        return { json: chat("", [{ name: "cde_work_get", args: { workId: rfi.body.number } }]) };
      },
      (body) => {
        detail = JSON.parse(toolResults(body)[1]!);
        return { json: chat(`Açık RFI: [${logResult.rfis[0].ref}], gecikmede.`) };
      },
    );
    const res = await alice.ask(p1.id, "Açık RFI'lar kimde bekliyor?");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.result;
    const offered: string[] = requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual(["cde_project_overview", "cde_search_files", "cde_rfi_log", "cde_works_list", "cde_work_get"]);
    for (const t of requests[0].tools) expect(t.function.description.length).toBeLessThan(260);
    expect(logResult).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(logResult.rfis[0]).toMatchObject({ ref: expect.stringMatching(/^W\d+$/), number: rfi.body.number, overdue: true });
    expect(JSON.stringify(logResult)).not.toContain(rfi.body.id);
    expect(detail).toMatchObject({ ref: logResult.rfis[0].ref, title: "Kolon ölçüsü" });
    expect(detail.workflow.steps.length).toBeGreaterThan(0);
    expect(r.toolCalls.map((t: any) => [t.tool, t.ok])).toEqual([
      ["cde_rfi_log", true],
      ["cde_work_get", true],
    ]);
    expect(r.answer).toContain(`(/projects/${p1.id}/works/${rfi.body.id})`);
    expect(r.sources[0]).toMatchObject({ type: "work", id: rfi.body.id, cited: true });

    // The overview counts works by type, open forms, the schedule and open clashes in one call.
    let overview: any;
    script.push(tools({ name: "cde_project_overview", args: {} }), (body) => {
      overview = JSON.parse(toolResults(body)[0]!);
      return { json: chat("1 açık RFI var.") };
    });
    const sum = await alice.ask(p1.id, "Kaç açık RFI var, geciken var mı?");
    expect(sum.body.result.rounds).toBe(1);
    expect(overview.works).toMatchObject({ total: 1, open: 1, overdue: 1 });
    const rfiType = Object.values(overview.works.byType)[0] as any;
    expect(rfiType).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(Object.keys(rfiType.openByStatus)).toHaveLength(1);
    expect(overview.forms).toEqual({ open: 0 });
    expect(overview.clashes).toEqual({ tests: 0, open: 0 });
    expect(overview.schedule).toBeNull();
    expect(overview.issues).toMatchObject({ total: 1, overdue: 1 });

    // Bob (company B, the addressee) sees the RFI through the assistant too.
    script.push(tools({ name: "cde_works_list", args: { open: true } }), (body) => ({ json: chat(toolResults(body)[0]!) }));
    const bobs = JSON.parse((await bob.ask(p1.id, "Açık işler hangileri?")).body.result.answer);
    expect(bobs.works.map((w: any) => w.number)).toContain(rfi.body.number);
  });

  it("links cited tags and drops unknown ones", () => {
    const refs = new Refs("p");
    const f = refs.add("file", "f-1", "A [rev] .pdf", { folderId: "d-1" });
    const i = refs.add("issue", "i-1", "#3 Kapı");
    const p = refs.add("report", "template:correspondence-status", "Yazışma Durumu");
    const s = refs.add("spec", "s-1", "Elektrik Şartnamesi.pdf", { fileId: "f-2" });
    const { markdown, cited } = linkifyRefs(`Dosya [${f}], issue [${i}, F99], rapor [${p}], şartname [${s}] ve [M3] kodu.`, refs);
    expect(markdown).toBe(
      "Dosya [A (rev) .pdf](/projects/p/files/d-1?file=f-1), issue [#3 Kapı](/projects/p/issues/i-1), rapor [Yazışma Durumu](/projects/p/reports?template=correspondence-status), şartname [Elektrik Şartnamesi.pdf](/projects/p/spec/s-1) ve kodu.",
    );
    expect(cited).toEqual([f, i, p, s]);
    expect(linkifyRefs(`**${i}**: kapı (${f}), rapor (**${p}**), kod (M3)`, refs).markdown).toBe(
      "**[#3 Kapı](/projects/p/issues/i-1)**: kapı ([A (rev) .pdf](/projects/p/files/d-1?file=f-1)), rapor (**[Yazışma Durumu](/projects/p/reports?template=correspondence-status)**), kod (M3)",
    );
    expect(linkifyRefs(`Model var. [Kaynak: ${f}]`, refs).markdown).toBe("Model var. [A (rev) .pdf](/projects/p/files/d-1?file=f-1)");
    expect(refs.resolveArgs({ folderId: f, fileId: f.toLowerCase(), issueId: "#3 Kapı", registerId: s, q: "F1" })).toEqual({
      folderId: "d-1",
      fileId: "f-1",
      issueId: "i-1",
      registerId: "s-1",
      q: "F1",
    });
  });

  it("prunes stored conversations and finished questions past their TTL, and nothing else", async () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await handle.db.insert(systemSettings).values([
      { key: "ai.ask.conv.old", value: {}, updatedAt: at(31) },
      { key: "ai.ask.conv.fresh", value: {}, updatedAt: at(29) },
      { key: "ai.ask.job.old", value: {}, updatedAt: at(11) },
      { key: "ai.ask.job.fresh", value: {}, updatedAt: at(9) },
      { key: "ai.mode.cleanup-test", value: {}, updatedAt: at(10_000) },
    ]);
    expect(await cleanupAskHistory(handle.db, now)).toBe(2);
    const left = (await handle.db.select({ key: systemSettings.key }).from(systemSettings)).map((r) => r.key);
    expect(left).toEqual(expect.arrayContaining(["ai.ask.conv.fresh", "ai.ask.job.fresh", "ai.mode.cleanup-test"]));
    expect(left).not.toContain("ai.ask.conv.old");
    expect(left).not.toContain("ai.ask.job.old");
  });
});
