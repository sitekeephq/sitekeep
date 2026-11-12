/**
 * Privacy phase 1 (docs/features/PRIVACY.md): security headers, the outbound registry and its log, the
 * Gizlilik Merkezi API, the kill switch and AI data minimisation. No real network: fetch is mocked.
 */
import { hasAi } from "../helpers/modules.js"; // AI steps run when the AI module is installed
import { render } from "../../src/i18n/index.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { isExternalUrl } from "../../src/ai/hosts.js";
import { AiError, resolveProvider } from "../../src/ai/provider.js";
// The AI module's internals load only when it is installed (a Community install has none).
const AI_PROVIDER = "@7dimensions-project/sitekeep-ee-ai/internal/provider.js";
const { createProvider } = hasAi ? await import(AI_PROVIDER) : ({} as Record<string, never>);
import { getAiTaskQueueSettings } from "../../src/ai/settings.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { companies, outboundLog, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { buildCsp } from "../../src/privacy/headers.js";
import { OutboundBlockedError, cleanupOutboundLog, outboundCall, outboundFetch } from "../../src/privacy/outbound.js";
import { Redactor, isValidTckn, redactText } from "../../src/privacy/redact.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const PW = "Sifre-1234567";
const SECRET_KEY = Buffer.alloc(32, 9);
const here = path.dirname(fileURLToPath(import.meta.url));

let handle: DbHandle;
let htmlHandle: DbHandle;
let app: FastifyInstance;
let htmlApp: FastifyInstance;
let dataDir: string;
let cookie: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-privacy-test-"));
  // App serving a built web app (index.html with a script tag) and a configured office editor.
  const webDist = path.join(dataDir, "web");
  mkdirSync(path.join(webDist, "assets"), { recursive: true });
  writeFileSync(path.join(webDist, "index.html"), `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>`);
  writeFileSync(path.join(webDist, "assets", "index-abc.js"), "console.log(1)");
  htmlHandle = await openDb("memory://");
  const htmlStorage = new LocalStorage(path.join(dataDir, "storage-html"));
  htmlApp = await buildApp({
    db: htmlHandle.db,
    storage: htmlStorage,
    jobs: new JobQueue(htmlHandle.db, htmlStorage),
    webDist,
    officeEnv: {
      CDE_OFFICE_EDITOR: "collabora",
      CDE_OFFICE_EDITOR_URL: "http://collabora:9980",
      CDE_OFFICE_EDITOR_PUBLIC_URL: "https://office.firma.com.tr",
    },
  });

  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: SECRET_KEY });
  const [company] = await handle.db.insert(companies).values({ name: "Poyraz", code: "PAS" }).returning();
  await handle.db
    .insert(users)
    .values({ email: "ayse@7d.test", name: "Ayşe Demir", passwordHash: await hashPassword(PW), isAdmin: true, companyId: company!.id });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ayse@7d.test", password: PW } });
  cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
});

