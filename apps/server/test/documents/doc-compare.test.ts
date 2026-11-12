import { hasAi } from "../helpers/modules.js"; // AI steps run when the AI module is installed
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ZipFile } from "yazl";
import {
  MASK_ADDED,
  MASK_REMOVED,
  clusterRegions,
  diffMask,
  diffSequence,
  normaliseRegions,
  wordDiff,
  type AntetResult,
  type DocCompareResult,
} from "@sitekeep/shared";
import { cdeToolDefinitions } from "@sitekeep/cde-tools";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { buildPrompt, linkBullets, parseBullets } from "../../src/doccompare/ai.js";
import { docxUnits, readCsv, readWorkbook } from "../../src/doccompare/office.js";
import { antetChanges, compareFlags, deterministicSummary, diffSheet, diffUnits, groupByPage, type TextUnit } from "../../src/doccompare/text-diff.js";
import { writeXlsx } from "../../src/core/formats/xlsx.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Put = (text: string, x: number, y: number, size?: number) => void;

async function pdf(pages: ((put: Put) => void)[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const draw of pages) {
    const page = doc.addPage([1190, 842]);
    draw((text, x, y, size = 8) => page.drawText(text, { x, y, size, font }));
  }
  return Buffer.from(await doc.save());
}

/** A3 drawing: plan notes on the left, revision table + title block bottom right; optional second page. */
function drawing(o: { rev: string; column: string; note4?: boolean; rows: [string, string, string][]; date?: string; page2?: string }) {
  const sheet = (put: Put) => {
    put("ZEMIN KAT PLANI", 80, 780, 18);
    put("NOTLAR: Tum olculer cm cinsindendir.", 80, 140, 8);
    put(`KOLON S12 ${o.column}`, 300, 500, 10);
    put("KIRIS K101 30x60", 300, 460, 10);
    if (o.note4) put("NOT 4: Doseme kotu +0.15 olarak guncellendi.", 80, 120, 8);
    o.rows.forEach((r, i) => {
      const y = 262 + 12 * (i + 1);
      put(r[0], 862, y, 7);
      put(r[1], 900, y, 7);
      put(r[2], 970, y, 7);
    });
    put("REV", 862, 262, 6);
    put("TARIH", 900, 262, 6);
    put("ACIKLAMA", 970, 262, 6);
    put("PROJE", 860, 230, 6);
    put("ZIRVE ANKARA VERI MERKEZI", 860, 218, 9);
    put("PAFTA ADI", 860, 196, 6);
    put("ZEMIN KAT PLANI", 860, 184, 10);
    put("Cizim No: A-102", 860, 140, 7);
    put("OLCEK", 860, 100, 6);
    put("1/50", 905, 100, 9);
    put("REV", 1000, 100, 6);
    put(o.rev, 1000, 88, 10);
    put("TARIH", 1060, 100, 6);
    put(o.date ?? "15.03.2026", 1060, 88, 9);
    put("CIZEN", 860, 60, 6);
    put("A. YILMAZ", 860, 50, 8);
  };
  const pages = [sheet];
  if (o.page2) pages.push((put) => put(o.page2!, 100, 700, 12));
  return pdf(pages);
}

