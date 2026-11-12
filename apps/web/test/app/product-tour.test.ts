import { afterEach, describe, expect, it } from "vitest";
import {
  isTourDone,
  markTourDone,
  nextTourIndex,
  STATION_TOUR_GROUP,
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
} from "../../src/features/onboarding/tour";

const mem = new Map<string, string>();
const memoryStorage = {
  getItem(key: string) {
    return mem.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    mem.set(key, value);
  },
  removeItem(key: string) {
    mem.delete(key);
  },
  clear() {
    mem.clear();
  },
  get length() {
    return mem.size;
  },
  key() {
    return null;
  },
};

describe("product tour", () => {
  afterEach(() => mem.clear());

  it("walks Bugün, Dokümanlar and Viewer in that order", () => {
    expect(TOUR_STEPS.map((s) => s.route).filter((r, i, all) => all.indexOf(r) === i)).toEqual(["today", "files", "viewer"]);
    expect(TOUR_STEPS.map((s) => s.target)).toContain("nav-today");
    expect(TOUR_STEPS.map((s) => s.target)).toContain("nav-files");
    expect(TOUR_STEPS.map((s) => s.target)).toContain("nav-viewer");
    expect(TOUR_STEPS.map((s) => s.target)).toContain("folder:S16");
    expect(TOUR_STEPS.map((s) => s.target)).toContain("folder:01-Mimari");
    expect(TOUR_STEPS.map((s) => s.target)).toContain("open-model");
  });

  it("skips the station folder group when those folders are missing", () => {
    const start = TOUR_STEPS.findIndex((s) => s.optionalGroup === STATION_TOUR_GROUP);
    expect(start).toBeGreaterThan(0);
    const next = nextTourIndex(start, STATION_TOUR_GROUP);
    expect(TOUR_STEPS[next]?.id).toBe("nav-viewer");
  });

  it("persists completion", () => {
    Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });
    expect(isTourDone()).toBe(false);
    markTourDone();
    expect(isTourDone()).toBe(true);
    expect(mem.get(TOUR_STORAGE_KEY)).toBe("done");
  });
});
