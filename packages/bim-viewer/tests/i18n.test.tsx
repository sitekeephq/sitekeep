import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setViewerLanguage, viewerLanguage, vt } from "../src/i18n";
import { ViewerToolsHud } from "../src/react/ViewerToolsHud";
import { SHORTCUT_HELP, shortcutHelp } from "../src/tools/shortcuts";
import { toolMoreItems } from "../src/tools/tools-phone";
import type { ToolsState, ViewerTools } from "../src/tools/tools";
import { MEASURE_KIND_LABELS, formatMeasure, formatNumberTr, measureKindLabel } from "../src/tools/units";

afterEach(() => {
  cleanup();
  setViewerLanguage("tr");
});

const state: ToolsState = {
  nav: "orbit",
  walkSpeed: 1.4,
  pointerLocked: false,
  storeys: null,
  storeysLoading: false,
  storeyIndex: null,
  sectionPlacing: false,
  planes: [],
  box: false,
  edgesOn: true,
  edgeMode: null,
  measureTool: null,
  measurements: [],
  tapPending: false,
  xray: false,
  hasSelection: true,
  hidden: false,
  helpOpen: false,
  hint: null,
};

describe("viewer language", () => {
  it("defaults to Turkish so hosts before 0.6.0 keep their texts", () => {
    expect(viewerLanguage()).toBe("tr");
    expect(vt("rail.section")).toBe("Kesit");
    expect(formatNumberTr(1234.5)).toBe("1.234,50");
  });

  it("maps any non-Turkish tag to English and fills parameters", () => {
    expect(setViewerLanguage("tr-TR")).toBe("tr");
    expect(setViewerLanguage("en-US")).toBe("en");
    expect(setViewerLanguage("de")).toBe("en");
    expect(vt("section.planeNo", { no: 2 })).toBe("Plane 2");
    expect(formatNumberTr(1234.5)).toBe("1,234.50");
    expect(formatMeasure("length", -0.001)).toBe("0.00 m");
  });

  it("English texts carry no Turkish letters", () => {
    // The two tables are typed against each other (Record<Key, string>), so a missing key fails the build.
    for (const k of ["nav.orbit", "rail.xray", "help.walkHere", "cube.front", "load.failed", "props.attributes"] as const) {
      setViewerLanguage("en");
      const enText = vt(k);
      setViewerLanguage("tr");
      expect(vt(k)).not.toBe("");
      expect(enText).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
  });

  it("shortcut help, measure labels and the phone menu follow the language", () => {
    setViewerLanguage("en");
    expect(shortcutHelp()[0]!.text).toBe("Orbit · Walk · Plan");
    expect(measureKindLabel("area")).toBe("Area");
    const labels = toolMoreItems(state).map((i) => i.label);
    expect(labels).toContain("◎ Orbit");
    expect(labels).toContain("📦 Volume of Selection");
    expect(labels.join(" ")).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    // The deprecated constants stay Turkish.
    expect(SHORTCUT_HELP[0]!.text).toBe("Yörünge · Yürüme · Plan");
    expect(MEASURE_KIND_LABELS.area).toBe("Alan");
  });

  it("renders the tool rail in English", () => {
    setViewerLanguage("en");
    const tools = { setNav: vi.fn(), setHelp: vi.fn(), screenshot: vi.fn(), setXray: vi.fn(), mountCube: vi.fn() } as unknown as ViewerTools;
    render(<ViewerToolsHud tools={tools} state={state} panel="visibility" setPanel={() => undefined} loaded />);
    expect(screen.getByRole("toolbar", { name: "Viewing Tools" })).toBeTruthy();
    for (const name of ["Orbit", "Walk", "Plan", "Section", "Measure", "Visibility", "X-Ray", "Screenshot", "Shortcuts"]) {
      expect(screen.getAllByRole(name === "Orbit" || name === "Walk" || name === "Plan" ? "radio" : "button", { name: new RegExp(name) }).length).toBeGreaterThan(0);
    }
    expect(document.body.textContent).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });
});
