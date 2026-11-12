import { describe, expect, it } from "vitest";
import { A4_PRINTABLE, fitScale, pxToIn, sheetPrintLayout } from "../../src/viewers/office/slide-size";

describe("slide and page geometry", () => {
  it("fits a slide into the stage", () => {
    expect(fitScale({ width: 960, height: 540 }, { width: 480, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 960, height: 540 }, { width: 4000, height: 270 })).toBe(0.5);
    expect(fitScale({ width: 960, height: 540 }, { width: 4000, height: 4000 }, 1)).toBe(1);
    expect(fitScale({ width: 0, height: 540 }, { width: 10, height: 10 })).toBe(1);
  });

  it("gives slide-sized print pages", () => {
    expect(pxToIn(960)).toBe("10in");
    expect(pxToIn(540)).toBe("5.625in");
  });

  it("prints narrow sheets portrait and shrinks wide ones onto landscape A4", () => {
    expect(sheetPrintLayout(600)).toEqual({ orientation: "portrait", zoom: 1 });
    expect(sheetPrintLayout(900)).toEqual({ orientation: "landscape", zoom: 1 });
    const wide = sheetPrintLayout(A4_PRINTABLE.landscape * 2);
    expect(wide.orientation).toBe("landscape");
    expect(wide.zoom).toBeCloseTo(0.5, 2);
    expect(sheetPrintLayout(100_000).zoom).toBe(0.3);
  });
});
