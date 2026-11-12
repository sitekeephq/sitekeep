import { describe, expect, it } from "vitest";
import { formatAngle, formatArea, formatLength, formatMeasure, formatNumberTr, formatVolume } from "../src/tools/units";
import {
  EYE_HEIGHT,
  NO_MOVE,
  RUN_FACTOR,
  canMove,
  clampPitch,
  floorFromProbe,
  isWalkKey,
  joystickToMovement,
  keysToMovement,
  lookDirection,
  moveDelta,
  smoothEyeHeight,
  yawPitchOf,
} from "../src/tools/walk-math";
import { emptyExtras, isEmptyExtras, readViewpointExtras, toViewpointExtras } from "../src/tools/viewpoint-extras";
import { fitStoreyScale, planCutY, sortStoreys, storeyIndexAt, storeyLevels } from "../src/tools/storeys";
import { SHORTCUT_HELP, isTypingTarget, shortcutCommand } from "../src/tools/shortcuts";
import { isToolMoreKey, toolMoreItems, type ToolMenuState } from "../src/tools/tools-phone";

describe("measurement units (Turkish number format)", () => {
  it("uses a decimal comma, dot grouping and 2 decimals", () => {
    expect(formatNumberTr(12.34)).toBe("12,34");
    expect(formatNumberTr(1234.5)).toBe("1.234,50");
    expect(formatNumberTr(0.005, 2)).toBe("0,01");
    expect(formatNumberTr(2.5, 1)).toBe("2,5");
  });

  it("formats m, m², ° and m³", () => {
    expect(formatLength(12.34)).toBe("12,34 m");
    expect(formatArea(1234.567)).toBe("1.234,57 m²");
    expect(formatAngle(45)).toBe("45,00°");
    expect(formatVolume(0.75)).toBe("0,75 m³");
    expect(formatMeasure("length", 3)).toBe("3,00 m");
  });

  it("never shows -0,00 or NaN", () => {
    expect(formatNumberTr(-0.0001)).toBe("0,00");
    expect(formatNumberTr(Number.NaN)).toBe("—");
    expect(formatLength(Number.POSITIVE_INFINITY)).toBe("— m");
  });
});

