import { describe as group, expect, it } from "vitest";
import { isTitleCaseTr } from "@sitekeep/shared";
import { cadMoreItems } from "../../src/viewers/cad/cad-phone";
import { angleDeg, circumcenter, closestOnSegment, polygonArea, polylineLength } from "../../src/viewers/cad/geometry";
import { clipboardText, describe, hintText, minPoints, pointsNeeded, toolLabel, TOOLS } from "../../src/viewers/cad/measure";
import { formatAngle, formatArea, formatCoord, formatLength, parseDxfHeaderUnits, unitInfo } from "../../src/viewers/cad/units";

const header = (pairs: [string, string][]) => pairs.map(([c, v]) => `${c}\n${v}`).join("\n");

group("CAD units ($INSUNITS) and Turkish formatting", () => {
  it("reads $INSUNITS and $MEASUREMENT from the HEADER section", () => {
    const dxf = header([
      ["0", "SECTION"],
      ["2", "HEADER"],
      ["9", "$ACADVER"],
      ["1", "AC1027"],
      ["9", "$INSUNITS"],
      ["70", "4"],
      ["9", "$MEASUREMENT"],
      ["70", "1"],
      ["0", "ENDSEC"],
      ["0", "SECTION"],
    ]);
    expect(parseDxfHeaderUnits(dxf)).toEqual({ insunits: 4, measurement: 1, done: true });
    expect(unitInfo(4)).toMatchObject({ short: "mm", metres: 0.001 });
  });

  it("handles CRLF, padded values, a missing $INSUNITS and an unfinished header", () => {
    expect(parseDxfHeaderUnits("  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$INSUNITS\r\n 70\r\n     6\r\n  0\r\nENDSEC\r\n").insunits).toBe(6);
    expect(parseDxfHeaderUnits(header([["0", "SECTION"], ["2", "HEADER"], ["0", "ENDSEC"]]))).toEqual({ insunits: null, measurement: null, done: true });
    expect(parseDxfHeaderUnits("0\nSECTION\n2\nHEADER\n9\n$INSUNITS").done).toBe(false);
    // A text value "$INSUNITS" that is not a header variable name is ignored.
    expect(parseDxfHeaderUnits(header([["1", "$INSUNITS"], ["70", "4"]])).insunits).toBeNull();
  });

  it("unitless and unknown codes have no metres factor", () => {
    expect(unitInfo(0).metres).toBeNull();
    expect(unitInfo(null).label).toBe("Birimsiz");
    expect(unitInfo(999).code).toBe(0);
  });

  it("formats in tr-TR with the display unit", () => {
    expect(formatLength(12.344, 1, "m")).toBe("12,34 m");
    expect(formatLength(12344, 0.001, "m")).toBe("12,34 m");
    expect(formatLength(1234.56, 0.001, "mm")).toBe("1.235 mm");
    expect(formatLength(1.5, 1, "cm")).toBe("150,0 cm");
    expect(formatArea(56.7, 1, "m")).toBe("56,70 m²");
    expect(formatArea(1_000_000, 0.001, "m")).toBe("1,00 m²");
    expect(formatAngle(45)).toBe("45,0°");
    expect(formatCoord(423000.1234, 1, "m")).toBe("423.000,123");
    expect(formatLength(-0.0001, 1, "m")).toBe("0,00 m");
  });
});

