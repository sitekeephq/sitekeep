import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(path.join(here, "../../fixtures", "schedule.csv"));
const PW = "Sifre-1234567";

function xlsx(rows: (string | number)[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Km");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("Doğrusal planlama API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-linear-"));
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
  let outsider: ReturnType<typeof client>;
  let pid: string;
  let sid: string;
  let seriesId: string;

  it("sets up a project with a schedule", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    await admin.post("/users", { email: "dis@7d.test", name: "Dış", password: PW });
    const p = await admin.post("/projects", { code: "INR", name: "Hat projesi" });
    pid = p.body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    outsider = client(await login("dis@7d.test"));
    const r = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.id;
    seriesId = r.body.seriesId;
  });

  it("serves the chainage table template, pre-filled with the version's tasks", async () => {
    const blank = await member.get(`/projects/${pid}/schedules/chainage-template`);
    expect(blank.status).toBe(200);
    expect(String(blank.headers["content-type"])).toContain("spreadsheetml");
    const filled = await member.get(`/projects/${pid}/schedules/chainage-template?sid=${sid}`);
    const wb = XLSX.read(filled.raw, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 });
    expect(rows.slice(1).map((r) => r[0])).toEqual(["A10", "A20", "A30", "A40"]);
    expect(wb.SheetNames).toHaveLength(2);
    expect((await outsider.get(`/projects/${pid}/schedules/chainage-template`)).status).toBe(404);
  });

  it("imports a chainage table and reports unmatched rows", async () => {
    const file = xlsx([["Activity ID", "Start km", "End km"], ["A20", "1+350", "1+200"], ["A30", 2, 2.5], ["ZZZ", "1+000", "2+000"]]);
    expect((await member.upload(`/projects/${pid}/schedules/${sid}/locations/import`, "km.xlsx", file)).status).toBe(403);
    const r = await admin.upload(`/projects/${pid}/schedules/${sid}/locations/import`, "km.xlsx", file);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ rows: 3, saved: 2, unmatched: 1, outsideRoute: [] });
    const bad = await admin.upload(`/projects/${pid}/schedules/${sid}/locations/import`, "x.xlsx", xlsx([["a", "b"], ["1", "2"]]));
    expect(bad.status).toBe(400);
    const list = await member.get(`/projects/${pid}/schedules/${sid}/locations`);
    expect(list.body).toHaveLength(2);
    expect(list.body.find((l: { activityCode: string }) => l.activityCode === "A20")).toMatchObject({ kmStart: 1.2, kmEnd: 1.35, source: "table", rule: "chainage_table" });
  });

  it("proposes locations for the remaining tasks", async () => {
    const r = await member.get(`/projects/${pid}/schedules/${sid}/location-proposals`);
    expect(r.status).toBe(200);
    expect(r.body.map((i: { activityCode: string }) => i.activityCode)).toEqual(["A10", "A40"]);
    expect(r.body[0].proposals[0]).toEqual({ rule: "wbs_siblings", kmStart: 1.2, kmEnd: 1.35, locationId: null, detail: expect.any(String), confidence: 0.7 });
    expect(r.body[0].proposals.find((p: { rule: string }) => p.rule === "whole_route")).toMatchObject({ kmStart: 1.2, kmEnd: 2.5, confidence: 0.6 });
  });

  it("saves wizard assignments for planners only and validates codes", async () => {
    const item = { activityCode: "A10", kmStart: 2.5, kmEnd: 1.2, source: "rule", rule: "whole_route", confidence: 0.6, category: "general" };
    expect((await member.put(`/projects/${pid}/schedules/${sid}/locations`, { items: [item] })).status).toBe(403);
    expect((await admin.put(`/projects/${pid}/schedules/${sid}/locations`, { items: [{ ...item, activityCode: "NOPE" }] })).status).toBe(400);
    expect((await admin.put(`/projects/${pid}/schedules/${sid}/locations`, { items: [{ ...item, source: "guess" }] })).status).toBe(400);
    const ok = await admin.put(`/projects/${pid}/schedules/${sid}/locations`, { items: [item] });
    expect(ok.body).toEqual({ saved: 1 });
    const list = await member.get(`/projects/${pid}/schedules/${sid}/locations`);
    expect(list.body.find((l: { activityCode: string }) => l.activityCode === "A10")).toMatchObject({ kmStart: 1.2, kmEnd: 2.5, category: "general", source: "rule" });
  });

  it("keeps assignments across a re-import of the same programme", async () => {
    const r = await admin.upload(`/projects/${pid}/schedules`, "program-v2.csv", CSV, { seriesId: sid });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.seriesId).toBe(seriesId);
    const list = await member.get(`/projects/${pid}/schedules/${r.body.id}/locations`);
    expect(list.body).toHaveLength(3);
  });

  it("deletes assignments", async () => {
    const r = await admin.post(`/projects/${pid}/schedules/${sid}/locations/delete`, { codes: ["A10"] });
    expect(r.body).toEqual({ deleted: 1 });
    expect((await member.get(`/projects/${pid}/schedules/${sid}/locations`)).body).toHaveLength(2);
  });
});