describe("walking: keys, movement, floor height, collision", () => {
  it("maps WASD, arrows, Q/E and Shift to movement", () => {
    expect(keysToMovement(["KeyW"])).toEqual({ forward: 1, right: 0, up: 0, run: false });
    expect(keysToMovement(["ArrowDown", "KeyD"])).toEqual({ forward: -1, right: 1, up: 0, run: false });
    expect(keysToMovement(["KeyA", "KeyE", "ShiftLeft"])).toEqual({ forward: 0, right: -1, up: 1, run: true });
    expect(keysToMovement(["KeyQ"]).up).toBe(-1);
  });

  it("counts W and ↑ together once, and opposite keys cancel", () => {
    expect(keysToMovement(["KeyW", "ArrowUp"]).forward).toBe(1);
    expect(keysToMovement(["KeyW", "KeyS"]).forward).toBe(0);
    expect(keysToMovement([])).toEqual(NO_MOVE);
  });

  it("knows its keys", () => {
    for (const k of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowLeft", "ShiftRight"]) expect(isWalkKey(k)).toBe(true);
    expect(isWalkKey("KeyH")).toBe(false);
  });

  it("moves along the view direction; diagonals are not faster; Shift runs", () => {
    const fwd = moveDelta({ forward: 1, right: 0, up: 0, run: false }, 0, 2, 0.5);
    expect(fwd.dx).toBeCloseTo(0);
    expect(fwd.dz).toBeCloseTo(-1); // yaw 0 looks towards −Z
    const right = moveDelta({ forward: 0, right: 1, up: 0, run: false }, 0, 2, 0.5);
    expect(right.dx).toBeCloseTo(1);
    const diag = moveDelta({ forward: 1, right: 1, up: 0, run: false }, Math.PI / 3, 2, 0.5);
    expect(Math.hypot(diag.dx, diag.dz)).toBeCloseTo(1);
    const run = moveDelta({ forward: 1, right: 0, up: 0, run: true }, 0, 2, 0.5);
    expect(-run.dz).toBeCloseTo(RUN_FACTOR);
    expect(moveDelta({ forward: 0, right: 0, up: 1, run: false }, 0, 2, 0.5).dy).toBeCloseTo(1);
  });

  it("turns look directions into yaw / pitch and back", () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [1.2, 0.3],
      [-2.5, -0.7],
    ] as const) {
      const back = yawPitchOf(lookDirection(yaw, pitch));
      expect(back.yaw).toBeCloseTo(yaw);
      expect(back.pitch).toBeCloseTo(pitch);
    }
    expect(clampPitch(3)).toBeLessThan(Math.PI / 2);
  });

  it("follows the floor smoothly at eye height and keeps the height without a floor", () => {
    expect(smoothEyeHeight(5, null, 0.016)).toBe(5);
    let y = EYE_HEIGHT;
    const floor = 0.18; // one stair step up
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) seen.push((y = smoothEyeHeight(y, floor, 1 / 60)));
    expect(seen[0]).toBeGreaterThan(EYE_HEIGHT);
    expect(seen[0]).toBeLessThan(floor + EYE_HEIGHT); // no jump
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
    expect(y).toBeCloseTo(floor + EYE_HEIGHT, 2);
    expect(smoothEyeHeight(3.4, 1, 1, { eyeHeight: 1.7, rate: 1000 })).toBeCloseTo(2.7);
  });

  it("treats high hits as obstacles, not floors", () => {
    expect(floorFromProbe(0, 0.17)).toBe(0.17);
    expect(floorFromProbe(0, -0.5)).toBe(-0.5);
    expect(floorFromProbe(0, 0.8)).toBeNull();
    expect(floorFromProbe(0, null)).toBeNull();
  });

  it("stops in front of walls but lets you turn away", () => {
    const wall = { dir: [0, -1] as [number, number], distance: 0.4 };
    expect(canMove(wall, 0, -0.1)).toBe(false);
    expect(canMove(wall, 0, 0.1)).toBe(true); // backwards
    expect(canMove(wall, 0.1, 0)).toBe(true); // sideways
    expect(canMove({ dir: [0, -1], distance: 3 }, 0, -0.1)).toBe(true);
    expect(canMove(null, 1, 1)).toBe(true);
  });

  it("reads the phone joystick with a dead zone", () => {
    expect(joystickToMovement(2, 2, 44)).toEqual(NO_MOVE);
    const up = joystickToMovement(0, -44, 44);
    expect(up.forward).toBeCloseTo(1);
    expect(up.right).toBeCloseTo(0);
    const far = joystickToMovement(100, 0, 44);
    expect(far.right).toBeCloseTo(1);
  });
});

