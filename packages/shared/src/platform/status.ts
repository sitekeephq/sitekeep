/** GET /admin/status — Yönetim → Sistem Durumu (docs/onprem/monitoring.md). */

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
  /** File storage (docs/onprem/object-storage.md): local disk or a bucket, its reachability and read cache. */
  storage: {
    driver: "local" | "s3" | "gcs";
    location: string;
    endpoint: string | null;
    ok: boolean;
    latencyMs: number;
    error: string | null;
    cache: { maxBytes: number; usedBytes: number; entries: number; hits: number; misses: number } | null;
  };
  backup: {
    scheduled: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
    nextAt: string | null;
  };
  privacy: { killSwitch: boolean };
}
