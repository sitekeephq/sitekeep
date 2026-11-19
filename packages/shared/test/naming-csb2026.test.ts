// ÇŞB 2026 (EK-2) file naming profile (docs/features/NAMING_CSB_2026.md) and the naming engine
// extensions it needs: maximum length, dependent lists, text character sets and suggestions,
// fixed values with tokens, fields outside the document code.
import { describe, expect, it } from "vitest";
import {
  CSB_2026_EK2,
  CSB_2026_STANDARD_NAME,
  applySetupOverrides,
  checkSetupDetails,
  checkStandard,
  csb2026NamingStandard,
  keepNamingFieldSettings,
  namingUsesToken,
  parseName,
  resolveNamingTokens,
  validateName,
  valuesFor,
  type ListField,
  type NamingStandard,
  type ProjectTemplate,
} from "../src/index.js";

const csb = csb2026NamingStandard();
const ok = (name: string, standard: NamingStandard = csb) => validateName(standard, name, "en");
const field = (standard: NamingStandard, name: string) => standard.fields.find((f) => f.name === name)!;

describe("ÇŞB 2026 EK-2: tables as transcribed", () => {
  it("has the 9 fields of Tablo 2.1, 35 characters, separated by _", () => {
    expect(csb.name).toBe(CSB_2026_STANDARD_NAME);
    expect(csb.delimiter).toBe("_");
    expect(csb.maxLength).toBe(35);
    expect(csb.fields.map((f) => f.name)).toEqual([
      "Proje Kodu", "Bina Kodu", "Disiplin", "Alt Disiplin / Öge", "Dosya Türü", "Dosya Tipi", "Kat / Konum", "Sıra No", "Revizyon No",
    ]);
    // 6+2+2+4+2+3+3+2+3 characters and 8 separators.
    expect(CSB_2026_EK2.fields.reduce((n, f) => n + f.length, 0) + 8).toBe(35);
    expect(checkStandard(csb, "en")).toEqual([]);
  });

  it("keeps every table with its row count and the codes that look unusual in the source", () => {
    expect(CSB_2026_EK2.disciplines.map((d) => d.code)).toEqual(["MM", "IM", "ST", "EE", "MK", "HR", "AL", "PY", "ZE", "YN", "GS", "AK"]);
    const rows = Object.fromEntries(CSB_2026_EK2.subdisciplines.map((t) => [t.table, t.values.length]));
    expect(rows).toEqual({ "2.3": 53, "2.4": 66, "2.5": 7, "2.6": 23, "2.7": 14, "2.8": 13, "2.9": 5, "2.10": 4, "2.11": 5 });
    for (const t of CSB_2026_EK2.subdisciplines) expect(t.values.map((v) => v.code)).toEqual(expect.arrayContaining(["XXXX", "DIGR"]));
    const mk = CSB_2026_EK2.subdisciplines.find((t) => t.discipline === "MK")!.values;
    expect(mk.find((v) => v.name === "Klima Tesisatı")?.code).toBe("DSDK");
    expect(mk.find((v) => v.name === "Müşterek Tesisat")?.code).toBe("ORTT");
    const islh = CSB_2026_EK2.subdisciplines.find((t) => t.discipline === "MM")!.values.find((v) => v.name === "Islak Hacim");
    expect(islh).toEqual({ code: "ISLH", name: "Islak Hacim", printed: "İSLH" });
    expect(CSB_2026_EK2.subdisciplines.find((t) => t.discipline === "ZE")!.values.map((v) => v.code)).toEqual(["IKS", "KZK", "ZTE", "XXXX", "DIGR"]);
    expect(CSB_2026_EK2.fileKinds.map((k) => k.code)).toEqual(["PL", "KS", "GR", "DT", "SM", "MD", "FR", "LS", "DK", "RP", "HS", "GN"]);
    expect(CSB_2026_EK2.fileTypes.map((g) => [g.group, g.values.length])).toEqual([
      ["MİMARİ DOSYA TİPLERİ", 7], ["STATİK DOSYA TİPLERİ", 4], ["MEKANİK DOSYA TİPLERİ", 7], ["ELEKTRİK DOSYA TİPLERİ", 5],
      ["HARİTA DOSYA TİPLERİ", 1], ["DİĞER DOSYA TİPLERİ", 2], ["TÜM DİSİPLİNLERDE OLABİLECEK DOSYALAR", 4],
    ]);
    expect(CSB_2026_EK2.fileTypes[0]!.values.find((v) => v.name === "Mimari Hesap Raporu")?.code).toBe("MIR");
    expect(CSB_2026_EK2.levels.map((l) => l.code)).toEqual(["B03", "B02", "B01", "K00", "K01", "K02", "K03", "K04", "NNN"]);
  });
});

