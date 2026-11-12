import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPACITY_CONCURRENCY,
  CAPACITY_TIERS,
  capacityTierLabel,
  evaluateCapacity,
  hardwareTier,
  registeredFromConcurrent,
  tierForUsers,
  usersFinding,
  type CapacityHardware,
} from "../src/index.js";

const GiB = 1024 ** 3;
const here = path.dirname(fileURLToPath(import.meta.url));

/** RAM as the operating system reports it (a little under the installed size). */
function machine(cpuCount: number, ramGb: number, diskUsed = 0.3): CapacityHardware {
  return {
    cpuCount,
    cpuModel: "test",
    memoryBytes: ramGb * GiB * 0.97,
    disk: { path: "/data", totalBytes: 1000 * GiB, freeBytes: (1 - diskUsed) * 1000 * GiB },
    os: "linux",
  };
}

const recent = { finishedAt: "2026-10-20T00:00:00Z", result: { concurrent: 40, registered: 266, stopReason: null } };
const now = new Date("2026-10-25T00:00:00Z");

describe("capacity tiers", () => {
  it("are ordered and size concurrency from the shared ratio", () => {
    const bounded = CAPACITY_TIERS.filter((t) => t.maxUsers !== null);
    for (let i = 1; i < bounded.length; i++) {
      expect(bounded[i]!.maxUsers!).toBeGreaterThan(bounded[i - 1]!.maxUsers!);
      expect(bounded[i]!.ramGb!).toBeGreaterThan(bounded[i - 1]!.ramGb!);
    }
    for (const t of bounded) expect(t.concurrent).toBe(Math.ceil(t.maxUsers! * CAPACITY_CONCURRENCY));
  });

  it("picks the smallest tier for a user count", () => {
    expect(tierForUsers(1).id).toBe("trial");
    expect(tierForUsers(10).id).toBe("trial");
    expect(tierForUsers(11).id).toBe("small");
    expect(tierForUsers(200).id).toBe("medium");
    expect(tierForUsers(501).id).toBe("enterprise");
  });

  it("reads installed RAM with the operating system's shortfall", () => {
    expect(hardwareTier(machine(8, 32))?.id).toBe("medium");
    expect(hardwareTier(machine(16, 32))?.id).toBe("medium");
    expect(hardwareTier(machine(4, 64))?.id).toBe("small");
    expect(hardwareTier(machine(2, 4))).toBeNull();
  });

  it("matches the table in docs/onprem/kapasite.md", () => {
    const doc = readFileSync(path.join(here, "../../../docs/onprem/kapasite.md"), "utf8");
    for (const t of CAPACITY_TIERS.filter((x) => x.vcpu !== null)) {
      const label = capacityTierLabel(t.id);
      const row = doc.split("\n").find((line) => line.startsWith(`| ${label} |`));
      expect(row, label).toBeTruthy();
      const cells = row!.split("|").map((c) => c.trim());
      expect(cells[2]).toBe(`≤ ${t.maxUsers}`);
      expect(cells[3]).toBe(String(t.concurrent));
      expect(cells[4]).toBe(String(t.vcpu));
      expect(cells[5]).toBe(`${t.ramGb} GB`);
    }
  });
});

describe("evaluateCapacity", () => {
  it("is green when the server fits the users and a recent test covers the active ones", () => {
    const e = evaluateCapacity({ hardware: machine(8, 32), counts: { registered: 120, active: 90 }, lastRun: recent, now });
    expect(e.level).toBe("ok");
    expect(e.needed.id).toBe("medium");
    expect(e.hardware?.id).toBe("medium");
  });

  it("warns at 90% of the tier and turns red above it, with the next tier as the action", () => {
    const near = usersFinding(machine(8, 32), 185);
    expect(near.level).toBe("warn");
    expect(near.action).toContain("Büyük kademesi: en az 16 vCPU, 64 GB RAM");
    const over = usersFinding(machine(8, 32), 212);
    expect(over.level).toBe("danger");
    expect(over.title).toBe("212 kullanıcı · sunucu 200 kullanıcıya göre");
    expect(over.action).toContain("Büyük kademesi");
  });

  it("names the missing RAM and CPU for the users' tier", () => {
    const e = evaluateCapacity({ hardware: machine(4, 16), counts: { registered: 150, active: 60 }, lastRun: recent, now });
    expect(e.level).toBe("danger");
    const memory = e.findings.find((f) => f.key === "memory")!;
    expect(memory).toMatchObject({ level: "danger", action: "RAM'i en az 32 GB yapın." });
    const cpu = e.findings.find((f) => f.key === "cpu")!;
    expect(cpu).toMatchObject({ level: "warn", action: "İşlemciyi en az 8 vCPU yapın." });
  });

  it("flags a server below the smallest tier (the live e2-medium: 2 vCPU, 4 GB)", () => {
    const e = evaluateCapacity({ hardware: machine(2, 4), counts: { registered: 8, active: 5 }, now });
    expect(e.hardware).toBeNull();
    expect(e.findings.find((f) => f.key === "users")!.level).toBe("danger");
    expect(e.findings.find((f) => f.key === "memory")!.action).toBe("RAM'i en az 8 GB yapın.");
  });

  it("asks for a test when there is none or it is older than 90 days", () => {
    const none = evaluateCapacity({ hardware: machine(8, 32), counts: { registered: 20, active: 10 }, now });
    expect(none.findings.find((f) => f.key === "test")!.level).toBe("warn");
    const old = evaluateCapacity({
      hardware: machine(8, 32),
      counts: { registered: 20, active: 10 },
      lastRun: { ...recent, finishedAt: "2026-06-01T00:00:00Z" },
      now,
    });
    expect(old.findings.find((f) => f.key === "test")!.title).toMatch(/^Son test \d+ gün önce$/);
  });

  it("compares the measured capacity with the active users", () => {
    const run = { ...recent, result: { concurrent: 15, registered: 100, stopReason: "p95" } };
    const tight = evaluateCapacity({ hardware: machine(8, 32), counts: { registered: 150, active: 90 }, lastRun: run, now });
    expect(tight.findings.find((f) => f.key === "measured")!.level).toBe("warn");
    const short = evaluateCapacity({ hardware: machine(8, 32), counts: { registered: 150, active: 120 }, lastRun: run, now });
    expect(short.findings.find((f) => f.key === "measured")!.level).toBe("danger");
  });

  it("grades the data disk", () => {
    const level = (used: number) =>
      evaluateCapacity({ hardware: machine(8, 32, used), counts: { registered: 20, active: 10 }, lastRun: recent, now }).findings.find(
        (f) => f.key === "disk",
      )!.level;
    expect(level(0.5)).toBe("ok");
    expect(level(0.85)).toBe("warn");
    expect(level(0.97)).toBe("danger");
  });

  it("turns concurrent users into registered ones with the shared ratio", () => {
    expect(registeredFromConcurrent(30)).toBe(200);
    expect(registeredFromConcurrent(30, 0.3)).toBe(100);
  });
});
