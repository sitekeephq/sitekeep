// ÇŞB 2026 (EK-2) naming profile in the Turkish construction template and the set-up wizard
// (docs/features/NAMING_CSB_2026.md): the template's standard equals the shared profile, the wizard
// chooses it as the document code standard (folders follow), the EK-1 project code fills Proje Kodu,
// names are checked on the folders, Revizyon No is not part of the document code, and the project
// naming API keeps the profile's settings.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { CSB_2026_STANDARD_NAME, csb2026NamingStandard, type NamingStandard } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { folders, namingStandards, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { builtInTemplates } from "../../src/projects/project-templates.js";
import { documentCodeOf } from "../../src/cde/document-code.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const TEMPLATE = "iso19650-yapim-tr";
const SHARED = "20-PAYLAŞILAN (Shared)";
const ISO = "ISO 19650 Doküman Kodlama";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-csb-"));
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

async function admin() {
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@7d.test", password: PW } });
  const cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
  const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, "accept-language": "en" }, payload: payload as object });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p?: unknown) => call("POST", u, p ?? {}), put: (u: string, p?: unknown) => call("PUT", u, p ?? {}) };
}

async function standardOfFolder(projectId: string, name: string): Promise<string | null> {
  const [folder] = await handle.db.select().from(folders).where(and(eq(folders.projectId, projectId), eq(folders.name, name)));
  if (!folder?.namingStandardId) return null;
  const [row] = await handle.db.select().from(namingStandards).where(eq(namingStandards.id, folder.namingStandardId));
  return row?.definition.name ?? null;
}

