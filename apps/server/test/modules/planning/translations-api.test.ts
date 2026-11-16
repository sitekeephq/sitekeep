import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(path.join(here, "../../fixtures", "schedule.csv"));
const PW = "Sifre-1234567";

describe("İş programı ad çevirileri API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  // Fake OpenAI-compatible model: translates every requested name and invents one extra code.
  let stub: Server;
  let stubUrl: string;
  const stubCalls: { system: string; items: { code: string; name: string }[] }[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-translations-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 5) });
    await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
    stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const system = String(body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "");
        const user = JSON.parse(String(body.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "{}"));
        stubCalls.push({ system, items: user.items ?? [] });
        const items = [...(user.items ?? []).map((i: { code: string; name: string }) => ({ code: i.code, name: `EN ${i.name}` })), { code: "ZZZ", name: "Invented" }];
        const content = "```json\n" + JSON.stringify({ items }) + "\n```";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    stub.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  function client(cookie: string) {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
      return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : null, raw: res.rawPayload, headers: res.headers };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      upload: async (url: string, name: string, data: Buffer, fields: Record<string, string> = {}) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        form.append("file", new Blob([data]), name);
        const req = new Request("http://x", { method: "POST", body: form });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1${url}`,
          headers: { cookie, "accept-language": "en", "content-type": req.headers.get("content-type")! },
          payload: Buffer.from(await req.arrayBuffer()),
        });
        return { status: res.statusCode, body: res.json() };
      },
    };
  }

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let pid: string;
  let sid: string;
  let wbsCode: string;
  /** WBS nodes without a translation after the import step (the CSV makes several). */
  let otherWbs: { code: string; name: string }[];
  const base = () => `/projects/${pid}/schedules/${sid}`;

  it("sets up a project with a schedule", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    pid = (await admin.post("/projects", { code: "INR", name: "Hat projesi" })).body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    const r = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.id;
    const acts = (await admin.get(`${base()}/activities`)).body as { code: string; name: string; summary: boolean }[];
    wbsCode = acts.find((a) => a.summary)!.code;
    otherWbs = acts.filter((a) => a.summary && a.code !== wbsCode).map((a) => ({ code: a.code, name: a.name }));
    expect(acts.filter((a) => !a.summary).map((a) => a.code)).toEqual(["A10", "A20", "A30", "A40"]);
  });

  it("lets members read and only planners write", async () => {
    expect((await member.get(`${base()}/translations?lang=en`)).body).toEqual({ lang: "en", items: [] });
    expect((await member.get(`${base()}/translations?lang=English`)).status).toBe(400);
    expect((await member.get(`${base()}/translations`)).status).toBe(400);
    expect((await member.put(`${base()}/translations`, { lang: "en", items: [{ activityCode: "A10", name: "Mobilisation" }] })).status).toBe(403);
    expect((await member.post(`${base()}/translations/ai`, { lang: "en" })).status).toBe(403);
    expect((await member.upload(`${base()}/translations/import`, "t.csv", Buffer.from("Activity ID;Name\nA10;X\n"), { lang: "en" })).status).toBe(403);
  });

  it("saves, lists and removes translations (WBS rows too)", async () => {
    const saved = await admin.put(`${base()}/translations`, {
      lang: "en",
      items: [
        { activityCode: "A10", name: "  Mobilisation " },
        { activityCode: wbsCode, name: "Preparation" },
        { activityCode: "A20", name: "Site office" },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({ saved: 3, deleted: 0 });
    const unknown = await admin.put(`${base()}/translations`, { lang: "en", items: [{ activityCode: "NOPE", name: "x" }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("NOPE");
    expect((await admin.put(`${base()}/translations`, { lang: "en", items: [{ activityCode: "A20", name: "" }] })).body).toEqual({ saved: 0, deleted: 1 });
    const list = (await member.get(`${base()}/translations?lang=en`)).body.items as { activityCode: string; name: string; source: string }[];
    expect(list.map((x) => [x.activityCode, x.name, x.source]).sort()).toEqual([["A10", "Mobilisation", "manual"], [wbsCode, "Preparation", "manual"]].sort());
    expect((await member.get(`${base()}/translations/languages`)).body).toEqual([{ lang: "en", count: 2 }]);
  });

  it("downloads the template and imports it back (unmatched rows reported)", async () => {
    const tpl = await member.get(`/projects/${pid}/schedules/translation-template?sid=${sid}&lang=en`);
    expect(tpl.status).toBe(200);
    expect(String(tpl.headers["content-type"])).toContain("spreadsheetml");
    const wb = XLSX.read(tpl.raw, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Translations", "Instructions"]);
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Translations!, { header: 1, defval: "" });
    expect(rows[0]!.slice(0, 3)).toEqual(["Activity ID", "Original Name", "Translation (en)"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(expect.arrayContaining([wbsCode, "A10", "A20", "A30", "A40"]));
    expect(rows.slice(1).every((r) => r[2] === "")).toBe(true);
    expect((await member.get(`/projects/${pid}/schedules/translation-template?sid=${sid}`)).status).toBe(400);

    // Fill the translation column for A30 and A40 and add a row for an unknown code.
    for (const r of rows.slice(1)) {
      if (r[0] === "A30") r[2] = "Foundation; raft";
      if (r[0] === "A40") r[2] = "Foundation complete";
    }
    rows.push(["ZZ-99", "Yok", "Missing"]);
    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), "Translations");
    const file = XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect((await admin.upload(`${base()}/translations/import`, "en.xlsx", file, {})).status).toBe(400);
    const r = await admin.upload(`${base()}/translations/import`, "en.xlsx", file, { lang: "en" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ lang: "en", rows: 3, saved: 2, unmatched: 1, unmatchedCodes: ["ZZ-99"] });
    const list = (await member.get(`${base()}/translations?lang=en`)).body.items as { activityCode: string; name: string; source: string }[];
    expect(list.find((x) => x.activityCode === "A30")).toMatchObject({ name: "Foundation; raft", source: "table" });

    // A plain CSV with code + name in another language; headers without a name column are refused.
    const csv = await admin.upload(`${base()}/translations/import`, "de.csv", Buffer.from("Activity ID;Activity Name\nA10;Baustelleneinrichtung\n"), { lang: "de" });
    expect(csv.body).toMatchObject({ saved: 1, unmatched: 0 });
    expect((await admin.upload(`${base()}/translations/import`, "x.csv", Buffer.from("Kod;Başlangıç\nA10;1\n"), { lang: "de" })).status).toBe(400);
    expect((await member.get(`${base()}/translations/languages`)).body).toEqual([{ lang: "de", count: 1 }, { lang: "en", count: 4 }]);
  });

  it("exports with translated names and unchanged codes (XER, MS Project XML)", async () => {
    const xer = await member.get(`${base()}/export?format=xer&nameLang=en`);
    expect(xer.status, xer.raw.toString("utf8").slice(0, 200)).toBe(200);
    const text = xer.raw.toString("utf8");
    expect(text).toContain("Mobilisation");
    expect(text).toContain("Foundation complete");
    expect(text).not.toContain("Mobilizasyon");
    expect(text).toContain("Şantiye binası"); // no translation: original name
    for (const c of ["A10", "A20", "A30", "A40"]) expect(text).toContain(`\t${c}\t`);
    expect(xer.headers["x-name-translations-missing"]).toBe(String(1 + otherWbs.length));
    expect(String(xer.headers["content-disposition"])).toContain("-en.xer");

    const xml = (await member.get(`${base()}/export?format=mspdi&nameLang=en`)).raw.toString("utf8");
    expect(xml).toContain("<Name>Mobilisation</Name>");
    expect(xml).toContain("<Name>Preparation</Name>");
    expect(xml).not.toContain("<Name>Mobilizasyon</Name>");
    for (const c of ["A10", "A20", "A30", "A40"]) expect(xml).toContain(`<FieldID>188743731</FieldID><Value>${c}</Value>`);

    expect((await member.get(`${base()}/export?format=xer`)).raw.toString("utf8")).toContain("Mobilizasyon");
    expect((await member.get(`${base()}/export?format=pdf&view=gantt&nameLang=en`)).status).toBe(200);
    expect((await member.get(`${base()}/export?format=xer&nameLang=ENGLISH`)).status).toBe(400);
  });

  it("keeps translations in a new version of the series", async () => {
    const v2 = await admin.post(`${base()}/versions`, {});
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    const list = (await member.get(`/projects/${pid}/schedules/${v2.body.id}/translations?lang=en`)).body.items as unknown[];
    expect(list).toHaveLength(4);
  });

  it("answers AI translation with ai_off without the AI module", async () => {
    const r = await admin.post(`${base()}/translations/ai`, { lang: "fr" });
    expect(r.status).toBe(hasAi ? 409 : 403);
  });

  it.runIf(hasAi)("explains that AI translation needs a provider", async () => {
    const r = await admin.post(`${base()}/translations/ai`, { lang: "fr" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("ai_no_provider");
    expect(r.body.message).toContain("translation table");
    expect(stubCalls).toHaveLength(0);
  });

  it.runIf(hasAi)("translates missing names with the project's AI provider and rejects invented codes", async () => {
    const prov = await admin.post("/admin/ai/providers", { name: "Sahte yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    // A20 and the untranslated WBS nodes are missing in English.
    const en = await admin.post(`${base()}/translations/ai`, { lang: "en" });
    expect(en.status, JSON.stringify(en.body)).toBe(200);
    const n = 1 + otherWbs.length;
    expect(en.body).toEqual({ lang: "en", requested: n, translated: n, rejected: 0, remaining: 0, model: "qwen3:8b" });
    expect(stubCalls.at(-1)!.items).toEqual(expect.arrayContaining([{ code: "A20", name: "Şantiye binası" }, ...otherWbs]));
    expect(stubCalls.at(-1)!.items).toHaveLength(n);
    expect(stubCalls.at(-1)!.system).toContain("into English");
    expect(stubCalls.at(-1)!.system).toContain("NATM");
    const a20 = ((await member.get(`${base()}/translations?lang=en`)).body.items as { activityCode: string; name: string; source: string; model: string }[]).find((x) => x.activityCode === "A20");
    expect(a20).toMatchObject({ name: "EN Şantiye binası", source: "ai", model: "qwen3:8b" });

    // Selected codes only; nothing left → no model call.
    const fr = await admin.post(`${base()}/translations/ai`, { lang: "fr", codes: ["A10", "A30"] });
    expect(fr.body).toMatchObject({ requested: 2, translated: 2, remaining: 0 });
    expect(stubCalls.at(-1)!.system).toContain("into French");
    const calls = stubCalls.length;
    expect((await admin.post(`${base()}/translations/ai`, { lang: "en" })).body).toMatchObject({ requested: 0, translated: 0 });
    expect(stubCalls).toHaveLength(calls);
    const fr2 = (await member.get(`${base()}/translations?lang=fr`)).body.items as { activityCode: string }[];
    expect(fr2.map((x) => x.activityCode).sort()).toEqual(["A10", "A30"]);
  });
});
