/** "Poz Öner" over HTTP: suggestions, accept → cost rules + memory, reject, memory across projects and the (fake) AI. */
import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import {
  auditLog,
  projectMembers,
  users,
} from "../../../src/db/schema.js";
import { pozMappings } from "@7dimensions-project/sitekeep-ee-cost/internal/schema/index.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC = readFileSync(path.join(here, "../../fixtures/poz.ifc"));
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
let stub: Server;
let stubUrl: string;
let stubBroken = false;
let stubPrompt = "";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-poz-api-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 5) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const user: string = body.messages?.[1]?.content ?? "";
      stubPrompt = user;
      const perde = /(g\d+): Duvar \| tip: Perde 25/.exec(user)?.[1] ?? "g1";
      const answer = stubBroken
        ? "Bunu yapamam."
        : `\`\`\`json\n${JSON.stringify({ suggestions: [{ group: perde, code: "B-DUV", confidence: 0.8, reason: "Perde duvar m² ile ölçülsün" }, { group: "g42", code: "YOK" }] })}\n\`\`\``;
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
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: Buffer) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie, "content-type": req.headers.get("content-type")! }, payload: body });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

type Api = ReturnType<typeof api>;
interface Sug {
  group: { key: string; class: string; type: string | null; material: string | null; match: unknown };
  costItemId: string;
  quantity: string;
  multiplier: number;
  amount: number;
  source: string;
  confidence: number;
  reason: string;
}

async function project(admin: Api, code: string, items: object[]): Promise<{ pid: string; versionId: string; items: Map<string, string> }> {
  const p = await admin.post("/projects", { code, name: `${code} Projesi` });
  const pid = p.body.id as string;
  const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
  const folderId = (await admin.post(`/projects/${pid}/folders`, { parentId: contents.body.folders[0].id, name: "Modeller" })).body.id;
  const up = await admin.upload(`/projects/${pid}/folders/${folderId}/files`, "Kaba.ifc", IFC);
  await jobs.drain();
  const file = await admin.get(`/projects/${pid}/files/${up.body.results[0].fileId}`);
  const ids = new Map<string, string>();
  for (const it of items) {
    const r = await admin.post(`/projects/${pid}/cost-items`, it);
    expect(r.status, r.body?.message).toBe(200);
    ids.set(r.body.code, r.body.id);
  }
  return { pid, versionId: file.body.versions[0].id, items: ids };
}

const accept = (s: Sug) => ({ class: s.group.class, type: s.group.type, material: s.group.material, match: s.group.match, costItemId: s.costItemId, quantity: s.quantity, multiplier: s.multiplier, source: s.source });
const of = (list: Sug[], cls: string, type: string | null = null) => list.find((s) => s.group.class === cls && s.group.type === type);

