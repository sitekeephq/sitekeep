/**
 * Online licensing (docs/onprem/licensing-online.md): the activation key, the signed reply of the licensing
 * service, activation and refresh against a stand-in service that behaves as the contract says (Worker +
 * Odoo), revocation and `online: required` bringing the dates forward, and the Privacy Centre connection.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { parseLicenceReply, type LicensePayload } from "../../src/license/format.js";
import { licensingUrls, normaliseKey } from "../../src/license/online.js";
import { computeLicense, NO_ONLINE } from "../../src/license/state.js";
import { parseLicense } from "../../src/license/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const devKey = createPrivateKey(readFileSync(path.join(here, "../fixtures/license/dev-private.pem")));
const DAY = 86_400_000;
const PW = "Lisans-Online-Parola-1";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
function signed<F extends string>(format: F, payload: unknown, kid = "dev") {
  const encoded = b64(payload);
  return { format, version: 1 as const, kid, payload: encoded, signature: sign(null, Buffer.from(encoded, "utf8"), devKey).toString("base64url") };
}
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function licencePayload(p: Partial<LicensePayload> & { installation: string }): LicensePayload {
  return {
    lid: "LIC-2026-0042",
    customer: { id: "odoo-1187", name: "Example Construction Ltd." },
    edition: "enterprise",
    plan: "plus",
    seats: 50,
    modules: ["manage", "field", "coordinate", "connect", "platform", "planning", "cost", "ai"],
    issuedAt: iso(-1),
    validFrom: iso(-1),
    validUntil: iso(365),
    supportUntil: iso(365),
    graceDays: 30,
    online: "optional",
    hardware: [],
    notes: null,
    ...p,
  };
}

describe("activation key", () => {
  it("accepts the canonical key in any spelling, TRIAL, and nothing else", () => {
    expect(normaliseKey("SK-7KQ2-MZ4P-X9HW-3TRB")).toBe("SK-7KQ2-MZ4P-X9HW-3TRB");
    expect(normaliseKey(" sk 7kq2mz4p x9hw-3trb ")).toBe("SK-7KQ2-MZ4P-X9HW-3TRB");
    expect(normaliseKey("7KQ2MZ4PX9HW3TRB")).toBe("SK-7KQ2-MZ4P-X9HW-3TRB");
    expect(normaliseKey("trial")).toBe("TRIAL");
    expect(normaliseKey("SK-7KQ2-MZ4P-X9HW-3TR")).toBeNull(); // too short
    expect(normaliseKey("SK-7KQ2-MZ4P-X9HW-3TR0")).toBeNull(); // 0 is not in the alphabet
    expect(normaliseKey("AEC-7KQ2-MZ4P-X9HW-3TRB")).toBeNull();
  });

  it("uses the licensing service and its fallback unless SITEKEEP_LICENSING_URL replaces them", () => {
    expect(licensingUrls(undefined)).toEqual(["https://licensing.sitekeep.org", "https://sk-licensing.aecpilot.workers.dev"]);
    expect(licensingUrls("http://127.0.0.1:9/, http://b.test")).toEqual(["http://127.0.0.1:9", "http://b.test"]);
  });
});

describe("signed reply", () => {
  it("accepts a reply recorded from the live service (worker-2026-12, 22.11.2026)", () => {
    // POST https://licensing.sitekeep.org/cde/v1/refresh for an unknown licence.
    const live = JSON.stringify({
      format: "sitekeep-licence-reply",
      version: 1,
      kid: "worker-2026-12",
      payload:
        "eyJzdGF0dXMiOiJpbnZhbGlkIiwicmVhc29uIjoibm90X2ZvdW5kIiwibm9uY2UiOiJlMDBkOTNjNzljYTVhZTYxZjE1M2I0ZTIiLCJpbnN0YWxsYXRpb24iOiJpbnN0X3Byb2JlX2I0YzA5MjQxY2NiNSIsInNlcnZlclRpbWUiOiIyMDI2LTExLTIyVDExOjEyOjAzWiIsImxpY2VuY2UiOm51bGx9",
      signature: "HY_2lil2gUIO6jpV55QY1_p6WinmP8mFE984TxDKNAVS4aFvmuM24YS8gWE01SVnGyvSlfKxah9TacSBOjCOAQ",
    });
    const expected = { nonce: "e00d93c79ca5ae61f153b4e2", installation: "inst_probe_b4c09241ccb5" };
    expect(parseLicenceReply(live, expected, { production: true })).toMatchObject({ ok: true, status: "invalid", reason: "not_found" });
    expect(parseLicenceReply(live, { ...expected, nonce: "other" }, { production: true })).toEqual({ ok: false, reason: "mismatch" });
  });

  const expectFor = { nonce: "n1", installation: "inst_a" };
  const reply = (p: Record<string, unknown>, kid?: string) => JSON.stringify(signed("sitekeep-licence-reply", { nonce: "n1", installation: "inst_a", reason: null, licence: null, ...p }, kid));

  it("reads valid, unchanged and invalid replies", () => {
    const licence = signed("sitekeep-license", licencePayload({ installation: "inst_a" }));
    const valid = parseLicenceReply(reply({ status: "valid", licence }), expectFor, { production: false });
    expect(valid).toMatchObject({ ok: true, status: "valid", notice: null });
    expect(valid.ok && valid.status === "valid" && parseLicense(valid.licence, { production: false }).ok).toBe(true);
    expect(parseLicenceReply(reply({ status: "unchanged" }), expectFor, { production: false })).toMatchObject({ ok: true, status: "unchanged" });
    expect(parseLicenceReply(reply({ status: "invalid", reason: "revoked" }), expectFor, { production: false })).toMatchObject({ ok: true, status: "invalid", reason: "revoked" });
  });

  it("refuses replies for another request or installation, unsigned, changed or with an unknown key", () => {
    expect(parseLicenceReply(reply({ status: "unchanged", nonce: "other" }), expectFor, { production: false })).toEqual({ ok: false, reason: "mismatch" });
    expect(parseLicenceReply(reply({ status: "unchanged", installation: "inst_b" }), expectFor, { production: false })).toEqual({ ok: false, reason: "mismatch" });
    expect(parseLicenceReply(reply({ status: "unchanged" }, "worker-2099-01"), expectFor, { production: false })).toEqual({ ok: false, reason: "unknown_key" });
    const tampered = JSON.parse(reply({ status: "invalid", reason: "revoked" }));
    tampered.payload = b64({ status: "valid", nonce: "n1", installation: "inst_a", licence: null });
    expect(parseLicenceReply(JSON.stringify(tampered), expectFor, { production: false })).toEqual({ ok: false, reason: "signature" });
    expect(parseLicenceReply('{"status":"valid"}', expectFor, { production: false })).toEqual({ ok: false, reason: "format" });
    expect(parseLicenceReply(reply({ status: "valid" }), expectFor, { production: false })).toEqual({ ok: false, reason: "payload" });
  });
});

describe("online state brings dates forward", () => {
  const parsed = (p: Partial<LicensePayload>) => parseLicense(JSON.stringify(signed("sitekeep-license", licencePayload({ installation: "inst_a", ...p }))), { production: false });
  const at = (d: number) => Date.now() + d * DAY;

  it("a revoked licence enters its grace period from the revocation, not at once", () => {
    const revokedAt = new Date(at(-5)).toISOString();
    const v = computeLicense({ installationId: "inst_a", parsed: parsed({}), maxSeenAt: 0, online: { ...NO_ONLINE, activated: true, revokedAt } }, at(0), undefined, 1);
    expect(v).toMatchObject({ status: "grace", onlineProblem: "revoked" });
    expect(Date.parse(v.readOnlyAt!)).toBe(Date.parse(revokedAt) + 30 * DAY);
    const later = computeLicense({ installationId: "inst_a", parsed: parsed({}), maxSeenAt: 0, online: { ...NO_ONLINE, activated: true, revokedAt } }, at(26), undefined, 1);
    expect(later.status).toBe("read_only");
  });

  it("online: required turns to grace after 30 days without an answer and read-only 14 days later", () => {
    const lastOkAt = new Date(at(-10)).toISOString();
    const input = (d: number) => computeLicense({ installationId: "inst_a", parsed: parsed({ online: "required", issuedAt: iso(-40) }), maxSeenAt: 0, online: { ...NO_ONLINE, activated: true, lastOkAt } }, at(d), undefined, 1);
    expect(input(0)).toMatchObject({ status: "expiring", onlineProblem: null }); // 20 days left
    expect(input(21)).toMatchObject({ status: "grace", onlineProblem: "offline_too_long" });
    expect(input(35).status).toBe("read_only");
    // optional licences do not care how long the service was away
    const optional = computeLicense({ installationId: "inst_a", parsed: parsed({ issuedAt: iso(-200) }), maxSeenAt: 0, online: { ...NO_ONLINE, activated: true, lastOkAt: iso(-200) } }, at(0), undefined, 1);
    expect(optional).toMatchObject({ status: "active", onlineProblem: null });
  });
});

/**
 * Stand-in for the Worker + Odoo (licensing-online.md §4–5): one licence record per key, bound to the first
 * installation that activates it; replies signed with the development key.
 */