afterAll(async () => {
  await app.close();
  await htmlApp.close();
  await handle.close();
  await htmlHandle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
  let body: any = null;
  try {
    body = res.body ? res.json() : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers, raw: res.body };
}

/** Mocked fetch: an OpenAI-compatible answer; records what was sent. */
function mockFetch(answer = "Tamam") {
  const sent: { url: string; body: any }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    let body: any = init?.body ?? null;
    try {
      body = body ? JSON.parse(String(body)) : null;
    } catch {
      /* not JSON */
    }
    sent.push({ url: String(url), body });
    return new Response(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { spy, sent };
}

async function logRows() {
  // Byte counts of streamed answers are written when the body ends: give the update a moment.
  await new Promise((r) => setTimeout(r, 20));
  return handle.db.select().from(outboundLog);
}

describe("security headers", () => {
  it("every response carries nosniff, referrer, permissions and opener policies; JSON gets no CSP", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    const tls = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-forwarded-proto": "https" } });
    expect(tls.headers["strict-transport-security"]).toBe("max-age=15552000");
  });

  it("the web app's pages get a CSP with a fresh nonce, frame-ancestors 'self' and the configured editor origin", async () => {
    for (const url of ["/", "/index.html", "/p/abc/docs"]) {
      const res = await htmlApp.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      const csp = String(res.headers["content-security-policy"]);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, url).toBeTruthy();
      expect(res.body).toContain(`<script nonce="${nonce}" type="module"`);
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toMatch(/frame-src 'self' blob: https:\/\/office\.firma\.com\.tr(;|$)/);
      expect(csp).toMatch(/form-action 'self' https:\/\/office\.firma\.com\.tr(;|$)/);
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
    const a = await htmlApp.inject({ method: "GET", url: "/" });
    const b = await htmlApp.inject({ method: "GET", url: "/" });
    expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
    // Static files keep working, without a page policy.
    const js = await htmlApp.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-security-policy"]).toBeUndefined();
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("OAuth paths keep window.opener (no COOP) and routes with their own CSP keep it", async () => {
    const res = await htmlApp.inject({ method: "GET", url: "/oauth2/authorize?client_id=nope&response_type=code" });
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const consent = await htmlApp.inject({ method: "GET", url: "/oauth/consent?client_id=x" });
    expect(consent.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(String(consent.headers["content-security-policy"])).toContain("frame-ancestors 'self'");
    expect(buildCsp({ editorOrigins: ["https://e.example", "bad origin; script-src *"] })).not.toContain("script-src *");
  });
});

describe("redaction", () => {
  it("TC kimlik no needs a valid checksum", () => {
    expect(isValidTckn("10000000146")).toBe(true);
    expect(isValidTckn("10000000147")).toBe(false);
    expect(isValidTckn("01234567890")).toBe(false);
    expect(redactText("TC: 10000000146, sipariş 10000000147").text).toBe("TC: [TCKN_1], sipariş 10000000147");
  });

  it.each([
    ["+90 532 123 45 67", "[TELEFON_1]"],
    ["0532 123 45 67", "[TELEFON_1]"],
    ["0 (532) 123-45-67", "[TELEFON_1]"],
    ["05321234567", "[TELEFON_1]"],
    ["+905321234567", "[TELEFON_1]"],
    ["0090 532 123 45 67", "[TELEFON_1]"],
    ["532 123 45 67", "[TELEFON_1]"],
    ["0532.123.45.67", "[TELEFON_1]"],
    ["0212 555 12 34", "[TELEFON_1]"],
    ["(0212) 555 12 34", "[TELEFON_1]"],
    ["312 456 78 90", "312 456 78 90"],
    ["2026-10-11", "2026-10-11"],
    ["Kat 3, aks 12-14", "Kat 3, aks 12-14"],
    ["ali.veli@firma.com.tr", "[E-POSTA_1]"],
    ["AYSE@ornek.com", "[E-POSTA_1]"],
    ["TR33 0006 1005 1978 6457 8413 26", "[IBAN_1]"],
    ["TR330006100519786457841326", "[IBAN_1]"],
    ["Proje kodu ZAVM-PAS-ZZ-S-B1-0204", "Proje kodu ZAVM-PAS-ZZ-S-B1-0204"],
  ])("%s → %s", (input, expected) => {
    expect(redactText(input).text).toBe(expected);
  });

  it("the same value keeps its placeholder, project members become role and company, and the answer is restored", () => {
    const r = new Redactor([
      { name: "Ayşe Demir", label: "Proje Müdürü (Poyraz)" },
      { name: "Ali Kaya", label: "Proje Müdürü (Poyraz)" },
      { name: "Yönetici", label: "Proje Üyesi" },
    ]);
    const out = r.redact("AYŞE DEMİR'e ve Ali Kaya'ya yaz: ayse@poyraz.com.tr, +90 532 123 45 67 / 0532 123 45 67. Yönetici onaylar.");
    expect(out).toBe("[Proje Müdürü (Poyraz)]'e ve [Proje Müdürü (Poyraz) 2]'ya yaz: [E-POSTA_1], [TELEFON_1] / [TELEFON_1]. Yönetici onaylar.");
    expect(r.counts).toEqual({ eposta: 1, telefon: 2, tckn: 0, iban: 0, kisi: 2 });
    expect(r.restore("[Proje Müdürü (Poyraz) 2] arasın: TELEFON_1, posta [E-POSTA_1]")).toBe("Ali Kaya arasın: +90 532 123 45 67, posta ayse@poyraz.com.tr");
    expect(r.restoreDeep({ to: ["[E-POSTA_1]"], n: 3 })).toEqual({ to: ["ayse@poyraz.com.tr"], n: 3 });
  });
});

describe("outbound registry", () => {
  it("logs purpose, host, sizes, status and time, never content", async () => {
    const { spy } = mockFetch("gizli cevap");
    const res = await outboundFetch("ofis:gotenberg", "https://convert.example.com/forms/x", { method: "POST", body: "gizli içerik 123" }, { connection: "office:converter" });
    expect(await res.text()).toContain("gizli cevap");
    expect(spy).toHaveBeenCalledOnce();
    const row = (await logRows()).find((r) => r.purpose === "ofis:gotenberg")!;
    expect(row).toMatchObject({ host: "convert.example.com", method: "POST", local: false, blocked: false, status: 200, connection: "office:converter" });
    expect(row.bytesOut).toBe(Buffer.byteLength("gizli içerik 123"));
    expect(row.bytesIn).toBeGreaterThan(10);
    expect(JSON.stringify(row)).not.toMatch(/gizli/);
  });

  it("SMTP and other protocols go through outboundCall", async () => {
    const r = await outboundCall("eposta", "smtp://user:pw@mail.firma.local:587", { connection: "smtp", method: "SMTP", bytesOut: 42 }, async () => ({ ok: true }));
    expect(r).toEqual({ ok: true });
    const row = (await logRows()).find((x) => x.purpose === "eposta")!;
    expect(row).toMatchObject({ host: "mail.firma.local:587", local: true, bytesOut: 42, method: "SMTP" });
  });

  it("no raw fetch, undici or SMTP transport outside the registry in src/", () => {
    const src = path.resolve(here, "../../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = path.join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(src);
    const problems: string[] = [];
    const rel = (f: string) => path.relative(src, f).replace(/\\/g, "/");
    for (const f of files) {
      const r = rel(f);
      const text = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (r !== "privacy/outbound.ts" && /(?<![\w.$])fetch\s*\(|globalThis\.fetch\b|\?\?\s*fetch\b/.test(text)) problems.push(`${r}: fetch`);
      if (/from\s+["']undici["']|require\(["']undici["']\)/.test(text)) problems.push(`${r}: undici`);
      if (/\b(?:https?|net|tls)\.(?:request|get|connect)\s*\(/.test(text)) problems.push(`${r}: node:http/net`);
      if (r !== "works/letter.ts" && /from\s+["']nodemailer["']/.test(text)) problems.push(`${r}: nodemailer`);
    }
    // The one SMTP send is wrapped in outboundCall.
    const letter = readFileSync(path.join(src, "works/letter.ts"), "utf8");
    expect(letter).toMatch(/outboundCall\(\s*"eposta"/);
    expect(problems).toEqual([]);
  });

  it("deletes rows older than the retention setting", async () => {
    await handle.db.insert(outboundLog).values({ purpose: "eski", host: "x.example", method: "GET", local: false, at: new Date(Date.now() - 100 * 86400_000) });
    await handle.db.insert(outboundLog).values({ purpose: "yeni", host: "x.example", method: "GET", local: false, at: new Date(Date.now() - 10 * 86400_000) });
    expect(await cleanupOutboundLog(handle.db)).toBe(1);
    const left = await handle.db.select().from(outboundLog).where(eq(outboundLog.host, "x.example"));
    expect(left.map((r) => r.purpose)).toEqual(["yeni"]);
  });
});

describe.skipIf(!hasAi)("AI data minimisation and Gizlilik Merkezi", () => {
  let cloudId: string;
  let localId: string;
  let pid: string;

  beforeAll(async () => {
    const cloud = await call("POST", "/admin/ai/providers", { name: "DeepSeek", kind: "openai_compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test", presetId: "deepseek" });
    expect(cloud.status, cloud.raw).toBe(200);
    cloudId = cloud.body.id;
    const local = await call("POST", "/admin/ai/providers", { name: "Ollama", kind: "openai_compatible", baseUrl: "http://ollama:11434/v1", model: "qwen3:8b" });
    localId = local.body.id;
    expect((await call("PUT", "/admin/settings/ai", { mode: "allow_external", defaultProviderId: cloudId })).status).toBe(200);
    const p = await call("POST", "/projects", { code: "GZL", name: "Gizlilik", template: "empty" });
    expect(p.status, p.raw).toBe(200);
    pid = p.body.id;
    expect((await call("PUT", `/projects/${pid}/ai`, { enabled: true, providerId: cloudId, allowExternal: true })).status).toBe(200);
  });

  it("a cloud provider gets placeholders; the answer is restored; the log has counts, not content", async () => {
    const { sent } = mockFetch("[Yönetici (Poyraz)] için [E-POSTA_1] adresine yazıldı.");
    const provider = await resolveProvider(handle.db, SECRET_KEY, pid);
    expect(provider.external).toBe(true);
    const r = await provider.chat([
      { role: "system", content: "Kısa cevap ver." },
      { role: "user", content: "Ayşe Demir'e (ayse@poyraz.com.tr, 0532 123 45 67, TC 10000000146) yaz." },
    ]);
    const body = JSON.stringify(sent[0]!.body);
    expect(body).not.toContain("ayse@poyraz.com.tr");
    expect(body).not.toContain("Ayşe Demir");
    expect(body).not.toContain("10000000146");
    expect(body).toContain("[Yönetici (Poyraz)]");
    expect(body).toContain("[E-POSTA_1]");
    expect(r.text).toBe("Ayşe Demir için ayse@poyraz.com.tr adresine yazıldı.");
    const row = (await logRows()).find((x) => x.purpose === "yapay_zeka:deepseek")!;
    expect(row).toMatchObject({ host: "api.deepseek.com", local: false, connection: `ai:${cloudId}`, projectId: null });
    expect(row.details).toMatchObject({ provider: "DeepSeek", redacted: true, redactions: { eposta: 1, telefon: 1, tckn: 1, kisi: 1, iban: 0 } });
    expect((row.details as any).chars).toBeGreaterThan(20);
    expect(JSON.stringify(row)).not.toMatch(/poyraz\.com|Ayşe|10000000146/);
  });

  it("a local provider gets the prompt as is, unless 'Yerel modelde de maskele' is on", async () => {
    const local = () => createProvider({ id: localId, name: "Ollama", kind: "openai_compatible", baseUrl: "http://ollama:11434/v1", model: "qwen3:8b" }, { allowExternal: false });
    let m = mockFetch("ok");
    await local().chat([{ role: "user", content: "ali@firma.com.tr" }]);
    expect(JSON.stringify(m.sent[0]!.body)).toContain("ali@firma.com.tr");
    vi.restoreAllMocks();
    expect((await call("PUT", "/admin/privacy/settings", { redactLocal: true })).status).toBe(200);
    m = mockFetch("ok");
    await local().chat([{ role: "user", content: "ali@firma.com.tr" }]);
    expect(JSON.stringify(m.sent[0]!.body)).not.toContain("ali@firma.com.tr");
    await call("PUT", "/admin/privacy/settings", { redactLocal: false });
  });

  it("logs the user and the route of in-app calls", async () => {
    mockFetch("Hazırım, 1, 2, 3");
    const res = await call("POST", `/admin/ai/providers/${cloudId}/test`);
    expect(res.status, res.raw).toBe(200);
    const rows = (await logRows()).filter((x) => x.purpose === "yapay_zeka:deepseek");
    const last = rows[rows.length - 1]!;
    const [me] = await handle.db.select().from(users).where(eq(users.email, "ayse@7d.test"));
    expect(last.userId).toBe(me!.id);
    expect((last.details as any).feature).toBe("admin/ai/providers/:id/test");
  });

  it("lists the connections and filters / exports the log", async () => {
    const c = await call("GET", "/admin/privacy/connections");
    expect(c.status).toBe(200);
    const byId = Object.fromEntries(c.body.map((x: any) => [x.id, x]));
    expect(byId[`ai:${cloudId}`]).toMatchObject({ location: "external", host: "api.deepseek.com", enabled: true });
    expect(byId[`ai:${cloudId}`].lastUsedAt).toBeTruthy();
    expect(byId[`ai:${localId}`]).toMatchObject({ location: "local", host: "ollama:11434" });
    for (const id of ["smtp", "office:editor", "office:converter", "mcp", "ai_queue", "oauth"]) expect(byId[id], id).toBeTruthy();
    expect(byId.oauth.notes[0]).toMatch(/0 uygulama/);

    const log = await call("GET", "/admin/privacy/outbound?purpose=yapay_zeka&limit=5");
    expect(log.status).toBe(200);
    expect(log.body.total).toBeGreaterThan(0);
    expect(log.body.rows.every((r: any) => r.purpose.startsWith("yapay_zeka"))).toBe(true);
    expect(log.body.purposes).toContain("yapay_zeka:deepseek");
    expect(log.body.hosts).toContain("api.deepseek.com");
    const byHost = await call("GET", "/admin/privacy/outbound?host=api.deepseek.com");
    expect(byHost.body.rows.every((r: any) => r.host === "api.deepseek.com")).toBe(true);
    const future = await call("GET", "/admin/privacy/outbound?from=2099-01-01");
    expect(future.body.total).toBe(0);

    const csv = await call("GET", "/admin/privacy/outbound.csv?purpose=yapay_zeka");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.raw.split("\r\n")[0]).toBe("﻿Zaman;Amaç;Bağlantı;Sunucu;Yöntem;Konum;Engellendi;Giden Bayt;Gelen Bayt;Durum;Hata;Süre (ms);Kullanıcı;Proje;Ayrıntı");
    expect(csv.raw).toContain("api.deepseek.com");
    expect(csv.raw).not.toContain("ayse@poyraz.com.tr");
  });

  it("a switched-off connection refuses the provider and its calls", async () => {
    expect((await call("PUT", `/admin/privacy/connections/ai:${cloudId}`, { enabled: false })).status).toBe(200);
    await expect(resolveProvider(handle.db, SECRET_KEY, pid)).rejects.toMatchObject({ code: "connection_disabled" });
    const { spy } = mockFetch();
    await expect(outboundFetch("yapay_zeka:deepseek", "https://api.deepseek.com/v1/x", {}, { connection: `ai:${cloudId}` })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(spy).not.toHaveBeenCalled();
    expect((await call("PUT", `/admin/privacy/connections/ai:${cloudId}`, { enabled: true })).status).toBe(200);
    expect((await call("PUT", "/admin/privacy/connections/nope", { enabled: false })).status).toBe(400);
  });

  it("the kill switch blocks cloud AI and external hosts, forces local_only and stops the queue for external clients", async () => {
    expect((await call("PUT", "/admin/settings/ai", { taskQueue: { enabled: true, allowExternalClients: true } })).status).toBe(200);
    const on = await call("PUT", "/admin/privacy/kill-switch", { on: true });
    expect(on.status).toBe(200);
    expect(on.body.killSwitch).toMatchObject({ on: true, byName: "Ayşe Demir" });
    expect(on.body.ai).toMatchObject({ mode: "local_only", storedMode: "allow_external" });
    expect((await call("GET", "/admin/privacy/status")).body).toEqual({ killSwitch: true });

    const settings = await call("GET", "/admin/settings");
    expect(settings.body.ai).toMatchObject({ mode: "local_only", storedMode: "allow_external", killSwitch: true });
    expect(await getAiTaskQueueSettings(handle.db)).toMatchObject({ enabled: false, allowExternalClients: false });

    const err = await resolveProvider(handle.db, SECRET_KEY, pid).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(render("tr", err.msg)).toContain("Tüm dış bağlantılar kapalı");

    const { spy } = mockFetch();
    const blocked = await outboundFetch("ofis:gotenberg", "https://convert.example.com/x").catch((e) => e);
    expect(blocked).toBeInstanceOf(OutboundBlockedError);
    expect(blocked.message).toContain("Tüm dış bağlantılar kapalı");
    expect(spy).not.toHaveBeenCalled();
    // Loopback / LAN still work, and the "iç ağ" list makes a public-looking name local.
    await outboundFetch("ofis:collabora", "http://127.0.0.1:9980/x");
    await outboundFetch("ofis:collabora", "http://10.1.2.3/x");
    expect((await call("PUT", "/admin/privacy/settings", { lanHosts: ["bad host!"] })).status).toBe(400);
    expect(isExternalUrl("https://ai.firma.com.tr/v1")).toBe(true);
    expect((await call("PUT", "/admin/privacy/settings", { lanHosts: ["ai.firma.com.tr", "100.64.0.0/10"] })).status).toBe(200);
    expect(isExternalUrl("https://ai.firma.com.tr/v1")).toBe(false);
    await outboundFetch("yapay_zeka:yerel", "https://ai.firma.com.tr/v1/x");
    await outboundFetch("yapay_zeka:yerel", "http://100.70.1.1/x");
    expect(spy).toHaveBeenCalledTimes(4);
    const rows = await logRows();
    expect(rows.some((r) => r.blocked && r.host === "convert.example.com" && r.error === "blocked")).toBe(true);

    const off = await call("PUT", "/admin/privacy/kill-switch", { on: false });
    expect(off.body.ai.mode).toBe("allow_external");
    expect(await getAiTaskQueueSettings(handle.db)).toMatchObject({ enabled: true, allowExternalClients: true });
    await call("PUT", "/admin/privacy/settings", { lanHosts: [] });
  });

  it("only system administrators reach Gizlilik Merkezi", async () => {
    await handle.db.insert(users).values({ email: "uye@7d.test", name: "Üye", passwordHash: await hashPassword(PW) });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "uye@7d.test", password: PW } });
    const c = `cde_session=${res.cookies.find((x) => x.name === "cde_session")!.value}`;
    for (const url of ["/admin/privacy", "/admin/privacy/status", "/admin/privacy/connections", "/admin/privacy/outbound"]) {
      const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie: c } });
      expect(r.statusCode, url).toBe(403);
    }
  });
});
