/**
 * Server texts in the reader's language (docs/architecture/i18n.md §8): same languages as the web
 * app, same keys as English, errors and notifications rendered per reader, no Turkish left in code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { notifications, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { notFound } from "../../src/core/platform/http.js";
import { fromAcceptLanguage, msg, render, SERVER_LANGUAGES } from "../../src/i18n/index.js";
import { notify } from "../../src/workflow/service.js";
// @ts-expect-error -- plain ESM script without type declarations
import { findServerTexts } from "../../scripts/check-i18n.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_LOCALES = path.resolve(here, "../../src/i18n/locales");
const WEB_LOCALES = path.resolve(here, "../../../web/src/i18n/locales");
const PW = "Sifre-1234567";

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, p = "", out = new Map<string, string>()) => {
  for (const [k, v] of Object.entries(t)) typeof v === "string" ? out.set(p + k, v) : flatten(v, `${p}${k}.`, out);
  return out;
};
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");
const tokens = (s: string) => [...s.matchAll(/\{\{\s*[\w.]+\s*\}\}/g)].map((m) => m[0].replace(/\s+/g, "")).filter((t) => t !== "{{count}}").sort();
const dirs = (root: string) => fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "meta.json"))).sort();

describe("server translation files", () => {
  it("offer the same languages as the web app", () => {
    expect(dirs(SERVER_LOCALES)).toEqual(dirs(WEB_LOCALES));
    expect(SERVER_LANGUAGES.map((l) => l.code).sort()).toEqual(dirs(WEB_LOCALES));
  });

  for (const code of dirs(SERVER_LOCALES).filter((c) => c !== "en")) {
    it(`${code} has English's keys and placeholders`, () => {
      const complete = JSON.parse(fs.readFileSync(path.join(SERVER_LOCALES, code, "meta.json"), "utf8")).status === "complete";
      const problems: string[] = [];
      for (const file of fs.readdirSync(path.join(SERVER_LOCALES, "en")).filter((f) => f !== "meta.json")) {
        const en = flatten(JSON.parse(fs.readFileSync(path.join(SERVER_LOCALES, "en", file), "utf8")));
        const otherFile = path.join(SERVER_LOCALES, code, file);
        const other = fs.existsSync(otherFile) ? flatten(JSON.parse(fs.readFileSync(otherFile, "utf8"))) : new Map<string, string>();
        const enBases = new Set([...en.keys()].map(base));
        for (const k of new Set([...other.keys()].map(base))) if (!enBases.has(k)) problems.push(`${file} ${k}: not in English`);
        for (const [k, v] of other) {
          const source = en.get(k) ?? en.get(`${base(k)}_other`) ?? en.get(base(k));
          if (!v.trim()) {
            if (complete) problems.push(`${file} ${k}: empty`);
          } else if (source !== undefined && tokens(v).join() !== tokens(source).join()) problems.push(`${file} ${k}: placeholders differ`);
        }
        if (complete) for (const k of enBases) if (![...other.keys()].some((o) => base(o) === k)) problems.push(`${file} ${k}: missing`);
      }
      expect(problems).toEqual([]);
    });
  }

  it("leave no Turkish text in server code", () => {
    const { files, problems } = (findServerTexts as () => { files: number; problems: string[] })();
    expect(files).toBeGreaterThan(200);
    expect(problems).toEqual([]);
  });
});

describe("language of a reader", () => {
  it("follows Accept-Language with quality values and falls back", () => {
    expect(fromAcceptLanguage("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
    expect(fromAcceptLanguage("de-DE,en;q=0.5")).toBe("en");
    expect(fromAcceptLanguage("de-DE")).toBeNull();
    expect(fromAcceptLanguage(undefined)).toBeNull();
  });

  it("renders nested messages: notFound(entity)", () => {
    const err = notFound(msg("errors:entities.record"));
    expect(err.message).toBe("Record not found.");
    expect(render("tr", err.msg!)).toBe("Kayıt bulunamadı.");
  });
});

describe("errors and notifications per reader", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "7dcde-i18n-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
    const [u] = await handle.db
      .insert(users)
      .values({ email: "uye@i18n.test", name: "Üye", passwordHash: await hashPassword(PW), isAdmin: false })
      .returning();
    userId = u!.id;
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "uye@i18n.test", password: PW } });
    cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const get = (url: string, lang?: string) =>
    app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie, ...(lang ? { "accept-language": lang } : {}) } });

  it("answers an error in the language the client asks for, else the profile's", async () => {
    const bad = (lang?: string) =>
      app.inject({ method: "PATCH", url: "/api/v1/me/prefs", headers: { cookie, ...(lang ? { "accept-language": lang } : {}) }, payload: { language: "Türkçe" } });
    expect((await bad("en")).json().message).toBe("Invalid request.");
    expect((await bad("tr-TR,tr;q=0.9")).json().message).toBe("Geçersiz istek.");
    // No header: the profile decides (tests run with CDE_DEFAULT_LANGUAGE=tr).
    expect((await bad()).json().message).toBe("Geçersiz istek.");
    await app.inject({ method: "PATCH", url: "/api/v1/me/prefs", headers: { cookie }, payload: { language: "en" } });
    expect((await bad()).json().message).toBe("Invalid request.");
  });

  it("stores a notification as a message and lists it in the reader's language", async () => {
    await notify(handle.db, [userId], { projectId: null, kind: "test", title: msg("errors:notFound", { what: msg("errors:entities.record") }) });
    const [row] = await handle.db.select().from(notifications).where(eq(notifications.userId, userId));
    expect(row!.message?.title.key).toBe("errors:notFound");
    expect((await get("/notifications", "en")).json()[0].title).toBe("Record not found.");
    expect((await get("/notifications", "tr")).json()[0].title).toBe("Kayıt bulunamadı.");
  });

  it("labels enum values of the report catalog in the reader's language (labelFor)", async () => {
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    const p = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie }, payload: { code: "DIL", name: "Dil" } });
    expect(p.statusCode).toBe(200);
    type Catalog = { datasets: { name: string; fields: { name: string; values?: Record<string, string> }[] }[]; modules: { key: string; label: string }[] };
    const catalog = async (lang: string) => (await get(`/projects/${p.json().id}/reports/catalog`, lang)).json() as Catalog;
    const issueStatus = (c: Catalog) => c.datasets.find((d) => d.name === "issues")!.fields.find((f) => f.name === "status")!.values!;
    const en = await catalog("en");
    const tr = await catalog("tr");
    expect(issueStatus(en).open).toBe("Open");
    expect(issueStatus(tr).open).toBe("Açık");
    expect(en.modules.find((m) => m.key === "issues")!.label).toBe("Issues");
    expect(tr.modules.find((m) => m.key === "issues")!.label).toBe("Sorunlar");
  });
});
