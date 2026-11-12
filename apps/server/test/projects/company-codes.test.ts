import { hasManage } from "../helpers/modules.js"; // steps that create RFIs, letters or meetings need Manage
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const YEAR = new Date().getFullYear();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-codes-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
  };
}

describe("company short codes", () => {
  let admin: ReturnType<typeof api>;
  let pelin: ReturnType<typeof api>;
  const co: Record<string, string> = {};

  it("validates, normalises and keeps codes unique", async () => {
    admin = api(await login("admin@7d.test"));
    const pas = await admin.post("/companies", { name: "Poyraz İnşaat", code: " psf " });
    expect(pas.status, JSON.stringify(pas.body)).toBe(200);
    expect(pas.body.code).toBe("PSF");
    co.PAS = pas.body.id;
    const hill = await admin.post("/companies", { name: "Hilal Müşavirlik" });
    expect(hill.body.code).toBeNull();
    co.HILL = hill.body.id;
    // Turkish-aware: "i" → "I", never "İ".
    const ibb = await admin.post("/companies", { name: "İstanbul BB", code: "ibb" });
    expect(ibb.body.code).toBe("IBB");
    co.IBB = ibb.body.id;

    expect((await admin.post("/companies", { name: "Kısa", code: "K" })).status).toBe(400);
    expect((await admin.post("/companies", { name: "Uzun", code: "ABCDEFGHI" })).status).toBe(400);
    expect((await admin.post("/companies", { name: "Tireli", code: "A-B" })).status).toBe(400);
    const dup = await admin.post("/companies", { name: "Başka", code: "psf" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain("Poyraz İnşaat");
    expect((await admin.post("/companies", { name: "Poyraz İnşaat" })).status).toBe(409);

    // Edit: set, clash, clear.
    expect((await admin.patch(`/companies/${co.IBB}`, { code: "PSF" })).status).toBe(409);
    expect((await admin.patch(`/companies/${co.IBB}`, { code: "" })).body.code).toBeNull();
    expect((await admin.patch(`/companies/${co.IBB}`, { code: "ibb1" })).body.code).toBe("IBB1");
    expect((await admin.patch(`/companies/${co.IBB}`, { name: "İBB" })).body).toMatchObject({ name: "İBB", code: "IBB1" });

    await admin.post("/users", { email: "pelin@7d.test", name: "Pelin", password: PW, companyId: co.PAS });
    pelin = api(await login("pelin@7d.test"));
    expect((await pelin.patch(`/companies/${co.HILL}`, { code: "HLL" })).status).toBe(403);
    const list = (await pelin.get("/companies")).body as { name: string; code: string | null }[];
    expect(list.find((c) => c.name === "Poyraz İnşaat")?.code).toBe("PSF");
  });

  it.skipIf(!hasManage)("numbers works with company codes, name-derived codes and the project code", async () => {
    const p = await admin.post("/projects", { code: "CC1", name: "Kod testi" });
    expect(p.status).toBe(200);
    const P = `/projects/${p.body.id}`;
    expect((await admin.post(`${P}/members`, { email: "pelin@7d.test" })).status).toBe(200);

    // Sender with a code, receiver without one → its code comes from the name (ASCII, no "İ").
    const a = await pelin.post(`${P}/works`, { typeKey: "giden-yazi", title: "Hilal'e", toCompanyIds: [co.HILL] });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.number).toBe(`CC1-PSF-HILALMUSAVIR-${YEAR}-0001`);
    // Receiver with a code.
    const b = await pelin.post(`${P}/works`, { typeKey: "giden-yazi", title: "İBB'ye", toCompanyIds: [co.IBB] });
    expect(b.body.number).toBe(`CC1-PSF-IBB1-${YEAR}-0001`);
    // Once the receiver gets a code, new numbers use it (and start their own counter).
    await admin.patch(`/companies/${co.HILL}`, { code: "HLL" });
    const c = await pelin.post(`${P}/works`, { typeKey: "giden-yazi", title: "Yine Hilal'e", toCompanyIds: [co.HILL] });
    expect(c.body.number).toBe(`CC1-PSF-HLL-${YEAR}-0001`);
    // A sender without a company: the project code instead of "X".
    const d = await admin.post(`${P}/works`, { typeKey: "giden-yazi", title: "Yöneticiden", toCompanyIds: [co.HILL] });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.number).toBe(`CC1-CC1-HLL-${YEAR}-0001`);
    // {Tip} is upper case ASCII: "giden-yazi" → "GIDEN-YAZI", not "GİDEN-YAZİ".
    const types = (await admin.get(`${P}/work-types`)).body as { id: string; key: string; numberingPattern: string }[];
    const giden = types.find((t) => t.key === "giden-yazi")!;
    const upd = await admin.put(`${P}/work-types/${giden.id}`, { numberingPattern: "{Tip}-{Gönderen}-{000}" });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    const e = await pelin.post(`${P}/works`, { typeKey: "giden-yazi", title: "Tipli", toCompanyIds: [co.HILL] });
    expect(e.body.number).toBe("GIDEN-YAZI-PSF-001");
  });

  it("defaults template slot codes to the company code", async () => {
    const r = await admin.post("/projects/from-template", {
      code: "CC2",
      name: "Şablon kodları",
      templateId: "bina-veri-merkezi",
      // Poyraz has code PSF (template default PAS); Hilal now HLL; İBB has IBB1 but the typed code wins.
      slotCompanies: { yuklenici: co.PAS, musavir: co.HILL, idare: co.IBB },
      slotCodes: { idare: "IDR" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const std = (await admin.get(`/projects/${r.body.id}/naming-standards`)).body[0].definition;
    // Unmapped "tasarimci" keeps the template default (CNS).
    expect(std.fields[1].values.map((v: { code: string }) => v.code)).toEqual(["PSF", "CNS", "HLL", "IDR"]);
  });
});
