import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { ZipFile } from "yazl";
import { intakeNoTextNote } from "@7dimensions-project/sitekeep-ee-manage/shared/record-intake.js";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { mergeAiAnswer, parseIntake, referencesIn } from "@7dimensions-project/sitekeep-ee-manage/internal/intake.js";
import { decodeHeader, parseEml } from "@7dimensions-project/sitekeep-ee-manage/internal/intake-text.js";
import { readUpload, signUpload } from "../../../src/works/intake-upload.js";

const PW = "Sifre-1234567";
const SECRET = Buffer.alloc(32, 7);
let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;

// Fake OpenAI-compatible model on 127.0.0.1; its answer is set per test. No real model is called.
let stub: Server;
let stubUrl: string;
let stubAnswer = "{}";
let stubPrompts: string[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-intake-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: SECRET, devTools: false });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      stubPrompts.push(body.messages?.map((m: { content: string }) => m.content).join("\n---\n") ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: stubAnswer } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await new Promise((r) => stub.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(auth: { cookie: string } | { token: string }) {
  const headers = "cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  const parse = (res: { body: string; json(): unknown }) => {
    try {
      return res.body ? (res.json() as any) : null;
    } catch {
      return res.body;
    }
  };
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    return { status: res.statusCode, body: parse(res), raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: Uint8Array | string) => {
      const form = new FormData();
      form.append("file", new Blob([typeof data === "string" ? data : Buffer.from(data)]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { ...headers, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: parse(res) };
    },
  };
}
type Client = ReturnType<typeof api>;

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
  });
  const r = res.json() as any;
  const text: string = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { isError: !!(r.error ?? r.result?.isError), text, json };
}

async function toolNames(token: string): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
  });
  return (res.json() as any).result.tools.map((t: { name: string }) => t.name);
}

// ---- Sample files ---------------------------------------------------------------------------

const FONT = readFileSync(path.resolve(__dirname, "../../../assets/fonts/LiberationSans-Regular.ttf"));

/** A Turkish official letter PDF (pdf-lib, embedded font); each row may hold several cells. */
async function letterPdf(rows: (string | [string, string])[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  const page = doc.addPage([595, 842]);
  let y = 790;
  for (const row of rows) {
    if (typeof row === "string") page.drawText(row, { x: 50, y, size: 10, font });
    else {
      page.drawText(row[0], { x: 50, y, size: 10, font });
      page.drawText(row[1], { x: 380, y, size: 10, font });
    }
    y -= 18;
  }
  return doc.save();
}

/** A scan: one page with an image-like rectangle and no text layer. */
async function scannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 40, y: 40, width: 500, height: 760, color: rgb(0.9, 0.9, 0.85) });
  return doc.save();
}

