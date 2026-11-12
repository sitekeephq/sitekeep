import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../../src/app/build-app.js";
import { hashPassword } from "../../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../../src/db/index.js";
import { eq } from "drizzle-orm";
import {
  auditLog,
  notifications,
  projectMembers,
  projects,
  users,
} from "../../../../src/db/schema.js";
import { contractItems, costItems, progressPayments } from "@7dimensions-project/sitekeep-ee-cost/internal/schema/index.js";
import { runGuaranteeReminders } from "@7dimensions-project/sitekeep-ee-cost/internal/contracts/reminders.js";
import { JobQueue } from "../../../../src/jobs/queue.js";
import { LocalStorage } from "../../../../src/core/platform/storage.js";

const PW = "Sifre-1234567";

describe("contracts & progress payments API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;
  let cookie: string;
  let projectId: string;
  let contractId: string;
  let itemAId: string;
  let itemBId: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "7dcde-contracts-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });

    const [admin] = await handle.db
      .insert(users)
      .values({ email: "admin@contracts.test", name: "Yönetici", passwordHash: await hashPassword(PW), isAdmin: true })
      .returning();

    const [proj] = await handle.db
      .insert(projects)
      .values({ code: "SZL-01", name: "Sözleşme Test Projesi", createdBy: admin!.id })
      .returning();
    projectId = proj!.id;

    await handle.db.insert(projectMembers).values({
      projectId,
      userId: admin!.id,
      isProjectAdmin: true,
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@contracts.test", password: PW },
    });
    cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a contract with financial terms and guarantees", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts`,
      headers: { cookie },
      payload: {
        code: "IK-2026-01",
        title: "Ana Kaba İnşaat Yapım İşi",
        type: "unit_price",
        status: "active",
        employerName: "7Dimensions Yatırım A.Ş.",
        contractorName: "Örnek Yapı Müteahhitlik A.Ş.",
        currency: "TRY",
        signedDate: "2026-01-15",
        siteHandoverDate: "2026-01-20",
        completionDate: "2026-12-31",
        terms: {
          advanceRatePct: 10,
          advanceDeductionPct: 10,
          retentionRatePct: 5,
          withholdingTaxPct: 0,
          stampTaxPct: 1,
          vatRatePct: 20,
          vatWithholdingTenths: 4,
          maxIncreasePct: 20,
          dailyPenaltyPct: 0.03,
        },
        guarantees: [
          {
            kind: "performance_bond",
            issuer: "Örnek Banka",
            referenceNo: "TM-99881",
            amount: 500_000,
            currency: "TRY",
            expiresAt: "2027-06-30",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBe("IK-2026-01");
    expect(body.guarantees).toHaveLength(1);
    expect(body.terms.vatWithholdingTenths).toBe(4);
    contractId = body.id;
  });

  it("adds unit price items and imports 5D cost items", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/items`,
      headers: { cookie },
      payload: {
        code: "15.150.1005",
        pozCode: "15.150.1005",
        description: "C30/37 Hazır Beton Dökülmesi",
        category: "Betonarme",
        unit: "m3",
        unitPrice: 2_500,
        contractQuantity: 1_000,
      },
    });
    expect(r1.statusCode).toBe(201);
    itemAId = r1.json().items[0].id;

    // Seed a 5D cost item and import it into the contract
    await handle.db.insert(costItems).values({
      projectId,
      code: "15.160.1001",
      pozCode: "15.160.1001",
      description: "Nervürlü Çelik Donatı (B420C)",
      category: "Betonarme",
      unit: "ton",
      unitPrice: 30_000,
      currency: "TRY",
    });

    const imp = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/items/import-5d`,
      headers: { cookie },
    });
    expect(imp.statusCode).toBe(200);
    const items = imp.json().items;
    expect(items).toHaveLength(2);
    const steel = items.find((i: { code: string }) => i.code === "15.160.1001");
    expect(steel).toBeTruthy();
    itemBId = steel.id;

    // Update steel contractQuantity to 100 ton
    const upd = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/items/${itemBId}`,
      headers: { cookie },
      payload: { contractQuantity: 100 },
    });
    expect(upd.statusCode).toBe(200);
    // Initial amount = 1000 * 2500 + 100 * 30000 = 2_500_000 + 3_000_000 = 5_500_000
    expect(upd.json().currentAmount).toBe(5_500_000);
  });

  it("creates and approves a contract variation (zeyilname) updating revised quantities and completion date", async () => {
    const vRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/variations`,
      headers: { cookie },
      payload: {
        title: "Zeyilname #1 — Ek Beton İmalatı ve Süre Uzatımı",
        timeExtensionDays: 30,
        effectiveDate: "2026-03-01",
        items: [
          {
            contractItemId: itemAId,
            code: "15.150.1005",
            description: "C30/37 Hazır Beton Dökülmesi",
            unit: "m3",
            unitPrice: 2_500,
            quantityDelta: 200,
          },
        ],
      },
    });
    expect(vRes.statusCode).toBe(201);
    const vid = vRes.json().variations[0].id;

    const appRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/variations/${vid}/decide`,
      headers: { cookie },
      payload: { approve: true },
    });
    expect(appRes.statusCode).toBe(200);
    const detail = appRes.json();
    expect(detail.variationAmount).toBe(500_000);
    expect(detail.currentAmount).toBe(6_000_000);
    expect(detail.timeExtensionDays).toBe(30);
    expect(detail.revisedCompletionDate).toBe("2027-01-30");
    const itemA = detail.items.find((i: { id: string }) => i.id === itemAId);
    expect(itemA.revisedQuantity).toBe(1_200);
  });

  it("creates Hakediş #1 and #2 with cumulative carryover, approval workflow and exports PDF & XLSX", async () => {
    // Hakediş #1
    const p1Res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments`,
      headers: { cookie },
      payload: {
        periodStart: "2026-01-20",
        periodEnd: "2026-02-28",
        priceDifferenceAmount: 50_000,
      },
    });
    expect(p1Res.statusCode).toBe(201);
    const p1Id = p1Res.json().id;

    // Enter period quantities for Hakediş #1: 300 m3 concrete, 20 ton steel
    const patch1 = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}`,
      headers: { cookie },
      payload: {
        lines: [
          { contractItemId: itemAId, periodQuantity: 300, sourceNote: "A Blok Temel" },
          { contractItemId: itemBId, periodQuantity: 20, sourceNote: "A Blok Temel Donatısı" },
        ],
      },
    });
    expect(patch1.statusCode).toBe(200);
    const d1 = patch1.json();
    // 300*2500 + 20*30000 = 750_000 + 600_000 = 1_350_000
    expect(d1.totals.periodGrossAmount).toBe(1_350_000);
    expect(d1.totals.periodSubTotal).toBe(1_400_000);

    // Submit & Approve Hakediş #1
    const sub1 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/submit`,
      headers: { cookie },
    });
    expect(sub1.statusCode).toBe(200);
    expect(sub1.json().status).toBe("submitted");

    const app1 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/approve`,
      headers: { cookie },
      payload: { decisionNote: "Kontrol mühendisi ve idare onayı tamamlandı." },
    });
    expect(app1.statusCode).toBe(200);
    expect(app1.json().status).toBe("approved");

    // Create Hakediş #2 — previousQuantity must automatically carry over 300 and 20!
    const p2Res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments`,
      headers: { cookie },
      payload: {
        periodEnd: "2026-03-31",
      },
    });
    expect(p2Res.statusCode).toBe(201);
    const p2 = p2Res.json();
    expect(p2.number).toBe(2);
    expect(p2.periodStart).toBe("2026-02-28");
    const lineA2 = p2.lines.find((l: { contractItemId: string }) => l.contractItemId === itemAId);
    expect(lineA2.previousQuantity).toBe(300);

    // Export XLSX and PDF for Hakediş #1
    const xlsxRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/export?format=xlsx`,
      headers: { cookie },
    });
    expect(xlsxRes.statusCode).toBe(200);
    expect(xlsxRes.rawPayload.subarray(0, 2).toString("utf8")).toBe("PK");

    const pdfRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/export?format=pdf`,
      headers: { cookie },
    });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.rawPayload.subarray(0, 4).toString("utf8")).toBe("%PDF");

    // An approved payment is locked: no edits, no 5D fill, no second approval.
    const locked = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}`,
      headers: { cookie },
      payload: { lines: [{ contractItemId: itemAId, periodQuantity: 999 }] },
    });
    expect(locked.statusCode).toBe(400);
    const lockedFill = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/fill-from-5d`,
      headers: { cookie },
    });
    expect(lockedFill.statusCode).toBe(400);
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p1Id}/approve`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(400);

    const contract = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    expect(contract.json().approvedCumulativeAmount).toBe(1_350_000);
    expect(contract.json().approvedProgressPct).toBe(22.5);
  });

  it("rejects a submitted payment, which can then be edited and resubmitted", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    const p2Id = list.json().payments.find((p: { number: number }) => p.number === 2).id;
    const base = `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p2Id}`;

    // Approving a draft is not allowed; it has to be submitted first.
    expect((await app.inject({ method: "POST", url: `${base}/approve`, headers: { cookie } })).statusCode).toBe(400);

    const edit = await app.inject({
      method: "PATCH",
      url: base,
      headers: { cookie },
      payload: {
        penaltyDeduction: 1_000,
        lines: [{ contractItemId: itemAId, periodQuantity: 950, sourceNote: "B Blok" }],
      },
    });
    expect(edit.statusCode).toBe(200);
    const lineA = edit.json().lines.find((l: { contractItemId: string }) => l.contractItemId === itemAId);
    // 300 previous + 950 period = 1250 > revised 1200
    expect(lineA.cumulativeQuantity).toBe(1_250);
    expect(lineA.overContractQuantity).toBe(true);
    expect(edit.json().overQuantityLineCount).toBe(1);
    expect(edit.json().totals.penaltyDeduction).toBe(1_000);

    expect((await app.inject({ method: "POST", url: `${base}/submit`, headers: { cookie } })).statusCode).toBe(200);
    const rejected = await app.inject({
      method: "POST",
      url: `${base}/reject`,
      headers: { cookie },
      payload: { decisionNote: "B Blok metrajı ataşmanla uyuşmuyor." },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("rejected");
    expect(rejected.json().decisionNote).toBe("B Blok metrajı ataşmanla uyuşmuyor.");

    const fixed = await app.inject({
      method: "PATCH",
      url: base,
      headers: { cookie },
      payload: { lines: [{ contractItemId: itemAId, periodQuantity: 400 }] },
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().overQuantityLineCount).toBe(0);
    expect((await app.inject({ method: "POST", url: `${base}/submit`, headers: { cookie } })).json().status).toBe(
      "submitted",
    );

    // Rejected payments do not count toward the approved cumulative.
    const contract = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    expect(contract.json().approvedCumulativeAmount).toBe(1_350_000);

    const actions = (await handle.db.select().from(auditLog).where(eq(auditLog.targetId, p2Id))).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["contract.payment_created", "contract.payment_submitted", "contract.payment_rejected"]),
    );
  });

  it("reports when the 5D model has no take-off for the contract items", async () => {
    const p3 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments`,
      headers: { cookie },
      payload: { periodEnd: "2026-04-30" },
    });
    expect(p3.statusCode).toBe(201);
    const fill = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/payments/${p3.json().id}/fill-from-5d`,
      headers: { cookie },
    });
    // No IFC model in this project: either nothing matches or every matched quantity is zero.
    if (fill.statusCode === 200) {
      for (const l of fill.json().lines) expect(l.periodQuantity).toBe(0);
    } else {
      expect(fill.statusCode).toBe(400);
    }
  });

  it("rejects a variation without touching amounts, and refuses to decide it twice", async () => {
    const v = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/variations`,
      headers: { cookie },
      payload: {
        title: "Zeyilname #2 — Ek Çatı İzolasyonu",
        timeExtensionDays: 15,
        items: [{ code: "YENI-01", description: "Çatı İzolasyonu", unit: "m2", unitPrice: 400, quantityDelta: 500 }],
      },
    });
    expect(v.statusCode).toBe(201);
    const created = v.json().variations.find((x: { number: number }) => x.number === 2);
    expect(created.status).toBe("pending");
    expect(created.amountDelta).toBe(200_000);

    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/variations/${created.id}/decide`;
    const rej = await app.inject({ method: "POST", url, headers: { cookie }, payload: { approve: false } });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().currentAmount).toBe(6_000_000);
    expect(rej.json().timeExtensionDays).toBe(30);
    expect(rej.json().items.some((i: { code: string }) => i.code === "YENI-01")).toBe(false);

    const twice = await app.inject({ method: "POST", url, headers: { cookie }, payload: { approve: true } });
    expect(twice.statusCode).toBe(400);
  });

  it("links a subcontract item to the main poz, deducts SGK and copies a rejected payment as a new revision", async () => {
    const main = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    const mainItem = main.json().items[0];
    const sub = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts`,
      headers: { cookie },
      payload: {
        code: "ALT-01",
        title: "Kalıp Alt Yüklenici",
        type: "subcontract",
        employerName: "Ana Yüklenici",
        contractorName: "Alt Yüklenici",
        parentContractId: contractId,
        consultantName: "Kontrol Müşavirliği",
        responsibleName: "Şantiye Şefi",
        terms: { sgkDeductionPct: 2, advanceDeductionPct: 0, retentionRatePct: 0, stampTaxPct: 0, vatRatePct: 0, vatWithholdingTenths: 0 },
      },
    });
    expect(sub.statusCode).toBe(201);
    const subId = sub.json().id as string;
    expect(sub.json().consultantName).toBe("Kontrol Müşavirliği");

    const item = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${subId}/items`,
      headers: { cookie },
      payload: {
        code: "KLP-01",
        description: "Kalıp",
        unit: "m2",
        unitPrice: 100,
        contractQuantity: 10,
        weightPct: 40,
        activityCode: "A-12",
        parentItemId: mainItem.id,
      },
    });
    expect(item.statusCode).toBe(201);
    const linked = item.json().items.find((i: { code: string }) => i.code === "KLP-01");
    expect(linked.parentCode).toBe(mainItem.code);
    expect(linked.unitMargin).toBe(mainItem.unitPrice - 100);
    expect(linked.marginAmount).toBe((mainItem.unitPrice - 100) * 10);
    expect(linked.weightPct).toBe(40);
    expect(linked.activityCode).toBe("A-12");

    const unknownFile = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${subId}`,
      headers: { cookie },
      payload: { fileIds: ["00000000-0000-4000-8000-000000000000"] },
    });
    expect(unknownFile.statusCode).toBe(400);

    const pay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${subId}/payments`,
      headers: { cookie },
      payload: { periodEnd: "2026-04-30" },
    });
    expect(pay.statusCode).toBe(201);
    const payId = pay.json().id as string;
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${subId}/payments/${payId}`,
      headers: { cookie },
      payload: {
        lines: [{ contractItemId: linked.id, periodQuantity: 10, objectionNote: "Ataşman eksik" }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().totals.sgkDeduction).toBe(20);
    expect(saved.json().totals.netPayableAmount).toBe(980);
    expect(saved.json().lines[0].objectionNote).toBe("Ataşman eksik");
    expect(saved.json().revision).toBe(1);

    expect((await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/contracts/${subId}/payments/${payId}/submit`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/contracts/${subId}/payments/${payId}/reject`, headers: { cookie }, payload: {} })).statusCode).toBe(200);

    const revised = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${subId}/payments/${payId}/revise`,
      headers: { cookie },
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().number).toBe(1);
    expect(revised.json().revision).toBe(2);
    expect(revised.json().status).toBe("draft");
    expect(revised.json().lines[0].periodQuantity).toBe(10);
    expect(revised.json().lines[0].objectionNote).toBe("Ataşman eksik");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${subId}/payments/${revised.json().id}/revise`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(400);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/contracts/${subId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
  });

  it("notifies project admins once when a guarantee is about to expire", async () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const expiresAt = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts`,
      headers: { cookie },
      payload: {
        code: "TEM-01",
        title: "Teminat Hatırlatma",
        employerName: "İdare",
        contractorName: "Yüklenici",
        guarantees: [{ kind: "performance_bond", issuer: "Örnek Banka", amount: 1000, expiresAt }],
      },
    });
    expect(created.statusCode).toBe(201);
    const first = await runGuaranteeReminders(handle.db, new Date());
    expect(first.dueSoon).toBe(1);
    const notes = await handle.db.select().from(notifications).where(eq(notifications.kind, "contract.guarantee_due_soon"));
    expect(notes.length).toBeGreaterThan(0);
    const second = await runGuaranteeReminders(handle.db, new Date());
    expect(second.dueSoon).toBe(0);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/contracts/${created.json().id}`,
      headers: { cookie },
    });
  });

  it("refuses duplicate contract and item codes", async () => {
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts`,
      headers: { cookie },
      payload: { code: "IK-2026-01", title: "Kopya", employerName: "A", contractorName: "B" },
    });
    expect(dup.statusCode).toBe(409);
    const dupItem = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/items`,
      headers: { cookie },
      payload: { code: "15.150.1005", description: "Kopya", unit: "m3", unitPrice: 1, contractQuantity: 1 },
    });
    expect(dupItem.statusCode).toBe(409);
  });

  it("lets a regular member read but not change contracts; outsiders see nothing", async () => {
    const [member] = await handle.db
      .insert(users)
      .values({ email: "member@contracts.test", name: "Üye", passwordHash: await hashPassword(PW) })
      .returning();
    await handle.db.insert(projectMembers).values({ projectId, userId: member!.id, isProjectAdmin: false });
    await handle.db
      .insert(users)
      .values({ email: "outsider@contracts.test", name: "Dışarıdan", passwordHash: await hashPassword(PW) });

    const loginAs = async (email: string) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
      return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
    };
    const memberCookie = await loginAs("member@contracts.test");
    const outsiderCookie = await loginAs("outsider@contracts.test");
    const base = `/api/v1/projects/${projectId}/contracts`;

    const list = await app.inject({ method: "GET", url: base, headers: { cookie: memberCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const writes = [
      { method: "POST" as const, url: base, payload: { code: "X", title: "X", employerName: "A", contractorName: "B" } },
      { method: "PATCH" as const, url: `${base}/${contractId}`, payload: { title: "Değişti" } },
      { method: "DELETE" as const, url: `${base}/${contractId}` },
      { method: "POST" as const, url: `${base}/${contractId}/payments`, payload: { periodEnd: "2026-05-31" } },
    ];
    for (const w of writes) {
      const res = await app.inject({ ...w, headers: { cookie: memberCookie } });
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(403);
    }

    const outsider = await app.inject({ method: "GET", url: `${base}/${contractId}`, headers: { cookie: outsiderCookie } });
    expect([403, 404]).toContain(outsider.statusCode);

    const anonymous = await app.inject({ method: "GET", url: base });
    expect(anonymous.statusCode).toBe(401);
  });

  it("keeps a contract with approved payments and deletes one without, with its items and payments", async () => {
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("Onaylanmış hakedişi olan sözleşme silinemez");

    const base = `/api/v1/projects/${projectId}/contracts`;
    const made = await app.inject({
      method: "POST",
      url: base,
      headers: { cookie },
      payload: { code: "SIL-01", title: "Silinecek", employerName: "İdare", contractorName: "Yüklenici" },
    });
    const draftId = made.json().id as string;
    await app.inject({ method: "POST", url: `${base}/${draftId}/items`, headers: { cookie }, payload: { code: "X-1", description: "Kalem", unit: "m2", unitPrice: 10 } });
    expect((await app.inject({ method: "POST", url: `${base}/${draftId}/payments`, headers: { cookie }, payload: { periodEnd: "2026-05-31" } })).statusCode).toBe(201);
    const del = await app.inject({ method: "DELETE", url: `${base}/${draftId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const contractIdBefore = contractId;
    contractId = draftId;
    // A cancelled contract can be removed with its approved history; the audit log keeps the record.
    await app.inject({ method: "PATCH", url: `${base}/${contractIdBefore}`, headers: { cookie }, payload: { status: "cancelled" } });
    expect((await app.inject({ method: "DELETE", url: `${base}/${contractIdBefore}`, headers: { cookie } })).statusCode).toBe(200);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
    expect(await handle.db.select().from(progressPayments).where(eq(progressPayments.contractId, contractId))).toHaveLength(0);
    expect(await handle.db.select().from(contractItems).where(eq(contractItems.contractId, contractId))).toHaveLength(0);
    expect(await handle.db.select().from(progressPayments).where(eq(progressPayments.contractId, contractIdBefore))).toHaveLength(0);
  });
});
