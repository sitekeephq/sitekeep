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
  /** `lastFailedAt`: when the most recent failed job finished (null without any), so new failures stand out. */
  jobs: { queued: number; running: number; failed: number; done: number; lastFailedAt: string | null };
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

/** One group of failed background jobs: same kind and same error text (GET /admin/failed-jobs/groups). */
export interface FailedJobGroupDto {
  kind: string;
  error: string;
  count: number;
  lastFinishedAt: string | null;
  /** The kind can be run again (not every kind is safe to repeat). */
  retryable: boolean;
}

/** One failed job (GET /admin/failed-jobs). */
export interface FailedJobDto {
  id: string;
  kind: string;
  error: string;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
  project: { id: string; code: string; name: string } | null;
  file: { id: string; name: string; versionId: string; version: number } | null;
  retryable: boolean;
}

export interface FailedJobPageDto {
  total: number;
  page: number;
  pageSize: number;
  items: FailedJobDto[];
}

/** Which failed jobs an action covers: listed ids, or a whole group (kind + error). */
export type FailedJobSelector = { ids: string[] } | { kind: string; error: string };

export interface FailedJobRetryResultDto {
  queued: number;
  /** Not queued: kind not repeatable, file or version gone, or already converted/running. */
  skipped: number;
}
