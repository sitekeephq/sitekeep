/** Değişiklik Talebi helpers (Coordinate's shared file): settings, ownership, codes and value text. */
import { describe, expect, it } from "vitest";
import { paramChangeCode, paramChangeDefaultOwnership, paramChangeLostMessage, paramValueText, resolveParamChangeSettings } from "@7dimensions-project/sitekeep-ee-coordinate/shared/param-change.js";

describe("Değişiklik Talebi helpers", () => {
  it("defaults: approval on, no approver role", () => {
    expect(resolveParamChangeSettings(undefined)).toEqual({ approvalRequired: true, approverRoleId: null });
    expect(resolveParamChangeSettings({ approvalRequired: false, approverRoleId: "r1" })).toEqual({ approvalRequired: false, approverRoleId: "r1" });
  });

  it("ownership: only new properties are CDE enrichment; no signal → Revit", () => {
    expect(paramChangeDefaultOwnership([{ source: "missing", unchanged: false }])).toBe("cde_only");
    expect(paramChangeDefaultOwnership([{ source: "missing", unchanged: false }, { source: "instance", unchanged: false }])).toBe("revit");
    expect(paramChangeDefaultOwnership([{ source: "instance", unchanged: true }, { source: "missing", unchanged: false }])).toBe("cde_only");
    expect(paramChangeDefaultOwnership([])).toBe("revit");
  });

  it("codes, messages and values read well", () => {
    expect(paramChangeCode(7)).toBe("PD-007");
    expect(paramChangeLostMessage("Kapı yangın dayanımı", 3)).toBe("Önceki parametre değişikliği bu versiyonda yok: Kapı yangın dayanımı (3 eleman)");
    expect([paramValueText(true), paramValueText(null), paramValueText(2.5)]).toEqual(["Evet", "—", "2,5"]);
  });
});
