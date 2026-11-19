/**
 * #139: Turkish left in an English interface and the metro template.
 * - built-in work types (names, field labels, statuses) in the reader's language;
 * - errors in the request's language, also where no language is passed down (currentLanguage);
 * - seeded names (project root, ISO folders) in the creator's language;
 * - {Gönderen} in numbers only from the project's parties;
 * - the metro template's naming standard on its construction state folders.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { folders, namingStandards, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { currentLanguage, msg, render, tFor, withRequestLanguage } from "../../src/i18n/index.js";
import { BcfFormatError } from "../../src/bcf/xml.js";
import { readZip } from "../../src/core/formats/zip.js";
import { hasManage } from "../helpers/modules.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const YEAR = new Date().getFullYear();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-i18n139-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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

function api(cookie: string, lang?: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const headers: Record<string, string> = { cookie };
    if (lang) headers["accept-language"] = lang;
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
  };
}

type TypeDto = { key: string; name: string; fields: { key: string; label: string; help?: string }[]; statuses: { key: string; label: string }[] };
const byKey = (list: TypeDto[], key: string) => list.find((t) => t.key === key)!;

describe("request language", () => {
  it("is the installation default outside a request and the given one inside", () => {
    expect(currentLanguage()).toBe("tr"); // vitest.config: CDE_DEFAULT_LANGUAGE=tr
    expect(withRequestLanguage(() => "en", () => currentLanguage())).toBe("en");
    // An unsupported language falls back to the default.
    expect(withRequestLanguage(() => "xx", () => currentLanguage())).toBe("tr");
  });

  it("writes errors built deep in a call in the request's language", () => {
    const m = msg("bcf:xml.unreadable", { what: "markup.bcf" });
    expect(withRequestLanguage(() => "en", () => new BcfFormatError(m).message)).toBe(render("en", m));
    expect(new BcfFormatError(m).message).toBe(render("tr", m));
    const zipError = (lang: string) =>
      withRequestLanguage(
        () => lang,
        () => {
          try {
            readZip(Buffer.from("not a zip"));
            return "";
          } catch (e) {
            return (e as Error).message;
          }
        },
      );
    expect(zipError("en")).not.toBe(zipError("tr"));
    expect(zipError("en")).not.toMatch(/[çğıöşüİ]/);
  });

  it("names the first administrator in the installation language", () => {
    expect(tFor("en")("auth:seed.adminName")).toBe("Administrator");
    expect(tFor("tr")("auth:seed.adminName")).toBe("Yönetici");
  });
});

describe("#139 i18n of seeded texts", () => {
  let cookie: string;
  let en: ReturnType<typeof api>, tr: ReturnType<typeof api>;
  let pid: string;
  const ids: Record<string, string> = {};

  it("creates the project root and ISO folders in the creator's language", async () => {
    cookie = await login("admin@7d.test");
    en = api(cookie, "en");
    tr = api(cookie, "tr");
    const p = await en.post("/projects", { code: "LOC", name: "Localised" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    pid = p.body.id;
    const contents = await en.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    expect(contents.body.folders.map((f: { name: string }) => f.name)).toEqual(["01-WIP", "02-SHARED", "03-PUBLISHED", "04-ARCHIVED"]);
    const [root] = await handle.db.select().from(folders).where(eq(folders.id, p.body.rootFolderId));
    expect(root!.name).toBe("Project Files");

    const t = await tr.post("/projects", { code: "LOCTR", name: "Yerel" });
    const [rootTr] = await handle.db.select().from(folders).where(eq(folders.id, t.body.rootFolderId));
    expect(rootTr!.name).toBe("Proje Dosyaları");
    const trContents = await tr.get(`/projects/${t.body.id}/folders/${t.body.rootFolderId}/contents`);
    expect(trContents.body.folders[0].name).toBe("01-WIP (Çalışmada)");
  });

  it("shows built-in work types in the reader's language; the stored data stays Turkish", async () => {
    const enTypes: TypeDto[] = (await en.get(`/projects/${pid}/work-types`)).body;
    const rfi = byKey(enTypes, "rfi");
    expect(rfi.name).toBe("RFI");
    expect(rfi.statuses.map((s) => s.label)).toEqual(["Draft", "Open", "Answered", "Closed", "Cancelled"]);
    expect(rfi.fields.find((f) => f.key === "oncelik")!.label).toBe("Priority");
    expect(rfi.fields.find((f) => f.key === "resmi_cevap")!.help).toBe("Filled from the workflow when answered");
    const meeting = byKey(enTypes, "toplanti");
    expect(meeting.statuses.map((s) => s.label)).toEqual(["Scheduled", "Minutes in Preparation", "Minutes Published", "Cancelled"]);
    expect(byKey(enTypes, "submittal-kalemi").name).toBe("Submittal Item");
    expect(byKey(enTypes, "giden-yazi").fields.find((f) => f.key === "tarih")!.label).toBe("Letter Date");
    // Nothing Turkish left in the texts of any built-in type.
    const texts = enTypes.flatMap((t) => [t.name, ...t.fields.flatMap((f) => [f.label, f.help ?? ""]), ...t.statuses.map((s) => s.label)]);
    expect(texts.filter((x) => /[çğıöşüÇĞİÖŞÜ]/.test(x))).toEqual([]);

    const trTypes: TypeDto[] = (await tr.get(`/projects/${pid}/work-types`)).body;
    expect(byKey(trTypes, "rfi").name).toBe("Bilgi Talebi");
    expect(byKey(trTypes, "rfi").statuses.map((s) => s.label)).toEqual(["Taslak", "Açık", "Cevaplandı", "Kapalı", "İptal"]);
  });

  it("keeps a label the admin changed in every language", async () => {
    const trTypes: TypeDto[] = (await tr.get(`/projects/${pid}/work-types`)).body;
    const giden = byKey(trTypes, "giden-yazi") as TypeDto & { id: string };
    const fields = giden.fields.map((f) => (f.key === "konu" ? { ...f, label: "Yazının Konusu" } : f));
    const put = await tr.put(`/projects/${pid}/work-types/${giden.id}`, { name: "Giden Resmi Yazı", fields });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const enGiden = byKey((await en.get(`/projects/${pid}/work-types`)).body, "giden-yazi");
    expect(enGiden.name).toBe("Giden Resmi Yazı");
    expect(enGiden.fields.find((f) => f.key === "konu")!.label).toBe("Yazının Konusu");
    // Untouched labels of the same type are still translated.
    expect(enGiden.fields.find((f) => f.key === "tarih")!.label).toBe("Letter Date");
  });

  it.skipIf(!hasManage)("lists works with English status labels and answers errors in English", async () => {
    for (const c of ["PAS", "CNS"]) ids[c] = (await en.post("/companies", { name: c })).body.id;
    const w = await en.post(`/projects/${pid}/works`, { typeKey: "rfi", title: "Question", toCompanyIds: [ids.CNS], fields: { soru: "?", kategori: "Malzeme", disiplin: "M - Mekanik", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Yok" } });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const list = (await en.get(`/projects/${pid}/works`)).body as { id: string; statusLabel: string; typeName: string }[];
    const row = list.find((x) => x.id === w.body.id)!;
    expect(row).toMatchObject({ statusLabel: "Draft", typeName: "RFI" });
    expect((await tr.get(`/projects/${pid}/works`)).body.find((x: { id: string }) => x.id === w.body.id).statusLabel).toBe("Taslak");

    const log = await en.get(`/projects/${pid}/build/rfis`);
    if (log.status === 200) expect(log.body.find((x: { id: string }) => x.id === w.body.id).statusLabel).toBe("Draft");

    const bad = await en.patch(`/projects/${pid}/works/${w.body.id}`, { status: "yok" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe(
      tFor("en")("works:errors.invalidStatusFor", { status: "yok", type: "RFI", allowed: "taslak, acik, cevaplandi, kapandi, iptal" }),
    );
    expect(bad.body.message).not.toMatch(/[çğıöşüİ]/);
  });

  it.skipIf(!hasManage)("offers a numbering preset that starts with the project code", async () => {
    const r = await en.put(`/projects/${pid}/build/numbering`, { preset: "proje" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rfi = byKey((await en.get(`/projects/${pid}/work-types`)).body, "rfi") as TypeDto & { numberingPattern: string };
    expect(rfi.numberingPattern).toBe("{Proje}_{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}");
  });
});

describe("#139 numbering: {Gönderen} only from the project's parties", () => {
  it.skipIf(!hasManage)("uses the project code for a creator whose company is not a party", async () => {
    const admin = api(await login("admin@7d.test"), "en");
    const co: Record<string, string> = {};
    for (const c of ["OPS", "IDR", "MSV", "TSR", "YKL"]) co[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects/from-template", {
      code: "NUM",
      name: "Numbering",
      templateId: "iso19650-temel",
      slotCompanies: { idare: co.IDR, musavir: co.MSV, tasarimci: co.TSR, yuklenici: co.YKL },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const pid = p.body.id;
    // "op" belongs to the operator's company, which is not a party of this project.
    for (const [email, company] of [
      ["op@num.test", co.OPS],
      ["ykl@num.test", co.YKL],
    ] as const) {
      expect((await admin.post("/users", { email, name: email, password: PW, companyId: company })).status).toBe(200);
      expect((await admin.post(`/projects/${pid}/members`, { email })).status).toBe(200);
    }
    const op = api(await login("op@num.test"), "en");
    const ykl = api(await login("ykl@num.test"), "en");
    const a = await op.post(`/projects/${pid}/works`, { typeKey: "giden-yazi", title: "From the operator", toCompanyIds: [co.IDR] });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.number).toBe(`NUM-NUM-IDR-${YEAR}-0001`);
    const b = await ykl.post(`/projects/${pid}/works`, { typeKey: "giden-yazi", title: "From the contractor", toCompanyIds: [co.IDR] });
    expect(b.body.number).toBe(`NUM-YKL-IDR-${YEAR}-0001`);
  });
});

describe("#139 template naming standard", () => {
  it("links the metro naming standard to the construction state folders like the design ones", async () => {
    const admin = api(await login("admin@7d.test"), "tr");
    const p = await admin.post("/projects/from-template", { code: "MTR", name: "Metro", templateId: "metro-ibb" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const rows = await handle.db.select().from(folders).where(eq(folders.projectId, p.body.id));
    const [std] = await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, p.body.id));
    expect(std!.definition.name).toBe("Metro Kodlama Sistemi");
    const top = (name: string) => rows.find((f) => f.name === name && f.parentId === p.body.rootFolderId)!;
    for (const area of ["01-TASARIM ÇALIŞMALARI", "02-YAPIM ÇALIŞMALARI"]) {
      const states = rows.filter((f) => f.parentId === top(area).id);
      expect(states.length, area).toBeGreaterThanOrEqual(3);
      for (const f of states) expect(f.namingStandardId, `${area}/${f.name}`).toBe(std!.id);
    }
    // Party WIP areas stay free, as in the ISO 19650 templates: the standard is mandatory on upload.
    expect(top("98-YÜKLENİCİ ORTAK ALAN").namingStandardId).toBeNull();
  });
});

describe("#139 seeded roles, folders and options in the reader's language", () => {
  let pid: string, rootId: string;
  let en: ReturnType<typeof api>, tr: ReturnType<typeof api>;

  it("shows the default roles translated; the stored names stay", async () => {
    const cookie = await login("admin@7d.test");
    en = api(cookie, "en");
    tr = api(cookie, "tr");
    // Created in Turkish: an older-style project whose seeded names are Turkish.
    const p = await tr.post("/projects", { code: "SEED", name: "Seeded" });
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    const enRoles = (await en.get(`/projects/${pid}/roles`)).body as { name: string; description: string }[];
    expect(enRoles.map((r) => r.name).sort()).toEqual(["Administrator", "Editor", "Viewer"]);
    const trRoles = (await tr.get(`/projects/${pid}/roles`)).body as { name: string }[];
    expect(trRoles.map((r) => r.name).sort()).toEqual(["Düzenleyici", "Görüntüleyici", "Yönetici"]);
  });

  it("shows the root and ISO folders of a Turkish project translated, stored names unchanged", async () => {
    const root = await en.get(`/projects/${pid}/folders/${rootId}`);
    expect(root.body.name).toBe("Project Files");
    const contents = await en.get(`/projects/${pid}/folders/${rootId}/contents`);
    expect(contents.body.folders.map((f: { name: string }) => f.name)).toEqual(["01-WIP", "02-SHARED", "03-PUBLISHED", "04-ARCHIVED"]);
    const [stored] = await handle.db.select().from(folders).where(eq(folders.id, rootId));
    expect(stored!.name).toBe("Proje Dosyaları");
    // A user folder with a built-in name deeper in the tree is the user's own.
    const wip = contents.body.folders[0].id;
    const made = await tr.post(`/projects/${pid}/folders`, { parentId: wip, name: "Yazılar" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect((await en.get(`/projects/${pid}/folders/${made.body.id}`)).body.name).toBe("Yazılar");
  });

  it("labels seeded list options for the reader and keeps the stored values", async () => {
    const rfi = ((await en.get(`/projects/${pid}/work-types`)).body as (TypeDto & { fields: { key: string; options?: string[]; optionLabels?: Record<string, string> }[] })[]).find(
      (t) => t.key === "rfi",
    )!;
    const prio = rfi.fields.find((f) => f.key === "oncelik")!;
    expect(prio.options).toEqual(["Düşük", "Normal", "Yüksek", "Acil"]);
    expect(prio.optionLabels).toMatchObject({ Düşük: "Low", Yüksek: "High", Acil: "Urgent" });
    const trRfi = ((await tr.get(`/projects/${pid}/work-types`)).body as { key: string; fields: { key: string; optionLabels?: unknown }[] }[]).find((t) => t.key === "rfi")!;
    expect(trRfi.fields.find((f) => f.key === "oncelik")!.optionLabels).toBeUndefined();
    // Saving the type from the English UI does not store the labels.
    const full = (await tr.get(`/projects/${pid}/work-types`)).body.find((t: { key: string }) => t.key === "rfi");
    const put = await en.put(`/projects/${pid}/work-types/${full.id}`, { fields: rfi.fields });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const again = (await tr.get(`/projects/${pid}/work-types`)).body.find((t: { key: string }) => t.key === "rfi");
    expect(again.fields.find((f: { key: string }) => f.key === "oncelik").optionLabels).toBeUndefined();
  });
});
