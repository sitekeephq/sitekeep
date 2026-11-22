// Privacy notice on the sign-in and invitation pages (docs/features/PRIVACY_NOTICE.md, issue #85 P3)
// and the RFC 9116 security.txt (SECURITY.md).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, privacyNoticeAcceptances, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { securityTxt, securityTxtExpiry } from "../../src/privacy/security-txt.js";

const PW = "Sifre-1234567";

interface Ctx {
  app: FastifyInstance;
  handle: DbHandle;
  dir: string;
}

let c: Ctx;

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "7dcde-notice-"));
  const handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  const app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    oauth: { publicUrl: "https://cde.example.test" },
    googleAuth: { clientId: "google-client", clientSecret: "google-secret", callbackUrl: "http://localhost/api/v1/auth/google/callback" },
  });
  const passwordHash = await hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@7d.test", name: "Admin Person", passwordHash, isAdmin: true },
    { email: "member@7d.test", name: "Member Person", passwordHash },
  ]);
  c = { app, handle, dir };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await c.app.close();
  await c.handle.close();
  rmSync(c.dir, { recursive: true, force: true });
});

type Res = { status: number; body: any; cookies: { name: string; value: string }[]; headers: Record<string, unknown> };

async function call(method: string, url: string, opts: { payload?: unknown; cookie?: string } = {}): Promise<Res> {
  const res = await c.app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), "accept-language": "en" },
    payload: (opts.payload ?? (method === "GET" ? undefined : {})) as object,
  });
  return { status: res.statusCode, body: res.body ? res.json() : null, cookies: res.cookies, headers: res.headers };
}

const session = (res: Res) => `cde_session=${res.cookies.find((k) => k.name === "cde_session" && k.value)!.value}`;
const login = (email: string, privacyNoticeVersion?: number, password = PW) =>
  call("POST", "/auth/login", { payload: { email, password, ...(privacyNoticeVersion !== undefined && { privacyNoticeVersion }) } });

async function adminCookie(): Promise<string> {
  const res = await login("admin@7d.test");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return session(res);
}

const audits = async (action: string) => c.handle.db.select().from(auditLog).where(eq(auditLog.action, action));
const acceptances = async () => c.handle.db.select().from(privacyNoticeAcceptances);

describe("privacy notice settings (Privacy Centre)", () => {
  it("is off by default; only a system administrator changes it; a changed text is a new version, recorded with its text", async () => {
    expect((await call("GET", "/auth/privacy-notice")).body).toMatchObject({ enabled: false, requireAck: false, version: 0 });
    const admin = await adminCookie();
    const member = session(await login("member@7d.test"));
    expect((await call("GET", "/admin/privacy/notice", { cookie: member })).status).toBe(403);
    expect((await call("PUT", "/admin/privacy/notice", { cookie: member, payload: { enabled: true } })).status).toBe(403);

    // Showing an empty notice is refused.
    expect((await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { enabled: true } })).status).toBe(400);

    const saved = await call("PUT", "/admin/privacy/notice", {
      cookie: admin,
      payload: { enabled: true, text: { en: "We process your **e-mail**.", tr: "E-posta adresinizi işleriz." } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, requireAck: false, reaskOnChange: true, version: 1, updatedByName: "Admin Person", acceptedCurrent: 0 });
    expect((await call("GET", "/auth/privacy-notice")).body).toEqual({
      enabled: true,
      requireAck: false,
      version: 1,
      text: { en: "We process your **e-mail**.", tr: "E-posta adresinizi işleriz." },
    });

    // Switches alone keep the version; a new text bumps it.
    expect((await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { requireAck: true } })).body.version).toBe(1);
    expect((await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { text: { tr: "Yeni metin." } } })).body).toMatchObject({
      version: 2,
      text: { en: "We process your **e-mail**.", tr: "Yeni metin." },
    });

    const rows = await audits("privacy.notice_updated");
    expect(rows.map((r) => r.details)).toEqual([
      expect.objectContaining({ version: 1, textChanged: true, text: { en: "We process your **e-mail**.", tr: "E-posta adresinizi işleriz." } }),
      expect.not.objectContaining({ text: expect.anything() }),
      expect.objectContaining({ version: 2, textChanged: true, requireAck: true, text: { en: "We process your **e-mail**.", tr: "Yeni metin." } }),
    ]);
  });
});

