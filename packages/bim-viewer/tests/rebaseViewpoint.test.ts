import { describe, expect, it } from "vitest";
import { rebaseViewpoint, type IssueViewpoint, type Vec3 } from "../src/core/types";

const vp = (over: Partial<IssueViewpoint> = {}): IssueViewpoint => ({
  camera: {
    position: [10, 20, 30],
    target: [1, 2, 3],
    projection: "perspective",
  },
  sceneOffset: [100, 0, 50],
  fileVersionIds: ["a"],
  ...over,
});

describe("rebaseViewpoint", () => {
  it("returns the same object when there is no scene offset", () => {
    const input = vp({ sceneOffset: undefined });
    expect(rebaseViewpoint(input, [1, 2, 3])).toBe(input);
  });

  it("returns the same object when the offset does not change", () => {
    const input = vp();
    expect(rebaseViewpoint(input, [100, 0, 50])).toBe(input);
  });

  it("moves camera, section planes, box, measurements and lines into the new frame", () => {
    const input = vp({
      sections: {
        planes: [{ origin: [0, 1, 0], normal: [0, 1, 0] }],
        box: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      measurements: [
        { kind: "length", points: [[0, 0, 0], [2, 0, 0]], value: 2 },
        { kind: "volume", guids: ["g"], value: 4 },
      ],
      lines: [
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
      ],
    });
    const next: Vec3 = [110, 5, 50];
    const out = rebaseViewpoint(input, next);

    expect(out).not.toBe(input);
    expect(out.sceneOffset).toEqual(next);
    expect(out.camera.position).toEqual([20, 25, 30]);
    expect(out.camera.target).toEqual([11, 7, 3]);
    expect(out.sections?.planes[0]?.origin).toEqual([10, 6, 0]);
    expect(out.sections?.planes[0]?.normal).toEqual([0, 1, 0]);
    expect(out.sections?.box).toEqual({ min: [9, 4, -1], max: [11, 6, 1] });
    expect(out.measurements?.[0]).toEqual({
      kind: "length",
      points: [
        [10, 5, 0],
        [12, 5, 0],
      ],
      value: 2,
    });
    expect(out.measurements?.[1]).toEqual({ kind: "volume", guids: ["g"], value: 4 });
    expect(out.lines).toEqual([
      [
        [10, 5, 0],
        [11, 5, 0],
      ],
    ]);
  });

  it("keeps a null section box as null", () => {
    const out = rebaseViewpoint(
      vp({ sections: { planes: [], box: null } }),
      [101, 0, 50],
    );
    expect(out.sections?.box).toBeNull();
  });
});
