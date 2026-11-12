/**
 * The core's door to a language model (docs/modules/ai.md). The AI module supplies the real clients
 * (OpenAI-compatible, Anthropic, personal keys) through the `ai.provider` capability; without it
 * every call answers "yapay zekâ kapalı" (403 ai_off), so features that use a model hide or degrade.
 * The types and AiError live here so the core and modules share one class (instanceof checks).
 */
import type { Db } from "../db/index.js";
import { HttpError } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { capability } from "../sdk/capabilities.js";
import type { AiProviderCapabilities } from "@sitekeep/shared";
import type { ProviderKind } from "./settings.js";

export class AiError extends HttpError {}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  maxTokens?: number;
  /**
   * The answer must be one JSON object. Providers with a JSON mode get response_format
   * {type: "json_object"}; others rely on the prompt and the caller's JSON extraction.
   */
  json?: boolean;
  /** Sampling temperature; omitted unless given (reasoning models reject it). */
  temperature?: number;
  timeoutMs?: number;
  /** Aborts the request (e.g. the user cancelled the question). */
  signal?: AbortSignal;
  /**
   * Streams the answer: called with the text so far (thinking blocks removed) while the model writes.
   * OpenAI-compatible providers stream; others call it once with the full text.
   */
  onText?: (textSoFar: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  stopReason: string | null;
  /** Token counts when the provider reports them (non-streaming answers). */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind | "cursor";
  readonly model: string;
  readonly external: boolean;
  /** What the provider supports (from its preset; conservative defaults for custom endpoints). */
  readonly capabilities?: AiProviderCapabilities;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<number[][]>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel?: string | null;
  disableThinking?: boolean;
  apiKey?: string | null;
  /** Anthropic: Workspace for keys that can act on several (anthropic-workspace-id header). */
  workspaceId?: string | null;
  /** Preset the provider was made from (capabilities and request quirks); found by address when absent. */
  presetId?: string | null;
}

/** "project": the project's provider; otherwise the user's own key. */
export type AiProviderSelection = "project" | "anthropic" | "cursor";

/** Removes Qwen3-style reasoning blocks (<think>…</think>) from model output. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^\s*<think>[\s\S]*$/, "").trim();
}

/** stripThinking for a partial answer: an unfinished <think> block hides everything. */
export function stripThinkingPartial(text: string): string {
  if (/^\s*<think>/.test(text) && !text.includes("</think>")) return "";
  return stripThinking(text);
}

const aiOff = () => new AiError(403, "ai_off", msg("ai:errors.aiOff"));

const ai = () => capability("ai.provider");

/** True when the AI module is installed (a model can be configured at all). */
export function aiInstalled(): boolean {
  return !!ai();
}

/**
 * The provider to use for a project (or for system-level work when projectId is null), after the
 * system mode, the project policy and the local-only host check.
 */
export async function resolveProvider(db: Db, secretKey: Buffer, projectId: string | null = null, modelOverride?: string): Promise<AiProvider> {
  const p = ai();
  if (!p) throw aiOff();
  return p.resolve(db, secretKey, projectId, modelOverride);
}

/** resolveProvider without creating the client: the configuration and the external-host guard. */
export async function resolveProviderSetup(
  db: Db,
  secretKey: Buffer,
  projectId: string | null = null,
  modelOverride?: string,
): Promise<{ cfg: ProviderConfig; allowExternal: boolean }> {
  const p = ai();
  if (!p) throw aiOff();
  return p.resolveSetup(db, secretKey, projectId, modelOverride);
}

/** The user's own key ("Kişisel Claude API", Cursor) for one question; null for the project's provider. */
export async function resolveSelectedProvider(
  db: Db,
  secretKey: Buffer,
  projectId: string,
  userId: string,
  selection: AiProviderSelection,
  modelOverride?: string,
): Promise<AiProvider | null> {
  if (selection === "project") return null;
  const p = ai();
  if (!p) throw aiOff();
  return p.resolveSelected(db, secretKey, projectId, userId, selection, modelOverride);
}