describe("Poz Öner API", () => {
  let admin: Api;
  let member: Api;
  let planner: Api;
  let A: Awaited<ReturnType<typeof project>>;
  let B: Awaited<ReturnType<typeof project>>;

  it("suggests unit prices from keywords when no AI provider is set", async () => {
    admin = api(await login("admin@7d.test"));
    A = await project(admin, "PZA", [
      { code: "BET-C30", description: "C30 hazır beton dökülmesi", unit: "m³", unitPrice: 2500, pozCode: "15.150.1005" },
      { code: "GAZ-20", description: "20 cm gazbeton duvar yapılması", unit: "m²", unitPrice: 450, pozCode: "18.071.1102" },
      { code: "KAPI-90", description: "Ahşap iç kapı 90x210", unit: "adet", unitPrice: 6000 },
      { code: "PEN-120", description: "PVC pencere 120x120", unit: "adet", unitPrice: 4000 },
    ]);
    const r = await admin.post(`/projects/${A.pid}/cost-rules/suggest`, { versionId: A.versionId });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body.ai.used).toBe(false);
    expect(r.body.ai.error).toBeTruthy();
    const list = r.body.suggestions as Sug[];
    expect(list.map((s) => [s.group.class, s.group.type, s.source])).toHaveLength(7);
    expect(list.every((s) => s.source === "keywords")).toBe(true);
    expect(of(list, "IfcWall", "Gazbeton Duvar 20")).toMatchObject({ costItemId: A.items.get("GAZ-20"), quantity: "NetSideArea", amount: 8100 });
    expect(of(list, "IfcWall", "Perde 25")).toMatchObject({ costItemId: A.items.get("BET-C30"), quantity: "NetVolume", amount: 12000 });
    expect(r.body.unmatched.map((u: { group: { class: string } }) => u.group.class).sort()).toEqual(["IfcRailing", "IfcWindow"]);
    expect(r.body.covered).toBe(0);
    // English reasons for an English reader.
    const en = await app.inject({ method: "POST", url: `/api/v1/projects/${A.pid}/cost-rules/suggest`, headers: { cookie: (await login("admin@7d.test")), "accept-language": "en" }, payload: { versionId: A.versionId, ai: false } });
    expect(en.json().suggestions[0].reason).toMatch(/^Matching words/);
  });

  it("is for planners only", async () => {
    const u = await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    expect((await admin.post(`/projects/${A.pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    member = api(await login("uye@7d.test"));
    expect((await member.post(`/projects/${A.pid}/cost-rules/suggest`, { versionId: A.versionId })).status).toBe(403);
    expect((await member.get(`/projects/${A.pid}/poz-mappings`)).status).toBe(403);
    expect(u.status).toBe(200);
  });

  it("turns accepted suggestions into cost rules and remembers them", async () => {
    const list = (await admin.post(`/projects/${A.pid}/cost-rules/suggest`, { versionId: A.versionId, ai: false })).body.suggestions as Sug[];
    const chosen = [of(list, "IfcWall", "Gazbeton Duvar 20")!, of(list, "IfcDoor", "KP-90")!];
    const r = await admin.post(`/projects/${A.pid}/cost-rules/suggest/accept`, { versionId: A.versionId, suggestions: chosen.map(accept) });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body.rules.map((x: { costItemCode: string; label: string }) => [x.costItemCode, x.label])).toEqual([
      ["GAZ-20", 'Sınıf: Duvar · Tip = "Gazbeton Duvar 20"'],
      ["KAPI-90", 'Sınıf: Kapı · Tip = "KP-90"'],
    ]);
    const preview = await admin.post(`/projects/${A.pid}/cost-rules/preview`, { versionId: A.versionId });
    expect(preview.body.total).toBe(8100 + 12000);
    const again = await admin.post(`/projects/${A.pid}/cost-rules/suggest`, { versionId: A.versionId, ai: false });
    expect(again.body.covered).toBe(2);
    expect(again.body.suggestions).toHaveLength(5);
    const [log] = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, A.pid), eq(auditLog.action, "cost.poz_suggestions_accepted")));
    expect(log!.details).toMatchObject({ count: 2, sources: { keywords: 2 } });
    const mappings = (await admin.get(`/projects/${A.pid}/poz-mappings`)).body;
    expect(mappings.map((m: { pozCode: string; decision: string; uses: number }) => [m.pozCode, m.decision, m.uses]).sort()).toEqual([
      ["18.071.1102", "accepted", 1],
      ["KAPI-90", "accepted", 1],
    ]);
  });

  it("does not offer a rejected pair again", async () => {
    const r = await admin.post(`/projects/${A.pid}/cost-rules/suggest/reject`, { class: "IfcSlab", type: null, material: "Beton C30", costItemId: A.items.get("BET-C30") });
    expect(r.status, r.body?.message).toBe(200);
    const list = (await admin.post(`/projects/${A.pid}/cost-rules/suggest`, { versionId: A.versionId, ai: false })).body;
    expect(of(list.suggestions, "IfcSlab")).toBeUndefined();
    expect(list.unmatched.some((u: { group: { class: string } }) => u.group.class === "IfcSlab")).toBe(true);
  });

  it("applies the memory in another project by poz no, and counts repeated approvals", async () => {
    B = await project(admin, "PZB", [
      { code: "B-DUV", description: "Gazbeton duvar", unit: "m²", unitPrice: 500, pozCode: "18.071.1102" },
      { code: "B-BET", description: "Hazır beton C30", unit: "m³", unitPrice: 2600 },
    ]);
    const list = (await admin.post(`/projects/${B.pid}/cost-rules/suggest`, { versionId: B.versionId, ai: false })).body.suggestions as Sug[];
    const gaz = of(list, "IfcWall", "Gazbeton Duvar 20")!;
    expect(gaz).toMatchObject({ source: "memory", costItemId: B.items.get("B-DUV"), quantity: "NetSideArea", amount: 9000, confidence: 0.96 });
    expect(gaz.reason).toContain("1 kez");
    expect(list[0]!.source).toBe("memory");
    await admin.post(`/projects/${B.pid}/cost-rules/suggest/accept`, { versionId: B.versionId, suggestions: [accept(gaz)] });
    const m = (await admin.get(`/projects/${B.pid}/poz-mappings`)).body.find((x: { pozCode: string }) => x.pozCode === "18.071.1102");
    expect(m.uses).toBe(2);
  });

  it.skipIf(!hasAi)("lets the project's AI pick among candidates; quantities stay the model's", async () => {
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    const r = await admin.post(`/projects/${B.pid}/cost-rules/suggest`, { versionId: B.versionId });
    expect(r.status, r.body?.message).toBe(200);
    expect(r.body.ai).toMatchObject({ used: true, model: "qwen3:8b" });
    expect(stubPrompt).toContain("Perde 25");
    expect(stubPrompt).not.toContain("Gazbeton Duvar 20"); // already priced by the accepted rule
    const perde = of(r.body.suggestions, "IfcWall", "Perde 25")!;
    expect(perde).toMatchObject({ source: "ai", costItemId: B.items.get("B-DUV"), quantity: "NetSideArea", amount: 12000, reason: "Yapay zekâ: Perde duvar m² ile ölçülsün" });
    // Groups the AI skipped fall back to keywords.
    expect(of(r.body.suggestions, "IfcSlab")).toMatchObject({ source: "keywords", costItemId: B.items.get("B-BET") });
    const [log] = await handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, B.pid), eq(auditLog.action, "ai.poz_suggest")));
    expect(log!.details).toMatchObject({ model: "qwen3:8b", picked: 1 });

    stubBroken = true;
    const broken = await admin.post(`/projects/${B.pid}/cost-rules/suggest`, { versionId: B.versionId });
    stubBroken = false;
    expect(broken.body.ai.used).toBe(false);
    expect(broken.body.ai.error).toContain("okunamadı");
    expect(of(broken.body.suggestions, "IfcWall", "Perde 25")).toMatchObject({ source: "keywords", costItemId: B.items.get("B-BET") });
    await admin.put("/admin/settings/ai", { mode: "off" });
  });

  it("lets a planner remove only mappings learned in the same project", async () => {
    const p = await admin.post("/users", { email: "planci@7d.test", name: "Planlamacı", password: PW });
    await handle.db.insert(projectMembers).values({ projectId: B.pid, userId: p.body.id, isProjectAdmin: true });
    planner = api(await login("planci@7d.test"));
    await planner.post(`/projects/${B.pid}/cost-rules/suggest/reject`, { class: "IfcSlab", type: null, material: "Beton C30", costItemId: B.items.get("B-BET") });
    const list = (await planner.get(`/projects/${B.pid}/poz-mappings`)).body as { id: string; pozCode: string; deletable: boolean }[];
    const kapi = list.find((m) => m.pozCode === "KAPI-90")!; // learned in project A
    const gaz = list.find((m) => m.pozCode === "18.071.1102")!; // learned in A, approved again in B: still A's
    const slab = list.find((m) => m.pozCode === "15.150.1005")!; // rejected in A
    const own = list.find((m) => m.pozCode === "B-BET")!; // rejected in B
    expect([kapi.deletable, gaz.deletable, slab.deletable, own.deletable]).toEqual([false, false, false, true]);
    expect((await planner.del(`/projects/${B.pid}/poz-mappings/${kapi.id}`)).status).toBe(403);
    expect((await planner.del(`/projects/${B.pid}/poz-mappings/${gaz.id}`)).status).toBe(403);
    expect((await planner.del(`/projects/${B.pid}/poz-mappings/${own.id}`)).status).toBe(200);
    expect((await admin.del(`/projects/${B.pid}/poz-mappings/${kapi.id}`)).status).toBe(200);
    const left = (await planner.get(`/projects/${B.pid}/poz-mappings`)).body.map((m: { pozCode: string }) => m.pozCode);
    expect(left.sort()).toEqual(["15.150.1005", "18.071.1102"]);
  });

  it("does not let another project overwrite or take over a mapping", async () => {
    // Project B rejects the wall pair project A approved: A keeps it, and A still gets it suggested.
    const r = await planner.post(`/projects/${B.pid}/cost-rules/suggest/reject`, { class: "IfcWall", type: "Gazbeton Duvar 20", material: null, costItemId: B.items.get("B-DUV") });
    expect(r.status, r.body?.message).toBe(200);
    const [row] = await handle.db.select().from(pozMappings).where(eq(pozMappings.pozCode, "18.071.1102"));
    expect(row).toMatchObject({ decision: "accepted", projectId: A.pid });
  });
});