async function docx(paragraphs: string[]): Promise<Buffer> {
  const zip = new ZipFile();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    "word/document.xml",
  );
  zip.addBuffer(Buffer.from("<Types/>"), "[Content_Types].xml");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const u = (text: string, page = 1, y = 0.1): TextUnit => ({ text, page, box: { x0: 0.1, y0: y, x1: 0.3, y1: y + 0.02 } });

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("text diff", () => {
  it("diffs sequences and words", () => {
    const ops = diffSequence(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(ops.map((o) => o.op)).toEqual([0, -1, 1, 0, 0, 1]);
    expect(wordDiff("KOLON S12 40x60", "KOLON S12 50x60")).toEqual([
      [0, "KOLON S12 "],
      [-1, "40x60"],
      [1, "50x60"],
    ]);
    // Large inputs are split at unique lines instead of a full table.
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const changed = [...big.slice(0, 2500), "new line", ...big.slice(2501)];
    const d = diffSequence(big, changed);
    expect(d.filter((o) => o.op !== 0)).toHaveLength(2);
  });

  it("groups changes per page and pairs similar lines into changed lines", () => {
    const a = [u("ZEMIN KAT PLANI"), u("KOLON S12 40x60", 1, 0.4), u("KIRIS K101 30x60", 1, 0.5), u("Kesit A-A", 2), u("Not 1", 2, 0.6)];
    const b = [u("ZEMIN KAT PLANI"), u("KOLON S12 50x60", 1, 0.4), u("KIRIS K101 30x60", 1, 0.5), u("Kesit A-A", 2), u("NOT 4: kot +0.15", 2, 0.7)];
    const pages = groupByPage(diffUnits(a, b));
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0]).toMatchObject({ page: 1, changed: 1, added: 0, removed: 0 });
    expect(pages[0]!.changes[0]).toMatchObject({ kind: "changed", old: "KOLON S12 40x60", new: "KOLON S12 50x60", pageA: 1, pageB: 1 });
    expect(pages[1]).toMatchObject({ page: 2, added: 1, removed: 1, changed: 0 });
    // Reflowed text (moved to the next page) is not a change.
    const moved = groupByPage(diffUnits([u("x"), u("y"), u("z")], [u("x"), u("y", 2), u("z", 2)]));
    expect(moved).toEqual([]);
  });

  it("detects title-block changes and revision problems", () => {
    const antet = (rev: string, date: string, rows: string[]): AntetResult => ({
      page: 1,
      pageCount: 1,
      pageSize: { width: 1000, height: 800 },
      region: { x0: 800, y0: 600, x1: 1000, y1: 800 },
      fields: [
        { key: "revision", label: "REV", value: rev, confidence: 0.9, source: "below", page: 1 },
        { key: "date", label: "TARIH", value: date, confidence: 0.9, source: "below", page: 1 },
        { key: "drawingNo", label: "Çizim No", value: "A-102", confidence: 0.9, source: "inline", page: 1 },
      ],
      pairs: [{ label: "Alan", value: "Z1", key: null }],
      revisionTable: rows.map((r) => ({ rev: r, date: null, description: null })),
      codes: [],
      hasText: true,
      kind: "drawing",
    });
    const ch = antetChanges(antet("B", "01.02.2026", ["A", "B"]), antet("C", "15.03.2026", ["A", "B", "C"]));
    expect(ch).toEqual([
      { key: "revision", label: "Revizyon", old: "B", new: "C" },
      { key: "date", label: "Tarih", old: "01.02.2026", new: "15.03.2026" },
      { key: null, label: "Revizyon Tablosu (son satır)", old: "B", new: "C" },
    ]);
    const base: DocCompareResult = {
      kind: "pdf",
      hasText: true,
      identical: false,
      pageCountA: 1,
      pageCountB: 1,
      pages: [],
      totals: { added: 0, removed: 0, changed: 0, pages: 0 },
      antet: [],
      revisionA: "B",
      revisionB: "B",
      revisionTableA: "B",
      revisionTableB: "B",
      antetRegion: { x0: 0.8, y0: 0.75, x1: 1, y1: 1 },
      contentChanged: true,
    };
    expect(compareFlags(base, null).map((f) => f.code)).toEqual(["revision_not_updated"]);
    // Revision went up, table not updated, nothing outside the title block changed.
    const up = { ...base, revisionB: "C", contentChanged: false };
    expect(compareFlags(up, []).map((f) => f.code)).toEqual(["revision_without_change", "revision_table_not_updated"]);
    // A visual region outside the title block counts as a content change.
    const regions = [{ page: 1, regions: [{ box: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, kind: "changed" as const, pixels: 50 }] }];
    expect(compareFlags({ ...up, revisionTableB: "C" }, regions)).toEqual([]);
    expect(compareFlags({ ...base, revisionA: "C", revisionB: "B" }, null).map((f) => f.code)).toContain("revision_backwards");
    const summary = deterministicSummary({ ...base, antet: ch }, null, compareFlags(base, null));
    expect(summary[0]).toMatchObject({ severity: "warn" });
    expect(summary.some((b) => b.text.startsWith("Antet: Revizyon B → C"))).toBe(true);
  });

  it("parses model bullets and links them to pages and regions", () => {
    const bullets = parseBullets(
      "<think>x</think>\n- [s.1] Kolon S12 boyutu \"KOLON S12 50x60\" oldu (40x60 → 50x60).\n* [!] Revizyon tablosu güncellenmemiş.\n- [s.9] Uydurma sayfa\n\nÖzet:",
      2,
    );
    expect(bullets).toEqual([
      { text: 'Kolon S12 boyutu "KOLON S12 50x60" oldu (40x60 → 50x60).', page: 1 },
      { text: "Revizyon tablosu güncellenmemiş.", severity: "warn" },
      { text: "Uydurma sayfa" },
    ]);
    const result = {
      pages: [{ page: 1, added: 0, removed: 0, changed: 1, changes: [{ kind: "changed", old: "KOLON S12 40x60", new: "KOLON S12 50x60", pageB: 1, boxB: { x0: 0.3, y0: 0.3, x1: 0.4, y1: 0.32 } }] }],
    } as unknown as DocCompareResult;
    const regions = [{ page: 1, regions: [{ box: { x0: 0.6, y0: 0.6, x1: 0.7, y1: 0.7 }, kind: "added" as const, pixels: 9 }, { box: { x0: 0.29, y0: 0.29, x1: 0.42, y1: 0.33 }, kind: "changed" as const, pixels: 40 }] }];
    expect(linkBullets(bullets, result, regions)[0]).toMatchObject({ page: 1, region: 1 });
  });

  it("reads and diffs spreadsheets, CSV and DOCX", async () => {
    const book = (qty: string) =>
      writeXlsx([
        { name: "Metraj", columns: [{ title: "Poz" }, { title: "Miktar" }], rows: [["15.150", "120"], ["15.160", qty], ["15.170", "8"]] },
        { name: "Notlar", columns: [{ title: "Not" }], rows: [["sabit"]] },
      ]);
    const a = readWorkbook(await book("40"));
    const b = readWorkbook(await book("45"));
    expect(a.map((s) => s.name)).toEqual(["Metraj", "Notlar"]);
    const d = diffSheet("Metraj", a[0]!.rows, b[0]!.rows);
    expect(d).toMatchObject({ status: "changed", changed: 1, added: 0, removed: 0 });
    expect(d.rows[0]).toEqual({ kind: "changed", rowA: 3, rowB: 3, cells: [{ col: "B", old: "40", new: "45" }] });
    expect(readCsv('Poz;Açıklama\n1;"Beton; C30"\n')).toEqual([["Poz", "Açıklama"], ["1", "Beton; C30"]]);
    const units = docxUnits(await docx(["Madde 1: Beton C30", "Madde 2: Donatı B500C"]));
    expect(units.map((x) => x.text)).toEqual(["Madde 1: Beton C30", "Madde 2: Donatı B500C"]);
  });
});

