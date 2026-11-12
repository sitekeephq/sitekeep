/**
 * Kapasite (Yönetim → Sistem Durumu → Kapasite, docs/onprem/kapasite.md): the sizing table, the
 * rules that compare a server with it, and the capacity-test DTOs. The screen, the warnings, the
 * report and the docs table all read CAPACITY_TIERS; change a number here only.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";
import type { StatusLevel } from "./status.js";

export type CapacityTierId = "trial" | "small" | "medium" | "large" | "enterprise";

export interface CapacityTier {
  id: CapacityTierId;
  /** Registered users the tier is sized for; null = no upper limit (project-specific). */
  maxUsers: number | null;
  /** Users working in the same minute at peak (maxUsers × CAPACITY_CONCURRENCY). */
  concurrent: number;
  vcpu: number | null;
  ramGb: number | null;
  /** Data disk (SSD), GB: [minimum, typical]. Grows with model volume, not with users. */
  diskGb: [number, number] | null;
}

/** Share of registered users working at the same time at peak (assumption, docs §2). */
export const CAPACITY_CONCURRENCY = 0.15;

/**
 * Date the tier numbers were measured on the reference machines (docs §7); null while they are
 * estimates, and the screen says "tahmini".
 */
export const CAPACITY_MEASURED_AT: string | null = null;

export const CAPACITY_TIERS: CapacityTier[] = [
  { id: "trial", maxUsers: 10, concurrent: 2, vcpu: 2, ramGb: 8, diskGb: [100, 100] },
  { id: "small", maxUsers: 50, concurrent: 8, vcpu: 4, ramGb: 16, diskGb: [500, 500] },
  { id: "medium", maxUsers: 200, concurrent: 30, vcpu: 8, ramGb: 32, diskGb: [1000, 2000] },
  { id: "large", maxUsers: 500, concurrent: 75, vcpu: 16, ramGb: 64, diskGb: [2000, 4000] },
  { id: "enterprise", maxUsers: null, concurrent: 75, vcpu: null, ramGb: null, diskGb: null },
];

/** Name of a tier ("Medium"). */
export function capacityTierLabel(id: CapacityTierId, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `capacity.tiers.${id}`);
}

/** Where the database runs in a tier ("Same machine, separate disk recommended"). */
export function capacityTierDatabase(id: CapacityTierId, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `capacity.tierDatabase.${id}`);
}

const COMMON_REQUIREMENTS = ["os64", "network", "ssd", "backup", "fixedCores"] as const;

/** Requirements every tier shares (Kapasite Rehberi). */
export function capacityCommonRequirements(lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  return COMMON_REQUIREMENTS.map((k) => sharedText(lang, `capacity.requirements.${k}`));
}

/** Limits of the load test (docs §4.2): a step that crosses one of them ends the test. */
export const CAPACITY_LIMITS = { p95Ms: 500, p99Ms: 1500, errorRate: 0.001, cpu: 0.9, freeMemory: 0.1 };

/** A test older than this turns the card yellow (docs §5). */
export const CAPACITY_TEST_MAX_AGE_DAYS = 90;

/** The operating system reports a little less RAM than installed: 16 GB shows ~15.6 GB. */
const RAM_TOLERANCE = 0.9;
const GiB = 1024 ** 3;

export interface CapacityHardware {
  cpuCount: number;
  cpuModel: string;
  memoryBytes: number;
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  os: string;
}

export interface CapacityCounts {
  /** Accounts that are not disabled. */
  registered: number;
  /** Signed in during the last 30 days. */
  active: number;
}

export type CapacityFindingKey = "users" | "memory" | "cpu" | "disk" | "test" | "measured";

export interface CapacityFinding {
  key: CapacityFindingKey;
  level: StatusLevel;
  title: string;
  /** What to do, written for the customer's IT ("RAM'i en az 32 GB yapın"). */
  action: string;
}

/** Smallest tier sized for this many registered users. */
export function tierForUsers(users: number): CapacityTier {
  return CAPACITY_TIERS.find((t) => t.maxUsers === null || users <= t.maxUsers)!;
}

/** Largest bounded tier this hardware meets; null when it does not meet even the smallest one. */
export function hardwareTier(hw: Pick<CapacityHardware, "cpuCount" | "memoryBytes">): CapacityTier | null {
  let best: CapacityTier | null = null;
  for (const t of CAPACITY_TIERS) {
    if (t.vcpu === null || t.ramGb === null) continue;
    if (hw.cpuCount >= t.vcpu && hw.memoryBytes >= t.ramGb * GiB * RAM_TOLERANCE) best = t;
  }
  return best;
}

