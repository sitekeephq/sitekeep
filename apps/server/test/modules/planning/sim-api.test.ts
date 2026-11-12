/** 4D / 5D over HTTP: link rules, 4D state, unit prices, cost rules, costs, reports, MCP tools, permissions and the module switch. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import * as XLSX from "xlsx";
import { cdeParseArgs, cdeToolDefinitions } from "@sitekeep/cde-tools";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { activityLinks } from "@7dimensions-project/sitekeep-ee-planning/internal/schema-tables.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { saveVersionIndex, type IndexFile } from "../../../src/jobs/version-index.js";
import { MODULE_TEMPLATES } from "../../../src/reports/templates-modules.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { moduleIds } from "../../../src/app/modules.js";

/** 5D is the Cost module's: its steps run when Cost is installed (SITEKEEP_MODULES). */
const hasCost = moduleIds().includes("cost");

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../../fixtures/model-query.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../../fixtures/model-query-v2.ifc"));
const PW = "Sifre-1234567";

/** Synthetic structural model (format-2 index); the uploaded IFC only provides the file version. */
function synthIndex(): IndexFile {
  const els: [string, string, string, number, Record<string, string | number>][] = [
    ["S2a", "IfcSlab", "Döşeme D1", 2, { "BaseQuantities.NetVolume": 10, "Pset_Proje.WBS": "A-200" }],
    ["S2b", "IfcSlab", "Döşeme D2", 2, { "BaseQuantities.NetVolume": 12.5, "Pset_Proje.WBS": "A-200" }],
    ["S2c", "IfcSlab", "Döşeme D3", 2, {}],
    ["S1a", "IfcSlab", "Döşeme D4", 1, { "BaseQuantities.NetVolume": 8, "Pset_Proje.WBS": "A-100" }],
    ["C2a", "IfcColumn", "Kolon K1", 2, { "BaseQuantities.NetVolume": 0.5 }],
    ["C2b", "IfcColumn", "Kolon K2", 2, { "BaseQuantities.NetVolume": 0.5 }],
    ["ST1", "IfcStair", "Merdiven M1", 0, {}],
  ];
  const keys: string[] = [];
  const vals: (string | number)[] = [];
  const k = (s: string) => (keys.includes(s) ? keys.indexOf(s) : keys.push(s) - 1);
  const v = (x: string | number) => (vals.includes(x) ? vals.indexOf(x) : vals.push(x) - 1);
  const file: IndexFile = {
    v: 2,
    storeys: [
      { name: "Zemin Kat", elevation: 0 },
      { name: "Kat 1", elevation: 3.5 },
      { name: "Kat 2", elevation: 7 },
    ],
    keys,
    vals,
    elements: {},
    details: {},
  };
  els.forEach(([guid, cls, name, storey, props], i) => {
    file.elements[guid] = [cls, name, `h${i}`];
    file.details![guid] = [100 + i, storey, -1, -1, `p${i}`, Object.entries(props).flatMap(([kk, vv]) => [k(kk), v(vv)])];
  });
  return file;
}

const CSV = [
  "Kod;Ad;Başlangıç;Bitiş;% Tamamlanma;TB;TS;GB;GS",
  "A-100;Kat 1 Döşeme Betonu;05.01.2026;16.01.2026;100;05.01.2026;16.01.2026;05.01.2026;16.01.2026",
  "A-200;Kat 2 Döşemeler;02.02.2026;13.02.2026;40;26.01.2026;06.02.2026;02.02.2026;",
  "A-210;Kat 2 Kolon Betonu;16.02.2026;20.02.2026;0;09.02.2026;13.02.2026;;",
  "A-300;Merdivenler;01.03.2026;10.03.2026;0;01.03.2026;10.03.2026;;",
].join("\r\n");
const MAPPING = { code: 0, name: 1, start: 2, finish: 3, percent: 4, baselineStart: 5, baselineFinish: 6, actualStart: 7, actualFinish: 8 };

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-sim-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 3) });
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

