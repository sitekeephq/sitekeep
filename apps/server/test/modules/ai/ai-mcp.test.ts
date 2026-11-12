import { createServer, type IncomingMessage, type Server } from "node:http";
import { hasField, hasManage, hasPlanning } from "../../helpers/modules.js"; // these steps use Field (forms) and Planning (schedule)
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { isPrivateHost } from "../../../src/ai/hosts.js";
import { AiError, resolveProvider, stripThinking } from "../../../src/ai/provider.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, systemSettings, users } from "../../../src/db/schema.js";
import { userAiCredentials } from "@7dimensions-project/sitekeep-ee-ai/internal/schema-tables.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { decryptSecret } from "../../../src/core/platform/secrets.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const PW = "Sifre-1234567";
const SECRET_KEY = Buffer.alloc(32, 7);

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

// Fake OpenAI-compatible and Anthropic endpoints on 127.0.0.1 — tests never call a real model.
let stub: Server;
let stubUrl: string;
const stubRequests: { url: string; headers: IncomingMessage["headers"]; body: any }[] = [];
const modelCalls: { apiKey: string; workspaceId: string | null }[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-ai-test-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    secretKey: SECRET_KEY,
    personalAiTest: async (_db, _secretKey, _userId, provider, candidate) => {
      if (candidate.apiKey?.includes("invalid")) throw new AiError(502, "provider_error", "API anahtarı doğrulanamadı.");
      return { ok: true, model: candidate.model ?? (provider === "anthropic" ? "claude-haiku-5-5" : "auto"), reply: "Hazırım", latencyMs: 12 };
    },
    personalAiModels: async (apiKey, workspaceId) => {
      modelCalls.push({ apiKey, workspaceId: workspaceId ?? null });
      if (apiKey.includes("multi") && !workspaceId) throw new AiError(422, "personal_ai_workspace", "Workspace gerekli.");
      return [
        { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      ];
    },
  });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });

  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      stubRequests.push({ url: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            id: "x",
            model: body.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "<think>düşünüyorum</think>\nHazırım" } }],
          }),
        );
      } else if (req.url === "/v1/messages") {
        res.end(JSON.stringify({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: "Hazırım, Claude." }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "yok" } }));
      }
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await new Promise((r) => stub.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

type Caller = ReturnType<typeof client>;
/** REST client authenticated with a session cookie or a Bearer token. */
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
  };
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

