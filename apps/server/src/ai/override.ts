/**
 * Runs an in-app AI route with a different model behind it, for the duration of one in-process
 * call (AsyncLocalStorage): resolveProvider() and the report builder return this provider instead of
 * the configured one. Used by
 *   - the AI task queue ("Yapay Zekâya Gönder"): a connected AI client's answer is fed to the route as the
 *     model's answer, so the SAME validation, repair check and post-processing run;
 *   - the developer AI evaluation: capture the exact prompt (dry) or swap the model name.
 *
 * The route still runs as its caller (permissions unchanged); only the model is replaced.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { msg } from "../i18n/index.js";
import { AiError, type AiProvider, type ChatMessage, type ChatOptions, type ChatResult, type ToolSpec } from "./provider.js";

export interface AiOverride {
  provider: AiProvider;
}

const store = new AsyncLocalStorage<AiOverride>();

/** The provider of the current override, if any. */
export function overrideProvider(): AiProvider | undefined {
  return store.getStore()?.provider;
}

export function withProvider<T>(provider: AiProvider, fn: () => Promise<T>): Promise<T> {
  return store.run({ provider }, fn);
}

interface Base {
  id: string;
  name: string;
  model: string;
}

function base(b: Partial<Base>): Pick<AiProvider, "id" | "name" | "kind" | "model" | "external"> {
  return { id: b.id ?? "override", name: b.name ?? "Claude (MCP)", kind: "anthropic", model: b.model ?? "claude-mcp", external: true };
}

export const PROMPT_CAPTURED = "ai_prompt_captured";
export const CANDIDATE_INVALID = "ai_candidate_invalid";

/** Records the first model call (messages and offered tools) and stops the route there. */
export class CaptureProvider implements AiProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = "anthropic" as const;
  readonly model: string;
  readonly external = true;
  captured: { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number } | null = null;
  constructor(b: Partial<Base> = {}) {
    const x = base({ name: "Komut yakalama", ...b });
    this.id = x.id;
    this.name = x.name;
    this.model = x.model;
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (!this.captured)
      this.captured = { messages: messages.map((m) => ({ ...m })), ...(opts.tools?.length && { tools: opts.tools }), maxTokens: opts.maxTokens };
    throw new AiError(409, PROMPT_CAPTURED, msg("ai:errors.promptCaptured"));
  }
  async embed(): Promise<number[][]> {
    throw new AiError(400, "embeddings_unsupported", msg("ai:errors.noEmbeddingsHere"));
  }
}

/**
 * Answers the first model call with a given text (a connected Claude's result). A second call
 * means the route found the answer invalid and asked for a repair: the repair request (which lists
 * the app's own validation errors) is recorded and the route is stopped.
 */
export class AnswerProvider implements AiProvider {
  readonly id: string;
  readonly name: string;
  readonly kind = "anthropic" as const;
  readonly model: string;
  readonly external = true;
  calls = 0;
  firstMessages: ChatMessage[] | null = null;
  repairRequest: string | null = null;
  constructor(
    private readonly answer: string,
    b: Partial<Base> = {},
  ) {
    const x = base(b);
    this.id = x.id;
    this.name = x.name;
    this.model = x.model;
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    if (this.calls === 1) {
      this.firstMessages = messages.map((m) => ({ ...m }));
      opts.onText?.(this.answer);
      return { text: this.answer, toolCalls: [], model: this.model, stopReason: "end_turn" };
    }
    const last = [...messages].reverse().find((m) => m.role === "user");
    this.repairRequest = last && "content" in last ? String(last.content) : "";
    throw new AiError(422, CANDIDATE_INVALID, msg("ai:errors.candidateInvalid"));
  }
  async embed(): Promise<number[][]> {
    throw new AiError(400, "embeddings_unsupported", msg("ai:errors.noEmbeddingsHere"));
  }
}

/** Wraps a real provider: counts calls, time and tokens (developer AI evaluation). */
export class MeteredProvider implements AiProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: AiProvider["kind"];
  readonly model: string;
  readonly external: boolean;
  calls = 0;
  ms = 0;
  inputTokens = 0;
  outputTokens = 0;
  hasUsage = false;
  firstMessages: ChatMessage[] | null = null;
  lastText = "";
  constructor(
    private readonly inner: AiProvider,
    private readonly timeoutMs?: number,
  ) {
    this.id = inner.id;
    this.name = inner.name;
    this.kind = inner.kind;
    this.model = inner.model;
    this.external = inner.external;
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.calls++;
    if (!this.firstMessages) this.firstMessages = messages.map((m) => ({ ...m }));
    const t = Date.now();
    try {
      const r = await this.inner.chat(messages, { ...opts, ...(this.timeoutMs && { timeoutMs: this.timeoutMs }) });
      this.lastText = r.text;
      if (r.usage) {
        this.hasUsage = true;
        this.inputTokens += r.usage.inputTokens ?? 0;
        this.outputTokens += r.usage.outputTokens ?? 0;
      }
      return r;
    } finally {
      this.ms += Date.now() - t;
    }
  }
  embed(texts: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<number[][]> {
    return this.inner.embed(texts, opts);
  }
}
