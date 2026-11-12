/**
 * Office → PDF previews end to end in the core, with or without the Connect module (docs/modules/connect.md):
 * the admin settings, a Gotenberg conversion of an uploaded file, and an ONLYOFFICE conversion whose
 * document server downloads the source from the core's /wopi/convert route. The WOPI editor itself is
 * Connect's (test/modules/connect/wopi.test.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users, versionPreviews } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { Converters } from "../../src/previews/converters.js";
import { verifyJwt } from "../../src/office/jwt.js";

const PW = "Office-Test-Password-1";

async function realPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;
let server: { base: string; handler: Handler; hits: string[]; close(): Promise<void> };

/** One mock for both converters: Gotenberg (/forms/libreoffice/convert, /health) and ONLYOFFICE (/converter, /healthcheck). */
async function startConverter() {
  const s = { base: "", handler: (() => undefined) as Handler, hits: [] as string[], close: async () => undefined };
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    s.hits.push(`${req.method} ${req.url}`);
    try {
      await s.handler(req, Buffer.concat(chunks), res);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  s.base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  s.close = () =>
    new Promise((r) => {
      srv.closeAllConnections();
      srv.close(() => r());
    });
  return s;
}

let dataDir: string;
let handle: DbHandle;
let jobs: JobQueue;
let app: FastifyInstance;

beforeAll(async () => {
  server = await startConverter();
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-office-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, officeEnv: {}, converters: new Converters({ sofficePath: null, dwg2dxfPath: null }) });
  for (const [email, name, isAdmin] of [
    ["admin@7d.test", "Yönetici", true],
    ["ece@7d.test", "Ece", false],
  ] as const) {
    await handle.db.insert(users).values({ email, name, passwordHash: await hashPassword(PW), isAdmin });
  }
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function client(cookie: string) {
  return async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
}

describe("office → PDF previews (core)", () => {
  let admin: ReturnType<typeof client>;
  let ece: ReturnType<typeof client>;
  let adminCookie: string;
  let pid: string;
  let folderId: string;

  const upload = async (name: string, data: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const req = new Request("http://x", { method: "POST", body: form });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/folders/${folderId}/files`,
      headers: { cookie: adminCookie, "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode, res.body).toBe(200);
    const fileId = res.json().results[0].fileId as string;
    return (await admin("GET", `/projects/${pid}/files/${fileId}`)).body.latest.id as string;
  };

  const pdfPreview = async (versionId: string) => {
    await jobs.drain();
    const [pv] = await handle.db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, versionId), eq(versionPreviews.kind, "pdf")));
    return pv;
  };

  beforeAll(async () => {
    adminCookie = await login("admin@7d.test");
    admin = client(adminCookie);
    ece = client(await login("ece@7d.test"));
    const p = await admin("POST", "/projects", { code: "OFC", name: "Ofis", template: "empty" });
    pid = p.body.id;
    folderId = (await admin("POST", `/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Çalışma" })).body.id;
  });

  it("settings: administrators only, URLs checked, the converter's status reported", async () => {
    expect((await ece("GET", "/admin/office")).status).toBe(403);
    expect((await ece("PUT", "/admin/office", { converter: { kind: "gotenberg", url: server.base } })).status).toBe(403);
    expect((await admin("PUT", "/admin/office", { converter: { kind: "gotenberg", url: "ftp://x" } })).status).toBe(400);

    server.handler = (req, _b, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "up", details: { libreoffice: { status: "up" } } }));
      }
    };
    const put = await admin("PUT", "/admin/office", { converter: { kind: "gotenberg", url: `${server.base}/` } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.settings.converter).toMatchObject({ kind: "gotenberg", url: server.base });
    expect(put.body.status.converter).toMatchObject({ kind: "gotenberg", available: true });
    expect((await admin("GET", "/admin/converters")).body.office).toMatchObject({ kind: "gotenberg", available: true });
  });

  it("converts an uploaded document with Gotenberg", async () => {
    server.handler = async (req, body, res) => {
      if (req.url === "/forms/libreoffice/convert" && req.method === "POST") {
        expect(body.toString("latin1")).toContain('filename="input.docx"');
        res.setHeader("Content-Type", "application/pdf");
        res.end(await realPdf("Gotenberg PDF"));
      }
    };
    const vid = await upload("Şartname.docx", Buffer.from("PK\u0003\u0004 belge baytları"));
    const pv = await pdfPreview(vid);
    expect(pv, pv?.error ?? "").toMatchObject({ kind: "pdf", status: "ready" });
    const status = (await admin("GET", `/projects/${pid}/versions/${vid}/preview`)).body;
    expect(status.pdfConverter).toBe(true);
    expect(status.previews.find((p: { kind: string }) => p.kind === "pdf").meta.pageCount).toBe(1);
  });

  it("converts with ONLYOFFICE: the document server downloads the source from the core once", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const cdeBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const secret = "oo-secret";
    let source: Buffer | null = null;
    let sourceUrl = "";
    server.handler = async (req, body, res) => {
      if (req.url === "/converter") {
        const json = JSON.parse(body.toString()) as { url: string; token: string };
        expect(verifyJwt(json.token, secret)).toMatchObject({ filetype: "pptx", outputtype: "pdf" });
        sourceUrl = json.url;
        expect(sourceUrl.startsWith(`${cdeBase}/wopi/convert/`)).toBe(true);
        source = Buffer.from(await (await fetch(sourceUrl)).arrayBuffer());
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ endConvert: true, percent: 100, fileUrl: `${server.base}/cache/out.pdf` }));
        return;
      }
      if (req.url === "/cache/out.pdf") res.end(await realPdf("ONLYOFFICE PDF"));
    };
    const put = await admin("PUT", "/admin/office", { converter: { kind: "onlyoffice", url: server.base }, wopiBaseUrl: cdeBase, jwtSecret: secret });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const pptx = Buffer.from("PK\u0003\u0004 sunum baytları");
    const vid = await upload("Sunum.pptx", pptx);
    const pv = await pdfPreview(vid);
    expect(pv, pv?.error ?? "").toMatchObject({ kind: "pdf", status: "ready" });
    expect(source).toEqual(pptx);
    // The ticket is single-use and unknown tickets are refused.
    expect((await fetch(sourceUrl)).status).toBe(404);
    expect((await fetch(`${cdeBase}/wopi/convert/not-a-ticket/x.docx`)).status).toBe(404);
  });
});
