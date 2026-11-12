import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyCounter,
  chainText,
  partyOutcomeOptions,
  renderPattern,
  resolveOutcomeOption,
  type WorkflowStep,
} from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import {
  combineChainOutcomes,
  enterStep,
  fileChain,
  resolveAssigneeRules,
  resolveNamePrefix,
  stopsChain,
  type ChainTemplate,
} from "../../src/workflow/chain.js";
import { runDueReminders } from "../../src/workflow/reminders.js";

// ---- Pure chain logic -----------------------------------------------------------------------

const step = (o: Partial<WorkflowStep>): WorkflowStep => ({
  name: "Adım",
  assignees: [{ type: "role", id: "project_admin" }],
  rule: "any",
  days: 0,
  outcomes: ["approved", "rejected"],
  ...o,
});
const actor = (userId: string) => ({ userId, companyId: null, isProjectAdmin: false, isStarter: false });

describe("review chain logic", () => {
  const client = partyOutcomeOptions("client", ["approved", "approved_with_comments", "info", "revise", "rejected"]);

  it("maps custom party-labelled outcomes to engine kinds", () => {
    expect(client.map((o) => o.label)).toEqual([
      "İDARE ONAYLANDI",
      "İDARE ŞARTLI ONAYLANDI",
      "İDARE BİLGİ",
      "İDARE İADE EDİLDİ",
      "İDARE REDDEDİLDİ",
    ]);
    const s = step({ outcomeOptions: client });
    expect(resolveOutcomeOption(s, "IDR-B")).toMatchObject({ base: "approved_with_comments", label: "İDARE ŞARTLI ONAYLANDI" });
    expect(resolveOutcomeOption(s, "IDR-I")?.base).toBe("reviewed");
    expect(resolveOutcomeOption(s, "approved")).toBeNull();
    // Plain steps keep the base codes.
    expect(resolveOutcomeOption(step({}), "approved")?.base).toBe("approved");

    const all = step({ rule: "all", outcomeOptions: client });
    const combined = combineChainOutcomes(all, [
      { actor: actor("u1"), outcomes: { f: "approved" }, codes: { f: "IDR-A" } },
      { actor: actor("u2"), outcomes: { f: "revise_resubmit" }, codes: { f: "IDR-C" } },
    ]);
    expect(combined.f).toEqual({ base: "revise_resubmit", code: "IDR-C" });
  });

  const tpl: ChainTemplate = {
    steps: [step({ stage: 0, days: 10 }), step({ stage: 1, days: 3 }), step({ stage: 1, days: 3 }), step({ stage: 2 })],
    finalOutcomes: {},
    chain: {
      originParty: "designer",
      stages: [
        { name: "Yüklenici", party: "contractor", days: 7, onRevise: "stop" },
        { name: "Müşavir", party: "consultant", days: 15, onRevise: "continue" },
        { name: "İdare", party: "client", days: 30, onRevise: "stop" },
      ],
    },
  };

  it("stops on revise only in stop stages and keeps step dues inside the stage deadline", () => {
    expect(stopsChain(tpl, 0, "revise_resubmit")).toBe(true);
    expect(stopsChain(tpl, 0, "approved_with_comments")).toBe(false);
    expect(stopsChain(tpl, 1, "rejected")).toBe(false);
    expect(stopsChain({ ...tpl, chain: {} }, 0, "rejected")).toBe(false);

    const t0 = new Date("2026-10-01T08:00:00Z");
    const s0 = enterStep(tpl, null, 0, t0, null);
    expect(s0.stageDueAt?.toISOString()).toBe("2026-10-08T08:00:00.000Z");
    expect(s0.stepDueAt?.toISOString()).toBe("2026-10-08T08:00:00.000Z"); // 10 days capped by 7
    const t1 = new Date("2026-10-05T08:00:00Z");
    const s1 = enterStep(tpl, 0, 1, t1, s0.stageDueAt);
    expect(s1.stageDueAt?.toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect(s1.stepDueAt?.toISOString()).toBe("2026-10-08T08:00:00.000Z");
    // Same stage: the stage clock keeps running.
    const s2 = enterStep(tpl, 1, 2, new Date("2026-10-19T08:00:00Z"), s1.stageDueAt);
    expect(s2.stepDueAt?.toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });

  it("renders per-file chain status", () => {
    const inst = { status: "running" as const, stepIndex: 1, stepDueAt: new Date(Date.now() + 86_400_000), stageDueAt: null };
    const cells = fileChain(tpl, inst, { stepResults: { "0": "approved" } });
    expect(chainText(cells)).toBe("Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·");
    expect(chainText(cells, true)).toBe("T✓ Y✓ M⧗ İ·");
    const returned = fileChain(tpl, inst, { stepResults: { "0": "revise_resubmit" }, stoppedAtStep: 0 });
    expect(chainText(returned)).toBe("Tasarımcı ✓ → Yüklenici ✗ → Müşavir – → İdare –");
  });

  it("resolves attribute assignees consistently and builds review numbers", () => {
    const s = step({
      assignees: [],
      assigneeRule: { type: "by_attribute", attribute: "Disiplin", map: { S: [{ type: "company", id: "cS" }], M: [{ type: "company", id: "cM" }] } },
    });
    const ok = resolveAssigneeRules([s], [
      { name: "a", values: { Disiplin: "S" } },
      { name: "b", values: { Disiplin: "S" } },
    ]);
    expect(ok.problems).toEqual([]);
    expect(ok.steps[0]!.assignees).toEqual([{ type: "company", id: "cS" }]);
    expect(ok.steps[0]!.resolvedBy).toEqual({ attribute: "Disiplin", values: ["S"] });
    const mixed = resolveAssigneeRules([s], [
      { name: "a", values: { Disiplin: "S" } },
      { name: "b", values: { Disiplin: "M" } },
    ]);
    expect(mixed.problems[0]).toContain("farklı atananlara");
    expect(resolveAssigneeRules([s], [{ name: "c", values: {} }]).problems[0]).toContain("eşlenemedi");

    expect(renderPattern("{Bölge}/{Disiplin}", { Bölge: "S20" })).toEqual({ text: "S20/{Disiplin}", unresolved: ["Disiplin"] });
    const p = resolveNamePrefix("{Proje}-{Tip}-{0000}", [{ name: "a", values: { Tip: "RP" } }], { Proje: "MBE" });
    expect(p.prefix).toBe("MBE-RP-{0000}");
    expect(applyCounter(p.prefix!, 7)).toBe("MBE-RP-0007");
  });
});

// ---- API ----------------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-rc-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@rc.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, list: { name: string; data: string }[], fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      for (const f of list) form.append("file", new Blob([f.data]), f.name);
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

describe("review chains API", () => {
  let admin: Client, des: Client, con: Client, str: Client, mek: Client, idr: Client;
  const ids: Record<string, string> = {};
  const v: Record<string, string> = {};
  let pid: string, designId: string, notesId: string, publishedId: string, templateId: string, reviewId: string;
  const P = () => `/projects/${pid}`;
  const rf = (detail: any, name: string) => detail.files.find((f: { fileName: string }) => f.fileName === name).id;

  it("sets up parties, a naming standard and design files", async () => {
    admin = api(await login("admin@rc.test"));
    for (const c of ["TKN", "ICT", "EMAY-S", "EMAY-M", "IBB"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects", { code: "MBE", name: "Zincir testi" });
    pid = p.body.id;
    for (const [key, company] of [["des", "TKN"], ["con", "ICT"], ["str", "EMAY-S"], ["mek", "EMAY-M"], ["idr", "IBB"]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@rc.test`, name: key, password: PW, companyId: ids[company] })).body.id;
      await admin.post(`${P()}/members`, { email: `${key}@rc.test` });
    }
    [des, con, str, mek, idr] = await Promise.all(["des", "con", "str", "mek", "idr"].map(async (k) => api(await login(`${k}@rc.test`))));

    const root = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    const [wipId, , pub] = root.body.folders.map((f: { id: string }) => f.id);
    publishedId = pub;
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;
    notesId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Notlar" })).body.id;
    // An existing zone folder: "S21" lands in it by code prefix.
    await admin.post(`${P()}/folders`, { parentId: publishedId, name: "S21 - Atatürk Mahallesi" });
    await admin.put(`${P()}/folders/${wipId}/permissions`, { entries: [{ subjectType: "company", subjectId: ids.TKN, level: "edit" }] });
    await admin.put(`${P()}/folders/${publishedId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: ids.TKN, level: "edit" }],
    });
    const std = await admin.post(`${P()}/naming-standards`, {
      name: "Metro",
      delimiter: "-",
      fields: [
        { name: "Proje", type: "list", values: [{ code: "MBE" }] },
        { name: "Bölge", type: "list", values: [{ code: "S20" }, { code: "S21" }] },
        { name: "Disiplin", type: "list", values: [{ code: "S" }, { code: "M" }] },
        { name: "Tip", type: "list", values: [{ code: "RP" }, { code: "DW" }] },
        { name: "No", type: "number", digits: 4 },
      ],
    });
    await admin.patch(`${P()}/folders/${designId}`, { namingStandardId: std.body.id });
    await admin.post(`${P()}/attribute-definitions`, { name: "Revizyon", type: "list", options: ["A", "B", "C"] });

    const names = ["MBE-S20-S-RP-0001.pdf", "MBE-S20-M-RP-0003.pdf", "MBE-S21-S-DW-0002.pdf", "MBE-S21-S-RP-0004.pdf", "MBE-S20-S-RP-0005.pdf"];
    expect((await des.upload(`${P()}/folders/${designId}/files`, names.map((n) => ({ name: n, data: n })))).status).toBe(200);
    for (const f of (await des.get(`${P()}/folders/${designId}/contents`)).body.files) v[f.name.slice(13, 17)] = f.latest.id;
    await des.upload(`${P()}/folders/${notesId}/files`, [{ name: "serbest.pdf", data: "x" }], { attributes: JSON.stringify({ Disiplin: "S", Tip: "RP" }) });
    v.free = (await des.get(`${P()}/folders/${notesId}/contents`)).body.files[0].latest.id;
    expect(Object.keys(v)).toHaveLength(6);
  });

  it("validates and saves a tiered template with labels, attribute assignees and patterns", async () => {
    const steps = [
      { name: "Yüklenici onayı", stage: 0, assignees: [{ type: "company", id: ids.ICT }], rule: "any", days: 0, outcomeOptions: partyOutcomeOptions("contractor") },
      {
        name: "Müşavir incelemesi",
        stage: 1,
        assignees: [],
        assigneeRule: { type: "by_attribute", attribute: "Disiplin", map: { S: [{ type: "company", id: ids["EMAY-S"] }], M: [{ type: "company", id: ids["EMAY-M"] }] } },
        rule: "any",
        days: 0,
        outcomeOptions: partyOutcomeOptions("consultant", ["approved", "approved_with_comments", "info", "revise"]),
        requiredAttributes: ["Yazı No", "Revizyon"],
      },
      { name: "İdare onayı", stage: 2, assignees: [{ type: "company", id: ids.IBB }], rule: "any", days: 0, outcomeOptions: partyOutcomeOptions("client") },
    ];
    const chain = {
      originParty: "designer",
      stages: [
        { name: "Yüklenici", party: "contractor", days: 7, onRevise: "stop" },
        { name: "Müşavir", party: "consultant", days: 15, onRevise: "continue" },
        { name: "İdare", party: "client", days: 30, onRevise: "stop" },
      ],
      namePattern: "{Proje}-{Tip}-{0000}",
      copyTarget: { folderId: publishedId, pattern: "{Bölge}/{Disiplin}" },
    };
    const bad = await admin.post(`${P()}/workflow-templates`, {
      name: "Kötü",
      steps: [{ ...steps[0], stage: 5 }],
      chain: { ...chain, namePattern: "{Proje}-{Tip}" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("kademe tanımlı değil");
    expect(bad.body.message).toContain("sayaç");

    const t = await admin.post(`${P()}/workflow-templates`, { name: "MBE zinciri", steps, chain });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    templateId = t.body.id;
    expect(t.body.steps[0].outcomes).toEqual(["approved", "approved_with_comments", "revise_resubmit", "rejected"]);
    expect(t.body.chain.stages).toHaveLength(3);
    expect(t.body.steps[1].assigneeRule.attribute).toBe("Disiplin");
  });

  it("refuses files that resolve to different assignee groups or number prefixes", async () => {
    const mixed = await des.post(`${P()}/reviews`, { templateId, versionIds: [v["0001"], v["0003"]] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.message).toContain("farklı atananlara");
    const pv = await des.post(`${P()}/reviews/preview`, { templateId, versionIds: [v["0001"], v["0002"]] });
    expect(pv.body.ok).toBe(false);
    expect(pv.body.problems.join(" ")).toContain("farklı inceleme numarası");
    const good = await des.post(`${P()}/reviews/preview`, { templateId, versionIds: [v["0001"], v["0004"]] });
    expect(good.body).toMatchObject({ ok: true, code: "MBE-RP-0001" });
    expect(good.body.steps[1].assignees).toEqual([{ type: "company", id: ids["EMAY-S"] }]);
    expect(good.body.files.map((f: { targetPath: string }) => f.targetPath).sort()).toEqual([
      "Proje Dosyaları / 03-PUBLISHED (Yayınlanan) / S20 / S",
      "Proje Dosyaları / 03-PUBLISHED (Yayınlanan) / S21 / S",
    ]);
  });

  it("numbers the review and starts the first stage with the stage deadline", async () => {
    const r = await des.post(`${P()}/reviews`, { templateId, versionIds: [v["0001"], v["0004"], v["0005"]] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    reviewId = r.body.id;
    expect(r.body).toMatchObject({ code: "MBE-RP-0001", name: "MBE-RP-0001", stepIndex: 0, overdue: false });
    const days = (new Date(r.body.stepDueAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(chainText(r.body.files[0].chain)).toBe("Tasarımcı ✓ → Yüklenici ⧗ → Müşavir · → İdare ·");
    // The consultant company resolved from Disiplin=S sees the review; the M team does not.
    expect((await str.get(`${P()}/reviews`)).body).toHaveLength(1);
    expect((await mek.get(`${P()}/reviews`)).body).toHaveLength(0);
  });

  it("stops a revised file in a stop stage and sends it back; others continue", async () => {
    const d = (await con.get(`${P()}/reviews/${reviewId}`)).body;
    const wrong = await con.post(`${P()}/reviews/${reviewId}/submit`, {
      files: d.files.map((f: { id: string }) => ({ reviewFileId: f.id, outcome: "approved" })),
    });
    expect(wrong.status).toBe(400);
    const r = await con.post(`${P()}/reviews/${reviewId}/submit`, {
      files: [
        { reviewFileId: rf(d, "MBE-S20-S-RP-0001.pdf"), outcome: "YUK-A" },
        { reviewFileId: rf(d, "MBE-S21-S-RP-0004.pdf"), outcome: "YUK-B" },
        { reviewFileId: rf(d, "MBE-S20-S-RP-0005.pdf"), outcome: "YUK-C" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "running", stepIndex: 1 });
    const back = r.body.files.find((f: { fileName: string }) => f.fileName.endsWith("0005.pdf"));
    expect(back).toMatchObject({ stoppedAtStep: 0, finalStatus: "revise_resubmit", finalLabel: "YÜKLENİCİ İADE EDİLDİ" });
    expect(back.stepLabels["0"]).toBe("YÜKLENİCİ İADE EDİLDİ");
    const ok = r.body.files.find((f: { fileName: string }) => f.fileName.endsWith("0001.pdf"));
    expect(chainText(ok.chain)).toBe("Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·");
    expect(chainText(back.chain)).toBe("Tasarımcı ✓ → Yüklenici ✗ → Müşavir – → İdare –");
    expect((await des.get("/notifications")).body.map((n: { kind: string }) => n.kind)).toContain("review.returned");

    const ap = (await des.get(`${P()}/folders/${designId}/approvals`)).body;
    const byV = Object.fromEntries(ap.map((x: { versionId: string }) => [x.versionId, x]));
    expect(byV[v["0005"]]).toMatchObject({ status: "revise_resubmit", label: "YÜKLENİCİ İADE EDİLDİ" });
    expect(byV[v["0001"]]).toMatchObject({ status: "in_review", chain: "T✓ Y✓ M⧗ İ·" });
  });

  it("requires step attributes, validates them and writes them to the files (audited)", async () => {
    const d = (await str.get(`${P()}/reviews/${reviewId}`)).body;
    expect(d.canAct).toBe(true);
    expect(d.attributeDefinitions.map((x: { name: string }) => x.name)).toEqual(["Revizyon"]);
    const f1 = rf(d, "MBE-S20-S-RP-0001.pdf");
    const f4 = rf(d, "MBE-S21-S-RP-0004.pdf");
    const files = [
      { reviewFileId: f1, outcome: "MUS-B" },
      { reviewFileId: f4, outcome: "MUS-I" },
    ];
    const missing = await str.post(`${P()}/reviews/${reviewId}/submit`, { files });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('"Yazı No" zorunlu');
    const invalid = await str.post(`${P()}/reviews/${reviewId}/submit`, {
      files,
      attributes: { [f1]: { "Yazı No": "2026/101", Revizyon: "Z" }, [f4]: { "Yazı No": "2026/101", Revizyon: "A" } },
    });
    expect(invalid.body.message).toContain("geçerli bir seçenek değil");
    const returned = await str.post(`${P()}/reviews/${reviewId}/submit`, {
      files: [...files, { reviewFileId: rf(d, "MBE-S20-S-RP-0005.pdf"), outcome: "MUS-A" }],
      attributes: { [f1]: { "Yazı No": "2026/101", Revizyon: "B" }, [f4]: { "Yazı No": "2026/101", Revizyon: "A" } },
    });
    expect(returned.body.message).toContain("İade edilmiş dosyaya");
    const ok = await str.post(`${P()}/reviews/${reviewId}/submit`, {
      files,
      attributes: { [f1]: { "Yazı No": "2026/101", Revizyon: "B" }, [f4]: { "Yazı No": "2026/101", Revizyon: "A" } },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.stepIndex).toBe(2);
    expect(ok.body.files.find((f: { id: string }) => f.id === f1).attributes).toMatchObject({ "Yazı No": "2026/101", Revizyon: "B" });
    expect(ok.body.marks.find((m: { reviewFileId: string; stepIndex: number }) => m.reviewFileId === f4 && m.stepIndex === 1).label).toBe("MÜŞAVİR BİLGİ");
    const activity = (await admin.get(`${P()}/activity`)).body.filter((e: { action: string }) => e.action === "file.attributes_updated");
    expect(activity).toHaveLength(2);
    expect(activity[0].details.to["Yazı No"]).toBe("2026/101");
  });

  it("completes with party labels and copies into pattern sub-folders it creates", async () => {
    const d = (await idr.get(`${P()}/reviews/${reviewId}`)).body;
    const done = await idr.post(`${P()}/reviews/${reviewId}/submit`, {
      files: [
        { reviewFileId: rf(d, "MBE-S20-S-RP-0001.pdf"), outcome: "IDR-B" },
        { reviewFileId: rf(d, "MBE-S21-S-RP-0004.pdf"), outcome: "IDR-A" },
      ],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("completed");
    const byName = Object.fromEntries(done.body.files.map((f: { fileName: string }) => [f.fileName.slice(13, 17), f]));
    expect(byName["0001"]).toMatchObject({ finalStatus: "approved_with_comments", finalLabel: "İDARE ŞARTLI ONAYLANDI", copyError: null });
    expect(byName["0001"].targetPath).toBe("Proje Dosyaları / 03-PUBLISHED (Yayınlanan) / S20 / S");
    expect(byName["0004"].targetPath).toBe("Proje Dosyaları / 03-PUBLISHED (Yayınlanan) / S21 - Atatürk Mahallesi / S");
    expect(byName["0005"].copiedFileId).toBeNull();
    expect(chainText(byName["0001"].chain)).toBe("Tasarımcı ✓ → Yüklenici ✓ → Müşavir ✓ → İdare ✓");

    const pub = (await des.get(`${P()}/folders/${publishedId}/contents`)).body.folders.map((f: { name: string }) => f.name);
    expect(pub.sort()).toEqual(["S20", "S21 - Atatürk Mahallesi"]);
    const s20 = (await des.get(`${P()}/folders/${publishedId}/contents`)).body.folders.find((f: { name: string }) => f.name === "S20");
    const s20s = (await des.get(`${P()}/folders/${s20.id}/contents`)).body.folders[0];
    const copied = (await des.get(`${P()}/folders/${s20s.id}/contents`)).body.files;
    expect(copied.map((f: { name: string }) => f.name)).toEqual(["MBE-S20-S-RP-0001.pdf"]);
    expect(copied[0].attributes["Yazı No"]).toBe("2026/101");
    // Created folders inherit the base permissions (no grants of their own).
    expect((await des.get(`${P()}/folders/${s20s.id}`)).body.canUpload).toBe(true);
    const ap = (await des.get(`${P()}/folders/${s20s.id}/approvals`)).body;
    expect(ap[0]).toMatchObject({ isCopy: true, label: "İDARE ŞARTLI ONAYLANDI", chain: "T✓ Y✓ M✓ İ✓" });
  });

  it("numbers reviews per project and prefix", async () => {
    const dw = await des.post(`${P()}/reviews`, { templateId, versionIds: [v["0002"]], name: "Kalıp donatı" });
    expect(dw.body).toMatchObject({ code: "MBE-DW-0001", name: "Kalıp donatı" });
    const m = await des.post(`${P()}/reviews`, { templateId, versionIds: [v["0003"]] });
    expect(m.body.code).toBe("MBE-RP-0002");
    expect(m.body.steps[1].assignees).toEqual([{ type: "company", id: ids["EMAY-M"] }]);
  });

  it("reports unresolved target fields per file", async () => {
    const quick = await admin.post(`${P()}/workflow-templates`, {
      name: "Hızlı",
      steps: [{ name: "Yönetici", assignees: [{ type: "role", id: "project_admin" }], rule: "any", days: 0, outcomes: ["approved"] }],
      chain: { copyTarget: { folderId: publishedId, pattern: "{Bölge}/{Disiplin}" } },
    });
    const pv = await des.post(`${P()}/reviews/preview`, { templateId: quick.body.id, versionIds: [v.free], name: "Serbest" });
    expect(pv.body.files[0]).toMatchObject({ targetPath: null, unresolved: ["Bölge"] });
    const r = await des.post(`${P()}/reviews`, { templateId: quick.body.id, versionIds: [v.free], name: "Serbest" });
    const done = await admin.post(`${P()}/reviews/${r.body.id}/submit`, { files: [{ reviewFileId: r.body.files[0].id, outcome: "approved" }] });
    expect(done.body.files[0].copyError).toContain("{Bölge}");
    expect(done.body.files[0].copyUnresolved).toEqual(["Bölge"]);
    // With fallback the file lands in the base folder.
    const r2 = await des.post(`${P()}/reviews`, { templateId: quick.body.id, versionIds: [v.free], name: "Serbest 2", targetFallback: true });
    const done2 = await admin.post(`${P()}/reviews/${r2.body.id}/submit`, { files: [{ reviewFileId: r2.body.files[0].id, outcome: "approved" }] });
    expect(done2.body.files[0]).toMatchObject({ copyError: null, copyUnresolved: ["Bölge"], targetPath: "Proje Dosyaları / 03-PUBLISHED (Yayınlanan)" });
  });

  it("sends due-soon and overdue reminders once per step (fake clock)", async () => {
    // Only the running reviews (DW and M, both in the 7-day contractor stage) are due.
    const now = Date.now();
    expect(await runDueReminders(handle.db, new Date(now + 3 * 86_400_000))).toEqual({ dueSoon: 0, overdue: 0 });
    expect(await runDueReminders(handle.db, new Date(now + 6.5 * 86_400_000))).toEqual({ dueSoon: 2, overdue: 0 });
    expect(await runDueReminders(handle.db, new Date(now + 6.6 * 86_400_000))).toEqual({ dueSoon: 0, overdue: 0 });
    const conKinds = (await con.get("/notifications")).body.map((n: { kind: string; title: string }) => n.kind);
    expect(conKinds.filter((k: string) => k === "review.due_soon")).toHaveLength(2);
    expect(await runDueReminders(handle.db, new Date(now + 8 * 86_400_000))).toEqual({ dueSoon: 0, overdue: 2 });
    expect(await runDueReminders(handle.db, new Date(now + 9 * 86_400_000))).toEqual({ dueSoon: 0, overdue: 0 });
    const overdue = (await des.get("/notifications")).body.filter((n: { kind: string }) => n.kind === "review.overdue");
    expect(overdue).toHaveLength(2);
    expect(overdue[0].title).toContain("termini geçti");
  });
});