async function docx(paragraphs: string[]): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("") +
    "</w:body></w:document>";
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(xml, "utf8"), "word/document.xml");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream as unknown as Readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function qp(s: string): string {
  return [...Buffer.from(s, "utf8")].map((b) => (b > 126 || b === 61 ? `=${b.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(b))).join("");
}

function eml(o: { from: string; subject: string; date: string; body: string }): string {
  return [
    `From: ${o.from}`,
    "To: belge@cns.com.tr",
    `Subject: =?utf-8?B?${Buffer.from(o.subject, "utf8").toString("base64")}?=`,
    `Date: ${o.date}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="sinir"',
    "",
    "--sinir",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp(o.body),
    "--sinir",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML sürümü <script>alert(1)</script></p>",
    "--sinir--",
    "",
  ].join("\r\n");
}

// ---- Rules (no server) ----------------------------------------------------------------------

describe("record from file: rules", () => {
  const companies = [
    { id: "c-prota", name: "Prota Mühendislik", code: "PRT" },
    { id: "c-hll", name: "HLL Müşavirlik", code: "HLL" },
  ];

  it("reads Sayı, Tarih, Konu, İlgi, sender, due date and reply from an official letter", () => {
    const text = [
      "PROTA MÜHENDİSLİK PROJE VE MÜŞAVİRLİK HİZMETLERİ A.Ş.",
      "Sayı : E-12345678-000-1234  Tarih: 02.10.2026",
      "Konu : B3 bodrum kazı iksa projesi revizyonu hk.",
      "CNS İNŞAAT A.Ş.'NE",
      "İlgi : a) 15.09.2026 tarihli ve CNS-PRT-2026-0007 sayılı yazınız.",
      "b) E-99999999-000-0001 sayılı yazımız.",
      "",
      "Revizyona ilişkin görüşlerinizin 10 gün içinde tarafımıza iletilmesini rica ederiz.",
      "Bu belge 5070 sayılı Elektronik İmza Kanunu gereğince güvenli elektronik imza ile imzalanmıştır.",
    ].join("\n");
    const d = parseIntake(text, { companies, mail: null, fileName: "yazi.pdf", today: "2026-10-11" });
    expect(d).toMatchObject({
      kind: "gelen-yazi",
      title: "B3 bodrum kazı iksa projesi revizyonu",
      sayi: "E-12345678-000-1234",
      date: "2026-10-02",
      fromCompanyId: "c-prota",
      dueDate: "2026-10-12",
      replyRequired: true,
    });
    expect(d.references.map((r) => [r.number, r.date])).toEqual([
      ["CNS-PRT-2026-0007", "2026-09-15"],
      ["E-99999999-000-0001", null],
    ]);
  });

  it("skips laws in İlgi, takes the type from the subject and works with a KEP address only", () => {
    expect(referencesIn("a) 4734 sayılı Kamu İhale Kanunu\nb) 01.10.2026 tarihli ve HLL/2026-45 sayılı yazı").map((r) => r.number)).toEqual(["HLL/2026-45"]);
    const d = parseIntake("KEP: hll@hs01.kep.tr\nSayı: 45\nKonu: Bilgi talebi - şaft ölçüleri\nBilgilerinize.", {
      companies,
      mail: null,
      fileName: "x.pdf",
      today: "2026-10-11",
    });
    expect(d).toMatchObject({ kind: "rfi", kindReason: "Bilgi talebi", fromCompanyId: "c-hll", replyRequired: false, dueDate: null, sayi: "45" });
  });

  it("guards the AI pass: numbers and dates that are not in the text are dropped", () => {
    const excerpt = "Yazı No E-55555555-000-0042, 03.10.2026. Konu: iksa";
    const base = parseIntake(excerpt, { companies, mail: null, fileName: "x.eml", today: "2026-10-11" });
    expect(base.sayi).toBeNull();
    const r = mergeAiAnswer(
      base,
      {
        title: "İksa Projesi",
        sayi: "E-00000000-UYDURMA",
        date: "2026-09-30",
        sender: "Prota",
        references: [{ number: "E-55555555-000-0042" }, { number: "E-11111111-000-9999", date: "2026-10-01" }],
      },
      excerpt,
      { companies, today: "2026-10-11" },
    );
    expect(r.draft.sayi).toBeNull();
    expect(r.draft.date).toBeNull();
    expect(r.draft.fromCompanyId).toBe("c-prota");
    expect(r.draft.title).toBe("İksa Projesi");
    expect(r.draft.references.map((x) => x.number)).toEqual(["E-55555555-000-0042"]);
    expect(r.notes.join(" ")).toContain("E-00000000-UYDURMA");
    expect(r.notes.join(" ")).toContain("E-11111111-000-9999");
    expect(r.draft.aiFields).toEqual(expect.arrayContaining(["title", "fromCompanyId", "references"]));
    const ok = mergeAiAnswer(base, { sayi: "E-55555555-000-0042", date: "2026-10-03" }, excerpt, { companies, today: "2026-10-11" });
    expect(ok.draft).toMatchObject({ sayi: "E-55555555-000-0042", date: "2026-10-03" });
  });

  it("decodes e-mail headers and bodies without running anything", () => {
    expect(decodeHeader("=?utf-8?B?" + Buffer.from("Teknik onay: Çelik", "utf8").toString("base64") + "?=")).toBe("Teknik onay: Çelik");
    expect(decodeHeader("=?iso-8859-9?Q?=DE=FDrket?=")).toBe("Şırket");
    const m = parseEml(Buffer.from(eml({ from: "A <a@b.com>", subject: "Konu", date: "Fri, 02 Oct 2026 09:00:00 +0300", body: "Gövde: ğüşıöç" }), "latin1"));
    expect(m.mail).toEqual({ from: "A <a@b.com>", subject: "Konu", date: "2026-10-02" });
    expect(m.body).toContain("Gövde: ğüşıöç");
    expect(m.body).not.toContain("alert");
  });

  it("signs uploads for one project, user and deadline", () => {
    const u = { projectId: "p1", userId: "u1", obj: { key: "projects/0a/files/x", size: 3, sha256: "h" }, name: "a.pdf", expiresAt: Date.now() + 1000 };
    const t = signUpload(SECRET, u);
    expect(readUpload(SECRET, t, "p1", "u1").obj.key).toBe("projects/0a/files/x");
    // HttpError: Error.message is English (logs); the client text is the Msg, rendered per request.
    const bad = expect.objectContaining({ code: "bad_upload", msg: { key: "works:errors.badUpload" } });
    expect(() => readUpload(SECRET, t, "p1", "u2")).toThrow(bad);
    expect(() => readUpload(Buffer.alloc(32, 1), t, "p1", "u1")).toThrow(bad);
    expect(() => readUpload(SECRET, t, "p1", "u1", Date.now() + 5000)).toThrow(expect.objectContaining({ code: "upload_expired", msg: { key: "works:errors.uploadExpired" } }));
  });
});

// ---- Server ---------------------------------------------------------------------------------

describe("record from file (Bırak, kaydet)", () => {
  let admin: Client, semih: Client, aytug: Client, eve: Client;
  let pid: string;
  const ids: Record<string, string> = {};
  let outNumber: string;
  let incomingWithSayi: string;
  let semihToken: string;
  let semihRead: string;
  let storedFileId: string;
  let providerId: string;
  let wipId: string;
  const P = () => `/projects/${pid}`;

  it("sets up a project with companies, members and two letters to refer to", async () => {
    admin = api({ cookie: await login("admin@7d.test") });
    await admin.put("/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    for (const [name, code] of [
      ["CNS İnşaat", "CNS"],
      ["Prota Mühendislik", "PRT"],
      ["HLL Müşavirlik", "HLL"],
      ["DİS Yapı Denetim", "DIS"],
    ])
      ids[code!] = (await admin.post("/companies", { name, code })).body.id;
    const p = await admin.post("/projects", { code: "BRK", name: "Bırak Kaydet" });
    pid = p.body.id;
    for (const [key, company] of [
      ["semih", "CNS"],
      ["aytug", "HLL"],
    ] as const) {
      await admin.post("/users", { email: `${key}@b.test`, name: key, password: PW, companyId: ids[company] });
      expect((await admin.post(`${P()}/members`, { email: `${key}@b.test` })).status).toBe(200);
    }
    await admin.post("/users", { email: "eve@b.test", name: "Eve", password: PW, companyId: ids.DIS });
    semih = api({ cookie: await login("semih@b.test") });
    aytug = api({ cookie: await login("aytug@b.test") });
    eve = api({ cookie: await login("eve@b.test") });
    const out = await semih.post(`${P()}/works`, { typeKey: "giden-yazi", title: "İksa projesi talebi", toCompanyIds: [ids.PRT] });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    outNumber = out.body.number;
    const inc = await semih.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "Önceki Prota yazısı", fromCompanyId: ids.PRT, fields: { sayi: "E-99999999-000-0001" } });
    incomingWithSayi = inc.body.id;
    const s = api({ cookie: await login("semih@b.test") });
    semihToken = (await s.post("/auth/tokens", { name: "Claude Code", scope: "write" })).body.token;
    semihRead = (await s.post("/auth/tokens", { name: "okuma" })).body.token;
  });

  let pdfDraft: any;
  let pdfBytes: Uint8Array;

  it("PDF letter: Sayı, Tarih, Konu, İlgi (linked to works), sender and due date with AI off", async () => {
    const pdf = await letterPdf([
      "PROTA MÜHENDİSLİK PROJE VE MÜŞAVİRLİK HİZMETLERİ A.Ş.",
      "Bilkent Plaza, Ankara",
      ["Sayı : E-12345678-000-1234", "Tarih: 02.10.2026"],
      "Konu : B3 bodrum kazı iksa projesi revizyonu hk.",
      "",
      "CNS İNŞAAT A.Ş.'NE",
      `İlgi : a) 15.09.2026 tarihli ve ${outNumber} sayılı yazınız.`,
      "b) 20.09.2026 tarihli ve E-99999999-000-0001 sayılı yazımız.",
      "",
      "İlgi (a) yazınızda istenen iksa projesi revizyonu ekte gönderilmiştir. Görüşlerinizin 10 gün içinde",
      "tarafımıza iletilmesini rica ederiz.",
      "Bu belge 5070 sayılı Elektronik İmza Kanunu gereğince güvenli elektronik imza ile imzalanmıştır.",
    ]);
    pdfBytes = pdf;
    const r = await semih.upload(`${P()}/record-from-file`, "Prota yazısı.pdf", pdf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pdfDraft = r.body;
    expect(r.body.draft).toMatchObject({
      kind: "gelen-yazi",
      title: "B3 bodrum kazı iksa projesi revizyonu",
      sayi: "E-12345678-000-1234",
      date: "2026-10-02",
      subject: "B3 bodrum kazı iksa projesi revizyonu",
      fromCompanyId: ids.PRT,
      dueDate: "2026-10-12",
      replyRequired: true,
      aiFields: [],
    });
    expect(r.body.draft.references).toMatchObject([
      { number: outNumber, date: "2026-09-15", workNumber: outNumber },
      { number: "E-99999999-000-0001", date: "2026-09-20", workId: incomingWithSayi },
    ]);
    expect(r.body.file).toMatchObject({ name: "Prota yazısı.pdf", format: "pdf", versionId: null });
    expect(r.body.file.uploadId).toEqual(expect.any(String));
    expect(r.body).toMatchObject({ noTextLayer: false, ai: { available: false, used: false } });
    // Nothing was created yet.
    expect((await semih.get(`${P()}/works?category=correspondence`)).body).toHaveLength(2);
  });

  it("Kaydet: the work is created with the original attached in Yazılar and the ilgi links", async () => {
    const d = pdfDraft.draft;
    const types = (await semih.get(`${P()}/work-types`)).body;
    const gelen = types.find((t: any) => t.key === "gelen-yazi");
    const w = await semih.post(`${P()}/works`, {
      typeId: gelen.id,
      title: d.title,
      fromCompanyId: d.fromCompanyId,
      fields: { sayi: d.sayi, tarih: d.date, konu: d.subject },
      dueDate: d.dueDate,
      replyRequired: d.replyRequired,
      links: d.references.filter((r: any) => r.workId).map((r: any) => ({ kind: "work", targetId: r.workId, role: "ilgi" })),
      sourceUploadId: pdfDraft.file.uploadId,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body).toMatchObject({ status: "alindi", fromCompanyId: ids.PRT, dueDate: "2026-10-12", replyRequired: true });
    const ek = w.body.links.find((l: any) => l.role === "ek");
    expect(ek).toMatchObject({ kind: "file_version", target: { label: expect.stringContaining("Prota yazısı.pdf") } });
    expect(w.body.links.filter((l: any) => l.role === "ilgi")).toHaveLength(2);
    // The file is a project file in "Yazılar"; the work's people download it.
    const root = (await admin.get(`${P()}`)).body.rootFolderId;
    const folders = (await admin.get(`${P()}/folders/${root}/contents`)).body.folders;
    const yazilar = folders.find((f: any) => f.name === "Yazılar");
    expect(yazilar).toBeTruthy();
    const files = (await admin.get(`${P()}/folders/${yazilar.id}/contents`)).body.files;
    expect(files.map((f: any) => f.name)).toContain(`${w.body.number}_Prota yazısı.pdf`);
    const dl = await semih.get(`${P()}/works/${w.body.id}/links/${ek.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.raw.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    // The reference belongs to this user and project only.
    const stolen = await aytug.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "x", sourceUploadId: pdfDraft.file.uploadId });
    expect(stolen.status).toBe(400);
    const forged = await semih.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "x", sourceUploadId: `${pdfDraft.file.uploadId}x` });
    expect(forged.status).toBe(400);
  });

  it(".eml: From, Subject, Date and the type from the subject (Teknik Onay), sender by short code", async () => {
    const mail = eml({
      from: '"HLL Müşavirlik" <info@hll-musavirlik.com.tr>',
      subject: "Teknik onay: C30 beton numunesi",
      date: "Mon, 05 Oct 2026 10:12:00 +0300",
      body: "Sayın ilgili,\n\nSayı: HLL-2026-145\nC30 beton numunesine ait teknik onay dosyasının 5 iş günü içinde gönderilmesini rica ederiz.\n\nSaygılarımızla",
    });
    const r = await semih.upload(`${P()}/record-from-file`, "numune.eml", mail);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.draft).toMatchObject({
      kind: "submittal",
      title: "Teknik onay: C30 beton numunesi",
      fromCompanyId: ids.HLL,
      sayi: "HLL-2026-145",
      date: "2026-10-05",
      dueDate: "2026-10-12",
      replyRequired: true,
    });
    expect(r.body.excerpt).not.toContain("<script");
  });

  it(".docx: Konu says Bilgi Talebi; date written with the month name", async () => {
    const file = await docx([
      "DİS YAPI DENETİM LTD. ŞTİ.",
      "Sayı: DIS-2026-9",
      "Tarih: 5 Ekim 2026",
      "Konu: Bilgi talebi - şaft ölçüleri",
      `İlgi: ${outNumber} sayılı yazınız.`,
      "Mekanik şaft ölçülerinin bildirilmesi rica olunur.",
    ]);
    const r = await semih.upload(`${P()}/record-from-file`, "bilgi-talebi.docx", file);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // DİS has no member and no work in the project: not a project company, the sender stays as read.
    expect(r.body.draft).toMatchObject({ kind: "rfi", sayi: "DIS-2026-9", date: "2026-10-05", fromCompanyId: null, fromText: "DİS YAPI DENETİM LTD. ŞTİ.", replyRequired: true, title: "Bilgi talebi - şaft ölçüleri" });
    expect(r.body.draft.references).toMatchObject([{ number: outNumber, workNumber: outNumber }]);
  });

  it("scanned PDF: says there is no text layer, keeps the file attached", async () => {
    const r = await semih.upload(`${P()}/record-from-file`, "tarama.pdf", await scannedPdf());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ noTextLayer: true, excerpt: "", draft: { kind: "gelen-yazi", title: "tarama", sayi: null } });
    expect(r.body.notes[0]).toBe(intakeNoTextNote());
    const w = await semih.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "Taranmış yazı", fromCompanyId: ids.PRT, sourceUploadId: r.body.file.uploadId });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.links.filter((l: any) => l.role === "ek")).toHaveLength(1);
  });

  it("refuses other formats, too large files, non-members and files the caller cannot see", async () => {
    expect((await semih.upload(`${P()}/record-from-file`, "resim.png", "x")).status).toBe(400);
    expect((await semih.upload(`${P()}/record-from-file`, "dev.pdf", new Uint8Array(50 * 1024 * 1024 + 10))).status).toBe(413);
    expect((await eve.upload(`${P()}/record-from-file`, "yazi.pdf", await scannedPdf())).status).toBe(404);
    // A file in a folder only HLL sees: semih gets 404 by id.
    const root = (await admin.get(`${P()}`)).body.rootFolderId;
    const wip = (await admin.get(`${P()}/folders/${root}/contents`)).body.folders.find((f: any) => f.name !== "Yazılar");
    wipId = wip.id;
    await admin.put(`${P()}/folders/${wip.id}/permissions`, { entries: [{ subjectType: "company", subjectId: ids.HLL, level: "edit" }] });
    const up = await aytug.upload(`${P()}/folders/${wip.id}/files`, "HLL-yazi.pdf", await letterPdf(["HLL MÜŞAVİRLİK", "Sayı: HLL-2026-200", "Konu: Gizli"]));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const file = (await aytug.get(`${P()}/folders/${wip.id}/contents`)).body.files.find((f: any) => f.name === "HLL-yazi.pdf");
    expect((await semih.post(`${P()}/record-from-file`, { fileId: file.id })).status).toBe(404);
    const own = await aytug.post(`${P()}/record-from-file`, { versionId: file.latest.id });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ file: { versionId: file.latest.id, uploadId: null }, draft: { sayi: "HLL-2026-200", fromCompanyId: null } });
  });

  it.skipIf(!hasAi)("AI on (mocked model): fills gaps, normalises the title, drops invented numbers", async () => {
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    providerId = prov.body.id;
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    stubAnswer = JSON.stringify({
      type: "gelen-yazi",
      title: "İksa Projesi Revizyonu",
      sender: "Prota Mühendislik",
      sayi: "E-55555555-000-0042",
      references: [{ number: "E-00000000-000-0000" }],
      replyRequired: true,
    });
    stubPrompts = [];
    const mail = eml({ from: "bilgi@ornek.com", subject: "iksa", date: "Tue, 06 Oct 2026 08:00:00 +0300", body: "Yazı No E-55555555-000-0042 ile iksa revizyonu gönderilmiştir." });
    const r = await semih.upload(`${P()}/record-from-file?ai=1`, "iksa.eml", mail);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ai).toEqual({ available: true, used: true, error: null });
    expect(r.body.draft).toMatchObject({ title: "İksa Projesi Revizyonu", sayi: "E-55555555-000-0042", fromCompanyId: ids.PRT, references: [], replyRequired: true });
    expect(r.body.draft.aiFields).toEqual(expect.arrayContaining(["title", "sayi", "fromCompanyId"]));
    expect(r.body.notes.join(" ")).toContain("E-00000000-000-0000");
    // The model saw only the excerpt and the rule-based result.
    expect(stubPrompts).toHaveLength(1);
    expect(stubPrompts[0]).toContain("Kural tabanlı sonuç");
    expect(stubPrompts[0]).toContain("E-55555555-000-0042");

    // The same pass on its own (button "Yapay Zekâ ile Tamamla").
    const again = await semih.post(`${P()}/ai/record-from-file`, { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.draft).toMatchObject({ title: "İksa Projesi Revizyonu", sayi: "E-12345678-000-1234", fromCompanyId: ids.PRT });
    expect(again.body.draft.references.map((x: any) => x.number)).toEqual([outNumber, "E-99999999-000-0001"]);
    stubAnswer = "bu JSON değil";
    expect((await semih.post(`${P()}/ai/record-from-file`, { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft })).status).toBe(502);
    const soft = await semih.upload(`${P()}/record-from-file?ai=1`, "iksa.eml", mail);
    expect(soft.body.ai).toMatchObject({ available: true, used: false, error: expect.stringContaining("geçerli") });
    expect(soft.body.draft.sayi).toBeNull();
  });

  it.skipIf(!hasAi)("AI off: rules only; the AI pass is refused", async () => {
    await admin.put("/admin/settings/ai", { mode: "off" });
    try {
      const r = await semih.upload(`${P()}/record-from-file?ai=1`, "Prota yazısı.pdf", await letterPdf(["PROTA MÜHENDİSLİK", "Sayı: E-1-2-3", "Konu: Deneme"]));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ai: { available: false, used: false }, draft: { sayi: "E-1-2-3", fromCompanyId: ids.PRT, aiFields: [] } });
      const off = await semih.post(`${P()}/ai/record-from-file`, { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft });
      expect(off.status).toBe(403);
      expect(off.body.error).toBe("ai_off");
      expect((await semih.get(`${P()}/ai-tasks/status`)).body.allowed).toBe(false);
    } finally {
      await admin.put("/admin/settings/ai", { mode: "local_only" });
    }
  });

  it.skipIf(!hasAi)("no provider: the AI pass goes through the task queue (record_from_file)", async () => {
    await admin.put("/admin/settings/ai", { defaultProviderId: null, taskQueue: { enabled: true, allowExternalClients: true } });
    expect((await admin.del(`/admin/ai/providers/${providerId}`)).status).toBe(200);
    const noProv = await semih.post(`${P()}/ai/record-from-file`, { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft });
    expect([503, 409]).toContain(noProv.status);
    const status = (await semih.get(`${P()}/ai-tasks/status`)).body;
    expect(status).toMatchObject({ enabled: true, allowed: true, providerAvailable: false });
    const t = await semih.post(`${P()}/ai-tasks`, { kind: "record_from_file", input: { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft } });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body).toMatchObject({ kind: "record_from_file", label: "Dosyadan Kayıt Taslağı", summary: "B3 bodrum kazı iksa projesi revizyonu" });
    const claim = await tool(semihToken, "cde_ai_task_claim", { projectId: pid, taskId: t.body.id });
    expect(claim.isError, claim.text).toBe(false);
    expect(claim.text).toContain("Kural tabanlı sonuç");
    const done = await tool(semihToken, "cde_ai_task_complete", {
      projectId: pid,
      taskId: t.body.id,
      result: { title: "B3 Kazı İksa Projesi Revizyonu", sayi: "E-00000000-UYDURMA" },
    });
    expect(done.isError, done.text).toBe(false);
    const task = (await semih.get(`${P()}/ai-tasks/${t.body.id}`)).body;
    expect(task.status).toBe("done");
    expect(task.result.draft).toMatchObject({ title: "B3 Kazı İksa Projesi Revizyonu", sayi: "E-12345678-000-1234" });
  });

  it.skipIf(!hasAi)("MCP cde_record_from_file: draft of an uploaded file, optionally created as a draft work (write token)", async () => {
    // An uploaded letter in a folder semih may edit.
    await admin.put(`${P()}/folders/${wipId}/permissions`, {
      entries: [
        { subjectType: "company", subjectId: ids.HLL, level: "edit" },
        { subjectType: "company", subjectId: ids.CNS, level: "edit" },
      ],
    });
    const up = await semih.upload(`${P()}/folders/${wipId}/files`, "Prota yazısı.pdf", pdfBytes);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const file = (await semih.get(`${P()}/folders/${wipId}/contents`)).body.files.find((f: any) => f.name === "Prota yazısı.pdf");
    storedFileId = file.id;
    expect(await toolNames(semihRead)).not.toContain("cde_record_from_file");
    const draft = await tool(semihToken, "cde_record_from_file", { projectId: pid, fileId: file.id });
    expect(draft.isError, draft.text).toBe(false);
    expect(draft.json).toMatchObject({ type: "gelen-yazi", typeLabel: "Gelen Yazı", sayi: "E-12345678-000-1234", sender: "Prota Mühendislik", created: null });
    const made = await tool(semihToken, "cde_record_from_file", { projectId: pid, fileId: file.id, create: true });
    expect(made.isError, made.text).toBe(false);
    expect(made.json.created).toMatchObject({ status: "Taslak" });
    const w = (await semih.get(`${P()}/works/${made.json.created.id}`)).body;
    expect(w).toMatchObject({ status: "taslak", fromCompanyId: ids.PRT, sentAt: null });
    expect(w.fields).toMatchObject({ sayi: "E-12345678-000-1234", tarih: "2026-10-02" });
    expect(w.links.find((l: any) => l.role === "ek")).toMatchObject({ targetId: file.latest.id });
    expect(w.links.filter((l: any) => l.role === "ilgi")).toHaveLength(2);
  });

  it.skipIf(!hasAi)("module switches: a closed type falls back, all closed refuses; Kaydet of a closed type is refused", async () => {
    expect((await admin.put(`${P()}/modules`, { modules: { correspondence: false } })).status).toBe(200);
    try {
      const pdf = await letterPdf(["PROTA MÜHENDİSLİK", "Sayı: E-7", "Konu: Deneme yazısı"]);
      const r = await semih.upload(`${P()}/record-from-file`, "yazi.pdf", pdf);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.draft.kind).toBe("rfi");
      expect(r.body.notes.join(" ")).toContain("Gelen Yazı bu projede kapalı");
      const refused = await semih.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "x", sourceUploadId: r.body.file.uploadId });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("module_disabled");
      const queued = await semih.post(`${P()}/ai-tasks`, { kind: "record_from_file", input: { excerpt: pdfDraft.excerpt, draft: pdfDraft.draft } });
      expect(queued.status).toBe(403);
      await admin.put(`${P()}/modules`, { modules: { correspondence: false, rfi: false, submittals: false, transmittals: false } });
      const all = await semih.upload(`${P()}/record-from-file`, "yazi.pdf", pdf);
      expect(all.status).toBe(403);
      expect(all.body.error).toBe("module_disabled");
      const mcp = await tool(semihToken, "cde_record_from_file", { projectId: pid, fileId: storedFileId });
      expect(mcp.isError).toBe(true);
      expect(mcp.text).toContain("modülü");
    } finally {
      await admin.put(`${P()}/modules`, { modules: { correspondence: true, rfi: true, submittals: true, transmittals: true } });
    }
  });
});