describe("API token scopes, MCP endpoint and AI governance", () => {
  let admin: Caller;
  let alice: Caller; // project admin of P1, member of P2
  let bob: Caller; // member of P1
  let p1: { id: string; rootFolderId: string };
  let p2: { id: string; rootFolderId: string };
  let readToken: string;
  let writeToken: string;

  it("sets up users and projects", async () => {
    admin = client({ cookie: await login("admin@7d.test") });
    await admin.post("/users", { email: "alice@7d.test", name: "Alice", password: PW });
    await admin.post("/users", { email: "bob@7d.test", name: "Bob", password: PW });
    p1 = (await admin.post("/projects", { code: "P1", name: "Proje 1" })).body;
    p2 = (await admin.post("/projects", { code: "P2", name: "Proje 2" })).body;
    await admin.post(`/projects/${p1.id}/members`, { email: "alice@7d.test", isProjectAdmin: true });
    await admin.post(`/projects/${p2.id}/members`, { email: "alice@7d.test" });
    await admin.post(`/projects/${p1.id}/members`, { email: "bob@7d.test" });
    alice = client({ cookie: await login("alice@7d.test") });
    bob = client({ cookie: await login("bob@7d.test") });
  });

  it("encrypts user-owned AI keys, masks them and isolates them by user", async () => {
    const initial = await alice.get("/me/ai-credentials");
    expect(initial.status).toBe(200);
    expect(initial.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic", hasApiKey: false }),
        expect.objectContaining({ id: "cursor", hasApiKey: false }),
      ]),
    );

    const plain = "sk-ant-personal-secret-123";
    const saved = await alice.patch("/me/ai-credentials/anthropic", {
      apiKey: plain,
      model: "claude-haiku-5-5",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic", hasApiKey: true, maskedKey: "••••••••••••-123", model: "claude-haiku-5-5" }),
      ]),
    );
    expect(JSON.stringify(saved.body)).not.toContain(plain);

    const [aliceRow] = await handle.db.select().from(users).where(eq(users.email, "alice@7d.test"));
    const [stored] = await handle.db
      .select()
      .from(userAiCredentials)
      .where(and(eq(userAiCredentials.userId, aliceRow!.id), eq(userAiCredentials.provider, "anthropic")));
    expect(stored?.apiKeyEnc).not.toContain(plain);
    expect(decryptSecret(SECRET_KEY, stored!.apiKeyEnc!)).toBe(plain);

    const bobView = await bob.get("/me/ai-credentials");
    expect(bobView.body.providers.find((provider: any) => provider.id === "anthropic")).toMatchObject({ hasApiKey: false });
    const projectView = await alice.get(`/projects/${p1.id}/ai`);
    expect(JSON.stringify(projectView.body)).not.toContain(plain);
    expect(projectView.body.personal.providers.find((provider: any) => provider.id === "anthropic")).toMatchObject({ hasApiKey: true });

    const rejected = await alice.patch("/me/ai-credentials/anthropic", {
      apiKey: "sk-ant-invalid",
      model: "claude-sonnet-5-5",
    });
    expect(rejected.status).toBe(502);
    const [unchanged] = await handle.db
      .select()
      .from(userAiCredentials)
      .where(and(eq(userAiCredentials.userId, aliceRow!.id), eq(userAiCredentials.provider, "anthropic")));
    expect(decryptSecret(SECRET_KEY, unchanged!.apiKeyEnc!)).toBe(plain);
    expect(unchanged!.model).toBe("claude-haiku-5-5");

    const removed = await alice.patch("/me/ai-credentials/anthropic", { apiKey: null });
    expect(removed.body.providers.find((provider: any) => provider.id === "anthropic")).toMatchObject({ hasApiKey: false });
  });

  it("reads a Claude key's models from Anthropic and keeps its Workspace", async () => {
    // A candidate key is only listed, nothing is stored.
    const listed = await alice.post("/me/ai-credentials/anthropic/models", { apiKey: "sk-ant-multi-1", workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy" });
    expect(listed.status).toBe(200);
    expect(listed.body.models.map((m: any) => m.id)).toEqual(["claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(modelCalls.at(-1)).toEqual({ apiKey: "sk-ant-multi-1", workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy" });
    expect((await alice.get("/me/ai-credentials")).body.providers.find((p: any) => p.id === "anthropic")).toMatchObject({ hasApiKey: false });

    expect((await alice.patch("/me/ai-credentials/anthropic", { apiKey: "sk-ant-multi-1", workspaceId: "ws-1" })).status).toBe(400);
    // A multi-Workspace key without its Workspace fails before anything is stored.
    expect((await alice.patch("/me/ai-credentials/anthropic", { apiKey: "sk-ant-multi-1" })).status).toBe(422);
    expect((await alice.patch("/me/ai-credentials/anthropic", { apiKey: "sk-ant-multi-1", workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy", model: "claude-opus-1" })).status).toBe(400);

    const saved = await alice.patch("/me/ai-credentials/anthropic", {
      apiKey: "sk-ant-multi-1",
      workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy",
      model: "claude-fable-5-1",
    });
    expect(saved.status).toBe(200);
    const claude = saved.body.providers.find((p: any) => p.id === "anthropic");
    expect(claude).toMatchObject({ hasApiKey: true, model: "claude-fable-5-1", workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy" });
    expect(claude.models.map((m: any) => m.id)).toContain("claude-fable-5-1");

    // Changing only the model uses the stored list; refreshing lists with the stored key and Workspace.
    const calls = modelCalls.length;
    expect((await alice.patch("/me/ai-credentials/anthropic", { model: "claude-sonnet-5-5" })).status).toBe(200);
    expect(modelCalls.length).toBe(calls);
    expect((await alice.post("/me/ai-credentials/anthropic/models", {})).status).toBe(200);
    expect(modelCalls.at(-1)).toEqual({ apiKey: "sk-ant-multi-1", workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy" });

    const removed = await alice.patch("/me/ai-credentials/anthropic", { apiKey: null });
    expect(removed.body.providers.find((p: any) => p.id === "anthropic")).toMatchObject({ hasApiKey: false, workspaceId: null });
  });

  it("enforces who may create tokens and whether write tokens are allowed", async () => {
    const policy = await bob.get("/auth/token-policy");
    expect(policy.body).toMatchObject({ canCreate: false, allowWriteTokens: false, tokenCreators: "project_admins" });
    expect((await bob.post("/auth/tokens", { name: "b" })).status).toBe(403);

    const t = await alice.post("/auth/tokens", { name: "Claude Code" });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ scope: "read", projectIds: null, expiresAt: null });
    readToken = t.body.token;
    expect((await alice.post("/auth/tokens", { name: "w", scope: "write" })).status).toBe(403);

    // Only admins.
    await admin.put("/admin/settings/mcp", { tokenCreators: "admins" });
    expect((await alice.post("/auth/tokens", { name: "x" })).status).toBe(403);
    // Everyone, with a 30 day limit.
    await admin.put("/admin/settings/mcp", { tokenCreators: "everyone", maxTokenDays: 30 });
    expect((await bob.post("/auth/tokens", { name: "never", expiresInDays: null })).status).toBe(400);
    expect((await bob.post("/auth/tokens", { name: "long", expiresInDays: 90 })).status).toBe(400);
    const limited = await bob.post("/auth/tokens", { name: "default" });
    expect(limited.status).toBe(200);
    const days = (new Date(limited.body.expiresAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const listed = (await bob.get("/auth/tokens")).body;
    expect(listed[0]).toMatchObject({ name: "default", scope: "read" });

    // Non-admins cannot change the policy; API tokens cannot change settings at all.
    expect((await alice.put("/admin/settings/mcp", { allowWriteTokens: true })).status).toBe(403);
    await admin.put("/admin/settings/mcp", { tokenCreators: "project_admins", maxTokenDays: null, allowWriteTokens: true });
    const w = await alice.post("/auth/tokens", { name: "yazma", scope: "write", expiresInDays: 90 });
    expect(w.status).toBe(200);
    writeToken = w.body.token;
  });

  it("lets read tokens GET but not change anything", async () => {
    const r = client({ token: readToken });
    expect((await r.get("/projects")).body.map((p: { code: string }) => p.code).sort()).toEqual(["P1", "P2"]);
    expect((await r.get(`/projects/${p1.id}/folders/${p1.rootFolderId}/contents`)).status).toBe(200);
    expect((await r.post(`/projects/${p1.id}/folders`, { parentId: p1.rootFolderId, name: "X" })).status).toBe(403);
    expect((await r.patch(`/projects/${p1.id}`, { name: "Yeni ad" })).status).toBe(403);
    expect((await r.del(`/projects/${p1.id}/members/00000000-0000-0000-0000-000000000000`)).status).toBe(403);
    // Read-only POSTs are allowed.
    const check = await r.post(`/projects/${p1.id}/naming/validate`, { folderId: p1.rootFolderId, names: ["a.pdf"] });
    expect(check.status).toBe(200);
    // Tokens cannot mint tokens or change passwords.
    expect((await r.post("/auth/tokens", { name: "kaçak" })).status).toBe(403);
    const w = client({ token: writeToken });
    expect((await w.post("/auth/tokens", { name: "kaçak", scope: "write" })).status).toBe(403);
    expect((await w.post("/auth/password", { currentPassword: PW, newPassword: "Baska-sifre-123" })).status).toBe(403);
    // Write tokens can write.
    expect((await w.post(`/projects/${p1.id}/folders`, { parentId: p1.rootFolderId, name: "Token klasörü" })).status).toBe(200);
  });

  it("hides other projects from project-restricted tokens", async () => {
    const t = await alice.post("/auth/tokens", { name: "yalnız P1", projectIds: [p1.id] });
    expect(t.body.projectIds).toEqual([p1.id]);
    const r = client({ token: t.body.token });
    expect((await r.get("/projects")).body.map((p: { code: string }) => p.code)).toEqual(["P1"]);
    expect((await r.get(`/projects/${p1.id}`)).status).toBe(200);
    expect((await r.get(`/projects/${p2.id}`)).status).toBe(404);
    expect((await r.get(`/projects/${p2.id}/folders/${p2.rootFolderId}/contents`)).status).toBe(404);
    // Cannot restrict a token to a project the user is not a member of.
    expect((await bob.post("/auth/tokens", { name: "x", projectIds: [p2.id] })).status).toBe(403); // bob is no project admin
    await admin.put("/admin/settings/mcp", { tokenCreators: "everyone" });
    expect((await bob.post("/auth/tokens", { name: "x", projectIds: [p2.id] })).status).toBe(400);
    await admin.put("/admin/settings/mcp", { tokenCreators: "project_admins" });
  });

  it("serves the CDE tools over hosted MCP with the token's rights", async () => {
    const init = await mcp(readToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("7d-cde");

    const list = await mcp(readToken, "tools/list");
    const names: string[] = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("cde_projects_list");
    expect(names).toContain("cde_naming_validate");
    expect(names).not.toContain("cde_folder_create");
    // Local file tools are stdio-only.
    expect(names).not.toContain("cde_file_upload");
    expect(names).not.toContain("cde_file_download");
    // AI schemas are readable; the Claude-as-AI save tools and the task queue need a write token;
    // developer tools exist only on a CDE_DEV_TOOLS=1 server.
    expect(names).toContain("cde_ai_schemas");
    for (const n of ["cde_report_save", "cde_form_template_save", "cde_form_flow_save", "cde_work_draft", "cde_workflow_template_save", "cde_ai_tasks_list", "cde_ai_task_claim"])
      expect(names).not.toContain(n);
    expect(names.some((n) => n.startsWith("cde_dev_"))).toBe(false);

    const res = await mcp(readToken, "tools/call", { name: "cde_projects_list", arguments: {} });
    expect(res.body.result.isError).toBeFalsy();
    const projects = JSON.parse(res.body.result.content[0].text);
    expect(projects.map((p: { code: string }) => p.code).sort()).toEqual(["P1", "P2"]);

    // Write tools are absent for read tokens.
    const denied = await mcp(readToken, "tools/call", {
      name: "cde_folder_create",
      arguments: { projectId: p1.id, parentId: p1.rootFolderId, name: "MCP" },
    });
    expect(denied.body.error ?? denied.body.result?.isError).toBeTruthy();

    // Write tokens get write tools; the REST layer still checks folder permissions.
    const wlist = await mcp(writeToken, "tools/list");
    const wnames: string[] = wlist.body.result.tools.map((t: { name: string }) => t.name);
    expect(wnames).toContain("cde_folder_create");
    expect(wnames).not.toContain("cde_file_upload");
    for (const n of ["cde_report_save", "cde_form_template_save", "cde_form_flow_save", "cde_work_draft", "cde_workflow_template_save", "cde_ai_tasks_list", "cde_ai_task_claim", "cde_ai_task_complete", "cde_ai_task_fail"])
      expect(wnames).toContain(n);
    expect(wnames.some((n) => n.startsWith("cde_dev_"))).toBe(false);
    const created = await mcp(writeToken, "tools/call", {
      name: "cde_folder_create",
      arguments: { projectId: p1.id, parentId: p1.rootFolderId, name: "MCP klasörü" },
    });
    expect(created.body.result.isError, created.body.result.content[0].text).toBeFalsy();
    // Alice is not a member with manage rights in P2's root → REST answers, tool reports the error.
    const p2try = await mcp(writeToken, "tools/call", {
      name: "cde_folder_create",
      arguments: { projectId: p2.id, parentId: p2.rootFolderId, name: "Yasak" },
    });
    expect(p2try.body.result.isError).toBe(true);

    // When the admin forbids write tokens, existing write tokens are read-only over MCP.
    await admin.put("/admin/settings/mcp", { allowWriteTokens: false });
    const ro = await mcp(writeToken, "tools/list");
    expect(ro.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("cde_folder_create");
    await admin.put("/admin/settings/mcp", { allowWriteTokens: true });

    // Every call is audited.
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "mcp.tool"));
    const tools = rows.map((r) => (r.details as { tool: string }).tool);
    expect(tools).toEqual(expect.arrayContaining(["cde_projects_list", "cde_folder_create"]));
    expect(rows.find((r) => (r.details as { tool: string }).tool === "cde_folder_create" && r.projectId === p1.id)).toBeTruthy();
  });

  it.skipIf(!hasField || !hasPlanning || !hasManage)("serves the construction-module tools: reads for every token, writes only for write tokens", async () => {
    const READ = [
      "cde_work_types_list", "cde_works_list", "cde_work_get", "cde_rfi_log", "cde_submittal_register", "cde_today",
      "cde_reviews_list", "cde_review_get", "cde_form_templates_list", "cde_forms_list", "cde_form_get", "cde_locations_tree",
      "cde_schedule_list", "cde_schedule_activities", "cde_schedule_compare", "cde_clash_tests_list", "cde_clash_results",
      "cde_spec_registers_list", "cde_spec_register_get", "cde_file_antet", "cde_document_compare",
    ];
    const WRITE = [
      "cde_work_create", "cde_work_comment", "cde_work_submit", "cde_work_respond", "cde_meeting_minutes_update",
      "cde_form_create_draft", "cde_form_template_from_description", "cde_spec_register_build",
    ];
    const names = (r: any): string[] => r.body.result.tools.map((t: { name: string }) => t.name);
    const ro = names(await mcp(readToken, "tools/list"));
    for (const n of READ) expect(ro).toContain(n);
    for (const n of WRITE) expect(ro).not.toContain(n);
    const rw = await mcp(writeToken, "tools/list");
    for (const n of [...READ, ...WRITE]) expect(names(rw)).toContain(n);
    const createTool = rw.body.result.tools.find((t: any) => t.name === "cde_work_create");
    expect(createTool.description).toContain("confirm with the user");
    expect(createTool.annotations.readOnlyHint).toBe(false);

    const tool = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await mcp(token, "tools/call", { name, arguments: args });
      const text: string = res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body);
      return { isError: !!(res.body.error ?? res.body.result?.isError), text, json: () => JSON.parse(text) };
    };

    // Work types → create an RFI (validated by the API) → it shows up in the list, log and details.
    const types = (await tool(readToken, "cde_work_types_list", { projectId: p1.id })).json();
    const rfiType = types.find((t: any) => t.category === "rfi");
    expect(rfiType.fields.some((f: any) => f.required)).toBe(true);
    const invalid = await tool(writeToken, "cde_work_create", { projectId: p1.id, typeKey: rfiType.key, title: "Eksik alanlı" });
    expect(invalid.isError).toBe(true);
    const company = (await admin.post("/companies", { name: "MSV" })).body;
    const fields = { soru: "Kolon ölçüsü nedir?", disiplin: "M - Mekanik", kategori: "Tasarım Koordinasyonu", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Var" };
    const created = await tool(writeToken, "cde_work_create", {
      projectId: p1.id, typeKey: "rfi", title: "Kolon ölçüsü", fields, toCompanyIds: [company.id], dueDate: "2020-02-01",
    });
    expect(created.isError, created.text).toBe(false);
    const rfi = created.json();
    expect(rfi).toMatchObject({ title: "Kolon ölçüsü", overdue: true, link: `/projects/${p1.id}/works/${rfi.id}` });
    // Read tokens cannot reach write tools.
    expect((await tool(readToken, "cde_work_comment", { projectId: p1.id, workId: rfi.id, body: "x" })).isError).toBe(true);
    const commented = await tool(writeToken, "cde_work_comment", { projectId: p1.id, workId: rfi.id, body: "Acil bakılsın" });
    expect(commented.isError, commented.text).toBe(false);
    const submitted = await tool(writeToken, "cde_work_submit", { projectId: p1.id, workId: rfi.id, comment: "Gönderildi" });
    expect(submitted.isError, submitted.text).toBe(false);
    expect(submitted.json().status).not.toBe("Taslak");

    const list = (await tool(readToken, "cde_works_list", { projectId: p1.id, category: "rfi", open: true })).json();
    expect(list).toMatchObject({ total: 1, overdue: 1 });
    expect(list.works[0]).toMatchObject({ id: rfi.id, number: rfi.number, title: "Kolon ölçüsü", overdue: true });
    const log = (await tool(readToken, "cde_rfi_log", { projectId: p1.id, overdue: true })).json();
    expect(log).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(log.rfis[0]).toMatchObject({ number: rfi.number, discipline: expect.stringContaining("Mekanik") });
    const detail = (await tool(readToken, "cde_work_get", { projectId: p1.id, workId: rfi.id })).json();
    expect(detail.fields.soru).toBe("Kolon ölçüsü nedir?");
    expect(detail.timeline.last.some((e: any) => e.kind === "comment" && e.text === "Acil bakılsın")).toBe(true);
    expect(detail.workflow.steps.length).toBeGreaterThan(0);
    // The submitter is not the reviewer: the API refuses and the tool reports it.
    const respond = await tool(writeToken, "cde_work_respond", { projectId: p1.id, workId: rfi.id, outcome: "reviewed", response: "x" });
    expect(respond.isError).toBe(true);

    // Meeting minutes through MCP become action works.
    const meeting = await tool(writeToken, "cde_work_create", {
      projectId: p1.id, typeKey: "toplanti", title: "Haftalık koordinasyon", fields: { tur: "Koordinasyon", tarih: "2026-10-12", saat: "10:00", yer: "Ofis" }, toCompanyIds: [company.id],
    });
    expect(meeting.isError, meeting.text).toBe(false);
    const minutes = await tool(writeToken, "cde_meeting_minutes_update", {
      projectId: p1.id, workId: meeting.json().id, items: [{ konu: "Kalıp", karar: "Revize", sorumluCompanyId: company.id, termin: "2026-10-20" }], notes: "Not",
    });
    expect(minutes.isError, minutes.text).toBe(false);
    expect(minutes.json().saved).toMatchObject({ created: 1 });
    const mget = (await tool(readToken, "cde_work_get", { projectId: p1.id, workId: meeting.json().id })).json();
    expect(mget.meeting.minutes[0]).toMatchObject({ konu: "Kalıp", sorumlu: "MSV", termin: "2026-10-20", action: true });
    expect(mget.items).toHaveLength(1);

    // Other modules answer compactly on an empty project.
    expect((await tool(readToken, "cde_today", {})).json().counts).toBeDefined();
    expect((await tool(readToken, "cde_forms_list", { projectId: p1.id, status: "open" })).json()).toMatchObject({ total: 0, open: 0 });
    expect((await tool(readToken, "cde_schedule_list", { projectId: p1.id })).text).toBe("[]");
    expect((await tool(readToken, "cde_schedule_activities", { projectId: p1.id, late: true })).isError).toBe(true);
    expect((await tool(readToken, "cde_clash_tests_list", { projectId: p1.id })).text).toBe("[]");
    expect((await tool(readToken, "cde_locations_tree", { projectId: p1.id })).json()).toMatchObject({ count: 0 });
    expect((await tool(readToken, "cde_reviews_list", { projectId: p1.id })).json()).toMatchObject({ total: 0 });
    const draft = await tool(writeToken, "cde_form_create_draft", { projectId: p1.id, templateId: "00000000-0000-0000-0000-000000000000" });
    expect(draft.isError).toBe(true);

    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "mcp.tool"));
    const audited = rows.map((r) => (r.details as { tool: string }).tool);
    expect(audited).toEqual(expect.arrayContaining(["cde_work_create", "cde_work_submit", "cde_meeting_minutes_update", "cde_rfi_log"]));
    expect(rows.find((r) => (r.details as any).tool === "cde_work_respond" && (r.details as any).ok === false)).toBeTruthy();
  });

  it("rejects MCP without an API token, with GET, and when disabled", async () => {
    const anon = await mcp(null, "tools/list");
    expect(anon.status).toBe(401);
    const cookie = await login("alice@7d.test");
    expect((await mcp(null, "tools/list", {}, { cookie })).status).toBe(401);
    const get = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${readToken}` } });
    expect(get.statusCode).toBe(405);

    await admin.put("/admin/settings/mcp", { enabled: false });
    expect((await mcp(readToken, "tools/list")).status).toBe(403);
    await admin.put("/admin/settings/mcp", { enabled: true });
    expect((await mcp(readToken, "tools/list")).status).toBe(200);
  });

  let deepseekId: string;
  let localId: string;
  let claudeId: string;

  it("encrypts provider API keys and never returns them", async () => {
    const res = await admin.post("/admin/ai/providers", {
      name: "DeepSeek",
      kind: "openai_compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-test-gizli-anahtar-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasApiKey: true, external: true });
    expect(JSON.stringify(res.body)).not.toContain("sk-test-gizli");
    deepseekId = res.body.id;

    const settings = await admin.get("/admin/settings");
    expect(JSON.stringify(settings.body)).not.toContain("sk-test-gizli");
    expect(settings.body.ai.mode).toBe("local_only");

    const [row] = await handle.db.select().from(systemSettings).where(eq(systemSettings.key, "ai.providers"));
    const stored = JSON.stringify(row!.value);
    expect(stored).not.toContain("sk-test-gizli");
    const enc = (row!.value as { apiKeyEnc: string }[])[0]!.apiKeyEnc;
    expect(decryptSecret(SECRET_KEY, enc)).toBe("sk-test-gizli-anahtar-123");

    // Keep on update when omitted, remove with null.
    await admin.patch(`/admin/ai/providers/${deepseekId}`, { model: "deepseek-chat" });
    expect((await admin.get("/admin/settings")).body.ai.providers[0].hasApiKey).toBe(true);
    expect((await alice.get("/admin/settings")).status).toBe(403);
  });

  it("refuses external providers in local-only mode and talks to local ones", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const blocked = await admin.post(`/admin/ai/providers/${deepseekId}/test`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe("external_blocked");

      const local = await admin.post("/admin/ai/providers", {
        name: "Ollama (yerel)",
        kind: "openai_compatible",
        baseUrl: `${stubUrl}/v1`,
        model: "qwen3:8b",
        embeddingModel: "bge-m3",
        disableThinking: true,
      });
      expect(local.body).toMatchObject({ external: false, hasApiKey: false, disableThinking: true });
      localId = local.body.id;
      const ok = await admin.post(`/admin/ai/providers/${localId}/test`);
      expect(ok.body).toMatchObject({ ok: true, reply: "Hazırım", model: "qwen3:8b" });
      expect(ok.body.latencyMs).toBeGreaterThanOrEqual(0);
      // Speed for the admin ("Bağlantıyı Test Et"): tokens per second (estimated without usage).
      expect(ok.body.outputTokens).toBeGreaterThan(0);
      expect(ok.body.estimated).toBe(true);
      const sent = stubRequests.at(-1)!;
      expect(sent.url).toBe("/v1/chat/completions");
      expect(sent.body.messages.at(-1).content).toMatch(/ \/no_think$/);
      expect(sent.body.reasoning_effort).toBe("none");

      // Claude through the stub (a local host) — the API key is decrypted and sent as x-api-key.
      const claude = await admin.post("/admin/ai/providers", {
        name: "Claude (stub)",
        kind: "anthropic",
        baseUrl: stubUrl,
        model: "claude-sonnet-5-5",
        apiKey: "sk-ant-test",
      });
      claudeId = claude.body.id;
      const c = await admin.post(`/admin/ai/providers/${claudeId}/test`);
      expect(c.body).toMatchObject({ ok: true, reply: "Hazırım, Claude." });
      const creq = stubRequests.at(-1)!;
      expect(creq.url).toBe("/v1/messages");
      expect(creq.headers["x-api-key"]).toBe("sk-ant-test");
      expect(creq.headers["anthropic-version"]).toBe("2023-06-01");
      expect(creq.body).toMatchObject({ model: "claude-sonnet-5-5", messages: [{ role: "user" }] });

      // No request ever left for the external host.
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("deepseek"))).toBe(false);

      const audits = await handle.db.select().from(auditLog).where(eq(auditLog.action, "ai.provider_tested"));
      expect(audits.length).toBeGreaterThanOrEqual(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves providers by system mode and project policy", async () => {
    const db = handle.db;
    // Default is the first provider created (DeepSeek, external) → refused in local-only mode.
    await expect(resolveProvider(db, SECRET_KEY)).rejects.toMatchObject({ code: "external_blocked" });
    await admin.put("/admin/settings/ai", { defaultProviderId: localId });
    const local = await resolveProvider(db, SECRET_KEY, p1.id);
    expect(local).toMatchObject({ name: "Ollama (yerel)", external: false });
    expect((await local.chat([{ role: "user", content: "Selam" }])).text).toBe("Hazırım");
    expect(await resolveProvider(db, SECRET_KEY, p1.id).then((p) => p.kind)).toBe("openai_compatible");

    // A project cannot exceed the system mode.
    const pa = client({ cookie: await login("alice@7d.test") });
    expect((await pa.put(`/projects/${p1.id}/ai`, { enabled: true, providerId: null, allowExternal: true })).status).toBe(400);
    expect((await pa.put(`/projects/${p1.id}/ai`, { enabled: true, providerId: deepseekId, allowExternal: false })).status).toBe(400);
    expect((await bob.put(`/projects/${p1.id}/ai`, { enabled: false, providerId: null, allowExternal: false })).status).toBe(403);

    // allow_external: system-level use may reach DeepSeek, a project only after opting in.
    await admin.put("/admin/settings/ai", { mode: "allow_external", defaultProviderId: deepseekId });
    expect((await resolveProvider(db, SECRET_KEY)).external).toBe(true);
    await expect(resolveProvider(db, SECRET_KEY, p1.id)).rejects.toMatchObject({ code: "external_blocked" });
    const put = await pa.put(`/projects/${p1.id}/ai`, { enabled: true, providerId: deepseekId, allowExternal: true });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.effective).toMatchObject({ enabled: true, providerName: "DeepSeek" });
    expect((await resolveProvider(db, SECRET_KEY, p1.id)).name).toBe("DeepSeek");

    // Back to local-only: the project's consent is capped by the system mode.
    await admin.put("/admin/settings/ai", { mode: "local_only" });
    await expect(resolveProvider(db, SECRET_KEY, p1.id)).rejects.toMatchObject({ code: "external_blocked" });
    const view = await bob.get(`/projects/${p1.id}/ai`);
    expect(view.body).toMatchObject({ systemMode: "local_only", effective: { enabled: false } });

    // Project switch-off and system off.
    await pa.put(`/projects/${p1.id}/ai`, { enabled: false, providerId: null, allowExternal: false });
    await expect(resolveProvider(db, SECRET_KEY, p1.id)).rejects.toMatchObject({ code: "ai_project_off" });
    await admin.put("/admin/settings/ai", { mode: "off" });
    await expect(resolveProvider(db, SECRET_KEY)).rejects.toMatchObject({ code: "ai_off" });
    await admin.put("/admin/settings/ai", { mode: "local_only" });

    // Anthropic has no embeddings.
    await admin.put("/admin/settings/ai", { defaultProviderId: claudeId });
    await expect((await resolveProvider(db, SECRET_KEY)).embed(["x"])).rejects.toMatchObject({ code: "embeddings_unsupported" });

    // Deleting a provider clears references.
    expect((await admin.del(`/admin/ai/providers/${claudeId}`)).status).toBe(200);
    expect((await admin.get("/admin/settings")).body.ai.defaultProviderId).toBeNull();
  });

  it("allows only catalogued OpenRouter model overrides", async () => {
    const created = await admin.post("/admin/ai/providers", {
      name: "OpenRouter",
      kind: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4.1-mini",
      apiKey: "sk-or-test",
    });
    expect(created.status).toBe(200);
    await admin.put("/admin/settings/ai", { mode: "allow_external", defaultProviderId: created.body.id });

    const selected = await resolveProvider(handle.db, SECRET_KEY, null, "google/gemini-2.5-flash");
    expect(selected.model).toBe("google/gemini-2.5-flash");
    await expect(resolveProvider(handle.db, SECRET_KEY, null, "unknown/model")).rejects.toMatchObject({
      code: "model_not_allowed",
    });

    await admin.put(`/projects/${p1.id}/ai`, { enabled: true, providerId: created.body.id, allowExternal: true });
    const projectAi = await admin.get(`/projects/${p1.id}/ai`);
    expect(projectAi.body.effective).toMatchObject({
      enabled: true,
      model: "openai/gpt-4.1-mini",
      models: expect.arrayContaining([
        expect.objectContaining({ id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" }),
      ]),
    });
  });

  it("classifies hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.10", "[::1]", "ollama", "gpu.local", "llm.corp.internal", "ai.lan", "fd12::1"])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["api.deepseek.com", "api.anthropic.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1", "local.example.com"])
      expect(isPrivateHost(h), h).toBe(false);
    expect(stripThinking("<think>a\nb</think>\n\nCevap")).toBe("Cevap");
  });
});
