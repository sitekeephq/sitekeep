import { describe, expect, it } from "vitest";
import { isTitleCaseTr } from "@sitekeep/shared";
import { viewerMoreItems } from "../../src/viewers/viewer-phone";

describe("viewer phone toolbar", () => {
  it("offers nothing before a model is loaded", () => {
    expect(viewerMoreItems(false, false)).toEqual([]);
  });

  it("moves the issue tools and Takvim into Diğer, with Takvim's state", () => {
    const items = viewerMoreItems(true, true);
    expect(items.map((i) => i.key)).toEqual(["pin_issue", "view_issue", "four_d"]);
    expect(items.find((i) => i.key === "four_d")?.checked).toBe(true);
    for (const i of items) expect(isTitleCaseTr(i.label.replace(/^\S+\s/, ""))).toBe(true);
  });
});
