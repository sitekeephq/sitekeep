import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_PROVIDER_PRESETS, aiPresetTexts, findAiPreset, presetProblems } from "@sitekeep/shared";
import { AiError, type AiProvider } from "../../../src/ai/provider.js";
import { createProvider, retryDelayMs } from "@7dimensions-project/sitekeep-ee-ai/internal/provider.js";
import { listAnthropicModels } from "@7dimensions-project/sitekeep-ee-ai/internal/personal.js";
import { personalProviderError } from "@7dimensions-project/sitekeep-ee-ai/internal/personal.js";
import { render } from "../../../src/i18n/index.js";
import { Refs, runAsk, type AskTool } from "@7dimensions-project/sitekeep-ee-ai/internal/assistant.js";

/** One stub HTTP server; each test sets the handler (imitating a vendor's response shape). */
let server: Server;
let base: string;
let handler: (req: IncomingMessage & { body: any }, res: ServerResponse) => void = () => {};
const seen: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r = req as IncomingMessage & { body: any };
      r.body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url, headers: req.headers, body: r.body });
      handler(r, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const make = (presetId: string | null, extra: Partial<Parameters<typeof createProvider>[0]> = {}): AiProvider =>
  createProvider({ id: "p", name: "Test", kind: "openai_compatible", baseUrl: `${base}/v1`, model: "m", presetId, ...extra }, { allowExternal: false });

describe("AI provider adapter (multi-provider)", () => {
  it("turns personal provider authentication and SDK failures into actionable errors (Turkish and English)", () => {
    const claude = personalProviderError("anthropic", new AiError(502, "provider_error", '"Kişisel Claude API" HTTP 401: invalid x-api-key'));
    expect(claude).toMatchObject({ status: 422, code: "personal_ai_key_invalid" });
    expect(render("tr", claude.msg!)).toContain("Claude API anahtarı geçersiz");
    expect(claude.message).toContain("Claude API key is invalid");

    const cursor = personalProviderError("cursor", new Error("bridge process exited unexpectedly"));
    expect(cursor).toMatchObject({ status: 502, code: "personal_ai_test_failed" });
    expect(render("tr", cursor.msg!)).toContain("Cursor bağlantısı doğrulanamadı");
  });

  it("validates the presets: DeepSeek is there with a KVKK warning, cloud on https, local on private hosts", () => {
    expect(presetProblems()).toEqual([]);
    const ds = AI_PROVIDER_PRESETS.find((p) => p.id === "deepseek")!;
    expect(ds).toMatchObject({ kind: "openai_compatible", baseUrl: "https://api.deepseek.com", cost: "low" });
    expect(aiPresetTexts(ds).dataLocation).toContain("Çin");
    expect(aiPresetTexts(ds).kvkk).toContain("Ollama");
    expect(aiPresetTexts(ds, "en").dataLocation).toContain("China");
    for (const id of ["openai", "gemini", "anthropic", "mistral", "groq", "openrouter", "azure-openai", "ollama", "vllm", "lmstudio"])
      expect(AI_PROVIDER_PRESETS.some((p) => p.id === id), id).toBe(true);
    expect(findAiPreset("https://api.deepseek.com/v1", "openai_compatible")?.id).toBe("deepseek");
    expect(findAiPreset("https://acme.openai.azure.com/openai/v1", "openai_compatible")?.id).toBe("azure-openai");
    expect(findAiPreset("http://10.0.0.5:9999/v1", "openai_compatible")).toBeUndefined();
  });

  it("DeepSeek: JSON mode, thinking off, reasoning_content never reaches the answer", async () => {
    handler = (_req, res) =>
      json(res, {
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { role: "assistant", reasoning_content: "Önce düşüneyim… gizli", content: '<think>iç ses</think>{"ok": true}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 7 },
      });
    const p = make("deepseek", { disableThinking: true });
    expect(p.capabilities).toMatchObject({ tools: true, jsonMode: true });
    const r = await p.chat([{ role: "user", content: "JSON ver" }], { json: true, maxTokens: 100 });
    expect(r.text).toBe('{"ok": true}');
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 7 });
    const sent = seen.at(-1).body;
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.reasoning_effort).toBe("none");
    expect(sent.messages.at(-1).content).toBe("JSON ver"); // no " /no_think" for DeepSeek
  });

  it("streams DeepSeek reasoning deltas without showing them", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "deepseek-flash", choices: [{ delta: { reasoning_content: "düşünce" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Mer" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "haba" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    const texts: string[] = [];
    const r = await make("deepseek").chat([{ role: "user", content: "selam" }], { onText: (t) => texts.push(t) });
    expect(r.text).toBe("Merhaba");
    expect(texts.join("|")).not.toContain("düşünce");
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(seen.at(-1).body.stream_options).toEqual({ include_usage: true });
  });

  it("Gemini-style answers: content parts and empty tool-call ids are normalised; OpenAI uses max_completion_tokens", async () => {
    handler = (_req, res) =>
      json(res, {
        choices: [{ message: { content: [{ type: "text", text: "Tamam" }], tool_calls: [{ id: "", function: { name: "cde_today", arguments: "{}" } }] } }],
      });
    const r = await make(null).chat([{ role: "user", content: "x" }], { tools: [{ name: "cde_today", description: "d", parameters: { type: "object" } }] });
    expect(r.text).toBe("Tamam");
    expect(r.toolCalls[0]).toMatchObject({ id: "call_0", name: "cde_today" });
    expect(findAiPreset("https://generativelanguage.googleapis.com/v1beta/openai", "openai_compatible")?.capabilities.tools).toBe(false);
    handler = (_req, res) => json(res, { choices: [{ message: { content: "ok" } }] });
    await make("openai").chat([{ role: "user", content: "x" }], { maxTokens: 50 });
    expect(seen.at(-1).body).toMatchObject({ max_completion_tokens: 50 });
    expect(seen.at(-1).body.max_tokens).toBeUndefined();
  });

  it("falls back to prompt-only JSON when a server refuses response_format", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      if (req.body.response_format) return json(res, { error: { message: "response_format desteklenmiyor" } }, 400);
      json(res, { choices: [{ message: { content: '{"a":1}' } }] });
    };
    const r = await make("ollama", { baseUrl: `${base}/v1` }).chat([{ role: "user", content: "json" }], { json: true });
    expect(r.text).toBe('{"a":1}');
    expect(calls).toBe(2);
  });

  it("retries 429 with Retry-After and gives a clear error when it persists (Anthropic shape)", async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      if (n === 1) return json(res, { error: { message: "yavaş" } }, 429, { "retry-after": "0" });
      json(res, { model: "claude-haiku-5-5", stop_reason: "tool_use", content: [{ type: "text", text: "Bakıyorum" }, { type: "tool_use", id: "tu1", name: "cde_today", input: { a: 1 } }] });
    };
    const claude = createProvider({ id: "c", name: "Claude", kind: "anthropic", baseUrl: base, model: "claude-haiku-5-5", apiKey: "k" }, { allowExternal: false });
    const r = await claude.chat([{ role: "user", content: "x" }], { tools: [{ name: "cde_today", description: "d", parameters: { type: "object" } }] });
    expect(n).toBe(2);
    expect(r.toolCalls).toEqual([{ id: "tu1", name: "cde_today", arguments: { a: 1 } }]);
    handler = (_req, res) => json(res, { error: { message: "dur" } }, 429, { "retry-after-ms": "1" });
    await expect(make(null).chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(retryDelayMs(new Headers({ "retry-after": "3" }), 0)).toBe(3000);
    expect(retryDelayMs(new Headers(), 1)).toBe(2000);
    expect(new AiError(429, "x", "y").status).toBe(429);
  });

  it("Claude sends anthropic-workspace-id only when a Workspace is set", async () => {
    const seen: (string | string[] | undefined)[] = [];
    handler = (req, res) => {
      seen.push(req.headers["anthropic-workspace-id"]);
      json(res, { model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Hazırım" }] });
    };
    const cfg = { id: "c", name: "Claude", kind: "anthropic" as const, baseUrl: base, model: "claude-haiku-5-5", apiKey: "k" };
    await createProvider({ ...cfg, workspaceId: "wrkspc_011CZkZaBF1tNoB5wlCeusgy" }, { allowExternal: false }).chat([{ role: "user", content: "x" }]);
    await createProvider(cfg, { allowExternal: false }).chat([{ role: "user", content: "x" }]);
    expect(seen).toEqual(["wrkspc_011CZkZaBF1tNoB5wlCeusgy", undefined]);
  });

  it("lists a Claude key's active models over every page of GET /v1/models", async () => {
    const urls: URL[] = [];
    const headers: Headers[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      headers.push(new Headers(init?.headers));
      const page = url.searchParams.get("after_id")
        ? { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }], has_more: false, last_id: "claude-haiku-5-5" }
        : {
            data: [
              { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", lifecycle: "active" },
              { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", lifecycle: "deprecated" },
            ],
            has_more: true,
            last_id: "claude-sonnet-4-5",
          };
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const models = await listAnthropicModels("sk-ant-x", "wrkspc_011CZkZaBF1tNoB5wlCeusgy");
      expect(models).toEqual([
        { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      ]);
      expect(urls.map((u) => `${u.origin}${u.pathname}`)).toEqual(["https://api.anthropic.com/v1/models", "https://api.anthropic.com/v1/models"]);
      // Anthropic answers 400 to `lifecycle=`; deprecated models are dropped from the answer instead.
      expect([...urls[0]!.searchParams.keys()]).toEqual(["limit"]);
      expect(urls[1]!.searchParams.get("after_id")).toBe("claude-sonnet-4-5");
      expect(headers[0]!.get("x-api-key")).toBe("sk-ant-x");
      expect(headers[0]!.get("anthropic-workspace-id")).toBe("wrkspc_011CZkZaBF1tNoB5wlCeusgy");

      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "This credential requires the anthropic-workspace-id header." } }), { status: 400 }));
      await expect(listAnthropicModels("sk-ant-x", null)).rejects.toMatchObject({ code: "personal_ai_workspace" });
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }));
      await expect(listAnthropicModels("sk-ant-x", null)).rejects.toMatchObject({ code: "personal_ai_key_invalid" });
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the parameter name is `lifecycle[]`" } }), { status: 400 }));
      await expect(listAnthropicModels("sk-ant-x", null)).rejects.toMatchObject({ code: "personal_ai_rejected", message: expect.stringContaining("lifecycle[]") });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("Sor without tool calling: router-only mode fetches the routed data first and answers in one call", async () => {
    const calls: any[] = [];
    const provider: AiProvider = {
      id: "g",
      name: "Gemini (sahte)",
      kind: "openai_compatible",
      model: "gemini-3.5-flash-lite",
      external: true,
      capabilities: { tools: false, jsonMode: true, vision: false, contextTokens: null },
      async chat(messages, opts = {}) {
        calls.push({ messages, opts });
        return { text: "Termini geçen 2 iş var.", toolCalls: [], model: "gemini-3.5-flash-lite", stopReason: "stop" };
      },
      async embed() {
        return [];
      },
    };
    const ran: string[] = [];
    const tool = (name: string, required: string[] = []): AskTool => ({
      name,
      description: name,
      parameters: { type: "object", properties: {}, required },
      run: async () => (ran.push(name), { works: [{ number: "W-1", overdue: true }] }),
    });
    const out = await runAsk({
      provider,
      tools: [tool("cde_today"), tool("cde_works_list"), tool("cde_work_get", ["workId"])],
      refs: new Refs("p"),
      project: { code: "P", name: "Proje" },
      question: "Termini geçen işler?",
      today: "2026-10-11",
      offer: ["cde_today", "cde_works_list", "cde_work_get"],
    });
    expect(out.protocol).toBe("router");
    expect(out.answer).toContain("Termini geçen");
    expect(ran.sort()).toEqual(["cde_today", "cde_works_list"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.tools).toBeUndefined();
    expect(calls[0].messages.at(-1).content).toContain("W-1");
  });
});
