import { hasManage } from "../helpers/modules.js"; // steps that create RFIs, letters or meetings need Manage
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { eq } from "drizzle-orm";
import { folders, users, workTypes } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { upgradeSeededLabels } from "../../src/projects/seeded-labels.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const YEAR = new Date().getFullYear();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-works-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
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
    upload: async (url: string, fileList: { name: string; data: string }[], fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Client = ReturnType<typeof api>;

describe("works (İşler)", () => {
  let admin: Client, murat: Client, eve: Client, semih: Client, aytug: Client, zeynep: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let rootId: string, wipId: string;
  let versionA1: string, versionB1: string, fileA: string;
  const P = () => `/projects/${pid}`;

  it("sets up a project with four companies", async () => {
    admin = api(await login("admin@7d.test"));
    for (const c of ["PAS", "CNS", "HLL", "ZRT"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects", { code: "WK", name: "İşler testi" });
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    const people: [string, string, string][] = [
      ["murat", "PAS", "Murat"],
      ["eve", "PAS", "Eve"],
      ["semih", "CNS", "Semih"],
      ["aytug", "HLL", "Aytuğ"],
      ["zeynep", "ZRT", "Zeynep"],
    ];
    for (const [key, company, name] of people) {
      ids[key] = (await admin.post("/users", { email: `${key}@wk.test`, name, password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@wk.test` })).status).toBe(200);
    }
    murat = api(await login("murat@wk.test"));
    eve = api(await login("eve@wk.test"));
    semih = api(await login("semih@wk.test"));
    aytug = api(await login("aytug@wk.test"));
    zeynep = api(await login("zeynep@wk.test"));

    wipId = (await admin.get(`${P()}/folders/${rootId}/contents`)).body.folders[0].id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.PAS, level: "edit" }],
    });
    const up = await murat.upload(
      `${P()}/folders/${wipId}/files`,
      [
        { name: "A.pdf", data: "A içerik v1" },
        { name: "B.pdf", data: "B içerik v1" },
      ],
      { attributes: JSON.stringify({ Revizyon: "R01" }) },
    );
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const files = (await murat.get(`${P()}/folders/${wipId}/contents`)).body.files;
    fileA = files[0].id;
    [versionA1, versionB1] = files.map((f: { latest: { id: string } }) => f.latest.id);
  });

  it("seeds the built-in types on first use", async () => {
    const types = await semih.get(`${P()}/work-types`);
    expect(types.status).toBe(200);
    expect(types.body.map((t: { key: string }) => t.key).sort()).toEqual(["aksiyon", "gelen-yazi", "giden-yazi", "rfi", "submittal-kalemi", "submittal-paketi", "toplanti", "transmittal"]);
    expect(types.body.every((t: { builtIn: boolean }) => t.builtIn)).toBe(true);
    // A second call does not duplicate them.
    expect((await murat.get(`${P()}/work-types`)).body).toHaveLength(8);
  });

  it.skipIf(!hasManage)("gives unique numbers to concurrent creates, one counter per scope", async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: `Yazı ${i}`, toCompanyIds: [ids.CNS] }),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const numbers = results.map((r) => r.body.number as string);
    expect(new Set(numbers).size).toBe(15);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 15 }, (_, i) => `WK-PAS-CNS-${YEAR}-${String(i + 1).padStart(4, "0")}`),
    );
    // Another recipient → another scope, counting from 1.
    const hll = await murat.post(`${P()}/works`, { typeKey: "giden-yazi", title: "HLL'ye", toCompanyIds: [ids.HLL] });
    expect(hll.body.number).toBe(`WK-PAS-HLL-${YEAR}-0001`);
    // Incoming registration: own pattern and counter, status "alındı".
    const gelen = await eve.post(`${P()}/works`, {
      typeKey: "gelen-yazi",
      title: "İdare yazısı",
      fromCompanyId: ids.ZRT,
      fields: { sayi: "E-123", tarih: "2026-10-01" },
    });
    expect(gelen.status, JSON.stringify(gelen.body)).toBe(200);
    expect(gelen.body).toMatchObject({ number: `WK-GLN-${YEAR}-0001`, status: "alindi", canSend: false });
    // Invalid field values are rejected.
    const bad = await eve.post(`${P()}/works`, { typeKey: "gelen-yazi", title: "x", fields: { tarih: "dün", yok: "1" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("Bilinmeyen alan");
  });

  let letterId: string, replyId: string;

  it.skipIf(!hasManage)("hides drafts from addressees and applies the visibility rule", async () => {
    const r = await murat.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "Asma tavan projeleri",
      toCompanyIds: [ids.CNS],
      ccCompanyIds: [ids.ZRT],
      replyRequired: true,
      dueDate: "2000-01-01",
      fields: { konu: "Asma tavan", tarih: "2026-10-10" },
    });
    expect(r.status).toBe(200);
    letterId = r.body.id;
    expect(r.body).toMatchObject({ status: "taslak", canSend: true, canEdit: true, fromCompanyId: ids.PAS });

    // Draft: addressees don't see it, the owner company does.
    expect((await semih.get(`${P()}/works/${letterId}`)).status).toBe(404);
    expect((await eve.get(`${P()}/works/${letterId}`)).status).toBe(200);
    expect((await semih.get(`${P()}/works`)).body.some((w: { id: string }) => w.id === letterId)).toBe(false);

    const sent = await murat.post(`${P()}/works/${letterId}/send`, { channel: "cde" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ status: "gonderildi", delivery: { channel: "cde", status: "delivered" } });

    // Sent: gereği (CNS) and bilgi (ZRT) recipients see it; HLL does not; admins see everything.
    expect((await semih.get(`${P()}/works/${letterId}`)).status).toBe(200);
    expect((await zeynep.get(`${P()}/works/${letterId}`)).status).toBe(200);
    expect((await aytug.get(`${P()}/works/${letterId}`)).status).toBe(404);
    expect((await aytug.get(`${P()}/works`)).body.some((w: { id: string }) => w.id === letterId)).toBe(false);
    expect((await admin.get(`${P()}/works/${letterId}`)).status).toBe(200);
    // Recipients may not edit; the owner company may.
    expect((await semih.patch(`${P()}/works/${letterId}`, { title: "x" })).status).toBe(403);
    expect((await eve.patch(`${P()}/works/${letterId}`, { assigneeUserId: ids.eve })).status).toBe(200);
    // Recipients cannot be changed after sending.
    expect((await murat.patch(`${P()}/works/${letterId}`, { toCompanyIds: [ids.HLL] })).status).toBe(409);
    // A project admin of another company sees it.
    await admin.patch(`${P()}/members/${ids.aytug}`, { isProjectAdmin: true });
    expect((await aytug.get(`${P()}/works/${letterId}`)).status).toBe(200);
    await admin.patch(`${P()}/members/${ids.aytug}`, { isProjectAdmin: false });
    expect((await aytug.get(`${P()}/works/${letterId}`)).status).toBe(404);

    const notes = (await semih.get("/notifications")).body;
    expect(notes.some((n: { kind: string; link: string }) => n.kind === "work.sent" && n.link.endsWith(letterId))).toBe(true);
  });

  it.skipIf(!hasManage)("puts the letter in the recipients' 'Bugün' inbox", async () => {
    const t = await semih.get("/me/today");
    expect(t.status).toBe(200);
    const has = (list: { id: string }[]) => list.some((w) => w.id === letterId);
    expect(has(t.body.awaitingReply)).toBe(true);
    expect(has(t.body.toReceive)).toBe(true);
    expect(has(t.body.overdue)).toBe(true);
    expect(t.body.awaitingReply[0]).toMatchObject({ projectCode: "WK", link: `/projects/${pid}/works/${letterId}` });
    // ZRT is only "bilgi": nothing to answer, but it can confirm receipt.
    const z = (await zeynep.get("/me/today")).body;
    expect(has(z.awaitingReply)).toBe(false);
    expect(has(z.toReceive)).toBe(true);
    expect(has(z.overdue)).toBe(false);
    // Eve is the assignee.
    expect(has((await eve.get("/me/today")).body.assigned)).toBe(true);
  });

  it.skipIf(!hasManage)("records receipt and builds a reply chain with 'ilgi' links", async () => {
    const rec = await semih.post(`${P()}/works/${letterId}/receive`);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.status).toBe("alindi");
    expect(rec.body.receipts).toHaveLength(1);
    expect((await semih.post(`${P()}/works/${letterId}/receive`)).status).toBe(409);
    expect((await aytug.post(`${P()}/works/${letterId}/receive`)).status).toBe(404);

    const reply = await semih.post(`${P()}/works/${letterId}/reply`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    replyId = reply.body.id;
    expect(reply.body).toMatchObject({
      typeKey: "giden-yazi",
      title: "RE: Asma tavan projeleri",
      status: "taslak",
      fromCompanyId: ids.CNS,
      toCompanyIds: [ids.PAS],
      ccCompanyIds: [ids.ZRT],
      number: `WK-CNS-PAS-${YEAR}-0001`,
    });
    expect(reply.body.fields.konu).toBe("Asma tavan");
    expect(reply.body.links).toEqual([
      expect.objectContaining({ kind: "work", role: "ilgi", targetId: letterId, meta: { reply: true } }),
    ]);
    // The original is still waiting until the reply is sent.
    expect((await murat.get(`${P()}/works/${letterId}`)).body.status).toBe("alindi");
    const sent = await semih.post(`${P()}/works/${replyId}/send`, { channel: "cde" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const original = (await murat.get(`${P()}/works/${letterId}`)).body;
    expect(original.status).toBe("cevaplandi");
    expect(original.closed).toBe(true);
    expect(original.backlinks.map((l: { sourceWorkId: string }) => l.sourceWorkId)).toEqual([replyId]);
    expect(original.events.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(["created", "sent", "received", "replied", "answered"]),
    );
    // Answered letters leave the inbox.
    expect((await semih.get("/me/today")).body.awaitingReply.some((w: { id: string }) => w.id === letterId)).toBe(false);

    // A third letter refers to the reply: the thread holds all three, oldest first.
    const third = await murat.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "Revize asma tavan",
      toCompanyIds: [ids.CNS],
      links: [{ kind: "work", targetId: replyId }],
    });
    expect(third.status).toBe(200);
    const thread = await murat.get(`${P()}/works/${letterId}/thread`);
    expect(thread.body.map((w: { id: string }) => w.id)).toEqual([letterId, replyId, third.body.id]);
    expect(thread.body[1].refs).toEqual([letterId]);
    expect(thread.body[2].refs).toEqual([replyId]);
    // Semih cannot see the third letter while it is a draft, so his thread stops at the reply.
    expect((await semih.get(`${P()}/works/${replyId}/thread`)).body).toHaveLength(2);
    // Linking a work the caller cannot see fails.
    const hidden = await aytug.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "x",
      links: [{ kind: "work", targetId: third.body.id }],
    });
    expect(hidden.status).toBe(404);
  });

  let transmittalId: string;

  // Transmittals are core (ISO 19650 information exchange): this runs without Manage too.
  it("sends a transmittal with pinned versions and a stored cover PDF", async () => {
    const empty = await murat.post(`${P()}/works`, {
      typeKey: "transmittal",
      title: "Boş",
      toCompanyIds: [ids.CNS],
      fields: { amac: "onay" },
    });
    expect(empty.status).toBe(200);
    const noFiles = await murat.post(`${P()}/works/${empty.body.id}/send`, { channel: "cde" });
    expect(noFiles.status).toBe(400);
    expect((await murat.post(`${P()}/works`, { typeKey: "transmittal", title: "x", toCompanyIds: [ids.CNS] })).status).toBe(400);

    const t = await murat.post(`${P()}/works`, {
      typeKey: "transmittal",
      title: "Mimari set Rev.0",
      toCompanyIds: [ids.CNS],
      ccCompanyIds: [ids.HLL],
      fields: { amac: "onay", not: "Lütfen inceleyin" },
      links: [
        { kind: "file_version", targetId: versionA1 },
        { kind: "file_version", targetId: versionB1 },
      ],
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    transmittalId = t.body.id;
    expect(t.body.number).toBe(`WK-GF-PAS-${YEAR}-0002`);
    expect(t.body.links.map((l: { role: string; target: { revision: string } }) => [l.role, l.target.revision])).toEqual([
      ["ek", "R01"],
      ["ek", "R01"],
    ]);
    // Semih (CNS) cannot link files he cannot see.
    expect((await semih.post(`${P()}/works/${transmittalId}/links`, { kind: "file_version", targetId: versionA1 })).status).toBe(404);

    // A new version of A after the transmittal was prepared does not change it.
    await murat.upload(`${P()}/folders/${wipId}/files`, [{ name: "A.pdf", data: "A içerik v2" }]);
    const sent = await murat.post(`${P()}/works/${transmittalId}/send`, { channel: "cde" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const ek = sent.body.links.filter((l: { role: string }) => l.role === "ek");
    expect(ek.map((l: { targetId: string; target: { version: number } }) => [l.targetId, l.target.version])).toEqual([
      [versionA1, 1],
      [versionB1, 1],
    ]);
    const cover = sent.body.links.find((l: { role: string }) => l.role === "kapak");
    expect(cover.target.label).toBe(`WK-GF-PAS-${YEAR}-0002.pdf`);
    expect(sent.body.events.map((e: { kind: string }) => e.kind)).toContain("cover_pdf");

    // The cover lives in the "Gönderim formları" folder as a normal file version.
    const root = await admin.get(`${P()}/folders/${rootId}/contents`);
    const folder = root.body.folders.find((f: { name: string }) => f.name === "Gönderim formları");
    expect(folder).toBeTruthy();
    const coverFiles = (await admin.get(`${P()}/folders/${folder.id}/contents`)).body.files;
    expect(coverFiles.map((f: { name: string }) => f.name)).toEqual([`WK-GF-PAS-${YEAR}-0002.pdf`]);

    // Recipients download the pinned files and the cover through the work, without folder rights.
    const dl = await semih.get(`${P()}/works/${transmittalId}/links/${ek[0].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.raw.body).toBe("A içerik v1");
    expect((await semih.get(`${P()}/versions/${versionA1}/download`)).status).toBe(404);
    const pdfRes = await semih.get(`${P()}/works/${transmittalId}/links/${cover.id}/download`);
    expect(pdfRes.status).toBe(200);
    const bytes = pdfRes.raw.rawPayload;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe(`WK-GF-PAS-${YEAR}-0002`);
    expect(pdf.getPageCount()).toBe(1);

    // Attachments are frozen after sending; ilgi links are still allowed.
    expect((await murat.post(`${P()}/works/${transmittalId}/links`, { kind: "file_version", targetId: versionA1 })).status).toBe(409);
    // (the letter needs Manage; without it the ilgi goes to the empty transmittal)
    const ilgi = hasManage ? letterId : empty.body.id;
    expect((await murat.post(`${P()}/works/${transmittalId}/links`, { kind: "work", targetId: ilgi })).status).toBe(200);

    // Receipt: only "gereği" receipts move the status; HLL (bilgi) confirms too.
    const hll = await aytug.post(`${P()}/works/${transmittalId}/receive`);
    expect(hll.status).toBe(200);
    expect(hll.body.status).toBe("gonderildi");
    const cns = await semih.post(`${P()}/works/${transmittalId}/receive`);
    expect(cns.body.status).toBe("alindi");
    expect(cns.body.receipts.map((r: { companyName: string }) => r.companyName).sort()).toEqual(["CNS", "HLL"]);
  });

  it.skipIf(!hasManage)("records KEP delivery manually and requires a signed PDF", async () => {
    const w = await murat.post(`${P()}/works`, {
      typeKey: "giden-yazi",
      title: "KEP ile resmi yazı",
      toCompanyIds: [ids.ZRT],
      links: [{ kind: "file_version", targetId: versionB1 }],
    });
    const channels = (await murat.get("/delivery-channels")).body.map((c: { id: string }) => c.id);
    expect(channels).toEqual(["cde", "elden", "eposta", "kep"]);
    const noSig = await murat.post(`${P()}/works/${w.body.id}/send`, { channel: "kep", reference: "KEP-1" });
    expect(noSig.status).toBe(400);
    expect(noSig.body.message).toContain("imzalı PDF");
    const link = w.body.links[0];
    const signed = await murat.patch(`${P()}/works/${w.body.id}/links/${link.id}`, { signed: true });
    expect(signed.body.links[0].meta.signed).toBe(true);
    const sent = await murat.post(`${P()}/works/${w.body.id}/send`, { channel: "kep", reference: "KEP-2026-0042" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.delivery).toMatchObject({ channel: "kep", status: "sent", reference: "KEP-2026-0042", channelLabel: "KEP (manuel)" });
    const upd = await murat.patch(`${P()}/works/${w.body.id}/delivery`, { status: "delivered" });
    expect(upd.body.delivery.status).toBe("delivered");
    expect((await murat.post(`${P()}/works/${w.body.id}/send`, { channel: "cde" })).status).toBe(409);
  });

  let reviewTemplateId: string;

  it("creates and sends a transmittal automatically when a review completes", async () => {
    const tpl = await admin.post(`${P()}/workflow-templates`, {
      kind: "review",
      name: "CNS onayı",
      steps: [
        { name: "CNS", assignees: [{ type: "company", id: ids.CNS }], rule: "any", days: 5, outcomes: ["approved", "rejected"] },
      ],
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    reviewTemplateId = tpl.body.id;
    expect(
      (await murat.put(`${P()}/work-automation/${reviewTemplateId}`, { autoTransmittal: true })).status,
    ).toBe(403);
    const set = await admin.put(`${P()}/work-automation/${reviewTemplateId}`, {
      autoTransmittal: true,
      recipientCompanyIds: [ids.ZRT],
      purpose: "uygulama",
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const auto = (await admin.get(`${P()}/work-automation`)).body;
    expect(auto).toEqual([
      expect.objectContaining({ templateId: reviewTemplateId, autoTransmittal: true, recipientCompanyIds: [ids.ZRT], purpose: "uygulama", send: true }),
    ]);

    const files = (await murat.get(`${P()}/folders/${wipId}/contents`)).body.files;
    const versionA2 = files.find((f: { name: string }) => f.name === "A.pdf").latest.id;
    const r = await murat.post(`${P()}/reviews`, { name: "Set 2 onayı", templateId: reviewTemplateId, versionIds: [versionA2, versionB1] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // While it runs, the review step shows up in Semih's "Bugün".
    const today = (await semih.get("/me/today")).body;
    expect(today.tasks.map((t: { subjectId: string }) => t.subjectId)).toContain(r.body.id);
    expect(today.counts.tasks).toBe(today.tasks.length);

    const before = (await admin.get(`${P()}/works?type=transmittal`)).body.length;
    const [fa, fb] = r.body.files;
    const sub = await semih.post(`${P()}/reviews/${r.body.id}/submit`, {
      files: [
        { reviewFileId: fa.id, outcome: "approved" },
        { reviewFileId: fb.id, outcome: "rejected" },
      ],
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe("completed");

    const list = (await admin.get(`${P()}/works?type=transmittal`)).body;
    expect(list).toHaveLength(before + 1);
    const created = list.find((w: { title: string }) => w.title === "Set 2 onayı");
    expect(created).toMatchObject({ status: "gonderildi", fromCompanyId: ids.CNS, toCompanyIds: [ids.ZRT] });
    const d = (await zeynep.get(`${P()}/works/${created.id}`)).body;
    expect(d.fields).toMatchObject({ amac: "uygulama" });
    expect(d.links.filter((l: { role: string }) => l.role === "kaynak").map((l: { targetId: string }) => l.targetId)).toEqual([r.body.id]);
    // Only the approved file goes out, pinned at the reviewed version.
    expect(d.links.filter((l: { role: string }) => l.role === "ek").map((l: { targetId: string }) => l.targetId)).toEqual([versionA2]);
    expect(d.links.some((l: { role: string }) => l.role === "kapak")).toBe(true);
    expect((await zeynep.get("/me/today")).body.toReceive.some((w: { id: string }) => w.id === created.id)).toBe(true);
    expect(today.tasks.length).toBeGreaterThan((await semih.get("/me/today")).body.tasks.length);

    // Templates without the option create nothing.
    await admin.put(`${P()}/work-automation/${reviewTemplateId}`, { autoTransmittal: false });
    const r2 = await murat.post(`${P()}/reviews`, { name: "Sessiz", templateId: reviewTemplateId, versionIds: [versionB1] });
    await semih.post(`${P()}/reviews/${r2.body.id}/submit`, { files: [{ reviewFileId: r2.body.files[0].id, outcome: "approved" }] });
    expect((await admin.get(`${P()}/works?type=transmittal`)).body).toHaveLength(before + 1);
  });

  it.skipIf(!hasManage)("filters the list by type, status, search and due date", async () => {
    const all = (await admin.get(`${P()}/works`)).body;
    expect(all.length).toBeGreaterThan(20);
    const letters = (await admin.get(`${P()}/works?type=giden-yazi,gelen-yazi`)).body;
    expect(letters.every((w: { category: string }) => w.category === "correspondence")).toBe(true);
    const search = (await admin.get(`${P()}/works?q=${encodeURIComponent("asma TAVAN")}`)).body;
    expect(search.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([letterId, replyId]));
    const answered = (await admin.get(`${P()}/works?status=cevaplandi`)).body;
    expect(answered.map((w: { id: string }) => w.id)).toEqual([letterId]);
    const open = (await admin.get(`${P()}/works?open=1`)).body;
    expect(open.some((w: { id: string }) => w.id === letterId)).toBe(false);
  });

  // Without Manage the engine's own rules (visibility, numbering, list filters) are checked on transmittals.
  it.runIf(!hasManage)("engine without Manage: drafts hidden, visibility after sending, unique numbers, filters", async () => {
    const d = await murat.post(`${P()}/works`, {
      typeKey: "transmittal",
      title: "Statik hesaplar",
      toCompanyIds: [ids.CNS],
      ccCompanyIds: [ids.ZRT],
      fields: { amac: "bilgi" },
      links: [{ kind: "file_version", targetId: versionB1 }],
    });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const id = d.body.id as string;
    expect(d.body).toMatchObject({ status: "taslak", canSend: true, fromCompanyId: ids.PAS });
    // Draft: addressees don't see it, the owner company does.
    expect((await semih.get(`${P()}/works/${id}`)).status).toBe(404);
    expect((await eve.get(`${P()}/works/${id}`)).status).toBe(200);
    expect((await semih.get(`${P()}/works`)).body.some((w: { id: string }) => w.id === id)).toBe(false);
    expect((await murat.post(`${P()}/works/${id}/send`, { channel: "cde" })).status).toBe(200);
    // Sent: gereği (CNS) and bilgi (ZRT) see it, HLL does not, admins do; recipients may not edit.
    expect((await semih.get(`${P()}/works/${id}`)).status).toBe(200);
    expect((await zeynep.get(`${P()}/works/${id}`)).status).toBe(200);
    expect((await aytug.get(`${P()}/works/${id}`)).status).toBe(404);
    expect((await admin.get(`${P()}/works/${id}`)).status).toBe(200);
    expect((await semih.patch(`${P()}/works/${id}`, { title: "x" })).status).toBe(403);

    // Concurrent creates get unique, consecutive numbers.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        murat.post(`${P()}/works`, { typeKey: "transmittal", title: `Set ${i}`, toCompanyIds: [ids.CNS], fields: { amac: "onay" } }),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const seq = results.map((r) => Number(String(r.body.number).split("-").pop())).sort((a, b) => a - b);
    expect(new Set(seq).size).toBe(10);
    expect(seq[9]! - seq[0]!).toBe(9);
    expect(results[0]!.body.number).toMatch(new RegExp(`^WK-GF-PAS-${YEAR}-\\d{4}$`));

    // List filters: type, search, status.
    const transmittals = (await admin.get(`${P()}/works?type=transmittal`)).body;
    expect(transmittals.every((w: { typeKey?: string; category: string }) => w.category === "transmittal" || w.typeKey === "transmittal")).toBe(true);
    expect((await admin.get(`${P()}/works?q=${encodeURIComponent("STATİK hesap")}`)).body.map((w: { id: string }) => w.id)).toEqual([id]);
    const drafts = (await admin.get(`${P()}/works?status=taslak`)).body.map((w: { id: string }) => w.id);
    expect(drafts).toEqual(expect.arrayContaining(results.map((r) => r.body.id)));
    expect(drafts).not.toContain(id);
  });

  it("lets project admins define work types (fields, numbering)", async () => {
    const body = {
      key: "ozel-rfi",
      name: "RFI",
      category: "generic",
      numberingPattern: "{Proje}_{Gönderen}_RFI_{000}",
      fields: [
        { key: "disiplin", label: "Disiplin", type: "list", options: ["Mimari", "Statik"], required: true },
        { key: "soru", label: "Soru", type: "textarea", required: true },
      ],
    };
    expect((await murat.post(`${P()}/work-types`, body)).status).toBe(403);
    const bad = await admin.post(`${P()}/work-types`, { ...body, numberingPattern: "{Proje}-{Firma}" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("sıra no");
    const t = await admin.post(`${P()}/work-types`, body);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.statuses.map((s: { key: string }) => s.key)).toEqual(["taslak", "acik", "kapandi"]);
    expect((await admin.post(`${P()}/work-types`, body)).status).toBe(409);

    const missing = await murat.post(`${P()}/works`, { typeKey: "ozel-rfi", title: "Soru", fields: { disiplin: "Mimari" } });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("Soru");
    const ok = await murat.post(`${P()}/works`, {
      typeKey: "ozel-rfi",
      title: "Kolon aksı",
      fields: { disiplin: "Statik", soru: "A aksı kolon ölçüsü?" },
      status: "acik",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.number).toBe("WK_PAS_RFI_001");

    const upd = await admin.put(`${P()}/work-types/${t.body.id}`, { numberingPattern: "{Proje}-RFI-{YY}-{0000}" });
    expect(upd.status).toBe(200);
    const next = await murat.post(`${P()}/works`, { typeKey: "ozel-rfi", title: "İkinci", fields: { disiplin: "Mimari", soru: "?" } });
    expect(next.body.number, JSON.stringify(next.body)).toBe(`WK-RFI-${String(YEAR).slice(-2)}-0001`);

    expect((await admin.del(`${P()}/work-types/${t.body.id}`)).status).toBe(200);
    expect((await murat.get(`${P()}/work-types`)).body.some((x: { key: string }) => x.key === "ozel-rfi")).toBe(false);
    expect((await murat.post(`${P()}/works`, { typeKey: "ozel-rfi", title: "x", fields: { disiplin: "Mimari", soru: "?" } })).status).toBe(400);
  });
});

describe("works: Turkish built-in names in older projects", () => {
  let admin: Client, lg: Client;
  let pid: string, rootId: string, wipId: string;
  const P = () => `/projects/${pid}`;

  it.skipIf(!hasManage)("renames untouched built-in types, keeps admin names and stored numbering", async () => {
    admin = api(await login("admin@7d.test"));
    const lga = (await admin.post("/companies", { name: "LGA" })).body.id;
    const lgb = (await admin.post("/companies", { name: "LGB" })).body.id;
    const p = await admin.post("/projects", { code: "LG", name: "Eski adlar" });
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    await admin.post("/users", { email: "lg@lg.test", name: "Lale", password: PW, companyId: lga });
    expect((await admin.post(`${P()}/members`, { email: "lg@lg.test" })).status).toBe(200);
    lg = api(await login("lg@lg.test"));

    // A fresh project gets the Turkish names and the EYL prefix for actions.
    const fresh = (await admin.get(`${P()}/work-types`)).body as { key: string; name: string; numberingPattern: string }[];
    const byKey = (list: typeof fresh) => new Map(list.map((t) => [t.key, t]));
    expect(byKey(fresh).get("transmittal")).toMatchObject({ name: "Gönderim Formu", numberingPattern: "{Proje}-GF-{Gönderen}-{YYYY}-{0000}" });
    expect(byKey(fresh).get("rfi")).toMatchObject({ name: "Bilgi Talebi", numberingPattern: "{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}" });
    expect(byKey(fresh).get("aksiyon")).toMatchObject({ name: "Eylem", numberingPattern: "{Proje}-EYL-{0000}" });

    // Turn the rows back into what a project seeded before the renaming looks like.
    const rows = await handle.db.select().from(workTypes).where(eq(workTypes.projectId, pid));
    const old = async (key: string, name: string, extra: Partial<typeof workTypes.$inferInsert> = {}, seededName?: string) => {
      const row = rows.find((r) => r.key === key)!;
      const { seededName: _drop, ...settings } = row.settings;
      await handle.db
        .update(workTypes)
        .set({ name, settings: seededName ? { ...settings, seededName } : settings, ...extra })
        .where(eq(workTypes.id, row.id));
    };
    await old("transmittal", "Transmittal");
    await old("rfi", "RFI");
    await old("aksiyon", "Aksiyon", { numberingPattern: "{Proje}-AKS-{0000}" });
    await old("submittal-paketi", "Onay dosyası"); // the admin's own name, no seededName yet
    await old("submittal-kalemi", "Malzeme onayı", {}, "Submittal kalemi"); // edited after seeding

    const upgraded = byKey((await admin.get(`${P()}/work-types`)).body);
    expect(upgraded.get("transmittal")!.name).toBe("Gönderim Formu");
    expect(upgraded.get("rfi")!.name).toBe("Bilgi Talebi");
    expect(upgraded.get("aksiyon")).toMatchObject({ name: "Eylem", numberingPattern: "{Proje}-AKS-{0000}" });
    expect(upgraded.get("submittal-paketi")!.name).toBe("Onay dosyası");
    expect(upgraded.get("submittal-kalemi")!.name).toBe("Malzeme onayı");

    // A name the admin sets later is never overwritten.
    const tr = upgraded.get("transmittal") as unknown as { id: string };
    expect((await admin.put(`${P()}/work-types/${tr.id}`, { name: "Sevk formu" })).status).toBe(200);
    expect(byKey((await admin.get(`${P()}/work-types`)).body).get("transmittal")!.name).toBe("Sevk formu");

    // Existing action numbers keep the AKS prefix of the stored pattern.
    const action = await lg.post(`${P()}/works`, { typeKey: "aksiyon", title: "Kontrol", toCompanyIds: [lgb] });
    expect(action.status, JSON.stringify(action.body)).toBe(200);
    expect(action.body.number).toBe("LG-AKS-0001");
  });

  it.skipIf(!hasManage)("upgrades untouched sentence-case labels to Title Case, keeps edited ones, twice in a row", async () => {
    type Row = typeof workTypes.$inferSelect;
    const load = async () => new Map((await handle.db.select().from(workTypes).where(eq(workTypes.projectId, pid))).map((r) => [r.key, r]));
    const rows = await load();
    // Back to a project seeded before Title Case: sentence-case defaults, no remembered labels.
    const legacy = async (key: string, patch: (r: Row) => Partial<Row>, seededName?: string) => {
      const r = rows.get(key)!;
      const { seededLabels: _l, seededName: _n, ...settings } = r.settings;
      await handle.db
        .update(workTypes)
        .set({ ...patch(r), settings: seededName ? { ...settings, seededName } : settings })
        .where(eq(workTypes.id, r.id));
    };
    const label = <T extends { key: string; label: string }>(list: T[], key: string, to: string) =>
      list.map((x) => (x.key === key ? { ...x, label: to } : x));
    await legacy(
      "gelen-yazi",
      (r) => ({
        name: "Gelen yazı",
        // "tarih", "ozet": untouched defaults; "proje_kodu": the admin's own label.
        fields: label(label(label(r.fields, "tarih", "Yazı tarihi"), "ozet", "Özet / not"), "proje_kodu", "İşveren proje no"),
      }),
      "Gelen yazı",
    );
    await legacy("submittal-kalemi", (r) => ({
      statuses: label(label(label(r.statuses, "notlu_onay", "Notlu onaylandı"), "revize", "Revize et ve tekrar gönder"), "reddedildi", "Ret"),
    }), "Submittal kalemi");
    await legacy("toplanti", (r) => ({ statuses: label(r.statuses, "yapildi", "Tutanak hazırlanıyor") }));

    type TypeDto = { id: string; key: string; name: string; fields: { key: string; label: string }[]; statuses: { key: string; label: string }[] };
    const types = (await admin.get(`${P()}/work-types`)).body as TypeDto[];
    const t = new Map(types.map((x) => [x.key, x]));
    const labelOf = (list: { key: string; label: string }[], key: string) => list.find((x) => x.key === key)!.label;
    const gelen = t.get("gelen-yazi")!;
    expect(gelen.name).toBe("Gelen Yazı");
    expect(labelOf(gelen.fields, "tarih")).toBe("Yazı Tarihi");
    expect(labelOf(gelen.fields, "ozet")).toBe("Özet / Not");
    expect(labelOf(gelen.fields, "proje_kodu")).toBe("İşveren proje no");
    const kalem = t.get("submittal-kalemi")!;
    expect(kalem.name).toBe("Malzeme onayı"); // the admin's name from the test above
    expect(labelOf(kalem.statuses, "notlu_onay")).toBe("Notlu Onaylandı");
    expect(labelOf(kalem.statuses, "revize")).toBe("Revize Et ve Tekrar Gönder");
    expect(labelOf(kalem.statuses, "reddedildi")).toBe("Ret");
    expect(labelOf(t.get("toplanti")!.statuses, "yapildi")).toBe("Tutanak Hazırlanıyor");
    const settled = await load();
    expect(settled.get("gelen-yazi")!.settings.seededLabels).toMatchObject({ "f:tarih": "Yazı Tarihi", "f:proje_kodu": "Proje Kodu" });

    // A second run changes nothing.
    await admin.get(`${P()}/work-types`);
    const again = await load();
    for (const [key, r] of settled) expect(again.get(key)!.updatedAt.getTime(), key).toBe(r.updatedAt.getTime());

    // The admin may write the old sentence-case label back: it is the admin's own now and stays.
    const put = await admin.put(`${P()}/work-types/${gelen.id}`, { fields: label(gelen.fields, "tarih", "Yazı tarihi") });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = ((await admin.get(`${P()}/work-types`)).body as TypeDto[]).find((x) => x.key === "gelen-yazi")!;
    expect(labelOf(after.fields, "tarih")).toBe("Yazı tarihi");
  });

  it.skipIf(!hasManage)("upgrades the template sub-status label 'İş sonu' to 'İş Sonu' at startup, keeps typed labels", async () => {
    const mk = async (name: string, stateLabel: string) => {
      const f = await admin.post(`${P()}/folders`, { parentId: rootId, name });
      expect(f.status, JSON.stringify(f.body)).toBe(200);
      expect((await admin.patch(`${P()}/folders/${f.body.id}`, { state: "published", stateLabel })).status).toBe(200);
      return f.body.id as string;
    };
    const seeded = await mk("04-İş Sonu", "İş sonu"); // what templates wrote before Title Case
    const typed = await mk("05-Teslim", "İş sonu (kısmi)");
    const label = async (id: string) => (await handle.db.select().from(folders).where(eq(folders.id, id)))[0]!.stateLabel;
    expect(await upgradeSeededLabels(handle.db)).toBeGreaterThanOrEqual(1);
    expect(await label(seeded)).toBe("İş Sonu");
    expect(await label(typed)).toBe("İş sonu (kısmi)");
    // Running it again changes nothing.
    expect(await upgradeSeededLabels(handle.db)).toBe(0);
    expect(await label(seeded)).toBe("İş Sonu");
  });

  it.skipIf(!hasManage)("numbers bilgi talepleri and gönderim formları of older projects with their stored RFI / TRM patterns", async () => {
    const lgb = (await admin.get("/companies")).body.find((c: { name: string }) => c.name === "LGB").id;
    const rows = await handle.db.select().from(workTypes).where(eq(workTypes.projectId, pid));
    const set = async (key: string, numberingPattern: string) =>
      handle.db.update(workTypes).set({ numberingPattern }).where(eq(workTypes.id, rows.find((r) => r.key === key)!.id));
    // The patterns projects were seeded with before BT / GF.
    await set("rfi", "{Gönderen}_{Alıcı}_{Disiplin}_RFI_{000}");
    await set("transmittal", "{Proje}-TRM-{Gönderen}-{YYYY}-{0000}");
    const types = (await admin.get(`${P()}/work-types`)).body as { key: string; numberingPattern: string }[];
    expect(types.find((x) => x.key === "rfi")!.numberingPattern).toBe("{Gönderen}_{Alıcı}_{Disiplin}_RFI_{000}");
    const rfi = await lg.post(`${P()}/works`, {
      typeKey: "rfi",
      title: "Kolon ölçüsü",
      toCompanyIds: [lgb],
      fields: { soru: "?", kategori: "Malzeme", disiplin: "S - Statik", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Yok" },
    });
    expect(rfi.status, JSON.stringify(rfi.body)).toBe(200);
    expect(rfi.body.number).toBe("LGA_LGB_S_RFI_001");
    const tr = await lg.post(`${P()}/works`, { typeKey: "transmittal", title: "Set", toCompanyIds: [lgb], fields: { amac: "bilgi" } });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);
    expect(tr.body.number).toMatch(new RegExp(`^LG-TRM-LGA-${YEAR}-\\d{4}$`));
  });

  it.skipIf(!hasManage)("keeps storing cover sheets in an existing Transmittaller folder", async () => {
    const lgb = (await admin.get("/companies")).body.find((c: { name: string }) => c.name === "LGB").id;
    const lga = (await admin.get("/companies")).body.find((c: { name: string }) => c.name === "LGA").id;
    expect((await admin.post(`${P()}/folders`, { parentId: rootId, name: "Transmittaller" })).status).toBe(200);
    wipId = (await admin.get(`${P()}/folders/${rootId}/contents`)).body.folders.find((f: { name: string }) => f.name.startsWith("01-")).id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, { entries: [{ subjectType: "company", subjectId: lga, level: "edit" }] });
    const up = await lg.upload(`${P()}/folders/${wipId}/files`, [{ name: "K.pdf", data: "k" }]);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const versionId = (await lg.get(`${P()}/folders/${wipId}/contents`)).body.files[0].latest.id;
    const t = await lg.post(`${P()}/works`, {
      typeKey: "transmittal",
      title: "Eski klasör",
      toCompanyIds: [lgb],
      fields: { amac: "bilgi" },
      links: [{ kind: "file_version", targetId: versionId }],
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const sent = await lg.post(`${P()}/works/${t.body.id}/send`, { channel: "cde" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const names = (await admin.get(`${P()}/folders/${rootId}/contents`)).body.folders.map((f: { name: string }) => f.name);
    expect(names).toContain("Transmittaller");
    expect(names).not.toContain("Gönderim formları");
    const legacy = (await admin.get(`${P()}/folders/${rootId}/contents`)).body.folders.find((f: { name: string }) => f.name === "Transmittaller");
    expect((await admin.get(`${P()}/folders/${legacy.id}/contents`)).body.files.map((f: { name: string }) => f.name)).toEqual([`${t.body.number}.pdf`]);
  });
});
