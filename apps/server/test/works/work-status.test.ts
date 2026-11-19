// Work status changes: actions can be cancelled; an unknown status is refused with the valid ones.
import { hasManage } from "../helpers/modules.js"; // actions belong to the Meetings module (Manage)
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ACTION_STATUSES } from "@sitekeep/shared";
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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-work-status-"));
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

async function client() {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  const cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p: unknown) => call("POST", u, p), patch: (u: string, p: unknown) => call("PATCH", u, p) };
}

it("offers a cancelled status for actions, closed like the other types' one", () => {
  expect(ACTION_STATUSES.find((s) => s.key === "iptal")).toMatchObject({ closed: true });
});

describe.skipIf(!hasManage)("action status changes", () => {
  let api: Awaited<ReturnType<typeof client>>;
  let pid: string;
  let wid: string;

  beforeAll(async () => {
    api = await client();
    pid = (await api.post("/projects", { code: "WST", name: "Durumlar" })).body.id;
    const types = await api.get(`/projects/${pid}/work-types`);
    expect(types.body.find((t: { key: string }) => t.key === "aksiyon").statuses.map((s: { key: string }) => s.key)).toEqual(["acik", "kapandi", "iptal"]);
    const w = await api.post(`/projects/${pid}/works`, { typeKey: "aksiyon", title: "Kapı detayını gönder" });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    wid = w.body.id;
  });

  it("refuses a status the type does not have, naming the valid ones", async () => {
    const r = await api.patch(`/projects/${pid}/works/${wid}`, { status: "cancelled" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("cancelled");
    expect(r.body.message).toContain("acik, kapandi, iptal");
    expect((await api.get(`/projects/${pid}/works/${wid}`)).body.status).toBe("acik");
  });

  it("cancels an action", async () => {
    const r = await api.patch(`/projects/${pid}/works/${wid}`, { status: "iptal" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = (await api.get(`/projects/${pid}/works/${wid}`)).body;
    expect(w.status).toBe("iptal");
  });

  it("hides cancelled works from the list on request, unless the status filter asks for them", async () => {
    await api.post(`/projects/${pid}/works`, { typeKey: "aksiyon", title: "Açık kalan" });
    const titles = async (qs: string) => (await api.get(`/projects/${pid}/works${qs}`)).body.map((w: { title: string }) => w.title).sort();
    expect(await titles("")).toEqual(["Açık kalan", "Kapı detayını gönder"]);
    expect(await titles("?cancelled=hide")).toEqual(["Açık kalan"]);
    expect(await titles("?cancelled=hide&status=iptal")).toEqual(["Kapı detayını gönder"]);
    expect(await titles("?cancelled=hide&status=acik,iptal")).toEqual(["Açık kalan", "Kapı detayını gönder"]);
  });
});
