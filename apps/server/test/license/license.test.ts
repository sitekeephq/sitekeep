/**
 * Licences (docs/onprem/lisanslama.md, src/license): the file and its signature, the status over time,
 * Yönetim → Lisans, and enforcement (SITEKEEP_LICENSE_ENFORCE=1): modules follow the licence, a lapsed
 * licence leaves its modules read-only, SiteKeep Community without a licence is never limited.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { sign, createPrivateKey } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { loadedModules } from "../../src/app/modules.js";
import { editionName, moduleIds } from "../../src/app/module-ids.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { parseLicense, type LicensePayload } from "../../src/license/format.js";
import { computeLicense, currentLicense, licenseEnforced } from "../../src/license/state.js";
import { capability } from "../../src/sdk/capabilities.js";
import { hasCost, hasPlanning } from "../helpers/modules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const devKey = createPrivateKey(readFileSync(path.join(here, "../fixtures/license/dev-private.pem")));
const DAY = 86_400_000;
const PW = "Lisans-Test-Parola-1";

function licenseFile(p: Partial<LicensePayload> & { installation: string }, opts: { kid?: string; tamper?: boolean } = {}): string {
  const payload: LicensePayload = {
    lid: "LIC-TEST-0001",
    customer: { id: "odoo-1", name: "Poyraz İnşaat" },
    edition: "enterprise",
    seats: null,
    modules: ["cost"],
    issuedAt: new Date(Date.now() - DAY).toISOString(),
    validFrom: new Date(Date.now() - DAY).toISOString(),
    validUntil: new Date(Date.now() + 365 * DAY).toISOString(),
    supportUntil: new Date(Date.now() + 365 * DAY).toISOString(),
    graceDays: 30,
    online: "optional",
    hardware: [],
    notes: null,
    ...p,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  let signature = sign(null, Buffer.from(encoded, "utf8"), devKey).toString("base64url");
  if (opts.tamper) signature = signature.slice(0, -4) + (signature.endsWith("AAAA") ? "BBBB" : "AAAA");
  return JSON.stringify({ format: "sitekeep-license", version: 1, kid: opts.kid ?? "dev", payload: encoded, signature });
}

describe("licence file", () => {
  it("verifies the signature and reads the payload", () => {
    const r = parseLicense(licenseFile({ installation: "*" }), { production: false });
    expect(r.ok && r.payload.modules).toEqual(["cost"]);
  });

  it("refuses changed files, unknown keys, other formats and the development key in production", () => {
    expect(parseLicense(licenseFile({ installation: "*" }, { tamper: true }), { production: false })).toEqual({ ok: false, reason: "signature" });
    expect(parseLicense(licenseFile({ installation: "*" }, { kid: "2099-01" }), { production: false })).toEqual({ ok: false, reason: "unknown_key" });
    expect(parseLicense(licenseFile({ installation: "*" }), { production: true })).toEqual({ ok: false, reason: "dev_key_in_production" });
    expect(parseLicense("not json", { production: false })).toEqual({ ok: false, reason: "format" });
    const file = JSON.parse(licenseFile({ installation: "*" }));
    expect(parseLicense(JSON.stringify({ ...file, payload: Buffer.from("{}").toString("base64url") }), { production: false }).ok).toBe(false);
  });
});

describe("licence status over time", () => {
  const at = (iso: string) => Date.parse(iso);
  const parsed = (p: Partial<LicensePayload>) => parseLicense(licenseFile({ installation: "inst_a", ...p }), { production: false });
  const status = (p: Partial<LicensePayload>, now: string, extra: { maxSeenAt?: number; build?: string } = {}) =>
    computeLicense({ installationId: "inst_a", parsed: parsed(p), maxSeenAt: extra.maxSeenAt ?? 0 }, at(now), extra.build);
  const year = { validFrom: "2027-01-01T00:00:00.000Z", validUntil: "2027-12-31T23:59:59.000Z", supportUntil: "2027-12-31T23:59:59.000Z" };

  it("walks from not yet valid through active, expiring and grace to read-only", () => {
    expect(status(year, "2026-12-20T00:00:00Z").status).toBe("not_yet");
    expect(status(year, "2027-06-01T00:00:00Z").status).toBe("active");
    expect(status(year, "2027-12-15T00:00:00Z")).toMatchObject({ status: "expiring", daysLeft: 17 });
    expect(status(year, "2028-01-10T00:00:00Z").status).toBe("grace");
    expect(status(year, "2028-02-15T00:00:00Z")).toMatchObject({ status: "read_only", readOnlyAt: "2028-01-30T23:59:59.000Z" });
    expect(status({ ...year, validUntil: null }, "2035-01-01T00:00:00Z").status).toBe("active");
  });

  it("does not apply to another installation or to builds after the support period", () => {
    expect(computeLicense({ installationId: "inst_b", parsed: parsed(year), maxSeenAt: 0 }, at("2027-06-01T00:00:00Z"))).toMatchObject({ status: "invalid", problem: "other_installation" });
    expect(status(year, "2027-06-01T00:00:00Z", { build: "2028-03-01T00:00:00Z" })).toMatchObject({ status: "invalid", problem: "build_after_support" });
    expect(computeLicense({ installationId: "inst_a", parsed: null, maxSeenAt: 0 }, Date.now()).status).toBe("none");
  });

  it("counts active accounts beyond the seats", () => {
    const p = parsed({ ...year, seats: 10 });
    expect(computeLicense({ installationId: "inst_a", parsed: p, maxSeenAt: 0 }, at("2027-06-01T00:00:00Z"), undefined, 10).seatsOver).toBe(0);
    expect(computeLicense({ installationId: "inst_a", parsed: p, maxSeenAt: 0 }, at("2027-06-01T00:00:00Z"), undefined, 13).seatsOver).toBe(3);
    expect(computeLicense({ installationId: "inst_a", parsed: parsed({ ...year, seats: null }), maxSeenAt: 0 }, at("2027-06-01T00:00:00Z"), undefined, 900).seatsOver).toBe(0);
  });

  it("decides by the latest time seen when the clock was turned back", () => {
    const v = status(year, "2027-06-01T00:00:00Z", { maxSeenAt: at("2028-02-15T00:00:00Z") });
    expect(v).toMatchObject({ clockBehind: true, status: "read_only" });
  });
});

describe("which installations check licences", () => {
  it("the Enterprise image checks them unless turned off; others only when asked", () => {
    const saved = { e: process.env.SITEKEEP_EDITION, f: process.env.SITEKEEP_LICENSE_ENFORCE };
    try {
      delete process.env.SITEKEEP_EDITION;
      delete process.env.SITEKEEP_LICENSE_ENFORCE;
      expect(licenseEnforced()).toBe(false);
      process.env.SITEKEEP_LICENSE_ENFORCE = "1";
      expect(licenseEnforced()).toBe(true);
      delete process.env.SITEKEEP_LICENSE_ENFORCE;
      process.env.SITEKEEP_EDITION = "enterprise";
      expect(licenseEnforced()).toBe(true);
      process.env.SITEKEEP_LICENSE_ENFORCE = "0";
      expect(licenseEnforced()).toBe(false);
      process.env.SITEKEEP_EDITION = "community";
      delete process.env.SITEKEEP_LICENSE_ENFORCE;
      expect(licenseEnforced()).toBe(false);
    } finally {
      if (saved.e === undefined) delete process.env.SITEKEEP_EDITION;
      else process.env.SITEKEEP_EDITION = saved.e;
      if (saved.f === undefined) delete process.env.SITEKEEP_LICENSE_ENFORCE;
      else process.env.SITEKEEP_LICENSE_ENFORCE = saved.f;
    }
  });
});

describe("Yönetim → Lisans and enforcement", () => {
  let dataDir: string;
  let handle: DbHandle;
  let app: FastifyInstance;
  let admin: string;
  let member: string;
  const call = async (cookie: string, method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-license-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), devTools: false });
    for (const [email, isAdmin] of [["admin@7d.test", true], ["uye@7d.test", false]] as const) {
      await handle.db.insert(users).values({ email, name: email, passwordHash: await hashPassword(PW), isAdmin });
    }
    admin = await login("admin@7d.test");
    member = await login("uye@7d.test");
  });

  afterAll(async () => {
    delete process.env.SITEKEEP_LICENSE_ENFORCE;
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows administrators the installation and installs, refuses and removes licences", async () => {
    expect((await call(member, "GET", "/admin/license")).status).toBe(403);
    const none = await call(admin, "GET", "/admin/license");
    expect(none.body).toMatchObject({ status: "none", license: null, enforced: false, seatsUsed: 2 });
    expect(none.body.installationId).toMatch(/^inst_/);

    const bad = await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation: none.body.installationId }, { tamper: true }) });
    expect(bad).toMatchObject({ status: 400, body: { error: "license_signature" } });
    const other = await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation: "inst_other" }) });
    expect(other).toMatchObject({ status: 400, body: { error: "license_other_installation" } });

    const ok = await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation: none.body.installationId, seats: 50 }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: "active", license: { lid: "LIC-TEST-0001", customer: "Poyraz İnşaat", seats: 50, modules: ["cost"] } });

    expect((await call(admin, "DELETE", "/admin/license")).body).toMatchObject({ status: "none", license: null });
  });

  it("an edition image never accepts the development key, whatever NODE_ENV says", async () => {
    const installation = currentLicense().installationId;
    process.env.SITEKEEP_EDITION = "enterprise";
    try {
      const r = await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation }) });
      expect(r).toMatchObject({ status: 400, body: { error: "license_dev_key_in_production" } });
    } finally {
      delete process.env.SITEKEEP_EDITION;
    }
  });

  it("without enforcement the licence changes nothing: modules follow the installed packages", () => {
    expect(moduleIds()).toEqual(loadedModules.map((m) => m.id));
  });

  it.runIf(hasCost && hasPlanning)("with enforcement, modules follow the licence; a lapsed licence leaves them read-only", async () => {
    const installation = currentLicense().installationId;
    const project = await call(admin, "POST", "/projects", { code: "LIS", name: "Lisans" });
    const pid = project.body.id as string;
    process.env.SITEKEEP_LICENSE_ENFORCE = "1";
    try {
      // No licence: SiteKeep Community. The core works, modules are off.
      expect(moduleIds()).toEqual([]);
      expect(editionName()).toBe("SiteKeep Community");
      expect((await call(admin, "GET", `/projects/${pid}/contracts`)).body).toMatchObject({ error: "module_off" });
      expect((await call(admin, "GET", `/projects/${pid}`)).status).toBe(200);
      const info = await app.inject({ method: "GET", url: "/api/v1/app-info" });
      expect(info.json()).toMatchObject({ edition: "SiteKeep Community", modules: [] });
      expect(capability("planning.schedules")).toBeUndefined();

      // Cost licensed: Cost on, Planning still off.
      await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation, modules: ["cost"] }) });
      expect(moduleIds()).toEqual(["cost"]);
      expect((await call(admin, "GET", `/projects/${pid}/contracts`)).status).toBe(200);
      expect(capability("planning.schedules")).toBeUndefined();

      // Lapsed beyond the grace days: Cost reads, writes are refused; the core is untouched.
      const old = (d: number) => new Date(Date.now() - d * DAY).toISOString();
      await call(admin, "PUT", "/admin/license", {
        file: licenseFile({ installation, modules: ["cost", "planning"], issuedAt: old(400), validFrom: old(400), validUntil: old(40), supportUntil: new Date(Date.now() + DAY).toISOString(), graceDays: 30 }),
      });
      expect(currentLicense().status).toBe("read_only");
      expect(capability("planning.schedules")).toBeDefined();
      expect((await call(admin, "GET", `/projects/${pid}/contracts`)).status).toBe(200);
      expect((await call(admin, "POST", `/projects/${pid}/contracts`, { code: "S-1", name: "Sözleşme" })).body).toMatchObject({ error: "license_read_only" });
      expect((await call(admin, "POST", "/projects", { code: "LIS2", name: "Çekirdek açık" })).status).toBe(200);

      // Seats: a valid licence for one user while two are active. Cost only reads; the core and new accounts are free.
      await call(admin, "PUT", "/admin/license", { file: licenseFile({ installation, modules: ["cost"], seats: 1 }) });
      const lic = await call(admin, "GET", "/admin/license");
      expect(lic.body).toMatchObject({ status: "active", seatsUsed: 2, seatsOver: 1 });
      expect((await call(admin, "POST", `/projects/${pid}/contracts`, { code: "S-2", name: "Sözleşme" })).body).toMatchObject({ error: "license_read_only" });
      expect((await call(admin, "POST", "/users", { email: "yeni@7d.test", name: "Yeni", password: PW })).status).toBe(200);
      expect((await call(admin, "GET", "/admin/license")).body.seatsOver).toBe(2);
    } finally {
      delete process.env.SITEKEEP_LICENSE_ENFORCE;
      await call(admin, "DELETE", "/admin/license");
    }
  });
});
