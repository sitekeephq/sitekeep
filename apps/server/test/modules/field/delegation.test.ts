// Approval delegation (issue #190) in Field's form approval flow: with a delegate resolved by the
// core's hook, the delegate gets the form step ("vekâleten"), answers it, the record and the form
// PDF say "A adına B", and the person can no longer answer the same step.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { registerAssigneeResolver } from "../../../src/workflow/delegation.js";
import { extractPdfText } from "../../../src/docintel/extract.js";
import { moduleAtLeast } from "../../helpers/modules.js";

// Field 0.7.0 uses the delegation hook (SDK 0.20.0).
const fieldDelegates = moduleAtLeast("field", "0.7.0");

const PW = "Sifre-1234567";
let handle: DbHandle;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-form-vekalet-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function client(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? (r.json() as any) : null, raw: r.rawPayload };
  };
  return { get: (u: string) => call("GET", u), post: (u: string, p?: unknown) => call("POST", u, p ?? {}), put: (u: string, p: unknown) => call("PUT", u, p) };
}

describe.skipIf(!fieldDelegates)("form approval with a delegate", () => {
  it("B answers A's form step 'A adına B'; A then gets a clear error; the PDF names both", async () => {
    const admin = await client("admin@7d.test");
    const pid = (await admin.post("/projects", { code: "FVK", name: "Form vekalet" })).body.id;
    const ids: Record<string, string> = {};
    for (const [key, name] of [["murat", "Murat"], ["ayse", "Ayşe"], ["bora", "Bora"]] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@fv.test`, name, password: PW })).body.id;
      expect((await admin.post(`/projects/${pid}/members`, { email: `${key}@fv.test` })).status).toBe(200);
    }
    registerAssigneeResolver({
      id: "test-form-delegation",
      delegates: ({ userIds }) => (userIds.includes(ids.ayse!) ? [{ forUserId: ids.ayse!, userId: ids.bora!, delegationId: "d-form" }] : []),
    });
    const murat = await client("murat@fv.test");
    const ayse = await client("ayse@fv.test");
    const bora = await client("bora@fv.test");
    const wf = await admin.post(`/projects/${pid}/workflow-templates`, {
      kind: "form",
      name: "Kontrol",
      steps: [{ name: "Saha şefi onayı", assignees: [{ type: "user", id: ids.ayse }], rule: "any", days: 2, outcomes: ["approved", "rejected"] }],
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(200);
    const t = await admin.post(`/projects/${pid}/form-templates`, {
      code: "GK",
      name: "Günlük kontrol",
      schema: { sections: [{ id: "s", title: "Genel", items: [{ id: "a", type: "text", label: "Not" }] }] },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const tpl = (await admin.get(`/projects/${pid}/form-templates/${t.body.id}`)).body;
    expect((await admin.put(`/projects/${pid}/form-templates/${t.body.id}`, { ...tpl, workflowTemplateId: wf.body.id })).status).toBe(200);
    const f = (await murat.post(`/projects/${pid}/forms`, { templateId: t.body.id, formDate: "2026-12-02" })).body;
    expect((await murat.post(`/projects/${pid}/forms/${f.id}/submit`, { values: { a: "Tamam" } })).body.status).toBe("in_review");

    // Bora: the step is his as a delegate.
    const tasks = (await bora.get("/my-tasks")).body;
    expect(tasks).toEqual([expect.objectContaining({ kind: "form", subjectId: f.id, onBehalfOf: { userId: ids.ayse, name: "Ayşe" } })]);
    expect((await bora.get("/notifications")).body[0].title).toContain("Ayşe adına");
    expect((await bora.get(`/projects/${pid}/forms/${f.id}`)).body.workflow.canAct).toBe(true);
    const r = await bora.post(`/projects/${pid}/forms/${f.id}/review`, { outcome: "approved" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "closed", lastOutcome: "approved" });
    const submit = r.body.workflow.actions.find((x: { kind: string }) => x.kind === "submit");
    expect(submit).toMatchObject({ userId: ids.bora, onBehalfOf: [{ type: "user", id: ids.ayse, name: "Ayşe", delegated: true }] });

    // Ayşe comes too late.
    const late = await ayse.post(`/projects/${pid}/forms/${f.id}/review`, { outcome: "rejected" });
    expect(late.status).toBe(409);

    // The form PDF lists the approval as "Bora (Ayşe adına, vekâleten)".
    const pdf = await ayse.get(`/projects/${pid}/forms/${f.id}/pdf`);
    expect(pdf.status).toBe(200);
    const text = (await extractPdfText({ data: new Uint8Array(pdf.raw), maxPages: 5 })).pages.flatMap((p) => p.items.map((i) => i.s)).join(" ");
    expect(text.replace(/\s+/g, " ")).toContain("Bora (Ayşe adına, vekâleten)");
  });
});
