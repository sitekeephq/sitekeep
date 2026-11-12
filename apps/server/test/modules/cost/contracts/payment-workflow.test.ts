import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../../../src/app/build-app.js";
import { hashPassword } from "../../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../../src/db/index.js";
import { notifications, projectMembers, projects, users, workflowInstances } from "../../../../src/db/schema.js";
import { runPaymentDueReminders } from "@7dimensions-project/sitekeep-ee-cost/internal/contracts/workflow.js";
import { JobQueue } from "../../../../src/jobs/queue.js";
import { LocalStorage } from "../../../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

describe("progress payment approval on the workflow engine", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  let projectId: string;
  let admin: string;
  let office: string;
  let consultant: string;
  let outsider: string;
  let officeId: string;
  let consultantId: string;
  let templateId: string;
  let contractId: string;
  let itemId: string;

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  }

  const url = (p: string) => `/api/v1/projects/${projectId}${p}`;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "7dcde-payflow-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });

    const hash = await hashPassword(PW);
    const [a, o, c, x] = await handle.db
      .insert(users)
      .values([
        { email: "admin@payflow.test", name: "Yönetici", passwordHash: hash, isAdmin: false },
        { email: "office@payflow.test", name: "Teknik Ofis", passwordHash: hash, isAdmin: false },
        { email: "consultant@payflow.test", name: "Müşavir", passwordHash: hash, isAdmin: false },
        { email: "outsider@payflow.test", name: "Saha", passwordHash: hash, isAdmin: false },
      ])
      .returning();
    officeId = o!.id;
    consultantId = c!.id;
    const [proj] = await handle.db.insert(projects).values({ code: "HKF-01", name: "Hakediş Akışı", createdBy: a!.id }).returning();
    projectId = proj!.id;
    await handle.db.insert(projectMembers).values([
      { projectId, userId: a!.id, isProjectAdmin: true },
      { projectId, userId: o!.id, isProjectAdmin: false },
      { projectId, userId: c!.id, isProjectAdmin: false },
      { projectId, userId: x!.id, isProjectAdmin: false },
    ]);
    admin = await login("admin@payflow.test");
    office = await login("office@payflow.test");
    consultant = await login("consultant@payflow.test");
    outsider = await login("outsider@payflow.test");

    const tpl = await app.inject({
      method: "POST",
      url: url("/workflow-templates"),
      headers: { cookie: admin },
      payload: {
        kind: "progress_payment",
        name: "Hakediş Onayı",
        steps: [
          { name: "Teknik Ofis", assignees: [{ type: "user", id: officeId }], rule: "any", days: 2, outcomes: ["approved", "rejected"] },
          { name: "Müşavir", assignees: [{ type: "user", id: consultantId }], rule: "any", days: 3, outcomes: ["approved", "rejected"] },
        ],
      },
    });
    expect(tpl.statusCode, tpl.body).toBeLessThan(300);
    templateId = tpl.json().id;

    const res = await app.inject({
      method: "POST",
      url: url("/contracts"),
      headers: { cookie: admin },
      payload: {
        code: "AKS-01",
        title: "Akışlı Sözleşme",
        employerName: "İşveren A.Ş.",
        contractorName: "Yüklenici A.Ş.",
        approvalTemplateId: templateId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    contractId = res.json().id;
    expect(res.json().approvalTemplateName).toBe("Hakediş Onayı");

    const item = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/items`),
      headers: { cookie: admin },
      payload: { code: "P-01", description: "Beton", unit: "m3", unitPrice: 100, contractQuantity: 100 },
    });
    expect(item.statusCode, item.body).toBe(201);
    itemId = (item.json().items as { id: string; code: string }[]).find((i) => i.code === "P-01")!.id;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Each scenario gets its own contract so payment numbers and their order stay independent. */
  async function newContract(withFlow = true) {
    const res = await app.inject({
      method: "POST",
      url: url("/contracts"),
      headers: { cookie: admin },
      payload: {
        code: `AKS-${Math.random().toString(36).slice(2, 8)}`,
        title: "Akışlı Sözleşme",
        employerName: "İşveren A.Ş.",
        contractorName: "Yüklenici A.Ş.",
        approvalTemplateId: withFlow ? templateId : null,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    contractId = res.json().id;
    const item = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/items`),
      headers: { cookie: admin },
      payload: { code: "P-01", description: "Beton", unit: "m3", unitPrice: 100, contractQuantity: 100 },
    });
    expect(item.statusCode, item.body).toBe(201);
    itemId = (item.json().items as { id: string; code: string }[]).find((i) => i.code === "P-01")!.id;
  }

  async function newPayment(fresh = true, withFlow = true) {
    if (fresh) await newContract(withFlow);
    const res = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/payments`),
      headers: { cookie: admin },
      payload: { periodEnd: "2026-03-31" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    const patch = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${id}`),
      headers: { cookie: admin },
      payload: { lines: [{ contractItemId: itemId, periodQuantity: 10 }] },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    return id;
  }

  const answer = (cookie: string, payId: string, outcome: string, comment?: string) =>
    app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/payments/${payId}/answer`),
      headers: { cookie },
      payload: { outcome, comment },
    });

  it("rejects a template of another kind or project", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}`),
      headers: { cookie: admin },
      payload: { approvalTemplateId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a payment line for an item outside the contract", async () => {
    const payId = await newPayment();
    const res = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${payId}`),
      headers: { cookie: admin },
      payload: { lines: [{ contractItemId: contractId, periodQuantity: 1 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a submitted payment through every step and approves it at the end", async () => {
    const payId = await newPayment();
    const sub = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/payments/${payId}/submit`),
      headers: { cookie: admin },
      payload: {},
    });
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().status).toBe("in_review");
    expect(sub.json().workflow).toMatchObject({ stepIndex: 0, stepCount: 2, stepName: "Teknik Ofis", canAct: false });
    expect(sub.json().workflow.stepNames).toEqual(["Teknik Ofis", "Müşavir"]);

    // The single admin decision is closed while the flow runs.
    const direct = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/payments/${payId}/approve`),
      headers: { cookie: admin },
      payload: {},
    });
    expect(direct.statusCode).toBe(409);

    // Not the current step's assignee.
    expect((await answer(consultant, payId, "approved")).statusCode).toBe(403);
    expect((await answer(outsider, payId, "approved")).statusCode).toBe(403);

    const assigned = await handle.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, officeId), eq(notifications.kind, "contract.payment_assigned")));
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.link).toContain(`payment=${payId}`);

    const tasks = await app.inject({ method: "GET", url: "/api/v1/my-tasks", headers: { cookie: office } });
    expect(tasks.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "progress_payment", subjectId: payId, stepName: "Teknik Ofis" })]),
    );

    const view = await app.inject({ method: "GET", url: url(`/contracts/${contractId}/payments/${payId}`), headers: { cookie: office } });
    expect(view.json().workflow.canAct).toBe(true);
    expect(view.json().canComment).toBe(true);

    // The reviewer may comment on lines but not change figures.
    const comment = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${payId}`),
      headers: { cookie: office },
      payload: { lines: [{ contractItemId: itemId, periodQuantity: 999, objectionNote: "Ataşman eksik" }] },
    });
    expect(comment.statusCode, comment.body).toBe(200);
    expect(comment.json().lines[0]).toMatchObject({ periodQuantity: 10, objectionNote: "Ataşman eksik" });
    const figures = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${payId}`),
      headers: { cookie: office },
      payload: { otherDeduction: 5 },
    });
    expect(figures.statusCode).toBe(403);
    const outsiderComment = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${payId}`),
      headers: { cookie: outsider },
      payload: { lines: [{ contractItemId: itemId, periodQuantity: 10, objectionNote: "x" }] },
    });
    expect(outsiderComment.statusCode).toBe(403);

    expect((await answer(office, payId, "approved_with_comments")).statusCode).toBe(400);
    const first = await answer(office, payId, "approved", "Uygun");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe("in_review");
    expect(first.json().workflow).toMatchObject({ stepIndex: 1, stepName: "Müşavir", canAct: false });
    expect((await answer(office, payId, "approved")).statusCode).toBe(403);

    const last = await answer(consultant, payId, "approved", "Onaylandı");
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().status).toBe("approved");
    expect(last.json().workflow.status).toBe("completed");
    expect(last.json().decisionNote).toBe("Onaylandı");

    const contract = await app.inject({ method: "GET", url: url(`/contracts/${contractId}`), headers: { cookie: admin } });
    expect(contract.json().approvedCumulativeAmount).toBe(last.json().totals.cumulativeGrossAmount);
    expect(last.json().totals.periodGrossAmount).toBe(1000);
  });

  it("ends the flow on a rejection, needs a reason, and restarts for the revision", async () => {
    const payId = await newPayment();
    await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    expect((await answer(office, payId, "rejected")).statusCode).toBe(400);
    const rej = await answer(office, payId, "rejected", "Metraj hatalı");
    expect(rej.statusCode, rej.body).toBe(200);
    expect(rej.json()).toMatchObject({ status: "rejected", decisionNote: "Metraj hatalı" });

    const rev = await app.inject({
      method: "POST",
      url: url(`/contracts/${contractId}/payments/${payId}/revise`),
      headers: { cookie: admin },
      payload: {},
    });
    expect(rev.statusCode, rev.body).toBe(201);
    const revId = rev.json().id as string;
    expect(rev.json().workflow).toBeNull();
    const sub = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${revId}/submit`), headers: { cookie: admin }, payload: {} });
    expect(sub.json().workflow).toMatchObject({ stepIndex: 0, status: "running" });

    const view = await app.inject({ method: "GET", url: url(`/contracts/${contractId}/payments/${revId}`), headers: { cookie: office } });
    expect(view.json().workflow.canAct).toBe(true);

    // The rejected original is history once a revision exists: it cannot be resubmitted or revised again.
    const again = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    expect(again.statusCode, again.body).toBe(409);
    const twice = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/revise`), headers: { cookie: admin }, payload: {} });
    expect(twice.statusCode, twice.body).toBe(409);
  });

  it("resubmits a rejected payment that has no revision, restarting its flow", async () => {
    const payId = await newPayment();
    await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    expect((await answer(office, payId, "rejected", "Eksik ataşman")).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().workflow).toMatchObject({ stepIndex: 0, status: "running" });
    const view = await app.inject({ method: "GET", url: url(`/contracts/${contractId}/payments/${payId}`), headers: { cookie: office } });
    expect(view.json().workflow.canAct).toBe(true);
  });

  it("keeps payments in order and takes previous quantities from the approved one", async () => {
    const p1 = await newPayment();
    const p2 = await newPayment(false);
    await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${p1}/submit`), headers: { cookie: admin }, payload: {} });
    // #2 waits while #1 is in review.
    const early = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${p2}/submit`), headers: { cookie: admin }, payload: {} });
    expect(early.statusCode, early.body).toBe(409);
    expect((await answer(office, p1, "approved")).statusCode).toBe(200);
    expect((await answer(consultant, p1, "approved")).json().status).toBe("approved");
    // #2 was created while #1 was open, so its previous quantity is refreshed at submit.
    const sub = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${p2}/submit`), headers: { cookie: admin }, payload: {} });
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().lines[0]).toMatchObject({ previousQuantity: 10, periodQuantity: 10, cumulativeQuantity: 20 });

    // The approved #1 fixes the item's price and the contract terms.
    const reprice = await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}/items/${itemId}`), headers: { cookie: admin }, payload: { unitPrice: 999 } });
    expect(reprice.statusCode, reprice.body).toBe(409);
    const rename = await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}/items/${itemId}`), headers: { cookie: admin }, payload: { description: "C30 Beton" } });
    expect(rename.statusCode, rename.body).toBe(200);
    expect((await app.inject({ method: "DELETE", url: url(`/contracts/${contractId}/items/${itemId}`), headers: { cookie: admin } })).statusCode).toBe(409);
    const terms = await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}`), headers: { cookie: admin }, payload: { terms: { retentionRatePct: 7 } } });
    expect(terms.statusCode, terms.body).toBe(409);
    const same = await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}`), headers: { cookie: admin }, payload: { title: "Yeni Ad", terms: {} } });
    expect(same.statusCode, same.body).toBe(200);

    // Status moves only forward from approved, and previous quantities are not typed in after #1.
    expect((await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}/payments/${p2}`), headers: { cookie: admin }, payload: { status: "approved" } })).statusCode).toBe(400);
    const invoiced = await app.inject({ method: "PATCH", url: url(`/contracts/${contractId}/payments/${p1}`), headers: { cookie: admin }, payload: { status: "invoiced", erpReference: "FT-2026-1" } });
    expect(invoiced.statusCode, invoiced.body).toBe(200);
    expect(invoiced.json()).toMatchObject({ status: "invoiced", erpReference: "FT-2026-1" });
    const p3 = await newPayment(false);
    const typed = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}/payments/${p3}`),
      headers: { cookie: admin },
      payload: { lines: [{ contractItemId: itemId, previousQuantity: 0, periodQuantity: 5 }] },
    });
    expect(typed.statusCode, typed.body).toBe(400);
  });

  it("reminds the step assignee before the due date, once", async () => {
    const payId = await newPayment();
    await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    const soon = new Date(Date.now() + 1.5 * 24 * 60 * 60 * 1000);
    const first = await runPaymentDueReminders(handle.db, soon);
    expect(first.dueSoon).toBeGreaterThanOrEqual(1);
    const second = await runPaymentDueReminders(handle.db, soon);
    expect(second.dueSoon).toBe(0);
    const rows = await handle.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, officeId), eq(notifications.kind, "contract.payment_due_soon")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the single admin approval when the contract has no flow, and cleans instances on delete", async () => {
    const payId = await newPayment();
    const off = await app.inject({
      method: "PATCH",
      url: url(`/contracts/${contractId}`),
      headers: { cookie: admin },
      payload: { approvalTemplateId: null },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().approvalTemplateId).toBeNull();
    const sub = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/submit`), headers: { cookie: admin }, payload: {} });
    expect(sub.json()).toMatchObject({ status: "submitted", workflow: null });
    const ok = await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${payId}/approve`), headers: { cookie: admin }, payload: {} });
    expect(ok.json().status).toBe("approved");
    // Approved financial history is kept.
    const blocked = await app.inject({ method: "DELETE", url: url(`/contracts/${contractId}`), headers: { cookie: admin } });
    expect(blocked.statusCode).toBe(409);

    const inReview = await newPayment();
    await app.inject({ method: "POST", url: url(`/contracts/${contractId}/payments/${inReview}/submit`), headers: { cookie: admin }, payload: {} });
    const running = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, inReview));
    expect(running).toHaveLength(1);
    const del = await app.inject({ method: "DELETE", url: url(`/contracts/${contractId}`), headers: { cookie: admin } });
    expect(del.statusCode).toBeLessThan(300);
    const left = await handle.db.select().from(workflowInstances).where(eq(workflowInstances.subjectId, inReview));
    expect(left).toHaveLength(0);
  });
});
