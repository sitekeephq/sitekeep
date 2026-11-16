/**
 * Limits of the close-out archive (docs/features/CLOSEOUT_ARCHIVE.md#limits). AppDeps.closeout
 * wins (tests); otherwise the environment:
 *   CDE_CLOSEOUT_MAX_GB           largest archive (sum of the files put in it); unset or 0 = no limit
 *   CDE_CLOSEOUT_RETENTION_DAYS   days a finished archive can be downloaded before it is deleted (default 14, 1–365)
 *   CDE_CLOSEOUT_MIN_FREE_GB      free disk space to leave beside the archive (default 2)
 */
const GiB = 1024 ** 3;

export interface CloseoutLimits {
  /** null = no limit. */
  maxBytes: number | null;
  retentionDays: number;
  minFreeBytes: number;
}

export const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MIN_FREE_BYTES = 2 * GiB;

export function closeoutLimits(given?: Partial<CloseoutLimits>, env: NodeJS.ProcessEnv = process.env): CloseoutLimits {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const maxGb = num(env.CDE_CLOSEOUT_MAX_GB);
  const days = num(env.CDE_CLOSEOUT_RETENTION_DAYS);
  const freeGb = num(env.CDE_CLOSEOUT_MIN_FREE_GB);
  return {
    maxBytes: given?.maxBytes !== undefined ? given.maxBytes : maxGb && maxGb > 0 ? Math.round(maxGb * GiB) : null,
    retentionDays: given?.retentionDays ?? (days && days >= 1 && days <= 365 ? Math.round(days) : DEFAULT_RETENTION_DAYS),
    minFreeBytes: given?.minFreeBytes ?? (freeGb !== undefined && freeGb >= 0 ? Math.round(freeGb * GiB) : DEFAULT_MIN_FREE_BYTES),
  };
}
