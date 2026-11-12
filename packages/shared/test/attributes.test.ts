import { describe, expect, it } from "vitest";
import { checkAttributeDefinition, foldTr, validateAttributes, type AttributeDefinition } from "../src/index.js";

const defs: AttributeDefinition[] = [
  { name: "Durum", type: "list", options: ["S0", "S1", "S2"], required: true },
  { name: "Teslim tarihi", type: "date" },
  { name: "Adet", type: "number" },
  { name: "Not", type: "text" },
];

describe("attributes", () => {
  it("accepts valid values and free-form keys", () => {
    expect(validateAttributes(defs, { Durum: "S2", "Teslim tarihi": "2026-10-10", Adet: "3,5", Serbest: "x" })).toEqual([]);
  });

  it("reports missing required, bad list, date and number values in Turkish", () => {
    const errors = validateAttributes(defs, { "Teslim tarihi": "2026-02-30", Adet: "üç" });
    expect(errors.map((e) => e.name)).toEqual(["Durum", "Teslim tarihi", "Adet"]);
    expect(errors[0]!.message).toBe('"Durum" zorunlu.');
    expect(validateAttributes(defs, { Durum: "S9" })[0]!.message).toContain("geçerli bir seçenek değil");
  });

  it("checks only given keys in partial mode", () => {
    expect(validateAttributes(defs, { Adet: "4" }, { partial: true })).toEqual([]);
    expect(validateAttributes(defs, { Durum: "" }, { partial: true })[0]!.message).toBe('"Durum" zorunlu.');
  });

  it("checks definitions", () => {
    expect(checkAttributeDefinition({ name: "Durum", type: "list", options: [] })).toHaveLength(1);
    expect(checkAttributeDefinition({ name: "Durum", type: "list", options: ["A", "A"] })).toHaveLength(1);
  });

  it("folds Turkish I variants for search", () => {
    expect(foldTr("KIRIŞ")).toBe(foldTr("kiriş"));
    expect(foldTr("İNŞAAT")).toBe("inşaat");
    expect(foldTr("ıfc")).toBe("ifc");
  });
});
