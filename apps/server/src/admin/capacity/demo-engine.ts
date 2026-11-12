/**
 * Sample engine: plays a believable quick check / load test for the server's real hardware without
 * sending a single request. Every run it produces is labelled demo ("örnek veri") on the screen and
 * in the report. docs/onprem/capacity.md §6.5.
 */
import {
  CAPACITY_LIMITS,
  hardwareTier,
  registeredFromConcurrent,
  type CapacityHardware,
  type CapacityStep,
  type StatusLevel,
} from "@sitekeep/shared";
import { msg, type Msg } from "../../i18n/index.js";
import { pause, type CapacityEngine, type CapacityEngineCheck, type CapacityEngineContext, type CapacityEngineResult } from "./engine.js";

const GiB = 1024 ** 3;
const LOAD_STEPS = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400];
const TICKS_PER_STEP = 8;
const TICKS_PER_CHECK = 4;

/** Deterministic noise so two runs on one machine look alike. */
function noise(seed: number): () => number {
  let x = seed % 2147483647 || 1;
  return () => {
    x = (x * 48271) % 2147483647;
    return x / 2147483647 - 0.5;
  };
}

/** Concurrent users the sample machine "carries": limited by cores and RAM. */
export function demoConcurrentCapacity(hw: CapacityHardware): number {
  return Math.max(2, Math.round(Math.min(hw.cpuCount * 5, (hw.memoryBytes / GiB) * 1.25)));
}

function point(users: number, capacity: number, r: () => number) {
  const load = users / capacity;
  const p95Ms = Math.max(20, 45 + 455 * load ** 2.5 + r() * 18);
  return {
    p95Ms,
    p50Ms: p95Ms * 0.42,
    p99Ms: p95Ms * 1.9,
    // ~1.6 requests a second per user; throughput flattens once the machine is saturated.
    rps: Math.max(0.5, (users * 1.6) / Math.max(1, load) ** 0.5 + r() * 2),
    errorRate: load > 1.05 ? 0.0015 * load : 0.0001 * Math.max(0, r() + 0.5),
    cpu: Math.min(0.98, 0.08 + 0.8 * load + r() * 0.03),
    memory: Math.min(0.95, 0.32 + 0.38 * load + r() * 0.02),
  };
}

function stopReason(s: Omit<CapacityStep, "users" | "passed">): Msg | null {
  if (s.p95Ms > CAPACITY_LIMITS.p95Ms) return msg("admin:capacity.stop.p95", { ms: CAPACITY_LIMITS.p95Ms });
  if (s.p99Ms > CAPACITY_LIMITS.p99Ms) return msg("admin:capacity.stop.p99", { ms: CAPACITY_LIMITS.p99Ms });
  if (s.errorRate > CAPACITY_LIMITS.errorRate) return msg("admin:capacity.stop.errorRate", { pct: CAPACITY_LIMITS.errorRate * 100 });
  if (s.cpu > CAPACITY_LIMITS.cpu) return msg("admin:capacity.stop.cpu", { pct: CAPACITY_LIMITS.cpu * 100 });
  if (1 - s.memory < CAPACITY_LIMITS.freeMemory) return msg("admin:capacity.stop.freeMemory", { pct: CAPACITY_LIMITS.freeMemory * 100 });
  return null;
}

export class DemoEngine implements CapacityEngine {
  readonly demo = true;

  /** @param tick one sample (one second of a real test) lasts this many ms; read at every run. */
  constructor(private readonly tick: () => number = () => 250) {}

  private tickMs = 250;

  run(ctx: CapacityEngineContext): Promise<CapacityEngineResult> {
    this.tickMs = this.tick();
    return ctx.mode === "quick" ? this.quick(ctx) : this.load(ctx);
  }

