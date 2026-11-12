/**
 * WOPI host protocol and the office admin/file endpoints, against a mocked editor (Collabora
 * discovery with a test key pair for X-WOPI-Proof) and a mocked ONLYOFFICE ConvertService.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ZipFile } from "yazl";
import type { FileOfficeDto, OfficeSessionDto } from "@sitekeep/shared";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { auditLog, projectMembers, systemSettings, users, versionPreviews, versionTexts, wopiLocks, wopiTokens } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { Converters } from "../../../src/previews/converters.js";
import { signProof, ticksFromDate } from "../../../src/office/proof.js";
import { verifyJwt } from "../../../src/office/jwt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PW = "Wopi-Test-Password-1";
const ORIGIN = "http://wopi.localhost:5173";
const CDE = "http://cde.test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function docx(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new ZipFile();
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    z.addBuffer(
      Buffer.from(`<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
      "word/document.xml",
    );
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

async function realPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oldKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (k: typeof keys) => k.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const jwkB64 = (k: typeof keys, part: "n" | "e") =>
  Buffer.from((k.publicKey.export({ format: "jwk" }) as Record<string, string>)[part]!, "base64url").toString("base64");

/** The Collabora fixture with our test keys. */
const DISCOVERY = readFileSync(path.join(here, "../../fixtures/discovery-collabora.xml"), "utf8").replace(
  /<proof-key[^>]*\/>/,
  `<proof-key exponent="${jwkB64(keys, "e")}" modulus="${jwkB64(keys, "n")}" oldexponent="${jwkB64(oldKeys, "e")}" oldmodulus="${jwkB64(oldKeys, "n")}"/>`,
);

// ---------------------------------------------------------------------------
// Mock editor / converter server
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;
let editor: { base: string; handler: Handler; close(): Promise<void>; discoveryHits: number };

async function startEditor() {
  const e = { base: "", handler: (() => undefined) as Handler, close: async () => undefined, discoveryHits: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/hosting/discovery") {
      e.discoveryHits++;
      res.setHeader("Content-Type", "text/xml");
      res.end(DISCOVERY);
      return;
    }
    if (req.url === "/hosting/capabilities") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ "convert-to": { available: true }, productVersion: "24.04.9" }));
      return;
    }
    try {
      await e.handler(req, Buffer.concat(chunks), res);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  e.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  e.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return e;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

let dataDir: string;
let handle: DbHandle;
let jobs: JobQueue;
let app: FastifyInstance;

beforeAll(async () => {
  editor = await startEditor();
  editor.handler = async (req, _body, res) => {
    // Collabora convert-to for the office PDF previews of saved versions.
    if (req.url === "/cool/convert-to/pdf") res.end(await realPdf("Collabora PDF"));
  };
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-wopi-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({
    db: handle.db,
    storage,
    jobs,
    officeEnv: {},
    converters: new Converters({ sofficePath: null, dwg2dxfPath: null }),
  });
  for (const [email, name, isAdmin] of [
    ["admin@7d.test", "Yönetici", true],
    ["ece@7d.test", "Ece Editör", false],
    ["veli@7d.test", "Veli İzleyici", false],
    ["yabanci@7d.test", "Yabancı", false],
  ] as const) {
    await handle.db.insert(users).values({ email, name, passwordHash: await hashPassword(PW), isAdmin });
  }
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await editor.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function client(cookie: string) {
  return async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, origin: ORIGIN, ...headers },
      ...(payload !== undefined && { payload: payload as object }),
    });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
}

/** A WOPI call as the editor makes it: access_token in the query, proof headers signed. */
async function wopi(
  method: "GET" | "POST",
  route: string,
  token: string,
  opts: { headers?: Record<string, string>; payload?: Buffer; proof?: "good" | "none" | "bad" | "old-key" | "stale" } = {},
) {
  const url = `${route}?access_token=${encodeURIComponent(token)}&access_token_ttl=0`;
  const headers: Record<string, string> = { ...opts.headers };
  const mode = opts.proof ?? "good";
  if (mode !== "none") {
    const when = mode === "stale" ? new Date(Date.now() - 25 * 60_000) : new Date();
    const ticks = ticksFromDate(when);
    const signer = mode === "old-key" ? oldKeys : mode === "bad" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : keys;
    headers["x-wopi-timestamp"] = ticks.toString();
    headers["x-wopi-proof"] = signProof(pem(signer), token, `${CDE}${url}`, ticks);
  }
  return app.inject({ method, url, headers, ...(opts.payload && { payload: opts.payload }) });
}

