/**
 * P6 activity codes (XER import → store → XER / P6 XML / Excel export → re-import) and the
 * Schedule of Payments API: items from the "SOP" code type, SoP table upload / template, item ↔
 * activity mapping, payment cash flow and traceability (ER 4.9.1), permissions.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import type { ActivityCodesDto } from "@7dimensions-project/sitekeep-ee-planning/shared/codes.js";
import type { PaymentCashFlowDto, PaymentItemDto, PaymentItemProgressDto, PaymentTraceabilityDto } from "@7dimensions-project/sitekeep-ee-planning/shared/payments.js";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { decodeText } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/import.js";
import { parseXer, readXerTables } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/xer.js";
import { parseMspdi } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/mspdi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const XER = readFileSync(path.join(here, "../../fixtures", "schedule-codes.xer"));
const PW = "Sifre-1234567";

describe("XER activity codes parser", () => {
  it("reads project and global code types, values with hierarchy and the assignments of the project", () => {
    const p = parseXer(decodeText(XER));
    const codes = p.activityCodes!;
    // OTHER belongs to another project and is left out.
    expect(codes.types.map((t) => [t.name, t.scope])).toEqual([["ZONE", "project"], ["SOP", "project"], ["DISCIPLINE", "global"]]);
    const sop = codes.types.find((t) => t.name === "SOP")!;
    expect(sop.values.map((v) => v.value)).toEqual(["1", "1.1", "2.1", "9.9"]);
    expect(sop.values.find((v) => v.value === "1.1")!.parentKey).toBe("21");
    expect(sop.values.find((v) => v.value === "1.1")!.description).toBe("Design of section A");
    expect(codes.assignments).toHaveLength(12);
    expect(codes.assignments.every((a) => a.typeKey !== "4")).toBe(true);
  });

  it("reads named MSPDI text fields as code types", () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>p</Name>
      <ExtendedAttributes>
        <ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName><Alias>Activity Code</Alias></ExtendedAttribute>
        <ExtendedAttribute><FieldID>188743734</FieldID><FieldName>Text2</FieldName><Alias>Zone</Alias></ExtendedAttribute>
        <ExtendedAttribute><FieldID>188743767</FieldID><FieldName>Number1</FieldName><Alias>Start km</Alias></ExtendedAttribute>
      </ExtendedAttributes>
      <Tasks>
        <Task><UID>1</UID><Name>A</Name><OutlineLevel>1</OutlineLevel><Start>2027-01-04T08:00:00</Start><Finish>2027-01-08T17:00:00</Finish>
          <ExtendedAttribute><FieldID>188743731</FieldID><Value>A100</Value></ExtendedAttribute>
          <ExtendedAttribute><FieldID>188743734</FieldID><Value>North</Value></ExtendedAttribute>
          <ExtendedAttribute><FieldID>188743767</FieldID><Value>12.5</Value></ExtendedAttribute></Task>
        <Task><UID>2</UID><Name>B</Name><OutlineLevel>1</OutlineLevel><Start>2027-01-04T08:00:00</Start><Finish>2027-01-08T17:00:00</Finish>
          <ExtendedAttribute><FieldID>188743734</FieldID><Value>South</Value></ExtendedAttribute></Task>
      </Tasks></Project>`;
    const p = parseMspdi(xml);
    expect(p.activityCodes!.types).toHaveLength(1);
    expect(p.activityCodes!.types[0]!.name).toBe("Zone");
    expect(p.activityCodes!.types[0]!.values.map((v) => v.value)).toEqual(["North", "South"]);
    expect(p.activityCodes!.assignments.map((a) => a.activityKey)).toEqual(["1", "2"]);
  });
});

describe("Activity codes and Schedule of Payments API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-payments-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 9) });
    await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
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
      const json = res.headers["content-type"]?.toString().includes("json");
      return { status: res.statusCode, body: json && res.body ? res.json() : null, raw: res.rawPayload, headers: res.headers };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
      put: (u: string, p: unknown) => call("PUT", u, p),
      patch: (u: string, p: unknown) => call("PATCH", u, p),
      del: (u: string) => call("DELETE", u),
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
  const base = () => `/projects/${pid}/schedules/${sid}`;
  const codesOf = async (id = sid) => (await admin.get(`/projects/${pid}/schedules/${id}/activity-codes`)).body as ActivityCodesDto;
  const valueOf = (c: ActivityCodesDto, activity: string, type: string) => {
    const t = c.types.find((x) => x.name === type)!;
    const a = c.assignments.find((x) => x.activityCode === activity && x.typeId === t.id);
    return t.values.find((v) => v.id === a?.valueId)?.value ?? null;
  };

  it("imports a P6 XER with its activity codes", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Uye", password: PW });
    pid = (await admin.post("/projects", { code: "SOP", name: "Payments" })).body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    const r = await admin.upload(`/projects/${pid}/schedules`, "codes.xer", XER);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.id;
    const c = await codesOf();
    expect(c.types.map((t) => t.name)).toEqual(["ZONE", "SOP", "DISCIPLINE"]);
    expect(c.types.every((t) => t.source === "import")).toBe(true);
    expect(c.assignments).toHaveLength(12);
    expect(valueOf(c, "D1000", "SOP")).toBe("1.1");
    expect(valueOf(c, "T2000", "DISCIPLINE")).toBe("CIV.TRK");
    const disc = c.types.find((t) => t.name === "DISCIPLINE")!;
    expect(disc.values.find((v) => v.value === "CIV.TRK")!.parentId).toBe(disc.values.find((v) => v.value === "CIV")!.id);
    // Members read the codes.
    expect((await member.get(`${base()}/activity-codes`)).status).toBe(200);
  });

  it("writes the codes back to XER and keeps them through a re-import", async () => {
    const res = await admin.get(`${base()}/export?format=xer`);
    expect(res.status).toBe(200);
    const text = decodeText(Buffer.from(res.raw));
    const tables = readXerTables(text);
    expect(tables.get("ACTVTYPE")!.map((r) => [r.actv_code_type, r.actv_code_type_scope])).toEqual([
      ["ZONE", "AS_Project"],
      ["SOP", "AS_Project"],
      ["DISCIPLINE", "AS_Global"],
    ]);
    expect(tables.get("ACTVCODE")).toHaveLength(8);
    expect(tables.get("TASKACTV")).toHaveLength(12);
    const child = tables.get("ACTVCODE")!.find((r) => r.short_name === "1.1")!;
    expect(tables.get("ACTVCODE")!.find((r) => r.actv_code_id === child.parent_actv_code_id)!.short_name).toBe("1");

    // Round trip: the exported file parses back to the same codes …
    const back = parseXer(text).activityCodes!;
    expect(back.types.map((t) => t.name)).toEqual(["ZONE", "SOP", "DISCIPLINE"]);
    expect(back.assignments).toHaveLength(12);
    // … and as a new version of the series the assignments stay.
    const v2 = await admin.upload(`/projects/${pid}/schedules`, "codes-v2.xer", Buffer.from(res.raw), { seriesId: sid });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    const c2 = await codesOf(v2.body.id);
    expect(c2.types.map((t) => t.name)).toEqual(["ZONE", "SOP", "DISCIPLINE"]);
    expect(c2.assignments).toHaveLength(12);
    expect(valueOf(c2, "D1000", "SOP")).toBe("1.1");
    expect(valueOf(c2, "T2000", "DISCIPLINE")).toBe("CIV.TRK");
  });

  it("exports codes to P6 XML, Excel and CSV", async () => {
    const xml = (await admin.get(`${base()}/export?format=p6xml`)).raw.toString("utf8");
    expect(xml).toContain("<ActivityCodeType>");
    expect(xml).toContain("<Name>SOP</Name>");
    expect(xml).toContain("<Scope>Global</Scope>");
    expect(xml).toMatch(/<Code>\s*<TypeObjectId>\d+<\/TypeObjectId>\s*<ValueObjectId>\d+<\/ValueObjectId>\s*<\/Code>/);
    const wb = XLSX.read((await admin.get(`${base()}/export?format=xlsx`)).raw, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });
    const header = rows[0]!;
    expect(header).toEqual(expect.arrayContaining(["ZONE", "SOP", "DISCIPLINE"]));
    const d1000 = rows.find((r) => r[0] === "D1000")!;
    expect(d1000[header.indexOf("SOP")]).toBe("1.1");
    const csv = (await admin.get(`${base()}/export?format=csv`)).raw.toString("utf8");
    expect(csv.split("\r\n")[0]).toContain("ZONE,SOP,DISCIPLINE");
  });

  it("lets planners edit code types, values and an activity's codes; members cannot", async () => {
    const t = await admin.post(`${base()}/activity-codes/types`, { name: "CONTRACT" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((await admin.post(`${base()}/activity-codes/types`, { name: "contract" })).status).toBe(409);
    const v = await admin.post(`${base()}/activity-codes/types/${t.body.id}/values`, { value: "C1", description: "Main contract" });
    expect(v.status).toBe(200);
    const sub = await admin.post(`${base()}/activity-codes/types/${t.body.id}/values`, { value: "C1.1", parentId: v.body.id });
    expect(sub.status).toBe(200);
    // A value cannot move under its own child.
    expect((await admin.patch(`${base()}/activity-codes/values/${v.body.id}`, { parentId: sub.body.id })).status).toBe(400);
    expect((await admin.put(`${base()}/activity-codes/assignments`, { activityCode: "T2020", items: [{ typeId: t.body.id, valueId: sub.body.id }] })).status).toBe(200);
    expect(valueOf(await codesOf(), "T2020", "CONTRACT")).toBe("C1.1");
    expect((await admin.put(`${base()}/activity-codes/assignments`, { activityCode: "NOPE", items: [{ typeId: t.body.id, valueId: null }] })).status).toBe(400);
    expect((await member.post(`${base()}/activity-codes/types`, { name: "X" })).status).toBe(403);
    expect((await member.put(`${base()}/activity-codes/assignments`, { activityCode: "T2020", items: [{ typeId: t.body.id, valueId: null }] })).status).toBe(403);
    expect((await admin.del(`${base()}/activity-codes/types/${t.body.id}`)).status).toBe(200);
    expect((await codesOf()).types.map((x) => x.name)).not.toContain("CONTRACT");
  });

  it("derives SoP items from the SOP code type", async () => {
    expect((await admin.get(`${base()}/payment-items`)).body.items).toEqual([]);
    const sop = (await codesOf()).types.find((t) => t.name === "SOP")!;
    const r = await admin.post(`${base()}/payment-items/from-codes`, { typeId: sop.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created: 4, updated: 0, mapped: 3 });
    const { items, progress } = (await admin.get(`${base()}/payment-items`)).body as { items: PaymentItemDto[]; progress: PaymentItemProgressDto[] };
    expect(items.map((i) => i.code)).toEqual(["1", "1.1", "2.1", "9.9"]);
    const byCode = (c: string) => items.find((i) => i.code === c)!;
    expect(byCode("1.1").parentId).toBe(byCode("1").id);
    expect(byCode("1.1").activityCodes).toEqual(["D1000", "D1010"]);
    expect(byCode("1.1").description).toBe("Design of section A");
    const st = (c: string) => progress.find((p) => p.code === c)!;
    expect(st("1").status).toBe("group");
    expect(st("1.1")).toMatchObject({ status: "planned", plannedDate: "2027-03-05", mapped: 2, done: 1, actualDate: null });
    expect(st("2.1")).toMatchObject({ milestoneOnly: true, plannedDate: "2027-04-30" });
    expect(st("9.9").status).toBe("unmapped");
  });

  it("uploads the SoP table: amounts, currency, parents and mapping", async () => {
    const tpl = await admin.get(`/projects/${pid}/schedules/payment-template?sid=${sid}`);
    expect(tpl.status).toBe(200);
    const twb = XLSX.read(tpl.raw, { type: "buffer" });
    const trows = XLSX.utils.sheet_to_json<unknown[]>(twb.Sheets[twb.SheetNames[0]!]!, { header: 1, defval: "" });
    expect(trows[0]).toEqual(["Item Code", "Description", "Amount", "Currency", "Unit", "Quantity", "Parent Item", "Activity Codes"]);
    expect(trows.slice(1).map((r) => r[0])).toEqual(["1", "1.1", "2.1", "9.9"]);

    const ws = XLSX.utils.aoa_to_sheet([
      ["Item Code", "Description", "Amount", "Currency", "Parent Item", "Activity Codes"],
      ["1.1", "Design of section A", "250.000,00", "USD", "1", "D1000; D1010"],
      ["2.1", "Track works A", 1200000, "USD", "", "T2010"],
      ["9.9", "Handover", 50000, "USD", "", "X999"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SoP");
    const r = await admin.upload(`${base()}/payment-items/import`, "sop.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rows: 3, created: 0, updated: 3, unknownCodes: ["X999"] });
    const items = (await admin.get(`${base()}/payment-items`)).body.items as PaymentItemDto[];
    expect(items.find((i) => i.code === "1.1")).toMatchObject({ amount: 250000, currency: "USD" });
    expect(items.find((i) => i.code === "9.9")!.activityCodes).toEqual(["X999"]);

    const bad = await admin.upload(`${base()}/payment-items/import`, "x.csv", Buffer.from("foo;bar\n1;2\n"));
    expect(bad.status).toBe(400);
    expect((await member.upload(`${base()}/payment-items/import`, "sop.xlsx", Buffer.from("x"))).status).toBe(403);
  });

  it("edits an item and its mapping", async () => {
    const items = (await admin.get(`${base()}/payment-items`)).body.items as PaymentItemDto[];
    const item = items.find((i) => i.code === "9.9")!;
    expect((await admin.put(`${base()}/payment-items/${item.id}/activities`, { activityCodes: ["T2020"] })).status).toBe(200);
    expect((await admin.patch(`${base()}/payment-items/${item.id}`, { amount: 60000 })).status).toBe(200);
    const c = await admin.post(`${base()}/payment-items`, { code: "3.1", description: "Spare", amount: 10, currency: "EUR" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await admin.post(`${base()}/payment-items`, { code: "3.1" })).status).toBe(409);
    const one = items.find((i) => i.code === "1")!;
    const child = items.find((i) => i.code === "1.1")!;
    // An item cannot move under its own sub-item.
    expect((await admin.patch(`${base()}/payment-items/${one.id}`, { parentCode: child.code })).status).toBe(400);
    const spare = ((await admin.get(`${base()}/payment-items`)).body.items as PaymentItemDto[]).find((i) => i.code === "3.1")!;
    expect((await admin.del(`${base()}/payment-items/${spare.id}`)).status).toBe(200);
    expect((await member.del(`${base()}/payment-items/${item.id}`)).status).toBe(403);
  });

  it("computes the monthly payment curve and exports it to Excel", async () => {
    const flow = (await member.get(`${base()}/payment-cashflow`)).body as PaymentCashFlowDto;
    expect(flow.currency).toBe("USD");
    expect(flow.total).toBe(250000 + 1200000 + 60000);
    expect(flow.months.map((m) => m.month)).toEqual(["2027-03", "2027-04", "2027-05"]);
    expect(flow.months.find((m) => m.month === "2027-04")!.planned).toBe(1200000);
    expect(flow.months.at(-1)!.cumPlanned).toBe(flow.total);
    // Nothing is fully delivered yet, so nothing is earned; actual stops at the data date's month.
    expect(flow.earned).toBe(0);
    expect(flow.months.find((m) => m.month === "2027-03")!.cumActual).toBe(0);
    expect(flow.months.find((m) => m.month === "2027-04")!.cumActual).toBeNull();
    const x = await admin.get(`${base()}/payment-cashflow?format=xlsx`);
    expect(x.status).toBe(200);
    const wb = XLSX.read(x.raw, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });
    expect(rows[0]).toEqual(["Month", "Planned (Current)", "Baseline", "Actual", "Cumulative Planned", "Cumulative Baseline", "Cumulative Actual"]);
    expect(rows[1]![0]).toBe("2027-03");
  });

  it("reports traceability findings and the underpinning activities", async () => {
    const tr = (await member.get(`${base()}/payment-traceability`)).body as PaymentTraceabilityDto;
    expect(tr.counts.items).toBe(3);
    expect(tr.itemsWithoutActivities).toEqual([]);
    // T2000 underpins item 2.1 only through its milestone, so it is not mapped itself.
    expect(tr.activitiesWithoutItem.map((a) => a.code)).toEqual(["T2000"]);
    expect(tr.milestoneOnlyItems.map((i) => i.code)).toEqual(["2.1"]);
    const u = tr.underpinning.find((x) => x.code === "2.1")!;
    expect(u.activities.map((a) => [a.code, a.via])).toEqual([["T2010", null], ["T2000", "T2010"]]);
    const x = await admin.get(`${base()}/payment-traceability?format=xlsx`);
    expect(x.status).toBe(200);
    expect(XLSX.read(x.raw, { type: "buffer" }).SheetNames).toContain("Underpinning Activities");
  });

  it("adds the no_payment_item rule to the schedule checks", async () => {
    const r = (await member.get(`${base()}/checks`)).body as { findings: { rule: string; message: string; activityCode?: string; params: Record<string, string> }[] };
    const mine = r.findings.filter((f) => f.rule === "no_payment_item");
    expect(mine.filter((f) => f.message === "noPaymentItem").map((f) => f.activityCode)).toEqual(["T2000"]);
    expect(mine.find((f) => f.message === "paymentItemMilestonesOnly")!.params.item).toBe("2.1");
  });

  it("puts the payment items on the exported activities", async () => {
    const wb = XLSX.read((await admin.get(`${base()}/export?format=xlsx`)).raw, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: "" });
    const col = rows[0]!.indexOf("Payment Items (SoP)");
    expect(col).toBeGreaterThan(0);
    expect(rows.find((r) => r[0] === "D1000")![col]).toBe("1.1");
    expect(rows.find((r) => r[0] === "T2020")![col]).toBe("9.9");
  });
});
