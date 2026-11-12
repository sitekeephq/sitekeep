import { describe, expect, it } from "vitest";
import { PARAM_CHANGE_OWNERSHIP_LABELS_TR, PARAM_CHANGE_STATUS_LABELS_TR, guessNewRecord, isTitleCaseTr, moduleOfNewRecordKind } from "../src/index.js";

describe("Değişiklik Talebi helpers", () => {
  it("labels are Turkish Title Case", () => {
    for (const v of [...Object.values(PARAM_CHANGE_STATUS_LABELS_TR), ...Object.values(PARAM_CHANGE_OWNERSHIP_LABELS_TR)]) expect(isTitleCaseTr(v), v).toBe(true);
  });

  it('"+ Yeni" knows Parametre Değişikliği (Koordinasyon module)', () => {
    expect(guessNewRecord("Kapılar için parametre değişikliği aç", []).kind).toBe("param-change");
    expect(moduleOfNewRecordKind("param-change")).toBe("coordination");
  });
});