/** Registered users this hardware is sized for (0 below the smallest tier). */
export function hardwareMaxUsers(hw: Pick<CapacityHardware, "cpuCount" | "memoryBytes">): number {
  return hardwareTier(hw)?.maxUsers ?? 0;
}

/**
 * Users check alone: also used before an administrator adds accounts (Yeni Kullanıcı), with the
 * count after the addition.
 */
export function usersFinding(
  hw: Pick<CapacityHardware, "cpuCount" | "memoryBytes">,
  registered: number,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): CapacityFinding {
  const tier = hardwareTier(hw);
  if (!tier) {
    return {
      key: "users",
      level: "danger",
      title: sharedText(lang, "capacity.findings.usersBelowSmallest", { count: registered }),
      action: upgradeText(tierForUsers(registered), lang),
    };
  }
  const max = tier.maxUsers!;
  const title = sharedText(lang, "capacity.findings.users", { count: registered, max });
  if (registered > max) {
    return { key: "users", level: "danger", title, action: sharedText(lang, "capacity.findings.overLimit", { upgrade: upgradeText(tierForUsers(registered), lang) }) };
  }
  if (registered >= max * 0.9) {
    return { key: "users", level: "warn", title, action: sharedText(lang, "capacity.findings.nearLimit", { upgrade: upgradeText(tierAbove(tier), lang) }) };
  }
  return { key: "users", level: "ok", title, action: ok(lang) };
}

const ok = (lang: string) => sharedText(lang, "capacity.findings.ok");

function upgradeText(t: CapacityTier, lang: string): string {
  return t.vcpu && t.ramGb
    ? sharedText(lang, "capacity.findings.upgrade", { tier: capacityTierLabel(t.id, lang), vcpu: t.vcpu, ram: t.ramGb })
    : sharedText(lang, "capacity.findings.upgradeEnterprise");
}

function tierAbove(t: CapacityTier): CapacityTier {
  const i = CAPACITY_TIERS.indexOf(t);
  return CAPACITY_TIERS[Math.min(i + 1, CAPACITY_TIERS.length - 1)]!;
}

export interface CapacityEvaluation {
  level: StatusLevel;
  /** Tier the registered users need. */
  needed: CapacityTier;
  /** Tier the hardware meets (null: below the smallest). */
  hardware: CapacityTier | null;
  findings: CapacityFinding[];
}

/**
 * Compares the server with the table (docs §5). Pure: the screen and the tests call it the same way.
 * Titles and actions are in `lang` (default Turkish).
 */
export function evaluateCapacity(input: {
  hardware: CapacityHardware;
  counts: CapacityCounts;
  lastRun?: Pick<CapacityRunDto, "finishedAt" | "result"> | null;
  now?: Date;
  lang?: string;
}): CapacityEvaluation {
  const { hardware: hw, counts } = input;
  const lang = input.lang ?? SHARED_DEFAULT_LANGUAGE;
  const now = input.now ?? new Date();
  const needed = tierForUsers(counts.registered);
  const neededLabel = capacityTierLabel(needed.id, lang);
  const findings: CapacityFinding[] = [usersFinding(hw, counts.registered, lang)];

  if (needed.ramGb !== null) {
    const ramGb = hw.memoryBytes / GiB;
    const need = needed.ramGb * RAM_TOLERANCE;
    const ram = Math.round(ramGb);
    if (ramGb < need) {
      findings.push({
        key: "memory",
        level: ramGb < need * 0.75 ? "danger" : "warn",
        title: sharedText(lang, "capacity.findings.memory", { ram, tier: neededLabel, need: needed.ramGb }),
        action: sharedText(lang, "capacity.findings.memoryAction", { need: needed.ramGb }),
      });
    } else findings.push({ key: "memory", level: "ok", title: sharedText(lang, "capacity.findings.memoryOk", { ram }), action: ok(lang) });
  }

  if (needed.vcpu !== null) {
    if (hw.cpuCount < needed.vcpu) {
      findings.push({
        key: "cpu",
        level: hw.cpuCount < needed.vcpu / 2 ? "danger" : "warn",
        title: sharedText(lang, "capacity.findings.cpu", { cpu: hw.cpuCount, tier: neededLabel, need: needed.vcpu }),
        action: sharedText(lang, "capacity.findings.cpuAction", { need: needed.vcpu }),
      });
    } else findings.push({ key: "cpu", level: "ok", title: sharedText(lang, "capacity.findings.cpuOk", { cpu: hw.cpuCount }), action: ok(lang) });
  }

  if (hw.disk && hw.disk.totalBytes > 0) {
    const free = hw.disk.freeBytes / hw.disk.totalBytes;
    const used = Math.round((1 - free) * 100);
    const level: StatusLevel = free < 0.05 ? "danger" : free < 0.2 ? "warn" : "ok";
    findings.push({
      key: "disk",
      level,
      title: sharedText(lang, "capacity.findings.disk", { used }),
      action: level === "ok" ? ok(lang) : sharedText(lang, "capacity.findings.diskAction"),
    });
  }

  const run = input.lastRun;
  if (!run?.finishedAt || !run.result) {
    findings.push({
      key: "test",
      level: "warn",
      title: sharedText(lang, "capacity.findings.testMissing"),
      action: sharedText(lang, "capacity.findings.testMissingAction"),
    });
  } else {
    const days = (now.getTime() - new Date(run.finishedAt).getTime()) / 86_400_000;
    findings.push(
      days > CAPACITY_TEST_MAX_AGE_DAYS
        ? {
            key: "test",
            level: "warn",
            title: sharedText(lang, "capacity.findings.testOld", { count: Math.floor(days) }),
            action: sharedText(lang, "capacity.findings.testOldAction"),
          }
        : { key: "test", level: "ok", title: sharedText(lang, "capacity.findings.testRecent"), action: ok(lang) },
    );
    const measured = run.result.registered;
    if (measured !== null) {
      const level: StatusLevel = measured < counts.active ? "danger" : measured < counts.active * 1.2 ? "warn" : "ok";
      findings.push({
        key: "measured",
        level,
        title: sharedText(lang, "capacity.findings.measured", { measured, active: counts.active }),
        action: level === "ok" ? ok(lang) : sharedText(lang, "capacity.findings.measuredAction"),
      });
    }
  }

  const level: StatusLevel = findings.some((f) => f.level === "danger") ? "danger" : findings.some((f) => f.level === "warn") ? "warn" : "ok";
  return { level, needed, hardware: hardwareTier(hw), findings };
}