describe("change regions", () => {
  it("ignores one-pixel shifts and finds real changes", () => {
    const w = 40;
    const h = 20;
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    // A line drawn one pixel lower in B: no change.
    for (let x = 2; x < 30; x++) {
      a[5 * w + x] = 1;
      b[6 * w + x] = 1;
    }
    // A blob only in B.
    for (let y = 12; y < 16; y++) for (let x = 30; x < 36; x++) b[y * w + x] = 1;
    const mask = diffMask(a, b, w, h, 1);
    expect(mask.slice(5 * w, 6 * w).every((v) => v === 0)).toBe(true);
    expect(mask[13 * w + 32]).toBe(MASK_ADDED);
  });

  it("clusters changed pixels into regions (pure)", () => {
    const w = 200;
    const h = 100;
    const mask = new Uint8Array(w * h);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = v;
    };
    fill(10, 10, 20, 20, MASK_REMOVED); // removed blob
    fill(24, 12, 30, 18, MASK_ADDED); // added blob next to it → one "changed" region
    fill(150, 70, 170, 90, MASK_ADDED); // far away → own "added" region
    mask[50 * w + 100] = MASK_ADDED; // noise
    const regions = clusterRegions(mask, w, h, { cell: 4, gap: 2 });
    expect(regions).toHaveLength(2);
    const [big, other] = regions;
    expect(big).toMatchObject({ kind: "added", x0: 148, y0: 68, x1: 172, y1: 92 });
    expect(other).toMatchObject({ kind: "changed", x0: 8, y0: 8 });
    expect(other!.x1).toBeGreaterThanOrEqual(30);
    const n = normaliseRegions(regions, w, h);
    expect(n[0]!.box).toEqual({ x0: 0.74, y0: 0.68, x1: 0.86, y1: 0.92 });
    expect(clusterRegions(new Uint8Array(w * h), w, h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let stub: Server;
let stubUrl: string;
const stubBodies: { messages: { role: string; content: string }[] }[] = [];
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-doccmp-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 5) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      stubBodies.push(body);
      const answer =
        '- [s.1] Kolon S12 boyutu büyütülmüş: "KOLON S12 50x60" (40x60 → 50x60); statik kontrol gerekir.\n' +
        "- [s.1] Not 4 eklendi: döşeme kotu +0.15.\n" +
        "- [!] Revizyon C'ye çıkmış ve tablo güncellenmiş.";
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
  const upload = async (url: string, name: string, data: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const req = new Request("http://x", { method: "POST", body: form });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: { cookie, "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().results[0] as { fileId: string };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    upload,
    cookie,
  };
}

describe("document comparison API", () => {
  let admin: ReturnType<typeof api>;
  let pid: string;
  let folderId: string;
  let v1: string;
  let v2: string;
  let cid: string;
  const P = () => `/projects/${pid}`;

  it("compares two PDF revisions: text per page, title block, checks", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "DC", name: "Doc compare", template: "empty" });
    pid = p.body.id;
    folderId = (await admin.post(`${P()}/folders`, { parentId: p.body.rootFolderId, name: "Paftalar" })).body.id;
    const rowsB: [string, string, string][] = [["A", "01.01.2026", "ILK YAYIN"], ["B", "01.02.2026", "YORUMLAR"]];
    const { fileId } = await admin.upload(`${P()}/folders/${folderId}/files`, "A-102.pdf", await drawing({ rev: "B", column: "40x60", rows: rowsB, date: "01.02.2026" }));
    await admin.upload(
      `${P()}/folders/${folderId}/files`,
      "A-102.pdf",
      await drawing({ rev: "C", column: "50x60", note4: true, rows: [...rowsB, ["C", "15.03.2026", "KOLON BOYUTU"]], page2: "DETAY 1" }),
    );
    const file = (await admin.get(`${P()}/files/${fileId}`)).body;
    v1 = file.versions.find((v: any) => v.version === 1).id;
    v2 = file.versions.find((v: any) => v.version === 2).id;

    expect((await admin.get(`${P()}/doc-compare?from=${v1}&to=${v1}`)).status).toBe(400);
    const r = await admin.get(`${P()}/doc-compare?from=${v1}&to=${v2}&wait=30000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    cid = r.body.id;
    expect(r.body.status).toBe("done");
    const res = r.body.result;
    expect(res).toMatchObject({ kind: "pdf", hasText: true, identical: false, pageCountA: 1, pageCountB: 2, revisionA: "B", revisionB: "C" });
    const page1 = res.pages.find((x: any) => x.page === 1);
    expect(page1.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "changed", old: "KOLON S12 40x60", new: "KOLON S12 50x60" }),
        expect.objectContaining({ kind: "added", new: "NOT 4: Doseme kotu +0.15 olarak guncellendi." }),
      ]),
    );
    expect(page1.changes.find((c: any) => c.new === "C")?.antet).toBe(true);
    expect(res.pages.find((x: any) => x.page === 2)).toMatchObject({ added: 1 });
    expect(res.antet).toEqual(
      expect.arrayContaining([
        { key: "revision", label: "Revizyon", old: "B", new: "C" },
        { key: "date", label: "Tarih", old: "2026-02-01", new: "2026-03-15" },
        { key: null, label: "Revizyon Tablosu (son satır)", old: "B · 2026-02-01 · YORUMLAR", new: "C · 2026-03-15 · KOLON BOYUTU" },
      ]),
    );
    expect(r.body.flags.map((f: any) => f.code)).toEqual(["page_count_changed"]);
    expect(r.body.ai).toMatchObject({ available: false, status: "none" });
    expect(r.body.ai.note).toBeTruthy();
    expect(r.body.summary.some((b: any) => b.text.includes("Revizyon B → C"))).toBe(true);
    // Cached: the same pair gives the same comparison.
    expect((await admin.get(`${P()}/doc-compare?from=${v1}&to=${v2}`)).body.id).toBe(cid);
    // Without a model the summary cannot start; the deterministic one stays.
    const off = await admin.post(`${P()}/doc-compare/${cid}/summary`);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe("ai_unavailable");
  });

  it("stores change regions from the browser", async () => {
    const bad = await admin.put(`${P()}/doc-compare/${cid}/regions`, { pages: [{ page: 1, regions: [{ box: { x0: 0, y0: 0, x1: 2, y1: 1 }, kind: "added", pixels: 1 }] }] });
    expect(bad.status).toBe(400);
    const ok = await admin.put(`${P()}/doc-compare/${cid}/regions`, {
      pages: [
        { page: 1, regions: [{ box: { x0: 0.25, y0: 0.35, x1: 0.35, y1: 0.42 }, kind: "changed", pixels: 120 }] },
        { page: 2, only: "B", regions: [] },
        { page: 3, regions: [] },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.regions.map((x: any) => x.page)).toEqual([1, 2]);
  });

  it.skipIf(!hasAi)("writes the AI summary with a (fake) local model, sending only the differences", async () => {
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    const start = await admin.post(`${P()}/doc-compare/${cid}/summary`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.ai.available).toBe(true);
    expect(["running", "done"]).toContain(start.body.ai.status);
    const done = await admin.get(`${P()}/doc-compare/${cid}?wait=20000`);
    expect(done.body.ai).toMatchObject({ status: "done", model: "qwen3:8b" });
    expect(done.body.ai.bullets[0]).toMatchObject({ page: 1, region: 0 });
    expect(done.body.ai.bullets[2]).toMatchObject({ severity: "warn" });
    expect(stubBodies).toHaveLength(1);
    const sent = stubBodies[0]!.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("KOLON S12 50x60");
    expect(sent).toContain("1 görsel değişiklik bölgesi");
    // Unchanged text never leaves the server.
    expect(sent).not.toContain("KIRIS K101");
    expect(sent).not.toContain("ZIRVE ANKARA");
    // Cached per version pair.
    await admin.post(`${P()}/doc-compare/${cid}/summary`);
    expect(stubBodies).toHaveLength(1);
    await admin.post(`${P()}/doc-compare/${cid}/summary`, { force: true });
    await admin.get(`${P()}/doc-compare/${cid}?wait=20000`);
    expect(stubBodies).toHaveLength(2);

    // AI switched off: the cached bullets stay, nothing new can start.
    await admin.put("/admin/settings/ai", { mode: "off" });
    const off = await admin.get(`${P()}/doc-compare/${cid}`);
    expect(off.body.ai).toMatchObject({ available: false, status: "done" });
    expect((await admin.post(`${P()}/doc-compare/${cid}/summary`, { force: true })).status).toBe(409);
    await admin.put("/admin/settings/ai", { mode: "local_only" });
  });

  it("exports a PDF report and adds the summary to a running review", async () => {
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const rep = await admin.post(`${P()}/doc-compare/${cid}/report`, { thumbnails: [{ page: 1, image: pixel }] });
    expect(rep.status, rep.raw.body.slice(0, 200)).toBe(200);
    expect(rep.raw.headers["content-type"]).toBe("application/pdf");
    expect(rep.raw.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(String(rep.raw.headers["content-disposition"])).toContain("A-102_V1-V2_karsilastirma.pdf");

    expect((await admin.post(`${P()}/doc-compare/${cid}/review-note`, { reviewId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    const tpl = await admin.post(`${P()}/workflow-templates`, {
      kind: "review",
      name: "Hızlı",
      steps: [{ name: "Yönetici", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 0, outcomes: ["approved"] }],
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const review = await admin.post(`${P()}/reviews`, { name: "Pafta onayı", templateId: tpl.body.id, versionIds: [v2], targetFolderId: folderId });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const dto = await admin.get(`${P()}/doc-compare/${cid}`);
    expect(dto.body.activeReviews).toEqual([expect.objectContaining({ reviewId: review.body.id, number: review.body.number })]);
    const note = await admin.post(`${P()}/doc-compare/${cid}/review-note`, { reviewId: review.body.id });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const detail = await admin.get(`${P()}/reviews/${review.body.id}`);
    const action = detail.body.actions.find((x: any) => x.kind === "note");
    expect(action.comment).toContain("Revizyon karşılaştırması: A-102.pdf V1 → V2");
    expect(action.comment).toContain("KOLON S12 50x60");
  });

  it("compares spreadsheets and Word documents, refuses mixed or unsupported types", async () => {
    const book = (qty: string) => writeXlsx([{ name: "Metraj", columns: [{ title: "Poz" }, { title: "Miktar" }], rows: [["15.150", "120"], ["15.160", qty]] }]);
    const x = await admin.upload(`${P()}/folders/${folderId}/files`, "metraj.xlsx", await book("40"));
    await admin.upload(`${P()}/folders/${folderId}/files`, "metraj.xlsx", await book("45"));
    const xf = (await admin.get(`${P()}/files/${x.fileId}`)).body;
    const [xa, xb] = [1, 2].map((n) => xf.versions.find((v: any) => v.version === n).id);
    const xr = await admin.get(`${P()}/doc-compare?from=${xa}&to=${xb}&wait=20000`);
    expect(xr.body.result.kind).toBe("xlsx");
    expect(xr.body.result.sheets[0]).toMatchObject({ name: "Metraj", status: "changed", changed: 1 });
    expect(xr.body.summary[0].text).toContain('"Metraj": 1 değişen satır');

    const d = await admin.upload(`${P()}/folders/${folderId}/files`, "sartname.docx", await docx(["Madde 1: Beton C30", "Madde 2: Donatı"]));
    await admin.upload(`${P()}/folders/${folderId}/files`, "sartname.docx", await docx(["Madde 1: Beton C35", "Madde 2: Donatı", "Madde 3: Kalıp"]));
    const df = (await admin.get(`${P()}/files/${d.fileId}`)).body;
    const [da, db] = [1, 2].map((n) => df.versions.find((v: any) => v.version === n).id);
    const dr = await admin.get(`${P()}/doc-compare?from=${da}&to=${db}&wait=20000`);
    expect(dr.body.result.kind).toBe("docx");
    expect(dr.body.result.totals).toMatchObject({ changed: 1, added: 1, removed: 0 });

    const mixed = await admin.get(`${P()}/doc-compare?from=${v1}&to=${db}`);
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toContain("aynı türde");
  });

  it.skipIf(!hasAi)("keeps comparisons private and serves the MCP / Sor tool", async () => {
    await admin.post("/users", { email: "osman@7d.test", name: "Osman", password: PW });
    await admin.post(`${P()}/members`, { email: "osman@7d.test", isProjectAdmin: false });
    const osman = api(await login("osman@7d.test"));
    expect((await osman.get(`${P()}/doc-compare?from=${v1}&to=${v2}`)).status).toBe(404);
    expect((await osman.get(`${P()}/doc-compare/${cid}`)).status).toBe(404);

    // The cde_document_compare tool through the REST layer with the admin's session.
    const call = async (method: string, url: string) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie: admin.cookie } });
      if (res.statusCode >= 400) throw new Error(res.body);
      return res.json();
    };
    const tool = cdeToolDefinitions(call as never, { readOnly: true }).find((t) => t.name === "cde_document_compare")!;
    expect(tool).toBeTruthy();
    const file = (await admin.get(`${P()}/files/${(await admin.get(`${P()}/doc-compare/${cid}`)).body.to.fileId}`)).body;
    const out = (await tool.run({ projectId: pid, fileId: file.id })) as any;
    expect(out).toMatchObject({ versions: "V1 → V2", revision: "B → C", kind: "pdf" });
    expect(out.antet).toContain("Revizyon: B → C");
    expect(out.aiSummary[0]).toContain("[s.1]");
    expect(out.pages.items[0].examples).toContain('~ "KOLON S12 40x60" → "KOLON S12 50x60"');
  });

  it("builds a compact prompt", () => {
    const text = buildPrompt({
      fileA: "A.pdf",
      fileB: "A.pdf",
      versionA: 1,
      versionB: 2,
      result: {
        kind: "pdf",
        hasText: false,
        identical: false,
        pageCountA: 1,
        pageCountB: 1,
        pages: [],
        totals: { added: 0, removed: 0, changed: 0, pages: 0 },
        antet: [],
        revisionA: null,
        revisionB: null,
        revisionTableA: null,
        revisionTableB: null,
        antetRegion: null,
        contentChanged: false,
        note: "Metin katmanı yok, yalnızca görsel karşılaştırma.",
      },
      regions: [{ page: 1, regions: [{ box: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 }, kind: "added", pixels: 5 }] }],
      flags: [],
    });
    expect(text).toContain("Dosya: A.pdf, V1 → V2");
    expect(text).toContain("Sayfa 1 (1 görsel değişiklik bölgesi)");
    expect(text).toContain("Metin katmanı yok");
  });
});