describe("\"I have read it\" before sign-in", () => {
  async function requireAck(reaskOnChange = true) {
    const admin = await adminCookie();
    const res = await call("PUT", "/admin/privacy/notice", {
      cookie: admin,
      payload: { enabled: true, requireAck: true, reaskOnChange, text: { en: "Notice v1", tr: "" } },
    });
    expect(res.status).toBe(200);
    return admin;
  }

  it("refuses a sign-in without the ticked version, records the acceptance once, and asks again after a new version", async () => {
    const admin = await requireAck();
    const refused = await login("member@7d.test");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("privacy_notice_required");
    // An old version does not count.
    expect((await login("member@7d.test", 99)).body.error).toBe("privacy_notice_required");
    // A wrong password stays a wrong password: the notice says nothing about the account.
    expect((await login("member@7d.test", undefined, "wrong-password-1")).status).toBe(401);

    const ok = await login("member@7d.test", 1);
    expect(ok.status).toBe(200);
    const [member] = await c.handle.db.select().from(users).where(eq(users.email, "member@7d.test"));
    expect(await acceptances()).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: member!.id, version: 1, via: "password" })]),
    );
    const accepted = await audits("privacy.notice_accepted");
    expect(accepted.filter((r) => r.userId === member!.id).map((r) => r.details)).toEqual([{ version: 1, via: "password" }]);

    // Accepted once: later sign-ins (scripts, other browsers) need not send it; sending it again records nothing new.
    expect((await login("member@7d.test")).status).toBe(200);
    expect((await login("member@7d.test", 1)).status).toBe(200);
    expect((await audits("privacy.notice_accepted")).filter((r) => r.userId === member!.id)).toHaveLength(1);
    expect((await call("GET", "/admin/privacy/notice", { cookie: admin })).body.acceptedCurrent).toBeGreaterThanOrEqual(1);

    // A new text with "ask again": version 2 must be accepted.
    expect((await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { text: { en: "Notice v2" } } })).body.version).toBe(2);
    expect((await login("member@7d.test")).body.error).toBe("privacy_notice_required");
    expect((await login("member@7d.test", 2)).status).toBe(200);
  });

  it("with \"ask again\" off, an earlier acceptance is enough after the text changes", async () => {
    const admin = await requireAck(false);
    expect((await login("member@7d.test", 1)).status).toBe(200);
    await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { text: { en: "Notice v2" } } });
    expect((await login("member@7d.test")).status).toBe(200);
  });

  it("shown without the checkbox, a sign-in needs nothing and nothing is recorded", async () => {
    const admin = await adminCookie();
    await call("PUT", "/admin/privacy/notice", { cookie: admin, payload: { enabled: true, text: { en: "Just read me", tr: "" } } });
    expect((await login("member@7d.test")).status).toBe(200);
    expect((await login("member@7d.test", 1)).status).toBe(200);
    expect(await acceptances()).toEqual([]);
  });

  it("an invitation is accepted only with the ticked version", async () => {
    const admin = await requireAck();
    const pid = (await call("POST", "/projects", { cookie: admin, payload: { code: "PN", name: "Notice Project" } })).body.id;
    const invited = await call("POST", `/projects/${pid}/invitations`, { cookie: admin, payload: { email: "guest@example.com" } });
    expect(invited.status).toBe(200);
    const token = String(invited.body.invitation.url).split("#")[1];
    const body = { token, name: "Guest Person", password: "Kabul-12345678" };
    const refused = await call("POST", "/invitations/accept", { payload: body });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("privacy_notice_required");
    // Nothing happened: the invitation is still open.
    expect((await call("POST", "/invitations/lookup", { payload: { token } })).status).toBe(200);

    const ok = await call("POST", "/invitations/accept", { payload: { ...body, privacyNoticeVersion: 1 } });
    expect(ok.status).toBe(200);
    expect(await acceptances()).toEqual(expect.arrayContaining([expect.objectContaining({ userId: ok.body.id, version: 1, via: "invitation" })]));
  });

  it("Google sign-in carries the ticked version through the redirect; without it the callback refuses", async () => {
    await requireAck();
    const google = async (query: string) => {
      const start = await c.app.inject({ method: "GET", url: `/api/v1/auth/google${query}` });
      expect(start.statusCode).toBe(302);
      const cookies = start.cookies.filter((k) => k.value).map((k) => `${k.name}=${k.value}`).join("; ");
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ email: "member@7d.test", email_verified: true }), { status: 200 }));
      const callback = await c.app.inject({
        method: "GET",
        url: `/api/v1/auth/google/callback?code=code&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookies },
      });
      vi.restoreAllMocks();
      return callback;
    };
    const refused = await google("");
    expect(refused.headers.location).toBe("/login?authError=privacy_notice_required");
    expect(refused.cookies.some((k) => k.name === "cde_session" && k.value)).toBe(false);

    const ok = await google("?notice=1");
    expect(ok.headers.location).toBe("/");
    expect(ok.cookies.some((k) => k.name === "cde_session" && k.value)).toBe(true);
    expect(await acceptances()).toEqual(expect.arrayContaining([expect.objectContaining({ version: 1, via: "google" })]));
  });
});

describe("security.txt (RFC 9116)", () => {
  it("serves contact, expiry, policy, languages and the canonical address", async () => {
    const res = await c.app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    const fields = res.body
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]);
    expect(fields).toEqual([
      ["Contact", "mailto:support@sitekeep.org"],
      ["Contact", "https://github.com/sitekeephq/sitekeep/security/advisories/new"],
      ["Expires", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)],
      ["Policy", "https://github.com/sitekeephq/sitekeep/blob/main/SECURITY.md"],
      ["Preferred-Languages", "en, tr"],
      ["Canonical", "https://cde.example.test/.well-known/security.txt"],
    ]);
    // In the future, and less than a year away (RFC 9116 §2.5.5).
    const expires = new Date(fields.find(([k]) => k === "Expires")![1]!).getTime();
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThan(366 * 24 * 3600 * 1000);
  });

  it("computes the expiry from the day it is served; no Canonical without a public address", () => {
    expect(securityTxtExpiry(new Date("2026-11-16T15:30:00Z")).toISOString()).toBe("2027-11-15T00:00:00.000Z");
    expect(securityTxtExpiry(new Date("2028-02-29T10:00:00Z")).toISOString()).toBe("2029-02-28T00:00:00.000Z");
    expect(securityTxt({ now: new Date("2026-11-16T00:00:00Z") })).not.toMatch(/Canonical/);
  });
});