describe("ÇŞB 2026 EK-2: names", () => {
  it("accepts names built from the tables", () => {
    for (const name of [
      "270001_00_MM_DUVA_PL_MMC_K01_01_000.dwg",
      "270001_A1_ST_BETO_HS_SHR_NNN_01_000.pdf",
      "270001_00_MK_SHTT_PL_MKC_B01_02_001.dwg",
      "270001_00_EE_KUVA_SM_ELC_K00_01_000.dwg",
      "270001_00_HR_ADPL_PL_YAP_NNN_01_000.dwg",
      "270001_00_IM_ISLH_DT_MMC_K02_03_000.dwg",
      "270001_00_AL_YAGS_PL_DIC_NNN_01_000.dwg",
      "270001_00_PY_BITS_PL_DIC_K00_01_000.dwg",
      "270001_00_ZE_IKS_RP_DGR_NNN_01_000.pdf", // Tablo 2.11 codes have three characters: 34 in all
      "270001_00_YN_DIGR_PL_DIC_K01_01_000.dwg", // no table for Yangın: DIGR / XXXX
      "270001_00_GS_XXXX_RP_DGR_NNN_01_000.pdf",
      "270001_00_MM_XXXX_KS_MMC_AA1_01_000.dwg", // 2.9.3: a location code chosen by the designer
      "270001_00_MM_XXXX_PL_MMC_K1A_01_000.dwg", // 2.9.2: KXX for a mezzanine
      "270001_00_MM_XXXX_MD_XXX_NNN_01_000.ifc",
    ]) {
      expect(ok(name).ok, `${name}: ${ok(name).errors.join("; ")}`).toBe(true);
    }
    expect(parseName(csb, "270001_00_MM_DUVA_PL_MMC_K01_01_000.dwg")).toEqual({
      "Proje Kodu": "270001", "Bina Kodu": "00", Disiplin: "MM", "Alt Disiplin / Öge": "DUVA",
      "Dosya Türü": "PL", "Dosya Tipi": "MMC", "Kat / Konum": "K01", "Sıra No": "01", "Revizyon No": "000",
    });
  });

  it("accepts every code of every table with its discipline", () => {
    const name = (d: string, s: string, kind = "PL", type = "DIC", level = "NNN") => `270001_00_${d}_${s}_${kind}_${type}_${level}_01_000`;
    for (const t of CSB_2026_EK2.subdisciplines) for (const v of t.values) expect(ok(name(t.discipline, v.code)).ok, `${t.discipline} ${v.code}`).toBe(true);
    for (const k of CSB_2026_EK2.fileKinds) expect(ok(name("MM", "XXXX", k.code)).ok, k.code).toBe(true);
    for (const g of CSB_2026_EK2.fileTypes) for (const v of g.values) expect(ok(name("MM", "XXXX", "PL", v.code)).ok, v.code).toBe(true);
    for (const l of CSB_2026_EK2.levels) expect(ok(name("MM", "XXXX", "PL", "DIC", l.code)).ok, l.code).toBe(true);
  });

  it("refuses names longer than 35 characters", () => {
    const r = ok("2700011_00_MM_DUVA_PL_MMC_K01_01_000.dwg");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toBe("The name is 36 characters long; at most 35 are allowed (without the extension).");
    // The extension does not count.
    expect(ok("270001_00_MM_DUVA_PL_MMC_K01_01_000.verylongextension").ok).toBe(true);
    // A free-text standard with maxLength only.
    const short: NamingStandard = { name: "s", delimiter: "-", maxLength: 5, fields: [{ name: "A", type: "text" }] };
    expect(validateName(short, "ABCDE").ok).toBe(true);
    expect(validateName(short, "ABCDEF").ok).toBe(false);
  });

  it("refuses codes that are not in the lists", () => {
    const cases: [string, string][] = [
      ["270001_00_XX_DUVA_PL_MMC_K01_01_000", 'Disiplin: "XX" is not one of the allowed values'],
      ["270001_00_MM_QQQQ_PL_MMC_K01_01_000", 'Alt Disiplin / Öge: "QQQQ" is not one of the allowed values'],
      ["270001_00_MM_BETO_PL_MMC_K01_01_000", 'Alt Disiplin / Öge: "BETO" is not allowed with Disiplin "MM"'],
      ["270001_00_ZE_IKSS_PL_MMC_K01_01_000", 'Alt Disiplin / Öge: "IKSS" is not one of the allowed values'],
      ["270001_00_MM_İSLH_PL_MMC_K01_01_000", 'Alt Disiplin / Öge: "İSLH" is not one of the allowed values'],
      ["270001_00_MM_DUVA_PX_MMC_K01_01_000", 'Dosya Türü: "PX" is not one of the allowed values'],
      ["270001_00_MM_DUVA_PL_ABC_K01_01_000", 'Dosya Tipi: "ABC" is not one of the allowed values'],
      ["270001_a1_MM_DUVA_PL_MMC_K01_01_000", "Bina Kodu: only capital letters A–Z and digits"],
      ["270001_000_MM_DUVA_PL_MMC_K01_01_000", "Bina Kodu: at most 2 characters"],
      ["27001_00_MM_DUVA_PL_MMC_K01_01_000", "Proje Kodu: at least 6 characters"],
      ["270001_00_MM_DUVA_PL_MMC_K1_01_000", "Kat / Konum: at least 3 characters"],
      ["270001_00_MM_DUVA_PL_MMC_K01_1_000", "Sıra No: must be a 2-digit number"],
      ["270001_00_MM_DUVA_PL_MMC_K01_01_00", "Revizyon No: must be a 3-digit number"],
    ];
    for (const [name, error] of cases) {
      const r = ok(name);
      expect(r.ok, name).toBe(false);
      expect(r.errors, name).toContain(error);
    }
    // An unknown parent does not hide the problem of the child behind a second message.
    expect(ok("270001_00_XX_BETO_PL_MMC_K01_01_000").errors).toEqual(['Disiplin: "XX" is not one of the allowed values']);
  });

  it("speaks Turkish", () => {
    const r = validateName(csb, "270001_00_MM_BETO_PL_MMC_K01_01_0000", "tr");
    expect(r.errors).toEqual(["Ad 36 karakter; uzantısız en fazla 35 karakter olabilir.", 'Alt Disiplin / Öge: "BETO", Disiplin "MM" ile kullanılamaz', "Revizyon No: 3 haneli sayı olmalı"]);
  });

  it("fills and checks the EK-1 project code of the project", () => {
    const own = csb2026NamingStandard({ projectCode: "270001" });
    expect(own.fields[0]).toEqual({ name: "Proje Kodu", type: "list", values: [{ code: "270001", description: "Proje kodu (EK-1)" }] });
    expect(ok("270001_00_MM_DUVA_PL_MMC_K01_01_000", own).ok).toBe(true);
    expect(ok("270002_00_MM_DUVA_PL_MMC_K01_01_000", own).errors).toContain('Proje Kodu: "270002" is not one of the allowed values');
  });

  it("resolves the {EK1} token of a template: a one-value list, or six characters when unknown", () => {
    const template = csb2026NamingStandard({ projectCode: "{EK1}" });
    expect(field(template, "Proje Kodu")).toMatchObject({ type: "text", fixed: "{EK1}" });
    expect(namingUsesToken([template], "EK1")).toBe(true);
    expect(namingUsesToken([csb], "EK1")).toBe(false);
    const ctx = { projectCode: "ZAVM", slotCodes: {}, slotNames: {} };
    const known = resolveNamingTokens(template, { ...ctx, csbProjectCode: "270001" });
    expect(known.fields[0]).toEqual({ name: "Proje Kodu", type: "list", values: [{ code: "270001" }] });
    expect(known.fields.slice(1)).toEqual(csb.fields.slice(1));
    expect(ok("270002_00_MM_DUVA_PL_MMC_K01_01_000", known).ok).toBe(false);
    const unknown = resolveNamingTokens(template, ctx);
    expect(unknown).toEqual(csb);
    expect(checkStandard(unknown)).toEqual([]);
  });
});

