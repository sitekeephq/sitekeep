/**
 * OpenCDE Documents API 1.0 (docs/features/OPENCDE.md): upload and select flows with a simulated native
 * client (AEC Pilot style: public OAuth client, PKCE, loopback callback) and the CDE pages' API.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp, redactUrl } from "../../src/app/build-app.js";
import { hashPassword, hashToken } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, files, fileVersions, jobs, opencdeDocSessions, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { AECPILOT_OAUTH_PRESET } from "@sitekeep/shared";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const BASE = "http://localhost:80";
const DOCS = `${BASE}/documents/1.0`;
const PART = 8;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-docs-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    oauth: { publicUrl: null, authUrl: null, tokenUrl: null, apis: [], tokenFailureLimit: 10_000 },
    documentsPartBytes: PART,
    maxUploadBytes: 1000,
  });
  for (const [email, name, isAdmin] of [
    ["admin@7d.test", "Admin", true],
    ["alice@7d.test", "Alice", false],
    ["bob@7d.test", "Bob", false],
  ] as const)
    await handle.db.insert(users).values({ email, name, passwordHash: await hashPassword(PW), isAdmin });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---- Helpers ---------------------------------------------------------------------------------------

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

/** /api/v1 with a browser session cookie. */
function web(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p: unknown = {}) => call("POST", u, p), put: (u: string, p: unknown) => call("PUT", u, p), patch: (u: string, p: unknown) => call("PATCH", u, p) };
}

/** Documents API call as the client (absolute URLs from the server or paths under /documents/1.0). */
async function client(token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const u = url.startsWith("http") ? new URL(url) : new URL(`${DOCS}${url}`);
  const res = await app.inject({
    method: method as "GET",
    url: u.pathname + u.search,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers },
    payload: payload as string,
  });
  const json = (() => {
    try {
      return res.json();
    } catch {
      return null;
    }
  })();
  return { status: res.statusCode, body: json, raw: res.rawPayload, headers: res.headers };
}

/** Full OAuth authorization code flow with PKCE for a public client, approving the consent. */
async function oauthToken(cookie: string, clientId: string, scope: string, redirectUri: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state: "s", code_challenge: challenge, code_challenge_method: "S256" });
  const a = await app.inject({ url: `/oauth2/authorize?${q}`, headers: { cookie } });
  expect(a.statusCode, a.body).toBe(302);
  let target = a.headers.location as string;
  if (target.startsWith("/oauth/consent?")) {
    const params = Object.fromEntries(new URL(target, BASE).searchParams);
    const d = await web(cookie).post("/oauth/consent", { params, approve: true });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    target = d.body.redirectTo;
  }
  const code = new URL(target).searchParams.get("code")!;
  const t = await app.inject({
    method: "POST",
    url: "/oauth2/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri }).toString(),
  });
  expect(t.statusCode, t.body).toBe(200);
  return t.json().access_token;
}

/** The page key from upload_ui_url / select_documents_url. */
const pageKey = (url: string) => new URL(url).searchParams.get("key")!;

// ---- Shared state ---------------------------------------------------------------------------------

let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let projectId: string;
let designId: string;
let sharedId: string;
let aliceId: string;
let aec: { clientId: string };
let portal: { clientId: string };
let writeToken: string;
let readToken: string;
let apiOnlyToken: string;
let portalToken: string;
const LOOP = "http://127.0.0.1/callback";
const CB = "http://127.0.0.1:53111/cde-callback";
const PORTAL_CB = "https://portal.example.test/opencde/callback";
const IFC = Buffer.from("ISO-10303-21;\nHEADER;ENDSEC;\nDATA;ENDSEC;\nEND-ISO-10303-21;\n");
let ifcFileId: string;