/** Concurrent capacity measured by a load test → registered users (docs §4.2). */
export function registeredFromConcurrent(concurrent: number, concurrency = CAPACITY_CONCURRENCY): number {
  return Math.floor(concurrent / concurrency);
}

// ---- Capacity test (Canlı Test Et) ----

export type CapacityRunMode = "quick" | "load";
/** passed: reached the top step; limited: stopped at a limit (normal result); cancelled; failed. */
export type CapacityRunStatus = "running" | "passed" | "limited" | "cancelled" | "failed";

/** One point a second while a load test runs. */
export interface CapacitySample {
  /** Seconds since the start. */
  t: number;
  users: number;
  rps: number;
  p95Ms: number;
  errorRate: number;
  cpu: number;
  memory: number;
}

/** One step of a load test (N virtual users for a while). */
export interface CapacityStep {
  users: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rps: number;
  errorRate: number;
  cpu: number;
  memory: number;
  passed: boolean;
}

export type CapacityCheckKey = "hardware" | "cpu" | "disk" | "database" | "ifc" | "memory";

/** One measurement of the quick check (docs §4.1). */
export interface CapacityCheck {
  key: CapacityCheckKey;
  label: string;
  /** Shown value ("412 MB/sn"); null while it runs. */
  value: string | null;
  level: StatusLevel | null;
}

export interface CapacityRunDto {
  id: string;
  mode: CapacityRunMode;
  status: CapacityRunStatus;
  /** Sample engine: nothing was measured (the screen says "örnek veri"). */
  demo: boolean;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  /** 0..1 */
  progress: number;
  /** Human readable stage ("50 sanal kullanıcı", "Disk hızı"). */
  stage: string;
  hardware: CapacityHardware;
  appVersion: string | null;
  checks: CapacityCheck[];
  samples: CapacitySample[];
  steps: CapacityStep[];
  result: {
    /** Highest step that stayed within the limits (load test). */
    concurrent: number | null;
    registered: number | null;
    /** Limit that ended the test; null when it reached the top step or was a quick check. */
    stopReason: string | null;
  } | null;
  findings: CapacityFinding[];
}

export interface AdminCapacityDto {
  demo: boolean;
  measuredAt: string | null;
  concurrency: number;
  hardware: CapacityHardware;
  counts: CapacityCounts;
  level: StatusLevel;
  neededTier: CapacityTierId;
  hardwareTier: CapacityTierId | null;
  findings: CapacityFinding[];
  lastRun: CapacityRunDto | null;
  running: CapacityRunDto | null;
  /** Full load test allowed on this installation (CAPACITY_LOAD_TEST). */
  loadTestEnabled: boolean;
}