describe("viewpoints with sections and measurements", () => {
  const full = {
    sections: {
      planes: [
        { origin: [1, 2, 3] as [number, number, number], normal: [0, 1, 0] as [number, number, number] },
        { origin: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], enabled: false },
      ],
      box: { min: [-1, -2, -3] as [number, number, number], max: [4, 5, 6] as [number, number, number] },
    },
    measurements: [
      { kind: "length" as const, points: [[0, 0, 0], [3, 0, 4]] as [[number, number, number], [number, number, number]], value: 5 },
      { kind: "area" as const, points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]] as [number, number, number][], value: 2 },
      { kind: "angle" as const, points: [[1, 0, 0], [0, 0, 0], [0, 0, 1]] as [[number, number, number], [number, number, number], [number, number, number]], value: 90 },
      { kind: "volume" as const, guids: ["2O2Fr$t4X7Zf8NOew3FLOH"], value: 1.5 },
    ],
  };

  it("reads old viewpoints (no fields) as nothing", () => {
    const old = { camera: { position: [1, 1, 1], target: [0, 0, 0], projection: "perspective" }, fileVersionIds: [], selection: ["x"] };
    expect(readViewpointExtras(old)).toEqual(emptyExtras());
    expect(isEmptyExtras(readViewpointExtras(old))).toBe(true);
    expect(readViewpointExtras(null)).toEqual(emptyExtras());
  });

  it("leaves the fields out when empty, so a plain viewpoint keeps its old shape", () => {
    expect(toViewpointExtras(emptyExtras())).toEqual({});
  });

  it("round-trips planes, the box and all four measurement kinds", () => {
    const saved = JSON.parse(JSON.stringify(toViewpointExtras(full)));
    expect(saved.sections.planes[1].enabled).toBe(false);
    expect(saved.sections.planes[0]).not.toHaveProperty("enabled");
    const back = readViewpointExtras(saved);
    expect(back.sections).toEqual(full.sections);
    expect(back.measurements).toEqual(full.measurements);
  });

  it("drops broken entries and repairs normals and boxes", () => {
    const back = readViewpointExtras({
      sections: {
        planes: [{ origin: [0, 0, 0], normal: [0, 0, 0] }, { origin: [0, 1, 0], normal: [0, 2, 0] }, { origin: "x" }],
        box: { min: [5, 5, 5], max: [0, 0, 0] },
      },
      measurements: [
        { kind: "length", points: [[0, 0, 0]], value: 1 },
        { kind: "area", points: [[0, 0, 0], [1, 0, 0]], value: 1 },
        { kind: "volume", guids: [], value: 1 },
        { kind: "spiral", value: 1 },
        { kind: "angle", points: [[1, 0, 0], [0, 0, 0], [0, 1, 0]], value: "90" },
        { kind: "length", points: [[0, 0, 0], [0, 0, 2]], value: 2 },
      ],
    });
    expect(back.sections.planes).toEqual([{ origin: [0, 1, 0], normal: [0, 1, 0] }]);
    expect(back.sections.box).toEqual({ min: [0, 0, 0], max: [5, 5, 5] });
    expect(back.measurements).toEqual([{ kind: "length", points: [[0, 0, 0], [0, 0, 2]], value: 2 }]);
  });

  it("rounds coordinates to 0.1 mm", () => {
    const out = toViewpointExtras({
      sections: { planes: [{ origin: [1.123456789, 0, 0], normal: [0, 1, 0] }], box: null },
      measurements: [],
    });
    expect(out.sections?.planes[0]?.origin[0]).toBe(1.1235);
    expect(out).not.toHaveProperty("measurements");
  });
});

describe("storeys for the plan view", () => {
  it("sorts bottom to top, unknown elevations last, names naturally, without duplicates", () => {
    const sorted = sortStoreys([
      { name: "Kat 10", elevation: 30 },
      { name: "Çatı", elevation: null },
      { name: "Bodrum", elevation: -3.5 },
      { name: "Kat 2", elevation: 6 },
      { name: "Asma Kat", elevation: null },
      { name: "Zemin", elevation: 0 },
      { name: "Kat 1", elevation: 3 },
      { name: "Zemin", elevation: 0 },
      { name: "Kat 1b", elevation: 3 },
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["Bodrum", "Zemin", "Kat 1", "Kat 1b", "Kat 2", "Kat 10", "Asma Kat", "Çatı"]);
  });

  it("detects millimetre elevations and the import offset", () => {
    // Model 0–12 m high in the scene, IFC origin at scene y = 0.
    expect(fitStoreyScale([0, 3000, 6000, 9000], { offsetY: 0, minY: -0.3, maxY: 12 })).toEqual({ scale: 0.001, offsetY: 0 });
    expect(fitStoreyScale([0, 3, 6, 9], { offsetY: 0, minY: -0.3, maxY: 12 })).toEqual({ scale: 1, offsetY: 0 });
    // Absolute heights (+850 m) moved to the origin on import.
    expect(fitStoreyScale([850, 853, 856], { offsetY: -850, minY: 0, maxY: 9 })).toEqual({ scale: 1, offsetY: -850 });
    expect(fitStoreyScale([], { offsetY: 2, minY: 0, maxY: 1 })).toEqual({ scale: 1, offsetY: 2 });
  });

  it("turns elevations into scene levels", () => {
    expect(storeyLevels([{ name: "A", elevation: 3000 }, { name: "B", elevation: null }], { scale: 0.001, offsetY: 1 })).toEqual([4, null]);
  });

  it("cuts 1.2 m above the level but below the next storey", () => {
    const levels = [-3, 0, 1, 4, null];
    expect(planCutY(levels, 0)).toBeCloseTo(-1.8);
    expect(planCutY(levels, 1)).toBeCloseTo(0.95); // the next level is only 1 m higher
    expect(planCutY(levels, 3)).toBeCloseTo(5.2); // top storey
    expect(planCutY(levels, 4)).toBeNull();
  });

  it("finds the storey a height belongs to", () => {
    const levels = [0, 3, 6, null];
    expect(storeyIndexAt(levels, 4.5)).toBe(1);
    expect(storeyIndexAt(levels, 2.8)).toBe(1); // tolerance: standing just below the next slab
    expect(storeyIndexAt(levels, -5)).toBe(0);
    expect(storeyIndexAt(levels, 50)).toBe(2);
  });
});

describe("viewer shortcuts", () => {
  it("maps keys to commands, following the layout", () => {
    expect(shortcutCommand({ key: "1" })).toBe("nav:orbit");
    expect(shortcutCommand({ key: "2" })).toBe("nav:walk");
    expect(shortcutCommand({ key: "3" })).toBe("nav:plan");
    expect(shortcutCommand({ key: "K" })).toBe("section:plane");
    expect(shortcutCommand({ key: "b" })).toBe("section:box");
    expect(shortcutCommand({ key: "m" })).toBe("measure:length");
    expect(shortcutCommand({ key: "ı" })).toBe("isolate"); // Turkish Q
    expect(shortcutCommand({ key: "I" })).toBe("isolate");
    expect(shortcutCommand({ key: "?" })).toBe("help");
    expect(shortcutCommand({ key: "Escape" })).toBe("escape");
  });

  it("leaves walking keys, modifier shortcuts and unknown keys alone", () => {
    for (const key of ["w", "a", "s", "d", "q", "e"]) expect(shortcutCommand({ key })).toBeNull();
    expect(shortcutCommand({ key: "h", ctrlKey: true })).toBeNull();
    expect(shortcutCommand({ key: "z" })).toBeNull();
  });

  it("does not fire while typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "text" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "radio" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("lists every key in the help", () => {
    expect(SHORTCUT_HELP.length).toBeGreaterThan(10);
    expect(SHORTCUT_HELP.some((r) => r.keys.includes("Esc"))).toBe(true);
  });
});

