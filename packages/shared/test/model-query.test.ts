import { describe, expect, it } from "vitest";
import { foldPlain, ifcClassLabel, modelFieldLabel, modelQueryChips } from "../src/coordination/model-query.js";

describe("model query labels", () => {
  it("labels IFC classes in Turkish", () => {
    expect(ifcClassLabel("IfcDoor")).toBe("Kapı");
    expect(ifcClassLabel("IFCWALLSTANDARDCASE")).toBe("Duvar");
    expect(ifcClassLabel("IfcTendon")).toBe("Tendon");
  });

  it("folds Turkish text for forgiving matches", () => {
    expect(foldPlain("  Döşeme  KATI ")).toBe("doseme kati");
    expect(foldPlain("İç Duvar")).toBe("ic duvar");
  });

  it("turns a query into chips", () => {
    expect(modelFieldLabel("Pset_DoorCommon.FireRating")).toBe("FireRating");
    expect(modelFieldLabel("storey")).toBe("Kat");
    expect(
      modelQueryChips({
        change: ["removed"],
        classes: ["IfcDoor"],
        storeys: ["Kat 1"],
        filters: [
          { field: "FireRating", op: "!=", value: "EI60" },
          { field: "IsExternal", op: "exists" },
        ],
        groupBy: ["storey"],
        aggregate: { op: "sum", field: "NetArea" },
      }).map((c) => c.text),
    ).toEqual(["Silinen", "Sınıf: Kapı", "Kat: Kat 1", "FireRating ≠ EI60", "IsExternal var", "Kat bazında", "Toplam NetArea"]);
  });
});