describe("naming engine extensions", () => {
  it("offers the values of a dependent list for a parent", () => {
    const sub = field(csb, "Alt Disiplin / Öge") as ListField;
    const st = valuesFor(sub, "ST").map((v) => v.code);
    expect(st).toEqual(["XXXX", "DIGR", "BETO", "CELK", "YIGM", "AHSP", "KMPT"]);
    expect(valuesFor(sub, "YN").map((v) => v.code)).toEqual(["XXXX", "DIGR"]);
    // Codes shared by two tables have both parents.
    expect(sub.values.find((v) => v.code === "AKSR")?.parents).toEqual(["MM", "IM"]);
    expect(sub.values.find((v) => v.code === "ISLH")?.parents).toEqual(["MM", "IM"]);
  });

  it("backtracks over a dependent list", () => {
    const s: NamingStandard = {
      name: "dep",
      delimiter: "-",
      allowDelimiterInCodes: true,
      fields: [
        { name: "A", type: "list", values: [{ code: "X" }, { code: "X-Y" }] },
        { name: "B", type: "list", dependsOn: "A", values: [{ code: "Y-Z", parents: ["X"] }, { code: "Z", parents: ["X"] }] },
      ],
    };
    // "X-Y" then "Z" is not allowed (Z only after X); "X" then "Y-Z" is.
    expect(parseName(s, "X-Y-Z")).toEqual({ A: "X", B: "Y-Z" });
  });

  it("checks the structure of the new settings", () => {
    const bad: NamingStandard = {
      name: "bad",
      delimiter: "-",
      maxLength: 0,
      fields: [
        { name: "Child", type: "list", dependsOn: "Parent", values: [{ code: "C" }] },
        { name: "Parent", type: "list", values: [{ code: "P" }] },
        { name: "Other", type: "list", dependsOn: "Parent", values: [{ code: "O", parents: ["P", "Q"] }] },
        { name: "T", type: "text", charset: "greek" as "numeric" },
      ],
    };
    expect(checkStandard(bad, "en")).toEqual([
      "The maximum name length must be a whole number of at least 1.",
      '"Child" depends on "Parent", which must be an earlier list field of the name.',
      '"Other" refers to codes not in "Parent": Q.',
      'The character set of "T" is unknown.',
    ]);
  });

  it("keeps the settings a text editor cannot show", () => {
    const edited = keepNamingFieldSettings(
      [
        { name: "Proje Kodu", type: "text" },
        { name: "Disiplin", type: "list", values: [{ code: "MM" }, { code: "ST" }] },
        { name: "Alt Disiplin / Öge", type: "list", values: [{ code: "BETO" }, { code: "NEW1" }] },
        { name: "Revizyon No", type: "number", digits: 3 },
      ],
      csb.fields,
    );
    expect(edited[0]).toEqual({ name: "Proje Kodu", type: "text", minLength: 6, maxLength: 6, charset: "alphanumeric" });
    expect(edited[2]).toEqual({
      name: "Alt Disiplin / Öge",
      type: "list",
      dependsOn: "Disiplin",
      values: [{ code: "BETO", parents: ["ST"] }, { code: "NEW1" }],
    });
    expect(edited[3]).toEqual({ name: "Revizyon No", type: "number", digits: 3, inCode: false });
  });
});

