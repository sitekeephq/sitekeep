/**
 * Official letters ("Yazışmalar"), ported from the Odoo module sevend_yazismalar's tests:
 * numbering, recipient prefill, self reference, thread, reply flow, translations before sending,
 * archive / cancel / delete rules, the letter PDF and the e-mail (.eml and SMTP via a capture
 * transport — nothing leaves the process), AI translation with a fake local model, MCP tools.
 */
import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users, workTypes } from "../../../src/db/schema.js";
import { extractPdfText } from "../../../src/docintel/extract.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const YEAR = new Date().getFullYear();

// Captured SMTP messages: a jsonTransport builds the message, nothing is sent.
const sent: SendMailOptions[] = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const capture = {
  sendMail: async (m: SendMailOptions) => {
    sent.push(m);
    return json.sendMail(m);
  },
} as unknown as Transporter;

// Fake OpenAI-compatible model on 127.0.0.1 (allowed in "local_only").
let stub: Server;
let stubUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-letters-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({
    db: handle.db,
    storage,
    jobs: new JobQueue(handle.db, storage),
    secretKey: Buffer.alloc(32, 5),
    mailer: { transport: capture, from: "cde@7d.test" },
  });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const answer = '```json\n{"subject":"Project approval answer","body":"English body","body2":"","signerTitle":"Project Manager"}\n```';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] }));
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

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
  };
}
type Client = ReturnType<typeof api>;

/** All text items of a PDF, one per line (pdf.js text layer). */
async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const out = await extractPdfText({ data: new Uint8Array(bytes) }, { maxPages: 50 });
  return { text: out.pages.map((p) => p.items.map((i) => i.s).join("\n")).join("\n"), pages: out.pageCount };
}