interface Record_ {
  key: string;
  installation: string | null;
  revoked: boolean;
  issuedAt: string;
  seats: number | null;
  validUntil: string;
}
class FakeService {
  records = new Map<string, Record_>();
  trials = new Set<string>();
  requests: { route: string; body: Record<string, unknown> }[] = [];
  /** Reply with this HTTP status instead (unreachable). */
  failWith: number | null = null;
  /** Sign the reply for another nonce (replay). */
  wrongNonce = false;
  server!: Server;
  url = "";

  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        const route = (req.url ?? "").replace("/cde/v1/", "");
        this.requests.push({ route, body });
        if (this.failWith) {
          res.writeHead(this.failWith).end("down");
          return;
        }
        const out = this.handle(route, body);
        const reply = signed("sitekeep-licence-reply", {
          ...out,
          nonce: this.wrongNonce ? "replayed" : body.nonce,
          installation: body.installation,
          serverTime: new Date().toISOString(),
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  licence(r: Record_, installation: string, trial = false) {
    return signed(
      "sitekeep-license",
      licencePayload({
        installation,
        issuedAt: r.issuedAt,
        seats: r.seats,
        validUntil: r.validUntil,
        supportUntil: r.validUntil,
        ...(trial && { edition: "trial", plan: "trial", seats: 10, graceDays: 0, lid: `TRIAL-${installation.slice(-6)}` }),
      }),
    );
  }

  handle(route: string, body: Record<string, unknown>): Record<string, unknown> {
    const installation = String(body.installation);
    if (route === "activate" && body.key === "TRIAL") {
      if (this.trials.has(installation)) return { status: "invalid", reason: "trial_used", licence: null };
      this.trials.add(installation);
      const r: Record_ = { key: "TRIAL", installation, revoked: false, issuedAt: new Date().toISOString(), seats: 10, validUntil: iso(30) };
      return { status: "valid", reason: null, licence: this.licence(r, installation, true) };
    }
    const r = route === "activate" ? this.records.get(String(body.key)) : [...this.records.values()].find((x) => x.installation === installation);
    if (!r) return { status: "invalid", reason: "not_found", licence: null };
    if (r.revoked) return { status: "invalid", reason: "revoked", licence: null };
    if (r.installation && r.installation !== installation) return { status: "invalid", reason: "bound_to_other_installation", licence: null };
    r.installation = installation;
    if (route === "refresh" && body.have === r.issuedAt) return { status: "unchanged", reason: null, licence: null };
    return { status: "valid", reason: null, licence: this.licence(r, installation) };
  }
}

describe("Administration → Licence online", () => {
  let dataDir: string;
  let handle: DbHandle;
  let app: FastifyInstance;
  let admin: string;
  const service = new FakeService();
  const KEY = "SK-7KQ2-MZ4P-X9HW-3TRB";
  const call = async (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload !== undefined && { payload: payload as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  beforeAll(async () => {
    await service.start();
    process.env.SITEKEEP_LICENSING_URL = service.url;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-license-online-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), devTools: false });
    await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
    admin = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  });

  beforeEach(() => {
    service.failWith = null;
    service.wrongNonce = false;
  });

  afterAll(async () => {
    delete process.env.SITEKEEP_LICENSING_URL;
    await app.close();
    await handle.close();
    await new Promise((r) => service.server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a malformed or unknown key and says when the service cannot be reached", async () => {
    expect(await call("POST", "/admin/license/activate", { key: "not a key" })).toMatchObject({ status: 400, body: { error: "license_key_format" } });
    expect(await call("POST", "/admin/license/activate", { key: KEY })).toMatchObject({ status: 400, body: { error: "license_not_found" } });
    service.failWith = 503;
    expect(await call("POST", "/admin/license/activate", { key: KEY })).toMatchObject({ status: 502, body: { error: "license_unreachable" } });
    service.failWith = null;
    service.records.set(KEY, { key: KEY, installation: null, revoked: false, issuedAt: iso(-1), seats: 5, validUntil: iso(365) });
    service.wrongNonce = true; // a recorded reply for another request
    expect(await call("POST", "/admin/license/activate", { key: KEY })).toMatchObject({ status: 502, body: { error: "license_unreachable" } });
    expect((await call("GET", "/admin/license")).body.license).toBeNull();
  });

  it("activates a key: sends only ids, version and counts, stores the licence, binds the installation", async () => {
    const r = await call("POST", "/admin/license/activate", { key: " sk-7kq2-mz4p-x9hw-3trb " });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      status: "active",
      license: { lid: "LIC-2026-0042", plan: "plus", seats: 5 },
      online: { activated: true, refreshes: true, lastResult: "valid" },
    });
    const sent = service.requests.at(-1)!;
    expect(sent.route).toBe("activate");
    expect(Object.keys(sent.body).sort()).toEqual(["buildDate", "counts", "hardware", "installation", "key", "nonce", "version"]);
    expect(sent.body).toMatchObject({ key: KEY, installation: r.body.installationId, counts: { users: 1 } });
    expect(service.records.get(KEY)!.installation).toBe(r.body.installationId);
  });

  it("refresh: unchanged, then a renewed licence replaces the stored one", async () => {
    const same = await call("POST", "/admin/license/refresh");
    expect(same.body.online).toMatchObject({ lastResult: "unchanged", revokedAt: null });
    expect(service.requests.at(-1)!.body).toMatchObject({ lid: "LIC-2026-0042" });

    const rec = service.records.get(KEY)!;
    rec.seats = 8;
    rec.issuedAt = new Date().toISOString();
    rec.validUntil = iso(730);
    const renewed = await call("POST", "/admin/license/refresh");
    expect(renewed.body).toMatchObject({ license: { seats: 8 }, online: { lastResult: "valid" } });
  });

  it("a revoked licence starts the grace period; the service coming back clears it; unreachable changes nothing", async () => {
    service.failWith = 500;
    const down = await call("POST", "/admin/license/refresh");
    expect(down).toMatchObject({ status: 502, body: { error: "license_unreachable" } });
    expect((await call("GET", "/admin/license")).body).toMatchObject({ status: "active", license: { seats: 8 }, online: { lastResult: "unreachable" } });
    service.failWith = null;

    service.records.get(KEY)!.revoked = true;
    const revoked = await call("POST", "/admin/license/refresh");
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: "grace", onlineProblem: "revoked", online: { lastResult: "invalid", lastReason: "revoked" } });

    service.records.get(KEY)!.revoked = false;
    const back = await call("POST", "/admin/license/refresh");
    expect(back.body).toMatchObject({ status: "active", onlineProblem: null, online: { revokedAt: null } });
  });

  it("the key cannot be used on a second installation", () => {
    expect(service.handle("activate", { key: KEY, installation: "inst_other" })).toMatchObject({ status: "invalid", reason: "bound_to_other_installation" });
  });

  it("lists the connection in the Privacy Centre; switching it off stops the calls", async () => {
    // (The kill switch stops it too for the real service; this stand-in runs on 127.0.0.1, which the kill switch leaves alone.)
    const list = await call("GET", "/admin/privacy/connections");
    const conn = (list.body as { id: string; kind: string; enabled: boolean }[]).find((c) => c.id === "license");
    expect(conn).toMatchObject({ kind: "license", enabled: true });
    expect((await call("PUT", "/admin/privacy/connections/license", { enabled: false })).status).toBe(200);
    const before = service.requests.length;
    expect(await call("POST", "/admin/license/refresh")).toMatchObject({ status: 502, body: { error: "license_unreachable" } });
    expect(service.requests.length).toBe(before);
    expect((await call("PUT", "/admin/privacy/connections/license", { enabled: true })).status).toBe(200);
  });

  it("a licence file uploaded by hand ends online refresh; removing the licence clears the online state", async () => {
    const inst = (await call("GET", "/admin/license")).body.installationId as string;
    const file = JSON.stringify(signed("sitekeep-license", licencePayload({ installation: inst, lid: "LIC-FILE-1" })));
    const up = await call("PUT", "/admin/license", { file });
    expect(up.body).toMatchObject({ license: { lid: "LIC-FILE-1" }, online: { activated: false, refreshes: false } });
    expect(await call("POST", "/admin/license/refresh")).toMatchObject({ status: 400, body: { error: "license_not_online" } });
    const gone = await call("DELETE", "/admin/license");
    expect(gone.body).toMatchObject({ status: "none", online: { activated: false, lastCheckAt: null } });
  });

  it("a trial once per installation", async () => {
    const t = await call("POST", "/admin/license/activate", { key: "trial" });
    expect(t.body).toMatchObject({ license: { edition: "trial", plan: "trial", seats: 10 } });
    await call("DELETE", "/admin/license");
    expect(await call("POST", "/admin/license/activate", { key: "TRIAL" })).toMatchObject({ status: 400, body: { error: "license_trial_used" } });
  });
});
