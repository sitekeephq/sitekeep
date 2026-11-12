import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import yazl from "yazl";
import { activityStatusAt } from "@sitekeep/shared";
import { isActivityLate } from "@7dimensions-project/sitekeep-ee-planning/shared/schedule.js";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { parseUpload } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/import.js";
import { decodeText } from "../../../src/core/formats/text.js";
import { parseMspdi } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/mspdi.js";
import { parseXer } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/xer.js";
import { suggestMapping } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/table.js";
import { toIsoDate, parsePercent } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/model.js";
import { readXlsx } from "@7dimensions-project/sitekeep-ee-planning/internal/schedule/xlsx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(path.join(here, "../../fixtures", n));
const V1 = fx("schedule-v1.xml");
const V2 = fx("schedule-v2.xml");
const XER = fx("schedule.xer");
const CSV = fx("schedule.csv");
const IFC = fx("sample-wall.ifc");
const PW = "Sifre-1234567";

/** Builds a minimal .xlsx (shared strings, a date style, one sheet) with yazl. */
async function makeXlsx(sheetXml?: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const add = (name: string, xml: string) => zip.addBuffer(Buffer.from(xml, "utf8"), name);
  add(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Program" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  add(
    "xl/sharedStrings.xml",
    `<sst><si><t>Kod</t></si><si><t>Ad</t></si><si><t>Başlangıç</t></si><si><t>Bitiş</t></si><si><t>% Tamamlanma</t></si><si><t>Öncül</t></si><si><t>X1</t></si><si><r><t>Kalıp </t></r><r><t>&amp; donatı</t></r></si><si><t>X2</t></si><si><t>Beton</t></si></sst>`,
  );
  add("xl/styles.xml", `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`);
  add(
    "xl/worksheets/sheet1.xml",
    sheetXml ??
    `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>
      <row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" s="1"><v>46027</v></c><c r="D2" s="2"><v>46031</v></c><c r="E2"><v>0.25</v></c></row>
      <row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="s"><v>9</v></c><c r="C3" s="1"><v>46034</v></c><c r="D3" s="1"><v>46038</v></c><c r="E3"><v>0</v></c><c r="F3" t="inlineStr"><is><t>X1</t></is></c></row>
    </sheetData></worksheet>`,
  );
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("schedule parsers", () => {
  it("evaluates formulas saved without cached values (library-written .xlsx)", async () => {
    // Like files written by OpenXML/ClosedXML: x: prefix, finish = start + duration, chained
    // starts, MAX over a range and a shared formula; none has a cached <v>.
    const c = (r: string, inner: string, s = "") => `<x:c r="${r}"${s ? ` s="${s}"` : ""}>${inner}</x:c>`;
    const str = (r: string, t: string) => `<x:c r="${r}" t="inlineStr"><x:is><x:t>${t}</x:t></x:is></x:c>`;
    const sheet = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
      <x:row r="1">${str("A1", "Activity ID")}${str("B1", "Description")}${str("C1", "Duration")}${str("D1", "Start_Date")}${str("E1", "End_Date")}</x:row>
      <x:row r="2">${str("A2", "DEM-01")}${str("B2", "Yıkım 1")}${c("C2", "<x:v>10</x:v>")}${c("D2", "<x:v>46027</x:v>", "1")}${c("E2", "<x:f>D2+C2</x:f>", "1")}</x:row>
      <x:row r="3">${str("A3", "DEM-02")}${str("B3", "Yıkım 2")}${c("C3", "<x:v>10</x:v>")}${c("D3", "<x:v>46030</x:v>", "1")}${c("E3", '<x:f t="shared" ref="E3:E4" si="0">D3+C3</x:f>', "1")}</x:row>
      <x:row r="4">${str("A4", "FND-L1")}${str("B4", "Temel")}${c("C4", "<x:v>5</x:v>")}${c("D4", "<x:f>MAX(E2:E3)+1</x:f>", "1")}${c("E4", '<x:f t="shared" si="0"/>', "1")}</x:row>
      <x:row r="5">${str("A5", "WAL-L1")}${str("B5", "Duvar")}${c("C5", "<x:v>3</x:v>")}${c("D5", "<x:f>E4+1</x:f>", "1")}${c("E5", "<x:f>D5+C5+UNKNOWNFN(1)</x:f>", "1")}</x:row>
    </x:sheetData></x:worksheet>`;
    const { parsed } = parseUpload("program.xlsx", await makeXlsx(sheet));
    const byCode = new Map(parsed.activities.map((a) => [a.code, a]));
    expect(byCode.get("DEM-01")).toMatchObject({ start: "2026-01-05", finish: "2026-01-15" });
    expect(byCode.get("DEM-02")).toMatchObject({ start: "2026-01-08", finish: "2026-01-18" });
    // MAX(15.01, 18.01) + 1 → 19.01; shared E4 = D4 + C4 → 24.01.
    expect(byCode.get("FND-L1")).toMatchObject({ start: "2026-01-19", finish: "2026-01-24" });
    expect(byCode.get("WAL-L1")!.start).toBe("2026-01-25");
    expect(parsed.warnings.join(" ")).toContain("1 formül hesaplanamadı (E5)");
  });

  it("reads dates and percentages in the usual export formats", () => {
    expect(toIsoDate("2026-01-05T08:00:00")).toBe("2026-01-05");
    expect(toIsoDate("2026-01-05 08:00")).toBe("2026-01-05");
    expect(toIsoDate("05.01.2026")).toBe("2026-01-05");
    expect(toIsoDate("5/1/26")).toBe("2026-01-05");
    expect(toIsoDate("05-Jan-26")).toBe("2026-01-05");
    expect(toIsoDate("05 Oca 2026")).toBe("2026-01-05");
    expect(toIsoDate("31.02.2026")).toBeNull();
    expect(toIsoDate("46027", { allowSerial: true })).toBe("2026-01-05");
    expect(parsePercent("45%")).toBe(45);
    expect(parsePercent("0,5")).toBe(50);
    expect(parsePercent("120")).toBe(100);
  });

  it("parses MS Project XML: outline, links, lag, baseline, resources", () => {
    const p = parseMspdi(V1.toString("utf8"));
    expect(p.name).toBe("ZAVM Ana Program");
    expect(p.dataDate).toBe("2026-03-02");
    expect(p.activities.map((a) => a.code)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    const by = new Map(p.activities.map((a) => [a.code, a]));
    expect(by.get("1")!.summary).toBe(true);
    expect(by.get("3")!.parentKey).toBe("1");
    expect(by.get("3")!.name).toBe("Temel betonu & yalıtım");
    expect(by.get("3")!.durationDays).toBe(15);
    expect(by.get("3")!.resource).toBe("Poyraz İnşaat");
    expect(by.get("2")!.baselineFinish).toBe("2026-02-13");
    expect(by.get("7")!.milestone).toBe(true);
    expect(by.get("7")!.outlineLevel).toBe(1);
    const deps = p.dependencies.map((d) => `${d.predKey}>${d.succKey}:${d.type}:${d.lagDays}`);
    expect(deps).toEqual(["2>3:FS:0", "3>4:FS:1", "4>6:SS:0", "4>7:FF:0"]);
  });

  it("parses Primavera XER: WBS summaries, calendars, float, resources (Windows-1254)", () => {
    const p = parseXer(decodeText(XER));
    expect(p.name).toBe("MBE-PRG");
    expect(p.dataDate).toBe("2026-03-02");
    expect(p.activities.map((a) => a.code)).toEqual(["WBS-IST", "A1020", "WBS-IST.KAZ", "A1000", "A1010"]);
    const by = new Map(p.activities.map((a) => [a.code, a]));
    expect(by.get("WBS-IST")!.name).toBe("İstasyon");
    expect(by.get("A1010")!.wbsPath).toBe("IST.KAZ");
    expect(by.get("A1010")!).toMatchObject({ start: "2026-02-16", finish: "2026-03-10", actualStart: "2026-02-16", percentComplete: 50, durationDays: 15, critical: true, resource: "Ankara Metro JV" });
    expect(by.get("A1000")!).toMatchObject({ percentComplete: 100, critical: false, actualFinish: "2026-02-13" });
    expect(by.get("A1020")!).toMatchObject({ milestone: true, critical: false });
    // Summary rolled up from its tasks.
    expect(by.get("WBS-IST.KAZ")!).toMatchObject({ start: "2026-02-02", finish: "2026-03-10", summary: true });
    expect(p.dependencies.map((d) => `${d.predKey}>${d.succKey}:${d.type}:${d.lagDays}`)).toEqual(["1001>1002:FS:2", "1002>1003:FF:0"]);
  });

  it("parses Turkish CSV with suggested mapping, WBS groups and predecessors", () => {
    const u = parseUpload("program.csv", CSV);
    expect(u.sourceType).toBe("csv");
    expect(u.table!.headers).toEqual(["Kod", "Ad", "WBS", "Başlangıç", "Bitiş", "% Tamamlanma", "Öncül", "Kritik"]);
    expect(u.mapping).toMatchObject({ code: 0, name: 1, wbs: 2, start: 3, finish: 4, percent: 5, predecessors: 6, critical: 7 });
    const by = new Map(u.parsed.activities.map((a) => [a.code, a]));
    expect(by.get("A30")!).toMatchObject({ name: "Temel; radye", start: "2026-01-26", finish: "2026-02-13", critical: true });
    expect(by.get("A10")!.percentComplete).toBe(100);
    expect(by.get("WBS-Kaba / Temel")!.parentKey).toBe("WBS:Kaba");
    expect(u.parsed.dependencies.map((d) => `${d.type}:${d.lagDays}`)).toEqual(["FS:0", "FS:2", "FF:0"]);
    expect(suggestMapping(["Activity ID", "Activity Name", "Start", "Finish", "Activity % Complete", "Predecessors"])).toMatchObject({
      code: 0,
      name: 1,
      start: 2,
      finish: 3,
      percent: 4,
      predecessors: 5,
    });
  });

  it("reads .xlsx without a dependency (shared strings, rich text, date styles)", async () => {
    const buf = await makeXlsx();
    const sheet = readXlsx(buf);
    expect(sheet.rows[1]).toEqual(["X1", "Kalıp & donatı", "2026-01-05", "2026-01-09", "0.25"]);
    const u = parseUpload("program.xlsx", buf);
    expect(u.sourceType).toBe("xlsx");
    const x2 = u.parsed.activities.find((a) => a.code === "X2")!;
    expect(x2).toMatchObject({ start: "2026-01-12", finish: "2026-01-16" });
    expect(u.parsed.activities.find((a) => a.code === "X1")!.percentComplete).toBe(25);
    expect(u.parsed.dependencies).toHaveLength(1);
  });

  it("derives activity status at a date", () => {
    const a = { start: "2026-03-09", finish: "2026-03-27", baselineStart: "2026-03-02", baselineFinish: "2026-03-20", actualStart: null, actualFinish: null, percentComplete: 0 };
    expect(activityStatusAt(a, "2026-03-01", "2026-03-10")).toBe("not_started");
    expect(activityStatusAt(a, "2026-03-10", "2026-03-10")).toBe("late"); // baseline start passed
    expect(activityStatusAt(a, "2026-03-12", "2026-03-10")).toBe("in_progress"); // future: plan
    expect(activityStatusAt(a, "2026-03-25", "2026-03-10")).toBe("late"); // past baseline finish
    expect(activityStatusAt(a, "2026-03-28", "2026-03-10")).toBe("complete");
    expect(isActivityLate({ ...a, baselineStart: null, baselineFinish: null }, "2026-03-05")).toBe(false);
  });
});

describe("İş programı API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-sched-"));
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

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    expect(res.statusCode, res.body).toBe(200);
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  function client(cookie: string) {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    };
    return {
      get: (u: string) => call("GET", u),
      post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
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
          headers: { cookie, "content-type": req.headers.get("content-type")! },
          payload: Buffer.from(await req.arrayBuffer()),
        });
        return { status: res.statusCode, body: res.json() };
      },
    };
  }

  let admin: ReturnType<typeof client>;
  let member: ReturnType<typeof client>;
  let outsider: ReturnType<typeof client>;
  let pid: string;
  let wipId: string;
  let v1: string;
  let v2: string;
  let seriesId: string;

  it("sets up a project with a member and an outsider", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    await admin.post("/users", { email: "dis@7d.test", name: "Dış", password: PW });
    const p = await admin.post("/projects", { code: "ZAVM", name: "Zirve Veri Merkezi" });
    pid = p.body.id;
    const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    wipId = contents.body.folders[0].id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = client(await login("uye@7d.test"));
    outsider = client(await login("dis@7d.test"));
  });

  it("lets only planners import; non-members do not see schedules", async () => {
    expect((await outsider.get(`/projects/${pid}/schedules`)).status).toBe(404);
    expect((await member.get(`/projects/${pid}/schedules`)).body).toEqual([]);
    expect((await member.upload(`/projects/${pid}/schedules`, "zavm.xml", V1)).status).toBe(403);
    const bad = await admin.upload(`/projects/${pid}/schedules`, "bos.csv", Buffer.from("Kod;Ad\r\n"));
    expect(bad.status).toBe(400);
  });

  it("previews CSV column mapping without storing", async () => {
    const r = await admin.upload(`/projects/${pid}/schedules/preview`, "program.csv", CSV);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.table.mapping).toMatchObject({ code: 0, name: 1, start: 3 });
    expect(r.body.activityCount).toBe(4);
    expect(r.body.sample[0].code).toBe("WBS-Hazırlık");
    expect((await admin.get(`/projects/${pid}/schedules`)).body).toEqual([]);
  });

  it("imports versions of one programme and keeps the first as baseline", async () => {
    const r1 = await admin.upload(`/projects/${pid}/schedules`, "zavm-v1.xml", V1);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ name: "ZAVM Ana Program", version: 1, isBaseline: true, sourceType: "mspdi", dataDate: "2026-03-02", activityCount: 5 });
    v1 = r1.body.id;
    seriesId = r1.body.seriesId;
    const r2 = await admin.upload(`/projects/${pid}/schedules`, "zavm-v2.xml", V2, { seriesId: v1 });
    expect(r2.body).toMatchObject({ version: 2, isBaseline: false, seriesId, dataDate: "2026-03-16", finishDate: "2026-05-08" });
    v2 = r2.body.id;
    const list = (await member.get(`/projects/${pid}/schedules`)).body;
    expect(list.map((s: { version: number }) => s.version)).toEqual([2, 1]);
  });

  it("returns activities with the baseline from the baseline version and filters", async () => {
    const acts = (await member.get(`/projects/${pid}/schedules/${v2}/activities`)).body;
    const by = new Map(acts.map((a: { code: string }) => [a.code, a]));
    expect(by.get("4")).toMatchObject({ start: "2026-03-16", finish: "2026-04-03", baselineStart: "2026-03-09", baselineFinish: "2026-03-27", finishVarianceDays: 7 });
    expect(by.get("8")).toMatchObject({ baselineFinish: null, finishVarianceDays: null });
    expect(by.get("3")).toMatchObject({ parentId: (by.get("1") as { id: string }).id, outlineLevel: 2 });

    const critical = (await member.get(`/projects/${pid}/schedules/${v2}/activities?critical=1&summaries=0`)).body;
    expect(critical.map((a: { code: string }) => a.code)).toEqual(["2", "3", "4", "6", "7"]);
    // Data date 16.03: Temel betonu (baseline finish 06.03) and Kolonlar (behind baseline) are late.
    const late = (await member.get(`/projects/${pid}/schedules/${v2}/activities?late=1`)).body;
    expect(late.map((a: { code: string }) => a.code)).toEqual(["3", "4", "6", "7"]);
    const wbs = (await member.get(`/projects/${pid}/schedules/${v2}/activities?wbs=2`)).body;
    expect(wbs.map((a: { code: string }) => a.code)).toEqual(["5", "6", "8"]);
    const window = (await member.get(`/projects/${pid}/schedules/${v2}/activities?from=2026-04-20&to=2026-04-30&summaries=0`)).body;
    expect(window.map((a: { code: string }) => a.code)).toEqual(["6", "8"]);
    expect((await member.get(`/projects/${pid}/schedules/${v2}/dependencies`)).body).toHaveLength(4);
  });

  it("compares versions: slips, critical changes, added activities", async () => {
    const c = (await member.get(`/projects/${pid}/schedules/compare?from=${v1}&to=${v2}`)).body;
    expect(c.finishSlipDays).toBe(21);
    expect(c.slipped.map((s: { code: string; finishSlipDays: number }) => `${s.code}:${s.finishSlipDays}`)).toEqual(["4:7", "6:7", "7:7", "3:7"]);
    expect(c.becameCritical.map((s: { code: string }) => s.code)).toEqual(["6"]);
    expect(c.added).toEqual([{ code: "8", name: "Çatı" }]);
    expect(c.removed).toEqual([]);
  });

  it("lists the 3-week lookahead and builds an S-curve", async () => {
    const la = (await member.get(`/projects/${pid}/schedules/${v2}/lookahead`)).body;
    expect(la).toMatchObject({ from: "2026-03-16", to: "2026-04-05", weeks: 3 });
    expect(la.activities.map((a: { code: string }) => a.code)).toEqual(["3", "4", "7"]);
    const la2 = (await member.get(`/projects/${pid}/schedules/${v2}/lookahead?weeks=6&from=2026-04-01`)).body;
    expect(la2.activities.map((a: { code: string }) => a.code)).toEqual(["3", "4", "7", "6", "8"]);

    const s = (await member.get(`/projects/${pid}/schedules/${v2}/scurve?step=week`)).body;
    expect(s.dataDate).toBe("2026-03-16");
    const pts = s.points as { date: string; planned: number; forecast: number; actual: number | null }[];
    expect(pts[0]!.date).toBe("2026-02-02");
    expect(pts.at(-1)!.forecast).toBe(100);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.planned).toBeGreaterThanOrEqual(pts[i - 1]!.planned);
    const atRef = pts.find((p) => p.date === "2026-03-16")!;
    expect(atRef.actual).toBeGreaterThan(0);
    expect(atRef.actual!).toBeLessThan(atRef.planned);
    expect(pts.filter((p) => p.date > "2026-03-16").every((p) => p.actual === null)).toBe(true);
    expect((await member.get(`/projects/${pid}/schedules/${v2}/scurve?step=year`)).status).toBe(400);
  });

  it("links activities to files, issues and IFC elements; only planners edit links", async () => {
    const up = await admin.upload(`/projects/${pid}/folders/${wipId}/files`, "kolon.pdf", Buffer.from("%PDF-1.4 test"));
    const fileId = up.body.results[0].fileId;
    const ifc = await admin.upload(`/projects/${pid}/folders/${wipId}/files`, "model.ifc", IFC);
    const ifcFile = (await admin.get(`/projects/${pid}/files/${ifc.body.results[0].fileId}`)).body;
    const versionId = ifcFile.versions[0].id;
    const issue = (await admin.post(`/projects/${pid}/issues`, { title: "Kolon donatısı eksik" })).body;

    const acts = (await admin.get(`/projects/${pid}/schedules/${v2}/activities`)).body;
    const kolon = acts.find((a: { code: string }) => a.code === "4");
    const base = `/projects/${pid}/schedules/${v2}/activities/${kolon.id}/links`;

    expect((await member.post(base, { kind: "file", targetId: fileId })).status).toBe(403);
    expect((await admin.post(base, { kind: "file", targetId: fileId })).status).toBe(200);
    expect((await admin.post(base, { kind: "file", targetId: fileId })).status).toBe(400);
    expect((await admin.post(base, { kind: "issue", targetId: issue.id })).body.target.label).toBe(`#${issue.number} Kolon donatısı eksik`);
    expect((await admin.post(base, { kind: "ifc_element", targetId: versionId })).status).toBe(400);
    expect((await admin.post(base, { kind: "file", targetId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    await admin.post(base, { kind: "ifc_element", targetId: versionId, globalIds: ["2O2Fr$t4X7Zf8NOew3FLOH"] });
    const merged = await admin.post(base, { kind: "ifc_element", targetId: versionId, globalIds: ["2O2Fr$t4X7Zf8NOew3FLOH", "1hOSvn6df7F8_7GcBWlRGQ"] });
    expect(merged.body.globalIds).toHaveLength(2);
    expect((await admin.post(base, { kind: "work", targetId: "RFI-0007" })).status).toBe(200);

    const links = (await member.get(base)).body;
    expect(links.map((l: { kind: string }) => l.kind)).toEqual(["file", "issue", "ifc_element", "work"]);
    // The member has no permission on the WIP folder: the file link is listed without its target.
    expect(links[0].target).toBeNull();
    expect((await admin.get(base)).body[0].target).toMatchObject({ label: "kolon.pdf", fileId });
    // Links are per programme and activity code: the baseline version sees them too.
    const kolonV1 = (await member.get(`/projects/${pid}/schedules/${v1}/activities`)).body.find((a: { code: string }) => a.code === "4");
    expect(kolonV1.linkCount).toBe(4);
    const detail = (await member.get(`/projects/${pid}/schedules/${v1}/activities/${kolonV1.id}`)).body;
    expect(detail.links).toHaveLength(4);
    expect(detail.predecessors).toMatchObject([{ code: "3", type: "FS", lagDays: 1 }]);
    expect(detail.successors.map((s: { code: string }) => s.code)).toEqual(["6", "7"]);

    const els = (await member.get(`/projects/${pid}/schedules/${v2}/elements`)).body;
    expect(els.elements).toEqual([
      expect.objectContaining({ activityCode: "4", fileVersionId: versionId, globalIds: ["2O2Fr$t4X7Zf8NOew3FLOH", "1hOSvn6df7F8_7GcBWlRGQ"], finish: "2026-04-03", baselineFinish: "2026-03-27" }),
    ]);
    const reverse = (await member.get(`/projects/${pid}/schedule-links?kind=issue&targetId=${issue.id}`)).body;
    expect(reverse).toMatchObject([{ activityCode: "4", version: 2, activity: { name: "Kolonlar" } }]);

    expect((await member.del(`/projects/${pid}/schedule-links/${links[3].id}`)).status).toBe(403);
    expect((await admin.del(`/projects/${pid}/schedule-links/${links[3].id}`)).status).toBe(200);
    expect((await member.get(base)).body).toHaveLength(3);
    expect((await outsider.get(base)).status).toBe(404);
  });

  it("summarises slips without AI when no provider is configured", async () => {
    const r = await member.post(`/projects/${pid}/schedules/${v2}/summary`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary).toBeNull();
    expect(r.body.aiNote).toMatch(hasAi ? /sağlayıcı/ : /kapatıldı/); // without the AI module AI is off
    expect(r.body.facts).toMatchObject({ version: 2, counts: { activities: 6, late: 4 }, comparedTo: { version: 1, finishSlipDays: 21, slipped: 4 } });
    expect(r.body.bullets.join("\n")).toContain("v1'e göre 4 faaliyet ötelendi");
    expect(r.body.bullets.join("\n")).toContain("Kritik yola giren: 6 Duvarlar");
    const noAi = await member.post(`/projects/${pid}/schedules/${v1}/summary`, { ai: false });
    expect(noAi.body.facts.comparedTo).toBeNull();
  });

  it("imports XER and mapped CSV, changes the baseline and deletes versions", async () => {
    const x = await admin.upload(`/projects/${pid}/schedules`, "mbe.xer", XER);
    expect(x.body).toMatchObject({ name: "MBE-PRG", sourceType: "xer", activityCount: 3, isBaseline: true });
    // Explicit mapping: no code column → row numbers become codes.
    const c = await admin.upload(`/projects/${pid}/schedules`, "program.csv", CSV, {
      name: "Hazırlık programı",
      mapping: JSON.stringify({ name: 1, start: 3, finish: 4, percent: 5 }),
      dataDate: "2026-01-20",
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ name: "Hazırlık programı", sourceType: "csv", dataDate: "2026-01-20", activityCount: 4 });
    const acts = (await admin.get(`/projects/${pid}/schedules/${c.body.id}/activities`)).body;
    expect(acts.map((a: { code: string }) => a.code)).toEqual(["1", "2", "3", "4"]);

    expect((await member.patch(`/projects/${pid}/schedules/${v2}`, { isBaseline: true })).status).toBe(403);
    expect((await admin.patch(`/projects/${pid}/schedules/${v2}`, { isBaseline: true })).body.isBaseline).toBe(true);
    const a1 = (await admin.get(`/projects/${pid}/schedules/${v1}/activities`)).body.find((a: { code: string }) => a.code === "4");
    expect(a1.baselineFinish).toBe("2026-04-03");
    expect((await admin.get(`/projects/${pid}/schedules/${v1}`)).body.isBaseline).toBe(false);

    expect((await member.del(`/projects/${pid}/schedules/${v1}`)).status).toBe(403);
    expect((await admin.del(`/projects/${pid}/schedules/${v1}`)).status).toBe(200);
    expect((await admin.get(`/projects/${pid}/schedules/${v1}`)).status).toBe(404);
    // Links stay while another version of the programme exists.
    expect((await admin.get(`/projects/${pid}/schedule-links?kind=work&targetId=x`)).body).toEqual([]);
    const kolon = (await admin.get(`/projects/${pid}/schedules/${v2}/activities`)).body.find((a: { code: string }) => a.code === "4");
    expect(kolon.linkCount).toBe(3);
    expect((await admin.del(`/projects/${pid}/schedules/${v2}`)).status).toBe(200);
    const left = (await admin.get(`/projects/${pid}/schedules`)).body;
    expect(left.map((s: { name: string }) => s.name).sort()).toEqual(["Hazırlık programı", "MBE-PRG"]);
  });
});
