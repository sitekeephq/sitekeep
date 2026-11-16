import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(path.join(here, "../../fixtures", "schedule.csv"));
const PW = "Sifre-1234567";

describe("İş programı CPM, ayarlar, şablonlar ve dışa aktarım API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-export-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
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

  function client(cookie: string) {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
      return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : null, raw: res.rawPayload, headers: res.headers };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      del: (u: string) => call("DELETE", u),
      upload: async (url: string, name: string, data: Buffer, fields: Record<string, string> = {}) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        form.append("file", new Blob([data]), name);
        const req = new Request("http://x", { method: "POST", body: form });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1${url}`,
          headers: { cookie, "content-type": req.headers.get("content-type")! },
          payload: Buffer.from(await req.arrayBuffer()),
        });
        return { status: res.statusCode, body: res.json() };
      },
    };
  }

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let pid: string;
  let sid: string;

  it("sets up a project with a schedule", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    const p = await admin.post("/projects", { code: "INR", name: "Hat projesi" });
    pid = p.body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    const r = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.id;
    await admin.put(`/projects/${pid}/schedules/${sid}/locations`, { items: [{ activityCode: "A20", kmStart: 1, kmEnd: 2, source: "manual" }] });
  });

  it("computes CPM with SPI", async () => {
    const r = await member.get(`/projects/${pid}/schedules/${sid}/cpm`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows.length).toBeGreaterThan(0);
    expect(r.body.finish).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.spi).toHaveProperty("planned");
  });

  it("saves programme settings for planners only", async () => {
    const body = { calendar: { workDays: [1, 2, 3, 4, 5], holidays: ["2026-01-01"], hoursPerDay: 9 }, nearCriticalDays: 5, milestoneTypes: { A40: "contractual" }, assumptions: ["Tünel kazısı 2 vardiya × 10 saat"] };
    expect((await member.put(`/projects/${pid}/schedules/${sid}/settings`, body)).status).toBe(403);
    expect((await admin.put(`/projects/${pid}/schedules/${sid}/settings`, { ...body, nearCriticalDays: -1 })).status).toBe(400);
    expect((await admin.put(`/projects/${pid}/schedules/${sid}/settings`, { ...body, assumptions: Array(41).fill("x") })).status).toBe(400);
    expect((await admin.put(`/projects/${pid}/schedules/${sid}/settings`, body)).status).toBe(200);
    // Contract dates default when a client does not send them.
    expect((await member.get(`/projects/${pid}/schedules/${sid}/settings`)).body).toEqual({ ...body, dayZero: null, timeForCompletionDays: null, contractMilestones: [] });
    expect((await member.get(`/projects/${pid}/schedules/${sid}/cpm`)).body.nearCriticalDays).toBe(5);
  });

  let tid: string;
  it("manages print templates", async () => {
    const template = { header: { leftLogoFileId: null, rightLogoFileId: null, lines: ["{project}", "{schedule}"] }, footer: { left: "{projectCode}", center: "{printed}", right: "{page} / {pages}" }, titleBlock: [{ label: "Proje", value: "{project}" }], signatures: ["Hazırlayan", "Onay"] };
    expect((await member.post(`/projects/${pid}/schedule-print-templates`, { name: "İşveren", template })).status).toBe(403);
    const c = await admin.post(`/projects/${pid}/schedule-print-templates`, { name: "İşveren", template });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    tid = c.body.id;
    expect((await member.get(`/projects/${pid}/schedule-print-templates`)).body.map((x: { name: string }) => x.name)).toEqual(["İşveren"]);
  });

  it("exports every format", async () => {
    const cases: [string, string, (b: Buffer) => boolean][] = [
      ["xer", "text/plain", (b) => b.toString("utf8").startsWith("ERMHDR")],
      ["p6xml", "xml", (b) => b.toString("utf8").includes("APIBusinessObjects")],
      ["mspdi", "xml", (b) => b.toString("utf8").includes("schemas.microsoft.com/project")],
      ["xlsx", "spreadsheetml", (b) => b[0] === 0x50 && b[1] === 0x4b],
      ["csv", "text/csv", (b) => b[0] === 0xef],
      ["ifc", "step", (b) => b.toString("latin1").startsWith("ISO-10303-21;")],
      ["dxf", "dxf", (b) => b.toString("latin1").startsWith("0\nSECTION")],
      ["tilos", "xml", (b) => b.toString("utf8").includes("<LPXFData>")],
      ["pdf&view=td&page=A3", "pdf", (b) => b.toString("latin1", 0, 5) === "%PDF-"],
      [`pdf&view=gantt&page=A1&template=${tid}&revision=Rev.02`, "pdf", (b) => b.toString("latin1", 0, 5) === "%PDF-"],
    ];
    for (const [q, type, ok] of cases) {
      const r = await member.get(`/projects/${pid}/schedules/${sid}/export?format=${q}`);
      expect(r.status, `${q}: ${r.raw.toString("utf8").slice(0, 200)}`).toBe(200);
      expect(String(r.headers["content-type"])).toContain(type);
      expect(ok(r.raw), q).toBe(true);
    }
    expect((await member.get(`/projects/${pid}/schedules/${sid}/export?format=docx`)).status).toBe(400);
  });

  it("re-imports its own MS Project XML and XER with the same activity codes", async () => {
    for (const [format, name] of [["mspdi", "geri.xml"], ["xer", "geri.xer"]] as const) {
      const file = await member.get(`/projects/${pid}/schedules/${sid}/export?format=${format}`);
      const r = await admin.upload(`/projects/${pid}/schedules`, name, file.raw);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const acts = (await admin.get(`/projects/${pid}/schedules/${r.body.id}/activities`)).body as { code: string; summary: boolean }[];
      expect(acts.filter((a) => !a.summary).map((a) => a.code).sort()).toEqual(["A10", "A20", "A30", "A40"]);
    }
  });

  it("deletes a print template", async () => {
    expect((await admin.del(`/projects/${pid}/schedule-print-templates/${tid}`)).status).toBe(204);
    expect((await member.get(`/projects/${pid}/schedule-print-templates`)).body).toEqual([]);
  });
});
