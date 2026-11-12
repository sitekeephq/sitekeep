import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { checkProjectTemplate } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { folders, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { builtInTemplates } from "../../src/projects/project-templates.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-tpl-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
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
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
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
type Api = ReturnType<typeof api>;

async function child(a: Api, pid: string, fid: string, name: string): Promise<string> {
  const c = await a.get(`/projects/${pid}/folders/${fid}/contents`);
  expect(c.status, c.body?.message).toBe(200);
  const f = c.body.folders.find((x: { name: string }) => x.name === name);
  expect(f, `${name} in ${c.body.folders.map((x: { name: string }) => x.name).join(", ")}`).toBeTruthy();
  return f.id;
}

async function walk(a: Api, pid: string, rootId: string, names: string[]): Promise<string> {
  let id = rootId;
  for (const n of names) id = await child(a, pid, id, n);
  return id;
}

async function liveFolderCount(projectId: string): Promise<number> {
  const rows = await handle.db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.projectId, projectId), isNull(folders.deletedAt)));
  return rows.length;
}

/** Template without volatile header fields, for comparisons. */
function body(t: Record<string, unknown>) {
  const { name: _n, description: _d, notes: _x, ...rest } = t;
  return rest;
}

describe("project templates", () => {
  let admin: Api;
  let designer: Api;
  let contractor: Api;
  const co: Record<string, string> = {};
  let slotCompanies: Record<string, string>;

  it("sets up companies and users", async () => {
    admin = api(await login("admin@7d.test"));
    for (const name of ["Poyraz", "CNS", "Hilal", "Zirve"]) co[name] = (await admin.post("/companies", { name })).body.id;
    await admin.post("/users", { email: "cns@7d.test", name: "Ceren", password: PW, companyId: co.CNS });
    await admin.post("/users", { email: "pas@7d.test", name: "Pelin", password: PW, companyId: co.Poyraz });
    designer = api(await login("cns@7d.test"));
    contractor = api(await login("pas@7d.test"));
    slotCompanies = { yuklenici: co.Poyraz!, tasarimci: co.CNS!, musavir: co.Hilal!, idare: co.Zirve! };
  });

  it("ships valid built-in templates", async () => {
    const list = await admin.get("/templates");
    expect(list.status).toBe(200);
    expect(list.body.map((t: { id: string }) => t.id).sort()).toEqual(["bina-veri-merkezi", "iso19650-temel", "metro-ibb"]);
    for (const [id, t] of builtInTemplates()) {
      expect(checkProjectTemplate(t), id).toEqual([]);
      const p = await admin.post("/templates/preview", { templateId: id, code: "TST", slotCompanies });
      expect(p.status).toBe(200);
      expect(p.body.errors, id).toEqual([]);
      expect(p.body.ok).toBe(true);
      expect(p.body.counts.folders).toBeGreaterThan(4);
    }
    // The metro template creates most of its leaves on demand.
    const metro = list.body.find((t: { id: string }) => t.id === "metro-ibb");
    expect(metro.counts.virtualFolders).toBeGreaterThan(metro.counts.folders);
    expect(metro.dimensions.find((d: { name: string }) => d.name === "İstasyon").editable).toBe(true);
  });

  it("reports template errors in preview and rejects malformed JSON", async () => {
    const bad = await admin.post("/templates/preview", {
      template: {
        name: "Hatalı",
        slots: [{ key: "a", label: "A" }],
        folders: [{ name: "X", grants: [{ slot: "yok", level: "view" }], naming: "Olmayan" }, "X", "Kötü/ad"],
        workflows: [{ name: "Akış", steps: [{ name: "S", assignees: [{ slot: "b" }], rule: "any", days: 1, outcomes: ["approved"] }] }],
        unknownKey: { ignored: true },
      },
    });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    const text = bad.body.errors.join("\n");
    expect(text).toContain('"yok" rolü');
    expect(text).toContain('"Olmayan" isimlendirme');
    expect(text).toContain("iki kez");
    expect(text).toContain("kullanılamaz");
    expect(text).toContain('"b" rolü');
    expect((await admin.post("/templates/preview", { template: { name: "x", folders: "nope" } })).status).toBe(400);
    expect((await admin.post("/templates/preview", { templateId: "yok" })).status).toBe(404);
  });

  it("forbids non-admins to create projects from templates", async () => {
    const r = await contractor.post("/projects/from-template", { code: "NOPE", name: "x", templateId: "iso19650-temel" });
    expect(r.status).toBe(403);
  });

  let zavm: { id: string; rootFolderId: string };

  it("creates a building project and resolves slots to companies", async () => {
    const r = await admin.post("/projects/from-template", {
      code: "ZAVM",
      name: "Zirve Veri Merkezi",
      templateId: "bina-veri-merkezi",
      slotCompanies,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.warnings).toEqual([]);
    zavm = r.body;
    expect(await liveFolderCount(zavm.id)).toBe(r.body.counts.folders);

    const root = await admin.get(`/projects/${zavm.id}/folders/${zavm.rootFolderId}/contents`);
    expect(root.body.folders.map((f: { name: string }) => f.name)).toEqual([
      "01-WIP (Çalışmada)",
      "02-SHARED (Paylaşılan)",
      "03-PUBLISHED (Yayınlanan)",
      "04-ARCHIVED (Arşiv)",
    ]);
    const sharedId = root.body.folders[1].id;
    type Grant = { subjectId: string; subjectName: string; level: string; inherited: boolean };
    const grants: Grant[] = (await admin.get(`/projects/${zavm.id}/folders/${sharedId}/permissions`)).body;
    // The template grants the slot companies on SHARED; the default roles come from the root folder.
    expect(grants.filter((g) => !g.inherited).map((g) => [g.subjectId, g.level]).sort()).toEqual(
      Object.values(slotCompanies)
        .map((id) => [id, "view_download"])
        .sort(),
    );
    expect(grants.filter((g) => g.inherited).map((g) => [g.subjectName, g.level])).toEqual([
      ["Görüntüleyici", "view_download"],
      ["Düzenleyici", "edit"],
      ["Yönetici", "manage"],
    ]);
    expect((await admin.get(`/projects/${zavm.id}/folders/${sharedId}/settings`)).body.gated).toBe(true);

    const wf = (await admin.get(`/projects/${zavm.id}/workflow-templates`)).body;
    expect(wf).toHaveLength(1);
    expect(wf[0].steps.map((s: { assignees: { type: string; id: string }[] }) => s.assignees)).toEqual(
      [co.Poyraz, co.CNS, co.Hilal, co.Zirve].map((id) => [{ type: "company", id }]),
    );

    const std = (await admin.get(`/projects/${zavm.id}/naming-standards`)).body[0].definition;
    expect(std.fields[0].values.map((v: { code: string }) => v.code)).toEqual(["ZAVM"]);
    expect(std.fields[1].values).toEqual([
      { code: "PAS", description: "Poyraz" },
      { code: "CNS", description: "CNS" },
      { code: "HLL", description: "Hilal" },
      { code: "ZRT", description: "Zirve" },
    ]);

    // The designer company edits WIP; the contractor only views it.
    await admin.post(`/projects/${zavm.id}/members`, { email: "cns@7d.test" });
    await admin.post(`/projects/${zavm.id}/members`, { email: "pas@7d.test" });
    const statik = await walk(designer, zavm.id, zavm.rootFolderId, ["01-WIP (Çalışmada)", "Statik"]);
    const up = await designer.upload(`/projects/${zavm.id}/folders/${statik}/files`, "ZAVM-CNS-ZZ-S-00-0101-RP-SD-0001.pdf", "x");
    expect(up.body.results[0].ok, JSON.stringify(up.body)).toBe(true);
    expect((await contractor.get(`/projects/${zavm.id}/folders/${statik}`)).body.myLevel).toBe("view_download");
  });

  it("leaves unmapped slots empty and hands their steps to project admins", async () => {
    const r = await admin.post("/projects/from-template", {
      code: "ZAVMB",
      name: "Eksik roller",
      templateId: "bina-veri-merkezi",
      slotCompanies: { yuklenici: co.Poyraz, tasarimci: co.CNS },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.warnings.join(" ")).toContain("Müşavir");
    const wf = (await admin.get(`/projects/${r.body.id}/workflow-templates`)).body[0];
    expect(wf.steps[2].assignees).toEqual([{ type: "role", id: "project_admin" }]);
    const std = (await admin.get(`/projects/${r.body.id}/naming-standards`)).body[0].definition;
    // Slot codes are template defaults even without a company.
    expect(std.fields[1].values.map((v: { code: string }) => v.code)).toEqual(["PAS", "CNS", "HLL", "ZRT"]);
    expect((await admin.post("/projects/from-template", { code: "ZAVM", name: "x", templateId: "iso19650-temel" })).status).toBe(409);
  });

  let pkf: { id: string; rootFolderId: string; counts: { folders: number; virtualFolders: number } };

  it("creates leaf folders on demand", async () => {
    const r = await admin.post("/projects/from-template", {
      code: "PKF",
      name: "M10 Metrosu",
      templateId: "metro-ibb",
      slotCompanies,
      slotCodes: { yuklenici: "OZG", tasarimci: "PRT" },
      dimensions: { İstasyon: ["S00 İstasyonlar (Genel)", "SG1 Pendik Merkez"], Hat: ["L1SG Pendik Merkez-Kaynarca Merkez"] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pkf = r.body;
    expect(await liveFolderCount(pkf.id)).toBe(pkf.counts.folders);
    expect(pkf.counts.virtualFolders).toBeGreaterThan(pkf.counts.folders);
    await admin.post(`/projects/${pkf.id}/members`, { email: "cns@7d.test" });
    await admin.post(`/projects/${pkf.id}/members`, { email: "pas@7d.test" });

    const mimari = await walk(designer, pkf.id, pkf.rootFolderId, [
      "99-TASARIMCI ORTAK ALAN",
      "002-İstasyonlar",
      "SG1 Pendik Merkez",
      "01-Mimari",
    ]);
    let c = await designer.get(`/projects/${pkf.id}/folders/${mimari}/contents`);
    expect(c.body.folders).toEqual([]);
    expect(c.body.virtualFolders.map((v: { name: string }) => v.name)).toEqual(["01-Modeller", "02-Çizimler", "03-Raporlar"]);

    const m = await designer.post(`/projects/${pkf.id}/folders/${mimari}/materialize`, { path: ["02-Çizimler"] });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.created).toEqual(["02-Çizimler"]);
    expect(m.body.folder.myLevel).toBe("manage");
    c = await designer.get(`/projects/${pkf.id}/folders/${mimari}/contents`);
    expect(c.body.folders.map((f: { name: string }) => f.name)).toEqual(["02-Çizimler"]);
    expect(c.body.virtualFolders.map((v: { name: string }) => v.name)).toEqual(["01-Modeller", "03-Raporlar"]);
    const up = await designer.upload(`/projects/${pkf.id}/folders/${m.body.folder.id}/files`, "pafta.pdf", "x");
    expect(up.body.results[0].ok).toBe(true);
    expect(await liveFolderCount(pkf.id)).toBe(pkf.counts.folders + 1);

    // Unknown names and callers without upload permission are refused.
    expect((await designer.post(`/projects/${pkf.id}/folders/${mimari}/materialize`, { path: ["99-Yok"] })).status).toBe(404);
    expect((await contractor.post(`/projects/${pkf.id}/folders/${mimari}/materialize`, { path: ["01-Modeller"] })).status).toBe(404);

    // A path through an existing folder creates only the missing part; sub-status labels are kept.
    const published = await walk(contractor, pkf.id, pkf.rootFolderId, ["01-TASARIM ÇALIŞMALARI", "02-Onaya Sunulan (Shared for Approval)"]);
    const pub = await contractor.get(`/projects/${pkf.id}/folders/${published}`);
    expect(pub.body.stateLabel).toBe("Onay için");
    const genel = await child(contractor, pkf.id, published, "000-Genel");
    const p2 = await contractor.post(`/projects/${pkf.id}/folders/${published}/materialize`, { path: ["000-Genel", "05-CDE Esasları"] });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.created).toEqual(["05-CDE Esasları"]);
    expect(p2.body.folder.parentId).toBe(genel);

    const std = (await admin.get(`/projects/${pkf.id}/naming-standards`)).body[0].definition;
    expect(std.fields.slice(0, 3).map((f: { values: { code: string }[] }) => f.values.map((v) => v.code))).toEqual([
      ["OZG"],
      ["PRT", "DGR"],
      ["PKF"],
    ]);
    // Extra field properties (variable digits) pass through unchanged.
    expect(std.fields[11]).toMatchObject({ type: "number", digits: 3, minDigits: 2, maxDigits: 3 });
  });

  it("exports a project as a template and round-trips it", async () => {
    expect((await contractor.get(`/projects/${pkf.id}/export-template`)).status).toBe(403);
    const e1 = await admin.get(`/projects/${pkf.id}/export-template`);
    expect(e1.status).toBe(200);
    expect(e1.headers["content-disposition"]).toContain("PKF-sablon.json");
    const t1 = e1.body;
    expect(t1.slots.map((s: { key: string }) => s.key)).toEqual(["idare", "musavir", "yuklenici", "tasarimci"]);
    expect(JSON.stringify(t1)).not.toContain("pafta.pdf");
    expect(t1.namingStandards[0].fields[2].values[0].code).toBe("{PROJE}");
    expect(checkProjectTemplate(t1)).toEqual([]);

    const r = await admin.post("/projects/from-template", { code: "PKF2", name: "Kopya", template: t1, slotCompanies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await liveFolderCount(r.body.id)).toBe(await liveFolderCount(pkf.id));
    expect(r.body.counts.virtualFolders).toBeLessThan(pkf.counts.virtualFolders);
    const t2 = (await admin.get(`/projects/${r.body.id}/export-template`)).body;
    expect(body(t2)).toEqual(body(t1));

    // The building project round-trips too (company grants → slots → the same companies).
    const z1 = (await admin.get(`/projects/${zavm.id}/export-template`)).body;
    const z = await admin.post("/projects/from-template", { code: "ZAVM2", name: "Kopya", template: z1, slotCompanies });
    expect(z.status, JSON.stringify(z.body)).toBe(200);
    expect(body((await admin.get(`/projects/${z.body.id}/export-template`)).body)).toEqual(body(z1));
  });

  it("round-trips review-chain settings through slots and folder paths", async () => {
    const r = await admin.post("/projects/from-template", { code: "ZCH", name: "Zincir", templateId: "bina-veri-merkezi", slotCompanies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pid = r.body.id;
    const published = await child(admin, pid, r.body.rootFolderId, "03-PUBLISHED (Yayınlanan)");
    const options = [
      { code: "YUK-A", label: "YÜKLENİCİ ONAYLADI", kind: "approved" },
      { code: "YUK-C", label: "YÜKLENİCİ İADE ETTİ", kind: "revise" },
    ];
    const chain = {
      stages: [
        { name: "Yüklenici", party: "contractor", days: 7, onRevise: "stop" },
        { name: "Müşavir", party: "consultant", days: 10, onRevise: "continue" },
      ],
      originParty: "designer",
      namePattern: "{Proje}-RV-{0000}",
      copyTarget: { folderId: published, pattern: "{Disiplin}", onUnresolved: "base" },
    };
    const wf = await admin.post(`/projects/${pid}/workflow-templates`, {
      name: "Kademeli onay",
      steps: [
        { name: "Yüklenici kontrolü", assignees: [{ type: "company", id: co.Poyraz }], rule: "any", days: 3, outcomeOptions: options, stage: 0, requiredAttributes: ["Durum"] },
        {
          name: "Disiplin müşaviri",
          assignees: [],
          rule: "any",
          days: 5,
          outcomes: ["approved", "revise_resubmit"],
          stage: 1,
          assigneeRule: {
            type: "by_attribute",
            attribute: "Disiplin",
            map: { S: [{ type: "company", id: co.Hilal }], M: [{ type: "company", id: co.Zirve }, { type: "role", id: "project_admin" }] },
            fallback: [{ type: "company", id: co.Hilal }],
          },
        },
      ],
      chain,
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(200);

    const t1 = (await admin.get(`/projects/${pid}/export-template`)).body;
    expect(checkProjectTemplate(t1)).toEqual([]);
    const w1 = t1.workflows.find((w: { name: string }) => w.name === "Kademeli onay");
    expect(w1.chain).toEqual({
      stages: chain.stages,
      originParty: "designer",
      namePattern: "{Proje}-RV-{0000}",
      copyTarget: { folder: "03-PUBLISHED (Yayınlanan)", pattern: "{Disiplin}", onUnresolved: "base" },
    });
    expect(w1.steps[0]).toMatchObject({ assignees: [{ slot: "yuklenici" }], outcomeOptions: options, stage: 0, requiredAttributes: ["Durum"] });
    expect(w1.steps[1]).toMatchObject({
      assignees: [],
      stage: 1,
      assigneeRule: {
        type: "by_attribute",
        attribute: "Disiplin",
        map: { S: [{ slot: "musavir" }], M: [{ slot: "idare" }, { role: "project_admin" }] },
        fallback: [{ slot: "musavir" }],
      },
    });

    // Import with other companies in the slots: assignees follow the slots, the folder its path.
    const swapped = { ...slotCompanies, musavir: co.Zirve!, idare: co.Hilal! };
    const c = await admin.post("/projects/from-template", { code: "ZCH2", name: "Zincir kopya", template: t1, slotCompanies: swapped });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.warnings).toEqual([]);
    const copyPublished = await child(admin, c.body.id, c.body.rootFolderId, "03-PUBLISHED (Yayınlanan)");
    const imported = (await admin.get(`/projects/${c.body.id}/workflow-templates`)).body.find((w: { name: string }) => w.name === "Kademeli onay");
    expect(imported.chain).toEqual({ ...chain, copyTarget: { ...chain.copyTarget, folderId: copyPublished } });
    expect(imported.steps[0]).toMatchObject({ assignees: [{ type: "company", id: co.Poyraz }], outcomeOptions: options, stage: 0, requiredAttributes: ["Durum"] });
    expect(imported.steps[1].assignees).toEqual([]);
    expect(imported.steps[1].assigneeRule).toEqual({
      type: "by_attribute",
      attribute: "Disiplin",
      map: { S: [{ type: "company", id: co.Zirve }], M: [{ type: "company", id: co.Hilal }, { type: "role", id: "project_admin" }] },
      fallback: [{ type: "company", id: co.Zirve }],
    });
    // Exported again it is the same template.
    expect(body((await admin.get(`/projects/${c.body.id}/export-template`)).body)).toEqual(body(t1));

    // A copy target folder missing from the template is reported and left empty.
    const broken = structuredClone(t1);
    broken.workflows.find((w: { name: string }) => w.name === "Kademeli onay").chain.copyTarget.folder = "Yok/Burada";
    const p = await admin.post("/templates/preview", { template: broken, slotCompanies });
    expect(p.body.ok, JSON.stringify(p.body.errors)).toBe(true);
    expect(p.body.warnings.join(" ")).toContain("Yok/Burada");
  });
});