describe("ÇŞB 2026 (EK-2) naming profile", () => {
  it("is in the Turkish construction template, generated from the same tables as the shared profile", () => {
    const tr = builtInTemplates("tr").get(TEMPLATE)!;
    const standard = tr.namingStandards!.find((s) => s.name === CSB_2026_STANDARD_NAME);
    expect(standard).toEqual(csb2026NamingStandard({ projectCode: "{EK1}" }));
    // The ISO 19650 naming stays the default document code standard; the English template has no ÇŞB profile.
    expect(tr.cde?.containerStandard).toBe(ISO);
    expect(builtInTemplates("en").get("iso19650-yapim-en")!.namingStandards!.some((s) => s.name === CSB_2026_STANDARD_NAME)).toBe(false);
  });

  let pid: string;
  it("the wizard chooses it as the document code standard: folders follow, Proje Kodu is the EK-1 code", async () => {
    const api = await admin();
    const request = {
      templateId: TEMPLATE,
      language: "tr",
      code: "CSB1",
      name: "ÇŞB Projesi",
      setup: { containerStandard: CSB_2026_STANDARD_NAME },
      details: { csbProjectCode: "270001" },
    };
    const dry = await api.post("/projects/setup/preview", request);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.ok, JSON.stringify(dry.body.errors)).toBe(true);
    expect(dry.body.tree.find((f: { name: string }) => f.name === SHARED).naming).toBe(CSB_2026_STANDARD_NAME);

    const res = await api.post("/projects/from-template", request);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    pid = res.body.id;
    expect(res.body.details).toEqual({ csbProjectCode: "270001" });

    const rows = await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, pid));
    const csb = rows.find((r) => r.definition.name === CSB_2026_STANDARD_NAME)!;
    expect(csb.definition.fields[0]).toEqual({ name: "Proje Kodu", type: "list", values: [{ code: "270001" }] });
    expect((await api.get(`/projects/${pid}/cde/settings`)).body.containerStandardId).toBe(csb.id);
    expect(await standardOfFolder(pid, SHARED)).toBe(CSB_2026_STANDARD_NAME);
    expect(await standardOfFolder(pid, "30-YAYINLANAN (Published)")).toBe(CSB_2026_STANDARD_NAME);
    // Correspondence keeps its own naming.
    expect(await standardOfFolder(pid, "07-Yazışmalar")).toBe("Yazışma Kodlama");

    const [shared] = await handle.db
      .select()
      .from(folders)
      .where(and(eq(folders.projectId, pid), eq(folders.name, SHARED)));
    const check = await api.post(`/projects/${pid}/naming/validate`, {
      folderId: shared!.id,
      names: [
        "270001_00_MM_DUVA_PL_MMC_K01_01_000.dwg",
        "270001_00_ST_BETO_HS_SHR_NNN_01_001.pdf",
        "270002_00_MM_DUVA_PL_MMC_K01_01_000.dwg",
        "270001_00_MM_BETO_PL_MMC_K01_01_000.dwg",
        "270001_000_MM_DUVA_PL_MMC_K01_01_000.dwg",
      ],
    });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.standard).toBe(CSB_2026_STANDARD_NAME);
    expect(check.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false, false, false]);
    expect(check.body.results[2].errors).toContain('Proje Kodu: "270002" is not one of the allowed values');
    expect(check.body.results[3].errors).toContain('Alt Disiplin / Öge: "BETO" is not allowed with Disiplin "MM"');
    expect(check.body.results[4].errors[0]).toBe("The name is 36 characters long; at most 35 are allowed (without the extension).");
  });

  it("without the EK-1 code Proje Kodu takes any six letters or digits; an invalid code is refused", async () => {
    const api = await admin();
    const res = await api.post("/projects/from-template", { templateId: TEMPLATE, language: "tr", code: "CSB2", name: "ÇŞB 2", setup: { containerStandard: CSB_2026_STANDARD_NAME } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, res.body.id));
    expect(rows.find((r) => r.definition.name === CSB_2026_STANDARD_NAME)!.definition).toEqual(csb2026NamingStandard());

    const bad = await api.post("/projects/setup/preview", { templateId: TEMPLATE, language: "tr", code: "CSB3", details: { csbProjectCode: "27-001" } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors).toContain('The ÇŞB project code (EK-1) must be six capital letters or digits (e.g. 270001): "27-001".');
  });

  it("projects keep the ISO 19650 naming when the wizard does not choose the profile", async () => {
    const api = await admin();
    const res = await api.post("/projects/from-template", { templateId: TEMPLATE, language: "tr", code: "CSB4", name: "ISO" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await standardOfFolder(res.body.id, SHARED)).toBe(ISO);
  });

  it("Revizyon No is in the name but not in the document code", () => {
    const standard = csb2026NamingStandard({ projectCode: "270001" });
    expect(documentCodeOf(standard, "270001_00_MM_DUVA_PL_MMC_K01_01_000.dwg")).toBe("270001_00_MM_DUVA_PL_MMC_K01_01");
    expect(documentCodeOf(standard, "270001_00_MM_DUVA_PL_MMC_K01_01_003.pdf")).toBe("270001_00_MM_DUVA_PL_MMC_K01_01");
    expect(documentCodeOf(standard, "270001_00_MM_DUVA_PL_MMC_K01_01.pdf")).toBeNull();
  });

  it("the project naming API keeps the profile's settings and checks them", async () => {
    const api = await admin();
    const csbRow = (await handle.db.select().from(namingStandards).where(eq(namingStandards.projectId, pid))).find(
      (r) => r.definition.name === CSB_2026_STANDARD_NAME,
    )!;
    const put = await api.put(`/projects/${pid}/naming-standards/${csbRow.id}`, csbRow.definition);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.definition).toEqual(csbRow.definition);
    const created = await api.post(`/projects/${pid}/naming-standards`, { ...csb2026NamingStandard(), name: "Kopya" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.definition).toEqual({ ...csb2026NamingStandard(), name: "Kopya" });
    // A dependent list must point at an earlier list field.
    const broken: NamingStandard = { ...csb2026NamingStandard(), name: "Bozuk" };
    broken.fields = broken.fields.map((f) => (f.type === "list" && f.dependsOn ? { ...f, dependsOn: "Dosya Tipi" } : f));
    const refused = await api.post(`/projects/${pid}/naming-standards`, broken);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('depends on \\"Dosya Tipi\\"');
  });
});
