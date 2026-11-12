import { describe, expect, it } from "vitest";
import {
  checkStandard,
  effectivePermission,
  isDowngrade,
  validateName,
  type Grant,
  type NamingStandard,
} from "../src/index.js";

const zavm: NamingStandard = {
  name: "Data Center Kodlama Sistemi",
  delimiter: "-",
  fields: [
    { name: "Proje", type: "list", values: [{ code: "ZAVM" }] },
    { name: "Firma", type: "list", values: [{ code: "PAS" }, { code: "CNS" }, { code: "HLL" }, { code: "ZRT" }] },
    { name: "Hacim", type: "list", values: [{ code: "ZZ" }, { code: "XX" }] },
    { name: "Rol", type: "list", values: [{ code: "A" }, { code: "S" }, { code: "M" }, { code: "E" }] },
    { name: "Kat", type: "list", values: [{ code: "B1" }, { code: "00" }, { code: "01" }] },
    { name: "Alt Disiplin", type: "number", digits: 4 },
    { name: "Tip", type: "list", values: [{ code: "RP" }, { code: "DR" }, { code: "M3" }] },
    { name: "Aşama", type: "list", values: [{ code: "MC" }, { code: "CD" }] },
    { name: "Numara", type: "number", digits: 4 },
  ],
};

describe("naming", () => {
  it("accepts a valid name", () => {
    const r = validateName(zavm, "ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001.pdf");
    expect(r.ok).toBe(true);
    expect(r.baseName).toBe("ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001");
  });

  it("reports each wrong field", () => {
    const r = validateName(zavm, "ZAVM-XYZ-ZZ-S-B1-204-RP-MC-0001.ifc");
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      'Firma: "XYZ" izinli değerlerden biri değil',
      "Alt Disiplin: 4 haneli sayı olmalı",
    ]);
  });

  it("rejects missing and extra fields", () => {
    expect(validateName(zavm, "ZAVM-PAS.ifc").ok).toBe(false);
    expect(validateName(zavm, "ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001-EK.pdf").ok).toBe(false);
  });

  it("allows a suffix only when enabled", () => {
    const withSuffix = { ...zavm, allowSuffix: true };
    expect(validateName(withSuffix, "ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001 Temel.pdf").ok).toBe(true);
    expect(validateName(zavm, "ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001 Temel.pdf").ok).toBe(false);
  });

  it("checks the standard itself", () => {
    expect(checkStandard(zavm)).toEqual([]);
    expect(
      checkStandard({ name: " ", delimiter: "-", fields: [{ name: "A", type: "list", values: [{ code: "A-B" }] }] }),
    ).toEqual(["Standart adı boş.", '"A" alanındaki "A-B" kodu ayraç içeriyor.']);
    expect(checkStandard({ ...zavm, delimiter: "--" })).toEqual(["Ayraç tek karakter olmalı."]);
  });
});

describe("permissions", () => {
  const ancestry = ["root", "design", "shared"];
  const grants: Grant[] = [
    { folderId: "root", subjectType: "company", subjectId: "poyraz", level: "view" },
    { folderId: "design", subjectType: "user", subjectId: "murat", level: "edit" },
    { folderId: "shared", subjectType: "role", subjectId: "bim", level: "manage" },
    { folderId: "other", subjectType: "user", subjectId: "murat", level: "manage" },
  ];

  it("inherits down and takes the highest grant", () => {
    expect(effectivePermission({ userId: "murat", companyId: "poyraz" }, ancestry, grants).level).toBe("edit");
    expect(effectivePermission({ userId: "ali", companyId: "poyraz" }, ancestry, grants).level).toBe("view");
    expect(effectivePermission({ userId: "ali", roleIds: ["bim"] }, ancestry, grants).level).toBe("manage");
    expect(effectivePermission({ userId: "ali" }, ancestry, grants).level).toBe("none");
  });

  it("ignores grants outside the folder chain", () => {
    expect(effectivePermission({ userId: "murat" }, ["root"], grants).level).toBe("none");
  });

  it("gives project admins manage", () => {
    expect(effectivePermission({ userId: "x", projectAdmin: true }, ancestry, []).level).toBe("manage");
  });

  it("keeps view level and adds upload for upload_only", () => {
    const g: Grant[] = [
      { folderId: "root", subjectType: "user", subjectId: "u", level: "view_download" },
      { folderId: "design", subjectType: "user", subjectId: "u", level: "upload_only" },
    ];
    expect(effectivePermission({ userId: "u" }, ancestry, g)).toEqual({ level: "view_download", canUpload: true });
    expect(effectivePermission({ userId: "u" }, ["design"], g)).toEqual({ level: "upload_only", canUpload: true });
  });

  it("detects downgrades", () => {
    expect(isDowngrade("edit", "view")).toBe(true);
    expect(isDowngrade("view", "manage")).toBe(false);
    expect(isDowngrade("none", "view")).toBe(false);
    expect(isDowngrade("view", "upload_only")).toBe(true);
  });
});
