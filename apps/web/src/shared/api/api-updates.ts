// Yönetim → Sistem Durumu → new versions (server: src/updates/routes.ts).
import { request } from "./client";

export interface UpdatesDto {
  /** The daily check is on (off until an administrator turns it on). */
  enabled: boolean;
  /** The one-time "Check for new versions automatically?" card was answered. */
  promptDismissed: boolean;
  /** version null: a development build (no release number). */
  current: { version: string | null; development: boolean };
  latest: { version: string; url: string | null; publishedAt: string | null; source: "github" | "licence" } | null;
  updateAvailable: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  /** Why no check can be made right now (Privacy Centre), or null. */
  blockedReason: string | null;
}

export const updatesApi = {
  get: () => request<UpdatesDto>("GET", "/admin/updates"),
  setEnabled: (enabled: boolean) => request<UpdatesDto>("PUT", "/admin/updates", { enabled }),
  dismissPrompt: () => request<UpdatesDto>("PUT", "/admin/updates", { promptDismissed: true }),
  check: () => request<UpdatesDto>("POST", "/admin/updates/check"),
};
