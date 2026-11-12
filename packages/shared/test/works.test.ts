import { describe, expect, it } from "vitest";
import {
  canEditWork,
  canSeeWork,
  checkNumberingPattern,
  checkWorkFieldDefs,
  asciiUpper,
  companyCodeProblem,
  companyNumberCode,
  normalizeCompanyCode,
  numberCode,
  numberingScope,
  tokenCode,
  renderWorkNumber,
  validateWorkFields,
  type WorkVisibilityInfo,
} from "../src/index.js";

const ctx = { projectCode: "PKF", typeKey: "giden-yazi", fromCompany: "Özgün İnşaat", toCompany: "İBB", date: new Date(2026, 9, 10) };

describe("work numbering", () => {
  it("renders patterns and keeps the counter out of the scope", () => {
    expect(renderWorkNumber("{Proje}-{Gönderen}-{Alıcı}-{YYYY}-{0000}", ctx, 7)).toBe("PKF-OZGUNINSAAT-IBB-2026-0007");
    expect(renderWorkNumber("{Tip}/{YY}{MM}/{000}", ctx, 12)).toBe("GIDEN-YAZI/2610/012");
    expect(numberingScope("{Proje}-{Gönderen}-{YYYY}-{0000}", ctx)).toBe("PKF-OZGUNINSAAT-2026-#");
    expect(numberCode(null)).toBe("X");
  });

  it("prefers company codes and falls back to names, then the project code", () => {
    const coded = { ...ctx, fromCode: "OZG", toCode: "IBB" };
    expect(renderWorkNumber("{Proje}-{Gönderen}-{Alıcı}-{0000}", coded, 1)).toBe("PKF-OZG-IBB-0001");
    expect(numberingScope("{Gönderen}_{Alıcı}_{000}", coded)).toBe("OZG_IBB_#");
    // Only the sender has a code: the receiver code comes from the name.
    expect(renderWorkNumber("{Gönderen}_{Alıcı}_{000}", { ...ctx, fromCode: "OZG" }, 3)).toBe("OZG_IBB_003");
    // No sender company: the project code, not "X"; no receiver: "X".
    const none = { ...ctx, fromCompany: null, toCompany: null };
    expect(renderWorkNumber("{Gönderen}_{Alıcı}_{000}", none, 1)).toBe("PKF_X_001");
    expect(renderWorkNumber("{Gönderen}_{000}", { ...none, projectCode: "M10-PKF" }, 1)).toBe("M10PKF_001");
    expect(companyNumberCode(null, "Hilal Müşavirlik")).toBe("HILALMUSAVIR");
    expect(companyNumberCode("hll", "Hilal Müşavirlik")).toBe("HLL");
  });

  it("folds Turkish upper case to ASCII in codes", () => {
    expect(asciiUpper("giden-yazı İçişleri şüğö")).toBe("GIDEN-YAZI ICISLERI SUGO");
    expect(asciiUpper("Café")).toBe("CAFE");
    expect(tokenCode("Mekanik Tesisat")).toBe("MEKANIKTESISAT");
    expect(normalizeCompanyCode(" İbb ")).toBe("IBB");
    expect(normalizeCompanyCode("  ")).toBeNull();
    expect(companyCodeProblem("PAS")).toBeNull();
    expect(companyCodeProblem("P")).not.toBeNull();
    expect(companyCodeProblem("ABCDEFGHI")).not.toBeNull();
    expect(companyCodeProblem("PA-S")).not.toBeNull();
  });

  it("validates patterns", () => {
    expect(checkNumberingPattern("{Proje}-{0000}")).toEqual([]);
    expect(checkNumberingPattern("{Proje}-{Firma}")).toHaveLength(2);
    expect(checkNumberingPattern("{00}-{000}")[0]).toContain("sıra no");
  });
});

describe("work fields", () => {
  const defs = [
    { key: "amac", label: "Amaç", type: "list" as const, options: ["bilgi", "onay"], required: true },
    { key: "tarih", label: "Tarih", type: "date" as const },
  ];
  it("checks values and definitions", () => {
    expect(validateWorkFields(defs, { amac: "onay", tarih: "2026-10-10" })).toEqual([]);
    expect(validateWorkFields(defs, {})).toEqual(['"Amaç" zorunlu.']);
    expect(validateWorkFields(defs, {}, true)).toEqual([]);
    expect(validateWorkFields(defs, { amac: "x", tarih: "10.10.2026", yok: 1 })).toHaveLength(3);
    expect(checkWorkFieldDefs([...defs, { key: "amac", label: "", type: "list" }])).toHaveLength(3);
  });
});

describe("work visibility", () => {
  const w: WorkVisibilityInfo = {
    status: "taslak",
    createdBy: "u1",
    assigneeUserId: null,
    ownerCompanyId: "PAS",
    fromCompanyId: "PAS",
    toCompanyIds: ["CNS"],
    ccCompanyIds: ["ZRT"],
  };
  const v = (companyId: string | null, isProjectAdmin = false, userId = "u9") => ({ userId, companyId, isProjectAdmin });
  it("hides drafts from addressees and lets admins see all", () => {
    expect(canSeeWork(w, v("PAS"))).toBe(true);
    expect(canSeeWork(w, v("CNS"))).toBe(false);
    expect(canSeeWork({ ...w, status: "gonderildi" }, v("CNS"))).toBe(true);
    expect(canSeeWork({ ...w, status: "gonderildi" }, v("ZRT"))).toBe(true);
    expect(canSeeWork({ ...w, status: "gonderildi" }, v("HLL"))).toBe(false);
    expect(canSeeWork(w, v("HLL", true))).toBe(true);
    expect(canSeeWork(w, v(null, false, "u1"))).toBe(true);
    expect(canEditWork({ ...w, status: "gonderildi" }, v("CNS"))).toBe(false);
    expect(canEditWork(w, v("PAS"))).toBe(true);
  });
});
