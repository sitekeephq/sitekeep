/** 2B metraj: calibration, quantities and group totals (Cost's shared helpers). */
import type { TakeoffPoint } from "@sitekeep/shared";
import { describe, expect, it } from "vitest";
import { calibrationScale, takeoffGroups, takeoffMinPoints, takeoffQuantity } from "@7dimensions-project/sitekeep-ee-cost/shared/takeoff.js";

const square: TakeoffPoint[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("2B metraj math", () => {
  it("derives metres per unit from a calibration line", () => {
    expect(calibrationScale([0, 0], [200, 0], 5)).toBe(0.025);
    expect(calibrationScale([0, 0], [30, 40], 1)).toBe(0.02);
    expect(() => calibrationScale([1, 1], [1, 1], 5)).toThrow(RangeError);
    expect(() => calibrationScale([0, 0], [1, 0], 0)).toThrow(RangeError);
    expect(() => calibrationScale([0, 0], [1, 0], Number.NaN)).toThrow(RangeError);
  });

  it("turns points into quantities with the scale", () => {
    expect(takeoffQuantity("count", [[0, 0], [1, 1], [2, 2]], null)).toBe(3);
    expect(takeoffQuantity("length", [[0, 0], [100, 0]], null)).toBeNull();
    expect(takeoffQuantity("length", [[0, 0], [100, 0]], 0.05)).toBe(5);
    expect(takeoffQuantity("area", square, 0.5)).toBe(25);
    expect(takeoffQuantity("area", square, 0.5, true)).toBe(-25);
    // Deduction only applies to areas.
    expect(takeoffQuantity("length", [[0, 0], [100, 0]], 0.05, true)).toBe(5);
    expect(takeoffQuantity("length", [[0, 0], [1, 0]], 1 / 3)).toBe(0.333);
  });

  it("knows the fewest points of each kind", () => {
    expect([takeoffMinPoints("count"), takeoffMinPoints("length"), takeoffMinPoints("area")]).toEqual([1, 2, 3]);
  });

  it("totals by group and kind, counting unscaled items", () => {
    const g = takeoffGroups([
      { group: "Sıva", kind: "area", quantity: 50, amount: 10000 },
      { group: "Sıva", kind: "area", quantity: -4, amount: -800 },
      { group: "Sıva", kind: "length", quantity: null, amount: null },
      { group: "Çini", kind: "area", quantity: 12.5, amount: null },
      { group: "", kind: "count", quantity: 3, amount: null },
    ]);
    expect(g.map((x) => [x.group, x.kind, x.items, x.unscaled, x.quantity, x.amount, x.unit])).toEqual([
      ["", "count", 1, 0, 3, null, "adet"],
      ["Çini", "area", 1, 0, 12.5, null, "m²"],
      ["Sıva", "length", 1, 1, 0, null, "m"],
      ["Sıva", "area", 2, 0, 46, 9200, "m²"],
    ]);
  });
});
