import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { projectAiSettings, systemSettings } from "../db/schema.js";
import { isExternalUrl } from "./hosts.js";
import { killSwitchOn } from "../privacy/settings.js";
import { msg, type Msg } from "../i18n/index.js";
import { defaultCapabilities, findAiPreset, type AiProviderCapabilities } from "@sitekeep/shared";

export type TokenCreators = "everyone" | "project_admins" | "admins";

export interface McpSettings {
  /** Hosted MCP endpoint (/mcp) on or off. */
  enabled: boolean;
  /** Users may create read+write API tokens; when false the hosted MCP serves read tools only. */
  allowWriteTokens: boolean;
  /** Who may create API tokens. */
  tokenCreators: TokenCreators;
  /** Longest token lifetime in days; null = no limit ("never expires" allowed). */
  maxTokenDays: number | null;
}

export const MCP_DEFAULTS: McpSettings = {
  enabled: true,
  allowWriteTokens: false,
  tokenCreators: "project_admins",
  maxTokenDays: null,
};

/**
 * off            no AI calls at all
 * local_only     only providers whose host is inside the network (fully local / air-gapped)
 * allow_external cloud providers (Claude, DeepSeek) allowed for projects that opt in
 */
export type AiMode = "off" | "local_only" | "allow_external";
export const AI_MODES: AiMode[] = ["off", "local_only", "allow_external"];

export type ProviderKind = "openai_compatible" | "anthropic";

export interface StoredProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel?: string | null;
  /** openai_compatible only: turn off Qwen3-style thinking (reasoning_effort "none", " /no_think", strip <think>…</think>). */
  disableThinking?: boolean;
  /** AES-256-GCM, see secrets.ts. */
  apiKeyEnc?: string | null;
  /** Preset it was made from (packages/shared ai-presets.ts): capabilities and request quirks. */
  presetId?: string | null;
}

export interface ProviderDto {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel: string | null;
  disableThinking: boolean;
  hasApiKey: boolean;
  /** Host is outside the customer's network. */
  external: boolean;
  presetId: string | null;
  capabilities: AiProviderCapabilities;
}

export interface ProjectAiPolicy {
  enabled: boolean;
  providerId: string | null;
  allowExternal: boolean;
}

export const PROJECT_AI_DEFAULTS: ProjectAiPolicy = { enabled: true, providerId: null, allowExternal: false };

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return row ? (row.value as T) : fallback;
}

/** Stores a setting; null removes it (the reader falls back to its default). */
export async function putSetting(db: Db, key: string, value: unknown, userId: string | null): Promise<void> {
  if (value === null || value === undefined) {
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  const now = new Date();
  await db
    .insert(systemSettings)
    .values({ key, value, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy: userId, updatedAt: now } });
}

export async function getMcpSettings(db: Db): Promise<McpSettings> {
  return { ...MCP_DEFAULTS, ...(await getSetting<Partial<McpSettings>>(db, "integrations.mcp", {})) };
}

/** The mode the administrator chose (Yönetim → Yapay Zekâ ve MCP). */
export async function getStoredAiMode(db: Db): Promise<AiMode> {
  const mode = await getSetting<AiMode>(db, "ai.mode", "local_only");
  return AI_MODES.includes(mode) ? mode : "local_only";
}

/**
 * The mode in force: the stored one, except that "Tüm Dış Bağlantıları Kapat" (Gizlilik Merkezi)
 * turns allow_external into local_only.
 */
export async function getAiMode(db: Db): Promise<AiMode> {
  const mode = await getStoredAiMode(db);
  return mode === "allow_external" && killSwitchOn() ? "local_only" : mode;
}

export async function getProviders(db: Db): Promise<StoredProvider[]> {
  return getSetting<StoredProvider[]>(db, "ai.providers", []);
}

export async function getDefaultProviderId(db: Db): Promise<string | null> {
  return getSetting<string | null>(db, "ai.defaultProviderId", null);
}