function client(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: Buffer, fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [key, val] of Object.entries(fields)) form.append(key, val);
      form.append("file", new Blob([data]), name);
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

function priceList(): Buffer {
  const wb = XLSX.utils.book_new();
  const rows = [
    ["Poz No", "Tanımı", "Birimi", "Birim Fiyatı (TL)", "Kategori"],
    ["BET-C30", "C30 hazır beton", "m3", 2500, "Betonarme"],
    ["DON-01", "Nervürlü donatı", "kg", "30,00", "Betonarme"],
    ["ANK-01", "Kolon ankrajı", "ad", 50, ""],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Liste");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("4D / 5D API", () => {
  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let outsider: ReturnType<typeof client>;
  let pid: string;
  let folderId: string;
  let fileId: string;
  let v1: string;
  let sid: string;
  const P = () => `/projects/${pid}`;
  const S = () => `${P()}/schedules/${sid}`;

  it("sets up a project, a model with a synthetic index and a schedule", async () => {
    admin = client(await login("admin@7d.test"));
    const memberId = (await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW })).body.id;
    await admin.post("/users", { email: "dis@7d.test", name: "Dış", password: PW });
    const p = await admin.post("/projects", { code: "SIM", name: "4D 5D Projesi" });
    pid = p.body.id;
    const contents = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    folderId = (await admin.post(`${P()}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
    expect((await admin.post(`${P()}/members`, { email: "uye@7d.test" })).status).toBe(200);
    await admin.put(`${P()}/folders/${folderId}/permissions`, { entries: [{ subjectType: "user", subjectId: memberId, level: "view" }] });
    member = client(await login("uye@7d.test"));
    outsider = client(await login("dis@7d.test"));

    const up = await admin.upload(`${P()}/folders/${folderId}/files`, "Kaba.ifc", IFC_V1);
    await jobs.drain();
    fileId = up.body.results[0].fileId;
    v1 = (await admin.get(`${P()}/files/${fileId}`)).body.versions[0].id;
    const tmp = path.join(dataDir, "synth.json");
    writeFileSync(tmp, JSON.stringify(synthIndex()));
    await saveVersionIndex(handle.db, storage, v1, pid, tmp, 7);

    const imp = await admin.upload(`${P()}/schedules`, "program.csv", Buffer.from(CSV, "utf8"), { mapping: JSON.stringify(MAPPING), dataDate: "2026-02-10" });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    sid = imp.body.id;
  });

  it("refuses rule changes to non-planners and everything to non-members", async () => {
    expect((await outsider.get(`${S()}/link-rules`)).status).toBe(404);
    expect((await member.get(`${S()}/link-rules`)).body).toEqual([]);
    const r = await member.post(`${S()}/link-rules`, { fileId, activityCode: "A-200", match: { classes: ["IfcSlab"] } });
    expect(r.status).toBe(403);
    if (hasCost) expect((await member.post(`${P()}/cost-items`, { code: "X", description: "X", unit: "m", unitPrice: 1 })).status).toBe(403);
    expect((await member.post(`${S()}/link-rules/apply`, { versionId: v1 })).status).toBe(403);
  });

  let slabRule: string;
  it("stores rules, previews counts per rule and proposes rules", async () => {
    const a = await admin.post(`${S()}/link-rules`, { fileId, activityCode: "A-200", match: { classes: ["IfcSlab"], storeys: ["Kat 2"] } });
    expect(a.status, a.body?.message).toBe(200);
    expect(a.body).toMatchObject({ activityCode: "A-200", activityName: "Kat 2 Döşemeler", label: "Kat: Kat 2 · Sınıf: Döşeme", fileName: "Kaba.ifc", appliedVersionId: null });
    slabRule = a.body.id;
    const b = await admin.post(`${S()}/link-rules`, { fileId, activityCode: "IGNORED", match: { property: { key: "WBS", equalsTarget: "code" } } });
    expect(b.body).toMatchObject({ activityCode: null, label: "WBS = faaliyet kodu" });
    await admin.post(`${S()}/link-rules`, { fileId, activityCode: "A-300", match: { classes: ["IfcDoor"] } });
    expect((await admin.post(`${S()}/link-rules`, { fileId, activityCode: "YOK", match: { classes: ["IfcSlab"] } })).status).toBe(400);
    expect((await admin.post(`${S()}/link-rules`, { fileId, activityCode: "A-200", match: {} })).status).toBe(400);
    expect((await admin.post(`${S()}/link-rules`, { fileId, match: { classes: ["IfcSlab"] } })).status).toBe(400);

    const prev = await member.post(`${S()}/link-rules/preview`, { versionId: v1 });
    expect(prev.status, prev.body?.message).toBe(200);
    expect(prev.body.rules.map((r: { matched: number }) => r.matched)).toEqual([3, 3, 0]);
    expect(prev.body).toMatchObject({ modelElements: 7, matchedElements: 4, targets: 2, multiTarget: 0 });
    const draft = await member.post(`${S()}/link-rules/preview`, { versionId: v1, rules: [{ activityCode: "A-210", match: { classes: ["IfcColumn"], storeys: ["Kat 2"] } }] });
    expect(draft.body.rules[0]).toMatchObject({ id: null, matched: 2, targets: 1 });

    const sug = await member.post(`${S()}/link-rules/suggest`, { versionId: v1 });
    expect(sug.status, sug.body?.message).toBe(200);
    const kolon = sug.body.suggestions.find((s: { activityCode: string }) => s.activityCode === "A-210");
    expect(kolon).toMatchObject({ match: { classes: ["IfcColumn"], storeys: ["Kat 2"] }, matched: 2 });
    expect(sug.body.suggestions[0].match).toEqual({ property: { key: "Pset_Proje.WBS", equalsTarget: "code" } });
  });

  it("applies rules as rule links next to manual links", async () => {
    const acts = (await admin.get(`${S()}/activities`)).body as { id: string; code: string; elementCount: number }[];
    const a210 = acts.find((x) => x.code === "A-210")!;
    const manual = await admin.post(`${S()}/activities/${a210.id}/links`, { kind: "ifc_element", targetId: v1, globalIds: ["C2a"] });
    expect(manual.status, manual.body?.message).toBe(200);
    expect(manual.body.ruleId).toBeNull();

    const res = await admin.post(`${S()}/link-rules/apply`, { versionId: v1 });
    expect(res.status, res.body?.message).toBe(200);
    expect(res.body).toMatchObject({ versionId: v1, activities: 2, elements: 4 });
    // Applying twice replaces the rule links; the manual link stays.
    await admin.post(`${S()}/link-rules/apply`, { fileId });
    const rows = await handle.db.select().from(activityLinks).where(eq(activityLinks.projectId, pid));
    expect(rows.filter((r) => r.ruleId).length).toBe(res.body.links);
    expect(rows.filter((r) => !r.ruleId).map((r) => r.globalIds)).toEqual([["C2a"]]);

    const list = (await member.get(`${S()}/activities`)).body as { code: string; elementCount: number }[];
    const count = (c: string) => list.find((x) => x.code === c)!.elementCount;
    expect([count("A-100"), count("A-200"), count("A-210")]).toEqual([1, 3, 1]);
    const rules = (await member.get(`${S()}/link-rules`)).body;
    expect(rules[0]).toMatchObject({ id: slabRule, appliedVersionId: v1, appliedCount: 3, newestVersionId: v1 });
    const els = (await member.get(`${S()}/elements`)).body;
    expect(els.elements.filter((e: { activityCode: string }) => e.activityCode === "A-200").flatMap((e: { globalIds: string[] }) => e.globalIds).sort()).toEqual(["S2a", "S2b", "S2b", "S2a", "S2c"].sort());
  });

  it("returns the 4D state at a date, planned and actual", async () => {
    const act = await member.get(`${S()}/4d-state?date=2026-02-10&mode=actual`);
    expect(act.status, act.body?.message).toBe(200);
    expect(act.body.counts).toEqual({ complete: 1, late: 2, not_started: 1, in_progress: 0 });
    expect(act.body.elementCounts).toEqual({ complete: 1, late: 4, not_started: 0, in_progress: 0 });
    expect(act.body.active.map((x: { code: string; percent: number }) => [x.code, x.percent])).toEqual([
      ["A-200", 40],
      ["A-210", 0],
    ]);
    const plan = await member.get(`${S()}/4d-state?date=2026-02-10&mode=planned`);
    expect(plan.body.active.map((x: { code: string; status: string; percent: number }) => [x.code, x.status, x.percent])).toEqual([["A-210", "in_progress", 40]]);
    expect((await member.get(`${S()}/4d-state?date=10.02.2026`)).status).toBe(400);
  });

  let c30: string;
  it.skipIf(!hasCost)("imports a unit price list with column mapping and keeps poz numbers unique", async () => {
    const one = await admin.post(`${P()}/cost-items`, { code: "BET-C30", description: "Eski beton", unit: "m³", unitPrice: 2000 });
    expect(one.status, one.body?.message).toBe(200);
    expect(one.body).toMatchObject({ currency: "TRY", unit: "m³" });
    c30 = one.body.id;
    expect((await admin.post(`${P()}/cost-items`, { code: "BET-C30", description: "X", unit: "m³", unitPrice: 1 })).status).toBe(400);
    expect((await admin.post(`${P()}/cost-items`, { code: "Y", description: "X", unit: "kutu", unitPrice: 1 })).status).toBe(400);

    const pre = await admin.upload(`${P()}/cost-items/import/preview`, "liste.xlsx", priceList());
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body).toMatchObject({ mapping: { code: 0, description: 1, unit: 2, unitPrice: 3, category: 4 }, itemCount: 3, error: null });
    const imp = await admin.upload(`${P()}/cost-items/import`, "liste.xlsx", priceList(), { mapping: JSON.stringify(pre.body.mapping) });
    expect(imp.body).toMatchObject({ created: 2, updated: 1, skipped: 0 });
    const items = (await member.get(`${P()}/cost-items`)).body;
    expect(items.map((i: { code: string; unitPrice: number }) => [i.code, i.unitPrice])).toEqual([
      ["ANK-01", 50],
      ["BET-C30", 2500],
      ["DON-01", 30],
    ]);
    const bad = await admin.upload(`${P()}/cost-items/import`, "liste.xlsx", priceList(), { mapping: JSON.stringify({ unitPrice: null }) });
    expect(bad.status).toBe(400);
  });

  it.skipIf(!hasCost)("computes costs by rules: totals, missing quantities, element lines and cash flow", async () => {
    const items = new Map(((await admin.get(`${P()}/cost-items`)).body as { id: string; code: string }[]).map((i) => [i.code, i.id]));
    const r1 = await admin.post(`${P()}/cost-rules`, { fileId, costItemId: c30, match: { classes: ["IfcSlab"] }, quantity: "NetVolume" });
    expect(r1.status, r1.body?.message).toBe(200);
    expect(r1.body).toMatchObject({ costItemCode: "BET-C30", label: "Sınıf: Döşeme", multiplier: 1 });
    const r2 = await admin.post(`${P()}/cost-rules`, {
      fileId,
      costItemId: items.get("DON-01"),
      match: { classes: ["IfcSlab"], storeys: ["Kat 2"] },
      quantity: "NetVolume",
      multiplier: 100,
      scheduleId: sid,
      activityCode: "A-200",
    });
    expect(r2.body).toMatchObject({ activityCode: "A-200", multiplier: 100 });
    await admin.post(`${P()}/cost-rules`, { fileId, costItemId: items.get("ANK-01"), match: { classes: ["IfcColumn"] }, quantity: "count" });
    expect((await admin.post(`${P()}/cost-rules`, { fileId, match: { classes: ["IfcColumn"] } })).status).toBe(400);
    expect((await admin.post(`${P()}/cost-rules`, { fileId, costItemId: c30, match: { classes: ["IfcSlab"] }, scheduleId: sid, activityCode: "YOK" })).status).toBe(400);

    const prev = await member.post(`${P()}/cost-rules/preview`, { versionId: v1 });
    expect(prev.status, prev.body?.message).toBe(200);
    expect(prev.body.rules.map((r: { matched: number; amount: number; missing: number }) => [r.matched, r.amount, r.missing])).toEqual([
      [4, 76250, 1],
      [3, 67500, 1],
      [2, 100, 0],
    ]);
    expect(prev.body.total).toBe(76250 + 67500 + 100);

    const sum = await member.get(`${P()}/costs`);
    expect(sum.status, sum.body?.message).toBe(200);
    expect(sum.body).toMatchObject({ total: 143850, currency: "TRY", missingCount: 2, scheduleId: sid, versions: [{ versionId: v1, fileName: "Kaba.ifc" }] });
    expect(sum.body.byCategory.map((g: { label: string; amount: number }) => [g.label, g.amount])).toEqual([
      ["Betonarme", 143750],
      ["Kategorisiz", 100],
    ]);
    const byAct = new Map(sum.body.byActivity.map((g: { key: string; amount: number }) => [g.key, g.amount]));
    // S1a → A-100 through its 4D rule link; C2a's anchor through the manual link.
    expect(byAct.get("A-100")).toBe(20000);
    expect(byAct.get("A-210")).toBe(50);
    expect(sum.body.missing[0]).toMatchObject({ guid: "S2c", quantity: "Net Hacim" });

    const heat = await member.get(`${P()}/costs/elements?versionId=${v1}`);
    expect(heat.body).toMatchObject({ total: 143850, max: 31250 + 37500, missing: ["S2c"] });
    expect(heat.body.elements.S2a).toBe(25000 + 30000);
    const lines = await member.get(`${P()}/costs/element?versionId=${v1}&guid=S2b`);
    expect(lines.body.map((l: { itemCode: string; quantity: number; amount: number }) => [l.itemCode, l.quantity, l.amount])).toEqual([
      ["BET-C30", 12.5, 31250],
      ["DON-01", 1250, 37500],
    ]);
    const flow = await member.get(`${P()}/costs/cashflow?step=week`);
    expect(flow.status, flow.body?.message).toBe(200);
    expect(flow.body.total).toBe(143850);
    expect(flow.body.points.at(-1).planned).toBeCloseTo(flow.body.scheduled, 1);
    expect(flow.body.points.find((p: { date: string }) => p.date === "2026-02-10")).toBeTruthy();
  });

  it.skipIf(!hasCost)("serves the report datasets and the Maliyet (5D) template", async () => {
    const tpl = MODULE_TEMPLATES.find((t) => t.id === "cost-5d")!;
    expect(tpl.name).toBe("Maliyet (5D)");
    const res = await member.post(`${P()}/reports/query`, { queries: tpl.queries });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results.total[0]).toMatchObject({ amount: 143850, count: 9 });
    expect(res.body.results.missing[0].count).toBe(2);
    expect(res.body.results.topItems[0]).toMatchObject({ item: "BET-C30 C30 hazır beton", unit: "m³", amount: 76250 });
    expect(res.body.results.cashflow.length).toBeGreaterThan(3);
    const catalog = await member.get(`${P()}/reports/catalog`);
    expect(catalog.body.templates.some((t: { id: string }) => t.id === "cost-5d")).toBe(true);
    expect(catalog.body.datasets.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(["model_costs", "cost_cashflow"]));
  });

  it("offers cde_cost_summary and cde_4d_state (MCP / Sor)", async () => {
    const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
      const r = method === "GET" ? await member.get(url) : await member.post(url, body);
      if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body?.message}`);
      return r.body as T;
    };
    const defs = cdeToolDefinitions(call, { readOnly: true });
    const tool = (name: string) => {
      const d = defs.find((x) => x.name === name)!;
      expect(d.write).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (args: Record<string, unknown>) => d.run(cdeParseArgs(d, args)) as Promise<any>;
    };
    if (hasCost) {
      const cost = await tool("cde_cost_summary")({ projectId: pid });
      expect(cost).toMatchObject({ currency: "TRY", total: 143850, models: ["Kaba.ifc V1"], missingQuantities: 2 });
      expect(cost.byItem[0]).toMatchObject({ code: "BET-C30", amount: 76250 });
      const one = await tool("cde_cost_summary")({ projectId: pid, versionId: v1, limit: 1 });
      expect(one.byItem).toHaveLength(1);
    }
    const st = await tool("cde_4d_state")({ projectId: pid, date: "2026-02-10" });
    expect(st).toMatchObject({ scheduleId: sid, mode: "actual", activities: { late: 2 }, linkedElements: 5 });
    expect(st.active[0]).toMatchObject({ code: "A-200", percent: 40, elements: 3 });
  });

  it("refuses 4D / 5D while the İş Programı module is off", async () => {
    expect((await admin.put(`${P()}/modules`, { modules: { schedule: false } })).status).toBe(200);
    try {
      for (const r of [
        await member.get(`${S()}/link-rules`),
        await member.get(`${S()}/4d-state`),
        await admin.post(`${S()}/link-rules/apply`, { versionId: v1 }),
        ...(hasCost
          ? [
              await member.get(`${P()}/costs`),
              await member.get(`${P()}/cost-items`),
              await admin.post(`${P()}/cost-items`, { code: "Z", description: "Z", unit: "m", unitPrice: 1 }),
            ]
          : []),
      ]) {
        expect(r.status).toBe(403);
        expect(r.body.error).toBe("module_disabled");
      }
    } finally {
      await admin.put(`${P()}/modules`, { modules: { schedule: true } });
    }
    expect((await member.get(hasCost ? `${P()}/costs` : `${S()}/link-rules`)).status).toBe(200);
  });

  it("re-applies link rules when a new model version is indexed", async () => {
    const up = await admin.upload(`${P()}/folders/${folderId}/files`, "Kaba.ifc", IFC_V2);
    expect(up.status).toBe(200);
    await jobs.drain();
    const v2 = (await admin.get(`${P()}/files/${fileId}`)).body.versions[0].id;
    expect(v2).not.toBe(v1);
    const rules = (await admin.get(`${S()}/link-rules`)).body as { appliedVersionId: string; newestVersionId: string; activityCode: string; appliedCount: number }[];
    expect(rules.every((r) => r.appliedVersionId === v2 && r.newestVersionId === v2)).toBe(true);
    // The real v2 model has doors (A-300 rule) but no "Kat 2" or WBS values.
    expect(rules.find((r) => r.activityCode === "A-300")!.appliedCount).toBeGreaterThan(0);
    const ruleLinks = await handle.db.select().from(activityLinks).where(and(eq(activityLinks.projectId, pid)));
    expect(ruleLinks.filter((r) => r.ruleId).every((r) => r.targetId === v2)).toBe(true);
    const manual = await handle.db.select().from(activityLinks).where(and(eq(activityLinks.projectId, pid), isNull(activityLinks.ruleId)));
    expect(manual.map((r) => r.targetId)).toEqual([v1]);
    // Deleting a rule removes its links.
    const doorRule = (await admin.get(`${S()}/link-rules`)).body.find((r: { activityCode: string }) => r.activityCode === "A-300");
    expect((await admin.del(`${P()}/link-rules/${doorRule.id}`)).status).toBe(200);
    const left = await handle.db.select().from(activityLinks).where(eq(activityLinks.activityCode, "A-300"));
    expect(left).toEqual([]);
  });
});
