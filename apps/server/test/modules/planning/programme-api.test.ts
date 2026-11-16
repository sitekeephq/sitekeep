import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, users } from "../../../src/db/schema.js";
import { scheduleSeriesSettings } from "@7dimensions-project/sitekeep-ee-planning/internal/schema-tables.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(path.join(here, "../../fixtures", "schedule.csv"));
const PW = "Sifre-1234567";

type Finding = { rule: string; severity: string; activityCode?: string; message: string; params: Record<string, string | number> };

describe("İş programı süre dayanağı, program kontrolü ve başlangıç tarihi API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-programme-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 6) });
    await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  function client(cookie: string, lang = "en") {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": lang }, payload: payload as object });
      return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : null, raw: res.rawPayload, headers: res.headers };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      upload: async (url: string, name: string, data: Buffer) => {
        const form = new FormData();
        form.append("file", new Blob([data]), name);
        const req = new Request("http://x", { method: "POST", body: form });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1${url}`,
          headers: { cookie, "accept-language": lang, "content-type": req.headers.get("content-type")! },
          payload: Buffer.from(await req.arrayBuffer()),
        });
        return { status: res.statusCode, body: res.json() };
      },
    };
  }

  const sheet = (buf: Buffer, index = 0) => {
    const wb = XLSX.read(buf, { type: "buffer" });
    return { names: wb.SheetNames, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[index]!]!, { header: 1, defval: "" }) };
  };

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let pid: string;
  let sid: string;
  const base = (id = sid) => `/projects/${pid}/schedules/${id}`;
  const basis = (activityCode: string, o: Record<string, unknown> = {}) => ({
    activityCode,
    quantity: null,
    unit: null,
    ratePerDay: null,
    crews: null,
    shiftsPerDay: null,
    hoursPerShift: null,
    note: null,
    ...o,
  });

  it("sets up a project with a schedule", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    pid = (await admin.post("/projects", { code: "INR", name: "Hat projesi" })).body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    const r = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.id;
  });

  it("keeps old settings readable and stores Day 0, Time for Completion and contract milestones", async () => {
    const old = (await member.get(`${base()}/settings`)).body;
    expect(old).toMatchObject({ dayZero: null, timeForCompletionDays: null, contractMilestones: [] });
    // A client that does not know the new fields still saves (defaults).
    const { dayZero: _d, timeForCompletionDays: _t, contractMilestones: _c, ...legacy } = old;
    expect((await admin.put(`${base()}/settings`, legacy)).status).toBe(200);
    const next = { ...old, dayZero: "2026-01-05", timeForCompletionDays: 30, contractMilestones: [{ code: "A40", label: "M1 Foundations", month: 1 }, { code: "Z99", label: "M2 Missing", month: 2 }] };
    expect((await member.put(`${base()}/settings`, next)).status).toBe(403);
    expect((await admin.put(`${base()}/settings`, { ...next, dayZero: "05.01.2026" })).status).toBe(400);
    expect((await admin.put(`${base()}/settings`, { ...next, contractMilestones: [{ code: "", label: "x", month: 1 }] })).status).toBe(400);
    expect((await admin.put(`${base()}/settings`, next)).status).toBe(200);
    expect((await member.get(`${base()}/settings`)).body).toMatchObject({ dayZero: "2026-01-05", timeForCompletionDays: 30, contractMilestones: next.contractMilestones });
  });

  it("lets members read duration bases and only planners write them", async () => {
    expect((await member.get(`${base()}/duration-basis`)).body).toEqual({ items: [] });
    expect((await member.put(`${base()}/duration-basis`, { items: [basis("A20", { quantity: 100, ratePerDay: 5 })] })).status).toBe(403);
    expect((await admin.put(`${base()}/duration-basis`, { items: [basis("NOPE", { quantity: 1, ratePerDay: 1 })] })).status).toBe(400);
    expect((await admin.put(`${base()}/duration-basis`, { items: [basis("A20", { quantity: -1 })] })).status).toBe(400);
    const r = await admin.put(`${base()}/duration-basis`, {
      items: [basis("A20", { quantity: 100, unit: " m2 ", ratePerDay: 5, crews: 2, shiftsPerDay: 1, hoursPerShift: 10, note: "Precast panels" }), basis("A30", { note: "Rough guess" })],
    });
    expect(r.body).toEqual({ saved: 2, deleted: 0 });
    const items = (await member.get(`${base()}/duration-basis`)).body.items as { activityCode: string; unit: string | null; source: string }[];
    expect(items.map((i) => [i.activityCode, i.unit, i.source]).sort()).toEqual([
      ["A20", "m2", "manual"],
      ["A30", null, "manual"],
    ]);
    // Only the code: removes the basis.
    expect((await admin.put(`${base()}/duration-basis`, { items: [basis("A30")] })).body).toEqual({ saved: 0, deleted: 1 });
  });

  it("downloads the basis template and reads it back", async () => {
    const tpl = await member.get(`${base()}/duration-basis/template`);
    expect(tpl.status).toBe(200);
    expect(String(tpl.headers["content-disposition"])).toContain("duration-basis.xlsx");
    const { names, rows } = sheet(tpl.raw);
    expect(names).toEqual(["Duration Basis", "How to Fill In"]);
    expect(rows[0]).toEqual(["Activity ID", "Activity Name", "Duration (Working Days)", "Quantity", "Unit", "Rate per Crew-Day", "Crews", "Shifts per Day", "Hours per Shift", "Basis Note"]);
    // Tasks only (WBS nodes are left out); the saved basis is filled in.
    expect(rows.slice(1).map((r) => r[0])).toEqual(["A10", "A20", "A30", "A40"]);
    expect(rows[2]!.slice(3)).toEqual([100, "m2", 5, 2, 1, 10, "Precast panels"]);

    rows[1]![3] = 4;
    rows[1]![5] = 1;
    rows[1]![9] = "Mobilisation crew";
    rows.push(["ZZ1", "Unknown", 1, 5, "m", 1, 1, "", "", ""]);
    rows.push(["A30", "", "", "abc", "", "", "", "", "", ""]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "x");
    const up = await admin.upload(`${base()}/duration-basis/import`, "basis.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body).toEqual({ rows: 3, saved: 2, unmatched: 1, unmatchedCodes: ["ZZ1"], badRows: [7] });
    expect((await member.upload(`${base()}/duration-basis/import`, "basis.xlsx", Buffer.from("x"))).status).toBe(403);
    expect((await admin.upload(`${base()}/duration-basis/import`, "basis.csv", Buffer.from("a;b\n1;2\n"))).status).toBe(400);
    const items = (await member.get(`${base()}/duration-basis`)).body.items as { activityCode: string; quantity: number; source: string }[];
    expect(items.find((i) => i.activityCode === "A10")).toMatchObject({ quantity: 4, source: "table" });
  });

  it("writes the basis into the Excel and CSV exports", async () => {
    const x = await member.get(`${base()}/export?format=xlsx`);
    expect(x.status).toBe(200);
    const { rows } = sheet(x.raw);
    const col = (rows[0] as string[]).indexOf("Duration Basis");
    expect(col).toBeGreaterThan(0);
    expect(rows.find((r) => r[0] === "A20")![col]).toBe("100 m2 ÷ (5 m2/d × 2 crew) = 10 d · 1×10 h · Precast panels");
    const tr = await client((await login("admin@7d.test")), "tr").get(`${base()}/export?format=xlsx`);
    const trRows = sheet(tr.raw).rows;
    expect(trRows.find((r) => r[0] === "A20")![(trRows[0] as string[]).indexOf("Süre Dayanağı")]).toBe("100 m2 ÷ (5 m2/gün × 2 ekip) = 10 gün · 1×10 sa · Precast panels");
    const csv = (await member.get(`${base()}/export?format=csv`)).raw.toString("utf8");
    expect(csv.split("\r\n")[0]).toMatch(/,Duration Basis$/);
    expect(csv).toContain("Mobilisation crew");
  });

  it("runs the schedule checks", async () => {
    const r = await member.get(`${base()}/checks`);
    expect(r.status).toBe(200);
    const findings = r.body.findings as Finding[];
    const by = (rule: string) => findings.filter((f) => f.rule === rule);
    expect(r.body.dayZero).toBe("2026-01-05");
    expect(r.body.summary.total).toBe(findings.length);
    expect(by("contract_milestone_late").map((f) => [f.message, f.params.code])).toEqual([
      ["contractMilestoneMissing", "Z99"],
      ["contractMilestoneLate", "A40"],
    ]);
    expect(by("contract_milestone_late")[1]!.params).toMatchObject({ due: "2026-02-05", finish: "2026-02-13", days: 8 });
    expect(by("completion_late")[0]!.params).toMatchObject({ due: "2026-02-04", finish: "2026-02-13", days: 9 });
    // A20 (site building) follows only mobilisation: no design before it.
    expect(by("construction_before_consent").map((f) => f.activityCode)).toEqual(["A20"]);
    expect(by("no_es_hold_point").map((f) => f.message)).toEqual(["noEsHoldPointNone"]);
    expect(by("missing_basis").map((f) => f.activityCode)).toEqual(["A30", "A40"]);
    expect(findings[0]!.severity).toBe("error");
    expect((await member.get(`/projects/${pid}/schedules/not-a-uuid/checks`)).status).toBe(404);

    const x = await member.get(`${base()}/checks/export`);
    expect(x.status).toBe(200);
    expect(String(x.headers["content-disposition"])).toMatch(/-checks\.xlsx/);
    const { names, rows } = sheet(x.raw);
    expect(names).toEqual(["Findings", "Summary"]);
    expect(rows[0]).toEqual(["Severity", "Rule", "Activity ID", "Activity Name", "Finding"]);
    expect(rows.length - 1).toBe(findings.length);
    expect(rows.some((row) => row[1] === "Contractual Milestones" && String(row[4]).includes("8 days after the contractual date 2026-02-05 (Month 1)"))).toBe(true);
  });

  it("re-dates the programme to the Commencement Date as a new version", async () => {
    expect((await member.post(`${base()}/commencement`, { date: "2026-03-02" })).status).toBe(403);
    expect((await admin.post(`${base()}/commencement`, { date: "2026-1-5" })).status).toBe(400);
    expect((await admin.post(`${base()}/commencement`, { date: "2026-01-05" })).status).toBe(400);
    const r = await admin.post(`${base()}/commencement`, { date: "2026-03-02" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ version: 2, isBaseline: false, startDate: "2026-03-02" });
    const v1 = (await member.get(`${base()}/activities`)).body as { code: string; start: string; finish: string }[];
    const v2 = (await member.get(`${base(r.body.id)}/activities`)).body as typeof v1;
    const a10 = (l: typeof v1) => l.find((a) => a.code === "A10")!;
    expect([a10(v1).start, a10(v1).finish]).toEqual(["2026-01-05", "2026-01-09"]);
    expect([a10(v2).start, a10(v2).finish]).toEqual(["2026-03-02", "2026-03-06"]);
    expect(v2.find((a) => a.code === "A40")!.finish).toBe("2026-04-10");
    // Day 0 moved with it; the other settings and the series' bases are kept.
    const s = (await member.get(`${base(r.body.id)}/settings`)).body;
    expect(s).toMatchObject({ dayZero: "2026-03-02", timeForCompletionDays: 30, contractMilestones: [{ code: "A40", label: "M1 Foundations", month: 1 }, { code: "Z99", label: "M2 Missing", month: 2 }] });
    expect(((await member.get(`${base(r.body.id)}/duration-basis`)).body.items as unknown[]).length).toBe(2);
    const late = ((await member.get(`${base(r.body.id)}/checks`)).body.findings as Finding[]).find((f) => f.message === "contractMilestoneLate")!;
    expect(late.params).toMatchObject({ due: "2026-04-02", finish: "2026-04-10", days: 8 });
    // The stored settings row holds the new Day 0.
    const [row] = await handle.db.select().from(scheduleSeriesSettings);
    expect(row!.settings.dayZero).toBe("2026-03-02");
  });

  it("audits every change", async () => {
    const rows = await handle.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.projectId, pid));
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["schedule.duration_basis_saved", "schedule.duration_basis_imported", "schedule.checks_exported", "schedule.commencement_shifted", "schedule.settings_saved"]) expect(actions).toContain(a);
  });
});