group("CAD geometry", () => {
  it("measures polylines, polygons and angles", () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(polylineLength(sq)).toBe(25);
    expect(polylineLength(sq, true)).toBe(30);
    expect(polygonArea(sq)).toBe(50);
    expect(polygonArea([...sq].reverse())).toBe(50);
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90);
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: -1 })).toBeCloseTo(135);
  });

  it("keeps area precision at survey coordinates (UTM-like)", () => {
    const o = { x: 423000.25, y: 4550700.75 };
    const pts = [
      { x: o.x, y: o.y },
      { x: o.x + 0.3, y: o.y },
      { x: o.x + 0.3, y: o.y + 0.2 },
      { x: o.x, y: o.y + 0.2 },
    ];
    expect(polygonArea(pts)).toBeCloseTo(0.06, 9);
  });

  it("finds the closest point on a segment and circle centres", () => {
    expect(closestOnSegment(5, 3, 0, 0, 10, 0)).toMatchObject({ x: 5, y: 0, d2: 9 });
    expect(closestOnSegment(-4, 0, 0, 0, 10, 0)).toMatchObject({ x: 0, t: 0 });
    const c = circumcenter(1, 0, 0, 1, -1, 0)!;
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(circumcenter(0, 0, 1, 1, 2, 2)).toBeNull();
  });
});

group("CAD measuring tools", () => {
  const f = { metres: 0.001, unit: "m" as const };

  it("knows the points each tool needs", () => {
    expect(pointsNeeded("length")).toBe(2);
    expect(pointsNeeded("angle")).toBe(3);
    expect(pointsNeeded("coord")).toBe(1);
    expect(pointsNeeded("chain")).toBeNull();
    expect(minPoints("area")).toBe(3);
    expect(minPoints("chain")).toBe(2);
    expect(hintText("chain", 2)).toMatch(/Enter/);
  });

  it("describes results in the display unit (drawing in mm, shown in m)", () => {
    expect(
      describe(
        "length",
        [
          { x: 0, y: 0 },
          { x: 3000, y: 4000 },
        ],
        f,
      ),
    ).toEqual({ value: "5,00 m", detail: "ΔX 3,00 m · ΔY 4,00 m" });
    const rect = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    expect(describe("area", rect, f)).toEqual({ value: "6,00 m²", detail: "Çevre 10,00 m" });
    expect(describe("chain", rect, f)).toEqual({ value: "7,00 m", detail: "3 Parça" });
    expect(describe("angle", [rect[1]!, rect[0]!, rect[3]!], f).value).toBe("90,0°");
    expect(describe("coord", [{ x: 423000123, y: 4550700456 }], f).value).toBe("X 423.000,123 · Y 4.550.700,456 (m)");
  });

  it("builds the clipboard text of the list", () => {
    const text = clipboardText(
      [
        {
          id: 1,
          tool: "length",
          pts: [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
          ],
        },
        { id: 2, tool: "angle", pts: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }] },
      ],
      f,
      "Ölçümler",
    );
    expect(text).toBe("Ölçümler\n1. Uzunluk: 1,00 m (ΔX 1,00 m · ΔY 0,00 m)\n2. Açı: 90,0°");
  });

  it("uses Title Case tool names", () => {
    for (const t of TOOLS) expect(isTitleCaseTr(toolLabel(t.key))).toBe(true);
  });
});

group("CAD phone toolbar: Diğer menu (cad-phone.ts)", () => {
  const base = { loaded: true, tool: null, snap: true, bg: "dark" as const, modelOnly: false, count: 0 };

  it("offers only view items before the drawing is loaded", () => {
    expect(cadMoreItems({ ...base, loaded: false }).map((i) => i.key)).toEqual(["fit_all", "bg", "model"]);
  });

  it("moves the tools, Yakalama and the list actions into Diğer with their state", () => {
    const items = cadMoreItems({ ...base, tool: "area", count: 2 });
    expect(items.map((i) => i.key)).toEqual(["fit_all", "length", "chain", "area", "angle", "coord", "info", "snap", "bg", "model", "copy", "clear"]);
    expect(items.find((i) => i.key === "area")?.checked).toBe(true);
    expect(items.find((i) => i.key === "length")?.checked).toBe(false);
    expect(items.find((i) => i.key === "snap")?.checked).toBe(true);
    for (const i of items) expect(isTitleCaseTr(i.label.replace(/^\S+\s/, ""))).toBe(true);
  });
});
