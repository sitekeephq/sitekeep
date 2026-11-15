/** ISO19650-2 5.1.7 audit: texts of audit rows and the query of the audit API (docs/features/AUDIT_LOG.md). */
import { describe, expect, it } from "vitest";
import { auditQuery } from "../../src/shared/api/api-audit";
import { auditActionLabel, auditSummary } from "../../src/shared/lib/audit";

describe("ISO19650-2 5.1.7 audit labels", () => {
  it("labels known actions in Turkish and shows unknown ones as they are", () => {
    expect(auditActionLabel("file.viewed")).toBe("Dosya görüntülendi");
    expect(auditActionLabel("cde.transition")).toBe("Durum değişti");
    expect(auditActionLabel("x.unknown")).toBe("x.unknown");
  });

  it("summarises transitions, views and other details", () => {
    expect(auditSummary({ action: "cde.transition", targetName: "A.pdf", details: { fromState: "wip", toState: "shared", mode: "direct" } })).toBe(
      "A.pdf · Çalışma → Paylaşılan · Doğrudan",
    );
    expect(auditSummary({ action: "file.viewed", targetName: "A.pdf", details: { versionId: "v", kind: "pdf" } })).toBe("A.pdf · PDF görüntüleyici");
    expect(auditSummary({ action: "file.downloaded", targetName: "A.pdf", details: { version: 2 } })).toBe("A.pdf · version: 2");
    expect(auditSummary({ action: "member.added", details: null })).toBe("");
  });

  it("builds the query without empty filters", () => {
    expect(auditQuery({ action: "file.*", userId: "", from: "2026-11-01" }, { cursor: 42, limit: 50 })).toBe("action=file.*&from=2026-11-01&cursor=42&limit=50");
  });
});