describe("set-up wizard: ÇŞB profile", () => {
  const iso: NamingStandard = { name: "ISO", delimiter: "-", fields: [{ name: "N", type: "number", digits: 4 }] };
  const corr: NamingStandard = { name: "Corr", delimiter: "-", fields: [{ name: "N", type: "number", digits: 3 }] };
  const template = (): ProjectTemplate => ({
    name: "t",
    slots: [],
    root: { naming: "ISO" },
    folders: [
      { name: "Shared", naming: "ISO", children: [{ name: "Inner", naming: "ISO" }] },
      { name: "Letters", naming: "Corr" },
      "Plain",
    ],
    namingStandards: [iso, corr, csb2026NamingStandard({ projectCode: "{EK1}" })],
    cde: { containerStandard: "ISO" },
  });

  it("switches the folders of the document code standard to the chosen one", () => {
    const { template: out, errors } = applySetupOverrides(template(), { containerStandard: CSB_2026_STANDARD_NAME }, "en");
    expect(errors).toEqual([]);
    expect(out.cde?.containerStandard).toBe(CSB_2026_STANDARD_NAME);
    expect(out.root?.naming).toBe(CSB_2026_STANDARD_NAME);
    expect(out.folders).toEqual([
      { name: "Shared", naming: CSB_2026_STANDARD_NAME, children: [{ name: "Inner", naming: CSB_2026_STANDARD_NAME }] },
      { name: "Letters", naming: "Corr" },
      "Plain",
    ]);
    // The same standard, or an unknown one (left to checkProjectTemplate), changes no folder.
    expect(applySetupOverrides(template(), { containerStandard: "ISO" }).template.folders).toEqual(template().folders);
    expect(applySetupOverrides(template(), { containerStandard: "Nope" }).template.folders).toEqual(template().folders);
  });

  it("keeps the parents of dependent codes when the wizard changes the codes", () => {
    const { template: out, errors } = applySetupOverrides(template(), {
      naming: [{ standard: CSB_2026_STANDARD_NAME, field: "Alt Disiplin / Öge", values: [{ code: "BETO" }, { code: "DIGR", description: "Diğer" }, { code: "ABCD" }] }],
    });
    expect(errors).toEqual([]);
    const sub = out.namingStandards![2]!.fields[3] as ListField;
    expect(sub.values).toEqual([{ code: "BETO", parents: ["ST"] }, { code: "DIGR", description: "Diğer" }, { code: "ABCD" }]);
  });

  it("checks the EK-1 project code of the details", () => {
    expect(checkSetupDetails({ csbProjectCode: "270001" }, "en")).toEqual([]);
    expect(checkSetupDetails({ csbProjectCode: "27-001" }, "en")).toEqual([
      'The ÇŞB project code (EK-1) must be six capital letters or digits (e.g. 270001): "27-001".',
    ]);
  });
});