  private async quick(ctx: CapacityEngineContext): Promise<CapacityEngineResult> {
    const hw = ctx.hardware;
    const ramGb = hw.memoryBytes / GiB;
    const tier = hardwareTier(hw);
    const ifcSeconds = Math.round(18 * Math.sqrt(8 / Math.max(hw.cpuCount, 1)));
    const freeAfterTier = tier?.ramGb ? ramGb - tier.ramGb * 0.6 : ramGb - 6;
    const checks: { check: CapacityEngineCheck; stage: Msg }[] = [
      {
        stage: msg("admin:capacity.stage.hardware"),
        check: {
          key: "hardware",
          label: msg("admin:capacity.check.hardware"),
          value: hw.disk
            ? msg("admin:capacity.value.hardwareDisk", { cpus: hw.cpuCount, ram: Math.round(ramGb), disk: Math.round(hw.disk.totalBytes / GiB) })
            : msg("admin:capacity.value.hardware", { cpus: hw.cpuCount, ram: Math.round(ramGb) }),
          level: tier ? "ok" : "danger",
        },
      },
      {
        stage: msg("admin:capacity.stage.cpu"),
        check: { key: "cpu", label: msg("admin:capacity.check.cpu"), value: msg("admin:capacity.value.cpu", { cores: hw.cpuCount, factor: Number((hw.cpuCount * 0.86).toFixed(1)) }), level: "ok" },
      },
      { stage: msg("admin:capacity.stage.disk"), check: { key: "disk", label: msg("admin:capacity.check.disk"), value: msg("admin:capacity.value.disk"), level: "ok" } },
      { stage: msg("admin:capacity.stage.database"), check: { key: "database", label: msg("admin:capacity.check.database"), value: msg("admin:capacity.value.database"), level: "ok" } },
      {
        stage: msg("admin:capacity.stage.ifc"),
        check: { key: "ifc", label: msg("admin:capacity.check.ifc"), value: msg("admin:capacity.value.ifc", { seconds: ifcSeconds }), level: ifcSeconds > 40 ? "warn" : "ok" },
      },
      {
        stage: msg("admin:capacity.stage.memory"),
        check: {
          key: "memory",
          label: msg("admin:capacity.check.memory"),
          value: msg("admin:capacity.value.memory", { gb: Math.max(0, Math.round(freeAfterTier)) }),
          level: (freeAfterTier < 2 ? "danger" : freeAfterTier < 4 ? "warn" : "ok") as StatusLevel,
        },
      },
    ];
    for (const { check } of checks) ctx.setCheck({ ...check, value: null, level: null });
    for (const [i, { check, stage }] of checks.entries()) {
      ctx.setStage(stage, i / checks.length);
      await pause(this.tickMs * TICKS_PER_CHECK, ctx.signal);
      ctx.setCheck(check);
    }
    ctx.setStage(msg("admin:capacity.stage.done"), 1);
    return { status: "passed", result: { concurrent: null, registered: null, stopReason: null } };
  }

  private async load(ctx: CapacityEngineContext): Promise<CapacityEngineResult> {
    const capacity = demoConcurrentCapacity(ctx.hardware);
    const r = noise(ctx.hardware.cpuCount * 7919 + Math.round(ctx.hardware.memoryBytes / GiB));
    const top = Math.max(capacity * 2, 10);
    const steps = LOAD_STEPS.filter((u) => u <= top);
    let t = 0;
    let passed: number | null = null;
    for (const [i, users] of steps.entries()) {
      ctx.setStage(msg("admin:capacity.stage.users", { count: users }), i / steps.length);
      const ticks: ReturnType<typeof point>[] = [];
      for (let k = 0; k < TICKS_PER_STEP; k++) {
        await pause(this.tickMs, ctx.signal);
        // The first seconds of a step ramp up from the previous one.
        const ramp = Math.min(1, (k + 1) / 3);
        const active = Math.round((steps[i - 1] ?? 0) + (users - (steps[i - 1] ?? 0)) * ramp);
        const p = point(active, capacity, r);
        ticks.push(p);
        ctx.sample({ t: ++t, users: active, rps: p.rps, p95Ms: p.p95Ms, errorRate: p.errorRate, cpu: p.cpu, memory: p.memory });
      }
      const steady = ticks.slice(3);
      const avg = (key: keyof ReturnType<typeof point>) => steady.reduce((s, p) => s + p[key], 0) / steady.length;
      const summary = { p50Ms: avg("p50Ms"), p95Ms: avg("p95Ms"), p99Ms: avg("p99Ms"), rps: avg("rps"), errorRate: avg("errorRate"), cpu: avg("cpu"), memory: avg("memory") };
      const reason = stopReason(summary);
      ctx.step({ users, ...summary, passed: !reason });
      if (reason) {
        ctx.setStage(msg("admin:capacity.stage.limitReached"), 1);
        return {
          status: "limited",
          result: { concurrent: passed, registered: passed === null ? null : registeredFromConcurrent(passed), stopReason: reason },
        };
      }
      passed = users;
    }
    ctx.setStage(msg("admin:capacity.stage.done"), 1);
    return { status: "passed", result: { concurrent: passed, registered: passed === null ? null : registeredFromConcurrent(passed), stopReason: null } };
  }
}