export function toProviderDto(p: StoredProvider): ProviderDto {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    embeddingModel: p.embeddingModel ?? null,
    disableThinking: !!p.disableThinking,
    hasApiKey: !!p.apiKeyEnc,
    external: isExternalUrl(p.baseUrl),
    presetId: findAiPreset(p.baseUrl, p.kind, p.presetId)?.id ?? null,
    capabilities: findAiPreset(p.baseUrl, p.kind, p.presetId)?.capabilities ?? defaultCapabilities(p.kind),
  };
}

export async function getProjectAiPolicy(db: Db, projectId: string): Promise<ProjectAiPolicy> {
  const [row] = await db.select().from(projectAiSettings).where(eq(projectAiSettings.projectId, projectId));
  return row ? { enabled: row.enabled, providerId: row.providerId, allowExternal: row.allowExternal } : { ...PROJECT_AI_DEFAULTS };
}

/** External providers are usable only when the system allows them and (for a project) the project opted in. */
export function externalAllowed(mode: AiMode, policy: ProjectAiPolicy | null): boolean {
  return mode === "allow_external" && (policy ? policy.allowExternal : true);
}

/**
 * AI task queue ("Yapay Zekâya Gönder"): in-app AI requests wait for a connected AI client (Claude
 * Desktop / Code, ChatGPT, Gemini CLI… over MCP) instead of the configured provider. Such a client is external AI.
 */
export interface AiTaskQueueSettings {
  /** The queue and its "Yapay Zekâya Gönder" buttons are on. */
  enabled: boolean;
  /**
   * Lets connected external AI clients receive project content for queued tasks even when the
   * system mode is local_only (or the project did not opt in to external AI). Never when AI is off.
   */
  allowExternalClients: boolean;
  /** Tasks expire after this many hours. */
  ttlHours: number;
}

export const AI_TASK_QUEUE_DEFAULTS: AiTaskQueueSettings = { enabled: false, allowExternalClients: false, ttlHours: 24 };

/** The queue settings the administrator chose. */
export async function getStoredAiTaskQueueSettings(db: Db): Promise<AiTaskQueueSettings> {
  return { ...AI_TASK_QUEUE_DEFAULTS, ...(await getSetting<Partial<AiTaskQueueSettings>>(db, "ai.taskQueue", {})) };
}

/** The queue settings in force: "Tüm Dış Bağlantıları Kapat" turns the queue for external clients off. */
export async function getAiTaskQueueSettings(db: Db): Promise<AiTaskQueueSettings> {
  const q = await getStoredAiTaskQueueSettings(db);
  return killSwitchOn() ? { ...q, enabled: false, allowExternalClients: false } : q;
}

export type ExternalClientDecision = { ok: true } | { ok: false; code: string; message: Msg };

/**
 * May an external AI client (Claude over MCP) receive this project's AI content (prompts, data)?
 * Same policy as external providers: AI not off, project AI on, and either external AI allowed for
 * the project (allow_external + project consent) or the explicit queue switch allowExternalClients.
 */
export async function externalClientAllowed(db: Db, projectId: string | null): Promise<ExternalClientDecision> {
  const mode = await getAiMode(db);
  if (mode === "off") return { ok: false, code: "ai_off", message: msg("ai:errors.aiOff") };
  const policy = projectId ? await getProjectAiPolicy(db, projectId) : null;
  if (policy && !policy.enabled) return { ok: false, code: "ai_project_off", message: msg("ai:errors.aiProjectOff") };
  if (externalAllowed(mode, policy)) return { ok: true };
  const q = await getAiTaskQueueSettings(db);
  if (q.allowExternalClients) return { ok: true };
  return {
    ok: false,
    code: "external_blocked",
    message:
      mode === "local_only"
        ? msg("ai:errors.clientLocalOnly")
        : msg("ai:errors.clientProjectNoExternal"),
  };
}
