import { isExternalUrl } from "../ai/hosts.js";
import { outboundFetch } from "../privacy/outbound.js";
import { Redactor } from "../privacy/redact.js";
import { privacyState } from "../privacy/settings.js";

/**
 * The language model behind the report builder. Deliberately tiny so that the central
 * AI provider settings (another feature branch) can implement it at merge time.
 */
export interface ReportLlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ReportLlm {
  complete(messages: ReportLlmMessage[]): Promise<string>;
  /** Endpoint, listed in Gizlilik Merkezi → Dış Bağlantılar (AI_BASE_URL). */
  readonly baseUrl?: string;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  /** Appended to the last user message (Qwen3: "/no_think" turns thinking off). */
  userSuffix?: string;
  /** OpenAI reasoning_effort; "none" turns Qwen3 thinking off on Ollama's OpenAI endpoint (which ignores /no_think). */
  reasoningEffort?: string;
  /** Upper bound of the answer's tokens. */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** Any OpenAI-compatible chat endpoint: Ollama, vLLM, LM Studio, llama.cpp server … */
export class OpenAiCompatibleReportLlm implements ReportLlm {
  constructor(private readonly o: OpenAiCompatibleOptions) {}

  get baseUrl(): string {
    return this.o.baseUrl;
  }

  async complete(messages: ReportLlmMessage[]): Promise<string> {
    // Personal data never leaves the network unmasked (privacy/redact.ts); the answer gets it back.
    const r = isExternalUrl(this.o.baseUrl) || privacyState().settings.redactLocal ? new Redactor() : null;
    const msgs = messages.map((m) => ({ ...m, content: r ? r.redact(m.content) : m.content }));
    const answer = await this.send(msgs, r);
    return r ? r.restore(answer) : answer;
  }

  private async send(msgs: ReportLlmMessage[], r: Redactor | null): Promise<string> {
    if (this.o.userSuffix) {
      const last = [...msgs].reverse().find((m) => m.role === "user");
      if (last && !last.content.trimEnd().endsWith(this.o.userSuffix.trim())) last.content += this.o.userSuffix;
    }
    const chars = msgs.reduce((n, m) => n + m.content.length, 0);
    const details = { provider: "AI_BASE_URL", model: this.o.model, chars, redacted: !!r, ...(r && { redactions: { ...r.counts } }) };
    const doFetch: typeof fetch =
      this.o.fetchImpl ?? ((url, init) => outboundFetch("yapay_zeka:rapor", String(url), init, { connection: "ai:env", details }));
    const res = await doFetch(`${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.o.model,
        messages: msgs,
        temperature: this.o.temperature ?? 0.2,
        ...(this.o.reasoningEffort ? { reasoning_effort: this.o.reasoningEffort } : {}),
        ...(this.o.maxTokens ? { max_tokens: this.o.maxTokens } : {}),
        // Streamed: headers arrive at once. A non-streamed answer from a slow local model
        // exceeds Node fetch's fixed 300 s headers timeout.
        stream: true,
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 600_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      // Servers that ignore `stream` answer with one JSON body.
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("LLM yanıtında içerik yok."); // i18n-ok: model call error detail, also fed back to the model
      return content;
    }
    return readSse(res);
  }
}

/** Concatenates `choices[0].delta.content` of an OpenAI-style server-sent event stream. */
async function readSse(res: Response): Promise<string> {
  if (!res.body) throw new Error("LLM yanıtında içerik yok."); // i18n-ok: model call error detail, also fed back to the model
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  const handle = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      if (chunk.error) throw new Error(`LLM: ${chunk.error.message ?? "hata"}`);
      out += chunk.choices?.[0]?.delta?.content ?? "";
    } catch (e) {
      if (e instanceof SyntaxError) return; // ignore keep-alives / partial garbage
      throw e;
    }
  };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer + decoder.decode());
  if (!out) throw new Error("LLM yanıtında içerik yok."); // i18n-ok: model call error detail, also fed back to the model
  return out;
}

export const DEFAULT_AI_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_AI_MODEL = "qwen3:8b";

/**
 * Reads AI_BASE_URL / AI_MODEL / AI_API_KEY (and AI_TIMEOUT_MS). The model is enabled when
 * AI_BASE_URL or AI_MODEL is set, or AI_ENABLED=1 (then defaults: local Ollama, qwen3:8b).
 * AI_ENABLED=0 turns it off.
 */
export function reportLlmFromEnv(env: NodeJS.ProcessEnv = process.env): ReportLlm | undefined {
  if (env.AI_ENABLED === "0") return undefined;
  if (!env.AI_BASE_URL && !env.AI_MODEL && env.AI_ENABLED !== "1") return undefined;
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  return new OpenAiCompatibleReportLlm({
    baseUrl: env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    model,
    apiKey: env.AI_API_KEY || undefined,
    timeoutMs: Number(env.AI_TIMEOUT_MS) || undefined,
    userSuffix: /qwen3/i.test(model) ? " /no_think" : undefined,
    reasoningEffort: /qwen3/i.test(model) ? "none" : undefined,
    maxTokens: 8000,
  });
}

/** Removes Qwen3-style reasoning blocks before the answer is parsed. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

/** The first JSON object in a model answer (handles ``` fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const clean = stripThinking(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean);
  const candidates = [clean, fenced?.[1] ?? ""];
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const c of candidates) {
    const t = c.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("Yanıtta geçerli bir JSON nesnesi bulunamadı."); // i18n-ok: model call error detail, also fed back to the model
}