const override = (op: string, extra: Record<string, string> = {}) => ({ headers: { "x-wopi-override": op, ...extra } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("office integration (WOPI)", () => {
  let admin: ReturnType<typeof client>;
  let ece: ReturnType<typeof client>;
  let veli: ReturnType<typeof client>;
  let adminCookie: string;
  let eceCookie: string;
  let pid: string;
  let folderId: string;
  let fileId: string;
  let v1: string;
  let eceToken: string;
  let ids: Record<string, string>;

  const upload = async (cookie: string, name: string, data: Buffer, fid = folderId) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const req = new Request("http://x", { method: "POST", body: form });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/folders/${fid}/files`,
      headers: { cookie, "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    return { status: res.statusCode, body: res.json() };
  };

  beforeAll(async () => {
    adminCookie = await login("admin@7d.test");
    eceCookie = await login("ece@7d.test");
    admin = client(adminCookie);
    ece = client(eceCookie);
    veli = client(await login("veli@7d.test"));
    ids = Object.fromEntries((await handle.db.select().from(users)).map((u) => [u.email, u.id]));
    const p = await admin("POST", "/projects", { code: "WOP", name: "WOPI", template: "empty" });
    pid = p.body.id;
    folderId = (await admin("POST", `/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Çalışma" })).body.id;
    for (const email of ["ece@7d.test", "veli@7d.test"]) expect((await admin("POST", `/projects/${pid}/members`, { email })).status).toBe(200);
    await admin("PUT", `/projects/${pid}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids["ece@7d.test"], level: "edit" },
        { subjectType: "user", subjectId: ids["veli@7d.test"], level: "view" },
      ],
    });
    const up = await upload(adminCookie, "Şartname.docx", await docx("İlk sürüm metni"));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    fileId = up.body.results[0].fileId;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/files/${fileId}`,
      headers: { cookie: adminCookie },
      payload: { attributes: { Disiplin: "Mimari" } },
    });
    v1 = (await admin("GET", `/projects/${pid}/files/${fileId}`)).body.latest.id;
    await jobs.drain();
  });

  // ---- Admin settings ------------------------------------------------------------------------

  it("admin settings: only administrators, URL validation, secrets encrypted and never returned", async () => {
    expect((await ece("GET", "/admin/office")).status).toBe(403);
    expect((await ece("PUT", "/admin/office", { editor: { kind: "collabora" } })).status).toBe(403);
    expect((await admin("PUT", "/admin/office", { editor: { url: "ftp://x" } })).status).toBe(400);

    const res = await admin("PUT", "/admin/office", {
      editor: { kind: "collabora", url: `${editor.base}/`, verifyProof: true },
      wopiBaseUrl: `${CDE}/`,
      tokenTtlMinutes: 600,
      jwtSecret: "cok-gizli-jwt",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.settings).toMatchObject({
      editor: { kind: "collabora", url: editor.base, publicUrl: null, verifyProof: true },
      converter: { kind: "auto", timeoutSec: 180, maxFileMb: 100, concurrency: 2, retries: 2 },
      wopiBaseUrl: CDE,
      tokenTtlMinutes: 600,
      hasJwtSecret: true,
      hasGotenbergAuth: false,
    });
    expect(JSON.stringify(res.body)).not.toContain("cok-gizli-jwt");
    const [row] = await handle.db.select().from(systemSettings).where(eq(systemSettings.key, "office.integration"));
    expect(JSON.stringify(row!.value)).not.toContain("cok-gizli-jwt");
    expect((row!.value as { jwtSecretEnc: string }).jwtSecretEnc).toMatch(/^aesgcm1:/);
    expect(res.body.status.editor).toMatchObject({ kind: "collabora", configured: true, proofKey: true, error: null });
    expect(res.body.status.editor.editExtensions).toEqual(expect.arrayContaining(["docx", "xlsx", "pptx"]));
    expect(res.body.status.converter).toMatchObject({ kind: "collabora", auto: true, available: true });

    // Removing the secret.
    expect((await admin("PUT", "/admin/office", { jwtSecret: "" })).body.settings.hasJwtSecret).toBe(false);
    // Converter status is part of /admin/converters too.
    expect((await admin("GET", "/admin/converters")).body.office).toMatchObject({ kind: "collabora", available: true });
  });

  it("connection test: discovery, proof key, converter health and a test conversion", async () => {
    const r = await admin("POST", "/admin/office/test");
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: { name: string; ok: boolean }) => [s.name, s.ok])).toEqual([
      ["Editör Discovery", true],
      ["Proof Key", true],
      ["Collabora Online Durumu", true],
      ["Deneme Dönüşümü", true],
    ]);
    expect(r.body.ok).toBe(true);
  });

  // ---- File state and sessions ---------------------------------------------------------------

  it("tells the drawer who may edit", async () => {
    const e: FileOfficeDto = (await ece("GET", `/projects/${pid}/files/${fileId}/office`)).body;
    expect(e).toMatchObject({ editable: true, canEdit: true, reason: null, lock: null, currentVersionId: v1, editor: { kind: "collabora" } });
    const v: FileOfficeDto = (await veli("GET", `/projects/${pid}/files/${fileId}/office`)).body;
    expect(v).toMatchObject({ editable: true, canEdit: false });
    expect(v.reason).toContain("yükleme yetkiniz yok");
    const stranger = client(await login("yabanci@7d.test"));
    expect((await stranger("GET", `/projects/${pid}/files/${fileId}/office`)).status).toBe(404);
  });

  it("opens an edit session: token, TTL, action URL with WOPISrc", async () => {
    const r = await ece("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode: "edit" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s: OfficeSessionDto = r.body;
    eceToken = s.accessToken;
    expect(s).toMatchObject({ mode: "edit", editor: "collabora", fileId, fileName: "Şartname.docx", versionId: v1 });
    expect(s.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = s.accessTokenTtl - Date.now();
    expect(ttl).toBeGreaterThan(599 * 60_000);
    expect(ttl).toBeLessThanOrEqual(600 * 60_000);
    expect(s.actionUrl).toBe(
      `http://localhost:9980/browser/1a2b3c4/cool.html?WOPISrc=${encodeURIComponent(`${CDE}/wopi/files/${fileId}`)}&lang=tr&closebutton=1`,
    );
    expect(s.editorOrigin).toBe("http://localhost:9980");
    // Stored hashed only.
    const rows = await handle.db.select().from(wopiTokens);
    expect(JSON.stringify(rows)).not.toContain(s.accessToken);
    expect(rows.find((t) => t.userId === ids["ece@7d.test"])).toMatchObject({ mode: "edit", postMessageOrigin: ORIGIN, projectId: pid });

    // A read-only user gets no edit session, but may view.
    expect((await veli("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode: "edit" })).status).toBe(403);
    // View: Collabora's edit action, read-only through the token.
    const view = await veli("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode: "view" });
    expect(view.status).toBe(200);
    expect(view.body.mode).toBe("view");
    const vinfo = (await wopi("GET", `/wopi/files/${fileId}`, view.body.accessToken)).json();
    expect(vinfo).toMatchObject({ UserCanWrite: false, ReadOnly: true, UserFriendlyName: "Veli İzleyici", DisableExport: true });
    expect((await veli("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode: "bogus" })).status).toBe(400);
  });

  it("public editor address replaces the internal one", async () => {
    await admin("PUT", "/admin/office", { editor: { publicUrl: "https://office.example.com" } });
    const s: OfficeSessionDto = (await ece("POST", `/projects/${pid}/files/${fileId}/office/session`, {})).body;
    expect(s.actionUrl.startsWith("https://office.example.com/browser/1a2b3c4/cool.html?WOPISrc=")).toBe(true);
    expect(s.editorOrigin).toBe("https://office.example.com");
    await admin("PUT", "/admin/office", { editor: { publicUrl: null } });
  });

  it("API tokens cannot open editor sessions", async () => {
    await admin("PUT", "/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    const t = await ece("POST", "/auth/tokens", { name: "betik", scope: "write" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/files/${fileId}/office/session`,
      headers: { authorization: `Bearer ${t.body.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    // …and an API or session token is no WOPI token.
    expect((await wopi("GET", `/wopi/files/${fileId}`, t.body.token)).statusCode).toBe(401);
    const cookieOnly = await app.inject({ method: "GET", url: `/wopi/files/${fileId}`, headers: { cookie: eceCookie } });
    expect(cookieOnly.statusCode).toBe(401);
  });

  // ---- CheckFileInfo / GetFile -----------------------------------------------------------------

  it("CheckFileInfo returns file, user and permission fields", async () => {
    const res = await wopi("GET", `/wopi/files/${fileId}`, eceToken);
    expect(res.statusCode, res.body).toBe(200);
    const info = res.json();
    const [v] = (await admin("GET", `/projects/${pid}/files/${fileId}`)).body.versions;
    expect(info).toMatchObject({
      BaseFileName: "Şartname.docx",
      FileExtension: ".docx",
      Size: v.size,
      OwnerId: ids["admin@7d.test"],
      UserId: ids["ece@7d.test"],
      UserFriendlyName: "Ece Editör",
      Version: v1,
      SHA256: Buffer.from(v.sha256, "hex").toString("base64"),
      UserCanWrite: true,
      ReadOnly: false,
      SupportsLocks: true,
      SupportsGetLock: true,
      SupportsUpdate: true,
      SupportsRename: false,
      UserCanNotWriteRelative: true,
      PostMessageOrigin: ORIGIN,
      BreadcrumbFolderName: "Çalışma",
      BreadcrumbDocName: "Şartname.docx",
      HostEditUrl: `${ORIGIN}/projects/${pid}/edit/${fileId}`,
      DisableExport: false,
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("GetFile returns the latest version and honours X-WOPI-MaxExpectedSize", async () => {
    const res = await wopi("GET", `/wopi/files/${fileId}/contents`, eceToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-wopi-itemversion"]).toBe(v1);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect((await wopi("GET", `/wopi/files/${fileId}/contents`, eceToken, { headers: { "x-wopi-maxexpectedsize": "10" } })).statusCode).toBe(412);
  });

  it("rejects missing, invalid, expired and foreign tokens", async () => {
    expect((await app.inject({ method: "GET", url: `/wopi/files/${fileId}` })).statusCode).toBe(401);
    expect((await wopi("GET", `/wopi/files/${fileId}`, "yanlis-token")).statusCode).toBe(401);
    // A token for another file.
    const other = await upload(adminCookie, "Diğer.docx", await docx("başka"));
    const otherId = other.body.results[0].fileId as string;
    expect((await wopi("GET", `/wopi/files/${otherId}`, eceToken)).statusCode).toBe(401);
    expect((await wopi("GET", `/wopi/files/not-a-uuid`, eceToken)).statusCode).toBe(401);
    // Expired.
    const s: OfficeSessionDto = (await ece("POST", `/projects/${pid}/files/${otherId}/office/session`, {})).body;
    expect((await wopi("GET", `/wopi/files/${otherId}`, s.accessToken)).statusCode).toBe(200);
    await handle.db.update(wopiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(wopiTokens.fileId, otherId));
    expect((await wopi("GET", `/wopi/files/${otherId}`, s.accessToken)).statusCode).toBe(401);
    // Deleted file → 404.
    const s2: OfficeSessionDto = (await ece("POST", `/projects/${pid}/files/${otherId}/office/session`, {})).body;
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${pid}/files/${otherId}`, headers: { cookie: adminCookie } });
    expect((await wopi("GET", `/wopi/files/${otherId}`, s2.accessToken)).statusCode).toBe(404);
  });

  it("checks X-WOPI-Proof signatures", async () => {
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken, { proof: "none" })).statusCode).toBe(500);
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken, { proof: "bad" })).statusCode).toBe(500);
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken, { proof: "stale" })).statusCode).toBe(500);
    // Signed with the old key (the editor rotated keys): accepted.
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken, { proof: "old-key" })).statusCode).toBe(200);
    // Proof checks can be turned off by the administrator.
    await admin("PUT", "/admin/office", { editor: { verifyProof: false } });
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken, { proof: "none" })).statusCode).toBe(200);
    await admin("PUT", "/admin/office", { editor: { verifyProof: true } });
  });

  // ---- Locks and PutFile -----------------------------------------------------------------------

  it("lock lifecycle: LOCK, GET_LOCK, conflicts, REFRESH_LOCK, UnlockAndRelock, UNLOCK", async () => {
    const f = `/wopi/files/${fileId}`;
    let r = await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "L1" }));
    expect(r.statusCode).toBe(200);
    r = await wopi("POST", f, eceToken, override("GET_LOCK"));
    expect(r.headers["x-wopi-lock"]).toBe("L1");
    // Same lock again refreshes; another lock conflicts.
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "L1" }))).statusCode).toBe(200);
    r = await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "L2" }));
    expect(r.statusCode).toBe(409);
    expect(r.headers["x-wopi-lock"]).toBe("L1");
    expect((await wopi("POST", f, eceToken, override("REFRESH_LOCK", { "x-wopi-lock": "L1" }))).statusCode).toBe(200);
    r = await wopi("POST", f, eceToken, override("REFRESH_LOCK", { "x-wopi-lock": "L9" }));
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, "L1"]);
    // UnlockAndRelock.
    r = await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "L2", "x-wopi-oldlock": "L9" }));
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, "L1"]);
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "L2", "x-wopi-oldlock": "L1" }))).statusCode).toBe(200);
    r = await wopi("POST", f, eceToken, override("UNLOCK", { "x-wopi-lock": "L1" }));
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, "L2"]);
    expect((await wopi("POST", f, eceToken, override("UNLOCK", { "x-wopi-lock": "L2" }))).statusCode).toBe(200);
    r = await wopi("POST", f, eceToken, override("GET_LOCK"));
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([200, ""]);
    // Unlock of an unlocked file: 409 with an empty lock.
    r = await wopi("POST", f, eceToken, override("UNLOCK", { "x-wopi-lock": "L2" }));
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, ""]);
    expect((await wopi("POST", f, eceToken, override("LOCK"))).statusCode).toBe(400);
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "x".repeat(1025) }))).statusCode).toBe(400);
    // Not offered.
    for (const op of ["PUT_RELATIVE", "RENAME_FILE", "DELETE", "PUT_USER_INFO"])
      expect((await wopi("POST", f, eceToken, override(op))).statusCode).toBe(501);
  });

  it("PutFile needs the lock and creates a new CDE version with the attributes carried over", async () => {
    const f = `/wopi/files/${fileId}`;
    const edited = await docx("Düzenlenmiş metin tarayıcıdan kaydedildi");
    // No lock on a non-empty file.
    let r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT"), payload: edited });
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, ""]);
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "S1" }))).statusCode).toBe(200);

    // The drawer shows who is editing; uploads of a new version wait.
    const st: FileOfficeDto = (await admin("GET", `/projects/${pid}/files/${fileId}/office`)).body;
    expect(st.lock).toMatchObject({ userId: ids["ece@7d.test"], userName: "Ece Editör" });
    const blocked = await upload(adminCookie, "Şartname.docx", await docx("araya giren yükleme"));
    expect(blocked.status).toBe(400);
    expect(blocked.body.results[0].errors[0]).toContain("Ece Editör tarafından tarayıcıda düzenleniyor");

    // Wrong lock.
    r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "S2" }), payload: edited });
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, "S1"]);

    r = await wopi("POST", `${f}/contents`, eceToken, {
      ...override("PUT", { "x-wopi-lock": "S1", "x-cool-wopi-isautosave": "false" }),
      payload: edited,
    });
    expect(r.statusCode, r.body).toBe(200);
    const file = (await admin("GET", `/projects/${pid}/files/${fileId}`)).body;
    expect(file.currentVersion).toBe(2);
    expect(r.headers["x-wopi-itemversion"]).toBe(file.latest.id);
    expect(r.json().LastModifiedTime).toBe(file.latest.uploadedAt);
    expect(file.latest).toMatchObject({ uploadedBy: ids["ece@7d.test"], comment: "Tarayıcıda düzenlendi (Collabora)", size: edited.length });
    expect(file.attributes).toEqual({ Disiplin: "Mimari" });

    // CheckFileInfo now reports the new version.
    expect((await wopi("GET", f, eceToken)).json().Version).toBe(file.latest.id);

    // Saving the same bytes again adds nothing.
    r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "S1" }), payload: edited });
    expect(r.statusCode).toBe(200);
    expect((await admin("GET", `/projects/${pid}/files/${fileId}`)).body.currentVersion).toBe(2);

    // The new version is indexed for search ("Sor" / MCP) and gets its office PDF.
    await jobs.drain();
    const [t] = await handle.db.select().from(versionTexts).where(eq(versionTexts.versionId, file.latest.id));
    expect(t?.content).toContain("tarayıcıdan kaydedildi");
    const search = (await admin("GET", `/projects/${pid}/search?q=${encodeURIComponent("tarayıcıdan kaydedildi")}`)).body;
    expect(search.results.map((x: { name: string }) => x.name)).toEqual(["Şartname.docx"]);
    // Office files get their text preview first; with a converter configured the PDF follows.
    const [pv] = await handle.db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, file.latest.id), eq(versionPreviews.kind, "pdf")));
    expect(pv).toMatchObject({ kind: "pdf", status: "ready" });

    // Audit entry like an upload.
    const logs = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, fileId));
    expect(logs.find((l) => l.action === "file.version_added")?.details).toMatchObject({ version: 2, via: "wopi", editor: "collabora" });
  });

  it("Collabora timestamp check: the file changed in the CDE meanwhile → 409 (1010)", async () => {
    const f = `/wopi/files/${fileId}`;
    const r = await wopi("POST", `${f}/contents`, eceToken, {
      ...override("PUT", { "x-wopi-lock": "S1", "x-cool-wopi-timestamp": "2020-01-01T00:00:00.000Z" }),
      payload: await docx("çakışan kayıt"),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ COOLStatusCode: 1010, LOOLStatusCode: 1010 });
    const info = (await wopi("GET", f, eceToken)).json();
    const ok = await wopi("POST", `${f}/contents`, eceToken, {
      ...override("PUT", { "x-wopi-lock": "S1", "x-cool-wopi-timestamp": info.LastModifiedTime }),
      payload: await docx("güncel temelden kayıt"),
    });
    expect(ok.statusCode).toBe(200);
    expect((await admin("GET", `/projects/${pid}/files/${fileId}`)).body.currentVersion).toBe(3);
  });

  it("locks expire after 30 minutes", async () => {
    const f = `/wopi/files/${fileId}`;
    const [lock] = await handle.db.select().from(wopiLocks).where(eq(wopiLocks.fileId, fileId));
    const left = lock!.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(29 * 60_000);
    expect(left).toBeLessThanOrEqual(30 * 60_000);
    await handle.db.update(wopiLocks).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(wopiLocks.fileId, fileId));
    expect((await wopi("POST", f, eceToken, override("GET_LOCK"))).headers["x-wopi-lock"]).toBe("");
    expect((await admin("GET", `/projects/${pid}/files/${fileId}/office`)).body.lock).toBeNull();
    // An expired lock is free for a new one; the old lock no longer writes.
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "S9" }))).statusCode).toBe(200);
    const r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "S1" }), payload: Buffer.from("x") });
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, "S9"]);
  });

  it("project administrators clear a stale lock", async () => {
    expect((await ece("DELETE", `/projects/${pid}/files/${fileId}/office/lock`)).status).toBe(403);
    expect((await admin("DELETE", `/projects/${pid}/files/${fileId}/office/lock`)).body).toEqual({ ok: true, cleared: true });
    expect((await admin("GET", `/projects/${pid}/files/${fileId}/office`)).body.lock).toBeNull();
  });

  it("accepts a save that races its own UNLOCK (Collabora does not wait), only shortly after", async () => {
    const f = `/wopi/files/${fileId}`;
    expect((await wopi("POST", f, eceToken, override("LOCK", { "x-wopi-lock": "G1" }))).statusCode).toBe(200);
    expect((await wopi("POST", f, eceToken, override("UNLOCK", { "x-wopi-lock": "G1" }))).statusCode).toBe(200);
    expect((await wopi("POST", f, eceToken, override("GET_LOCK"))).headers["x-wopi-lock"]).toBe("");
    const before = (await admin("GET", `/projects/${pid}/files/${fileId}`)).body.currentVersion as number;
    let r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "G1" }), payload: await docx("kilit yarışı") });
    expect(r.statusCode, r.body).toBe(200);
    expect((await admin("GET", `/projects/${pid}/files/${fileId}`)).body.currentVersion).toBe(before + 1);
    // Another lock id, or the same one too late: refused.
    r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "G2" }), payload: await docx("başka") });
    expect([r.statusCode, r.headers["x-wopi-lock"]]).toEqual([409, ""]);
    await handle.db.update(wopiLocks).set({ expiresAt: new Date(Date.now() - 61_000) }).where(eq(wopiLocks.fileId, fileId));
    r = await wopi("POST", `${f}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "G1" }), payload: await docx("geç") });
    expect(r.statusCode).toBe(409);
    // A released lock does not block uploads.
    expect((await admin("GET", `/projects/${pid}/files/${fileId}/office`)).body.lock).toBeNull();
  });

  it("a read-only user cannot write, lock or export", async () => {
    // View-only folder right: an "edit" token cannot be had; a hand-made one still cannot write.
    const viewer = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/files/${fileId}/office/session`,
      headers: { cookie: await login("veli@7d.test"), origin: ORIGIN },
      payload: { mode: "edit" },
    });
    expect(viewer.statusCode).toBe(403);
    // Forge an edit token for Veli directly: the per-call check still says no.
    const { issueWopiToken } = await import("@7dimensions-project/sitekeep-ee-connect/internal/office/wopi.js");
    const { token } = await issueWopiToken(handle.db, {
      userId: ids["veli@7d.test"]!,
      projectId: pid,
      fileId,
      mode: "edit",
      permission: { level: "edit", canUpload: true, canDownload: true },
      postMessageOrigin: ORIGIN,
      editor: "collabora",
      ttlMinutes: 10,
    });
    const info = (await wopi("GET", `/wopi/files/${fileId}`, token)).json();
    expect(info).toMatchObject({ UserCanWrite: false, ReadOnly: true, DisableExport: true, DisablePrint: true, HideSaveOption: true });
    expect((await wopi("POST", `/wopi/files/${fileId}`, token, override("LOCK", { "x-wopi-lock": "V1" }))).statusCode).toBe(401);
    expect((await wopi("POST", `/wopi/files/${fileId}/contents`, token, { ...override("PUT", { "x-wopi-lock": "S9" }), payload: Buffer.from("x") })).statusCode).toBe(401);
    // Reading is fine.
    expect((await wopi("GET", `/wopi/files/${fileId}/contents`, token)).statusCode).toBe(200);
    // Removed from the project: the token stops working.
    await handle.db.delete(projectMembers).where(eq(projectMembers.userId, ids["veli@7d.test"]!));
    expect((await wopi("GET", `/wopi/files/${fileId}`, token)).statusCode).toBe(404);
  });

  it("approval gate: a gated folder blocks editing like it blocks uploads", async () => {
    const gated = (await admin("PUT", `/projects/${pid}/folders/${folderId}/settings`, { requireApprovedReview: true })).status;
    expect(gated).toBe(200);
    const st: FileOfficeDto = (await ece("GET", `/projects/${pid}/files/${fileId}/office`)).body;
    expect(st.canEdit).toBe(false);
    expect(st.reason).toContain("onaylanmış bir inceleme");
    expect((await ece("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode: "edit" })).status).toBe(403);
    // An open editor session loses its write right too.
    const info = (await wopi("GET", `/wopi/files/${fileId}`, eceToken)).json();
    expect(info.UserCanWrite).toBe(false);
    const r = await wopi("POST", `/wopi/files/${fileId}/contents`, eceToken, { ...override("PUT", { "x-wopi-lock": "S9" }), payload: Buffer.from("x") });
    expect(r.statusCode).toBe(401);
    await admin("PUT", `/projects/${pid}/folders/${folderId}/settings`, { requireApprovedReview: false });
    expect((await wopi("GET", `/wopi/files/${fileId}`, eceToken)).json().UserCanWrite).toBe(true);
  });

  it("refuses bodies over the upload limit", async () => {
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    const small = await buildApp({
      db: handle.db,
      storage,
      // Its own queue: the second app must not take over the job handlers of the first.
      jobs: new JobQueue(handle.db, storage),
      officeEnv: {},
      maxUploadBytes: 1000,
      converters: new Converters({ sofficePath: null, dwg2dxfPath: null }),
    });
    try {
      await handle.db.delete(wopiLocks);
      const token = eceToken;
      const call = (method: "POST", url: string, headers: Record<string, string>, payload?: Buffer) => {
        const u = `${url}?access_token=${token}`;
        const ticks = ticksFromDate(new Date());
        return small.inject({
          method,
          url: u,
          headers: { ...headers, "x-wopi-timestamp": ticks.toString(), "x-wopi-proof": signProof(pem(keys), token, `${CDE}${u}`, ticks) },
          ...(payload && { payload }),
        });
      };
      expect((await call("POST", `/wopi/files/${fileId}`, { "x-wopi-override": "LOCK", "x-wopi-lock": "BIG" })).statusCode).toBe(200);
      const r = await call("POST", `/wopi/files/${fileId}/contents`, { "x-wopi-override": "PUT", "x-wopi-lock": "BIG" }, Buffer.alloc(5000, 1));
      expect(r.statusCode).toBe(413);
      expect((await call("POST", `/wopi/files/${fileId}`, { "x-wopi-override": "UNLOCK", "x-wopi-lock": "BIG" })).statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });

  // ---- ONLYOFFICE converter end to end -----------------------------------------------------------

  it("office previews through ONLYOFFICE: the document server downloads the source from the CDE", async () => {
    await jobs.drain(); // earlier saves are converted by Collabora first
    await app.listen({ port: 0, host: "127.0.0.1" });
    const cdeBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const secret = "oo-secret";
    let source: Buffer | null = null;
    editor.handler = async (req, body, res) => {
      if (req.url === "/converter") {
        const json = JSON.parse(body.toString()) as { url: string; token: string; filetype: string };
        expect(verifyJwt(json.token, secret)).toMatchObject({ filetype: "pptx", outputtype: "pdf" });
        expect(json.url.startsWith(`${cdeBase}/wopi/convert/`)).toBe(true);
        source = Buffer.from(await (await fetch(json.url)).arrayBuffer());
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ endConvert: true, percent: 100, fileUrl: `${editor.base}/cache/out.pdf` }));
        return;
      }
      if (req.url === "/cache/out.pdf") res.end(await realPdf("ONLYOFFICE PDF"));
    };
    const put = await admin("PUT", "/admin/office", {
      converter: { kind: "onlyoffice", url: editor.base },
      wopiBaseUrl: cdeBase,
      jwtSecret: secret,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.settings).toMatchObject({ hasJwtSecret: true, converter: { kind: "onlyoffice" } });
    const pptx = Buffer.from("PK\u0003\u0004 sunum baytları");
    const up = await upload(adminCookie, "Sunum.pptx", pptx);
    const vid = (await admin("GET", `/projects/${pid}/files/${up.body.results[0].fileId}`)).body.latest.id;
    await jobs.drain();
    const [pv] = await handle.db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, vid), eq(versionPreviews.kind, "pdf")));
    expect(pv, pv?.error ?? "").toMatchObject({ kind: "pdf", status: "ready" });
    expect(source).toEqual(pptx);
    // The one-time source URL is gone after the conversion.
    const status = (await admin("GET", `/projects/${pid}/versions/${vid}/preview`)).body;
    expect(status.pdfConverter).toBe(true);
    expect(status.previews.find((p: { kind: string }) => p.kind === "pdf").meta.pageCount).toBe(1);
  });
});