describe("viewer tools in the phone menu", () => {
  const base: ToolMenuState = {
    nav: "orbit",
    sectionPlacing: false,
    box: false,
    planes: [],
    measureTool: null,
    measurements: [],
    hasSelection: false,
    hidden: false,
    xray: false,
  };

  it("offers nothing before the tools exist", () => {
    expect(toolMoreItems(null)).toEqual([]);
  });

  it("has Title Case labels and t: keys, with the navigation mode checked", () => {
    const items = toolMoreItems({ ...base, nav: "walk" });
    expect(items.every((i) => isToolMoreKey(i.key))).toBe(true);
    expect(items.find((i) => i.key === "t:nav:walk")?.checked).toBe(true);
    expect(items.find((i) => i.key === "t:nav:orbit")?.checked).toBe(false);
    expect(items.some((i) => i.key === "t:hide")).toBe(false);
  });

  it("adds selection, list and show-all items when they apply", () => {
    const keys = toolMoreItems({ ...base, hasSelection: true, hidden: true, measurements: [1, 2], planes: [1], box: true }).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["t:hide", "t:isolate", "t:show_all", "t:measure:volume", "t:panel:measure", "t:panel:sections"]));
    expect(toolMoreItems({ ...base, measurements: [1, 2] }).find((i) => i.key === "t:panel:measure")?.label).toBe("📏 Ölçüler (2)");
  });
});

describe("storey unit detection (real metro model: elevations in cm)", () => {
  it("reads centimetre elevations as cm, not mm, when the storeys span the model height", async () => {
    const { fitStoreyScale } = await import("../src/tools/storeys");
    // -1.40 … +48.14 m stored as -140 … 4814 (cm); the model is about 50 m tall.
    const fit = fitStoreyScale([-140, 0, 103, 893, 1616, 2279, 3150, 3790, 4354, 4814], { offsetY: 0, minY: -3, maxY: 50 });
    expect(fit.scale).toBe(0.01);
  });
  it("still picks millimetres for mm models and metres for metre models", async () => {
    const { fitStoreyScale } = await import("../src/tools/storeys");
    expect(fitStoreyScale([0, 3500, 7000, 10500], { offsetY: 0, minY: -0.5, maxY: 14 }).scale).toBe(0.001);
    expect(fitStoreyScale([0, 3.5, 7, 10.5], { offsetY: 0, minY: -0.5, maxY: 14 }).scale).toBe(1);
  });
});
