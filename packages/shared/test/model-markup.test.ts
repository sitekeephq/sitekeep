import { describe, expect, it } from "vitest";
import { carryVersionIds, MODEL_MARKUP_VIEW_UNITS, pxToView, rebasePoint, viewToPx } from "../src/index.js";

describe("model markup view units", () => {
  it("puts the origin at the centre and scales by the view height", () => {
    expect(viewToPx([0, 0], 1600, 800)).toEqual([800, 400]);
    expect(viewToPx([MODEL_MARKUP_VIEW_UNITS / 2, -MODEL_MARKUP_VIEW_UNITS / 2], 1600, 800)).toEqual([1200, 0]);
  });

  it("round-trips pixels and keeps a drawing on the same rays in a wider window", () => {
    const p = pxToView([1000, 300], 1600, 800);
    expect(p).toEqual([250, -125]);
    expect(viewToPx(p, 1600, 800)).toEqual([1000, 300]);
    // Same height, wider window: the point moves with the centre, not with the width.
    expect(viewToPx(p, 2000, 800)).toEqual([1200, 300]);
    // Half the height (a snapshot): everything scales by the height.
    expect(viewToPx(p, 800, 400)).toEqual([500, 150]);
  });
});

describe("carrying model markups over", () => {
  it("replaces the old version and keeps the other models of a federated view", () => {
    expect(carryVersionIds(["a1", "s1"], "a1", "a2")).toEqual(["a2", "s1"]);
    expect(carryVersionIds(["s1"], "a1", "a2")).toEqual(["a2", "s1"]);
    expect(carryVersionIds(["a1", "a2"], "a1", "a2")).toEqual(["a2"]);
  });

  it("moves points between viewpoint frames", () => {
    expect(rebasePoint([1, 2, 3], [10, 0, 0], [12, 1, -1])).toEqual([3, 3, 2]);
    expect(rebasePoint([1, 2, 3], undefined, [12, 1, -1])).toEqual([1, 2, 3]);
  });
});
