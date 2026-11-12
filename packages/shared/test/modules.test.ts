import { describe, expect, it } from "vitest";
import {
  ISO19650_DEFAULT_MODULES,
  PROJECT_MODULES,
  PROJECT_MODULE_LABELS_TR,
  isTitleCaseTr,
  moduleOfReportModule,
  moduleOfWorkCategory,
  moduleOffMessage,
  reportModuleEnabled,
  resolveModules,
} from "../src/index.js";

describe("project modules", () => {
  it("every module is on unless stored as false (existing projects keep everything)", () => {
    expect(Object.values(resolveModules(null)).every(Boolean)).toBe(true);
    expect(Object.values(resolveModules({})).every(Boolean)).toBe(true);
    const m = resolveModules({ issues: false, forms: true, unknown: false });
    expect(m.issues).toBe(false);
    expect(m.forms).toBe(true);
    expect(Object.keys(m).sort()).toEqual([...PROJECT_MODULES].sort());
  });

  it("maps work categories and report families to modules", () => {
    expect(moduleOfWorkCategory("correspondence")).toBe("correspondence");
    expect(moduleOfWorkCategory("submittal_package")).toBe("submittals");
    expect(moduleOfWorkCategory("action")).toBe("meetings");
    expect(moduleOfWorkCategory("generic")).toBeNull();
    expect(moduleOfReportModule("meetings")).toBe("meetings");
    expect(moduleOfReportModule("documents")).toBeNull();
    const m = resolveModules({ issues: false });
    expect(reportModuleEnabled(m, "issues")).toBe(false);
    expect(reportModuleEnabled(m, "documents")).toBe(true);
    expect(reportModuleEnabled(resolveModules({ reports: false }), "documents")).toBe(false);
  });

  it("ISO 19650 template default: documents, reviews, issues, correspondence and reports", () => {
    expect(PROJECT_MODULES.filter((m) => ISO19650_DEFAULT_MODULES[m])).toEqual(["correspondence", "issues", "reviews", "reports"]);
  });

  it("labels are Title Case; the refusal names the module in Turkish", () => {
    for (const m of PROJECT_MODULES) expect(isTitleCaseTr(PROJECT_MODULE_LABELS_TR[m])).toBe(true);
    expect(moduleOffMessage("submittals")).toMatch(/^Teknik Onay modülü bu projede kapalı/);
  });
});
