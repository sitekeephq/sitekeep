/**
 * AI task queue ("Yapay Zekâya Gönder"): in-app AI requests handed to a connected AI client
 * (Claude, ChatGPT, Gemini CLI, Cursor… over MCP). Pure helpers + API calls; the button lives in
 * components/AiTaskButton.tsx.
 */
import { request } from "../../shared/api/api";
import { i18n } from "../../i18n";

export type AiTaskKind =
  | "report_generate"
  | "report_repair"
  | "form_flow"
  | "form_fields_naming"
  | "form_template_from_text"
  | "letter_translate"
  | "doc_compare_summary"
  | "model_ask"
  | "ask"
  | "minutes_actions"
  | "rfi_draft"
  | "today_summary"
  | "record_from_file"
  | "param_change";

export type AiTaskStatus = "pending" | "claimed" | "done" | "failed" | "cancelled";

export interface AiTaskDto {
  id: string;
  projectId: string;
  kind: AiTaskKind;
  label: string;
  status: AiTaskStatus;
  statusLabel: string;
  summary: string;
  clientName?: string | null;
  claimedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  error: string | null;
  result?: unknown;
  link?: string | null;
}

export interface AiQueueStatus {
  enabled: boolean;
  allowed: boolean;
  reason: string | null;
  providerAvailable: boolean;
}

export type AiTaskButtonMode = "primary" | "secondary" | "hidden";

/**
 * Where the "Yapay Zekâya Gönder" button shows: hidden unless the administrator turned the queue
 * on and the project may send content to a connected AI client; the main action when no model is
 * configured, otherwise a secondary option next to the in-app AI button.
 */
export function aiTaskButtonMode(status: AiQueueStatus | null | undefined): AiTaskButtonMode {
  if (!status || !status.enabled || !status.allowed) return "hidden";
  return status.providerAvailable ? "secondary" : "primary";
}

export function isOpenTask(s: AiTaskStatus): boolean {
  return s === "pending" || s === "claimed";
}

/** The waiting line under the button. */
export function waitingText(t: Pick<AiTaskDto, "status" | "clientName">): string {
  if (t.status === "claimed") return i18n.t("ai:tasks.messages.working", { client: t.clientName ?? i18n.t("ai:tasks.defaultClient") });
  return i18n.t("ai:tasks.messages.waiting");
}

/** Polling interval while a task is open (ms). */
export const AI_TASK_POLL_MS = 5_000;

const statusCache = new Map<string, { at: number; value: Promise<AiQueueStatus | null> }>();

export const aiTaskApi = {
  /** Cached for a minute per project (the button appears in many places). */
  status(pid: string, fresh = false): Promise<AiQueueStatus | null> {
    const hit = statusCache.get(pid);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = request<AiQueueStatus>("GET", `/projects/${pid}/ai-tasks/status`).catch(() => null);
    statusCache.set(pid, { at: Date.now(), value });
    return value;
  },
  create: (pid: string, kind: AiTaskKind, input: Record<string, unknown>) => request<AiTaskDto>("POST", `/projects/${pid}/ai-tasks`, { kind, input }),
  get: (pid: string, id: string) => request<AiTaskDto>("GET", `/projects/${pid}/ai-tasks/${id}`),
  cancel: (pid: string, id: string) => request<AiTaskDto>("POST", `/projects/${pid}/ai-tasks/${id}/cancel`),
  mine: (pid: string) => request<AiTaskDto[]>("GET", `/projects/${pid}/ai-tasks`),
};
