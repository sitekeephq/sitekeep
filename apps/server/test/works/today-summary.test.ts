/**
 * "Günün Özeti" (docs/product/SIMPLIFICATION.md, 2. aşama): deterministic summary, the invented-number guard,
 * cache and stamp, AI off / mocked provider / task queue, and per-user scoping.
 */
import { hasAi, hasManage } from "../helpers/modules.js"; // AI steps run when the AI module is installed
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { TODAY_SUMMARY_MAX_LINES, type TodayRowDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { todaySummaries, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { summaryDue, todaySummaryIdle } from "../../src/today/service.js";
import { autoSummary, compactInput, inputStamp, parseAiSummary, recordNumbers, type TodayData } from "../../src/today/text.js";

// ---- Pure: deterministic summary and guard ----------------------------------------------------

const TODAY = "2026-10-11";
const row = (o: Partial<TodayRowDto> & Pick<TodayRowDto, "number" | "title">): TodayRowDto => ({
  kind: "work",
  id: o.number,
  typeLabel: "Bilgi Talebi",
  dueDate: null,
  overdue: false,
  link: `/p/x/works/${o.number}`,
  ...o,
});
const rfi3 = row({ number: "ZAVM-RFI-0003", title: "B3 kazı iksa detayı", dueDate: "2026-10-06", overdue: true, note: "Cevap bekleniyor", party: "Prota" });
const rfi4 = row({ number: "ZAVM-RFI-0004", title: "B3 perde donatısı", dueDate: "2026-10-13", note: "Cevap bekleniyor", party: "Prota" });
const step = row({ kind: "task", number: "ZAVM-INC-0002", title: "B3 paftaları incelemesi", typeLabel: "Doküman İncelemesi", dueDate: TODAY, note: "2. Müşavir Onayı" });
const action = row({ number: "TPL-014", title: "Toplantı eylemleri", typeLabel: "Eylem", dueDate: "2026-10-09", overdue: true });

function fixture(): TodayData {
  return {
    projectId: "p",
    mine: { tasks: [step], works: [], actions: [action], replies: [rfi3, rfi4], receipts: [], forms: [], issues: [] },
    overdue: [rfi3, action],
    upcoming: [step, rfi4],
    upcomingDays: 7,
    changes: [
      {
        day: "2026-10-10",
        changes: [
          {
            at: "2026-10-10T09:00:00Z",
            userName: "Elif Aydın",
            action: "file.version_added",
            text: "3 dosyaya yeni versiyon yükledi",
            count: 3,
            items: [
              { label: "B3-A-101.pdf", link: "/p/x/files/f?file=1" },
              { label: "B3-A-102.pdf", link: "/p/x/files/f?file=2" },
            ],
          },
        ],
      },
    ],
    changeDays: 7,
    counts: { mine: 4, overdue: 2, upcoming: 2, changes: 3 },
    generatedAt: `${TODAY}T08:00:00Z`,
  };
}

const empty = (): TodayData => ({
  projectId: "p",
  mine: { tasks: [], works: [], actions: [], replies: [], receipts: [], forms: [], issues: [] },
  overdue: [],
  upcoming: [],
  upcomingDays: 7,
  changes: [],
  changeDays: 7,
  counts: { mine: 0, overdue: 0, upcoming: 0, changes: 0 },
  generatedAt: `${TODAY}T08:00:00Z`,
});

describe("deterministic summary (no AI)", () => {
  it("writes templated Turkish sentences for a typical day, with links to the records", () => {
    const s = autoSummary(fixture(), TODAY);
    expect(s.map((b) => b.text)).toEqual([
      "Size düşen 4 iş var: 1 onay adımı, 1 eylem, 2 cevap beklenen yazı.",
      "Bugün 1 işin termini doluyor: ZAVM-INC-0002.",
      "2 işin termini geçti; en eskisi ZAVM-RFI-0003 (5 gün).",
      "Cevabınızı bekleyen 2 yazı var (Prota 2): ZAVM-RFI-0003, ZAVM-RFI-0004.",
      "Dün: Elif Aydın 3 dosyaya yeni versiyon yükledi (B3-A-101.pdf, B3-A-102.pdf).",
      "En acil: ZAVM-RFI-0003 B3 kazı iksa detayı.",
    ]);
    expect(s[1]!.refs).toEqual([{ number: "ZAVM-INC-0002", link: "/p/x/works/ZAVM-INC-0002" }]);
    expect(s[3]!.refs.map((r) => r.number)).toEqual(["ZAVM-RFI-0003", "ZAVM-RFI-0004"]);
    expect(s[4]!.refs[0]).toEqual({ number: "B3-A-101", link: "/p/x/files/f?file=1" });
  });

  it("says so when nothing waits, and mentions later due dates when there is room", () => {
    expect(autoSummary(empty(), TODAY).map((b) => b.text)).toEqual(["Size bekleyen bir iş yok.", "Termini geçen iş yok.", "Son 7 günde değişiklik yok."]);
    const d = empty();
    d.upcoming = [rfi4];
    d.counts.upcoming = 1;
    expect(autoSummary(d, TODAY).map((b) => b.text)).toContain("Önümüzdeki 7 günde 1 termin daha var; ilki ZAVM-RFI-0004 (13.10.2026).");
  });
});

describe("compact model input", () => {
  it("holds counts and at most 15 short lines, never documents", () => {
    const d = fixture();
    d.upcoming = Array.from({ length: 40 }, (_, i) => row({ number: `ZAVM-EYL-${String(i + 1).padStart(4, "0")}`, title: `Eylem ${i + 1} ${"uzun ".repeat(30)}`, dueDate: "2026-10-15" }));
    const input = compactInput(d, TODAY);
    const lines = input.text.split("\n");
    expect(lines[0]).toBe("Bugün: 11.10.2026");
    expect(lines[1]).toContain("bana düşen 4 (onay adımı 1, eylem 1, cevap beklenen yazı 2)");
    const recordLines = lines.filter((l) => / \| /.test(l) && !l.startsWith("Kayıtlar"));
    const changeLines = lines.slice(lines.indexOf("Son değişiklikler:") + 1);
    expect(recordLines.length + changeLines.length).toBe(TODAY_SUMMARY_MAX_LINES);
    // My step first, then the letters waiting for me (with who waits), then overdue.
    expect(recordLines[0]).toMatch(/^ZAVM-INC-0002 \| B3 paftaları incelemesi \| Doküman İncelemesi \| termini bugün \| onayımı bekliyor; 2\. Müşavir Onayı$/);
    expect(recordLines[1]).toBe("ZAVM-RFI-0003 | B3 kazı iksa detayı | Bilgi Talebi | 06.10.2026, 5 gün gecikti | Cevap bekleniyor; bekleyen: Prota");
    expect(Math.max(...recordLines.map((l) => l.length))).toBeLessThan(160);
    expect(input.text.length).toBeLessThan(2500);
  });

  it("stamps the input: same data, same stamp; any change, a new one", () => {
    const a = inputStamp(compactInput(fixture(), TODAY).text);
    expect(inputStamp(compactInput(fixture(), TODAY).text)).toBe(a);
    const d = fixture();
    d.mine.replies = [rfi3];
    expect(inputStamp(compactInput(d, TODAY).text)).not.toBe(a);
    expect(inputStamp(compactInput(fixture(), "2026-10-12").text)).not.toBe(a);
  });
});

describe("invented-number guard", () => {
  it("finds record numbers but not dates", () => {
    expect(recordNumbers("ZAVM-RFI-0003 ve #12, TPL-014'ün termini 2026-10-11; B3 aksı")).toEqual(["ZAVM-RFI-0003", "#12", "TPL-014"]);
  });

  it("drops bullets with record numbers or counts that are not in the input and links the rest", () => {
    const input = compactInput(fixture(), TODAY);
    const raw =
      "<think>düşünüyorum</think>Tamam, işte özet:\n" +
      "- Bugün **ZAVM-INC-0002** incelemesinin termini doluyor.\n" +
      "- Prota'nın 2 bilgi talebi cevabınızı bekliyor; ZAVM-RFI-0003 5 gündür sizde.\n" +
      "- ZAVM-RFI-0099 için cevap gecikti.\n" +
      "- 8 eylem gecikti.\n" +
      "- Dün 3 dosya revize edildi (9 Ekim'deki eylemler hâlâ açık).\n" +
      "- En acil: TPL-014 toplantı eylemleri.";
    const p = parseAiSummary(raw, input);
    expect(p.bullets.map((b) => b.text)).toEqual([
      "Bugün ZAVM-INC-0002 incelemesinin termini doluyor.",
      "Prota'nın 2 bilgi talebi cevabınızı bekliyor; ZAVM-RFI-0003 5 gündür sizde.",
      "Dün 3 dosya revize edildi (9 Ekim'deki eylemler hâlâ açık).",
      "En acil: TPL-014 toplantı eylemleri.",
    ]);
    expect(p.bullets[1]!.refs).toEqual([{ number: "ZAVM-RFI-0003", link: "/p/x/works/ZAVM-RFI-0003" }]);
    expect(p.dropped).toEqual([
      { text: "ZAVM-RFI-0099 için cevap gecikti.", numbers: ["ZAVM-RFI-0099"] },
      { text: "8 eylem gecikti.", numbers: ["8"] },
    ]);
  });

  it("takes plain lines when the model wrote no bullet markers, at most six", () => {
    const input = compactInput(fixture(), TODAY);
    const p = parseAiSummary(Array.from({ length: 9 }, () => "Bugün ZAVM-INC-0002 bekliyor.").join("\n"), input);
    expect(p.bullets).toHaveLength(6);
  });
});

describe("cache rule", () => {
  const base = { userId: "u", projectId: "p", bullets: [{ text: "x", refs: [] }], model: "m", source: "provider", error: null, errorAt: null };
  const now = new Date("2026-10-11T10:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it("regenerates when the stamp changed, at most every 15 minutes; Yenile skips the 15 minutes", () => {
    const row = { ...base, stamp: "a", generatedAt: ago(5), attemptedAt: ago(5) };
    expect(summaryDue(undefined, "a", now, false)).toBe(true);
    expect(summaryDue(row, "a", now, false)).toBe(false);
    expect(summaryDue(row, "b", now, false)).toBe(false);
    expect(summaryDue({ ...row, attemptedAt: ago(16) }, "b", now, false)).toBe(true);
    expect(summaryDue({ ...row, attemptedAt: ago(16) }, "a", now, false)).toBe(false);
    expect(summaryDue(row, "b", now, true)).toBe(true);
    expect(summaryDue(row, "a", now, true)).toBe(false);
    // A failed last run may be retried by hand.
    expect(summaryDue({ ...row, error: "zaman aşımı", errorAt: ago(1) }, "a", now, true)).toBe(true);
  });
});

// ---- Endpoints ----------------------------------------------------------------------------------

const PW = "Sifre-1234567";
let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let stub: Server;
let stubUrl: string;
let stubMode: "ok" | "invent" = "ok";
const stubBodies: { messages: { role: string; content: string }[] }[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-today-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 7) });
  await handle.db.insert(users).values({ email: "admin@today.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  // A fake local OpenAI-compatible model: answers with the first record number of the prompt.
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      stubBodies.push(body);
      const user = (body.messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
      const first = /^(\S+) \| /m.exec(user)?.[1] ?? "YOK-0000";
      const answer =
        stubMode === "ok"
          ? `- Bugün termini geçen işleriniz var.\n- En acil: ${first} işini bitirin.`
          : "- ZAVM-XXX-9999 için cevap gecikti.\n- 777 iş gecikti.";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await todaySummaryIdle();
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
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
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

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let admin: Client, field: Client, other: Client, outsider: Client;
let pid: string;
let providerId: string;
const ids: Record<string, string> = {};
const P = () => `/projects/${pid}`;

async function summaryRow(email: string) {
  const [u] = await handle.db.select().from(users).where(eq(users.email, email));
  const [r] = await handle.db.select().from(todaySummaries).where(and(eq(todaySummaries.userId, u!.id), eq(todaySummaries.projectId, pid)));
  return r;
}

describe("Günün Özeti endpoints", () => {
  it.skipIf(!hasManage)("sets up a project with records for two members", async () => {
    admin = api({ cookie: await login("admin@today.test") });
    await admin.put("/admin/settings/mcp", { allowWriteTokens: true, tokenCreators: "everyone" });
    const pas = (await admin.post("/companies", { name: "Pasha" })).body.id;
    const hll = (await admin.post("/companies", { name: "Hill" })).body.id;
    pid = (await admin.post("/projects", { code: "BGN", name: "Bugün testi" })).body.id;
    for (const [key, company] of [["field", pas], ["other", hll], ["out", hll]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@today.test`, name: key.toUpperCase(), password: PW, companyId: company })).body.id;
      if (key !== "out") expect((await admin.post(`${P()}/members`, { email: `${key}@today.test` })).status).toBe(200);
    }
    field = api({ cookie: await login("field@today.test") });
    other = api({ cookie: await login("other@today.test") });
    outsider = api({ cookie: await login("out@today.test") });
    const types = (await admin.get(`${P()}/work-types`)).body as { id: string; key: string }[];
    const aksiyon = types.find((t) => t.key === "aksiyon")!.id;
    const w = await admin.post(`${P()}/works`, { typeId: aksiyon, title: "Kalıp çizimlerini revize et", assigneeUserId: ids.field, dueDate: day(-2), description: "GIZLI-ACIKLAMA metni", fields: {} });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    ids.fieldWork = w.body.number;
    ids.otherWork = (await admin.post(`${P()}/works`, { typeId: aksiyon, title: "Hill eylemi", assigneeUserId: ids.other, dueDate: day(1), fields: {} })).body.number;
  });

  it.skipIf(!hasManage)("AI off: only the deterministic summary, no model call", async () => {
    await admin.put("/admin/settings/ai", { mode: "off" });
    const t = await field.get(`${P()}/today`);
    expect(t.status).toBe(200);
    expect(t.body.summary).toMatchObject({ mode: "off", ai: null, running: false, queueTask: null });
    expect(t.body.summary.auto[0].text).toBe("Size düşen 1 iş var: 1 eylem.");
    expect(t.body.summary.auto.at(-1)).toEqual({
      text: `En acil: ${ids.fieldWork} Kalıp çizimlerini revize et.`,
      refs: [{ number: ids.fieldWork, link: expect.stringMatching(/^\/projects\/.+\/works\//) }],
    });
    const r = await field.post(`${P()}/today/summary`);
    expect(r.status).toBe(403);
    expect(stubBodies).toHaveLength(0);
  });

  it.skipIf(!hasAi || !hasManage)("AI on with a (mocked) local model: written in the background from the compact input, then cached", async () => {
    await admin.put("/admin/settings/ai", { mode: "local_only" });
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    providerId = prov.body.id;
    await admin.put("/admin/settings/ai", { defaultProviderId: providerId });

    const first = (await field.get(`${P()}/today`)).body.summary;
    expect(first.mode).toBe("provider");
    expect(first.running).toBe(true);
    expect(first.ai).toBeNull();
    expect(first.auto.length).toBeGreaterThanOrEqual(3);
    await todaySummaryIdle();

    const s = (await field.get(`${P()}/today/summary`)).body;
    expect(s.running).toBe(false);
    expect(s.ai).toMatchObject({ source: "provider", model: "qwen3:8b", fresh: true });
    expect(s.ai.bullets.map((b: { text: string }) => b.text)).toEqual(["Bugün termini geçen işleriniz var.", `En acil: ${ids.fieldWork} işini bitirin.`]);
    expect(s.ai.bullets[1].refs[0].number).toBe(ids.fieldWork);
    expect(stubBodies).toHaveLength(1);
    const sent = stubBodies[0]!.messages.map((m) => m.content).join("\n");
    expect(sent).toContain(ids.fieldWork);
    expect(sent).not.toContain("GIZLI-ACIKLAMA");

    // Same data: no new model call (page loads, polling, Yenile).
    await field.get(`${P()}/today`);
    expect((await field.post(`${P()}/today/summary`)).body.ai.fresh).toBe(true);
    await todaySummaryIdle();
    expect(stubBodies).toHaveLength(1);
  });

  it.skipIf(!hasAi || !hasManage)("data changed: no new run within 15 minutes; Yenile writes a new one", async () => {
    const types = (await admin.get(`${P()}/work-types`)).body as { id: string; key: string }[];
    await admin.post(`${P()}/works`, { typeId: types.find((t) => t.key === "aksiyon")!.id, title: "Yeni eylem", assigneeUserId: ids.field, dueDate: day(0), fields: {} });
    const s = (await field.get(`${P()}/today`)).body.summary;
    expect(s.running).toBe(false);
    expect(s.ai.fresh).toBe(false);
    await todaySummaryIdle();
    expect(stubBodies).toHaveLength(1);

    const r = await field.post(`${P()}/today/summary`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await todaySummaryIdle();
    expect(stubBodies).toHaveLength(2);
    expect((await field.get(`${P()}/today/summary`)).body.ai.fresh).toBe(true);
  });

  it.skipIf(!hasAi || !hasManage)("an answer with invented numbers is refused; the earlier summary stays", async () => {
    stubMode = "invent";
    const sync = await field.post(`${P()}/today/summary?wait=1`, { force: true });
    expect(sync.status).toBe(422);
    expect(sync.body.details.errors.join(" ")).toContain("ZAVM-XXX-9999");
    await field.post(`${P()}/today/summary`, { force: true });
    await todaySummaryIdle();
    const s = (await field.get(`${P()}/today/summary`)).body;
    expect(s.error).toMatch(/verilmeyen numaralar/);
    expect(s.ai.bullets[1].text).toContain("En acil");
    stubMode = "ok";
  });

  it.skipIf(!hasAi || !hasManage)("each user sees only their own summary; non-members none", async () => {
    const fieldRow = await summaryRow("field@today.test");
    expect(fieldRow?.bullets?.length).toBeGreaterThan(0);
    const o = (await other.get(`${P()}/today/summary`)).body;
    expect(o.ai).toBeNull(); // field's summary is not theirs
    expect(o.running).toBe(true);
    await todaySummaryIdle();
    const mine = (await other.get(`${P()}/today/summary`)).body;
    expect(JSON.stringify(mine.ai)).not.toContain(ids.fieldWork);
    expect(stubBodies.at(-1)!.messages.map((m) => m.content).join("\n")).not.toContain("Kalıp çizimlerini");
    expect((await summaryRow("field@today.test"))?.bullets).toEqual(fieldRow!.bullets);
    expect((await outsider.get(`${P()}/today/summary`)).status).toBe(404);
    expect((await outsider.post(`${P()}/today/summary`)).status).toBe(404);
    expect((await outsider.get(`${P()}/today`)).status).toBe(404);
  });

  it.skipIf(!hasManage)("remembers the collapsed card per user", async () => {
    expect((await field.patch("/me/prefs", { todaySummaryCollapsed: true })).body.todaySummaryCollapsed).toBe(true);
    expect((await field.get("/me/prefs")).body.todaySummaryCollapsed).toBe(true);
    expect((await other.get("/me/prefs")).body.todaySummaryCollapsed).toBeUndefined();
  });

  it.skipIf(!hasManage)("remembers the interface language per user and returns it with the session", async () => {
    expect((await field.patch("/me/prefs", { language: "tr" })).body.language).toBe("tr");
    expect((await field.get("/auth/me")).body.language).toBe("tr");
    expect((await other.get("/auth/me")).body.language).toBeNull();
    expect((await field.patch("/me/prefs", { language: "Türkçe" })).status).toBe(400);
    // Other prefs are kept.
    expect((await field.get("/me/prefs")).body.todaySummaryCollapsed).toBe(true);
  });

  it.skipIf(!hasAi || !hasManage)("no model: 'Yapay Zekâya Gönder' (today_summary) stores the connected client's answer as the requester's summary", async () => {
    await admin.del(`/admin/ai/providers/${providerId}`);
    await admin.put("/admin/settings/ai", { taskQueue: { enabled: true, allowExternalClients: true } });
    let s = (await other.get(`${P()}/today`)).body.summary;
    expect(s.mode).toBe("queue");
    expect((await other.post(`${P()}/today/summary`)).status).toBe(409);

    const task = await other.post(`${P()}/ai-tasks`, { kind: "today_summary", input: {} });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(task.body).toMatchObject({ label: "Bugün Özeti", summary: "Bugün sayfasının özeti" });
    s = (await other.get(`${P()}/today/summary`)).body;
    expect(s.queueTask).toEqual({ id: task.body.id, status: "pending" });

    // A connected client (other's write token) claims it: the prompt is the compact input only.
    const token = (await other.post("/auth/tokens", { name: "Claude Code", scope: "write" })).body.token;
    const client = api({ token });
    const claim = await client.post(`${P()}/ai-tasks/${task.body.id}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    const prompt = claim.body.prompt.messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain(ids.otherWork);
    expect(claim.body.tools).toEqual(["cde_project_today"]);
    const calls = stubBodies.length;

    const bad = await client.post(`${P()}/ai-tasks/${task.body.id}/complete`, { result: `- ${ids.otherWork} yarın bitiyor.\n- ZAVM-UYD-0001 de bekliyor.` });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors.join(" ")).toContain("ZAVM-UYD-0001");

    const ok = await client.post(`${P()}/ai-tasks/${task.body.id}/complete`, { result: `- Yarın ${ids.otherWork} termini doluyor.\n- En acil: ${ids.otherWork} Hill eylemi.` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.ok).toBe(true);
    s = (await other.get(`${P()}/today/summary`)).body;
    expect(s.queueTask).toBeNull();
    expect(s.ai).toMatchObject({ source: "queue", fresh: true });
    expect(s.ai.model).toContain("Claude Code");
    expect(s.ai.bullets[1].refs[0].number).toBe(ids.otherWork);
    expect(stubBodies.length).toBe(calls);
    // field's summary is untouched.
    expect((await summaryRow("field@today.test"))?.source).toBe("provider");
  });

  it.skipIf(!hasAi || !hasManage)("serves the same data plus the summary to MCP clients (cde_project_today)", async () => {
    const token = (await other.post("/auth/tokens", { name: "okuma" })).body.token;
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cde_project_today", arguments: { projectId: pid } } },
    });
    const out = JSON.parse((res.json() as any).result.content[0].text);
    expect(out.summary).toMatchObject({ source: "ai", bullets: [`Yarın ${ids.otherWork} termini doluyor.`, `En acil: ${ids.otherWork} Hill eylemi.`] });
    expect(out.counts.mine).toBe(1);
    expect(out.mine.actions.items[0]).toMatchObject({ number: ids.otherWork, title: "Hill eylemi" });
  });
});
