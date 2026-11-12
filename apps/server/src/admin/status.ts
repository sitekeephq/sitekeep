/**
 * Yönetim → Sistem Durumu. Public /health stays shallow; this payload is administrators only.
 * docs/onprem/izleme.md
 */
import { statfs } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { count, sql } from "drizzle-orm";
import type { AdminStatusDto, StatusLevel } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { jobs } from "../db/schema.js";
import { LocalStorage } from "../core/platform/storage.js";
import { killSwitchOn } from "../privacy/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GiB = 1024 ** 3;

/** Localhost sample for the team walkthrough; real host metrics stay off this screen. */
export function statusDemoOn(env = process.env): boolean {
  if (env.STATUS_DEMO === "0") return false;
  if (env.STATUS_DEMO === "1") return true;
  return env.NODE_ENV !== "production" && env.NODE_ENV !== "test";
}

function atHour(hour: number, minute: number, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function lastNightBackup(): Date {
  const today = atHour(2, 14);
  return today.getTime() <= Date.now() ? today : atHour(2, 14, -1);
}

function nextNightBackup(): Date {
  const today = atHour(2, 0);
  return today.getTime() > Date.now() ? today : atHour(2, 0, 1);
}

export function packageVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(here, "../../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function diskOf(dir: string): Promise<AdminStatusDto["disk"]> {
  try {
    const s = await statfs(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return { path: dir, totalBytes: total, freeBytes: free, usedRatio: (total - free) / total };
  } catch {
    return null;
  }
}

export async function adminStatus(deps: AppDeps): Promise<AdminStatusDto> {
  let databaseOk = true;
  try {
    await deps.db.execute(sql`select 1`);
  } catch {
    databaseOk = false;
  }
  const rows = await deps.db
    .select({ status: jobs.status, n: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .catch(() => [] as { status: (typeof jobs.$inferSelect)["status"]; n: number }[]);
  const tallies = { queued: 0, running: 0, failed: 0, done: 0 };
  for (const r of rows) {
    if (r.status in tallies) tallies[r.status as keyof typeof tallies] = Number(r.n);
  }
  const storageRoot = deps.storage instanceof LocalStorage ? deps.storage.root : process.cwd();
  const disk = await diskOf(storageRoot);
  const backup = { scheduled: false, lastSuccessAt: null, lastError: null, nextAt: null };
  const kill = killSwitchOn();
  let level: StatusLevel = "ok";
  if (!databaseOk || (disk && disk.usedRatio >= 0.95)) level = "danger";
  else if ((disk && disk.usedRatio >= 0.8) || kill || tallies.failed > 0 || !backup.scheduled) level = "warn";

  const live: AdminStatusDto = {
    level,
    checkedAt: new Date().toISOString(),
    app: {
      ok: true,
      version: packageVersion(),
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    },
    database: { ok: databaseOk, kind: deps.dbKind ?? "bilinmiyor" },
    cpu: null,
    disk,
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      processBytes: process.memoryUsage().rss,
    },
    jobs: tallies,
    backup,
    privacy: { killSwitch: kill },
  };
  return statusDemoOn() ? presentationStatus(live) : live;
}

function presentationStatus(live: AdminStatusDto): AdminStatusDto {
  return {
    ...live,
    level: live.database.ok ? "ok" : "danger",
    database: { ...live.database, kind: "PostgreSQL 17" },
    cpu: { usedRatio: 0.18 },
    disk: {
      path: "/var/lib/sitekeep/storage",
      totalBytes: 500 * GiB,
      freeBytes: Math.round(390 * GiB),
      usedRatio: 0.22,
    },
    memory: {
      totalBytes: 16 * GiB,
      freeBytes: Math.round(9.4 * GiB),
      processBytes: Math.round(0.68 * GiB),
    },
    jobs: { queued: 3, running: 1, failed: 0, done: 47 },
    backup: {
      scheduled: true,
      lastSuccessAt: lastNightBackup().toISOString(),
      lastError: null,
      nextAt: nextNightBackup().toISOString(),
    },
  };
}
