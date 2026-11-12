import { describe, expect, it } from "vitest";
import {
  formatRailChainageLabel,
  parseChainageInput,
  sensorsUseTrackChainage,
  trackChainageMetres,
} from "../src/scan/iot/dataView";
import { statusFromLimits, type IotSensor } from "../src/scan/types";

const limits: IotSensor["limits"] = {
  AL: { min: 10, max: 20 },
  IL: { min: 5, max: 25 },
  IAL: { min: 0, max: 30 },
};

describe("statusFromLimits", () => {
  it("is ok when the value or the bands are missing", () => {
    expect(statusFromLimits(null, limits)).toBe("ok");
    expect(statusFromLimits(15)).toBe("ok");
    expect(statusFromLimits(15, {})).toBe("ok");
  });

  it("uses IAL then IL as alarm, AL as warn", () => {
    expect(statusFromLimits(15, limits)).toBe("ok");
    expect(statusFromLimits(22, limits)).toBe("warn");
    expect(statusFromLimits(8, limits)).toBe("warn");
    expect(statusFromLimits(27, limits)).toBe("alarm");
    expect(statusFromLimits(-1, limits)).toBe("alarm");
  });
});

describe("rail chainage helpers", () => {
  it("formats Autodesk-style 25 m steps without jumping a kilometre", () => {
    expect(formatRailChainageLabel(281, 1)).toBe("281+000.00");
    expect(formatRailChainageLabel(281, 2)).toBe("281+000.25");
    expect(formatRailChainageLabel(281, 5)).toBe("281+001.00");
    expect(trackChainageMetres(1)).toBe(0);
    expect(trackChainageMetres(5)).toBe(100);
    expect(trackChainageMetres(0)).toBe(0);
  });

  it("reads typed range bounds as numbers or in the axis' km format", () => {
    // Track chainage: the inverse of the axis label.
    expect(parseChainageInput("281+001.00", true)).toBe(trackChainageMetres(5));
    expect(parseChainageInput("281+000.25", true)).toBe(trackChainageMetres(2));
    expect(parseChainageInput(" 281 + 001.5 ", true)).toBe(150);
    // Kilometre + metres.
    expect(parseChainageInput("281+050.5", false)).toBe(281050.5);
    // Plain positions, a decimal comma, and the empty / unreadable cases.
    expect(parseChainageInput("100", true)).toBe(100);
    expect(parseChainageInput("12,5", false)).toBe(12.5);
    expect(parseChainageInput("", true)).toBeNull();
    expect(parseChainageInput("km 281", true)).toBeNull();
  });

  it("detects when km/metre labels skip more than a step", () => {
    expect(
      sensorsUseTrackChainage([
        { trackOrder: 1, km: 281, metre: 0 },
        { trackOrder: 2, km: 281, metre: 25 },
      ]),
    ).toBe(false);
    expect(
      sensorsUseTrackChainage([
        { trackOrder: 1, km: 281, metre: 0 },
        { trackOrder: 2, km: 282, metre: 0 },
      ]),
    ).toBe(true);
    expect(sensorsUseTrackChainage([{ trackOrder: 1, km: 281, metre: 0 }])).toBe(false);
    expect(sensorsUseTrackChainage([{ km: 281, metre: 0 }, { km: 282, metre: 0 }])).toBe(false);
  });
});
