/** Yönetim → Sistem Durumu → Kapasite (docs/onprem/kapasite.md): card, sample test engine, report. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CAPACITY_CONCURRENCY, type AdminCapacityDto, type CapacityRunDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let admin: string;

beforeAll(async () => {
  process.env.CAPACITY_DEMO_TICK_MS = "1";
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-capacity-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true },
    { email: "uye@7d.test", name: "Üye", passwordHash: await hashPassword(PW), isAdmin: false },
    { email: "kapali@7d.test", name: "Kapalı", passwordHash: await hashPassword(PW), isAdmin: false, disabled: true },
  ]);
  admin = await login("admin@7d.test");
});

afterAll(async () => {
  delete process.env.CAPACITY_DEMO_TICK_MS;
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

const call = (method: "GET" | "POST", url: string, payload?: object, cookie = admin) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

async function start(mode: "quick" | "load"): Promise<CapacityRunDto> {
  const res = await call("POST", "/admin/capacity/runs", { mode });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function finished(id: string): Promise<CapacityRunDto> {
  for (let i = 0; i < 500; i++) {
    const run = (await call("GET", `/admin/capacity/runs/${id}`)).json() as CapacityRunDto;
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("kapasite testi bitmedi");
}

describe("GET /admin/capacity", () => {
  it("is only for system administrators", async () => {
    const member = await login("uye@7d.test");
    expect((await call("GET", "/admin/capacity", undefined, member)).statusCode).toBe(403);
    expect((await call("POST", "/admin/capacity/runs", { mode: "quick" }, member)).statusCode).toBe(403);
  });

  it("reads this machine and the users, and asks for a first test", async () => {
    const card = (await call("GET", "/admin/capacity")).json() as AdminCapacityDto;
    expect(card.demo).toBe(false);
    expect(card.hardware.cpuCount).toBeGreaterThan(0);
    expect(card.hardware.memoryBytes).toBeGreaterThan(0);
    // The disabled account does not count; both signed-in accounts are active.
    expect(card.counts).toEqual({ registered: 2, active: 2 });
    expect(card.neededTier).toBe("trial");
    expect(card.lastRun).toBeNull();
    expect(card.findings.find((f) => f.key === "test")).toMatchObject({ level: "warn", title: "Kapasite testi yapılmadı" });
    expect(card.loadTestEnabled).toBe(true);
  });
});

describe("capacity test runs (sample engine)", () => {
  it("runs a quick check through every measurement and records it as the last test", async () => {
    const started = await start("quick");
    expect(started).toMatchObject({ mode: "quick", status: "running", demo: true });
    const run = await finished(started.id);
    expect(run.status).toBe("passed");
    expect(run.checks.map((c) => c.key)).toEqual(["hardware", "cpu", "disk", "database", "ifc", "memory"]);
    expect(run.checks.every((c) => c.value && c.level)).toBe(true);
    expect(run.findings.length).toBeGreaterThan(0);
    const card = (await call("GET", "/admin/capacity")).json() as AdminCapacityDto;
    expect(card.lastRun?.id).toBe(run.id);
    expect(card.findings.find((f) => f.key === "test")!.level).toBe("ok");
  });

  it("raises the load step by step and stops at the first step over a limit", async () => {
    const run = await finished((await start("load")).id);
    expect(run.status).toBe("limited");
    expect(run.samples.length).toBeGreaterThan(run.steps.length);
    const last = run.steps.at(-1)!;
    expect(last.passed).toBe(false);
    expect(run.steps.slice(0, -1).every((s) => s.passed)).toBe(true);
    const concurrent = run.steps.at(-2)?.users ?? null;
    expect(run.result).toMatchObject({ concurrent, registered: concurrent === null ? null : Math.floor(concurrent / CAPACITY_CONCURRENCY) });
    expect(run.result!.stopReason).toBeTruthy();
    const card = (await call("GET", "/admin/capacity")).json() as AdminCapacityDto;
    expect(card.findings.some((f) => f.key === "measured")).toBe(concurrent !== null);
    expect(card.lastRun?.samples).toEqual([]);
  });

  it("runs one test at a time and can be stopped", async () => {
    // Slow enough that the test is still running when Durdur arrives.
    process.env.CAPACITY_DEMO_TICK_MS = "50";
    const run = await start("load");
    process.env.CAPACITY_DEMO_TICK_MS = "1";
    expect((await call("POST", "/admin/capacity/runs", { mode: "quick" })).statusCode).toBe(409);
    expect((await call("GET", `/admin/capacity/runs/${run.id}/report`)).statusCode).toBe(400);
    expect((await call("POST", `/admin/capacity/runs/${run.id}/cancel`)).statusCode).toBe(200);
    const stopped = await finished(run.id);
    expect(stopped.status).toBe("cancelled");
    // A stopped test is not a result: the card keeps the previous one.
    const card = (await call("GET", "/admin/capacity")).json() as AdminCapacityDto;
    expect(card.lastRun?.id).not.toBe(run.id);
    expect((await call("GET", "/admin/capacity/runs")).json()[0].id).toBe(run.id);
  });

  it("refuses the full load test when the installation turns it off", async () => {
    process.env.CAPACITY_LOAD_TEST = "0";
    try {
      expect((await call("POST", "/admin/capacity/runs", { mode: "load" })).statusCode).toBe(400);
      expect(((await call("GET", "/admin/capacity")).json() as AdminCapacityDto).loadTestEnabled).toBe(false);
    } finally {
      delete process.env.CAPACITY_LOAD_TEST;
    }
  });

  it("downloads the report as HTML and the package for 7D as JSON without the disk path", async () => {
    const run = await finished((await start("load")).id);
    const html = await call("GET", `/admin/capacity/runs/${run.id}/report`);
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-disposition"]).toMatch(/attachment; filename="7d-kapasite-\d{4}-\d{2}-\d{2}\.html"/);
    expect(html.body).toContain("Kapasite Raporu · Tam Yük Testi");
    expect(html.body).toContain("Örnek veri.");
    expect(html.body).toContain("Yük basamakları");
    const json = await call("GET", `/admin/capacity/runs/${run.id}/report?format=json`);
    expect(json.statusCode).toBe(200);
    const body = json.json();
    expect(body.kind).toBe("7d-cde-capacity-report");
    expect(body.run.id).toBe(run.id);
    expect(body.run.startedBy).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(dataDir);
    expect((await call("GET", "/admin/capacity/runs/yok/report")).statusCode).toBe(404);
  });
});