describe("OpenCDE Documents API 1.0", () => {
  it("is advertised in /foundation/versions with its base URL", async () => {
    const res = await app.inject({ url: "/foundation/versions" });
    expect(res.json().versions).toContainEqual({
      api_id: "documents",
      version_id: "1.0",
      detailed_version: "https://github.com/buildingSMART/documents-API/tree/release_1_0",
      api_base_url: DOCS,
    });
  });

  it("sets up a project, rights, a naming standard and OAuth clients", async () => {
    adminCookie = await login("admin@7d.test");
    aliceCookie = await login("alice@7d.test");
    bobCookie = await login("bob@7d.test");
    const admin = web(adminCookie);
    const p = await admin.post("/projects", { code: "DOCS", name: "Docs API Test" });
    projectId = p.body.id;
    const root = await admin.get(`/projects/${projectId}/folders/${p.body.rootFolderId}/contents`);
    const wipId = root.body.folders[0].id;
    sharedId = root.body.folders[1].id;
    designId = (await admin.post(`/projects/${projectId}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;
    expect((await admin.post(`/projects/${projectId}/members`, { email: "alice@7d.test" })).status).toBe(200);
    expect((await admin.post(`/projects/${projectId}/members`, { email: "bob@7d.test" })).status).toBe(200);
    const [alice] = await handle.db.select().from(users).where(eq(users.email, "alice@7d.test"));
    aliceId = alice!.id;
    const [bob] = await handle.db.select().from(users).where(eq(users.email, "bob@7d.test"));
    await admin.put(`/projects/${projectId}/folders/${designId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: aliceId, level: "edit" },
        { subjectType: "user", subjectId: bob!.id, level: "view" },
      ],
    });
    await admin.put(`/projects/${projectId}/folders/${sharedId}/permissions`, { entries: [{ subjectType: "user", subjectId: aliceId, level: "view" }] });
    const std = await admin.post(`/projects/${projectId}/naming-standards`, {
      name: "DOCS",
      delimiter: "-",
      fields: [
        { name: "Proje", type: "list", values: [{ code: "DOCS" }] },
        { name: "Rol", type: "list", values: [{ code: "A" }, { code: "S" }] },
        { name: "Numara", type: "number", digits: 4 },
      ],
    });
    await admin.patch(`/projects/${projectId}/folders/${designId}`, { namingStandardId: std.body.id });

    const a = await admin.post("/admin/oauth-clients", {
      name: "AEC Pilot",
      description: "Revit / Civil 3D eklentisi",
      type: "public",
      redirectUris: [LOOP],
      scopes: ["documents", "documents:read", "read"],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    aec = a.body.client;
    const b = await admin.post("/admin/oauth-clients", { name: "Portal", type: "public", redirectUris: [PORTAL_CB], scopes: ["documents:read"] });
    portal = b.body.client;

    writeToken = await oauthToken(aliceCookie, aec.clientId, "documents", LOOP);
    readToken = await oauthToken(aliceCookie, aec.clientId, "documents:read", LOOP);
    apiOnlyToken = await oauthToken(aliceCookie, aec.clientId, "read", LOOP);
    portalToken = await oauthToken(aliceCookie, portal.clientId, "documents:read", PORTAL_CB);
  });

  it("checks scopes: Bearer required, documents to upload, documents:read only selects, /api/v1 scopes are not enough", async () => {
    const body = { callback: { url: CB, expires_in: 3600 }, files: [{ file_name: "a.ifc", session_file_id: "1" }] };
    expect((await client(null, "POST", "/upload-documents", body)).status).toBe(401);
    const viaCookie = await app.inject({ method: "POST", url: "/documents/1.0/upload-documents", headers: { cookie: aliceCookie }, payload: body });
    expect(viaCookie.statusCode).toBe(401);
    expect((await client(readToken, "POST", "/upload-documents", body)).status).toBe(403);
    expect((await client(apiOnlyToken, "POST", "/select-documents", { callback: { url: CB, expires_in: 60 } })).status).toBe(403);
    // documents:read may select.
    expect((await client(readToken, "POST", "/select-documents", { callback: { url: CB, expires_in: 60 } })).status).toBe(200);
    // A documents-only token cannot use /api/v1.
    const v1 = await app.inject({ url: "/api/v1/projects", headers: { authorization: `Bearer ${writeToken}` } });
    expect(v1.statusCode).toBe(403);
    // CORS preflight and unknown paths.
    const pre = await app.inject({ method: "OPTIONS", url: "/documents/1.0/upload-documents" });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect((await client(writeToken, "GET", "/nope")).status).toBe(404);
  });

  it("rejects foreign callbacks (no open redirect); native clients may use any loopback port and path", async () => {
    const files = [{ file_name: "a.ifc", session_file_id: "1" }];
    const up = (token: string, url: string) => client(token, "POST", "/upload-documents", { callback: { url, expires_in: 600 }, files });
    expect((await up(writeToken, "https://evil.example.com/cb")).status).toBe(400);
    expect((await up(writeToken, "http://192.168.1.5:8080/cb")).status).toBe(400);
    expect((await up(writeToken, "http://127.0.0.1:8080/x#frag")).status).toBe(400);
    expect((await up(writeToken, "http://localhost:51234/any/path")).status).toBe(200);
    // A web client with an https registration: exact match only.
    const sel = (url: string) => client(portalToken, "POST", "/select-documents", { callback: { url, expires_in: 600 } });
    expect((await sel(PORTAL_CB)).status).toBe(200);
    expect((await sel(`${PORTAL_CB}?x=1`)).status).toBe(400);
    expect((await sel("http://127.0.0.1:9000/cb")).status).toBe(400);
  });

  it("uploads two files: page with folder choice, naming check, metadata; multi-part upload; completion; cancellation", async () => {
    const start = await client(writeToken, "POST", "/upload-documents", {
      callback: { url: CB, expires_in: 3600 },
      files: [
        { file_name: "model.ifc", session_file_id: "f-ifc" },
        { file_name: "rapor.pdf", session_file_id: "f-pdf" },
      ],
    });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body).toMatchObject({ expires_in: 600, max_size_in_bytes: 1000 });
    expect(start.body.upload_ui_url).toMatch(/^http:\/\/localhost:80\/opencde\/upload\?key=[A-Za-z0-9_-]{43}$/);
    const key = pageKey(start.body.upload_ui_url);
    const page = web(aliceCookie);

    // Another user cannot open the page; tokens cannot use the page API.
    expect((await web(bobCookie).get(`/opencde/sessions/${key}`)).status).toBe(403);
    const byToken = await app.inject({ url: `/api/v1/opencde/sessions/${key}`, headers: { authorization: `Bearer ${writeToken}` } });
    expect(byToken.statusCode).toBe(403);

    const s = await page.get(`/opencde/sessions/${key}`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ kind: "upload", status: "pending", client: { name: "AEC Pilot", description: "Revit / Civil 3D eklentisi" } });
    expect(s.body.callbackTarget).toBe("127.0.0.1:53111 (bu bilgisayar)");
    expect(s.body.files.map((f: { fileName: string }) => f.fileName)).toEqual(["model.ifc", "rapor.pdf"]);
    const [ifcRow, pdfRow] = s.body.files as { id: string }[];

    // A second browser session of the same user cannot take over the link.
    const otherSession = await login("alice@7d.test");
    expect((await web(otherSession).get(`/opencde/sessions/${key}`)).status).toBe(403);

    const folders = await page.get(`/opencde/sessions/${key}/projects/${projectId}/folders`);
    const byId = new Map((folders.body as { id: string; canUpload: boolean; path: string }[]).map((f) => [f.id, f]));
    expect(byId.get(designId)).toMatchObject({ canUpload: true, path: "Proje Dosyaları / 01-WIP (Çalışmada) / Tasarım" });
    expect(byId.get(sharedId)).toMatchObject({ canUpload: false });
    const rules = await page.get(`/opencde/sessions/${key}/projects/${projectId}/folders/${designId}/rules`);
    expect(rules.body.standard.name).toBe("DOCS");
    expect((await page.get(`/opencde/sessions/${key}/projects/${projectId}/folders/${sharedId}/rules`)).status).toBe(403);

    // Folder without upload right.
    const noRight = await page.post(`/opencde/sessions/${key}/upload`, { projectId, folderId: sharedId, names: {} });
    expect(noRight.status).toBe(403);
    // Naming violation and a changed extension, reported per file.
    const bad = await page.post(`/opencde/sessions/${key}/upload`, {
      projectId,
      folderId: designId,
      names: { [ifcRow!.id]: "model.ifc", [pdfRow!.id]: "DOCS-A-0002.docx" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details.files[ifcRow!.id][0]).toMatch(/İsimlendirme standardına uymuyor/);
    expect(bad.body.details.files[pdfRow!.id].join(" ")).toMatch(/uzantısı değiştirilemez/);

    // Instructions before the page is finished: 409.
    const sid = (await handle.db.select().from(opencdeDocSessions).where(eq(opencdeDocSessions.kind, "upload"))).find((r) => r.status === "pending" && r.claimedAt)!.id;
    expect((await client(writeToken, "POST", `/upload-sessions/${sid}`, { files: [{ size_in_bytes: 10, session_file_id: "f-ifc" }] })).status).toBe(409);

    const ok = await page.post(`/opencde/sessions/${key}/upload`, {
      projectId,
      folderId: designId,
      comment: "AEC Pilot'tan gönderildi",
      revision: "C01",
      suitability: "S2",
      names: { [ifcRow!.id]: "DOCS-A-0001.ifc", [pdfRow!.id]: "DOCS-A-0002.pdf" },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const redirect = new URL(ok.body.redirectTo);
    expect(redirect.origin + redirect.pathname).toBe(CB);
    const uploadUrl = redirect.searchParams.get("upload_documents_url")!;
    expect(uploadUrl).toBe(`${DOCS}/upload-sessions/${sid}`);
    // The page cannot be sent twice.
    expect((await page.post(`/opencde/sessions/${key}/upload`, { projectId, folderId: designId, names: {} })).status).toBe(409);

    // Other tokens of the user (other client) or other users get 404.
    expect((await client(portalToken, "POST", uploadUrl, { files: [] })).status).toBe(403);
    // Size limit.
    expect((await client(writeToken, "POST", uploadUrl, { files: [{ size_in_bytes: 5000, session_file_id: "f-ifc" }] })).status).toBe(400);

    const instr = await client(writeToken, "POST", uploadUrl, {
      files: [
        { size_in_bytes: IFC.length, session_file_id: "f-ifc" },
        { size_in_bytes: 5, session_file_id: "f-pdf" },
      ],
    });
    expect(instr.status, JSON.stringify(instr.body)).toBe(200);
    expect(typeof instr.body.server_context).toBe("string");
    const ifcPlan = instr.body.documents_to_upload.find((d: { session_file_id: string }) => d.session_file_id === "f-ifc");
    const parts = ifcPlan.upload_file_parts as { url: string; http_method: string; content_range_start: number; content_range_end: number; include_authorization: boolean; additional_headers: { values: { name: string; value: string }[] } }[];
    expect(parts.length).toBe(Math.ceil(IFC.length / PART));
    expect(parts[0]).toMatchObject({ http_method: "PUT", include_authorization: true, content_range_start: 0, content_range_end: PART - 1 });
    expect(parts.at(-1)!.content_range_end).toBe(IFC.length - 1);
    expect(parts[0]!.additional_headers.values).toEqual([{ name: "Content-Length", value: String(PART) }]);

    // Completion before all parts: 409. Wrong part size: 400.
    expect((await client(writeToken, "POST", ifcPlan.upload_completion.url)).status).toBe(409);
    const wrong = await client(writeToken, "PUT", parts[0]!.url, Buffer.from("abc"), { "content-type": "application/octet-stream" });
    expect(wrong.status).toBe(400);
    // Parts in reverse order (any order is allowed), one of them twice.
    for (const p of [...parts].reverse()) {
      const chunk = IFC.subarray(p.content_range_start, p.content_range_end + 1);
      const r = await client(writeToken, p.http_method, p.url, chunk, { "content-type": "application/octet-stream" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const again = await client(writeToken, "PUT", parts[1]!.url, IFC.subarray(parts[1]!.content_range_start, parts[1]!.content_range_end + 1));
    expect(again.status).toBe(200);

    const done = await client(writeToken, "POST", ifcPlan.upload_completion.url);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    ifcFileId = done.body.document_id;
    expect(done.body).toEqual({
      links: {
        document_version: { url: `${DOCS}/documents/${ifcFileId}/versions/1` },
        document_version_metadata: { url: `${DOCS}/documents/${ifcFileId}/versions/1/metadata` },
        document_version_download: { url: `${DOCS}/documents/${ifcFileId}/versions/1/download` },
        document_versions: { url: `${DOCS}/documents/${ifcFileId}/versions` },
        document_details: { url: `${BASE}/projects/${projectId}/files/${designId}?file=${ifcFileId}` },
      },
      version_number: "v1",
      version_index: 1,
      creation_date: expect.any(String),
      title: "DOCS-A-0001",
      file_description: { name: "DOCS-A-0001.ifc", size_in_bytes: IFC.length },
      document_id: ifcFileId,
    });
    // Completion is idempotent.
    expect((await client(writeToken, "POST", ifcPlan.upload_completion.url)).body.document_id).toBe(ifcFileId);

    // Stored through the normal upload service: folder, attributes, comment, IFC job, audit.
    const [file] = await handle.db.select().from(files).where(eq(files.id, ifcFileId));
    expect(file).toMatchObject({ folderId: designId, name: "DOCS-A-0001.ifc", attributes: { Revizyon: "C01", Uygunluk: "S2" } });
    const [version] = await handle.db.select().from(fileVersions).where(eq(fileVersions.fileId, ifcFileId));
    expect(version).toMatchObject({ comment: "AEC Pilot'tan gönderildi", size: IFC.length, derivativeStatus: "pending" });
    expect(version!.sha256).toBe(createHash("sha256").update(IFC).digest("hex"));
    const queued = await handle.db.select().from(jobs).where(eq(jobs.kind, "ifc_to_frag"));
    expect(queued.some((j) => j.payload.versionId === version!.id)).toBe(true);
    const [uploaded] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "file.uploaded"), eq(auditLog.targetId, ifcFileId)));
    expect(uploaded!.details).toMatchObject({ via: "opencde-documents", client: "AEC Pilot" });

    // The PDF is cancelled by the client: 204, then the session is closed.
    const pdfPlan = instr.body.documents_to_upload.find((d: { session_file_id: string }) => d.session_file_id === "f-pdf");
    await client(writeToken, "PUT", pdfPlan.upload_file_parts[0].url, Buffer.from("%PDF-"));
    const cancel = await client(writeToken, "POST", pdfPlan.upload_cancellation.url);
    expect(cancel.status).toBe(204);
    expect((await client(writeToken, "POST", pdfPlan.upload_completion.url)).status).toBe(409);
    const [closed] = await handle.db.select().from(opencdeDocSessions).where(eq(opencdeDocSessions.id, sid));
    expect(closed!.status).toBe("completed");

    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, sid))).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["opencde.upload_started", "opencde.upload_prepared", "opencde.upload_instructions", "opencde.upload_completed", "opencde.upload_cancelled"]),
    );
  });

  it("uploads a new version of an existing document (document_id)", async () => {
    const start = await client(writeToken, "POST", "/upload-documents", {
      callback: { url: CB, expires_in: 3600 },
      files: [{ file_name: "export.ifc", session_file_id: "v2", document_id: ifcFileId }],
    });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const key = pageKey(start.body.upload_ui_url);
    const page = web(aliceCookie);
    const s = await page.get(`/opencde/sessions/${key}`);
    expect(s.body.files[0].existing).toMatchObject({ fileId: ifcFileId, name: "DOCS-A-0001.ifc", folderId: designId, version: 1 });
    const ok = await page.post(`/opencde/sessions/${key}/upload`, { projectId, folderId: designId, revision: "C02", names: {} });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const url = new URL(ok.body.redirectTo).searchParams.get("upload_documents_url")!;
    const data = Buffer.from("ISO-10303-21; v2");
    const plan = (await client(writeToken, "POST", url, { files: [{ size_in_bytes: data.length, session_file_id: "v2" }] })).body.documents_to_upload[0];
    for (const p of plan.upload_file_parts) {
      const r = await client(writeToken, "PUT", p.url, data.subarray(p.content_range_start, p.content_range_end + 1));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const done = await client(writeToken, "POST", plan.upload_completion.url);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ document_id: ifcFileId, version_index: 2, version_number: "v2", file_description: { name: "DOCS-A-0001.ifc", size_in_bytes: data.length } });
    const [file] = await handle.db.select().from(files).where(eq(files.id, ifcFileId));
    expect(file!.attributes).toMatchObject({ Revizyon: "C02", Uygunluk: "S2" });
    // An unknown document_id is refused at the start.
    const unknown = await client(writeToken, "POST", "/upload-documents", {
      callback: { url: CB, expires_in: 60 },
      files: [{ file_name: "x.ifc", session_file_id: "x", document_id: "bf546064-6b97-4730-a094-c21ab929c91a" }],
    });
    expect(unknown.status).toBe(400);
  });

  it("expires page links and sessions; the user can cancel", async () => {
    const start = async () =>
      (await client(writeToken, "POST", "/upload-documents", { callback: { url: CB, expires_in: 3600 }, files: [{ file_name: "a.ifc", session_file_id: "a" }] })).body
        .upload_ui_url as string;
    // Unopened link after its lifetime.
    const k1 = pageKey(await start());
    await handle.db.update(opencdeDocSessions).set({ uiExpiresAt: new Date(Date.now() - 1000) }).where(eq(opencdeDocSessions.status, "pending"));
    expect((await web(aliceCookie).get(`/opencde/sessions/${k1}`)).status).toBe(410);

    // The application stopped waiting (callback expired): the page cannot be sent.
    const k2 = pageKey(await start());
    expect((await web(aliceCookie).get(`/opencde/sessions/${k2}`)).status).toBe(200);
    await handle.db
      .update(opencdeDocSessions)
      .set({ callbackExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(opencdeDocSessions.id, (await sessionByKey(k2)).id));
    expect((await web(aliceCookie).post(`/opencde/sessions/${k2}/upload`, { projectId, folderId: designId, names: {} })).status).toBe(410);

    // Expired upload session: instructions 410.
    const k3 = pageKey(await start());
    const page = web(aliceCookie);
    const s3 = await page.get(`/opencde/sessions/${k3}`);
    const r = await page.post(`/opencde/sessions/${k3}/upload`, { projectId, folderId: designId, names: { [s3.body.files[0].id]: "DOCS-S-0009.ifc" } });
    const url = new URL(r.body.redirectTo).searchParams.get("upload_documents_url")!;
    await handle.db.update(opencdeDocSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(opencdeDocSessions.id, url.split("/").at(-1)!));
    expect((await client(writeToken, "POST", url, { files: [{ size_in_bytes: 3, session_file_id: "a" }] })).status).toBe(410);

    // "İptal" on the page.
    const k4 = pageKey(await start());
    await page.get(`/opencde/sessions/${k4}`);
    const c = await page.post(`/opencde/sessions/${k4}/cancel`);
    expect(new URL(c.body.redirectTo).searchParams.get("user_cancelled_upload")).toBe("true");
  });

  it("selects documents: page lists, selection, versions, metadata, download, document query", async () => {
    const start = await client(writeToken, "POST", "/select-documents", {
      callback: { url: CB, expires_in: 3600 },
      supported_file_extensions: [".ifc"],
    });
    expect(start.status).toBe(200);
    expect(start.body.select_documents_url).toMatch(/\/opencde\/select\?key=/);
    expect(start.body.expires_in).toBe(600);
    const key = pageKey(start.body.select_documents_url);
    const page = web(aliceCookie);
    const s = await page.get(`/opencde/sessions/${key}`);
    expect(s.body).toMatchObject({ kind: "select", supportedExtensions: [".ifc"] });
    const list = await page.get(`/opencde/sessions/${key}/projects/${projectId}/documents?folderId=${designId}`);
    const row = (list.body as { fileId: string; versionId: string; version: number }[]).find((r) => r.fileId === ifcFileId)!;
    expect(row.version).toBe(2);
    const search = await page.get(`/opencde/sessions/${key}/projects/${projectId}/documents?q=docs-a-0001`);
    expect(search.body.map((r: { fileId: string }) => r.fileId)).toContain(ifcFileId);

    const sel = await page.post(`/opencde/sessions/${key}/select`, { projectId, versionIds: [row.versionId] });
    expect(sel.status, JSON.stringify(sel.body)).toBe(200);
    const selectedUrl = new URL(sel.body.redirectTo).searchParams.get("selected_documents_url")!;
    const got = await client(writeToken, "GET", selectedUrl);
    expect(got.status).toBe(200);
    expect(got.body.documents).toHaveLength(1);
    const doc = got.body.documents[0];
    expect(doc).toMatchObject({ document_id: ifcFileId, version_index: 2, title: "DOCS-A-0001" });
    expect(typeof got.body.server_context).toBe("string");
    // Another client of the same user cannot read the selection.
    expect((await client(portalToken, "GET", selectedUrl)).status).toBe(404);

    const versions = await client(readToken, "GET", doc.links.document_versions.url);
    expect(versions.body.documents.map((d: { version_index: number }) => d.version_index)).toEqual([2, 1]);
    const one = await client(readToken, "GET", versions.body.documents[1].links.document_version.url);
    expect(one.body.version_number).toBe("v1");
    const meta = await client(readToken, "GET", doc.links.document_version_metadata.url);
    const entries = Object.fromEntries((meta.body.metadata as { name: string; value: string[]; data_type: string }[]).map((m) => [m.name, m]));
    expect(entries["Proje"]!.value).toEqual(["Docs API Test"]);
    expect(entries["Revizyon"]!.value).toEqual(["C02"]);
    expect(entries["Yükleme Tarihi"]!.data_type).toBe("date-time");
    const dl = await client(readToken, "GET", versions.body.documents[1].links.document_version_download.url);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.raw, IFC)).toBe(0);
    expect(dl.headers["content-disposition"]).toContain("DOCS-A-0001.ifc");

    const q = await client(readToken, "POST", "/document-versions", { document_ids: [ifcFileId, "bf546064-6b97-4730-a094-c21ab929c91a"] });
    expect(q.status).toBe(200);
    expect(q.body.versions.map((v: { version_index: number }) => v.version_index)).toEqual([2]);
    const etag = q.headers.etag as string;
    expect((await client(readToken, "POST", "/document-versions", { document_ids: [ifcFileId] }, { "if-none-match": etag })).status).toBe(304);

    // Select page cancel.
    const k2 = pageKey((await client(readToken, "POST", "/select-documents", { callback: { url: CB, expires_in: 600 } })).body.select_documents_url);
    await page.get(`/opencde/sessions/${k2}`);
    const c = await page.post(`/opencde/sessions/${k2}/cancel`);
    expect(new URL(c.body.redirectTo).searchParams.get("user_cancelled_selection")).toBe("true");
  });

  it("respects folder rights: view without download, no access, audit of downloads", async () => {
    const bobToken = await oauthToken(bobCookie, aec.clientId, "documents", LOOP);
    const base = `/documents/${ifcFileId}/versions/2`;
    expect((await client(bobToken, "GET", base)).status).toBe(200);
    expect((await client(bobToken, "GET", `${base}/download`)).status).toBe(403);
    // Bob leaves the project: the document disappears for his application too.
    const [bob] = await handle.db.select().from(users).where(eq(users.email, "bob@7d.test"));
    const del = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}/members/${bob!.id}`, headers: { cookie: adminCookie } });
    expect(del.statusCode, del.body).toBe(200);
    expect((await client(bobToken, "GET", base)).status).toBe(404);
    const downloads = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "file.downloaded"), eq(auditLog.targetId, ifcFileId)));
    expect(downloads.some((d) => (d.details as { via?: string }).via === "opencde-documents")).toBe(true);
  });

  /**
   * The contract of the AEC Pilot "CDE'ye Gönder" client (aecpilot feat/send-to-cde), replayed
   * step by step as the client does it: discovery, OAuth with the preset client, upload-documents,
   * browser page, callback with a random path, instructions, parts with optional prefix/suffix
   * framing and additional headers, completion; then the cancel paths and the error shape.
   */
  it("meets the AEC Pilot Send to CDE contract (two-part upload, cancel paths, errors)", async () => {
    const preset = await web(adminCookie).post("/admin/oauth-clients", AECPILOT_OAUTH_PRESET);
    expect(preset.status, JSON.stringify(preset.body)).toBe(200);
    expect(preset.body.client).toMatchObject({ type: "public", scopes: ["documents"], redirectUris: ["http://127.0.0.1/aecpilot/opencde/oauth"] });
    expect(preset.body.client.clientId).toMatch(/^cde-/);
    // OAuth: any loopback port, exact path, PKCE, scope "documents".
    const token = await oauthToken(aliceCookie, preset.body.client.clientId, "documents", "http://127.0.0.1:61234/aecpilot/opencde/oauth");

    // 1. Discovery.
    const versions = (await app.inject({ url: "/foundation/versions" })).json();
    const docs = versions.versions.find((v: { api_id: string; version_id: string }) => v.api_id === "documents" && v.version_id === "1.0").api_base_url as string;
    expect(docs).toBe(DOCS);

    // Client helper: absolute or relative URLs against the CDE, Bearer when asked.
    const call = async (method: string, url: string, opts: { body?: Buffer | string; json?: unknown; auth?: boolean; headers?: Record<string, string> } = {}) => {
      const u = new URL(url, docs);
      expect(u.origin).toBe(new URL(docs).origin);
      const res = await app.inject({
        method: method as "POST",
        url: u.pathname + u.search,
        headers: {
          ...(opts.auth !== false && { authorization: `Bearer ${token}` }),
          ...(opts.json !== undefined && { "content-type": "application/json" }),
          ...opts.headers,
        },
        payload: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      });
      return { status: res.statusCode, text: res.body, json: () => res.json() };
    };
    const callback = `http://127.0.0.1:61235/${randomBytes(8).toString("hex")}/`;

    // Browser page: the user signs in (cookie), picks the folder and the name, sends.
    const browserSend = async (uploadUiUrl: string, name: string) => {
      const key = pageKey(uploadUiUrl);
      const page = web(aliceCookie);
      const s = await page.get(`/opencde/sessions/${key}`);
      expect(s.status).toBe(200);
      const r = await page.post(`/opencde/sessions/${key}/upload`, { projectId, folderId: designId, names: { [s.body.files[0].id]: name } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return new URL(r.body.redirectTo);
    };

    // 2. upload-documents.
    const sessionFileId = randomBytes(16).toString("hex");
    const data = Buffer.from("ISO-10303-21;");
    expect(data.length).toBeGreaterThan(PART);
    expect(data.length).toBeLessThanOrEqual(2 * PART);
    const init = await call("POST", `${docs}/upload-documents`, {
      json: { server_context: null, callback: { url: callback, expires_in: 3600 }, files: [{ file_name: "Model.ifc", session_file_id: sessionFileId }] },
    });
    expect(init.status, init.text).toBe(200);
    const initBody = init.json();
    expect(Object.keys(initBody).sort()).toEqual(["expires_in", "max_size_in_bytes", "upload_ui_url"]);
    expect(initBody.expires_in).toBeGreaterThan(0);

    // 3–4. Browser → callback with the url-encoded upload_documents_url.
    const back = await browserSend(initBody.upload_ui_url, "DOCS-S-0100.ifc");
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    const uploadDocumentsUrl = back.searchParams.get("upload_documents_url")!;
    expect(back.search).toContain(encodeURIComponent(uploadDocumentsUrl));

    // 5. Instructions.
    const instr = await call("POST", uploadDocumentsUrl, { json: { files: [{ size_in_bytes: data.length, session_file_id: sessionFileId }] } });
    expect(instr.status, instr.text).toBe(200);
    const plan = instr.json();
    expect(typeof plan.server_context).toBe("string");
    const doc = plan.documents_to_upload[0];
    expect(doc.session_file_id).toBe(sessionFileId);
    expect(doc.upload_file_parts).toHaveLength(2);

    // Parts exactly as the client sends them: prefix + bytes[start..end] + suffix, extra headers, Bearer if asked.
    type Part = { url: string; http_method: string; content_range_start: number; content_range_end: number; include_authorization?: boolean; additional_headers?: { values: { name: string; value: string }[] }; multipart_form_data?: { prefix: string; suffix: string } };
    for (const part of doc.upload_file_parts as Part[]) {
      expect(part.include_authorization).toBe(true);
      expect(part.multipart_form_data).toBeUndefined();
      const prefix = part.multipart_form_data ? Buffer.from(part.multipart_form_data.prefix, "base64") : Buffer.alloc(0);
      const suffix = part.multipart_form_data ? Buffer.from(part.multipart_form_data.suffix, "base64") : Buffer.alloc(0);
      const body = Buffer.concat([prefix, data.subarray(part.content_range_start, part.content_range_end + 1), suffix]);
      const headers = Object.fromEntries((part.additional_headers?.values ?? []).map((h) => [h.name.toLowerCase(), h.value]));
      expect(Number(headers["content-length"])).toBe(body.length);
      const r = await call(part.http_method, part.url, { body, auth: part.include_authorization === true, headers: { "content-type": "application/octet-stream", ...headers } });
      expect(r.status, r.text).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
    }

    // 6. Completion: POST, Bearer, no body → DocumentVersion.
    const done = await call("POST", doc.upload_completion.url);
    expect(done.status, done.text).toBe(200);
    const v = done.json();
    for (const link of ["document_version", "document_version_metadata", "document_version_download", "document_versions", "document_details"])
      expect(typeof v.links[link].url).toBe("string");
    expect(v).toMatchObject({ version_number: "v1", version_index: 1, title: "DOCS-S-0100", file_description: { name: "DOCS-S-0100.ifc", size_in_bytes: data.length } });
    expect(new Date(v.creation_date).toISOString()).toBe(v.creation_date);
    expect(typeof v.document_id).toBe("string");
    const dl = await call("GET", v.links.document_version_download.url);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(data.toString());

    // 7a. Client cancellation → 204, empty body.
    const sf2 = randomBytes(16).toString("hex");
    const init2 = (await call("POST", `${docs}/upload-documents`, { json: { server_context: plan.server_context, callback: { url: callback, expires_in: 3600 }, files: [{ file_name: "Model.ifc", session_file_id: sf2, document_id: v.document_id }] } })).json();
    const back2 = await browserSend(init2.upload_ui_url, "ignored-for-new-version.ifc");
    const plan2 = (await call("POST", back2.searchParams.get("upload_documents_url")!, { json: { files: [{ size_in_bytes: data.length, session_file_id: sf2 }] } })).json();
    const cancelled = await call("POST", plan2.documents_to_upload[0].upload_cancellation.url);
    expect(cancelled.status).toBe(204);
    expect(cancelled.text).toBe("");

    // 7b. User cancels on the page → ?user_cancelled_upload=true on the same callback.
    const init3 = (await call("POST", `${docs}/upload-documents`, { json: { callback: { url: callback, expires_in: 3600 }, files: [{ file_name: "Model.ifc", session_file_id: "x" }] } })).json();
    const key3 = pageKey(init3.upload_ui_url);
    await web(aliceCookie).get(`/opencde/sessions/${key3}`);
    const userCancel = new URL((await web(aliceCookie).post(`/opencde/sessions/${key3}/cancel`)).body.redirectTo);
    expect(`${userCancel.origin}${userCancel.pathname}`).toBe(callback);
    expect(userCancel.searchParams.get("user_cancelled_upload")).toBe("true");
    expect(userCancel.searchParams.get("upload_documents_url")).toBeNull();

    // Errors: JSON with a Turkish message the client shows as is.
    const err = await call("POST", `${docs}/upload-documents`, { json: { callback: { url: "https://evil.example.com/", expires_in: 60 }, files: [{ file_name: "a.ifc", session_file_id: "1" }] } });
    expect(err.status).toBe(400);
    expect(err.json().message).toMatch(/kayıtlı yönlendirme/);
    const noAuth = await call("POST", `${docs}/upload-documents`, { auth: false, json: {} });
    expect(noAuth.status).toBe(401);
    expect(typeof noAuth.json().message).toBe("string");
  });

  it("keeps page keys out of the request log", () => {
    expect(redactUrl("/api/v1/opencde/sessions/abcDEF123_-xyz/upload")).toBe("/api/v1/opencde/sessions/***/upload");
    expect(redactUrl("/opencde/upload?key=secretValue")).toBe("/opencde/upload?key=***");
  });
});

async function sessionByKey(key: string) {
  const [s] = await handle.db.select().from(opencdeDocSessions).where(eq(opencdeDocSessions.uiKeyHash, hashToken(key)));
  return s!;
}
