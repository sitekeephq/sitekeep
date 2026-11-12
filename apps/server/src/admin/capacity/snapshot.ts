/**
 * What the capacity card compares with the table: the machine (as the container sees it) and the
 * user counts. docs/onprem/capacity.md §0, §2.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import { and, count, countDistinct, eq, gt, sql } from "drizzle-orm";
import type { CapacityCounts, CapacityHardware } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { LocalStorage } from "../../core/platform/storage.js";
import { tokens, users } from "../../db/schema.js";
import { diskOf, statusDemoOn } from "../status.js";

const GiB = 1024 ** 3;
const ACTIVE_DAYS = 30;

/** cgroup v2 limits: inside Docker os.totalmem() / os.cpus() report the host, not the container. */
async function cgroupLimits(): Promise<{ cpus: number | null; memoryBytes: number | null }> {
  const read = (file: string) => readFile(file, "utf8").then((s) => s.trim()).catch(() => null);
  const [cpuMax, memMax] = await Promise.all([read("/sys/fs/cgroup/cpu.max"), read("/sys/fs/cgroup/memory.max")]);
  let cpus: number | null = null;
  const [quota, period] = cpuMax?.split(" ") ?? [];
  if (quota && quota !== "max" && Number(period) > 0) cpus = Math.max(1, Math.floor(Number(quota) / Number(period)));
  const memoryBytes = memMax && memMax !== "max" && Number(memMax) > 0 ? Number(memMax) : null;
  return { cpus, memoryBytes };
}

export async function readHardware(deps: AppDeps): Promise<CapacityHardware> {
  const limits = await cgroupLimits();
  const hostCpus = os.availableParallelism?.() ?? os.cpus().length;
  const storageRoot = deps.storage instanceof LocalStorage ? deps.storage.root : process.cwd();
  const disk = await diskOf(storageRoot);
  return {
    cpuCount: limits.cpus ? Math.min(limits.cpus, hostCpus) : hostCpus,
    cpuModel: os.cpus()[0]?.model.trim() ?? "bilinmiyor",
    memoryBytes: limits.memoryBytes ? Math.min(limits.memoryBytes, os.totalmem()) : os.totalmem(),
    disk: disk ? { path: disk.path, totalBytes: disk.totalBytes, freeBytes: disk.freeBytes } : null,
    os: `${os.type()} ${os.release()}`,
  };
}

export async function readCounts(deps: AppDeps): Promise<CapacityCounts> {
  const since = new Date(Date.now() - ACTIVE_DAYS * 86_400_000);
  const [registered] = await deps.db.select({ n: count() }).from(users).where(eq(users.disabled, false));
  const [active] = await deps.db
    .select({ n: countDistinct(tokens.userId) })
    .from(tokens)
    .where(and(eq(tokens.kind, "session"), gt(sql`coalesce(${tokens.lastUsedAt}, ${tokens.createdAt})`, since)));
  return { registered: Number(registered?.n ?? 0), active: Number(active?.n ?? 0) };
}

/** Same rule as Sistem Durumu: the localhost walkthrough shows a sample server, not the Mac. */
export function capacityDemoOn(): boolean {
  return statusDemoOn();
}

export function demoHardware(): CapacityHardware {
  return {
    cpuCount: 8,
    cpuModel: "Intel Xeon (örnek)", // i18n-ok: sample hardware (demo data)
    memoryBytes: 32 * GiB,
    disk: { path: "/var/lib/sitekeep/storage", totalBytes: 1000 * GiB, freeBytes: 640 * GiB },
    os: "Linux (örnek)", // i18n-ok: sample hardware (demo data)
  };
}

export const DEMO_COUNTS: CapacityCounts = { registered: 164, active: 97 };