/** Quoted-printable decoding of a whole message (enough to search the text part). */
function qpDecode(s: string): string {
  const flat = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    const hex = flat.slice(i + 1, i + 3);
    if (flat[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(flat[i]!, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

describe("yazışmalar (official letters on works)", () => {
  let admin: Client, murat: Client, eve: Client, semih: Client;
  const ids: Record<string, string> = {};
  let pid: string, rootId: string;
  const P = () => `/projects/${pid}`;
  let incomingId: string, replyId: string, replyNumber: string;

  it("stores address and e-mail on companies", async () => {
    admin = api(await login("admin@7d.test"));
    ids.PAS = (await admin.post("/companies", { name: "PAS", code: "PAS" })).body.id;
    const bad = await admin.post("/companies", { name: "KGM", email: "evrak-at-kgm" });
    expect(bad.status).toBe(400);
    const kgm = await admin.post("/companies", {
      name: "Karayolları Genel Müdürlüğü",
      code: "KGM",
      address: "İnönü Bulvarı No:14\nAnkara",
      email: "evrak@kgm.example.com",
    });
    expect(kgm.status, JSON.stringify(kgm.body)).toBe(200);
    expect(kgm.body).toMatchObject({ address: "İnönü Bulvarı No:14\nAnkara", email: "evrak@kgm.example.com" });
    ids.KGM = kgm.body.id;
    ids.NOM = (await admin.post("/companies", { name: "Adressiz", code: "NOM" })).body.id;
    const upd = await admin.patch(`/companies/${ids.NOM}`, { address: "  ", email: "" });
    expect(upd.body).toMatchObject({ address: null, email: null, code: "NOM" });

    const p = await admin.post("/projects", { code: "YZ", name: "Yazışma testi" });
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    for (const [key, company, name] of [
      ["murat", "PAS", "Murat"],
      ["eve", "PAS", "Eve"],
      ["semih", "KGM", "Semih"],
    ] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@yz.test`, name, password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@yz.test` })).status).toBe(200);
    }
    murat = api(await login("murat@yz.test"));
    eve = api(await login("eve@yz.test"));
    semih = api(await login("semih@yz.test"));
    expect((await murat.patch(`/companies/${ids.KGM}`, { email: "x@y.z" })).status).toBe(403);
    const list = (await murat.get("/companies")).body;
    expect(list.find((c: { id: string }) => c.id === ids.KGM).email).toBe("evrak@kgm.example.com");
  });

  it("upgrades built-in letter types once and numbers GEL / GID letters", async () => {
    const types = (await admin.get(`${P()}/work-types`)).body;
    const gelen = types.find((t: { key: string }) => t.key === "gelen-yazi");
    const giden = types.find((t: { key: string }) => t.key === "giden-yazi");
    for (const t of [gelen, giden]) {
      expect(t.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(["proje_kodu", "seri", "departman", "sube"]));
      expect(t.statuses.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(["arsivlendi", "iptal"]));
    }
    expect(giden.fields[0].key).toBe("belge_no");
    expect(gelen.fields.map((f: { key: string }) => f.key)).not.toContain("belge_no");
    // A project seeded before this version: no new fields or statuses, and a label edited by the admin.
    await handle.db
      .update(workTypes)
      .set({
        fields: [{ key: "sayi", label: "Karşı tarafın sayısı", type: "text" }, { key: "tarih", label: "Yazı tarihi", type: "date" }],
        statuses: gelen.statuses.filter((s: { key: string }) => s.key !== "arsivlendi" && s.key !== "iptal"),
        settings: { incoming: true, replyTypeKey: "giden-yazi" },
      })
      .where(eq(workTypes.id, gelen.id));
    const up = (await murat.get(`${P()}/work-types`)).body.find((t: { key: string }) => t.key === "gelen-yazi");
    expect(up.fields[0]).toEqual({ key: "sayi", label: "Karşı tarafın sayısı", type: "text" });
    expect(up.fields.map((f: { key: string }) => f.key)).toEqual(["sayi", "tarih", "konu", "ozet", "proje_kodu", "seri", "departman", "sube"]);
    expect(up.statuses.map((s: { key: string }) => s.key).slice(-2)).toEqual(["arsivlendi", "iptal"]);
    // Idempotent; a field the admin removes later is not added back.
    const again = (await murat.get(`${P()}/work-types`)).body.find((t: { key: string }) => t.key === "gelen-yazi");
    expect(again.fields).toHaveLength(8);
    const removed = await admin.put(`${P()}/work-types/${gelen.id}`, {
      fields: up.fields.filter((f: { key: string }) => f.key !== "sube"),
      numberingPattern: "GEL-{YYYY}-{00000}",
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const after = (await murat.get(`${P()}/work-types`)).body.find((t: { key: string }) => t.key === "gelen-yazi");
    expect(after.fields.map((f: { key: string }) => f.key)).not.toContain("sube");
    expect((await admin.put(`${P()}/work-types/${giden.id}`, { numberingPattern: "GID-{YYYY}-{00000}" })).status).toBe(200);
  });

  it("prefills the recipient from the company; edits are kept", async () => {
    const inc = await murat.post(`${P()}/works`, {
      typeKey: "gelen-yazi",
      title: "Proje onayı",
      fromCompanyId: ids.KGM,
      fields: { sayi: "E-12345", tarih: "2026-03-05", proje_kodu: "P.87.1019", departman: "Yapı İşleri" },
      letter: { translations: { en: { subject: "Project approval" } } },
    });
    expect(inc.status, JSON.stringify(inc.body)).toBe(200);
    incomingId = inc.body.id;
    expect(inc.body.number).toBe(`GEL-${YEAR}-00001`);
    expect(inc.body.letter.data.recipient).toEqual({
      name: "Karayolları Genel Müdürlüğü",
      address: "İnönü Bulvarı No:14\nAnkara",
      email: "evrak@kgm.example.com",
    });
    expect(inc.body.letter).toMatchObject({ pdf: false, threadCount: 0, canEditLetter: true, smtp: true });

    const out = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Bilgi", toCompanyIds: [ids.KGM] });
    expect(out.body.number).toBe(`GID-${YEAR}-00001`);
    expect(out.body.letter.data.recipient.email).toBe("evrak@kgm.example.com");
    const edited = await murat.put(`${P()}/works/${out.body.id}/letter`, { recipient: { name: "Genel Müdür" } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const body = await murat.put(`${P()}/works/${out.body.id}/letter`, { body: "Bilgilerinize." });
    expect(body.body.letter.data.recipient).toMatchObject({ name: "Genel Müdür", email: "evrak@kgm.example.com" });
    expect((await murat.put(`${P()}/works/${out.body.id}/letter`, { ccEmails: ["yok"] })).status).toBe(400);
    expect((await semih.put(`${P()}/works/${out.body.id}/letter`, { body: "x" })).status).toBe(404);
    ids.info = out.body.id;
  });

  it("forbids self reference and builds the thread in both directions", async () => {
    const self = await murat.post(`${P()}/works/${incomingId}/links`, { kind: "work", targetId: incomingId });
    expect(self.status).toBe(400);

    const reply = await murat.post(`${P()}/works/${incomingId}/reply`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    replyId = reply.body.id;
    replyNumber = reply.body.number;
    expect(reply.body).toMatchObject({
      typeKey: "giden-yazi",
      title: "RE: Proje onayı",
      status: "taslak",
      toCompanyIds: [ids.KGM],
      number: `GID-${YEAR}-00002`,
      fields: { proje_kodu: "P.87.1019", departman: "Yapı İşleri" },
    });
    expect(reply.body.letter.data.translations).toEqual({ en: { subject: "RE: Project approval" } });
    expect(reply.body.letter.data.recipient.email).toBe("evrak@kgm.example.com");
    expect(reply.body.links).toEqual([expect.objectContaining({ kind: "work", role: "ilgi", targetId: incomingId, meta: { reply: true } })]);
    // Opening a reply does not answer the incoming letter.
    expect((await murat.get(`${P()}/works/${incomingId}`)).body.status).toBe("alindi");

    const follow = await murat.post(`${P()}/works`, {
      typeKey: "gelen-yazi",
      title: "Ek bilgi",
      fromCompanyId: ids.KGM,
      links: [{ kind: "work", targetId: replyId }],
    });
    const unrelated = await murat.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "Başka", fromCompanyId: ids.KGM });
    const inc = (await murat.get(`${P()}/works/${incomingId}`)).body;
    expect(inc.backlinks.map((l: { sourceWorkId: string }) => l.sourceWorkId)).toEqual([replyId]);
    expect(inc.letter.threadCount).toBe(2);
    expect(unrelated.body.letter.threadCount).toBe(0);
    const thread = (await murat.get(`${P()}/works/${follow.body.id}/thread`)).body;
    expect(new Set(thread.map((w: { id: string }) => w.id))).toEqual(new Set([incomingId, replyId, follow.body.id]));
    expect(thread.find((w: { id: string }) => w.id === follow.body.id).refs).toEqual([replyId]);
    ids.follow = follow.body.id;
  });

  it("sends a bilingual reply only with translations and answers the incoming letter on send", async () => {
    const put = await murat.put(`${P()}/works/${replyId}/letter`, {
      secondaryLanguage: "en",
      body: "Türkçe metin",
      ccEmails: ["proje@kgm.example.com"],
      signer: { name: "Ali Veli", title: "Proje Müdürü" },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const blocked = await murat.post(`${P()}/works/${replyId}/send`, { channel: "cde" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain("English dilinde basılacak");
    expect((await murat.get(`${P()}/works/${incomingId}`)).body.status).toBe("alindi");
    await murat.put(`${P()}/works/${replyId}/letter`, { translations: { en: { body: "English text", signerTitle: "Project Manager" } } });
    const ok = await murat.post(`${P()}/works/${replyId}/send`, { channel: "cde" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe("gonderildi");
    expect((await murat.get(`${P()}/works/${incomingId}`)).body.status).toBe("cevaplandi");

    // The letter PDF is stored in "Yazılar" and linked to the work.
    const pdfLink = ok.body.links.find((l: { role: string }) => l.role === "kapak");
    expect(pdfLink.target.label).toBe(`${replyNumber}.pdf`);
    expect(ok.body.events.map((e: { kind: string }) => e.kind)).toContain("letter_pdf");
    const root = (await admin.get(`${P()}/folders/${rootId}/contents`)).body;
    const folder = root.folders.find((f: { name: string }) => f.name === "Yazılar");
    expect(folder).toBeTruthy();
    expect((await admin.get(`${P()}/folders/${folder.id}/contents`)).body.files.map((f: { name: string }) => f.name)).toEqual([`${replyNumber}.pdf`]);
    const dl = await semih.get(`${P()}/works/${replyId}/links/${pdfLink.id}/download`);
    expect(dl.status).toBe(200);
    const { text } = await pdfText(dl.raw.rawPayload);
    expect(text).toContain("Sayı / Ref:");
    expect(text).toContain("RE: Proje onayı / RE: Project approval");
    // Sent letters are frozen.
    expect((await murat.put(`${P()}/works/${replyId}/letter`, { body: "değişti" })).status).toBe(409);
  });

  it("requires the translation of a foreign-language letter and distinct languages", async () => {
    const w = await murat.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "Konu",
      toCompanyIds: [ids.KGM],
      letter: { language: "fr", body: "Metin" },
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const send = () => murat.post(`${P()}/works/${w.body.id}/send`, { channel: "cde" });
    expect((await send()).status).toBe(400);
    await murat.put(`${P()}/works/${w.body.id}/letter`, { translations: { fr: { subject: "Objet" } } });
    const noBody = await send();
    expect(noBody.status).toBe(400);
    expect(noBody.body.message).toContain("Français");
    await murat.put(`${P()}/works/${w.body.id}/letter`, { translations: { fr: { body: "Texte" } } });
    expect((await send()).status).toBe(200);
    ids.fr = w.body.id;

    expect((await murat.put(`${P()}/works/${ids.info}/letter`, { secondaryLanguage: "tr" })).status).toBe(400);
    const same = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "x", letter: { language: "en", secondaryLanguage: "en" } });
    expect(same.status).toBe(400);
  });

  it("prints the official letter PDF with İLGİ lines in each language", async () => {
    // Our earlier letter (sent) and the incoming one are both referenced.
    expect((await murat.post(`${P()}/works/${ids.info}/send`, { channel: "elden" })).status).toBe(200);
    const w = await murat.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "Cevap",
      toCompanyIds: [ids.KGM],
      fields: { tarih: "2026-04-01", proje_kodu: "P.87.1019", belge_no: "BN-0042" },
      links: [
        { kind: "work", targetId: incomingId },
        { kind: "work", targetId: ids.info },
      ],
      letter: {
        body: "Türkçe metin",
        signer: { name: "Ali Veli", title: "Proje Müdürü" },
        translations: {
          en: { subject: "Answer", signerTitle: "Project Manager", body: "English text" },
          de: { subject: "Antwort", body: "Deutscher Text" },
        },
      },
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const url = `${P()}/works/${w.body.id}/letter.pdf`;
    const tr = await murat.get(url);
    expect(tr.status).toBe(200);
    expect(tr.raw.headers["content-type"]).toBe("application/pdf");
    const doc = await PDFDocument.load(tr.raw.rawPayload);
    expect(doc.getTitle()).toBe(w.body.number);
    const t1 = (await pdfText(tr.raw.rawPayload)).text;
    expect(t1).toContain("05.03.2026 tarihli ve E-12345 sayılı yazınız.");
    expect(t1).toMatch(new RegExp(`tarihli ve GID-${YEAR}-00001 sayılı yazımız\\.`));
    expect(t1).toContain("İLGİ:");
    expect(t1).toContain("Proje Müdürü");
    expect(t1).toContain("Türkçe metin");
    expect(t1).toContain("PAS");
    expect(t1).toContain("P.87.1019");
    expect(t1).toContain("Belge No");
    expect(t1).toContain("BN-0042");
    expect(t1).toContain("KARAYOLLARI GENEL MÜDÜRLÜĞÜ");
    expect(t1).not.toContain("English text");
    // The incoming letter (05.03) comes before our letter (today).
    expect(t1.indexOf("yazınız")).toBeLessThan(t1.indexOf("yazımız"));

    await murat.put(`${P()}/works/${w.body.id}/letter`, { language: "en" });
    const t2 = (await pdfText((await murat.get(url)).raw.rawPayload)).text;
    expect(t2).toContain("Your letter No. E-12345 dated 5 March 2026.");
    expect(t2).toContain("Answer");
    expect(t2).toContain("Project Manager");
    expect(t2).toContain("REFERENCES:");
    expect(t2).not.toContain("yazınız");

    await murat.put(`${P()}/works/${w.body.id}/letter`, { language: "de" });
    const t3 = (await pdfText((await murat.get(url)).raw.rawPayload)).text;
    expect(t3).toContain("Ihr Schreiben Nr. E-12345 vom 5. März 2026.");
    expect(t3).toContain("Betreff");
    expect(t3).toContain("Deutscher Text");
    expect(t3).toContain("Proje Müdürü"); // no German title: Turkish fallback

    // Bilingual, both layouts.
    await murat.put(`${P()}/works/${w.body.id}/letter`, { language: "tr", secondaryLanguage: "en" });
    for (const layout of ["columns", "stacked"]) {
      await murat.put(`${P()}/works/${w.body.id}/letter`, { layout });
      const t = (await pdfText((await murat.get(url)).raw.rawPayload)).text;
      for (const s of ["Sayı / Ref:", "Cevap / Answer", "Türkçe metin", "English text", "sayılı yazınız", "Your letter No.", "İLGİ:", "REFERENCES:", "01.04.2026 / 1 April 2026"])
        expect(t, layout).toContain(s);
      expect(t.indexOf("Türkçe metin")).toBeLessThan(t.indexOf("English text"));
    }

    // Long text flows over pages; body2 starts on a new page; every page is numbered.
    const para = "Bu paragraf uzun bir resmi yazının bir parçasıdır ve satırlara bölünerek sayfalara yayılmalıdır. ".repeat(4);
    await murat.put(`${P()}/works/${w.body.id}/letter`, {
      layout: "columns",
      body: Array.from({ length: 40 }, (_, i) => `${i + 1}. ${para}`).join("\n\n"),
      translations: { en: { body: Array.from({ length: 40 }, (_, i) => `${i + 1}. This paragraph is part of a long letter. `.repeat(6)).join("\n\n") } },
    });
    const long = await pdfText((await murat.get(url)).raw.rawPayload);
    expect(long.pages).toBeGreaterThan(2);
    expect(long.pages).toBeLessThan(15);
    expect(long.text).toContain(`${w.body.number} · 1/${long.pages}`);
    expect(long.text).toContain("40. Bu paragraf");
    await murat.put(`${P()}/works/${w.body.id}/letter`, { body2: "Ek sayfa metni\n\n- birinci **kalem**\n- ikinci kalem" });
    const extra = await pdfText((await murat.get(url)).raw.rawPayload);
    expect(extra.pages).toBe(long.pages + 1);
    expect(extra.text).toContain("Ek sayfa metni");

    // Incoming registrations have no letter PDF.
    expect((await murat.get(`${P()}/works/${incomingId}/letter.pdf`)).status).toBe(400);
  });

  it("prepares an .eml and e-mails by SMTP only when configured", async () => {
    const eml = await murat.get(`${P()}/works/${replyId}/letter.eml`);
    expect(eml.status).toBe(200);
    expect(eml.raw.headers["content-type"]).toContain("message/rfc822");
    const raw = eml.raw.body;
    expect(raw).toContain("\r\n");
    expect(raw).toMatch(/^To: /m);
    expect(raw).toContain("<evrak@kgm.example.com>");
    expect(raw).toMatch(/^Cc: proje@kgm\.example\.com/m);
    expect(raw).toMatch(/^From: .*murat@yz\.test/m);
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("application/pdf");
    expect(raw).toContain(`${replyNumber}.pdf`);
    expect(raw).toContain("X-Unsent: 1");
    const text = qpDecode(raw);
    expect(text).toContain(`"RE: Proje onayı" konulu ${replyNumber} sayılı yazımız ekte bilgilerinize sunulmuştur.`);
    expect(text).toContain("Sayın Karayolları Genel Müdürlüğü,");
    expect(text).toContain(`Dear Karayolları Genel Müdürlüğü,`);
    expect(text).toContain(`Please find attached our letter No. ${replyNumber} regarding "RE: Project approval".`);
    expect(text).toContain("Ali Veli\r\nPAS");

    const mailed = await murat.post(`${P()}/works/${replyId}/letter/mail`);
    expect(mailed.status, JSON.stringify(mailed.body)).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "cde@7d.test",
      subject: `${replyNumber} - RE: Proje onayı / RE: Project approval`,
      cc: "proje@kgm.example.com",
    });
    expect(String(sent[0]!.to)).toContain("evrak@kgm.example.com");
    expect(String(sent[0]!.text)).toContain("Sayın");
    expect((sent[0]!.attachments as { filename: string }[])[0]!.filename).toBe(`${replyNumber}.pdf`);
    expect(mailed.body.letter.data.mailSentAt).toBeTruthy();
    expect(mailed.body.events.map((e: { kind: string }) => e.kind)).toContain("mail");
    expect((await murat.post(`${P()}/works/${replyId}/letter/mail-sent`)).status).toBe(409);

    // Drafts are not e-mailed; letters without a recipient e-mail cannot be prepared.
    const draft = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Taslak", toCompanyIds: [ids.NOM] });
    expect((await murat.post(`${P()}/works/${draft.body.id}/letter/mail`)).status).toBe(409);
    expect((await murat.post(`${P()}/works/${draft.body.id}/letter/mail-sent`)).status).toBe(409);
    const noMail = await murat.get(`${P()}/works/${draft.body.id}/letter.eml`);
    expect(noMail.status).toBe(400);
    expect(noMail.body.message).toContain("e-posta");
    expect(sent).toHaveLength(1);
    ids.draft = draft.body.id;

    // Sent from the user's own mail program.
    const mark = await murat.post(`${P()}/works/${ids.fr}/letter/mail-sent`);
    expect(mark.status).toBe(200);
    expect(mark.body.letter.data.mailSentAt).toBeTruthy();
  });

  it("archives, cancels, reopens and deletes by the rules", async () => {
    const L = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Arşivlik", toCompanyIds: [ids.KGM] });
    const url = `${P()}/works/${L.body.id}`;
    expect(L.body.letter).toMatchObject({ canArchive: false, canCancel: true, canReopen: false, canDelete: true });
    expect((await murat.post(`${url}/archive`)).status).toBe(409);
    await murat.post(`${url}/send`, { channel: "cde" });
    const arch = await murat.post(`${url}/archive`);
    expect(arch.status).toBe(200);
    expect(arch.body).toMatchObject({ status: "arsivlendi", closed: true, letter: { canArchive: false, canCancel: false, canDelete: false } });
    expect(arch.body.events.map((e: { kind: string }) => e.kind)).toContain("archived");
    expect((await admin.del(url)).status).toBe(409);
    expect((await murat.post(`${url}/cancel`)).status).toBe(409);
    expect((await murat.post(`${url}/reopen`)).status).toBe(409);
    expect((await murat.patch(url, { status: "gonderildi" })).status).toBe(409);
    ids.archived = L.body.id;

    const M = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "İptallik", toCompanyIds: [ids.KGM] });
    const m = `${P()}/works/${M.body.id}`;
    expect((await murat.patch(m, { status: "iptal" })).status).toBe(409);
    const c = await murat.post(`${m}/cancel`, { comment: "Vazgeçildi" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await murat.get(m)).body).toMatchObject({ status: "iptal", letter: { canReopen: true, canDelete: false } });
    const r = await murat.post(`${m}/reopen`);
    expect(r.body.status).toBe("taslak");
    expect(r.body.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["cancelled", "reopened"]));
    await murat.post(`${m}/cancel`);
    // Cancelled: only a project admin deletes; the creator's colleague cannot, the creator neither.
    expect((await eve.del(m)).status).toBe(403);
    expect((await murat.del(m)).status).toBe(403);
    expect((await admin.del(m)).status).toBe(200);
    expect((await admin.get(m)).status).toBe(404);
    // The creator deletes their own draft.
    expect((await murat.del(`${P()}/works/${ids.draft}`)).status).toBe(200);

    // An answered incoming letter can be cancelled; an addressee cannot cancel ours.
    expect((await murat.post(`${P()}/works/${incomingId}/cancel`)).status).toBe(200);
    expect((await murat.get(`${P()}/works/${incomingId}`)).body.status).toBe("iptal");
    expect((await semih.post(`${P()}/works/${ids.fr}/cancel`)).status).toBe(403);
  });

  it("filters correspondence: awaiting reply, not e-mailed, archive, cancelled", async () => {
    const ask = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "Cevap bekliyoruz", toCompanyIds: [ids.KGM], replyRequired: true });
    await murat.post(`${P()}/works/${ask.body.id}/send`, { channel: "cde" });
    const view = async (v: string) => (await murat.get(`${P()}/works?view=${v}`)).body.map((w: { id: string }) => w.id);
    expect(await view("awaiting")).toEqual([ask.body.id]);
    const unmailed = await view("unmailed");
    expect(unmailed).toEqual(expect.arrayContaining([ask.body.id, ids.info]));
    expect(unmailed).not.toContain(replyId);
    expect(unmailed).not.toContain(ids.fr);
    expect(await view("archived")).toEqual([ids.archived]);
    expect(await view("cancelled")).toEqual([incomingId]);
  });

  it.skipIf(!hasAi)("suggests translations with the configured model (suggestions only)", async () => {
    const url = `${P()}/works/${ids.follow}/letter/translate`;
    expect((await murat.post(url, { language: "en" })).status).toBe(503);
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    expect((await murat.post(url, { language: "tr" })).status).toBe(400);
    await murat.put(`${P()}/works/${ids.follow}/letter`, { body: "Ek bilgi metni", signer: { title: "Proje Müdürü" } });
    const s = await murat.post(url, { language: "en" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toEqual({ language: "en", subject: "Project approval answer", body: "English body", body2: "", signerTitle: "Project Manager" });
    expect((await murat.get(`${P()}/works/${ids.follow}`)).body.letter.data.translations).toEqual({});
    await admin.put("/admin/settings/ai", { mode: "off" });
    const off = await murat.post(url, { language: "en" });
    expect(off.status).toBe(403);
    expect(off.body.error).toBe("ai_off");
    await admin.put("/admin/settings/ai", { mode: "local_only" });
  });

  it.skipIf(!hasAi)("serves the thread and the letter summary to MCP clients", async () => {
    const t = await admin.post("/auth/tokens", { name: "yazisma" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${t.body.token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
      return JSON.parse(res.json().result.content[0].text);
    };
    const thread = await call("cde_work_thread", { projectId: pid, workId: replyId });
    const all = (await murat.get(`${P()}/works/${replyId}/thread`)).body;
    expect(thread.count).toBe(all.length - 1);
    expect(thread.count).toBeGreaterThanOrEqual(2);
    expect(thread.works.find((w: { self?: boolean }) => w.self).number).toBe(replyNumber);
    expect(thread.works.find((w: { id: string }) => w.id === ids.follow).refersTo).toEqual([replyNumber]);
    const detail = await call("cde_work_get", { projectId: pid, workId: replyId });
    expect(detail.letter).toMatchObject({
      languages: ["tr", "en"],
      recipient: "Karayolları Genel Müdürlüğü",
      mailSent: true,
      threadCount: thread.count,
    });
  });
});
