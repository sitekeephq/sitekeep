import { describe, expect, it } from "vitest";
import { polygonArea, polylineLength, type TakeoffPoint } from "../src/index.js";

const square: TakeoffPoint[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("2B metraj math", () => {
  it("measures open and closed polylines", () => {
    expect(polylineLength([[0, 0], [3, 4], [3, 10]])).toBe(11);
    expect(polylineLength(square, true)).toBe(40);
    expect(polylineLength([[1, 1]])).toBe(0);
  });

  it("computes polygon areas regardless of winding", () => {
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
    // L shape.
    expect(polygonArea([[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]])).toBe(300);
    expect(polygonArea([[0, 0], [5, 5]])).toBe(0);
  });
});
