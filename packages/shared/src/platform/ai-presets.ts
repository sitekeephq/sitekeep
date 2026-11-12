/**
 * AI provider presets (Yönetim → Yapay Zekâ) and their capabilities. They build on the two provider
 * kinds the server speaks: OpenAI-compatible chat completions and the Anthropic Messages API.
 * Model ids are defaults only and stay editable; prices are never stored (only a relative hint).
 * Sources: docs/features/AI_PROVIDERS.md.
 */

import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";

export type AiProviderKindPreset = "openai_compatible" | "anthropic";

export interface AiProviderCapabilities {
  /** Native tool / function calling (the "Sor" assistant falls back to router-only mode without it). */
  tools: boolean;
  /** response_format {type: "json_object"} (otherwise JSON comes from the prompt and is extracted). */
  jsonMode: boolean;
  vision: boolean;
  /** Context window in tokens, when the vendor documents one for the default model. */
  contextTokens: number | null;
}

export interface AiProviderAdapter {
  /** OpenAI reasoning-era models take max_completion_tokens instead of max_tokens. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Azure OpenAI sends the key as "api-key". */
  authHeader?: "bearer" | "api-key";
  extraHeaders?: Record<string, string>;
  /** stream_options.include_usage on streamed answers (token counts). */
  streamUsage?: boolean;
  /** How "Düşünme Modunu Kapat" is sent. Default: reasoning_effort "none" + " /no_think". */
  thinkingOff?: { reasoningEffort?: string; noThinkSuffix?: boolean; extraBody?: Record<string, unknown> };
}

export interface AiProviderPreset {
  id: string;
  label: string;
  group: "local" | "cloud";
  kind: AiProviderKindPreset;
  baseUrl: string;
  /** First = default (cheap / fast), then stronger ones. */
  models: string[];
  embeddingModel?: string | null;
  disableThinking?: boolean;
  capabilities: AiProviderCapabilities;
  adapter?: AiProviderAdapter;
  /** Relative price hint. Texts (data location, KVKK note, note): aiPresetTexts(). */
  cost: "low" | "medium" | "high";
  docs: string[];
}

/**
 * The preset's texts in `lang`: where the vendor processes the data, the KVKK note on cross-border
 * transfer (cloud presets) and a setup note (messages aiPresets.<id>.*).
 */
