/** ISO19650-2 5.1.7(d) audit: texts of audit rows and the query of the audit API (docs/features/AUDIT_LOG.md). */
import { describe, expect, it } from "vitest";
import { auditQuery } from "../../src/shared/api/api-audit";
import { auditActionLabel, auditSummary } from "../../src/shared/lib/audit";

describe("ISO19650-2 5.1.7(d) audit labels", () => {
  it("labels known actions in Turkish and shows unknown ones as they are", () => {
    expect(auditActionLabel("file.viewed")).toBe("Dosya görüntülendi");
    expect(auditActionLabel("cde.transition")).toBe("Durum değişti");
    expect(auditActionLabel("x.unknown")).toBe("x.unknown");
  });

  it("labels the delivery plan events (ISO-7)", () => {
    expect(auditActionLabel("delivery_plan.deliverable_created")).toBe("Planlanan teslim eklendi");
    expect(auditActionLabel("delivery_plan.imported")).toBe("Teslim planı içe aktarıldı");
    expect(auditSummary({ action: "delivery_plan.deliverable_updated", details: { code: "P-A-0001", title: "Plan", changed: ["dueShared"] } })).toBe("title: Plan");
  });

  it("summarises transitions, views and other details", () => {
    expect(auditSummary({ action: "cde.transition", targetName: "A.pdf", details: { fromState: "wip", toState: "shared", mode: "direct" } })).toBe(
      "A.pdf · Çalışma → Paylaşılan · Doğrudan",
    );
    expect(auditSummary({ action: "file.viewed", targetName: "A.pdf", details: { versionId: "v", kind: "pdf" } })).toBe("A.pdf · PDF görüntüleyici");
    expect(auditSummary({ action: "file.downloaded", targetName: "A.pdf", details: { version: 2 } })).toBe("A.pdf · version: 2");
    expect(auditSummary({ action: "member.added", details: null })).toBe("");
  });

  it("summarises supersession links: superseded by and supersedes (ISO-12)", () => {
    const pub = { fileId: "p", versionId: "pv", name: "A.pdf", version: 2, revisionCode: "C02", folderId: "f" };
    expect(auditSummary({ action: "cde.superseded", details: { name: "A.pdf", version: 1, supersededBy: pub } })).toBe("A.pdf · version: 1 · yerini alan: A.pdf V2 · C02");
    expect(
      auditSummary({ action: "review.file_copied", targetName: "A.pdf", details: { name: "A.pdf", version: 2, supersedes: [{ ...pub, version: 1, revisionCode: "C01" }] } }),
    ).toBe("A.pdf · version: 2 · yerini aldığı: A.pdf V1 · C01");
    // Without links: the usual summary.
    expect(auditSummary({ action: "cde.superseded", details: { name: "A.pdf", version: 1 } })).toBe("name: A.pdf · version: 1");
  });

  it("builds the query without empty filters", () => {
    expect(auditQuery({ action: "file.*", userId: "", from: "2026-11-01" }, { cursor: 42, limit: 50 })).toBe("action=file.*&from=2026-11-01&cursor=42&limit=50");
  });
});
