import { describe, expect, it } from "vitest";
import { checkStandard, parseName, validateName, type NamingStandard } from "../src/index.js";

const codes = (...c: string[]) => c.map((code) => ({ code }));

/** Trimmed-down İBB "Metro Kodlama Sistemi" (PKF lists). */
const metro: NamingStandard = {
  name: "Metro Kodlama Sistemi",
  delimiter: "-",
  allowDelimiterInCodes: true,
  fields: [
    { name: "YÜKLENİCİ KODU", type: "list", values: codes("OZG") },
    { name: "ALT YÜKLENİCİ KODU", type: "list", values: codes("PRT", "DGR", "SCH") },
    { name: "PROJE KODU", type: "list", values: codes("PKF") },
    { name: "ALAN", type: "list", values: codes("000", "SG1", "S20", "L0SG", "SKP1-A", "SKP2-B", "SKT1-C") },
    { name: "ALT ALAN", type: "list", values: codes("000", "NTM", "TBM", "SKP2E") },
    { name: "SEVİYE", type: "list", values: codes("00", "10", "H0") },
    { name: "SİSTEM", type: "list", values: codes("A1", "00", "01", "11") },
    { name: "ALT SİSTEM", type: "list", values: codes("00", "05", "14") },
    { name: "AŞAMA", type: "list", values: codes("G", "K", "U") },
    { name: "DİL", type: "list", values: codes("T", "E") },
    { name: "DOKÜMAN TİPİ", type: "list", values: codes("2A", "6K", "1AB") },
    { name: "Number", type: "number", digits: 3, minDigits: 2, maxDigits: 3 },
    { name: "Revizyon", type: "text", maxLength: 8, inName: false },
    { name: "PAFTA / DOKÜMAN ADI", type: "text", maxLength: 255, inName: false },
  ],
};

describe("naming: Forma-style standards", () => {
  it("parses a real-shape name and skips metadata fields", () => {
    const r = validateName(metro, "OZG-PRT-PKF-SG1-000-10-11-05-U-T-6K-300.nwd");
    expect(r.ok).toBe(true);
    expect(r.fields).toHaveLength(12);
    expect(r.values).toMatchObject({ ALAN: "SG1", SİSTEM: "11", "DOKÜMAN TİPİ": "6K", Number: "300" });
    expect(r.values).not.toHaveProperty("Revizyon");
  });

  it("matches list codes that contain the delimiter", () => {
    const v = parseName(metro, "OZG-PRT-PKF-SKP1-A-NTM-H0-01-00-K-T-2A-01.pdf");
    expect(v).not.toBeNull();
    expect(v!.ALAN).toBe("SKP1-A");
    expect(v!["ALT ALAN"]).toBe("NTM");
    expect(v!.Number).toBe("01");
  });

  it("backtracks when the longest code leads nowhere", () => {
    const s: NamingStandard = {
      name: "x",
      delimiter: "-",
      allowDelimiterInCodes: true,
      fields: [
        { name: "A", type: "list", values: codes("AB", "AB-C") },
        { name: "B", type: "list", values: codes("C-D", "D") },
      ],
    };
    // "AB-C" then "D" works, and so does "AB" then "C-D": the first full match wins.
    expect(parseName(s, "AB-C-D")).toEqual({ A: "AB-C", B: "D" });
    expect(parseName(s, "AB-C-D-E")).toBeNull();
    const t: NamingStandard = { ...s, fields: [s.fields[0]!, { name: "B", type: "list", values: codes("C-D") }] };
    expect(parseName(t, "AB-C-D")).toEqual({ A: "AB", B: "C-D" });
  });

  it("accepts variable-length numbers within the range only", () => {
    const base = "OZG-PRT-PKF-SG1-000-10-11-05-U-T-6K-";
    expect(validateName(metro, `${base}01.pdf`).ok).toBe(true);
    expect(validateName(metro, `${base}123.pdf`).ok).toBe(true);
    const short = validateName(metro, `${base}1.pdf`);
    expect(short.ok).toBe(false);
    expect(short.errors).toEqual(["Number: 2–3 haneli sayı olmalı"]);
    expect(validateName(metro, `${base}1234.pdf`).errors).toEqual(["Number: 2–3 haneli sayı olmalı"]);
  });

  it("reports wrong fields after a delimiter code with the right field names", () => {
    const r = validateName(metro, "OZG-XXX-PKF-SKT1-C-TBM-00-01-00-K-T-2A-010.dwg");
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['ALT YÜKLENİCİ KODU: "XXX" izinli değerlerden biri değil']);
    expect(r.fields.find((f) => f.field === "ALAN")?.value).toBe("SKT1-C");
  });

  it("counts fields with delimiter codes correctly", () => {
    const r = validateName(metro, "OZG-PRT-PKF-SKP2-B-NTM.pdf");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toBe('Ad 12 alandan oluşmalı, 5 alan var (ayraç "-").');
  });

  it("returns null from parseName for invalid names", () => {
    expect(parseName(metro, "OZG-PRT-PKF.pdf")).toBeNull();
  });

  it("checks the new options in the standard", () => {
    expect(checkStandard(metro)).toEqual([]);
    expect(checkStandard({ ...metro, allowDelimiterInCodes: false })).toEqual([
      '"ALAN" alanındaki "SKP1-A" kodu ayraç içeriyor.',
      '"ALAN" alanındaki "SKP2-B" kodu ayraç içeriyor.',
      '"ALAN" alanındaki "SKT1-C" kodu ayraç içeriyor.',
    ]);
    expect(
      checkStandard({
        name: "x",
        delimiter: "-",
        allowDelimiterInCodes: true,
        fields: [
          { name: "A", type: "list", values: codes("-A") },
          { name: "N", type: "number", digits: 3, minDigits: 4, maxDigits: 2 },
        ],
      }),
    ).toEqual([
      '"A" alanındaki "-A" kodu ayraçla başlayamaz veya bitemez.',
      '"N" için en az/en çok hane 1–12 arasında olmalı (en az ≤ en çok).',
    ]);
    expect(
      checkStandard({ name: "x", delimiter: "-", fields: [{ name: "R", type: "text", inName: false }] }),
    ).toEqual(["Adda en az bir alan olmalı."]);
  });

  it("keeps text fields and suffixes working with the new parser", () => {
    const s: NamingStandard = {
      name: "x",
      delimiter: "_",
      allowSuffix: true,
      fields: [
        { name: "P", type: "list", values: codes("ZAVM") },
        { name: "Konu", type: "text", minLength: 2 },
        { name: "No", type: "number", digits: 3 },
      ],
    };
    expect(parseName(s, "ZAVM_Kazi_001.pdf")).toEqual({ P: "ZAVM", Konu: "Kazi", No: "001" });
    expect(parseName(s, "ZAVM_Kazi_001 Temel.pdf")).toEqual({ P: "ZAVM", Konu: "Kazi", No: "001" });
    expect(parseName(s, "ZAVM_Kazi_001_Temel.pdf")).toEqual({ P: "ZAVM", Konu: "Kazi", No: "001" });
    expect(validateName(s, "ZAVM_K_001.pdf").errors).toEqual(["Konu: en az 2 karakter"]);
    expect(parseName({ ...s, allowSuffix: false }, "ZAVM_Kazi_001_Temel.pdf")).toBeNull();
  });
});