export function aiPresetTexts(
  preset: Pick<AiProviderPreset, "id">,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): { dataLocation: string; kvkk?: string; note?: string } {
  const text = (part: string) => {
    const key = `aiPresets.${preset.id}.${part}`;
    const value = sharedText(lang, key);
    return value === key ? undefined : value;
  };
  return { dataLocation: text("dataLocation") ?? "", kvkk: text("kvkk"), note: text("note") };
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  // ---- Local ------------------------------------------------------------------------------
  {
    id: "ollama",
    label: "Ollama",
    group: "local",
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b", "qwen3:14b", "deepseek-r1:8b", "qwen3:32b"],
    embeddingModel: "bge-m3",
    disableThinking: true,
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: null },
    cost: "low",
    docs: ["https://github.com/ollama/ollama/blob/main/docs/openai.md"],
  },
  {
    id: "vllm",
    label: "vLLM",
    group: "local",
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: ["Qwen/Qwen3-8B", "Qwen/Qwen3-32B"],
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: null },
    cost: "low",
    docs: ["https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    group: "local",
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    capabilities: { tools: true, jsonMode: false, vision: false, contextTokens: null },
    cost: "low",
    docs: ["https://lmstudio.ai/docs/app/api/endpoints/openai"],
  },
  // ---- Cloud ------------------------------------------------------------------------------
  {
    id: "deepseek",
    label: "DeepSeek",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    // Thinking is on by default; with tools the API wants earlier reasoning_content back, so the
    // preset turns thinking off ("Düşünme Modunu Kapat").
    disableThinking: true,
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: 1_000_000 },
    adapter: { streamUsage: true, thinkingOff: { reasoningEffort: "none" } },
    cost: "low",
    docs: ["https://api-docs.deepseek.com/", "https://api-docs.deepseek.com/updates/", "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"],
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.4-mini", "gpt-5.5", "gpt-6-luna"],
    disableThinking: true,
    capabilities: { tools: true, jsonMode: true, vision: true, contextTokens: 400_000 },
    adapter: { maxTokensParam: "max_completion_tokens", streamUsage: true, thinkingOff: { reasoningEffort: "none" } },
    cost: "medium",
    docs: ["https://platform.openai.com/docs/api-reference/chat"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.5-flash-lite", "gemini-3.8-flash"],
    // Gemini 3 tool calls carry a thought_signature that must be echoed back: the "Sor" assistant
    // uses router-only mode with this preset (no tool calls), other features need no tools.
    capabilities: { tools: false, jsonMode: true, vision: true, contextTokens: 1_000_000 },
    adapter: { thinkingOff: {} },
    cost: "low",
    docs: ["https://ai.google.dev/gemini-api/docs/openai"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    group: "cloud",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    capabilities: { tools: true, jsonMode: false, vision: true, contextTokens: 1_000_000 },
    cost: "high",
    docs: ["https://docs.anthropic.com/en/api/messages"],
  },
  {
    id: "mistral",
    label: "Mistral",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://api.eu.mistral.ai/v1",
    models: ["mistral-small-latest", "mistral-medium-latest"],
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: 256_000 },
    adapter: { thinkingOff: {} },
    cost: "medium",
    docs: ["https://docs.mistral.ai/api/"],
  },
  {
    id: "groq",
    label: "Groq",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
    disableThinking: true,
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: 131_000 },
    adapter: { thinkingOff: { extraBody: { include_reasoning: false } } },
    cost: "low",
    docs: ["https://console.groq.com/docs/openai"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["deepseek/deepseek-chat", "openai/gpt-5-mini", "anthropic/claude-sonnet-5.5"],
    capabilities: { tools: true, jsonMode: true, vision: false, contextTokens: null },
    adapter: { extraHeaders: { "X-OpenRouter-Title": "SiteKeep" }, streamUsage: true, thinkingOff: {} },
    cost: "medium",
    docs: ["https://openrouter.ai/docs/api-reference/overview"],
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    group: "cloud",
    kind: "openai_compatible",
    baseUrl: "https://KAYNAK-ADI.openai.azure.com/openai/v1",
    models: ["DAGITIM-ADI"],
    capabilities: { tools: true, jsonMode: true, vision: true, contextTokens: null },
    adapter: { authHeader: "api-key", maxTokensParam: "max_completion_tokens", thinkingOff: {} },
    cost: "medium",
    docs: ["https://learn.microsoft.com/azure/ai-foundry/openai/reference"],
  },
];

/** Capabilities of a custom endpoint without a preset (tools are tried; no JSON mode). */
export function defaultCapabilities(kind: AiProviderKindPreset): AiProviderCapabilities {
  return { tools: true, jsonMode: false, vision: false, contextTokens: kind === "anthropic" ? 200_000 : null };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The preset of a stored provider: by id, else by kind + host (with port). */
export function findAiPreset(baseUrl: string, kind: AiProviderKindPreset, presetId?: string | null): AiProviderPreset | undefined {
  if (presetId) {
    const byId = AI_PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (byId) return byId;
  }
  const host = hostOf(baseUrl);
  if (!host) return undefined;
  return AI_PROVIDER_PRESETS.find((p) => p.kind === kind && (hostOf(p.baseUrl) === host || (p.id === "azure-openai" && host.endsWith(".openai.azure.com"))));
}

/**
 * Problems of a preset list (tests): ids unique, cloud on https with a KVKK note, local on private
 * hosts, a data location text. Developer checks: the problems are not translated.
 */
export function presetProblems(list: AiProviderPreset[] = AI_PROVIDER_PRESETS): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const p of list) {
    const texts = aiPresetTexts(p, "en");
    if (ids.has(p.id)) out.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!/^https?:\/\//.test(p.baseUrl)) out.push(`${p.id}: address is not http(s)`);
    if (p.group === "cloud" && (!p.baseUrl.startsWith("https://") || !texts.kvkk)) out.push(`${p.id}: a cloud provider needs https and a KVKK note`);
    if (p.group === "local" && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl)) out.push(`${p.id}: a local provider needs a local address`);
    if (!texts.dataLocation || !p.docs.length) out.push(`${p.id}: data location and sources required`);
  }
  return out;
}
