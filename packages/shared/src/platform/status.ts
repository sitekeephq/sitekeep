/** GET /admin/status — Yönetim → Sistem Durumu (docs/onprem/izleme.md). */

export type StatusLevel = "ok" | "warn" | "danger";

export interface AdminStatusDto {
  level: StatusLevel;
  checkedAt: string;
  app: { ok: boolean; version: string | null; node: string; uptimeSeconds: number };
  database: { ok: boolean; kind: string };
  cpu: { usedRatio: number } | null;
  disk: { path: string; totalBytes: number; freeBytes: number; usedRatio: number } | null;
  memory: { totalBytes: number; freeBytes: number; processBytes: number };
  jobs: { queued: number; running: number; failed: number; done: number };
  backup: {
    scheduled: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
    nextAt: string | null;
  };
  privacy: { killSwitch: boolean };
}
